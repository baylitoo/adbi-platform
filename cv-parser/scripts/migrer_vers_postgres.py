#!/usr/bin/env python3
"""scripts/migrer_vers_postgres.py — Migration ponctuelle vers PostgreSQL (issue #15).

Copie dans adbi_cv_parser (DATABASE_URL) :
  - data/adbi.db (SQLite)   -> needs, matching_results
  - data/users.json         -> users
  - data/tokens.json        -> refresh_tokens
  - data/invites.json       -> invites
  - data/activity.json      -> activity
  - cv_database.json        -> cvs

NE TOUCHE À AUCUN fichier source (lecture seule). Rejouable sans risque :
toutes les insertions utilisent ON CONFLICT DO UPDATE (ou DO NOTHING pour
activity, qui n'a pas d'id naturel côté JSON — voir _activity_id ci-dessous).

Ce script, comme les modules core/*_pg.py, n'importe PAS config.py (effets
de bord : création de data/jwt_secret.txt, rangement des llm_*.txt...) — les
chemins par défaut sont recalculés ici, et surchageables via variables
d'environnement pour pointer sur une copie de test :

  ADBI_CVPARSER_DATA_DIR   (defaut : <racine cv-parser>/data)
  ADBI_CVPARSER_CV_DB      (defaut : <racine cv-parser>/cv_database.json)

Usage :
  DATABASE_URL=postgresql://... python scripts/migrer_vers_postgres.py
  DATABASE_URL=postgresql://... ADBI_CVPARSER_DATA_DIR=/tmp/data \
    ADBI_CVPARSER_CV_DB=/tmp/cv_database.json python scripts/migrer_vers_postgres.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

CV_PARSER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CV_PARSER_ROOT))

from psycopg.types.json import Jsonb as _Jsonb  # noqa: E402
import core.pg as pg  # noqa: E402 — n'importe pas config.py, voir core/pg.py

DATA_DIR = Path(os.environ.get("ADBI_CVPARSER_DATA_DIR") or (CV_PARSER_ROOT / "data"))
CV_DB_FILE = Path(os.environ.get("ADBI_CVPARSER_CV_DB") or (CV_PARSER_ROOT / "cv_database.json"))
SQLITE_FILE = DATA_DIR / "adbi.db"
USERS_FILE = DATA_DIR / "users.json"
TOKENS_FILE = DATA_DIR / "tokens.json"
INVITES_FILE = DATA_DIR / "invites.json"
ACTIVITY_FILE = DATA_DIR / "activity.json"

# Espace de noms fixe pour dériver un id stable et rejouable des entrées
# d'activity.json, qui n'ont pas d'id naturel côté JSON (append-only).
_ACTIVITY_NS = uuid.UUID("6f2f6a0e-6c1f-4a63-9d2b-9a8e6a2b7c11")


def _log(msg: str) -> None:
    print(f"[migration] {msg}")


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        content = path.read_text(encoding="utf-8").strip()
        return json.loads(content) if content else default
    except Exception as e:
        _log(f"AVERTISSEMENT : {path} illisible ({e}) — traité comme vide.")
        return default


def _uj(v):
    """Décodage JSON tolérant, comme core/database.py::_uj — les colonnes
    SQLite required_skills/bonus_skills/... sont du TEXT JSON sérialisé."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return []
    return v or []


def _parse_iso(v: str | None, *, assume_naive_utc: bool = False) -> datetime | None:
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None and assume_naive_utc:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ══════════════════════════════════════════════════════════════════════════════
# NEEDS + MATCHING_RESULTS (SQLite -> Postgres)
# ══════════════════════════════════════════════════════════════════════════════

