"""Choix du modèle d'extraction d'un CV, par action (#194).

Le catalogue partagé (document-parsing/models/catalogue.json et son chargeur
catalogue.py, source unique) dit quels modèles proposer pour la tâche
`resume`, sur quelle voie DocIE, avec quel identifiant réel (variables
DOCIE_MODELE_<MODELE> et DOCIE_AGENT_RESUME_<MODELE>). Ce module ne fait que
l'appliquer à cv-parser :

- la VOIE d'un fichier suit la configuration existante, sans rien réaiguiller :
  bridge actif (DOCIE_EXTRACTION_ENABLED) et PDF -> voie `agent`
  (docie_bridge_extraction) ; client historique en mode inline -> voie
  `texte` (docie_client, PDF texte ou DOCX) ; mode studio -> aucune voie du
  catalogue, donc aucun sélecteur ;
- le sélecteur ne s'affiche que si PLUSIEURS modèles sont proposés : tant
  qu'aucune alternative n'est configurée, l'écran ne change pas ;
- un choix EXPLICITE = un champ `modele` non vide reçu avec le dépôt ou la
  ré-analyse. Le sélecteur, quand il est affiché, l'envoie toujours (défaut
  compris) : l'utilisateur a vu le modèle nommé à côté du bouton. Sans champ,
  comportement d'avant le catalogue, repli compris ;
- un choix est vérifié sur le document RÉEL juste avant l'envoi (lignes non
  vides pour la voie texte, pages pour la voie agent) et n'est jamais
  remplacé par un autre modèle : refus nommé (`modele_non_propose`,
  `limite`, `configuration`), levé comme ErreurTache — la tâche échoue avec
  ce code, sans fiche vide de repli.

Le chargeur est lu par son chemin (importlib), jamais par sys.path : dans
l'image, il est copié sous /document-parsing/models/ (voir le Dockerfile),
même profondeur relative que dans le dépôt.
"""
import importlib.util
import os
from pathlib import Path

from docie_bridge_extraction import docie_extraction_enabled
from taches_upload import ErreurTache

TACHE = "resume"
CHEMIN_CHARGEUR = Path(__file__).resolve().parents[1] / "document-parsing" / "models" / "catalogue.py"

# Extensions que le bridge reçoit en fichier (docie_bridge_extraction._MIME_BY_SUFFIX).
_EXT_BRIDGE = (".pdf", ".png", ".jpg", ".jpeg", ".webp")
# Extensions que le client historique lit en texte en mode inline (docie_client.extract_resume).
_EXT_TEXTE = (".pdf", ".docx")

_catalogue = None


