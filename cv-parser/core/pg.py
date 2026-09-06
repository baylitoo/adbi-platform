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


# Timeout court (connexion ET requête) — utilisé par /api/sante, interrogée
# par le HEALTHCHECK Docker toutes les 30s (voir Dockerfile) : ne doit jamais
# pendre au-delà du --timeout du HEALTHCHECK si Postgres est joignable au TCP
# mais ne répond jamais (ex. conteneur en pause).
PING_TIMEOUT_S = 3


def ping() -> None:
    """Vérifie que PostgreSQL répond réellement — pas seulement que le
    process gunicorn est vivant.

    Connexion dédiée et de courte durée (pas de pool ici, voir get_conn) :
    connect_timeout de libpq borne l'établissement TCP et l'authentification,
    mais pas une requête envoyée sur une connexion déjà établie (cas d'un
    conteneur Postgres "gelé" — ex. `docker pause` — qui accepte le TCP sans
    jamais répondre au protocole) : statement_timeout côté session borne donc
    aussi le SELECT 1 lui-même. Une base en pause ou injoignable échoue ainsi
    proprement au bout de PING_TIMEOUT_S plutôt que de pendre indéfiniment.
    Lève une exception si la base ne répond pas ; ne retourne rien sinon.
    """
    with psycopg.connect(
        database_url(),
        connect_timeout=PING_TIMEOUT_S,
        options=f"-c statement_timeout={PING_TIMEOUT_S * 1000}",
        row_factory=dict_row,
    ) as con:
        con.execute("SELECT 1")
