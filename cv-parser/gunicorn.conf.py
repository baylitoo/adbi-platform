"""Configuration Gunicorn pour cv-parser (usage conteneur — voir Dockerfile).

Le serveur de développement Flask (`app.run(...)`) n'est pas conçu pour la
production : sa propre documentation le dit explicitement — pas de pool de
process, pas de protection contre un client lent qui garde une connexion
ouverte (slowloris), et son débogueur interactif est un vecteur de RCE connu
si jamais exposé sur le réseau. `python app.py` reste le chemin de
développement local (voir app.py::__main__) ; l'image Docker lance
maintenant Gunicorn directement sur le module (`app:app`).

Bind — mêmes variables que app.py::__main__
---------------------------------------------
`ADBI_HOTE` et `PORT` restent la seule source de vérité pour l'adresse
d'écoute, pour ne jamais désynchroniser le chemin local et le chemin
conteneur. Défaut à 127.0.0.1 (poste local, jamais exposé par accident) —
c'est le Dockerfile qui pose `ENV ADBI_HOTE=0.0.0.0`, pas ce fichier.
"""
import os

hote = os.environ.get("ADBI_HOTE", "127.0.0.1")
port = os.environ.get("PORT", "5000")
bind = f"{hote}:{port}"

# ── Un seul worker (process), plusieurs threads ───────────────────────────────
# cv-parser garde plusieurs états globaux en mémoire de PROCESS, partagés
# entre les requêtes du même worker threadé jusqu'ici (`app.run(...,
# threaded=True)`) :
#   - `_verrous_cv` (verrou par fiche CV, issue #53/PR #54) : sans mémoire
#     partagée, deux workers Gunicorn pourraient à nouveau écraser la fiche
#     l'un de l'autre — exactement le "lost update" que PR #54 a corrigé.
#   - `PROGRESSION_ANALYSES` (barre de progression de /api/upload) : un
#     sondage qui atterrit sur un autre worker que celui qui traite l'upload
#     ne verrait jamais l'avancement.
# Plusieurs workers Gunicorn (processus séparés, prefork) casseraient donc
# silencieusement ces deux choses. Un seul worker avec plusieurs threads
# (`gthread`) reproduit le modèle actuel à l'identique (même mémoire de
# process) tout en bénéficiant d'un vrai serveur de production : pool de
# connexions, purge des clients lents, plus de débogueur exposable.
worker_class = "gthread"
workers = 1
# `app.run(threaded=True)` n'imposait AUCUNE limite au nombre de threads
# concurrents (un par requête reçue) ; en fixer 4 ici est déjà plus prudent,
# tout en restant confortable pour l'usage réel (dépôts de CV en rafale rares).
threads = int(os.environ.get("ADBI_GUNICORN_THREADS", "4"))

# Les connexions PostgreSQL doivent être ouvertes dans le worker, après fork.
preload_app = False

# Le délai d'extraction est borné par DOCIE_TIMEOUT_SECONDS dans le client.
# Le heartbeat Gunicorn reste indépendant des requêtes HTTP longues.
timeout = int(os.environ.get("ADBI_GUNICORN_TIMEOUT", "240"))
graceful_timeout = timeout

# Bug connu de Gunicorn en conteneur : le fichier de battement de cœur du
# worker sur un `/tmp` en overlay (fréquent sous Docker) peut provoquer des
# faux positifs de timeout. `/dev/shm` (tmpfs) l'évite.
worker_tmp_dir = "/dev/shm"

accesslog = "-"
errorlog = "-"
