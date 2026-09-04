# ADBI Parser

Port **5000**. Python 3.14 + Flask + Docling. Extraction structurée de CV —
**bibliothèques d'abord, IA seulement si besoin**.

## Principe

```
dépôt CV ──► empreinte SHA-256 ── déjà connue ? ──► fiche reprise (~0,5 s)
                │ non
                ▼
        extraction LOCALE (Docling, OCR désactivé, singleton préchargé)
                │
        extraction suffisante ? (nom, titre, ≥2 exp, ≥5 compétences)
                │ oui → fiche servie sans IA
                │ non
                ▼
        appel LLM (chaîne de secours configurable, voir llm_cascade.py)
```

Import par lot (2 envois parallèles), bouton « Relancer l'analyse » par
fiche, base locale + dossiers de compétences générés (`export_dossier.py`).

## LLM

`config.py` / `llm_cascade.py` appellent la **passerelle d'inférence
auto-hébergée ADBI** (compatible API OpenAI) via `ADBI_LLM_BASE_URL` +
`ADBI_LLM_API_KEY` (voir [`.env.example`](.env.example)) — OpenAI, OpenRouter
puis OVHcloud AI Endpoints ont été utilisés avant elle et sont tous retirés du
code. Sans `ADBI_LLM_BASE_URL`, l'extraction locale Docling reste seule
disponible (pas d'erreur, juste pas d'IA). Ne réintroduire aucun fournisseur
tiers non identifié.

## Authentification

**Désactivée par défaut** (l'application tourne en local) — voir
`core/auth.py`. À réactiver avant toute exposition Internet :

```
ADBI_AUTH=on
```

## Organisation du code

```
app.py                  point d'entrée Flask
config.py               configuration centralisée (JWT, LLM, chemins)
llm_cascade.py           appel LLM à chaîne de secours (sondage, repli)
skills_normalizer.py     normalisation des compétences
export_dossier.py        génération du dossier de compétences
api/                     blueprints (auth, matching, besoins, réglages)
core/                    auth, base de données, matching, rapprochement
templates/, static/      interface web
```

## Données

PostgreSQL — **requis** (issue #15, PR B), plus de repli SQLite/JSON : voir
`core/pg.py` (schéma), `core/database_pg.py` (besoins/matching),
`core/auth_pg.py` (utilisateurs/tokens/invitations), `core/activity_pg.py`
(journal d'activité), `core/cvstore_pg.py` (CVthèque). `DATABASE_URL` doit
pointer vers une base existante (`core/pg.py::database_url` lève sinon) —
voir [`.env.example`](.env.example). Une base existante en `adbi.db`
(SQLite) / `users.json` / `tokens.json` / `invites.json` / `activity.json` /
`cv_database.json` doit être migrée au préalable avec
`scripts/migrer_vers_postgres.py` (lecture seule sur les sources, rejouable).

`data/` (gitignoré) ne garde plus que `jwt_secret.txt` (généré au premier
lancement) et les réglages LLM (`llm_provider.txt`, `llm_model_interne.txt`).
`uploads/` (fichiers déposés) reste à la racine du module (gitignoré aussi).

## Démarrage

```bash
python -m venv .venv
.venv/Scripts/activate      # ou source .venv/bin/activate sur Linux/Mac
pip install -r requirements.txt
export DATABASE_URL=postgresql://adbi:motdepasse@localhost:5432/adbi_cv_parser
python app.py                # → http://localhost:5000
```

Premier lancement : téléchargement des modèles Docling (long, normal).

### Docker

```bash
docker build -t adbi-cv-parser .
docker run -p 5000:5000 -v "$(pwd)/data:/app/data" \
  -e ADBI_AUTH=on -e DATABASE_URL=postgresql://adbi:motdepasse@host:5432/adbi_cv_parser \
  adbi-cv-parser
```

`ADBI_AUTH=on` n'est **pas** posé par défaut dans l'image — à fournir
explicitement au lancement, pour ne jamais masquer un oubli (voir
`factory/README.md`).

Variables d'environnement : voir [`.env.example`](.env.example).
