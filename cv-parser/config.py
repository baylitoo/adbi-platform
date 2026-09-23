"""config.py — Configuration centralisée ADBI CV Parser"""
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# ── JWT ───────────────────────────────────────────────────────────────────────
_secret_file = DATA_DIR / "jwt_secret.txt"
if _secret_file.exists():
    JWT_SECRET = _secret_file.read_text().strip()
else:
    JWT_SECRET = os.environ.get("ADBI_JWT_SECRET") or secrets.token_hex(32)
    _secret_file.write_text(JWT_SECRET)

JWT_ALGORITHM              = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60        # 1 heure
REFRESH_TOKEN_EXPIRE_DAYS   = 7

# ── Portee du cookie de session (issue #245, serie controle d'acces) ──────────
#
# VIDE = comportement actuel, a l'octet : le cookie reste "host-only", il n'est
# renvoye qu'a cv-parser. C'est le defaut, et un deploiement qui ne pose jamais
# cette variable ne doit rien voir changer.
#
# Posee (ex. "outils.adbi.fr") : le cookie devient valable pour les
# sous-domaines de ce domaine, ce qui permet aux autres services ADBI de
# VERIFIER le jeton emis ici -- cv-parser reste le seul emetteur d'identite.
#
# A ne jamais poser a un suffixe public ni au-dessus : le navigateur refuserait
# le cookie. Sur les domaines Coolify actuels (*.sslip.io, absent de la Public
# Suffix List) la valeur utile est "<ip-du-serveur>.sslip.io" -- mais le cookie y
# est alors visible par tout hote servi sous ce suffixe. Voir #253 : la bascule
# vers un vrai domaine referme exactement cette exposition, et ne coute que le
# changement de CETTE variable.
COOKIE_DOMAIN = os.environ.get("ADBI_COOKIE_DOMAIN", "").strip()

# URL publique du hub (ADBI Factory), ex. "https://outils.adbi.fr".
#
# Sert UNIQUEMENT a valider le `next` de /login : sans liste blanche, un
# parametre de redirection sur une page de connexion est une redirection
# ouverte -- l'endroit le plus dangereux pour en avoir une, puisque la victime
# vient justement d'y taper son mot de passe. Vide = aucun `next` n'est
# accepte, on retombe sur "/".
FACTORY_URL = os.environ.get("ADBI_FACTORY_URL", "").strip().rstrip("/")

# ── Stockage ──────────────────────────────────────────────────────────────────
# users.json/tokens.json/invites.json/adbi.db (SQLite)/cv_database.json ont
# disparu avec la bascule PostgreSQL (issue #15, PR B) — voir core/pg.py,
# core/auth_pg.py, core/database_pg.py, core/cvstore_pg.py, core/activity_pg.py.
# DATABASE_URL est désormais requise (core/pg.py::database_url lève sinon).
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# ── Premier lancement ─────────────────────────────────────────────────────────
#
# Identifiants du superuser créé si la table users (PostgreSQL) est vide
# (voir core/auth.py::ensure_default_superuser). Le mot de passe par défaut n'a de
# sens qu'en développement local (poste, ADBI_AUTH=off) : le poser explicitement
# via variable d'environnement avant toute exposition Internet.
DEFAULT_SUPERUSER_EMAIL    = os.environ.get("ADBI_SUPERUSER_EMAIL") or "admin@adbi.fr"
DEFAULT_SUPERUSER_PASSWORD = os.environ.get("ADBI_SUPERUSER_PASSWORD") or "Adbi2025!"

# ── Anti brute-force (POST /api/auth/login) ──────────────────────────────────
#
# Jusqu'ici, aucune limite : ni compteur d'échecs, ni délai, ni verrouillage.
# bcrypt ralentit chaque vérification (~100 ms) mais ça ne freine pas un
# attaquant qui envoie ses tentatives en parallèle (jusqu'à
# ADBI_GUNICORN_THREADS=4 à la fois, voir gunicorn.conf.py) — un mot de passe
# faible, ou le mot de passe par défaut ci-dessus si ADBI_SUPERUSER_PASSWORD
# n'a jamais été posée, restait devinable en continu, sans jamais déclencher
# le moindre frein côté serveur. Voir api/auth_bp.py::_trop_de_tentatives.
LOGIN_MAX_ECHECS = int(os.environ.get("ADBI_LOGIN_MAX_ECHECS", "10"))
LOGIN_FENETRE_S  = int(os.environ.get("ADBI_LOGIN_FENETRE_S", "300"))  # 5 min

# ── LLM ───────────────────────────────────────────────────────────────────────
#
# OpenAI et OpenRouter ont été retirés le 2026-08-13 : leurs clés vivaient en
# clair dans ce fichier, OpenAI était facturé, et aucun des deux n'est hébergé
# en Union européenne — or un CV est une donnée personnelle. OVHcloud AI
# Endpoints (UE, sans clé) les avait remplacés ; il est à son tour retiré au
# profit de la passerelle d'inférence auto-hébergée ADBI : mêmes garanties de
# confidentialité, sous notre contrôle direct. Ne réintroduire aucun
# fournisseur tiers ici — le fichier n'est pas un coffre.
#
# Base URL + clé posées par variable d'environnement, jamais en dur. Le choix
# du modèle ne se fait pas ici mais dans la chaîne de secours
# (`llm_cascade.py`, écran Paramètres).
LLM_BASE_URL = os.environ.get("ADBI_LLM_BASE_URL", "").rstrip("/")
LLM_API_KEY  = os.environ.get("ADBI_LLM_API_KEY", "")
LLM_MODEL    = os.environ.get("ADBI_LLM_MODEL", "")


