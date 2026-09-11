"""Extraction CV via le bridge DocIE partagé (issue #151).

`docie_client.py` (commit "standardize DocIE extraction") appelait DocIE
directement, avant que le bridge commun (#150/#155,
document-parsing/bridge/docie_bridge.py) n'existe. Ce module ajoute un
second chemin d'extraction qui passe par ce bridge — auth, timeouts,
classification d'erreurs sans fuite de secret et parsing de la réponse
DocIE y sont déjà traités, pas réimplémentés ici.

Bascule : DOCIE_EXTRACTION_ENABLED (voir docie_extraction_enabled ci-dessous).
Off par défaut, le chemin historique `docie_client.extract_resume` reste
inchangé — le point n'est pas de retirer ce client aujourd'hui, seulement
d'offrir un chemin de bascule sûr et réversible. La normalisation, l'édition
et les exports en aval (app.py::process_cv, normalize_cv_data, bilan_adbi,
export_dossier.py) ne changent pas : seule l'étape d'extraction change.

Le bridge n'accepte que PDF/PNG/JPEG/WebP (pas encore de contrat texte,
voir document-parsing/bridge/README.md) : un .docx passe donc toujours par
`docie_client.extract_resume`, même bascule activée — un seul appel réseau
dans tous les cas, jamais un second essai via un autre transport après un
échec du bridge (le README du bridge est explicite : ne jamais rejouer
aveuglément un travail DocIE potentiellement facturé).

Empaquetage Docker : l'image cv-parser copie document-parsing/bridge/
docie_bridge.py à côté de ce fichier au moment du build (voir le Dockerfile,
"additional_contexts") — le fichier partagé reste une source unique dans
document-parsing/bridge/, jamais dupliqué dans l'arborescence de ce module
(cf. document-parsing/bridge/README.md : "Ne pas copier manuellement ces
fichiers dans les modules"). Hors conteneur (tests, `python app.py` en
local depuis un checkout du dépôt), il est importé directement depuis ce
dossier.
"""
import os
import sys
from pathlib import Path

import docie_client
from docie_client import DocIEError

# Schéma DocIE attendu pour un CV (voir document-parsing/bridge/docie_bridge.py::SCHEMAS).
_EXPECTED_SCHEMA = "adbi_resume"

_MIME_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

# Messages FR par code stable du bridge (document-parsing/bridge/docie_bridge.py).
# Le texte du bridge lui-même (`str(exc)`) est en anglais et resterait affiché
# tel quel à l'utilisateur (parse_warning) sans cette table.
_ERROR_MESSAGES = {
    "configuration": "DocIE (bridge) mal configuré côté serveur cv-parser.",
    "input": "Document invalide pour le bridge DocIE (taille ou format).",
    "auth": "DocIE (bridge) : accès refusé. Vérifiez DOCIE_API_KEY.",
    "rate_limit": "DocIE (bridge) : limite de débit atteinte, réessayez plus tard.",
    "upstream": "DocIE (bridge) : erreur côté serveur DocIE.",
    "timeout": "DocIE (bridge) : délai dépassé. Le traitement distant peut continuer.",
    "network": "DocIE (bridge) injoignable ou délai réseau dépassé.",
    "response": "DocIE (bridge) : réponse invalide.",
    "incomplete": "DocIE (bridge) : extraction non terminée.",
    "schema": "DocIE (bridge) : schéma de réponse inattendu.",
}


def docie_extraction_enabled() -> bool:
    """DOCIE_EXTRACTION_ENABLED (défaut : désactivé).

    Même convention que ADBI_AUTH/ADBI_DEBUG/ADBI_RELOAD (core/auth.py,
    app.py) : "1"/"on"/"true" (insensible à la casse) activent le bridge.
    Toute autre valeur, y compris absente, laisse `docie_client.py` en place.

    N'importe PAS docie_bridge (voir _load_bridge) : lire le drapeau, flag
    éteint, ne requiert donc pas que le module du bridge soit installé.
    """
    return os.environ.get("DOCIE_EXTRACTION_ENABLED", "").strip().lower() in ("1", "on", "true")


