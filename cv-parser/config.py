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

PROVIDERS = ("interne",)

_llm_prov_file  = DATA_DIR / "llm_provider.txt"
_llm_model_file = DATA_DIR / "llm_model.txt"          # ancien format, migré
_llm_model_files = {
    "interne": DATA_DIR / "llm_model_interne.txt",
}

_DEFAUTS = {
    "interne": {"url": LLM_BASE_URL, "key": LLM_API_KEY, "model": LLM_MODEL},
}


def modele_coherent(provider: str, model: str) -> bool:
    """Le modèle appartient-il au fournisseur ? Un seul fournisseur reste ;
    seule une valeur non vide est exigée."""
    return bool(model)


def _ranger_anciens_fichiers():
    """
    Met de côté les réglages des fournisseurs retirés.

    Les fichiers `llm_provider.txt` / `llm_model*.txt` peuvent encore désigner
    « openai » ou un modèle OpenRouter : laissés en place, ils feraient choisir
    un fournisseur qui n'existe plus.
    """
    for fichier in (_llm_model_file, _llm_prov_file):
        try:
            if not fichier.exists():
                continue
            contenu = fichier.read_text().strip()
            if contenu and contenu not in PROVIDERS and "/" not in contenu and fichier is _llm_prov_file:
                pass  # valeur inattendue : traitée par le repli de get_active_llm
            # Renommé plutôt que supprimé : on garde une trace, et le rangement
            # ne peut pas se rejouer au prochain démarrage.
            if fichier is _llm_model_file or contenu not in PROVIDERS:
                fichier.rename(fichier.with_suffix(fichier.suffix + ".retire"))
        except Exception:
            pass  # un rangement raté ne doit jamais empêcher l'application de démarrer


_ranger_anciens_fichiers()


def get_active_llm() -> dict:
    """
    Config LLM active : {url, key, model, provider, modele_ignore}.

    `modele_ignore` porte le modèle enregistré qui a été écarté parce qu'il
    n'appartient pas au fournisseur actif — l'interface peut ainsi expliquer
    pourquoi ce n'est pas le modèle attendu qui est utilisé, au lieu de
    laisser l'utilisateur devant une erreur muette.
    """
    provider = "interne"
    if _llm_prov_file.exists():
        provider = _llm_prov_file.read_text().strip() or "interne"
    if provider not in PROVIDERS:
        # Ancien réglage pointant vers un fournisseur retiré : on retombe sur
        # le seul restant plutôt que de lever une erreur au démarrage.
        provider = "interne"

    defaut = _DEFAUTS[provider]
    model = defaut["model"]
    modele_ignore = None

    fichier = _llm_model_files[provider]
    if fichier.exists():
        enregistre = fichier.read_text().strip()
        if enregistre:
            if modele_coherent(provider, enregistre):
                model = enregistre
            else:
                modele_ignore = enregistre

    return {
        "url": defaut["url"],
        "key": defaut["key"],
        "model": model,
        "provider": provider,
        "modele_ignore": modele_ignore,
    }


def set_active_llm(provider: str, model: str = "") -> dict:
    """
    Change le fournisseur actif, et son modèle si un modèle est fourni.

    Renvoie {"provider", "model", "refus"} — `refus` est renseigné quand le
    modèle demandé n'appartient pas au fournisseur : il n'est alors PAS
    enregistré, pour ne pas reproduire la panne d'origine.
    """
    provider = provider if provider in PROVIDERS else "interne"
    _llm_prov_file.write_text(provider)

    refus = None
    if model:
        if modele_coherent(provider, model):
            _llm_model_files[provider].write_text(model)
        else:
            refus = f"Le nom de modèle ne peut pas être vide."

    return {"provider": provider, "model": get_active_llm()["model"], "refus": refus}

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
