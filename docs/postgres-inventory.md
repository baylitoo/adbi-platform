# Inventaire des stockages actuels (avant migration PostgreSQL)

Produit pour l'issue #12 (milestone 4 — migration PostgreSQL). Basé sur
lecture directe du code (pas de la doc) au 2026-09-04 — sert de référence
pour la conception du schéma dans #14 (contrats), #15 (cv-parser) et #16
(one-pager). Chemins relatifs à chaque service.

---

## contrats/

### `data/contrats.sqlite` — sql.js (WASM), fichier réécrit entier à chaque `persist()`

**Table `contrats`** (server.js:48-59)
| Colonne | Type déclaré | Ajoutée par | Notes |
|---|---|---|---|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | CREATE initial | |
| numero | TEXT | CREATE initial | `values.numeroContrat` ou `numeroAvenant` |
| type | TEXT | CREATE initial | "sous-traitance" / "cds" / "cdi" / "cdd" / "avenant" |
| sous_traitant | TEXT | CREATE initial | `values.stNom` ou `avPartie2Nom` |
| client_final | TEXT | CREATE initial | `values.clientFinal` |
| payload | TEXT | CREATE initial | JSON de `{type, values, options}` (ou `req.body` complet selon la route — voir /api/save vs /api/signatures) |
| cree_le | TEXT | CREATE initial | ISO 8601 |
| statut | TEXT DEFAULT '' | ALTER (idempotent, try/catch) | '' = en cours, "clos" = clôturé |
| signe | TEXT DEFAULT '' | ALTER (idempotent, try/catch) | date ISO (YYYY-MM-DD) de signature externe, '' sinon |

**Table `signatures`** (server.js:55) — une colonne `donnees` TEXT contenant le JSON entier d'une "demande" (voir `lib/signatures.js::nouvelleDemande`). Champs réels du blob JSON (id ajouté après coup côté app, pas en base) :
| Champ | Type | Notes |
|---|---|---|
| base | string | nom de dossier de stockage (`data/contrats-generes/<base>/`) |
| numero | string | |
| titre | string | |
| type | string | |
| payload | string | **JSON stringifié imbriqué** (double-encodé) — `{type, values, options}` |
| empreinte | string | SHA-256 hex du PDF de base |
| echeance | string \| null | "AAAA-MM-JJ" |
| signataires | array | `[{role, cote:"left"|"right", nom, email, rang:int, statut:"attente"|"signe", signeLe:string|null}]` |
| statut | string | "envoyee" \| "complete" \| "annulee" |
| fournisseur | string \| null | "yousign" \| "zoho" \| "local" (anciennes demandes) |
| externe | object \| null | `{id: string, signataires: [{email, url}]}` — réf. chez le fournisseur |
| journal | array | `[{quand: ISO string, evenement: string}]` |
| creeLe | string (ISO) | |
| completeLe | string (ISO) \| null | |
| id (runtime only) | int | recopié dans le JSON stocké après insert (référence SIG-<id> stable) |

Anciennes demandes "locales" (flux retiré) peuvent aussi porter `signataires[].image` (dataURL png), `.cachet` (dataURL), `.initiales`, `.ip`, `.agent` — champs optionnels lus par `signaturesPourPdf`/`certificatDe`, absents des nouvelles demandes.

**Table `corbeille`** (server.js:62) : `id INTEGER PK`, `type TEXT` ("contrat" \| "signature"), `donnees TEXT` (JSON — objet contrat SANS id, ou objet demande SANS id), `supprime_le TEXT` (ISO). Restauration réinsère dans la table d'origine.

### `data/referentiels.json` — fichier JSON unique (lib/referentiels.js)
```
{
  clients: [{ nom, siren, adresse, email, tel, craValidateurs: string[], lieux: string[] }],
  managers: [{ nom, email, tel }],
  signataires: [{ nom, qualite }],
  soustraitants: [{ nom, formeJuridique, adresse, siren, siret, representant, qualite, email }]
}
```
Toutes les valeurs sont des strings trim() côté `save()`. **Suivi en git** (voir .gitignore) — décision explicite, référentiel partagé.

### `data/templates-perso.json` — fichier JSON unique (lib/templates-perso.js)
```
{ [type: string]: {
    meta: { titre?, headerTitle?, headerNum?, footerText? },   // 4 clés connues (META_DEFS)
    blocs: [{ i: int, original: string, texte: string }]        // retouche appliquée seulement si original correspond encore au bloc actuel de lib/template.js
} }
```

### `data/secrets.json` — fichier JSON unique
Clés vues dans le code (intégrations.js, mailer.js, fournisseurs/{yousign,zoho}.js) : `pappersApiKey`, `inseeApiKey`, `source` ("gouv"|"pappers"|"insee"), `smtpHote`, `smtpPort`, `smtpUtilisateur`, `smtpMdp`, `smtpExpediteur`, `fournisseurSignature` ("yousign"|"zoho", ancien "local" ignoré), `yousignMode` ("sandbox"|"production"), `yousignCleApi`, `yousignWebhookSecret`, `zohoRegion` ("eu"|"com"|"in"), `zohoClientId`, `zohoClientSecret`, `zohoRefreshToken`. **Toutes ces clés ont déjà un équivalent variable d'environnement prioritaire** (milestone 1, PR #21) — ce fichier n'est qu'un repli, candidat à NE PAS migrer vers Postgres (reste un fichier local ou disparaît si l'env devient obligatoire).

