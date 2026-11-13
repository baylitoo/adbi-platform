-- Schéma de factures, appliqué au démarrage (idempotent) ; préfixe fac_ car la base est partagée.

CREATE TABLE IF NOT EXISTS fac_factures (
  id                SERIAL PRIMARY KEY,
  statut            TEXT NOT NULL DEFAULT 'a_valider' CHECK (statut IN ('a_valider', 'validee', 'payee')),
  fichier_nom       TEXT NOT NULL DEFAULT '',
  fichier_chemin    TEXT NOT NULL DEFAULT '',
  fichier_mime      TEXT NOT NULL DEFAULT '',
  fichier_taille    INTEGER NOT NULL DEFAULT 0,
  empreinte         TEXT NOT NULL DEFAULT '',
  extraction_etat   TEXT NOT NULL DEFAULT 'en_cours' CHECK (extraction_etat IN ('en_cours', 'terminee', 'echec')),
  extraction_erreur TEXT NOT NULL DEFAULT '',
  extraction        JSONB NOT NULL DEFAULT '{}'::jsonb,
  donnees           JSONB NOT NULL DEFAULT '{}'::jsonb,
  siren             TEXT NOT NULL DEFAULT '',
  numero            TEXT NOT NULL DEFAULT '',
  fournisseur       TEXT NOT NULL DEFAULT '',
  iban              TEXT NOT NULL DEFAULT '',
  date_facture      DATE,
  date_echeance     DATE,
  total_ttc         NUMERIC(14, 2),
  verif_societe     JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fac_factures_siren_numero ON fac_factures (siren, numero);
CREATE INDEX IF NOT EXISTS idx_fac_factures_statut_echeance ON fac_factures (statut, date_echeance);
CREATE INDEX IF NOT EXISTS idx_fac_factures_empreinte ON fac_factures (empreinte);

-- Journal d'audit : tout changement porte l'utilisateur du jeton adbi_access vérifié.
CREATE TABLE IF NOT EXISTS fac_evenements (
  id          SERIAL PRIMARY KEY,
  facture_id  INTEGER NOT NULL REFERENCES fac_factures (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  de          TEXT NOT NULL DEFAULT '',
  vers        TEXT NOT NULL DEFAULT '',
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sub         TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  le          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fac_evenements_facture ON fac_evenements (facture_id, le);
CREATE INDEX IF NOT EXISTS idx_fac_evenements_type ON fac_evenements (type, vers);
