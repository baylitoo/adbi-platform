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
#   - `_converter` (singleton DocumentConverter Docling, chargé une fois en
#     tâche de fond au démarrage — import mesuré à ~59 s) : le charger dans
#     plusieurs process multiplierait le temps de démarrage ET l'empreinte
#     mémoire par worker, potentiellement lourde (voir factory/modules.docker.
#     json : "delai": 90 pour cv-parser, le préchauffage Docling à lui seul).
#   - `PROGRESSION_ANALYSES` (barre de progression de /api/upload) : un
#     sondage qui atterrit sur un autre worker que celui qui traite l'upload
#     ne verrait jamais l'avancement.
# Plusieurs workers Gunicorn (processus séparés, prefork) casseraient donc
# silencieusement ces trois choses. Un seul worker avec plusieurs threads
# (`gthread`) reproduit le modèle actuel à l'identique (même mémoire de
# process) tout en bénéficiant d'un vrai serveur de production : pool de
# connexions, purge des clients lents, plus de débogueur exposable.
worker_class = "gthread"
workers = 1
# `app.run(threaded=True)` n'imposait AUCUNE limite au nombre de threads
# concurrents (un par requête reçue) ; en fixer 4 ici est déjà plus prudent,
# tout en restant confortable pour l'usage réel (dépôts de CV en rafale rares).
threads = int(os.environ.get("ADBI_GUNICORN_THREADS", "4"))

# Ne PAS activer `preload_app` : le thread de préchauffage Docling
# (`threading.Thread(target=_init_converter, ...)` à l'import d'app.py) doit
# démarrer APRÈS le fork, dans le worker qui servira les requêtes — avec
# preload_app=True il démarrerait dans le master et ne survivrait pas au fork.

# ── Timeout ────────────────────────────────────────────────────────────────
# Avec un worker `gthread`, `timeout` n'interrompt PAS une requête lente en
# tant que telle (le worker notifie l'arbiter indépendamment de chaque
# thread de requête) : le vrai risque couvert ici est qu'une extension C
# (Docling/torch, pendant l'extraction ou l'inférence) garde le GIL assez
# longtemps pour bloquer cette notification et faire tuer le worker en plein
# traitement — perdant une analyse en cours. Une analyse complète enchaîne
# extraction Docling + appel(s) LLM : jusqu'à 75 s de budget de cascade
# (app.py::llm_parse_cv) pour le parsing initial, jusqu'à 120 s pour un appel
# de rapprochement — largement au-dessus du défaut Gunicorn (30 s). D'où une
# marge large plutôt qu'un réglage au plus juste.
timeout = int(os.environ.get("ADBI_GUNICORN_TIMEOUT", "240"))
graceful_timeout = timeout

# Bug connu de Gunicorn en conteneur : le fichier de battement de cœur du
# worker sur un `/tmp` en overlay (fréquent sous Docker) peut provoquer des
# faux positifs de timeout. `/dev/shm` (tmpfs) l'évite.
worker_tmp_dir = "/dev/shm"

accesslog = "-"
errorlog = "-"