### `data/code-parametres.txt` — fichier texte brut (un seul code d'accès). A un remplaçant env (`ADBI_CODE_PARAMETRES`, milestone 1) — probablement pas à migrer non plus.

### Hors DB
`data/contrats-generes/<base>/*` : fichiers binaires (PDF/DOCX) horodatés — restera sur disque/volume, pas en base.

---

## cv-parser/

### `data/adbi.db` — SQLite natif (core/database.py), PRAGMA WAL + foreign_keys

**Table `needs`**
| Colonne | Type SQLite | Défaut |
|---|---|---|
| id | TEXT PK | uuid4 str |
| title | TEXT NOT NULL | |
| context | TEXT | '' |
| required_skills | TEXT (JSON array stringifié) | '[]' |
| bonus_skills | TEXT (JSON array) | '[]' |
| seniority | TEXT | '' |
| min_years | INTEGER | 0 |
| languages | TEXT (JSON array) | '[]' |
| location | TEXT | '' |
| remote | TEXT | 'flexible' |
| start_date | TEXT | '' |
| contract_type | TEXT | 'Tous' |
| budget | TEXT | '' |
| client | TEXT | '' |
| sector | TEXT | '' |
| notes | TEXT | '' |
| raw_text | TEXT | '' |
| status | TEXT | 'active' ("active"\|"archivé"\|"pourvu" côté Pydantic) |
| prix_achat | REAL | 0 (ajoutée par migration ALTER idempotente) |
| prix_vente | REAL | 0 (idem) |
| created_by | TEXT NOT NULL | (user id) |
| created_at | TEXT NOT NULL | ISO |
| updated_at | TEXT NOT NULL | ISO |

Index : `idx_needs_status(status)`, `idx_needs_created_by(created_by)`.

**Table `matching_results`** (FK need_id → needs.id ON DELETE CASCADE)
| Colonne | Type | Notes |
|---|---|---|
| id | TEXT PK | uuid4 |
| need_id | TEXT NOT NULL | FK |
| candidate_id | TEXT NOT NULL | référence un enregistrement de cv_database.json, PAS une FK SQL (pas de table candidates ici) |
| score_total, score_skills, score_title, score_seniority, score_availability, score_missions, score_bonus | REAL | |
| strengths, weaknesses, reservations, missing_skills | TEXT (JSON array) | |
| explanation | TEXT | résumé texte libre |
| rank | INTEGER | |
| computed_at | TEXT NOT NULL | ISO |

Index : `idx_match_need(need_id)`, `idx_match_score(need_id, score_total DESC)`.

Toute la sérialisation JSON (`required_skills` etc.) est faite manuellement en Python (`_j`/`_uj`) — pas de type JSON natif utilisé côté SQLite.

### `data/users.json` — dict JSON `{ [user_id: uuid]: user }`
```
{ id, email, password_hash (bcrypt), role: "user"|"superuser", full_name, is_active: bool, created_at: ISO }
```
`list_users()`/`_public()` retirent `password_hash` avant tout envoi au front — jamais exposé.

### `data/tokens.json` — dict JSON `{ [jti: uuid]: token_record }` (refresh tokens uniquement — les access tokens ne sont pas stockés, juste signés JWT)
```
{ user_id, jti, expires_at: ISO, created_at: ISO, revoked: bool }
```

### `data/invites.json` — **liste** JSON (pas un dict, contrairement à users/tokens) — géré par `api/settings_bp.py`, pas core/auth.py
```
[{ token: string (urlsafe), email, role, created_by: email, expires_at: ISO, used: bool }]
```

### `data/jwt_secret.txt` — fichier texte brut (secret HMAC JWT). A un remplaçant env (`ADBI_JWT_SECRET`) — pas un candidat Postgres.

### `data/activity.json` — **liste** JSON, plafonnée à 2000 entrées (core/activity.py — NON listé dans l'issue #12 d'origine, trouvé en lisant le code)
```
[{ type: "login"|"cv_upload"|"match_run", user_id, user_email, detail: object (libre), ts: ISO }]
```
Insertion en tête de liste (le plus récent en premier), troncature à 2000 à chaque écriture.

