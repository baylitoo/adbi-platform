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


def _offre_externe(catalogue: dict, t: dict, entree: dict, voie: str, env: Mapping[str, str]) -> dict | None:
    """Offre d'un modèle HORS ADBI (``externes`` d'une voie), ou None.

    Offerte si et seulement si la variable du fournisseur (OPENAI_API_KEY) est
    non vide. ``identifiant`` = le mode de transport, jamais la clé ; ``variable``
    = le NOM de la variable seulement.
    """
    modele = catalogue["modeles"].get(entree.get("modele")) if isinstance(entree, dict) else None
    if not modele or t["usage"] not in modele["etiquettes"] or not modele.get("fournisseur"):
        return None
    fournisseur = (catalogue.get("fournisseurs") or {}).get(modele["fournisseur"])
    if not fournisseur or voie not in fournisseur["voies"]:
        return None
    if not str(env.get(fournisseur["variable"]) or "").strip():
        return None
    return {
        "id": entree["modele"],
        "libelle": modele["libelle"],
        "description": modele["description"],
        "etiquettes": list(modele["etiquettes"]),
        "role": "externe",
        "voie": voie,
        "variable": fournisseur["variable"],
        "identifiant": modele["mode"],
        "limites": dict((modele.get("limites") or {}).get(voie) or {}),
        "condition": entree.get("condition"),
        "prerequis": entree.get("prerequis"),
        "experimental": entree.get("experimental") is True,
        "fournisseur": modele["fournisseur"],
        "mode": modele["mode"],
    }


def _releve(store) -> tuple[set, list]:
    """``store`` : noms des modèles prêts, ou ``{"modeles": noms, "agents": [...]}`` (relevé du pont) -> (noms, agents)."""
    if store is None:
        return set(), []
    if isinstance(store, Mapping):
        return set(store.get("modeles") or []), list(store.get("agents") or [])
    return set(store), []


def identifiant_store(voie: str, modele: dict, store) -> str:
    """``store:<nom>`` si le modèle est prêt sur le store (voies texte/chat), sinon ``""``."""
    nom = modele.get("store")
    if voie == "agent" or not isinstance(nom, str) or nom not in _releve(store)[0]:
        return ""
    return "store:" + nom


def identifiant_agent(voie: str, t: dict, modele: dict, store) -> str:
    """Nom du premier agent prêt qui applique le ``schema`` de la tâche avec le ``store`` du modèle (voie agent), sinon ``""``."""
    if voie != "agent" or not isinstance(t.get("schema"), str) or not isinstance(modele.get("store"), str):
        return ""
    for agent in _releve(store)[1]:
        if isinstance(agent, Mapping) and agent.get("schema") == t["schema"] and agent.get("modele_store") == modele["store"] \
                and isinstance(agent.get("nom"), str) and NOM_AGENT.fullmatch(agent["nom"]):
            return agent["nom"]
    return ""


def modeles_configures(tache: str, voie: str, env: Mapping[str, str] | None = None,
                       catalogue: dict | None = None, externes: bool = False, store=None) -> list[dict]:
    """Modèles configurés pour (tache, voie), défaut d'abord, sans regarder le document.

    ``experimental`` : vrai seulement si l'entrée de la tâche le déclare.
    ``externes`` : le consommateur sait appeler un modèle hors ADBI ; sans cette
    option, aucune offre externe, même avec la clé (sortie inchangée).
    ``store`` : noms des modèles prêts sur le store DocIE, ou relevé
    ``{"modeles", "agents"}`` du pont ; sans variable, un modèle dont le
    ``store`` y figure est proposé sous ``store:<nom>`` (texte/chat), et sur la
    voie agent sous le nom de l'agent prêt qui applique le ``schema`` de la tâche.
    """
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
        # Un modèle externe n'est jamais un défaut ni l'alternative DocIE.
        if not modele or t["usage"] not in modele["etiquettes"] or modele.get("fournisseur"):
            continue
        variable = nom_variable(voie, tache, entree["modele"], catalogue)
        brut = (str(env.get(variable) or "").strip() or identifiant_store(voie, modele, store)
                or identifiant_agent(voie, t, modele, store))
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
            "experimental": entree.get("experimental") is True,
        })
    # Modèles HORS ADBI, après le défaut et l'alternative DocIE, seulement sur
    # demande — et SEULEMENT si au moins un modèle ADBI est configuré pour cette
    # voie (`offres` ne contient encore que défaut/alternative).
    #
    # Sans ce dernier garde-fou, une voie sans modèle DocIE configuré ne
    # proposait QUE des externes. Le premier de la liste est celui que le
    # navigateur présélectionne, et aucune option ne porte `selected` (les
    # interfaces ne le posent que sur `role == "defaut"`) : le document partait
    # donc chez le fournisseur PAR DÉFAUT, sans que personne ne l'ait choisi.
    # La prose de catalogue.json l'interdit depuis toujours — « toujours en plus
    # du défaut et de l'alternative, jamais à leur place ni par défaut » — mais
    # le code ne l'appliquait pas.
    if externes and offres and isinstance(v.get("externes"), list):
        for entree in v["externes"]:
            offre = _offre_externe(catalogue, t, entree, voie, env)
            if offre:
                offres.append(offre)
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
                    document: Mapping[str, int] | None = None, catalogue: dict | None = None,
                    externes: bool = False, store=None) -> list[dict]:
    """Modèles proposés pour (tache, voie) et, s'il est connu, ce document. Défaut d'abord."""
    catalogue = catalogue or charger_catalogue()
    return [o for o in modeles_configures(tache, voie, env, catalogue, externes, store)
            if refus_par_limite(o["id"], voie, document, catalogue) is None]


