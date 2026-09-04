-- Schema PostgreSQL de one-pager. Applique automatiquement par lib/db.pg.js
-- (CREATE TABLE IF NOT EXISTS) au démarrage — pas de runner de migration
-- séparé pour un schéma aussi simple (une seule table).
--
-- master/options restent en JSONB tels quels (voir docs/postgres-inventory.md) :
-- pas de structure stable documentée pour experiences/identity, normaliser
-- maintenant inventerait un schéma non vérifié.

CREATE TABLE IF NOT EXISTS cvs (
  id       TEXT PRIMARY KEY,
  nom      TEXT,
  titre    TEXT,
  fichier  TEXT,
  hash     TEXT,
  master   JSONB NOT NULL,
  options  JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le  TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cvs_hash ON cvs (hash);