### `cv_database.json` (racine du module, PAS dans data/) — dict JSON `{ [cv_id: uuid]: cv_record }`
Le plus gros et le moins structuré des stockages. Champs observés (assemblage progressif dans app.py, tous ne sont pas garantis présents selon le chemin de traitement — extraction complète vs repli minimal vs reprise depuis cache) :
```
id, filename, ext, uploaded_at (ISO), stored_at (ISO), empreinte (sha256 hex, sert de clé de dédoublonnage),
name, name_source ("nom du fichier", optionnel), title, years_experience (int),
contact: { email, phone, linkedin, github, location },
experience: [...] (structure libre, alimente aussi years_experience/bilan),
education: [...], skills: [...], skills_flat: [...] (calculé), languages: [...],
projects: [...], certifications: [...], interests: [...],
html_content (string, gros volume potentiel),
llm_parsed (bool), llm_enriched (bool), docling_used (bool),
parsing_mode: "digital"|"scanned", llm_service (string, ex. "ADBI/<modele>"),
extraction: "ia"|"bibliothèques"|"cache",
bilan_adbi (objet calculé, structure libre — voir bilan_adbi() dans app.py),
parse_warning (string, optionnel), copie_de (id source, seulement si extraction="cache")
```
Champs nested (`experience`, `education`, `contact`, `bilan_adbi`) ont une structure libre non capturée ici en détail (pas de schéma Pydantic les couvrant contrairement à `needs`/`matching_results`) — à relire dans `skills_normalizer.py`/le code d'extraction si un schéma Postgres normalisé est envisagé plutôt qu'une colonne JSONB.

### Hors DB
`uploads/` (fichiers CV bruts), `cv_output/` (dossiers de compétences générés), `data/llm_chaine.json` / `llm_provider.txt` / `llm_model_interne.txt` (config LLM, a des remplaçants env depuis PR #25 — pas candidats).

---

## one-pager/

### `data/cvs.sqlite` — sql.js (WASM)

**Table unique `cvs`**
| Colonne | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| nom | TEXT | dénormalisé depuis `master.identity.full_name`, pour tri/liste sans parser le JSON |
| titre | TEXT | dénormalisé depuis `master.identity.title` |
| fichier | TEXT | dénormalisé depuis `master.source.filename` |
| hash | TEXT | empreinte du fichier source (dédoublonnage, `findByHash`) |
| master | TEXT NOT NULL | **JSON stringifié complet** — le "cv_master" (extraction sans perte). Structure interne connue en partie : `identity: {full_name, title, trigram, seniority_years}`, `source: {filename}`, `experiences: []` — reste non capturé ici (à relire dans lib/extract.js si un schéma normalisé est visé) |
| options | TEXT | JSON stringifié — réglages one-pager (anonymisation, densité, angle, cible…) |
| cree_le | TEXT | ISO, ne change pas après création (repris de l'existant à l'upsert) |
| maj_le | TEXT | ISO, mis à jour à chaque `save()` |

Index : `idx_cvs_hash(hash)`.

Le "cv_onepager" (projection réduite) n'est **jamais stocké** — recalculé à la demande depuis `master` (confirmé dans le code, pas seulement dans le README).

Sauvegarde applicative additionnelle hors du champ Postgres : rotation de 3 copies `cvs.sauvegarde{1,2,3}.sqlite` + copie `.avant-perte-<horodatage>.sqlite` si le nombre de lignes chute de plus de moitié — logique de sécurité propre à sql.js (réécriture totale du fichier à chaque persist) qui n'aura plus de raison d'être une fois sur Postgres (WAL + transactions).

**Statut de migration (PR #31, issue #16) :** schéma + module d'accès async
(`lib/db.pg.js`) + script de migration écrits et testés contre un vrai
Postgres — `server.js` ne les consomme pas encore (PR B à venir).

---

## coffre/
Pas de base de données (confirmé, aucun fichier `.sqlite`/`.db` ni `require("sql.js")`/`sqlite3` dans coffre/). Uniquement `data/cle-locale.bin` (clé de chiffrement) + les documents traités transitoirement. Reste hors Postgres, volume de fichiers uniquement — cohérent avec l'issue #12 d'origine.

---

## Résumé — candidats Postgres vs hors périmètre

| Store | Candidat Postgres ? |
|---|---|
| contrats: table `contrats` | Oui |
| contrats: table `signatures` | Oui (JSON imbriqué à plat ou en JSONB — à trancher en #14) |
| contrats: table `corbeille` | Oui |
| contrats: `referentiels.json` | À trancher (#14 le mentionne déjà — actuellement suivi en git, migrer casserait ce mécanisme de partage par commit) |
| contrats: `templates-perso.json` | Probablement oui (petit volume, mais actuellement per-fichier donc per-instance) |
| contrats: `secrets.json`, `code-parametres.txt` | Non — remplacés par variables d'env (milestone 1) |
| cv-parser: `needs` + `matching_results` (adbi.db) | Oui |
| cv-parser: `users.json`, `tokens.json`, `invites.json` | Oui |
| cv-parser: `activity.json` | Oui (append-only, volumineux à terme — pourrait justifier une table dédiée avec purge) |
| cv-parser: `cv_database.json` | Oui, mais structure très libre — JSONB probable plutôt que colonnes normalisées, sauf si #15 choisit de normaliser `experience`/`education`/etc. |
| cv-parser: `jwt_secret.txt`, `llm_*.txt/json` | Non — remplacés par variables d'env |
| one-pager: `cvs` (cvs.sqlite) | Oui — `master`/`options` probablement JSONB (déjà stockés JSON stringifié) |
| coffre: (aucune base) | Hors périmètre, confirmé |
