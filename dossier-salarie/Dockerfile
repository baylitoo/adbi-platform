# =====================================================================
#  ADBI - Dossier salarie  --  Image Docker (modele : contrats/Dockerfile)
# =====================================================================
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Code partage, a la racine de l'image : meme profondeur relative qu'en checkout monorepo.
COPY --from=contratslib --chown=node:node . /contrats/lib
COPY --from=bridge --chown=node:node . /document-parsing/bridge
COPY --from=schemas --chown=node:node . /document-parsing/schemas
COPY --from=fixtures --chown=node:node date_mission.json /document-parsing/fixtures/date_mission.json
COPY --from=modeles --chown=node:node catalogue.json catalogue.js /document-parsing/models/
COPY --from=auth --chown=node:node . /auth

# /contrats/lib requiert pdf-parse : ses modules npm sont ceux de /app.
ENV NODE_PATH=/app/node_modules
ENV NODE_ENV=production
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4600

# Pieces deposees : volume nomme monte sur /app/data (jamais dans l'image ni dans les journaux).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4600)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
