"""core/pg.py — Connexion PostgreSQL partagée pour les modules *_pg.py.

Ce module (et tout ce qui en dépend : core/database_pg.py, core/auth_pg.py,
core/activity_pg.py, core/cvstore_pg.py) fait délibérément PAS `import
config` : config.py a des effets de bord au chargement (création de
data/jwt_secret.txt, rangement des fichiers llm_*.txt...) qui n'ont rien à
voir avec Postgres et qu'on ne veut pas déclencher juste en import.
DATABASE_URL est lue directement depuis l'environnement, comme dans
one-pager/lib/db.pg.js.

Rien ici n'est appelé par app.py / les blueprints tant que la bascule
(PR B, issue #15) n'a pas eu lieu — seuls scripts/migrer_vers_postgres.py et
les tests de ce module l'utilisent.
"""
from __future__ import annotations

import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL manquante — requise pour les modules core/*_pg.py "
            "(voir docker-compose.yml / .env.example)."
        )
    return url


def get_conn() -> psycopg.Connection:
    """Nouvelle connexion, lignes en dict (comme sqlite3.Row côté core/database.py).

    Une connexion par appel plutôt qu'un pool : cv-parser est un WSGI sync à
    faible volume (comme core/database.py avec sqlite3.connect par requête),
    et ça garde ce module aussi simple à lire que db.pg.js. À revoir si PR B
    montre un besoin de pool.
    """
    return psycopg.connect(database_url(), row_factory=dict_row)


def init_schema() -> None:
    """Applique core/schema.sql (CREATE TABLE IF NOT EXISTS — idempotent)."""
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with get_conn() as con:
        con.execute(schema)
