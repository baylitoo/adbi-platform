"""Lecture d'une fiche de poste par la voie texte du pont, ou par un modèle externe choisi : une requête bornée, mise en cache."""
import hashlib
import json
import threading
from collections import OrderedDict
from pathlib import Path

import choix_modele
import docie_client

TACHE = "fiche_de_poste"
SCHEMA = Path(__file__).resolve().parents[1] / "document-parsing" / "schemas" / "fiche_de_poste.schema.json"
TEXTE_MAX = 8000
CACHE_MAX = 64

_cache = OrderedDict()
_verrou = threading.Lock()


class LectureImpossible(RuntimeError):
    """Échec de lecture ; `public` est un message français constant, montrable tel quel."""

    def __init__(self, code, public):
        super().__init__(public)
        self.code = code
        self.public = public


def offres():
    """Modèles proposés pour lire une fiche, défaut d'abord ; liste vide si aucun."""
    try:
        catalogue = choix_modele.charger()
        proposes = catalogue.modeles_offerts(TACHE, "texte", externes=choix_modele.EXTERNES, store=choix_modele.store_pret())
    except Exception:
        return []
    return [{"id": o["id"], "libelle": o["libelle"], "description": o["description"], "role": o["role"],
             "experimental": o.get("experimental") is True, "externe": bool(o.get("fournisseur"))}
            for o in proposes]


def _schema():
    return json.loads(SCHEMA.read_text(encoding="utf-8"))


def _par_externe(texte, offre):
    openai_responses = docie_client._charger_openai()
    try:
        return openai_responses.extraire_via_openai(texte, mode=offre["mode"], dynamic_schema=_schema())
    except Exception as exc:
        code = getattr(exc, "code", None) or "inconnu"
        message = docie_client._MESSAGES_EXTERNE.get(code, "échec de la lecture.")
        raise LectureImpossible(code, f"Service externe (hors ADBI) : {message}") from None


def _par_pont(texte, offre):
    from docie_bridge_extraction import _load_bridge
    pont = _load_bridge()
    try:
        return pont.extract_text(texte, kind=TACHE, dynamic_schema=_schema(), model_profile=offre["identifiant"])
    except pont.DocIEBridgeError as exc:
        traduit = pont.message_erreur(exc)
        raise LectureImpossible(exc.code, traduit["message"] if traduit else
                                "Plateforme d'inférence interne indisponible.") from None


def lire(description, modele=None):
    """(résultat brut sans enveloppes, libellé du modèle) ; LectureImpossible sinon, jamais de substitution."""
    texte = str(description or "").strip()[:TEXTE_MAX]
    if not modele:
        proposes = offres()
        if not proposes:
            raise LectureImpossible("aucun_modele", "Aucun modèle de lecture proposé.")
        modele = proposes[0]["id"]
    catalogue = choix_modele.charger()
    try:
        offre = catalogue.choisir_modele(TACHE, "texte", modele, externes=choix_modele.EXTERNES, store=choix_modele.store_pret(),
                                         document={"lignes_non_vides": catalogue.compter_lignes_non_vides(texte)})
    except catalogue.CatalogueError as exc:
        raise LectureImpossible(exc.code, "Modèle de lecture mal configuré côté serveur." if exc.code == "configuration" else str(exc)) from None
    cle = hashlib.sha256(f"{offre['id']}\0{texte}".encode("utf-8")).hexdigest()
    with _verrou:
        if cle in _cache:
            _cache.move_to_end(cle)
            return _cache[cle]
    sortie = _par_externe(texte, offre) if offre.get("fournisseur") else _par_pont(texte, offre)
    resultat = (docie_client.unwrap((sortie or {}).get("result") or {}), offre["libelle"])
    with _verrou:
        _cache[cle] = resultat
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return resultat