def choisir_modele(tache: str, voie: str, modele: str, env: Mapping[str, str] | None = None,
                   document: Mapping[str, int] | None = None, catalogue: dict | None = None,
                   externes: bool = False, store=None) -> dict:
    """Le modèle demandé, vérifié sur le document réel. Jamais de substitution."""
    catalogue = catalogue or charger_catalogue()
    t = _tache(catalogue, tache)
    offre = next((o for o in modeles_configures(tache, voie, env, catalogue, externes, store) if o["id"] == modele), None)
    if offre is None:
        # Un modèle externe refusé n'est pas nommé : message d'avant, sans clé.
        connu = catalogue["modeles"].get(modele) if isinstance(modele, str) else None
        nom = connu["libelle"] if connu and not connu.get("fournisseur") else "demandé"
        raise CatalogueError("modele_non_propose", f"Modèle {nom} non proposé pour : {t['libelle']}.")
    refus = refus_par_limite(offre["id"], voie, document, catalogue)
    if refus:
        raise CatalogueError("limite", refus["message"], refus)
    return offre


def modeles_chat(releve, catalogue: dict | None = None) -> list[dict]:
    """Modèles du store utilisables en chat : ceux du catalogue étiquetés ``chat`` d'abord, puis les découverts (aptes, hors catalogue).

    ``releve`` : entrées projetées du store (pont ``store_utilisable``) ; un modèle
    du catalogue sans étiquette ``chat`` n'est jamais proposé, même apte.
    """
    catalogue = catalogue or charger_catalogue()
    par_store = {m["store"]: (mid, m) for mid, m in catalogue["modeles"].items() if isinstance(m.get("store"), str)}
    prets = {e["nom"]: e for e in releve if isinstance(e, dict) and isinstance(e.get("nom"), str) and e.get("utilisable", True)}
    offres = []
    for nom, (mid, m) in par_store.items():
        if nom in prets and "chat" in m["etiquettes"]:
            offres.append({"id": mid, "libelle": m["libelle"], "identifiant": "store:" + nom, "decouvert": False})
    for nom in sorted(prets):
        if nom not in par_store and prets[nom].get("chat") is True:
            offres.append({"id": None, "libelle": nom, "identifiant": "store:" + nom, "decouvert": True})
    return offres


def modele_servi(tache: str, voie: str, metadata: Mapping[str, Any] | None,
                 env: Mapping[str, str] | None = None, catalogue: dict | None = None, store=None) -> dict | None:
    """Le modèle qui a réellement servi (``metadata.model`` voie texte, ``metadata.agent`` voie agent).

    Rapproché des identifiants configurés, avec ou sans ``store:`` ; sans
    correspondance, le nom brut — jamais le libellé du modèle demandé.
    """
    brut = (metadata or {}).get("agent" if voie == "agent" else "model")
    if not isinstance(brut, str) or not brut.strip():
        return None
    fournisseur = (metadata or {}).get("fournisseur")
    if fournisseur is not None:
        # Modèle externe : rapproché par fournisseur + mode, jamais par le nom
        # servi (gpt-6-luna-2026-05-18 ne ressemble à aucun identifiant).
        for o in modeles_configures(tache, voie, env, catalogue, externes=True):
            if o["role"] == "externe" and o["fournisseur"] == fournisseur and o["mode"] == (metadata or {}).get("mode"):
                return {"id": o["id"], "libelle": o["libelle"], "identifiant": brut}
        return {"id": None, "libelle": brut, "identifiant": brut}

    def nu(s: str) -> str:
        s = s.strip()
        return s[len("store:"):] if s.startswith("store:") else s

    for o in modeles_configures(tache, voie, env, catalogue, store=store):
        if nu(o["identifiant"]) == nu(brut):
            return {"id": o["id"], "libelle": o["libelle"], "identifiant": brut}
    return {"id": None, "libelle": brut, "identifiant": brut}
