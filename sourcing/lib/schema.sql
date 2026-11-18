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

ALTER TABLE src_elements ADD COLUMN IF NOT EXISTS source_meta JSONB;

-- Référentiel de profils par utilisateur, rapproché des offres ; cvtheque_id prépare le lien avec la CVthèque.
CREATE TABLE IF NOT EXISTS src_profils (
  id              SERIAL PRIMARY KEY,
  proprietaire    TEXT NOT NULL,
  nom             TEXT NOT NULL,
  intitule        TEXT NOT NULL DEFAULT '',
  competences     JSONB NOT NULL DEFAULT '[]'::jsonb,
  seniorite       TEXT NOT NULL DEFAULT '',
  localisation    TEXT NOT NULL DEFAULT '',
  disponibilite   TEXT NOT NULL DEFAULT '',
  tjm             INTEGER,
  notes           TEXT NOT NULL DEFAULT '',
  cvtheque_id     TEXT NOT NULL DEFAULT '',
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS src_idx_profils_proprietaire ON src_profils (proprietaire, nom);

CREATE TABLE IF NOT EXISTS src_affectations (
  proprietaire    TEXT NOT NULL,
  element_id      INTEGER NOT NULL REFERENCES src_elements(id) ON DELETE CASCADE,
  profil_id       INTEGER NOT NULL REFERENCES src_profils(id) ON DELETE CASCADE,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (element_id, profil_id)
);
