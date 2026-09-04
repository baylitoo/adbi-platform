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
COPY . .

# Les donnees (referentiel, historique SQLite, cle API) vivent dans
# /app/data, monte comme volume pour persister hors du conteneur.
ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "server.js"]