def migrate_needs_and_matches(pg) -> tuple[int, int, int]:
    if not SQLITE_FILE.exists():
        _log(f"{SQLITE_FILE} absent — needs/matching_results non migrés (rien à faire).")
        return 0, 0, 0

    con = sqlite3.connect(str(SQLITE_FILE))
    con.row_factory = sqlite3.Row

    needs_migrated = 0
    migrated_ids: set[str] = set()
    for row in con.execute("SELECT * FROM needs"):
        d = dict(row)
        created_at = _parse_iso(d.get("created_at"), assume_naive_utc=True) or datetime.now(timezone.utc)
        updated_at = _parse_iso(d.get("updated_at"), assume_naive_utc=True) or created_at
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO needs
                  (id, title, context, required_skills, bonus_skills, seniority, min_years,
                   languages, location, remote, start_date, contract_type, budget,
                   client, sector, notes, raw_text, status, prix_achat, prix_vente,
                   created_by, created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                  title=EXCLUDED.title, context=EXCLUDED.context,
                  required_skills=EXCLUDED.required_skills, bonus_skills=EXCLUDED.bonus_skills,
                  seniority=EXCLUDED.seniority, min_years=EXCLUDED.min_years,
                  languages=EXCLUDED.languages, location=EXCLUDED.location,
                  remote=EXCLUDED.remote, start_date=EXCLUDED.start_date,
                  contract_type=EXCLUDED.contract_type, budget=EXCLUDED.budget,
                  client=EXCLUDED.client, sector=EXCLUDED.sector, notes=EXCLUDED.notes,
                  raw_text=EXCLUDED.raw_text, status=EXCLUDED.status,
                  prix_achat=EXCLUDED.prix_achat, prix_vente=EXCLUDED.prix_vente,
                  updated_at=EXCLUDED.updated_at
                """,
                (
                    d["id"], d.get("title", ""), d.get("context", ""),
                    _Jsonb(_uj(d.get("required_skills"))), _Jsonb(_uj(d.get("bonus_skills"))),
                    d.get("seniority", ""), int(d.get("min_years") or 0),
                    _Jsonb(_uj(d.get("languages"))), d.get("location", ""),
                    d.get("remote", "flexible"), d.get("start_date", ""),
                    d.get("contract_type", "Tous"), d.get("budget", ""),
                    d.get("client", ""), d.get("sector", ""), d.get("notes", ""),
                    d.get("raw_text", ""), d.get("status", "active"),
                    float(d.get("prix_achat") or 0), float(d.get("prix_vente") or 0),
                    d["created_by"], created_at, updated_at,
                ),
            )
        migrated_ids.add(d["id"])
        needs_migrated += 1

    matches_migrated = 0
    matches_skipped = 0
    for row in con.execute("SELECT * FROM matching_results"):
        d = dict(row)
        if d["need_id"] not in migrated_ids:
            matches_skipped += 1
            continue
        computed_at = _parse_iso(d.get("computed_at"), assume_naive_utc=True) or datetime.now(timezone.utc)
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO matching_results
                  (id, need_id, candidate_id, score_total, score_skills, score_title,
                   score_seniority, score_availability, score_missions, score_bonus,
                   strengths, weaknesses, reservations, missing_skills,
                   explanation, rank, computed_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                  score_total=EXCLUDED.score_total, score_skills=EXCLUDED.score_skills,
                  score_title=EXCLUDED.score_title, score_seniority=EXCLUDED.score_seniority,
                  score_availability=EXCLUDED.score_availability, score_missions=EXCLUDED.score_missions,
                  score_bonus=EXCLUDED.score_bonus, strengths=EXCLUDED.strengths,
                  weaknesses=EXCLUDED.weaknesses, reservations=EXCLUDED.reservations,
                  missing_skills=EXCLUDED.missing_skills, explanation=EXCLUDED.explanation,
                  rank=EXCLUDED.rank, computed_at=EXCLUDED.computed_at
                """,
                (
                    d["id"], d["need_id"], d["candidate_id"],
                    d.get("score_total", 0), d.get("score_skills", 0), d.get("score_title", 0),
                    d.get("score_seniority", 0), d.get("score_availability", 0),
                    d.get("score_missions", 0), d.get("score_bonus", 0),
                    _Jsonb(_uj(d.get("strengths"))), _Jsonb(_uj(d.get("weaknesses"))),
                    _Jsonb(_uj(d.get("reservations"))), _Jsonb(_uj(d.get("missing_skills"))),
                    d.get("explanation", ""), d.get("rank", 0), computed_at,
                ),
            )
        matches_migrated += 1

    con.close()
    if matches_skipped:
        _log(
            f"AVERTISSEMENT : {matches_skipped} matching_results orphelins "
            "(need_id absent de needs) ignorés — PRAGMA foreign_keys n'était "
            "actif que sur la connexion d'init côté SQLite, ces lignes "
            "existent en pratique."
        )
    return needs_migrated, matches_migrated, matches_skipped


