"""Indexation sémantique en tâche de fond : un thread démon, file dédoublonnée par fiche, rattrapage par modèle."""
from __future__ import annotations

import sys
import threading
from collections import deque

from core import cvstore_pg, semantique

LOT = semantique.LOT
RATTRAPAGE_S = 300

_cond = threading.Condition()
_file: deque = deque()
_en_file: set = set()
_a_reprendre: set = set()
_etat = {"thread": None, "abonne": False, "rattrape": None, "demarrage": True}


def signaler(cv_id: str) -> None:
    """Met la fiche en file (une seule fois tant qu'elle n'est pas traitée)."""
    with _cond:
        if cv_id not in _en_file:
            _en_file.add(cv_id)
            _file.append(cv_id)
            _cond.notify()


def demarrer() -> None:
    """Abonne la file aux écritures de fiches et lance le thread (rattrapage compris), sans bloquer."""
    with _cond:
        if not _etat["abonne"]:
            cvstore_pg.abonner(signaler)
            _etat["abonne"] = True
        if _etat["thread"] is None or not _etat["thread"].is_alive():
            _etat["thread"] = threading.Thread(target=_boucle, name="indexation-semantique", daemon=True)
            _etat["thread"].start()


def _journal(quoi: str, exc: Exception) -> None:
    code = getattr(exc, "code", None)
    print(f"[semantique] {quoi} en échec ({type(exc).__name__}"
          f"{', ' + code if isinstance(code, str) else ''}) ; nouvelle tentative plus tard", file=sys.stderr)


def _modele() -> str | None:
    try:
        return semantique._modele()
    except semantique.Indisponible:
        return None


def _indexer(cvs: dict, modele: str) -> None:
    try:
        semantique.indexer(cvs, modele)
    except Exception as exc:
        _journal(f"indexation de {len(cvs)} fiche(s)", exc)
        with _cond:
            _a_reprendre.update(cvs)


def _rattraper(modele: str) -> None:
    cvs = cvstore_pg.list_cvs()
    ids = list(cvs)
    for debut in range(0, len(ids), LOT):
        _indexer({cid: cvs[cid] for cid in ids[debut:debut + LOT]}, modele)


def _tour() -> None:
    with _cond:
        if not _file and not _etat["demarrage"]:
            _cond.wait(timeout=RATTRAPAGE_S)
        _etat["demarrage"] = False
        if not _file:
            _file.extend(i for i in _a_reprendre if i not in _en_file)
            _en_file.update(_a_reprendre)
            _a_reprendre.clear()
        lot = [_file.popleft() for _ in range(min(LOT, len(_file)))]
        _en_file.difference_update(lot)
    try:
        _traiter(lot)
    except Exception:
        with _cond:
            _a_reprendre.update(lot)
        raise


def _traiter(lot: list[str]) -> None:
    modele = _modele()
    if modele is None:
        _etat["rattrape"] = None
        return
    if modele != _etat["rattrape"]:
        _rattraper(modele)
        _etat["rattrape"] = modele
    cvs = {cid: cv for cid, cv in ((cid, cvstore_pg.get_cv(cid)) for cid in lot) if cv}
    if cvs:
        _indexer(cvs, modele)


def _boucle() -> None:
    while True:
        try:
            _tour()
        except Exception as exc:
            _journal("indexation en tâche de fond", exc)
            with _cond:
                _cond.wait(timeout=RATTRAPAGE_S)
