# ADBI Parser

Port **5000**. Python 3.14 + Flask. Extraction des CV déléguée à DocIE :
aucun Docling, Torch, OCR ou modèle à installer dans cette image.

## Principe

Dépôt du CV → cache par empreinte → lecture du texte → DocIE (schéma inline) →
normalisation ADBI → PostgreSQL et exports PDF/Word.

Par défaut, le client utilise `POST /v1/extract/text` avec le schéma `adbi_resume`
fourni dans la requête. PDF texte et DOCX sont pris en charge, pas encore les scans.
Voir [le guide Coolify + DocIE](../docs/coolify-docie.md).

En mode historique explicite `DOCIE_EXTRACTION_MODE=studio`, le client utilise
`POST /v1/studio/extract` avec `dynamic_schema_name`, puis
`GET /v1/studio/runs/{event_id}` jusqu'au résultat persistant. Il conserve
les expériences, formations, compétences et métadonnées de validation.
Les PDF sont envoyés en `content_b64`. Pour les DOCX, le texte des paragraphes
et tableaux est envoyé dans `text` (DocIE ne lit pas directement le format Word).
Un DOCX constitué uniquement d'images doit être exporté en PDF pour l'OCR.
Une panne distante est signalée ; une réanalyse échouée conserve la fiche existante.

## Configuration DocIE

Configurer les variables d'environnement (Compose lit le `.env` racine ;
en exécution native, exporter les variables dans le shell) :

- `DOCIE_BASE_URL` : URL racine, sans `/v1`. Sur ce poste Docker :
  `http://host.docker.internal:8080` ; hors Docker : `http://127.0.0.1:8080`.
- `DOCIE_API_KEY` : clé envoyée côté serveur dans `x-api-key`.
  Laisser vide uniquement si l'instance DocIE fonctionne sans authentification.
- `DOCIE_SCHEMA_NAME=resume` : schéma dynamique déjà enregistré dans DocIE.
- `DOCIE_MODEL_PROFILE` : profil DocIE ; vide pour son choix par défaut.
- `DOCIE_OCR_BACKEND` : backend OCR distant ; vide pour son choix par défaut.
- `DOCIE_TIMEOUT_SECONDS=900` : attente totale maximale (1 à 3600 secondes).

Le schéma `resume` doit suivre celui de
`document-parsing/scripts/register_and_test.py`. Le client ne remplace pas
les schémas existants. La version DocIE doit fournir `output` dans les résultats
persistés ; un statut « Completed » seul ne suffit pas.
Prévoir un délai de proxy suffisant pour les uploads/réanalyses synchrones.
Après un timeout, le traitement DocIE peut encore continuer.

### Bridge DocIE (issue #151)

`docie_client.py` ci-dessus appelait DocIE directement, avant l'arrivée du
bridge serveur partagé (`document-parsing/bridge/docie_bridge.py`, #150/#155),
réutilisé par les autres consommateurs du même milestone. `DOCIE_EXTRACTION_ENABLED`
(off par défaut — `docie_client.py` reste le chemin actif) bascule vers ce
bridge pour les PDF/PNG/JPEG/WebP ; un `.docx` continue de passer par
`docie_client.py` même bascule activée, le bridge n'ayant pas encore de
contrat texte. Requiert alors `DOCIE_AGENT_RESUME` (nom de l'agent DocIE côté
bridge) en plus de `DOCIE_BASE_URL`/`DOCIE_API_KEY` ci-dessus ; `DOCIE_ALLOW_HTTP=true`
si `DOCIE_BASE_URL` n'est pas en HTTPS et pas en loopback (ex. `host.docker.internal`
en local — le bridge refuse HTTP hors loopback par défaut). Un échec du
bridge (timeout, erreur DocIE, mauvaise configuration) ne relance pas
`docie_client.py` pour la même fiche — la fiche est stockée vide et éditable,
avec un message d'erreur, comme pour tout échec d'extraction. Voir
`docie_bridge_extraction.py` et `tests/test_docie_bridge_extraction.py`.
`docie_client.py` n'est pas retiré par cette bascule (prévu par l'issue #154,
une fois les trois services DocIE validés) ; c'est une migration réversible,
pas un remplacement.

