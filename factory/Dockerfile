# ADBI Factory — image Docker
# Build : docker build -t adbi-factory .
# Run   : docker run -p 4000:4000 adbi-factory
#
# Aucune dépendance npm : uniquement les modules natifs de Node 18+ (voir
# server.js). modules.docker.json (hôtes/ports docker-compose, voir son
# "_lisezmoi") est copié en modules.json par défaut — pour un autre domaine
# ou une autre topologie, écraser /app/modules.json par bind-mount dans
# docker-compose.yml plutôt que reconstruire l'image.
FROM node:22-bookworm-slim

WORKDIR /app
COPY . .
COPY modules.docker.json modules.json

ENV NODE_ENV=production
# Sans ca, server.js lie 127.0.0.1 (defaut poste de dev) : injoignable via le
# port publie du conteneur malgre "-p 4000:4000" (voir server.js).
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.ADBI_PORT||4000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
