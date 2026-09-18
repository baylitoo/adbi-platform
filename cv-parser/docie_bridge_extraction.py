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

Le bridge n'accepte que PDF/PNG/JPEG — WebP en a été retiré (#180, DocIE le
refuse ; voir #241) et ne doit pas réapparaître ici (pas encore de contrat texte,
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
import json
import os
import sys
from pathlib import Path

import docie_client
from docie_client import DocIEError

# Schéma DocIE attendu pour un CV (voir document-parsing/bridge/docie_bridge.py::SCHEMAS).
_EXPECTED_SCHEMA = "adbi_resume"

# Ces types DOIVENT rester un sous-ensemble de l'allowlist du pont
# (document-parsing/bridge/docie_bridge.py::MIME_TYPES) : un type déclaré ici
# mais absent là-bas route le fichier vers une voie qui le refusera.
#
# `.webp` a été retiré (#241). Le pont l'a écarté en #180 parce que l'allowlist
# de DocIE le refuse — chaque WebP payait un aller-retour réseau pour rien. Ce
# miroir, lui, n'a pas suivi, et rien ne le signalait : aucun test ne comparait
# les deux listes. Ne pas le remettre sans que `MIME_TYPES` l'accepte d'abord
# (c'est la question ouverte de #181) ; tests/test_parite_extensions.py échoue
# sinon.
_MIME_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
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


def _compter_pages(content, mime_type):
    """Pages du document envoyé en vision (#194, limite du catalogue) ; None si illisible."""
    if mime_type != "application/pdf":
        return 1
    try:
        from io import BytesIO
        from pypdf import PdfReader
        return len(PdfReader(BytesIO(content)).pages)
    except Exception:
        return None


def _schema_resume():
    """Définition du schéma `adbi_resume`, envoyée dans le CORPS de la requête
    (voie texte) : c'est ce qui dispense d'un enregistrement côté Studio. Même
    fichier que docie_client, jamais une seconde copie — le pont refuse un
    `dynamic_schema` dont le `document_type` n'est pas celui du `kind` demandé
    (docie_bridge.py::extract_text)."""
    return json.loads(Path(__file__).with_name("adbi_resume.schema.json").read_text(encoding="utf-8"))


def _echouer_pont(exc):
    """LÈVE DocIEError à partir d'une erreur du pont : message FR stable par
    code (jamais de corps de réponse ni de clé distante dans exc :
    docie_bridge.py les exclut déjà).

    Lève ici, plutôt que de rendre l'exception à l'appelant, et ce n'est pas un
    détail de style : tests/test_taches_upload.py::
    test_seuls_messages_dynamiques_connus_du_client relit ces deux fichiers à
    l'AST et recense CHAQUE `raise DocIEError(...)` à valeur dynamique, pour
    qu'aucun message recopiant une valeur n'échappe à la revue. Un
    `return DocIEError(...)` rendrait ce garde-fou aveugle.
    """
    message = _ERROR_MESSAGES.get(exc.code, f"DocIE (bridge) : {exc}")
    raise DocIEError(f"{message} [{exc.code}]") from exc


def _adapter(bridge_result, voie):
    """Réponse du pont -> `(data, metadata)` attendus par app.py::process_cv.

    UN seul constructeur pour les deux voies : ce qui est rendu au consommateur
    ne doit pas dépendre du transport emprunté.
    """
    data = docie_client.map_resume(bridge_result, expected_schema=_EXPECTED_SCHEMA)
    meta = bridge_result.get("metadata") or {}
    validation = meta.get("validation")
    metadata = {
        "event_id": meta.get("request_id") or "",
        "model_profile": meta.get("model") or meta.get("agent") or "",
        # Agent réellement appelé (#194) : c'est lui qui désigne le modèle
        # servi sur la voie agent (choix_modele.modele_servi). Vide sur la voie
        # texte, où c'est `model` que la réponse nomme.
        "agent": meta.get("agent") or "",
        # Résultat partiel relevé par le bridge (#203) : [{champ, raison}] et
        # plafond de blocs de la voie texte. Lus par process_cv sur tout dépôt
        # (docie_review, marques « à vérifier ») et, pour un modèle
        # explicitement choisi, enregistrés sur la fiche (#194).
        "partiel": meta.get("partiel"),
        # Voie texte : MESURÉS par le pont sur ce qui est exactement parti
        # (#190). Voie agent : None, « non mesurable » et non « non tronqué » —
        # c'est l'OCR distant qui y fabrique les blocs.
        "troncature_possible": meta.get("troncature_possible"),
        "blocs_texte": meta.get("blocs_texte"),
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
        # #177 ligne 21 : DocIE a-t-il nommé le schéma de sa réponse ? Le
        # bridge tolère qu'il ne le nomme pas — aucune des trois sources n'est
        # obligatoire — et pose ce drapeau à False pour le signaler. Il était
        # jeté ici comme `field_confidence` l'était : one-pager avertit le
        # relecteur (`docie_schema_non_verifie`), la CVthèque ne disait rien.
        # Absent des métadonnées d'un bridge antérieur : None, donc aucune
        # revue supplémentaire (docie_review teste `is False`).
        "schema_reported": meta.get("schema_reported"),
        "transport": "docie-bridge",
        # Voie RÉELLEMENT empruntée (#151). Le pont sert désormais les deux, et
        # `transport` ne suffit donc plus à la déduire : app.py la lit ici.
        "voie": voie,
    }
    return data, metadata


