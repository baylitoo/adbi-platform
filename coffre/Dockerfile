# ADBI Coffre — image Docker
# Build : docker build -t adbi-coffre .
# Run   : docker run -p 4300:4300 -v "$(pwd)/data:/app/data" adbi-coffre
#
# Aucune dépendance npm (crypto/zlib/zip natifs, pdfjs/pdf-lib embarqués dans
# public/lib) : pas d'étape d'installation, juste le code.
FROM node:22-bookworm-slim

WORKDIR /app
COPY --chown=node:node . .

ENV NODE_ENV=production
# Sans ca, server.js lie 127.0.0.1 (defaut poste de dev) : injoignable via le
# port publie du conteneur malgre "-p 4300:4300" (voir server.js).
ENV ADBI_HOTE=0.0.0.0
EXPOSE 4300

# Ne jamais tourner en root dans le conteneur (issue #136) : node:22-bookworm-slim
# fournit deja l'utilisateur non-privilegie "node" (uid 1000). /app/data est
# recree ici pour le cas sans bind-mount (build/test local) ; quand le volume
# hote existe deja (docker-compose.yml), chown -R ./coffre/data vers 1000:1000
# avant le premier demarrage sur un hote deja provisionne en root.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# data/cle-locale.bin est monté en volume : SA PERTE REND IRRÉCUPÉRABLES tous
# les documents "protégés" émis (voir README.md) — à sauvegarder comme les
# données, jamais régénéré comme un secret classique.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.ADBI_COFFRE_PORT||4300)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
