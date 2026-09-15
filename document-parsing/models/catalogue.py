"""Chargeur Python du catalogue des modèles (#194) — portage jumeau de catalogue.js.

Pour une tâche (``resume``, ``contract``…) et une voie DocIE (``texte``,
``agent``, ``chat``) : quels modèles proposer, défaut d'abord, avec quel
identifiant réel.

- ``catalogue.json`` porte rôles, libellés, étiquettes et limites.
- L'environnement porte les identifiants réels (motifs sous ``variables``) :
  ``DOCIE_MODELE_<MODELE>`` (voie texte, référence ``store:<nom>`` attendue) et
  ``DOCIE_AGENT_<TACHE>_<MODELE>`` (voie agent : le modèle est figé par l'agent).
- Un modèle sans identifiant configuré n'est pas proposé. Aucun identifiant pour
  une tâche et une voie : liste vide, le consommateur garde son comportement
  d'avant (``DOCIE_MODEL_PROFILE`` / ``DOCIE_AGENT_<TYPE>``).

Aucun appel réseau, aucune substitution : ``choisir_modele`` lève une erreur
nommée plutôt que de retomber sur le défaut (« échouer bruyamment »).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

CHEMIN_CATALOGUE = Path(__file__).with_name("catalogue.json")

NOM_AGENT = re.compile(r"[A-Za-z0-9_-]{1,128}")
CONTROLE = re.compile(r"[\x00-\x1f\x7f]")


class CatalogueError(Exception):
    def __init__(self, code: str, message: str, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details


_cache: dict | None = None


def charger_catalogue() -> dict:
    global _cache
    if _cache is None:
        _cache = json.loads(CHEMIN_CATALOGUE.read_text(encoding="utf-8"))
    return _cache


def compter_lignes_non_vides(texte: str) -> int:
    """Règle exacte de DocIE (ocr/base.py::text_to_blocks, #190)."""
    return sum(1 for ligne in str(texte).splitlines() if ligne.strip())


def _identifiant_valide(voie: str, valeur: str) -> bool:
    if voie == "agent":
        return NOM_AGENT.fullmatch(valeur) is not None
    return CONTROLE.search(valeur) is None and len(valeur.encode("utf-8")) <= 128


def nom_variable(voie: str, tache: str, modele: str, catalogue: dict | None = None) -> str:
    catalogue = catalogue or charger_catalogue()
    motif = catalogue["variables"].get(voie)
    if not isinstance(motif, str):
        raise CatalogueError("voie", "Voie inconnue du catalogue.")
    return motif.replace("{TACHE}", str(tache).upper()).replace("{MODELE}", str(modele).upper())


def _tache(catalogue: dict, tache: str) -> dict:
    if tache not in catalogue["taches"]:
        raise CatalogueError("tache", "Tâche inconnue du catalogue.")
    return catalogue["taches"][tache]


def modeles_configures(tache: str, voie: str, env: Mapping[str, str] | None = None,
                       catalogue: dict | None = None) -> list[dict]:
    """Modèles configurés pour (tache, voie), défaut d'abord, sans regarder le document."""
    catalogue = catalogue or charger_catalogue()
    env = os.environ if env is None else env
    t = _tache(catalogue, tache)
    v = t["voies"].get(voie)
    if not v:
        return []
    offres = []
    for role in ("defaut", "alternative"):
        entree = v.get(role)
        if not entree:
            continue
        modele = catalogue["modeles"].get(entree["modele"])
        if not modele or t["usage"] not in modele["etiquettes"]:
            continue
        variable = nom_variable(voie, tache, entree["modele"], catalogue)
        brut = str(env.get(variable) or "").strip()
        if not brut:
            continue
        if not _identifiant_valide(voie, brut):
            raise CatalogueError("configuration", f"Identifiant mal formé dans {variable}.", {"variable": variable})
        offres.append({
            "id": entree["modele"],
            "libelle": modele["libelle"],
            "description": modele["description"],
            "etiquettes": list(modele["etiquettes"]),
            "role": role,
            "voie": voie,
            "variable": variable,
            "identifiant": brut,
            "limites": dict((modele.get("limites") or {}).get(voie) or {}),
            "condition": entree.get("condition"),
            "prerequis": entree.get("prerequis"),
        })
    return offres


def refus_par_limite(modele_id: str, voie: str, document: Mapping[str, int] | None,
                     catalogue: dict | None = None) -> dict | None:
    """Limite du modèle dépassée par ce document, ou None.

    ``document`` : ``{"lignes_non_vides": int, "pages": int}`` ; un fait absent
    n'est pas évalué — rappeler ``choisir_modele`` avec le document réel avant l'envoi.
    """
    catalogue = catalogue or charger_catalogue()
    modele = catalogue["modeles"].get(modele_id) or {}
    limites = (modele.get("limites") or {}).get(voie) or {}
    doc = document or {}
    lignes, max_lignes = doc.get("lignes_non_vides"), limites.get("lignes_non_vides_max")
    if isinstance(max_lignes, int) and isinstance(lignes, int) and lignes > max_lignes:
        return {"code": "limite_lignes", "valeur": lignes, "max": max_lignes,
                "message": f"{modele['libelle']} n'est pas proposé au-delà de {max_lignes} lignes non vides (document : {lignes})."}
    pages, max_pages = doc.get("pages"), limites.get("pages_max")
    if isinstance(max_pages, int) and isinstance(pages, int) and pages > max_pages:
        return {"code": "limite_pages", "valeur": pages, "max": max_pages,
                "message": f"{modele['libelle']} n'est pas proposé au-delà de {max_pages} pages (document : {pages})."}
    return None


def modeles_offerts(tache: str, voie: str, env: Mapping[str, str] | None = None,
                    document: Mapping[str, int] | None = None, catalogue: dict | None = None) -> list[dict]:
    """Modèles proposés pour (tache, voie) et, s'il est connu, ce document. Défaut d'abord."""
    catalogue = catalogue or charger_catalogue()
    return [o for o in modeles_configures(tache, voie, env, catalogue)
            if refus_par_limite(o["id"], voie, document, catalogue) is None]


def choisir_modele(tache: str, voie: str, modele: str, env: Mapping[str, str] | None = None,
                   document: Mapping[str, int] | None = None, catalogue: dict | None = None) -> dict:
    """Le modèle demandé, vérifié sur le document réel. Jamais de substitution."""
    catalogue = catalogue or charger_catalogue()
    t = _tache(catalogue, tache)
    offre = next((o for o in modeles_configures(tache, voie, env, catalogue) if o["id"] == modele), None)
    if offre is None:
        nom = catalogue["modeles"][modele]["libelle"] if modele in catalogue["modeles"] else "demandé"
        raise CatalogueError("modele_non_propose", f"Modèle {nom} non proposé pour : {t['libelle']}.")
    refus = refus_par_limite(offre["id"], voie, document, catalogue)
    if refus:
        raise CatalogueError("limite", refus["message"], refus)
    return offre


def modele_servi(tache: str, voie: str, metadata: Mapping[str, Any] | None,
                 env: Mapping[str, str] | None = None, catalogue: dict | None = None) -> dict | None:
    """Le modèle qui a réellement servi (``metadata.model`` voie texte, ``metadata.agent`` voie agent).

    Rapproché des identifiants configurés, avec ou sans ``store:`` ; sans
    correspondance, le nom brut — jamais le libellé du modèle demandé.
    """
    brut = (metadata or {}).get("agent" if voie == "agent" else "model")
    if not isinstance(brut, str) or not brut.strip():
        return None

    def nu(s: str) -> str:
        s = s.strip()
        return s[len("store:"):] if s.startswith("store:") else s

    for o in modeles_configures(tache, voie, env, catalogue):
        if nu(o["identifiant"]) == nu(brut):
            return {"id": o["id"], "libelle": o["libelle"], "identifiant": brut}
    return {"id": None, "libelle": brut, "identifiant": brut}
