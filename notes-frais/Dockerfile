# ADBI - Notes de frais -- image Docker, même modèle que contrats/Dockerfile.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Sources partagées copiées à la racine de l'image : lib/ les résout par ../../, comme en checkout monorepo.
COPY --from=bridge --chown=node:node . /document-parsing/bridge
COPY --from=schemas --chown=node:node recu.schema.json /document-parsing/schemas/recu.schema.json
COPY --from=modeles --chown=node:node catalogue.json catalogue.js /document-parsing/models/

# server.js résout ../auth et ../contrats/lib depuis /app.
COPY --from=auth --chown=node:node . /auth
COPY --from=contratslib --chown=node:node taches-extraction.js choix-modele.js /contrats/lib/

ENV NODE_ENV=production
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4400

# Justificatifs déposés : volume nommé monté sur /app/data.
RUN mkdir -p /app/data/recus && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4400)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
