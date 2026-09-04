# Checklist de recette post-déploiement (issue #20)

À dérouler après chaque déploiement (premier déploiement Coolify, ou mise à
jour majeure). Reprend l'esprit de la section 13 de l'ancien guide
`ADBI-Deploiement-Serveur.docx` (systemd), adaptée au déploiement
conteneurisé (`docker-compose.yml`, voir `docs/deploiement-coolify.md`).

- [ ] **`docker compose ps`** (ou l'onglet Coolify équivalent) : les 6
      conteneurs (`postgres` + 5 services) sont `Up`, aucun en
      `Restarting`/`Exited`.
- [ ] **Healthchecks verts** : chaque service expose un `HEALTHCHECK` Docker
      (voir chaque `Dockerfile`) — `docker inspect --format='{{.State.Health.Status}}' <conteneur>`
      renvoie `healthy` pour les 6, pas `unhealthy` ni `starting` en continu.
- [ ] **Aucun secret par défaut** : vérifier qu'aucune des variables REQUIS
      (`POSTGRES_PASSWORD`, `ADBI_CODE_PARAMETRES`, `ADBI_JWT_SECRET`,
      `ADBI_SUPERUSER_EMAIL`, `ADBI_SUPERUSER_PASSWORD`) n'a la valeur par
      défaut de développement — le `docker-compose.yml` refuse normalement de
      démarrer sans elles (`${VAR:?...}`), mais vérifier qu'elles n'ont pas
      été copiées telles quelles depuis un autre environnement.
- [ ] **`ADBI_AUTH=on` sur cv-parser** — obligatoire dès que le service n'est
      plus derrière la Factory en localhost (c'est le cas dès qu'un domaine
      public lui est assigné). Déjà posé en dur dans `docker-compose.yml`,
      vérifier qu'il n'a pas été retiré/surchargé.
- [ ] **PostgreSQL accessible** : `docker exec adbi-postgres pg_isready -U
      ${POSTGRES_USER}` répond `accepting connections` ; les 3 bases
      (`adbi_contrats`, `adbi_cv_parser`, `adbi_one_pager`) existent
      (`\l` dans `psql`) — créées par `infra/postgres/init-databases.sh` au
      premier démarrage du volume.
- [ ] **HTTPS actif** sur les 5 domaines publics (voir
      `docs/deploiement-coolify.md` § domaines) — certificat valide, pas
      d'avertissement navigateur, pas de mixed content.
- [ ] **Chaque module s'ouvre depuis la Factory** (tuile → iframe) et
      répond directement sur son propre domaine (pas seulement via la
      Factory) — confirme que `factory/modules.docker.json` (`hote`/`url`)
      correspond bien aux noms de service et domaines réellement déployés.
- [ ] **Voyant IA du hub** (si `ADBI_LLM_*` posées) : `/api/llm/tester`
      répond correctement — sinon voyant "non configurée", pas d'erreur
      côté navigateur (jamais d'appel direct navigateur → passerelle).
- [ ] **Sauvegardes planifiées** : volume `postgres-data`, `coffre/data/`
      (⚠️ `cle-locale.bin` irremplaçable), et tant que la migration
      PostgreSQL (milestone 4) n'est pas terminée pour un service, son
      dossier `data/` — voir `docs/deploiement-coolify.md` § volumes.
- [ ] **Un utilisateur superuser cv-parser fonctionnel** : connexion possible
      avec `ADBI_SUPERUSER_EMAIL`/`ADBI_SUPERUSER_PASSWORD` posés au premier
      démarrage — pas de repli sur `admin@adbi.fr` (dev uniquement).
