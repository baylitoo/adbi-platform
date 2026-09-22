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
COPY --chown=node:node . .
COPY --chown=node:node modules.docker.json modules.json

# Bibliotheque de verification des jetons ADBI (auth/auth-adbi.js, #247),
# partagee avec les autres services Node et donc HORS du contexte ./factory :
# elle arrive par `additional_contexts: auth` (voir docker-compose.yml), comme
# le pont DocIE arrive chez contrats. Aucune dependance npm ajoutee -- la
# bibliotheque n'en a aucune, c'est ce qui permet a factory de garder les
# siennes a zero.
COPY --from=auth --chown=node:node . /auth
# Pont DocIE partage (additional_contexts: bridge) : le hub liste le store DocIE.
COPY --from=bridge --chown=node:node . /document-parsing/bridge

ENV NODE_ENV=production
# Sans ca, server.js lie 127.0.0.1 (defaut poste de dev) : injoignable via le
# port publie du conteneur malgre "-p 4000:4000" (voir server.js).
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4000

# Ne jamais tourner en root dans le conteneur (issue #136) : node:22-bookworm-slim
# fournit deja l'utilisateur non-privilegie "node" (uid 1000).
RUN chown -R node:node /app
USER node

# Sonde `/api/sante` et NON `/` : depuis que le hub exige une session (#245),
# `/` repond 401 a une requete sans cookie -- ce que `r.ok` traite comme un
# echec, donc Coolify redemarrerait le conteneur en boucle. Les quatre autres
# services sondent deja `/api/sante` ; factory etait le seul a sonder `/`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.ADBI_PORT||4000)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
