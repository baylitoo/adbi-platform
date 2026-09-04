"""core/activity_pg.py — PostgreSQL pour le journal d'activité.

Même API que core/activity.py (data/activity.json), SANS le plafond
MAX_EVENTS = 2000 : c'était un contournement du stockage fichier (éviter un
tableau JSON qui grossit indéfiniment). Une vraie table n'a pas ce problème
— "activité récente" redevient un simple ORDER BY ts DESC LIMIT au moment de
la lecture (get_events), pas une troncature à l'écriture (log_event).

N'importe PAS config.py (effets de bord au chargement) : voir core/pg.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from psycopg.types.json import Jsonb

from core.pg import get_conn, init_schema

__all__ = ["init_db", "log_event", "get_events", "get_user_stats"]


def init_db() -> None:
    init_schema()
    print("[DB] Schema PostgreSQL initialise (activity).")


def _iso(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def log_event(event_type: str, user_id: str, user_email: str, detail: dict | None = None) -> None:
    with get_conn() as con:
        con.execute(
            """
            INSERT INTO activity (id, event_type, user_id, user_email, detail, ts)
            VALUES (%s,%s,%s,%s,%s,%s)
            """,
            (
                str(uuid.uuid4()),
                event_type,
                user_id,
                user_email or "",
                Jsonb(detail or {}),
                datetime.now(timezone.utc),
            ),
        )


def get_events(limit: int = 200, user_id: str | None = None) -> list[dict]:
    sql = "SELECT * FROM activity"
    params: list = []
    if user_id:
        sql += " WHERE user_id = %s"
        params.append(user_id)
    sql += " ORDER BY ts DESC LIMIT %s"
    params.append(limit)
    with get_conn() as con:
        rows = con.execute(sql, params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["type"] = d.pop("event_type")
        d["ts"] = _iso(d.get("ts"))
        out.append(d)
    return out


def get_user_stats() -> list[dict]:
    """Agrège logins / cv_uploads / matches / last_seen par utilisateur.

    Même sortie que core/activity.py::get_user_stats (une entrée par
    user_id), mais calculée en SQL plutôt qu'en itérant tout le journal en
    mémoire — plus la peine avec une vraie table indexée.
    """
    sql = """
        SELECT
          user_id,
          MAX(user_email)                                   AS email,
          COUNT(*) FILTER (WHERE event_type = 'login')       AS logins,
          COUNT(*) FILTER (WHERE event_type = 'cv_upload')   AS cv_uploads,
          COUNT(*) FILTER (WHERE event_type = 'match_run')   AS matches,
          MAX(ts)                                            AS last_seen
        FROM activity
        GROUP BY user_id
    """
    with get_conn() as con:
        rows = con.execute(sql).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["last_seen"] = _iso(d.get("last_seen")) or None
        out.append(d)
    return out
