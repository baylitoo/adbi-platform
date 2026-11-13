-- Schéma PostgreSQL de notes-frais, appliqué au démarrage par lib/db.pg.js (idempotent).
-- Tables préfixées ndf_ : elles vivent dans la base par défaut de l'instance partagée.

CREATE TABLE IF NOT EXISTS ndf_notes (
  id              SERIAL PRIMARY KEY,
  user_sub        TEXT NOT NULL,
  user_email      TEXT NOT NULL DEFAULT '',
  user_nom        TEXT NOT NULL DEFAULT '',
  fichier_nom     TEXT NOT NULL DEFAULT '',
  fichier_chemin  TEXT NOT NULL DEFAULT '',
  fichier_mime    TEXT NOT NULL DEFAULT '',
  fichier_taille  INTEGER NOT NULL DEFAULT 0,
  statut          TEXT NOT NULL DEFAULT 'extraction',
  tache           TEXT,
  erreur          JSONB,
  voie            TEXT NOT NULL DEFAULT '',
  modele          TEXT NOT NULL DEFAULT '',
  date_depense    DATE,
  commercant      TEXT NOT NULL DEFAULT '',
  total_ht        NUMERIC(12, 2),
  tva             JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_ttc       NUMERIC(12, 2),
  devise          TEXT NOT NULL DEFAULT 'EUR',
  moyen_paiement  TEXT NOT NULL DEFAULT '',
  categorie       TEXT NOT NULL DEFAULT 'autre',
  extraction      JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valide_le       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ndf_notes_user ON ndf_notes (user_sub);
CREATE INDEX IF NOT EXISTS idx_ndf_notes_date ON ndf_notes (date_depense);
