# Déploiement Coolify (issue #18)

Complète `README.md` (chemin Docker générique) avec la config spécifique à
Coolify : import du dépôt, domaines, variables d'environnement, réseau
inter-services. Prérequis : `docker-compose.yml` (racine) et
`factory/modules.docker.json`.

## 1. Import du dépôt

Coolify → nouvelle *Resource* → **Docker Compose**, pointer sur ce dépôt
(branche `master`), fichier `docker-compose.yml` à la racine. **Un seul
resource pour les 6 conteneurs** (5 services + `postgres`) — pas une
resource par service : ils partagent le réseau compose et les dépendances
`depends_on: postgres: condition: service_healthy` du fichier.

## 2. Domaines — un sous-domaine public par service (sauf Postgres)

`factory/modules.docker.json` fixe déjà les URL publiques attendues par le
navigateur (`hote` = nom du service compose pour la résolution DNS interne ;
`url` = domaine public HTTPS) :

| Service compose | Domaine à assigner dans Coolify |
|---|---|
| `factory` | domaine racine, ex. `outils.adbi.fr` (page d'accueil / hub) |
| `one-pager` | `onepager.outils.adbi.fr` |
| `contrats` | `contrats.outils.adbi.fr` |
| `coffre` | `coffre.outils.adbi.fr` |
| `cv-parser` | `parser.outils.adbi.fr` |
| `postgres` | **aucun** — jamais de domaine public, accès réseau interne uniquement (voir `docker-compose.yml`, aucun port publié par défaut) |

Si un domaine différent de `outils.adbi.fr` est utilisé : adapter
`factory/modules.docker.json` (`url` de chaque module) avant déploiement —
c'est le fichier que le conteneur `factory` charge comme `modules.json`
(voir `factory/Dockerfile`).

Chaque service sert directement son propre domaine — la Factory ne fait
**pas** office de reverse proxy applicatif, le navigateur navigue vers le
domaine du module cliqué (iframe `src` = l'URL publique). Coolify pose le
HTTPS (Let's Encrypt) par domaine automatiquement.

## 3. Variables d'environnement

Toutes celles listées dans `.env.example` (racine) et le `.env.example` de
chaque service se posent comme variables d'environnement **natives
Coolify**, par service — jamais de fichier `.env` committé ni copié à la
main. Rappel des REQUIS (le `docker-compose.yml` refuse de démarrer sans
eux, voir la syntaxe `${VAR:?message}`) :

- `POSTGRES_PASSWORD` (généré, jamais réutilisé d'un autre environnement)
- `ADBI_CODE_PARAMETRES` (contrats)
- `ADBI_JWT_SECRET`, `ADBI_SUPERUSER_EMAIL`, `ADBI_SUPERUSER_PASSWORD` (cv-parser)

Le reste (SMTP, Yousign, Zoho, Pappers/INSEE, passerelle LLM interne) est
optionnel — sans eux le service démarre en mode dégradé documenté dans son
propre README.

## 4. Réseau inter-services

Le réseau par défaut du compose suffit : chaque service résout les autres
par leur nom de service (`postgres`, `contrats`, `one-pager`, `coffre`,
`cv-parser`) — c'est déjà ce que `factory/modules.docker.json` (`hote`) et
`docker-compose.yml` (`DATABASE_URL=...@postgres:5432/...`) utilisent.
Aucune configuration réseau Coolify supplémentaire n'est nécessaire tant que
tout reste dans le même docker-compose resource. Coffre n'est appelé par
aucun autre service **côté serveur** actuellement (uniquement un lien de
navigation dans `factory/public/rail.js`, côté navigateur) — pas de règle
réseau spécifique à prévoir pour lui.

## 5. Volumes persistants

En plus de `postgres-data` (déjà déclaré dans `docker-compose.yml`), monter
en volume Coolify (pas dans l'image) :
- `coffre/data/` — contient `cle-locale.bin`, **irremplaçable** (voir
  `coffre/README.md`)
- `contrats/data/`, `one-pager/data/`, `cv-parser/data/` (+ `uploads/`,
  `cv_output/`) — tant que leur migration PostgreSQL (milestone 4) n'est pas
  terminée, ce sont ces dossiers qui portent les données réelles.