# ══════════════════════════════════════════════════════════════════════════════
# UTILISATEURS + TOKENS + INVITES (JSON -> Postgres)
# ══════════════════════════════════════════════════════════════════════════════

def migrate_auth(pg) -> tuple[int, int, int]:
    users = _load_json(USERS_FILE, {})
    tokens = _load_json(TOKENS_FILE, {})
    invites = _load_json(INVITES_FILE, [])

    n_users = 0
    known_user_ids: set[str] = set()
    for u in users.values():
        created_at = _parse_iso(u.get("created_at"), assume_naive_utc=True) or datetime.now(timezone.utc)
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO users (id, email, password_hash, role, full_name, is_active, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                  email=EXCLUDED.email, password_hash=EXCLUDED.password_hash,
                  role=EXCLUDED.role, full_name=EXCLUDED.full_name,
                  is_active=EXCLUDED.is_active
                """,
                (
                    u["id"], u["email"], u["password_hash"], u.get("role", "user"),
                    u.get("full_name", ""), bool(u.get("is_active", True)), created_at,
                ),
            )
        known_user_ids.add(u["id"])
        n_users += 1

    n_tokens = 0
    orphan_tokens = 0
    for t in tokens.values():
        expires_at = _parse_iso(t.get("expires_at"), assume_naive_utc=True) or datetime.now(timezone.utc)
        created_at = _parse_iso(t.get("created_at"), assume_naive_utc=True) or datetime.now(timezone.utc)
        if t.get("user_id") not in known_user_ids:
            orphan_tokens += 1  # migré quand même : pas de FK sur refresh_tokens.user_id (voir schema.sql)
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO refresh_tokens (jti, user_id, expires_at, created_at, revoked)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (jti) DO UPDATE SET
                  user_id=EXCLUDED.user_id, expires_at=EXCLUDED.expires_at,
                  revoked=EXCLUDED.revoked
                """,
                (t["jti"], t["user_id"], expires_at, created_at, bool(t.get("revoked", False))),
            )
        n_tokens += 1
    if orphan_tokens:
        _log(f"INFO : {orphan_tokens} refresh_tokens sans utilisateur correspondant, migrés quand même.")

    n_invites = 0
    for inv in invites:
        expires_at = _parse_iso(inv.get("expires_at"), assume_naive_utc=True) or datetime.now(timezone.utc)
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO invites (token, email, role, created_by, expires_at, used)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (token) DO UPDATE SET
                  email=EXCLUDED.email, role=EXCLUDED.role, created_by=EXCLUDED.created_by,
                  expires_at=EXCLUDED.expires_at, used=EXCLUDED.used
                """,
                (
                    inv["token"], inv["email"], inv.get("role", "user"),
                    inv.get("created_by", ""), expires_at, bool(inv.get("used", False)),
                ),
            )
        n_invites += 1

    return n_users, n_tokens, n_invites


# ══════════════════════════════════════════════════════════════════════════════
# ACTIVITY (data/activity.json -> Postgres)
# ══════════════════════════════════════════════════════════════════════════════

def _activity_id(entry: dict) -> str:
    """id stable et rejouable : les entrées de activity.json n'ont pas d'id
    (tableau append-only). uuid5 sur une représentation canonique -> même id
    à chaque exécution du script pour la même entrée -> ON CONFLICT DO
    NOTHING la rend idempotente (pas de doublon si on relance la migration)."""
    canon = json.dumps(entry, sort_keys=True, ensure_ascii=True)
    return str(uuid.uuid5(_ACTIVITY_NS, canon))


def migrate_activity(pg) -> int:
    events = _load_json(ACTIVITY_FILE, [])
    n = 0
    for e in events:
        # activity.py écrit ts = datetime.utcnow().isoformat() : naïf, déjà en UTC.
        ts = _parse_iso(e.get("ts"), assume_naive_utc=True) or datetime.now(timezone.utc)
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO activity (id, event_type, user_id, user_email, detail, ts)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO NOTHING
                """,
                (
                    _activity_id(e), e.get("type", ""), e.get("user_id", ""),
                    e.get("user_email", ""), _Jsonb(e.get("detail") or {}), ts,
                ),
            )
        n += 1
    return n


