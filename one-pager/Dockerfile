# ADBI OnePager — image Docker
# Build : docker build -t adbi-onepager .
# Run   : docker run -p 4200:4200 -v "$(pwd)/data:/app/data" adbi-onepager
FROM node:22-bookworm-slim

WORKDIR /app

# Dépendances d'abord (meilleur cache Docker).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4200

# data/cvs.sqlite est monté en volume pour persister hors du conteneur.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
