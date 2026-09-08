"""core/database_pg.py — PostgreSQL pour needs + matching_results.

Même API que core/database.py (SQLite), mêmes noms/formes de fonctions,
mais backée par PostgreSQL (JSONB pour les listes libres au lieu de TEXT
JSON sérialisé à la main). Tant qu'app.py / api/needs_bp.py / api/matching_bp.py
n'ont pas été basculés dessus (voir issue #15, PR de bascule), ce module
n'est importé que par scripts/migrer_vers_postgres.py et les tests.

N'importe PAS config.py (effets de bord au chargement) : voir core/pg.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from psycopg.types.json import Jsonb

from core.pg import get_conn, init_schema

__all__ = [
    "init_db",
    "insert_need", "get_need", "list_needs", "update_need", "delete_need",
    "upsert_match_results", "get_match_results", "get_match_result",
]


def init_db() -> None:
    init_schema()
    print("[DB] Schema PostgreSQL initialise (needs/matching_results).")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v) -> str:
    """Normalise un timestamp (datetime psycopg ou None) en chaîne ISO,
    comme le renvoyait sqlite3.Row (TEXT ISO) côté core/database.py."""
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _row_to_need(row: dict) -> dict:
    d = dict(row)
    d["created_at"] = _iso(d.get("created_at"))
    d["updated_at"] = _iso(d.get("updated_at"))
    return d


def _row_to_match(row: dict) -> dict:
    d = dict(row)
    d["computed_at"] = _iso(d.get("computed_at"))
    return d


# ══════════════════════════════════════════════════════════════════════════════
# NEEDS
# ══════════════════════════════════════════════════════════════════════════════

def insert_need(need: dict, created_by: str) -> dict:
    now = _now()
    nid = str(uuid.uuid4())
    with get_conn() as con:
        con.execute(
            """
            INSERT INTO needs
              (id, title, context, required_skills, bonus_skills, seniority, min_years,
               languages, location, remote, start_date, contract_type, budget,
               client, sector, notes, raw_text, status,
               prix_achat, prix_vente,
               created_by, created_at, updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                nid,
                need.get("title", ""),
                need.get("context", ""),
                Jsonb(need.get("required_skills") or []),
                Jsonb(need.get("bonus_skills") or []),
                need.get("seniority", ""),
                # `or 0` : un "min_years": null explicite (accepté par
                # _valider_besoin — voir needs_bp.py::_CHAMPS_ENTIERS, qui
                # traite None comme "pas de valeur") laisse la clé présente
                # dans le dict avec une valeur None ; sans ce repli,
                # need.get("min_years", 0) renvoie None (le défaut ne joue
                # que si la clé est ABSENTE) et int(None) lève TypeError, non
                # rattrapé par create_need() — 500 brut. update_need() et les
                # deux champs prix_achat/prix_vente juste en dessous ont déjà
                # ce repli ; seul celui-ci manquait (issue #144/#145 : promis
                # pour "null -> 0" mais jamais appliqué à ce cast précis).
                int(need.get("min_years", 0) or 0),
                Jsonb(need.get("languages") or []),
                need.get("location", ""),
                need.get("remote", "flexible"),
                need.get("start_date", ""),
                need.get("contract_type", "Tous"),
                need.get("budget", ""),
                need.get("client", ""),
                need.get("sector", ""),
                need.get("notes", ""),
                need.get("raw_text", ""),
                "active",
                float(need.get("prix_achat", 0) or 0),
                float(need.get("prix_vente", 0) or 0),
                created_by,
                now,
                now,
            ),
        )
    return get_need(nid)


def get_need(need_id: str) -> dict | None:
    with get_conn() as con:
        row = con.execute("SELECT * FROM needs WHERE id = %s", (need_id,)).fetchone()
    return _row_to_need(row) if row else None


def list_needs(created_by: str | None = None, status: str | None = None) -> list[dict]:
    sql = "SELECT * FROM needs WHERE 1=1"
    params: list = []
    if created_by:
        sql += " AND created_by = %s"
        params.append(created_by)
    if status:
        sql += " AND status = %s"
        params.append(status)
    sql += " ORDER BY created_at DESC"
    with get_conn() as con:
        rows = con.execute(sql, params).fetchall()
    return [_row_to_need(r) for r in rows]


