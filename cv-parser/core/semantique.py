"""Recherche sémantique de la CVthèque : vecteurs DocIE (/v1/embeddings) rangés dans pgvector, à côté de la recherche classique."""
from __future__ import annotations

import hashlib

from core.pg import get_conn

LOT = 32
REQUETE_MAX = 500

_CREER = (
    "CREATE EXTENSION IF NOT EXISTS vector",
    "CREATE TABLE IF NOT EXISTS cv_embeddings ("
    " cv_id TEXT NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,"
    " modele TEXT NOT NULL, empreinte TEXT NOT NULL, embedding vector NOT NULL,"
    " PRIMARY KEY (cv_id, modele))",
)


class Indisponible(RuntimeError):
    def __init__(self, raison: str, message: str):
        super().__init__(message)
        self.raison = raison


_MESSAGES = {
    "pont_absent": "Recherche sémantique indisponible : pont DocIE absent.",
    "aucun_modele": "Recherche sémantique indisponible : aucun modèle d'embedding prêt sur DocIE.",
    "pgvector_absent": "Recherche sémantique indisponible : extension pgvector absente de la base.",
}


def _pont():
    from docie_bridge_extraction import _load_bridge
    return _load_bridge()


def _preparer() -> None:
    with get_conn() as con:
        for requete in _CREER:
            con.execute(requete)


def _modele() -> str:
    try:
        pont = _pont()
    except Exception:
        raise Indisponible("pont_absent", _MESSAGES["pont_absent"]) from None
    modele = pont.embedder_pret()
    if not modele:
        raise Indisponible("aucun_modele", _MESSAGES["aucun_modele"])
    try:
        _preparer()
    except Exception:
        raise Indisponible("pgvector_absent", _MESSAGES["pgvector_absent"]) from None
    return modele


def etat() -> dict:
    """{disponible, modele?, raison?, message?} pour l'interface."""
    try:
        return {"disponible": True, "modele": _modele()}
    except Indisponible as exc:
        return {"disponible": False, "raison": exc.raison, "message": str(exc)}


def texte_cv(cv: dict) -> str:
    parts = [cv.get("title"), cv.get("summary"), ", ".join(str(s) for s in (cv.get("skills_flat") or []))]
    for exp in cv.get("experience") or []:
        if isinstance(exp, dict):
            parts += [exp.get("title"), exp.get("client"), exp.get("company"), exp.get("contexte"),
                      exp.get("description"), exp.get("env_technique")]
    return "\n".join(str(p).strip() for p in parts if p and str(p).strip())


def _vecteur(v: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in v) + "]"


def indexer(cvs: dict, modele: str) -> int:
    """Calcule les vecteurs manquants ou périmés (texte changé) pour `modele` ; renvoie leur nombre."""
    textes = {cid: texte_cv(cv) for cid, cv in cvs.items()}
    empreintes = {cid: hashlib.sha256(t.encode("utf-8")).hexdigest() for cid, t in textes.items() if t}
    with get_conn() as con:
        connues = {r["cv_id"]: r["empreinte"] for r in con.execute(
            "SELECT cv_id, empreinte FROM cv_embeddings WHERE modele = %s", (modele,)).fetchall()}
    a_faire = [cid for cid, e in empreintes.items() if connues.get(cid) != e]
    pont = _pont()
    for debut in range(0, len(a_faire), LOT):
        lot = a_faire[debut:debut + LOT]
        vecteurs = pont.embed([textes[cid] for cid in lot], modele=modele)
        with get_conn() as con:
            for cid, v in zip(lot, vecteurs):
                con.execute(
                    "INSERT INTO cv_embeddings (cv_id, modele, empreinte, embedding) VALUES (%s, %s, %s, %s::vector)"
                    " ON CONFLICT (cv_id, modele) DO UPDATE SET empreinte = EXCLUDED.empreinte,"
                    " embedding = EXCLUDED.embedding", (cid, modele, empreintes[cid], _vecteur(v)))
    return len(a_faire)


def rechercher(q: str, cvs: dict) -> tuple[list[dict], str]:
    """([{id, score}] du plus proche au plus lointain, modèle) ; score = similarité cosinus."""
    q = (q or "").strip()[:REQUETE_MAX]
    modele = _modele()
    indexer(cvs, modele)
    requete = _pont().embed([q], modele=modele)[0]
    with get_conn() as con:
        lignes = con.execute(
            "SELECT cv_id, 1 - (embedding <=> %s::vector) AS score FROM cv_embeddings"
            " WHERE modele = %s AND vector_dims(embedding) = %s ORDER BY embedding <=> %s::vector",
            (_vecteur(requete), modele, len(requete), _vecteur(requete))).fetchall()
    return [{"id": r["cv_id"], "score": round(float(r["score"]), 4)} for r in lignes if r["cv_id"] in cvs], modele