def extract_resume(file_path, progress=None, *, session=None, choix=None):
    """Même contrat que docie_client.extract_resume : renvoie (data, metadata).

    DEUX voies du pont, choisies sur la structure que la source a RÉELLEMENT
    (règle du pont, #180) — jamais sur une préférence :

      * voie TEXTE (#151) — le DOCX, qui porte son texte et n'a aucune image à
        OCRiser. Le texte est lu localement et part avec la DÉFINITION du
        schéma dans le corps (extract_text) : rien à enregistrer côté Studio.
      * voie AGENT — PDF et images : le document part en data URI et l'OCR de
        DocIE le lit.

    Avant #151, un .docx SORTAIT du pont par le client historique : le pont ne
    servait qu'une de ses deux surfaces, et sa voie texte — pourtant écrite,
    testée, et déjà employée par contrats — n'était atteinte par personne ici.

    Un PDF à couche texte relèverait lui aussi de la voie texte ; il y reste
    volontairement inéligible tant que le sélecteur de modèles ne sait pas
    prédire la voie PAR FICHIER (voir le commentaire du corps).

    `metadata` porte `transport` ("docie-bridge", ou "docie" quand un suffixe
    qu'aucune voie du pont ne lit est délégué au client historique) et `voie`
    ("texte" ou "agent"), que l'appelant ne peut plus déduire du transport.

    `choix` (#194, choix_modele.Choix) : modèle explicitement choisi. Voie
    texte : vérifié sur le texte réel (lignes non vides) et envoyé en
    `model_profile` pour CET appel. Voie agent : vérifié sur le nombre de pages
    réel, son agent passé au bridge pour CET appel (DOCIE_AGENT_RESUME n'est
    pas lu).
    """
    path = Path(file_path)
    suffixe = path.suffix.lower()
    mime_type = _MIME_BY_SUFFIX.get(suffixe)

    # Voie TEXTE pour le DOCX, et pour lui seul. C'est EXACTEMENT ce que prédit
    # choix_modele.voie_pour(".docx") -> "texte" : un modèle explicitement
    # choisi a donc déjà été validé POUR CETTE VOIE par app.py
    # (Choix.verifier) avant d'arriver ici, et pour_texte() ci-dessous ne peut
    # pas le refuser après coup.
    #
    # Un PDF à couche texte relève de la même voie et n'y va PAS, délibérément :
    # le pont actif, voie_pour(".pdf") rend "agent" (premier test de la
    # fonction, _EXT_BRIDGE avant _EXT_TEXTE), donc le sélecteur ne propose que
    # des modèles de la voie agent pour un PDF. L'y router ferait appeler
    # pour_texte() sur un Choix validé pour la voie agent : un modèle
    # vision-seul serait refusé (`modele_non_propose`) là où il fonctionnait.
    # Le faire proprement demande une prédiction PAR FICHIER côté sélecteur,
    # comme contrats a dû l'écrire pour le Kbis (#194, preparerSelecteurKbis).
    # Hors de cette PR : c'est un changement d'interface, pas de transport.
    if suffixe == ".docx":
        # Règle PARTAGÉE avec le client historique, jamais recopiée. Un DOCX
        # sans texte lisible est déjà refusé, nommé, par document_payload ;
        # `page_sans_texte` ne concerne que les PDF, donc jamais ce chemin.
        texte, _raison = docie_client.texte_document(path)
        docie_bridge = _load_bridge()
        if progress:
            progress("Envoi du texte du document à DocIE (bridge)")
        options = {}
        if choix is not None:
            options["model_profile"] = choix.pour_texte(texte)
        try:
            bridge_result = docie_bridge.extract_text(
                texte, kind="resume", dynamic_schema=_schema_resume(),
                session=session, **options)
        except docie_bridge.DocIEBridgeError as exc:
            _echouer_pont(exc)
        return _adapter(bridge_result, "texte")

    if mime_type is None:
        # Suffixe qu'aucune voie du pont ne sait lire : un seul appel, via le
        # client historique — pas un second essai après un échec du pont.
        options = {"choix": choix} if choix is not None else {}
        data, metadata = docie_client.extract_resume(path, progress=progress, session=session, **options)
        return data, {**metadata, "transport": "docie", "voie": "texte"}

    docie_bridge = _load_bridge()

    if progress:
        progress("Envoi du document à DocIE (bridge)")
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise DocIEError(f"Document introuvable ou illisible : {exc}") from None

    options = {}
    if choix is not None:
        options["agent"] = choix.pour_agent(_compter_pages(content, mime_type))

    try:
        bridge_result = docie_bridge.extract_document(content, mime_type, kind="resume", session=session, **options)
    except docie_bridge.DocIEBridgeError as exc:
        _echouer_pont(exc)

    return _adapter(bridge_result, "agent")