_ALLOWED_UPDATE_FIELDS = {
    "title", "context", "required_skills", "bonus_skills", "seniority", "min_years",
    "languages", "location", "remote", "start_date", "contract_type", "budget",
    "client", "sector", "notes", "raw_text", "status",
    "prix_achat", "prix_vente",
}

_JSONB_FIELDS = {"required_skills", "bonus_skills", "languages"}
# Colonnes numériques (INTEGER / REAL) : sans ce cast, une valeur string/bool/
# liste envoyée par le client part telle quelle dans le paramètre SQL et
# Postgres la rejette avec une erreur de type non gérée (500 brut) au lieu
# d'un 400 propre — contrairement à insert_need() qui caste déjà ces mêmes
# champs à l'écriture.
_NUMERIC_INT_FIELDS = {"min_years"}
_NUMERIC_FLOAT_FIELDS = {"prix_achat", "prix_vente"}


def update_need(need_id: str, updates: dict) -> dict | None:
    existing = get_need(need_id)
    if not existing:
        return None
    fields, vals = [], []
    for k, v in updates.items():
        if k not in _ALLOWED_UPDATE_FIELDS:
            continue
        if k in _JSONB_FIELDS:
            v = Jsonb(v)
        elif k in _NUMERIC_INT_FIELDS:
            v = int(v or 0)
        elif k in _NUMERIC_FLOAT_FIELDS:
            v = float(v or 0)
        fields.append(f"{k} = %s")
        vals.append(v)
    if not fields:
        return existing
    vals.extend([_now(), need_id])
    with get_conn() as con:
        con.execute(
            f"UPDATE needs SET {', '.join(fields)}, updated_at = %s WHERE id = %s",
            vals,
        )
    return get_need(need_id)


def delete_need(need_id: str) -> bool:
    with get_conn() as con:
        cur = con.execute("DELETE FROM needs WHERE id = %s", (need_id,))
        return cur.rowcount > 0


# ══════════════════════════════════════════════════════════════════════════════
# MATCHING RESULTS
# ══════════════════════════════════════════════════════════════════════════════

def upsert_match_results(need_id: str, results: list[dict]) -> None:
    """Remplace tous les résultats d'un besoin par les nouveaux (même
    comportement que core/database.py : DELETE puis ré-insertion)."""
    now = _now()
    with get_conn() as con:
        con.execute("DELETE FROM matching_results WHERE need_id = %s", (need_id,))
        for r in results:
            score = r.get("score", {})
            expl = r.get("explanation", {})
            con.execute(
                """
                INSERT INTO matching_results
                  (id, need_id, candidate_id, score_total, score_skills, score_title,
                   score_seniority, score_availability, score_missions, score_bonus,
                   strengths, weaknesses, reservations, missing_skills,
                   explanation, rank, computed_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    str(uuid.uuid4()),
                    need_id,
                    r["candidate_id"],
                    round(score.get("total", 0), 2),
                    round(score.get("skills", 0), 2),
                    round(score.get("title", 0), 2),
                    round(score.get("seniority", 0), 2),
                    round(score.get("availability", 0), 2),
                    round(score.get("missions", 0), 2),
                    round(score.get("bonus", 0), 2),
                    Jsonb(expl.get("strengths") or []),
                    Jsonb(expl.get("weaknesses") or []),
                    Jsonb(expl.get("reservations") or []),
                    Jsonb(expl.get("missing_skills") or []),
                    expl.get("summary", ""),
                    r.get("rank", 0),
                    now,
                ),
            )


def get_match_results(need_id: str) -> list[dict]:
    with get_conn() as con:
        rows = con.execute(
            "SELECT * FROM matching_results WHERE need_id = %s ORDER BY rank ASC",
            (need_id,),
        ).fetchall()
    return [_row_to_match(r) for r in rows]


def get_match_result(need_id: str, candidate_id: str) -> dict | None:
    with get_conn() as con:
        row = con.execute(
            "SELECT * FROM matching_results WHERE need_id = %s AND candidate_id = %s",
            (need_id, candidate_id),
        ).fetchone()
    return _row_to_match(row) if row else None
