# Factures fournisseurs, sur le modèle de contrats/Dockerfile ; contextes additionnels : voir les deux docker-compose.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Copies à la racine de l'image : depuis /app, ../contrats/lib et ../../document-parsing gardent la profondeur du monorepo.
COPY --from=bridge --chown=node:node . /document-parsing/bridge
COPY --from=schemas --chown=node:node . /document-parsing/schemas
COPY --from=modeles --chown=node:node catalogue.json catalogue.js /document-parsing/models/
COPY --from=fixtures --chown=node:node date_mission.json /document-parsing/fixtures/date_mission.json
COPY --from=auth --chown=node:node . /auth
COPY --from=contratslib --chown=node:node . /contrats/lib

ENV NODE_ENV=production
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4500

RUN mkdir -p /app/data/fichiers && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4500)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
