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

-- search() (lib/db.pg.js) fait un LIKE '%...%' sur LOWER(master::text) pour
-- une recherche plein texte libre sur tout le cv_master (nom, techno,
-- client — voir placeholder du champ de recherche cote client). Un motif
-- qui commence par '%' ne peut pas utiliser un index B-tree classique ; sans
-- rien ici, cette requete fait un scan sequentiel qui caste le JSONB entier
-- de CHAQUE fiche en texte, a chaque appel (voir issue #106 pour les
-- mesures : ~2-3 s sur 2000 fiches, quel que soit le terme). pg_trgm est une
-- extension contrib standard, deja presente dans l'image postgres:17-alpine
-- utilisee par ce projet, et "trusted" depuis PG13 (pas besoin de superuser,
-- le proprietaire de la base suffit). L'expression indexee doit rester
-- IDENTIQUE a celle du WHERE de search() (LOWER(master::text)) pour que le
-- planificateur puisse s'en servir.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_cvs_master_trgm ON cvs USING gin (LOWER(master::text) gin_trgm_ops);
