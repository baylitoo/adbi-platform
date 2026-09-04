"""core/database.py — SQLite pour les besoins clients et les résultats de matching.

La CVthèque reste dans cv_database.json (compatibilité existante).
Ce module gère uniquement les nouvelles tables : needs + matching_results.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from config import DB_FILE

# ── Schéma ────────────────────────────────────────────────────────────────────
_SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS needs (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    context         TEXT DEFAULT '',
    required_skills TEXT NOT NULL DEFAULT '[]',
    bonus_skills    TEXT NOT NULL DEFAULT '[]',
    seniority       TEXT DEFAULT '',
    min_years       INTEGER DEFAULT 0,
    languages       TEXT NOT NULL DEFAULT '[]',
    location        TEXT DEFAULT '',
    remote          TEXT DEFAULT 'flexible',
    start_date      TEXT DEFAULT '',
    contract_type   TEXT DEFAULT 'Tous',
    budget          TEXT DEFAULT '',
    client          TEXT DEFAULT '',
    sector          TEXT DEFAULT '',
    notes           TEXT DEFAULT '',
    raw_text        TEXT DEFAULT '',
    status          TEXT DEFAULT 'active',
    prix_achat      REAL DEFAULT 0,
    prix_vente      REAL DEFAULT 0,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_needs_status     ON needs(status);
CREATE INDEX IF NOT EXISTS idx_needs_created_by ON needs(created_by);

CREATE TABLE IF NOT EXISTS matching_results (
    id               TEXT PRIMARY KEY,
    need_id          TEXT NOT NULL,
    candidate_id     TEXT NOT NULL,
    score_total      REAL NOT NULL DEFAULT 0,
    score_skills     REAL DEFAULT 0,
    score_title      REAL DEFAULT 0,
    score_seniority  REAL DEFAULT 0,
    score_availability REAL DEFAULT 0,
    score_missions   REAL DEFAULT 0,
    score_bonus      REAL DEFAULT 0,
    strengths        TEXT DEFAULT '[]',
    weaknesses       TEXT DEFAULT '[]',
    reservations     TEXT DEFAULT '[]',
    missing_skills   TEXT DEFAULT '[]',
    explanation      TEXT DEFAULT '',
    rank             INTEGER DEFAULT 0,
    computed_at      TEXT NOT NULL,
    FOREIGN KEY (need_id) REFERENCES needs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_match_need  ON matching_results(need_id);
CREATE INDEX IF NOT EXISTS idx_match_score ON matching_results(need_id, score_total DESC);
"""


# ── Connexion ─────────────────────────────────────────────────────────────────

@contextmanager
def _conn():
    con = sqlite3.connect(str(DB_FILE), check_same_thread=False)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db():
    with _conn() as con:
        con.executescript(_SCHEMA)
        # Migration: add price columns if they don't exist (for existing DBs)
        existing_cols = {row[1] for row in con.execute("PRAGMA table_info(needs)").fetchall()}
        if "prix_achat" not in existing_cols:
            con.execute("ALTER TABLE needs ADD COLUMN prix_achat REAL DEFAULT 0")
        if "prix_vente" not in existing_cols:
            con.execute("ALTER TABLE needs ADD COLUMN prix_vente REAL DEFAULT 0")
    print("[DB] SQLite initialisee.")  # ASCII-safe for Windows consoles


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else (v or "")


def _uj(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return []
    return v or []


def _row_to_need(row) -> dict:
    d = dict(row)
    for f in ("required_skills", "bonus_skills", "languages"):
        d[f] = _uj(d.get(f))
    return d


def _row_to_match(row) -> dict:
    d = dict(row)
    for f in ("strengths", "weaknesses", "reservations", "missing_skills"):
        d[f] = _uj(d.get(f))
    return d


# ══════════════════════════════════════════════════════════════════════════════
# NEEDS
# ══════════════════════════════════════════════════════════════════════════════

def insert_need(need: dict, created_by: str) -> dict:
    now = _now()
    nid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO needs
              (id, title, context, required_skills, bonus_skills, seniority, min_years,
               languages, location, remote, start_date, contract_type, budget,
               client, sector, notes, raw_text, status,
               prix_achat, prix_vente,
               created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            nid,
            need.get("title", ""),
            need.get("context", ""),
            _j(need.get("required_skills", [])),
            _j(need.get("bonus_skills", [])),
            need.get("seniority", ""),
            int(need.get("min_years", 0)),
            _j(need.get("languages", [])),
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
        ))
    return get_need(nid)


def get_need(need_id: str) -> dict | None:
    with _conn() as con:
        row = con.execute("SELECT * FROM needs WHERE id = ?", (need_id,)).fetchone()
    return _row_to_need(row) if row else None


def list_needs(created_by: str | None = None, status: str | None = None) -> list[dict]:
    sql = "SELECT * FROM needs WHERE 1=1"
    params = []
    if created_by:
        sql += " AND created_by = ?"
        params.append(created_by)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC"
    with _conn() as con:
        rows = con.execute(sql, params).fetchall()
    return [_row_to_need(r) for r in rows]


def update_need(need_id: str, updates: dict) -> dict | None:
    existing = get_need(need_id)
    if not existing:
        return None
    allowed = {
        "title", "context", "required_skills", "bonus_skills", "seniority", "min_years",
        "languages", "location", "remote", "start_date", "contract_type", "budget",
        "client", "sector", "notes", "raw_text", "status",
        "prix_achat", "prix_vente",
    }
    fields, vals = [], []
    for k, v in updates.items():
        if k in allowed:
            fields.append(f"{k} = ?")
            vals.append(_j(v) if isinstance(v, list) else v)
    if not fields:
        return existing
    vals.extend([_now(), need_id])
    with _conn() as con:
        con.execute(
            f"UPDATE needs SET {', '.join(fields)}, updated_at = ? WHERE id = ?",
            vals,
        )
    return get_need(need_id)


def delete_need(need_id: str) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM needs WHERE id = ?", (need_id,))
    return cur.rowcount > 0


# ══════════════════════════════════════════════════════════════════════════════
# MATCHING RESULTS
# ══════════════════════════════════════════════════════════════════════════════

def upsert_match_results(need_id: str, results: list[dict]):
    """Remplace tous les résultats d'un besoin par les nouveaux."""
    now = _now()
    with _conn() as con:
        con.execute("DELETE FROM matching_results WHERE need_id = ?", (need_id,))
        for r in results:
            score = r.get("score", {})
            expl  = r.get("explanation", {})
            con.execute("""
                INSERT INTO matching_results
                  (id, need_id, candidate_id, score_total, score_skills, score_title,
                   score_seniority, score_availability, score_missions, score_bonus,
                   strengths, weaknesses, reservations, missing_skills,
                   explanation, rank, computed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
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
                _j(expl.get("strengths", [])),
                _j(expl.get("weaknesses", [])),
                _j(expl.get("reservations", [])),
                _j(expl.get("missing_skills", [])),
                expl.get("summary", ""),
                r.get("rank", 0),
                now,
            ))


def get_match_results(need_id: str) -> list[dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM matching_results WHERE need_id = ? ORDER BY rank ASC",
            (need_id,),
        ).fetchall()
    return [_row_to_match(r) for r in rows]


def get_match_result(need_id: str, candidate_id: str) -> dict | None:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM matching_results WHERE need_id = ? AND candidate_id = ?",
            (need_id, candidate_id),
        ).fetchone()
    return _row_to_match(row) if row else None
