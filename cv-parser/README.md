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

Stocké dans `data/` (gitignoré) : `adbi.db` (SQLite), `users.json`,
`tokens.json`, `invites.json`, `jwt_secret.txt` (généré au premier
lancement). Compatibilité : `cv_database.json`, `uploads/` à la racine du
module (gitignorés aussi).

## Démarrage

```bash
python -m venv .venv
.venv/Scripts/activate      # ou source .venv/bin/activate sur Linux/Mac
pip install -r requirements.txt
python app.py                # → http://localhost:5000
```

Premier lancement : téléchargement des modèles Docling (long, normal).

Variables d'environnement : voir [`.env.example`](.env.example).