Pour les scans, DocIE doit disposer d'un backend OCR opérationnel. Sur l'image
DocIE locale utilisée ici, `pdf_text`/`liteparse` inclut le secours OCR, mais
nécessite `TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata` dans
l'environnement de son worker pour utiliser les données Tesseract installées.
Ce réglage appartient au service DocIE, pas au conteneur CV Parser.

Les états intermédiaires Inngest enveloppés dans `data` peuvent afficher un
statut terminal avec `ended_at: null` pendant un traitement/rejeu. Le client
attend alors le résultat durable au lieu de conclure prématurément.

## Autres fonctions IA

`ADBI_LLM_BASE_URL` / `ADBI_LLM_API_KEY` restent utilisés par la traduction,
le rapprochement et les autres fonctions de langage. Ces réglages sont
indépendants de l'extraction DocIE. Une passerelle compatible servie par DocIE
utilise une URL terminant par `/v1`.

## Tester une instance distante

Le script `scripts/query_remote.py` (depuis la racine du dépôt) lit les valeurs
dans `.env.remote`. Le modèle du fichier `scripts/.env.example` décrit les deux
contrats supportés :

```bash
python scripts/query_remote.py chat
python scripts/query_remote.py extract chemin/vers/cv.pdf
```

`chat` accepte une URL racine avec port, une base `/v1`, ou l'endpoint complet
`/chat/completions`, avec `ADBI_LLM_MODEL` et `ADBI_LLM_API_KEY` (Bearer).
`extract` utilise le contrat DocIE Studio : `DOCIE_BASE_URL`, `DOCIE_API_KEY`
(X-API-Key), schéma `resume`, `DOCIE_OCR_BACKEND=liteparse`, et
`DOCIE_MODEL_PROFILE` désignant le profil LFM2.5 2.6B configuré sur ce serveur.
Un endpoint de pipeline personnalisé doit exposer l'un de ces contrats pour
être utilisé directement. Le script ne crée ni modèle ni pipeline distant.

Pour appliquer une configuration au service, reporter les variables concernées
dans le `.env` racine puis recréer le conteneur avec Docker Compose. Une chaîne
LLM enregistrée dans l'écran Paramètres reste prioritaire sur `ADBI_LLM_*` ;
la réinitialiser pour reprendre les valeurs d'environnement.

## Authentification

**Désactivée par défaut** (l'application tourne en local) — voir
`core/auth.py`. À réactiver avant toute exposition Internet :

```
ADBI_AUTH=on
```

## Organisation du code

```
app.py                  point d'entrée Flask
docie_client.py          extraction distante et mapping du schéma resume
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
export DOCIE_BASE_URL=http://127.0.0.1:8080
export DOCIE_SCHEMA_NAME=resume
# Exporter aussi DOCIE_API_KEY et DOCIE_MODEL_PROFILE selon l'instance.
python app.py                # → http://localhost:5000
```

Aucun téléchargement de modèle au démarrage. Le service DocIE héberge l'OCR et l'inférence.

### Docker

```bash
docker build -t adbi-cv-parser .
docker run -p 5000:5000 -v "$(pwd)/data:/app/data" \
  -e ADBI_AUTH=on -e DATABASE_URL=postgresql://adbi:motdepasse@host:5432/adbi_cv_parser \
  -e DOCIE_BASE_URL=http://host.docker.internal:8080 -e DOCIE_API_KEY -e DOCIE_MODEL_PROFILE \
  adbi-cv-parser
```

`ADBI_AUTH=on` n'est **pas** posé par défaut dans l'image — à fournir
explicitement au lancement, pour ne jamais masquer un oubli (voir
`factory/README.md`).

Variables d'environnement : voir [`.env.example`](.env.example).
# Déploiement DocIE inline

Le mode par défaut est maintenant `DOCIE_EXTRACTION_MODE=inline` : PDF texte/DOCX
vers `/v1/extract/text`, schéma `adbi_resume` fourni dans la requête, sans création
de schéma distant. Les scans nécessitent encore une intégration OCR ; ils sont
refusés explicitement. `DOCIE_EXTRACTION_MODE=studio` conserve le client historique
décrit plus bas. Voir [le guide Coolify](../docs/coolify-docie.md).
