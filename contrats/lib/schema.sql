-- Schema PostgreSQL de contrats. Applique automatiquement par lib/db.pg.js
-- (CREATE TABLE IF NOT EXISTS) au demarrage.
--
-- Trois tables reprises telles quelles de sql.js (contrats, signatures,
-- corbeille) + une nouvelle (templates_perso) pour data/templates-perso.json,
-- qui est un etat mutable propre a l'instance (contrairement a
-- data/referentiels.json, intentionnellement suivi par git comme donnee de
-- reference partagee — voir issue #14 : ce fichier NE migre PAS ici).
--
-- payload/donnees restent en JSONB tels quels (voir issue #14 : pas de
-- structure stable documentee pour values/options/signataires/journal) :
-- normaliser maintenant inventerait un schema non verifie. Le script de
-- migration (scripts/migrer-vers-postgres.js) corrige au passage le
-- double-encodage historique de signatures.donnees.payload (JSON.stringify
-- applique deux fois par lib/signatures.js) : en JSONB, payload est un objet,
-- pas une chaine contenant du JSON.

CREATE TABLE IF NOT EXISTS contrats (
  id            SERIAL PRIMARY KEY,
  numero        TEXT,
  type          TEXT,
  sous_traitant TEXT,
  client_final  TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  statut        TEXT NOT NULL DEFAULT '',
  signe         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_contrats_numero ON contrats (numero);
CREATE INDEX IF NOT EXISTS idx_contrats_sous_traitant ON contrats (sous_traitant);

-- Demandes de signature : tout l'objet vit en JSONB (memes volumes minuscules,
-- filtrage en JS cote serveur qu'avant — voir lib/signatures.js).
CREATE TABLE IF NOT EXISTS signatures (
  id      SERIAL PRIMARY KEY,
  donnees JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- CORBEILLE : toute suppression (contrat, demande de signature) passe ici et
-- reste restaurable depuis Parametres — meme forme qu'en sql.js, juste en
-- Postgres. `type` distingue "contrat" / "signature" ; `donnees` porte la
-- ligne supprimee complete, re-inserable telle quelle dans sa table d'origine.
CREATE TABLE IF NOT EXISTS corbeille (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  donnees      JSONB NOT NULL DEFAULT '{}'::jsonb,
  supprime_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Personnalisation des modeles de contrat (ecran Parametres -> "Modeles de
-- contrat") : etat mutable propre a l'instance (gitignore aujourd'hui, voir
-- data/templates-perso.json) — candidat legitime a la migration, contrairement
-- a referentiels.json. Une ligne par type de contrat retouche.
CREATE TABLE IF NOT EXISTS templates_perso (
  type    TEXT PRIMARY KEY,
  donnees JSONB NOT NULL DEFAULT '{}'::jsonb
);
