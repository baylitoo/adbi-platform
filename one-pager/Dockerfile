# ADBI OnePager — image Docker
# Build (DEPUIS LA RACINE DU DEPOT — requis depuis l'issue #152 pour embarquer
# le client bridge DocIE partage, voir document-parsing/bridge/README.md) :
#   docker build -f one-pager/Dockerfile -t adbi-onepager .
# Contexte filtre par one-pager/Dockerfile.dockerignore (liste blanche, lue par
# BuildKit a la place d'un .dockerignore racine) : tout nouveau COPY doit y
# etre reintegre, sinon le build echoue sur « not found ».
# Run   : docker run -p 4200:4200 -v "$(pwd)/data:/app/data" adbi-onepager
FROM node:22-bookworm-slim

WORKDIR /app

# Dépendances d'abord (meilleur cache Docker).
COPY one-pager/package.json one-pager/package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node one-pager/ ./
# Client bridge DocIE partage (issue #150) : source unique dans
# document-parsing/bridge/, jamais copiee a la main dans les modules d'apres
# son README — d'ou un contexte de build a la racine du depot plutot qu'un
# copier-coller. lib/docie-extract.js le charge via un chemin relatif
# (../../document-parsing/bridge/docie-bridge) qui reste valable ici :
# depuis /app/lib, il resout vers /document-parsing/bridge/docie-bridge.js.
# N'est utilise que si DOCIE_EXTRACTION_ENABLED=true ; son absence ne bloque
# pas le demarrage du service (voir lib/docie-extract.js#chargerBridge).
COPY --chown=node:node document-parsing/bridge/docie-bridge.js /document-parsing/bridge/docie-bridge.js
# Definition du schema « adbi_resume », envoyee avec le texte sur la voie
# /v1/extract/text (issue #180) : `schema_name` seul ne resout que le registre
# integre de DocIE, un schema personnalise doit voyager avec sa definition.
# Elle n'est pas dans bridge/ — un transport ne possede pas de schema metier.
# Sans cette ligne, l'image embarquerait le code de la voie texte sans ce
# qu'elle envoie, et chaque import texte se replierait en local.
COPY --chown=node:node document-parsing/schemas/adbi_resume.schema.json /document-parsing/schemas/adbi_resume.schema.json

# Jeux d'essai partages avec cv-parser (#177) : lib/normalize.js les charge par
# `require`, AU CHARGEMENT DU MODULE et sans garde — et server.js remonte
# jusqu'a lui par lib/extract.js. Contrairement au client bridge ci-dessus, leur
# absence ne degrade donc pas une fonctionnalite : elle empeche le service de
# demarrer. Meme chemin relatif depuis /app/lib : ../../document-parsing/.
# competences_synonymes.json (#177 G/H) : meme regime, lib/taxonomy.js le lit au
# chargement — et taxonomy.js est requis par lib/extract.js.
COPY --chown=node:node document-parsing/fixtures/mission_en_cours.json \
     document-parsing/fixtures/date_mission.json \
     document-parsing/fixtures/competences_synonymes.json \
     /document-parsing/fixtures/

# Catalogue des modeles par action (#194) : lib/choix-modele.js charge
# ../../document-parsing/models/catalogue (le chargeur et catalogue.json a cote)
# pour GET /api/modeles et pour un import avec un modele choisi. Charge a
# l'appel, comme le bridge : sans ces fichiers le service demarre et l'import
# sans choix fonctionne, mais aucun modele n'est propose et un choix echoue.
# Les deux fichiers seulement : tests/ n'a rien a faire dans l'image. A
# reintegrer dans Dockerfile.dockerignore (liste blanche).
COPY --chown=node:node document-parsing/models/catalogue.json \
     document-parsing/models/catalogue.js \
     /document-parsing/models/

# Bibliotheque de verification des jetons ADBI (auth/auth-adbi.js, #247).
# AUCUN `additional_contexts` ici, contrairement a factory, coffre et contrats :
# le contexte de build de cette image EST deja la racine du depot (voir l'en-tete
# et les deux docker-compose), donc auth/ est atteignable directement. server.js
# le resout par ../auth depuis /app, soit la meme profondeur qu'en checkout.
# Sans cette copie le conteneur PLANTE au demarrage, le require echouant --
# panne invisible aux tests, qui tournent sur le checkout.
# Le contexte est filtre par une LISTE BLANCHE (Dockerfile.dockerignore) : la
# ligne `!auth` y est indispensable, sinon ce COPY echoue sur « not found ».
COPY --chown=node:node auth/ /auth

ENV NODE_ENV=production
# Sans ca, server.js lie 127.0.0.1 (defaut poste de dev) : injoignable via le
# port publie du conteneur malgre "-p 4200:4200" (voir server.js).
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4200

# Ne jamais tourner en root dans le conteneur (issue #136) : node:22-bookworm-slim
# fournit deja l'utilisateur non-privilegie "node" (uid 1000). /app/data est
# recree ici pour le cas sans bind-mount (build/test local) ; quand le volume
# hote existe deja (docker-compose.yml), chown -R ./one-pager/data vers 1000:1000
# avant le premier demarrage sur un hote deja provisionne en root.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# /api/sante fait un vrai SELECT 1 contre PostgreSQL (voir lib/db.pg.js et
# server.js) — "/" ne fait que servir index.html en statique et restait vert
# meme base injoignable (issue #88).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
