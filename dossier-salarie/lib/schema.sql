-- Schéma du dossier salarié (appliqué par lib/db.pg.js), tables préfixées dsal_ car la base est partagée.

CREATE TABLE IF NOT EXISTS dsal_dossiers (
  id             SERIAL PRIMARY KEY,
  nom            TEXT NOT NULL,
  prenoms        TEXT NOT NULL DEFAULT '',
  date_embauche  DATE,
  type_contrat   TEXT NOT NULL DEFAULT '',
  attendus       JSONB NOT NULL DEFAULT '[]'::jsonb,
  fiche          JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_par_sub   TEXT NOT NULL,
  cree_par_email TEXT NOT NULL DEFAULT '',
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsal_pieces (
  id              SERIAL PRIMARY KEY,
  dossier_id      INTEGER NOT NULL REFERENCES dsal_dossiers (id) ON DELETE CASCADE,
  fichier         TEXT NOT NULL,
  nom_origine     TEXT NOT NULL DEFAULT '',
  mime            TEXT NOT NULL,
  taille          INTEGER NOT NULL,
  type_piece      TEXT,
  classement      TEXT NOT NULL DEFAULT '',
  statut          TEXT NOT NULL DEFAULT 'en_attente',
  tache           TEXT,
  voie            TEXT NOT NULL DEFAULT '',
  valeurs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  constats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  erreur          JSONB,
  depose_par_sub  TEXT NOT NULL,
  depose_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  extrait_le      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dsal_pieces_dossier ON dsal_pieces (dossier_id);
