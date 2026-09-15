# CV Parser : client DocIE et exports, sans runtime OCR/ML local.
FROM python:3.14-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Bridge DocIE partagé (issue #151, #150/#155) : contexte de build additionnel
# pointant vers document-parsing/bridge/ (voir docker-compose*.yml,
# additional_contexts: bridge). Copié uniquement au build, jamais dupliqué
# dans ce dépôt module — document-parsing/bridge/README.md reste la source
# unique. Utilisé seulement si DOCIE_EXTRACTION_ENABLED=true (docie_bridge_
# extraction.py) ; absent, le client DocIE historique (docie_client.py)
# reste le chemin par défaut.
COPY --from=bridge docie_bridge.py .
# Table de synonymes de compétences partagée avec one-pager (#177 lignes G/H) :
# contexte de build additionnel `fixtures` (document-parsing/fixtures/, voir
# docker-compose*.yml). skills_normalizer.py la lit AU CHARGEMENT DU MODULE, et
# app.py l'importe au démarrage : sans cette ligne, le service ne démarre pas.
# UN SEUL fichier, pas le dossier (fixtures/ contient aussi des CV d'exemple).
# Même chemin que dans le dépôt, relatif au module : /app/.. -> /document-parsing/.
COPY --from=fixtures competences_synonymes.json /document-parsing/fixtures/competences_synonymes.json
# Catalogue des modèles par action (#194) : contexte de build additionnel
# `modeles` (document-parsing/models/, voir docker-compose*.yml). choix_modele.py
# charge /document-parsing/models/catalogue.py par son chemin (même profondeur
# relative que dans le dépôt), qui lit catalogue.json à côté de lui. Lu à
# l'appel : sans ces fichiers le service démarre et le dépôt sans choix
# fonctionne, mais aucun modèle n'est proposé (message à l'écran) et un choix
# échoue. Les deux fichiers seulement : tests/ n'a rien à faire dans l'image.
COPY --from=modeles catalogue.json catalogue.py /document-parsing/models/

ENV PYTHONUNBUFFERED=1
ENV ADBI_HOTE=0.0.0.0
EXPOSE 5000

RUN useradd -r -u 1000 -m -d /home/adbi adbi \
    && mkdir -p /app/data /app/uploads /app/cv_output \
    && chown -R adbi:adbi /app /home/adbi
USER adbi

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','5000')+'/api/sante', timeout=4)" || exit 1

CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
