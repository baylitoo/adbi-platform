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
- [ ] **`ADBI_AUTH=on` sur les CINQ services** — obligatoire dès qu'un domaine
      public est assigné, c'est-à-dire toujours en déploiement. Depuis #245,
      factory, coffre, contrats et one-pager ont chacun leur propre garde et
      lisent chacun **leur** `ADBI_AUTH` ; seul cv-parser l'a posé en dur dans
      `docker-compose.yml` (`ADBI_AUTH: "on"`). Les quatre autres reçoivent
      `${ADBI_AUTH:-}`, qui vaut **off** quand la variable n'est pas définie :
      la poser une fois au niveau du déploiement les couvre tous les cinq.
      ⚠️ Ne pas s'arrêter à « cv-parser demande un mot de passe » : c'est
      exactement l'état dans lequel les quatre autres restent ouverts.
- [ ] **`ADBI_JWT_SECRET` identique sur les cinq** — cv-parser signe, les
      quatre autres vérifient. Une valeur différente sur un service refuse
      toute session sur CE service (jamais un passage libre, mais une panne).
- [ ] **`ADBI_FACTORY_URL` posée** — sans elle, un module refusé répond un 401
      nu au lieu de renvoyer vers la connexion du hub, et cv-parser abandonne
      silencieusement le `next` après connexion (#254).
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
      (⚠️ `cle-locale.bin` irremplaçable), `contrats/data/` (fichiers
      générés — la bascule PostgreSQL ne les remplace pas),
      `cv-parser/uploads/` + `cv-parser/cv_output/` (fichiers CV — idem),
      et `one-pager/data/` tant que sa bascule PostgreSQL (issue #16) n'est
      pas faite — voir `docs/deploiement-coolify.md` § volumes pour le détail
      par service.
- [ ] **Un utilisateur superuser cv-parser fonctionnel** : connexion possible
      avec `ADBI_SUPERUSER_EMAIL`/`ADBI_SUPERUSER_PASSWORD` posés au premier
      démarrage — pas de repli sur `admin@adbi.fr` (dev uniquement).