# ══════════════════════════════════════════════════════════════════════════════
# CV_DATABASE.JSON -> Postgres
# ══════════════════════════════════════════════════════════════════════════════

def migrate_cvs(pg) -> int:
    db = _load_json(CV_DB_FILE, {})
    n = 0
    for cv_id, record in db.items():
        name = str(record.get("name") or "")
        email = str((record.get("contact") or {}).get("email") or "")
        with pg.get_conn() as pcon:
            pcon.execute(
                """
                INSERT INTO cvs (id, name, email, data, cree_le, maj_le)
                VALUES (%s,%s,%s,%s, now(), now())
                ON CONFLICT (id) DO UPDATE SET
                  name=EXCLUDED.name, email=EXCLUDED.email, data=EXCLUDED.data,
                  maj_le=now()
                """,
                (cv_id, name, email, _Jsonb(record)),
            )
        n += 1
    return n


def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        _log("DATABASE_URL manquante — voir cv-parser/.env.example / docker-compose.yml.")
        return 1

    pg.init_schema()
    _log("schema.sql applique.")

    needs_n, matches_n, matches_skipped = migrate_needs_and_matches(pg)
    _log(f"needs : {needs_n} migres.")
    _log(f"matching_results : {matches_n} migres ({matches_skipped} orphelins ignores).")

    users_n, tokens_n, invites_n = migrate_auth(pg)
    _log(f"users : {users_n} migres.")
    _log(f"refresh_tokens : {tokens_n} migres.")
    _log(f"invites : {invites_n} migrees.")

    activity_n = migrate_activity(pg)
    _log(f"activity : {activity_n} evenements migres.")

    cvs_n = migrate_cvs(pg)
    _log(f"cvs : {cvs_n} fiches migrees.")

    # Vérification de comptage — même esprit que migrer-vers-postgres.js
    # (one-pager) : on compare la source à ce qui se trouve réellement en
    # base après migration, avant de déclarer un succès.
    with pg.get_conn() as con:
        counts = {
            "needs": con.execute("SELECT COUNT(*) AS n FROM needs").fetchone()["n"],
            "matching_results": con.execute("SELECT COUNT(*) AS n FROM matching_results").fetchone()["n"],
            "users": con.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"],
            "refresh_tokens": con.execute("SELECT COUNT(*) AS n FROM refresh_tokens").fetchone()["n"],
            "invites": con.execute("SELECT COUNT(*) AS n FROM invites").fetchone()["n"],
            "activity": con.execute("SELECT COUNT(*) AS n FROM activity").fetchone()["n"],
            "cvs": con.execute("SELECT COUNT(*) AS n FROM cvs").fetchone()["n"],
        }

    ok = (
        counts["needs"] == needs_n
        and counts["matching_results"] >= matches_n  # peut inclure des lignes d'un run precedent
        and counts["users"] == users_n
        and counts["invites"] == invites_n
        and counts["cvs"] == cvs_n
    )
    _log(f"comptage en base : {counts}")
    if not ok:
        _log("ECART detecte entre source et base — verifier avant de considerer la migration terminee.")
        return 1

    _log("OK — migration terminee, comptages coherents avec la source.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