def charger():
    """Le module catalogue.py, chargé une fois. Absent : FileNotFoundError."""
    global _catalogue
    if _catalogue is None:
        spec = importlib.util.spec_from_file_location("adbi_catalogue_modeles", CHEMIN_CHARGEUR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _catalogue = module
    return _catalogue


def voie_pour(ext):
    """Voie DocIE que prendra un fichier de cette extension, ou None."""
    ext = str(ext or "").lower()
    if docie_extraction_enabled() and ext in _EXT_BRIDGE:
        return "agent"
    if os.environ.get("DOCIE_EXTRACTION_MODE", "inline") == "inline" and ext in _EXT_TEXTE:
        return "texte"
    return None


def modeles_proposes(ext=None):
    """Modèles du sélecteur, défaut d'abord : [{id, libelle, description, role}].

    `ext` connu (ré-analyse) : la voie de ce fichier. Absent (dépôt, PDF ou
    DOCX, en lot) : les voies des deux formats réunies ; un modèle configuré
    sur une seule voie est vérifié sur le fichier réel au moment de l'envoi.
    Les limites ne sont pas évaluées ici (document inconnu).
    """
    voies = []
    for e in ([ext] if ext else [".pdf", ".docx"]):
        voie = voie_pour(e)
        if voie and voie not in voies:
            voies.append(voie)
    if not voies:
        return []
    catalogue = charger()
    vus = {}
    for voie in voies:
        for offre in catalogue.modeles_offerts(TACHE, voie):
            vus.setdefault(offre["id"], {"id": offre["id"], "libelle": offre["libelle"],
                                         "description": offre["description"], "role": offre["role"]})
    return sorted(vus.values(), key=lambda o: o["role"] != "defaut")


def offres_par_format():
    """{".pdf": [ids], ".docx": [ids]} : modèles proposés pour la voie de chaque
    format accepté au dépôt. Le navigateur envoie `modele` pour un fichier dès
    qu'au moins un modèle est proposé pour SON format (même règle que contrats,
    #210), sélecteur affiché ou non."""
    catalogue = None
    offres = {}
    for ext in (".pdf", ".docx"):
        voie = voie_pour(ext)
        if voie is None:
            offres[ext] = []
            continue
        catalogue = catalogue or charger()
        offres[ext] = [o["id"] for o in catalogue.modeles_offerts(TACHE, voie)]
    return offres


class Choix:
    """Un modèle explicitement choisi, vérifié voie par voie sur le document réel.

    Passé à docie_client.extract_resume (`pour_texte`) et à
    docie_bridge_extraction.extract_resume (`pour_agent`), qui l'appellent
    juste avant l'appel réseau et envoient l'identifiant rendu.
    """

    def __init__(self, modele):
        self.modele = modele
        self.offre = None

    def _choisir(self, voie, document):
        catalogue = charger()
        try:
            self.offre = catalogue.choisir_modele(TACHE, voie, self.modele, document=document)
        except catalogue.CatalogueError as exc:
            raise ErreurTache(str(exc), code=exc.code) from None
        return self.offre["identifiant"]

    def verifier(self, ext):
        """Avant tout travail : le modèle est-il proposé pour la voie de ce fichier ?"""
        voie = voie_pour(ext)
        if voie is None:
            # Même message que le catalogue pour un modèle non configuré.
            return self._choisir("__aucune__", None)
        return self._choisir(voie, None)

    def pour_texte(self, texte):
        return self._choisir("texte", {"lignes_non_vides": charger().compter_lignes_non_vides(texte)})

    def pour_agent(self, pages):
        """`pages` None : nombre de pages illisible. Refusé si le modèle a une
        limite de pages — une limite non vérifiable n'est pas une limite respectée."""
        if pages is None:
            offre = self._choisir("agent", None)
            if self.offre["limites"].get("pages_max") is not None:
                raise ErreurTache(
                    f"{self.offre['libelle']} : nombre de pages du document illisible, "
                    f"limite de {self.offre['limites']['pages_max']} pages non vérifiable.", code="limite")
            return offre
        return self._choisir("agent", {"pages": pages})


def resultat_partiel(metadata, data):
    """Résultat partiel d'une extraction (#203) : [{champ, raison}], ou None si
    on n'a pas pu le vérifier.

    Voie agent : relevé par le bridge (`metadata["partiel"]`). Voie texte (client
    historique, hors bridge) : même relevé, par la fonction du bridge — une
    seule reconnaissance des libellés DocIE, jamais recopiée ici.
    """
    partiel = (metadata or {}).get("partiel")
    if isinstance(partiel, list):
        return partiel
    try:
        from docie_bridge_extraction import _load_bridge
        return _load_bridge().resultat_partiel((metadata or {}).get("validation"), data)
    except Exception:
        return None


def modele_servi(voie, metadata):
    """Le modèle qui a RÉELLEMENT servi : {id, libelle} ou None.

    Lu dans la réponse (`model` voie texte, `agent` voie agent), rapproché des
    identifiants configurés avec ou sans `store:` ; sans correspondance, le nom
    brut rapporté par DocIE, jamais le modèle demandé. Même forme que contrats
    (#210) : l'identifiant `store:` configuré n'est pas recopié sur la fiche.
    Catalogue illisible : le nom brut, jamais une exception.
    """
    try:
        servi = charger().modele_servi(TACHE, voie, metadata)
    except Exception:
        brut = (metadata or {}).get("agent" if voie == "agent" else "model")
        servi = {"id": None, "libelle": brut} if isinstance(brut, str) and brut.strip() else None
    return {"id": servi["id"], "libelle": servi["libelle"]} if servi else None
