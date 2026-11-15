-- Schéma de sourcing, appliqué au démarrage (idempotent) ; tables et index préfixés src_ dans la base par défaut.

CREATE TABLE IF NOT EXISTS src_elements (
  id              SERIAL PRIMARY KEY,
  proprietaire    TEXT NOT NULL,
  texte           TEXT NOT NULL,
  empreinte       TEXT NOT NULL,
  url_source      TEXT NOT NULL DEFAULT '',
  origine         TEXT NOT NULL DEFAULT 'api',
  capture_le      TIMESTAMPTZ,
  auteur          TEXT NOT NULL DEFAULT '',
  statut          TEXT NOT NULL DEFAULT 'en_attente',
  type            TEXT,
  classement      JSONB,
  extraction      JSONB,
  champs          JSONB,
  preuves         JSONB NOT NULL DEFAULT '{}'::jsonb,
  confiances      JSONB NOT NULL DEFAULT '{}'::jsonb,
  rapprochement   JSONB,
  erreur          JSONB,
  tache           TEXT,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS src_idx_elements_proprietaire ON src_elements (proprietaire, cree_le DESC);
CREATE UNIQUE INDEX IF NOT EXISTS src_idx_elements_doublon ON src_elements (proprietaire, empreinte);
