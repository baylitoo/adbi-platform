# =====================================================================
#  ADBI - Generateur de contrats  --  Image Docker
#  Build :  docker build -t adbi-contrats .
#  Run   :  docker run -p 4100:4100 -v "$(pwd)/data:/app/data" adbi-contrats
#  (Plus simple : voir docker-compose.yml et LISEZ-MOI-DOCKER.txt)
# =====================================================================
FROM node:22-bookworm-slim

# Dossier de travail dans le conteneur
WORKDIR /app

# 1) Dependances d'abord (meilleur cache Docker : ne se reinstalle
#    que si package.json / package-lock.json changent)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2) Code de l'application
COPY --chown=node:node . .

# 3) Bridge DocIE partage (issue #153, extraction Kbis optionnelle derriere
#    DOCIE_EXTRACTION_ENABLED — voir lib/docie-extraction.js). Le contexte de
#    build additionnel "bridge" pointe vers document-parsing/bridge/ (hors du
#    contexte ./contrats — voir docker-compose.yml racine et celui de ce
#    dossier). Copie a la racine du systeme de fichiers de l'image, PAS sous
#    /app : lib/docie-extraction.js resout /document-parsing/bridge via un
#    chemin relatif depuis /app/lib (../../document-parsing/bridge), la meme
#    profondeur qu'en checkout monorepo (contrats/lib -> document-parsing/bridge).
#    Ce fichier partage n'est pas duplique dans contrats/ (cf. le README du
#    bridge : "ne pas copier manuellement ces fichiers dans les modules").
COPY --from=bridge --chown=node:node . /document-parsing/bridge

# Les fichiers (referentiel, cle API, contrats generes) vivent dans
# /app/data, monte comme volume pour persister hors du conteneur.
# L'historique/signatures/corbeille/templates-perso vivent en PostgreSQL
# (DATABASE_URL, requise — voir README.md).
ENV NODE_ENV=production
# Sans ca, server.js lie 127.0.0.1 (defaut poste de dev) : injoignable via le
# port publie du conteneur malgre "-p 4100:4100" (voir server.js).
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4100

# Ne jamais tourner en root dans le conteneur (issue #136) : node:22-bookworm-slim
# fournit deja l'utilisateur non-privilegie "node" (uid 1000). /app/data est
# recree ici pour le cas sans bind-mount (build/test local) ; quand le volume
# hote existe deja (docker-compose.yml), chown -R ./contrats/data vers 1000:1000
# avant le premier demarrage sur un hote deja provisionne en root.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# /api/sante fait un vrai SELECT 1 contre PostgreSQL (voir lib/db.pg.js et
# server.js) — "/" ne fait que servir index.html en statique et restait vert
# meme base injoignable (issue #88).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
