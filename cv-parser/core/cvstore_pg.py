"""core/cvstore_pg.py — PostgreSQL pour la CVthèque (cv_database.json).

Même API que les fonctions load_db/save_db d'app.py (dict {id: fiche}, sans
schéma fixe : name, title, contact{...}, experience[], education[], skills[],
bilan_adbi, ...). load_db()/save_db(dict) sont fournies telles quelles pour
que la bascule (PR B) puisse remplacer les deux fonctions d'app.py par un
import quasi direct, sans changer les nombreux appels `db = load_db(); ...;
save_db(db)` disséminés dans app.py.

save_db(dict) reproduit la sémantique "remplacement complet" du fichier JSON
: app.py fait `db.pop(cv_id, None); save_db(db)` pour supprimer une fiche, ce
qui suppose que save_db() synchronise exactement la table sur le dict fourni
(upsert de ce qui est présent, suppression de ce qui ne l'est plus) — pas
seulement un upsert partiel.

Des fonctions plus ciblées (get_cv/save_cv/delete_cv) sont aussi fournies
pour un usage ligne-à-ligne plus proche d'une vraie base.

N'importe PAS config.py (effets de bord au chargement) : voir core/pg.py.
"""
from __future__ import annotations

from datetime import datetime, timezone

from psycopg.types.json import Jsonb

from core.pg import get_conn, init_schema

__all__ = [
    "init_db", "load_db", "save_db",
    "get_cv", "list_cvs", "save_cv", "delete_cv",
]


def init_db() -> None:
    init_schema()
    print("[DB] Schema PostgreSQL initialise (cvs).")


def _record(row: dict) -> dict:
    """Reconstruit la fiche telle que cv_database.json la stockait : le
    JSONB `data` EST l'enregistrement (name, contact, experience...) ; id
    est garanti présent (comme la clé du dict côté JSON)."""
    data = dict(row["data"])
    data["id"] = row["id"]
    return data


def get_cv(cv_id: str) -> dict | None:
    with get_conn() as con:
        row = con.execute("SELECT * FROM cvs WHERE id = %s", (cv_id,)).fetchone()
    return _record(row) if row else None


def list_cvs() -> dict:
    """Équivalent de load_db() : {id: fiche} pour toute la CVthèque."""
    with get_conn() as con:
        rows = con.execute("SELECT * FROM cvs").fetchall()
    return {r["id"]: _record(r) for r in rows}


# Alias explicite pour coller au nom utilisé dans app.py (facilite la bascule).
def load_db() -> dict:
    return list_cvs()


def save_cv(cv_id: str, record: dict) -> None:
    name = str(record.get("name") or "")
    email = str((record.get("contact") or {}).get("email") or "")
    now = datetime.now(timezone.utc)
    with get_conn() as con:
        con.execute(
            """
            INSERT INTO cvs (id, name, email, data, cree_le, maj_le)
            VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name, email = EXCLUDED.email,
              data = EXCLUDED.data, maj_le = EXCLUDED.maj_le
            """,
            (cv_id, name, email, Jsonb(record), now, now),
        )


def delete_cv(cv_id: str) -> bool:
    with get_conn() as con:
        cur = con.execute("DELETE FROM cvs WHERE id = %s", (cv_id,))
        return cur.rowcount > 0


def save_db(db: dict) -> None:
    """Équivalent de save_db(dict) : synchronise la table EXACTEMENT sur le
    dict fourni (upsert des clés présentes, suppression des lignes absentes)
    — c'est ce que fait implicitement l'écriture complète de cv_database.json
    (voir app.py, ex. db.pop(cv_id, None) puis save_db(db))."""
    ids = list(db.keys())
    now = datetime.now(timezone.utc)
    with get_conn() as con:
        if ids:
            con.execute("DELETE FROM cvs WHERE id != ALL(%s)", (ids,))
        else:
            con.execute("DELETE FROM cvs")
        for cv_id, record in db.items():
            name = str(record.get("name") or "")
            email = str((record.get("contact") or {}).get("email") or "")
            con.execute(
                """
                INSERT INTO cvs (id, name, email, data, cree_le, maj_le)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                  name = EXCLUDED.name, email = EXCLUDED.email,
                  data = EXCLUDED.data, maj_le = EXCLUDED.maj_le
                """,
                (cv_id, name, email, Jsonb(record), now, now),
            )
