# ADBI OnePager — image Docker
# Build (DEPUIS LA RACINE DU DEPOT — requis depuis l'issue #152 pour embarquer
# le client bridge DocIE partage, voir document-parsing/bridge/README.md) :
#   docker build -f one-pager/Dockerfile -t adbi-onepager .
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
