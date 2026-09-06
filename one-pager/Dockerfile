# ADBI OnePager — image Docker
# Build : docker build -t adbi-onepager .
# Run   : docker run -p 4200:4200 -v "$(pwd)/data:/app/data" adbi-onepager
FROM node:22-bookworm-slim

WORKDIR /app

# Dépendances d'abord (meilleur cache Docker).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

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