def _load_bridge():
    """Importe document-parsing/bridge/docie_bridge.py à la demande.

    Appelé uniquement quand un document est réellement envoyé au bridge —
    jamais depuis docie_extraction_enabled() ni au chargement de ce module —
    pour que le drapeau à l'arrêt (défaut) n'exige pas que ce fichier soit
    présent : `docie_client.py` reste alors le seul chemin, sans dépendance
    nouvelle. En conteneur, le Dockerfile le copie à côté de ce fichier
    (import direct) ; hors conteneur (tests, checkout du dépôt), il est
    chargé depuis son dossier source unique.
    """
    try:
        import docie_bridge
    except ImportError:
        bridge_dir = Path(__file__).resolve().parents[1] / "document-parsing" / "bridge"
        if str(bridge_dir) not in sys.path:
            sys.path.insert(0, str(bridge_dir))
        import docie_bridge
    return docie_bridge


def extract_resume(file_path, progress=None, *, session=None):
    """Même contrat que docie_client.extract_resume : renvoie (data, metadata).

    `metadata` porte en plus `transport` ("docie-bridge" ou "docie" si un
    .docx a été délégué au client historique), pour que l'appelant puisse
    étiqueter correctement la fiche même quand la bascule ne change rien au
    fichier traité.
    """
    path = Path(file_path)
    mime_type = _MIME_BY_SUFFIX.get(path.suffix.lower())
    if mime_type is None:
        # Pas de contrat texte côté bridge : un seul appel, via le client
        # historique — pas un second essai après un échec du bridge.
        data, metadata = docie_client.extract_resume(path, progress=progress, session=session)
        return data, {**metadata, "transport": "docie"}

    docie_bridge = _load_bridge()

    if progress:
        progress("Envoi du document à DocIE (bridge)")
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise DocIEError(f"Document introuvable ou illisible : {exc}") from None

    try:
        bridge_result = docie_bridge.extract_document(content, mime_type, kind="resume", session=session)
    except docie_bridge.DocIEBridgeError as exc:
        # Message FR stable par code (jamais de corps de réponse ni de clé
        # distante dans exc : docie_bridge.py les exclut déjà).
        message = _ERROR_MESSAGES.get(exc.code, f"DocIE (bridge) : {exc}")
        raise DocIEError(f"{message} [{exc.code}]") from exc

    data = docie_client.map_resume(bridge_result, expected_schema=_EXPECTED_SCHEMA)
    meta = bridge_result.get("metadata") or {}
    validation = meta.get("validation")
    metadata = {
        "event_id": meta.get("request_id") or "",
        "model_profile": meta.get("model") or meta.get("agent") or "",
        # `validation` est conservée telle quelle, y compris None : le bridge
        # renvoie None quand DocIE n'en a PAS joint, et une extraction terminée
        # en porte toujours une (listes vides quand tout va bien). La replier
        # sur {} comme avant confondait « rien à signaler » avec « réponse
        # qu'on n'a pas pu vérifier » — voir docie_review.revue_docie. Le type
        # attendu en aval (app.py, dict) est préservé dans tous les autres cas.
        "validation": validation if isinstance(validation, dict) else None,
        # Confiance par champ, rendue par le bridge sous une clé de chemin
        # stable ({"experience[0].title": 0.5}) AVANT que le déballage des
        # enveloppes ne l'efface. C'était le seul signal par champ que DocIE
        # émette — « valeur partielle, à faire relire » — et il était jeté ici
        # (issue #172). Absent des métadonnées d'un bridge antérieur : {}, donc
        # aucune revue supplémentaire, comportement inchangé.
        "field_confidence": meta.get("field_confidence") or {},
        "transport": "docie-bridge",
    }
    return data, metadata
