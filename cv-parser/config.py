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

# ── Fichiers de stockage ──────────────────────────────────────────────────────
USERS_FILE   = DATA_DIR / "users.json"
TOKENS_FILE  = DATA_DIR / "tokens.json"
DB_FILE      = DATA_DIR / "adbi.db"     # SQLite pour besoins + matching
INVITES_FILE = DATA_DIR / "invites.json"

# ── Fichiers existants (compatibilité) ────────────────────────────────────────
CV_DB_FILE = BASE_DIR / "cv_database.json"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# ── Premier lancement ─────────────────────────────────────────────────────────
#
# Identifiants du superuser créé si data/users.json est vide (voir
# core/auth.py, ensure_default_superuser). Le mot de passe par défaut n'a de
# sens qu'en développement local (poste, ADBI_AUTH=off) : le poser explicitement
# via variable d'environnement avant toute exposition Internet.
DEFAULT_SUPERUSER_EMAIL    = os.environ.get("ADBI_SUPERUSER_EMAIL") or "admin@adbi.fr"
DEFAULT_SUPERUSER_PASSWORD = os.environ.get("ADBI_SUPERUSER_PASSWORD") or "Adbi2025!"

# ── LLM ───────────────────────────────────────────────────────────────────────
#
# OpenAI et OpenRouter ont été retirés le 2026-08-13 : leurs clés vivaient en
# clair dans ce fichier, OpenAI était facturé, et aucun des deux n'est hébergé
# en Union européenne — or un CV est une donnée personnelle. Ne pas les
# réintroduire ici : le fichier n'est pas un coffre.
#
# Seul reste OVHcloud AI Endpoints : hébergé en UE, sans clé ni inscription,
# rétention zéro et aucune utilisation des données pour l'entraînement. Le
# choix du modèle ne se fait plus ici mais dans la chaîne de secours
# (`llm_cascade.py`, écran Paramètres) : six modèles essayés dans l'ordre.

OVH_URL   = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions"
OVH_MODEL = "Mistral-Small-3.2-24B-Instruct-2506"

PROVIDERS = ("ovh",)

_llm_prov_file  = DATA_DIR / "llm_provider.txt"
_llm_model_file = DATA_DIR / "llm_model.txt"          # ancien format, migré
_llm_model_files = {
    "ovh": DATA_DIR / "llm_model_ovh.txt",
}

_DEFAUTS = {
    "ovh": {"url": OVH_URL, "key": "", "model": OVH_MODEL},
}


def modele_coherent(provider: str, model: str) -> bool:
    """
    Le modèle appartient-il au fournisseur ?

    Il ne reste qu'OVHcloud, dont les identifiants n'ont jamais de barre
    oblique — celle-ci signalait un modèle OpenRouter (« openai/gpt-oss:free »).
    Le contrôle empêche donc de ressaisir un ancien identifiant qui ferait
    répondre 400 à chaque requête.
    """
    if not model:
        return False
    return "/" not in model


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
    provider = "ovh"
    if _llm_prov_file.exists():
        provider = _llm_prov_file.read_text().strip() or "ovh"
    if provider not in PROVIDERS:
        # Ancien réglage pointant vers un fournisseur retiré : on retombe sur
        # le seul restant plutôt que de lever une erreur au démarrage.
        provider = "ovh"

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
    provider = provider if provider in PROVIDERS else "ovh"
    _llm_prov_file.write_text(provider)

    refus = None
    if model:
        if modele_coherent(provider, model):
            _llm_model_files[provider].write_text(model)
        else:
            refus = (f"Le modèle « {model} » n'est pas un modèle OVHcloud : "
                     "il en faut un sans barre oblique, "
                     "par exemple « Mistral-Small-3.2-24B-Instruct-2506 ».")

    return {"provider": provider, "model": get_active_llm()["model"], "refus": refus}

# Longueur de CV envoyée au modèle.
#
# 8 000 caractères représentent environ trois pages : sur un CV de 34 pages,
# tout le reste était perdu — mesuré, une seule expérience extraite au lieu
# d'une dizaine. Le gain de vitesse ne valait pas cette perte. 24 000 (~7 000
# jetons) reste très en deçà des 128 000 de contexte des modèles utilisés.
MAX_LLM_CHARS = 24_000
