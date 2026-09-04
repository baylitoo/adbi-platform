-- Schéma PostgreSQL de cv-parser (issue #15, PR A).
--
-- Appliqué automatiquement par core/pg.py (CREATE TABLE IF NOT EXISTS,
-- comme one-pager/lib/schema.sql) — pas de runner de migration séparé pour
-- un schéma qui reste simple.
--
-- Une table par domaine de données existant (voir core/database.py,
-- core/auth.py, core/activity.py, app.py::load_db/save_db) :
--   cvs               <- cv_database.json          (CVthèque, libre)
--   needs             <- SQLite table needs
--   matching_results  <- SQLite table matching_results
--   users             <- data/users.json
--   refresh_tokens    <- data/tokens.json
--   invites           <- data/invites.json
--   activity          <- data/activity.json (plus de plafond 2000, voir
--                        core/activity_pg.py — ORDER BY ... LIMIT au lieu
--                        d'une troncature à l'écriture)
--
-- JSONB pour tout ce qui est libre/non normalisé (contenu de CV, tableaux
-- de compétences/langues des besoins, détail d'activité) : aucune forme
-- stable et vérifiée n'existe pour experience/education/bilan_adbi —
-- normaliser aujourd'hui inventerait une structure que personne n'a
-- confirmée. Colonnes typées seulement pour les champs réellement
-- scalaires (id, email, timestamps, statuts).

-- ── CVthèque ─────────────────────────────────────────────────────────────────
-- cv_database.json est un dict {id: enregistrement} sans schéma fixe
-- (name, title, contact{...}, experience[], education[], skills[], ...,
-- plus des champs ajoutés au fil du temps : bilan_adbi, llm_parsed, etc.).
-- name/email sont dupliqués en colonnes à plat uniquement pour permettre un
-- index/tri simple ; la donnée de référence reste `data` (JSONB).
CREATE TABLE IF NOT EXISTS cvs (
    id        TEXT PRIMARY KEY,
    name      TEXT DEFAULT '',
    email     TEXT DEFAULT '',
    data      JSONB NOT NULL,
    cree_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
    maj_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cvs_email ON cvs (email);
CREATE INDEX IF NOT EXISTS idx_cvs_name  ON cvs (LOWER(name));

-- ── Besoins clients ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS needs (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    context           TEXT DEFAULT '',
    required_skills   JSONB NOT NULL DEFAULT '[]'::jsonb,
    bonus_skills      JSONB NOT NULL DEFAULT '[]'::jsonb,
    seniority         TEXT DEFAULT '',
    min_years         INTEGER DEFAULT 0,
    languages         JSONB NOT NULL DEFAULT '[]'::jsonb,
    location          TEXT DEFAULT '',
    remote            TEXT DEFAULT 'flexible',
    start_date        TEXT DEFAULT '',
    contract_type     TEXT DEFAULT 'Tous',
    budget            TEXT DEFAULT '',
    client            TEXT DEFAULT '',
    sector            TEXT DEFAULT '',
    notes             TEXT DEFAULT '',
    raw_text          TEXT DEFAULT '',
    status            TEXT DEFAULT 'active',
    prix_achat        REAL DEFAULT 0,
    prix_vente        REAL DEFAULT 0,
    created_by        TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_needs_status     ON needs (status);
CREATE INDEX IF NOT EXISTS idx_needs_created_by ON needs (created_by);

-- ── Résultats de matching ────────────────────────────────────────────────────
-- Pas de FOREIGN KEY vers needs(id) : la table SQLite d'origine l'a, mais
-- PRAGMA foreign_keys n'était activé que sur la connexion d'init (voir
-- core/database.py) — des matching_results orphelins existent en pratique.
-- La migration (scripts/migrer_vers_postgres.py) les signale et les saute
-- plutôt que d'échouer sur une contrainte que les données réelles ne
-- respectent pas forcément.
CREATE TABLE IF NOT EXISTS matching_results (
    id                  TEXT PRIMARY KEY,
    need_id             TEXT NOT NULL,
    candidate_id        TEXT NOT NULL,
    score_total         REAL NOT NULL DEFAULT 0,
    score_skills        REAL DEFAULT 0,
    score_title         REAL DEFAULT 0,
    score_seniority     REAL DEFAULT 0,
    score_availability  REAL DEFAULT 0,
    score_missions      REAL DEFAULT 0,
    score_bonus         REAL DEFAULT 0,
    strengths           JSONB NOT NULL DEFAULT '[]'::jsonb,
    weaknesses          JSONB NOT NULL DEFAULT '[]'::jsonb,
    reservations        JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing_skills      JSONB NOT NULL DEFAULT '[]'::jsonb,
    explanation         TEXT DEFAULT '',
    rank                INTEGER DEFAULT 0,
    computed_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_need  ON matching_results (need_id);
CREATE INDEX IF NOT EXISTS idx_match_score ON matching_results (need_id, score_total DESC);

-- ── Utilisateurs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'user',
    full_name      TEXT DEFAULT '',
    is_active      BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

-- ── Refresh tokens ───────────────────────────────────────────────────────────
-- Pas de FOREIGN KEY vers users(id) : delete_user() révoque les tokens de
-- l'utilisateur mais ne les supprime jamais côté JSON — des jti orphelins
-- (user_id sans compte) existent déjà dans data/tokens.json.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti         TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked     BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON refresh_tokens (user_id);

-- ── Invitations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'user',
    created_by  TEXT DEFAULT '',
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (LOWER(email));

-- ── Journal d'activité ───────────────────────────────────────────────────────
-- data/activity.json est un tableau JSON plafonné à 2000 entrées (voir
-- core/activity.py, MAX_EVENTS) — un contournement propre au stockage
-- fichier. En PostgreSQL, une vraie table n'a pas besoin de ce plafond :
-- core/activity_pg.py ne le reproduit pas ; "activité récente" devient un
-- ORDER BY ts DESC LIMIT au moment de la lecture.
CREATE TABLE IF NOT EXISTS activity (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    user_email  TEXT DEFAULT '',
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_user ON activity (user_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts   ON activity (ts DESC);