# Longueur de CV envoyée au modèle.
#
# 8 000 caractères représentent environ trois pages : sur un CV de 34 pages,
# tout le reste était perdu — mesuré, une seule expérience extraite au lieu
# d'une dizaine. Le gain de vitesse ne valait pas cette perte. 24 000 (~7 000
# jetons) reste très en deçà des 128 000 de contexte des modèles utilisés.
MAX_LLM_CHARS = 24_000

# ── Bornes sur les besoins clients (api/needs_bp.py) ─────────────────────────
#
# `core/matcher.py::run_matching` relit CHAQUE champ texte du besoin pour
# CHAQUE CV de la CVthèque (SequenceMatcher, correspondance de mots-clés par
# sous-chaîne...) : un besoin sans borne haute transforme
# POST /api/needs/<id>/match en calcul CPU non borné (issue #72). Mesuré
# (50 CV synthétiques, run_matching appelé directement) :
#   titre normal (25 car., 3 compétences)        ->   0,05 s
#   titre de ~118 000 caractères                 ->   6,7 s
#   titre de ~500 000 caractères                 ->  29,2 s
#   5 000 required_skills (aucune ne matche)     -> 220,6 s
# cv-parser tourne en un seul worker Gunicorn (gthread) : un tel calcul garde
# le GIL et bloque de fait tout le process pendant son exécution.
NEED_SHORT_MAX = int(os.environ.get("ADBI_NEED_SHORT_MAX", "300"))
# title, seniority, location, remote, contract_type, budget, start_date

NEED_TEXT_MAX = int(os.environ.get("ADBI_NEED_TEXT_MAX", "20000"))
# context, notes, raw_text, client, sector — une vraie fiche de poste tient
# large dans cette limite (comparer à MATCHING_OFFRE_MAX = 40000 côté one-pager).

NEED_LIST_MAX = int(os.environ.get("ADBI_NEED_LIST_MAX", "60"))
# nombre d'entrées : required_skills, bonus_skills, languages

NEED_ITEM_MAX = int(os.environ.get("ADBI_NEED_ITEM_MAX", "100"))
# longueur (caractères) de chaque entrée de ces listes

# Concurrence du matching : garder des threads libres pour les autres routes.
# Définition restaurée depuis le correctif #94, perdue lors des fusions.
MATCHING_MAX_CONCURRENT = int(os.environ.get("ADBI_MATCHING_MAX_CONCURRENT", "2"))

# ── Bornes sur les fiches CV (api/cvs, POST /api/cvs et PATCH /api/cvs/<id>) ─
#
# Même risque que #72, dans l'autre sens : core/matcher.py::_score_skills
# compare CHAQUE compétence requise du besoin (bornée à NEED_LIST_MAX par
# #72) à CHAQUE compétence du candidat (SequenceMatcher par paire) — mais
# candidate_skills (dérivé de `skills` via skills_normalizer.skills_to_flat,
# qui aplatit `skills[].items`) n'a jamais été borné côté écriture :
# POST /api/cvs n'avait aucune validation, PATCH /api/cvs/<id> vérifie le
# TYPE des champs (issue #82) mais pas leur taille. Mesuré (run_matching
# appelé directement, 20 CV normaux + 1 CV empoisonné, need à 5
# required_skills) :
#   skills normal (3-5 compétences)         ->  0,005 s (vivier entier)
#   1 CV avec 20 000 items dans `skills`    ->  0,79 s
#   1 CV avec 150 000 items dans `skills`   ->  8,6 s
#   1 CV avec 400 000 items dans `skills`   -> 24,0 s
# (un corps JSON de 400 000 items tient sous ~5 Mo, largement sous
# MAX_CONTENT_LENGTH = 20 Mo) — issue #98. Plafonds choisis très au-dessus de
# ce qu'une carrière réelle produit (aucune fiche de la CVthèque de
# développement ne s'en approche) : le coût mesuré à ces valeurs reste
# négligeable (500 items ~ 0,02 s d'après la mesure ci-dessus), la marge sert
# uniquement à ne jamais gêner une édition manuelle légitime depuis l'écran
# CV (cv_detail.html::collectData renvoie la fiche ENTIÈRE à chaque
# sauvegarde, pas seulement le champ modifié).
CV_LIST_MAX = int(os.environ.get("ADBI_CV_LIST_MAX", "300"))
# nombre d'entrées : experience, education, languages, certifications, interests

CV_SKILLS_FLAT_MAX = int(os.environ.get("ADBI_CV_SKILLS_FLAT_MAX", "500"))
# nombre total de compétences après aplatissement (skills_normalizer.skills_to_flat)
