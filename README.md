# Plateforme ADBI — dépôt de déploiement

Suite d'outils internes ADBI, orchestrée par **ADBI Factory** :

| Dossier | Module | Port | README |
|---|---|---|---|
| `factory/` | ADBI Factory — hub, tuiles, cycle de vie des modules | 4000 | [factory/README.md](factory/README.md) |
| `contrats/` | ADBI Contrats + ADBI Sign — génération de contrats, signature par connecteurs API (Yousign / Zoho Sign) | 4100 | [contrats/README.md](contrats/README.md) |
| `one-pager/` | ADBI OnePager — CV → dossier de compétences | 4200 | [one-pager/README.md](one-pager/README.md) |
| `coffre/` | ADBI Coffre — protection / anonymisation de documents | 4300 | [coffre/README.md](coffre/README.md) |
| `cv-parser/` | ADBI Parser — extraction structurée de CV (Python/Flask) | 5000 | [cv-parser/README.md](cv-parser/README.md) |

Le module **ADBI Gestion n'est pas dans ce dépôt** (outil interne, non déployé).

## Déployer

### Coolify (production)

Déployer `master` avec le fichier standard `docker-compose.yml`. Saisir les secrets
directement dans l'interface Coolify : aucun fichier `.env` à déployer.
Voir [le guide DocIE et Coolify](docs/coolify-docie.md) pour les domaines, volumes
persistants, variables requises et protections d'accès avant ouverture publique.

### Docker local

```bash
git clone <URL_DE_CE_DEPOT> adbi-platform && cd adbi-platform
cp .env.example .env      # renseigner les variables REQUIS (voir le fichier)
docker compose -f docker-compose.local.yml up -d --build
# → Factory sur http://localhost:4000
```

`docker-compose.yml` construit et démarre les 5 services (`factory` utilise
`factory/modules.docker.json`, voir `factory/README.md`) plus une instance
PostgreSQL (une base par service, voir `infra/postgres/`). Sous Coolify,
importer ce dépôt comme *docker-compose resource* : les variables
d'environnement se posent dans l'interface, un domaine par service. La base
Postgres est consommée par contrats, cv-parser et one-pager. Le fichier
`docker-compose.local.yml` conserve les ports locaux et les bind mounts historiques.
Ne pas basculer une installation existante vers les volumes de production sans
migrer ses données.

### Serveur classique (systemd, un seul hôte)

**Suivre le guide : [`ADBI-Deploiement-Serveur.docx`](ADBI-Deploiement-Serveur.docx)**
(prérequis, installation, Caddy/HTTPS, systemd, pare-feu, sauvegardes, recette).

Résumé du chemin :

```bash
# sur le serveur (Ubuntu 22.04/24.04)
sudo git clone <URL_DE_CE_DEPOT> /opt/adbi
cd /opt/adbi
# puis dérouler le guide à partir de la section 5 :
#  - npm ci dans contrats/, one-pager/, coffre/  (factory : aucune dépendance)
#  - venv + pip install -r cv-parser/requirements.txt
#  - factory/modules.example.json → adapter le domaine → renommer en modules.json
#  - Caddyfile (section 7), systemd (section 8), UFW (section 9)
```

> ⚠️ Le guide utilise `/opt/adbi/factory`, `/opt/adbi/contrats`, etc. — la
> structure de ce dépôt correspond exactement : cloner dans `/opt/adbi` suffit.

## Ce que git ne contient pas (voulu — voir `.gitignore`)

- **Secrets** : clés API, code d'accès des Paramètres de Contrats, clé du
  Coffre — voir le `.env.example` de chaque service. **Un code/mot de passe
  par défaut existe dans le code pour le développement local uniquement** ;
  poser explicitement `ADBI_CODE_PARAMETRES` (contrats) et
  `ADBI_SUPERUSER_EMAIL`/`ADBI_SUPERUSER_PASSWORD` (cv-parser) avant tout
  déploiement accessible depuis Internet.
- **Données de travail** : bases, CV, documents, archives de contrats — la
  plateforme démarre à vide et le serveur garde ses données hors git
  (les mises à jour par `git pull` ne toucheront jamais aux données).

## Mettre à jour le serveur

```bash
cd /opt/adbi && sudo -u adbi git pull && sudo systemctl restart adbi-factory
```

## Documents

- `ADBI-Deploiement-Serveur.docx` — le guide de déploiement pas à pas (systemd)
- `ARCHITECTURE.md` — architecture interne, sécurité, évolutivité
- `contrats/docs/INTEGRATION-SIGNATURE.md` — connecteurs de signature (Yousign / Zoho), conformité RGPD/eIDAS

> Dépôt privé. Déploiement par conteneurs (Docker/Coolify) et secrets en
> variables d'environnement disponibles ci-dessus ; migration vers une base
> PostgreSQL partagée encore en préparation (chaque service garde pour
> l'instant son stockage fichier).

Contact fonctionnel : Amine OUKLI (ADBI).
