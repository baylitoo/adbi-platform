# ADBI Parser — image Docker
# Build : docker build -t adbi-cv-parser .
# Run   : docker run -p 5000:5000 -v "$(pwd)/data:/app/data" -e ADBI_AUTH=on adbi-cv-parser
#
# Python 3.14 : la même version que le poste où l'application est développée
# et testée (voir factory/README.md — la 3.13 n'a pas toutes les dépendances
# de Docling). Premier lancement long : Docling télécharge ses modèles au
# RUNTIME, pas au build — prévoir un volume ou un temps de démarrage long au
# premier démarrage du conteneur.
FROM python:3.14-slim

WORKDIR /app

# Bibliothèques système requises par la chaîne de vision de Docling (OpenCV
# et consorts) — non couvertes par pip sur une image "slim".
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 0.0.0.0 : ni app.py ni gunicorn.conf.py ne le font PAR DÉFAUT (127.0.0.1,
# poste local) — voir gunicorn.conf.py (utilisé par le CMD ci-dessous) et
# app.py::__main__ (`python app.py` en local). Indispensable pour que le port
# publié par Docker atteigne le processus. ADBI_AUTH=on à poser explicitement
# au lancement (voir README) : volontairement PAS ici, pour ne jamais masquer
# un oubli avec une valeur par défaut qui semblerait sûre.
ENV PYTHONUNBUFFERED=1
ENV ADBI_HOTE=0.0.0.0
EXPOSE 5000

# Ne jamais tourner en root dans le conteneur (issue #136) : contrairement aux
# images node:*, python:3.14-slim n'a pas d'utilisateur applicatif tout prêt —
# on le crée ici. -m crée aussi son $HOME (/home/adbi) : Docling/HuggingFace y
# téléchargent leurs modèles au runtime (voir en-tête de ce fichier) sous
# $HOME/.cache — sans $HOME accessible en écriture, le thread de préchauffage
# (_init_converter, lancé en tâche de fond à l'import d'app.py) échoue
# silencieusement et chaque analyse de CV casse. /app/data, /app/uploads et
# /app/cv_output sont recrés ici pour le cas sans bind-mount (build/test
# local) ; quand les volumes hôte existent déjà (docker-compose.yml), chown -R
# ces dossiers vers 1000:1000 avant le premier démarrage sur un hôte déjà
# provisionné en root.
RUN useradd -r -u 1000 -m -d /home/adbi adbi \
    && mkdir -p /app/data /app/uploads /app/cv_output \
    && chown -R adbi:adbi /app /home/adbi
USER adbi

# /api/sante fait un vrai SELECT 1 contre PostgreSQL (voir core/pg.py::ping)
# — /api/status ne vérifie que la chaîne de passerelles LLM et restait vert
# même base injoignable (issue #88).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','5000')+'/api/sante', timeout=4)" || exit 1

# Serveur de production Gunicorn (issue #61 — le serveur de dev Flask n'est
# pas conçu pour être exposé) plutôt que `python app.py` : configuration dans
# gunicorn.conf.py (bind via ADBI_HOTE/PORT, un seul worker + threads, voir
# ce fichier pour le détail). `python app.py` reste disponible pour le
# développement local (hors Docker).
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
