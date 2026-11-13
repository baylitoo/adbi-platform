"""core/cynov_auth.py — Client du serveur d'authentification Cynov (Facturation) : connexion, rotation, déconnexion."""
from __future__ import annotations

import base64
import json

import requests

from config import CYNOV_AUTH_BASE_URL

DELAI_S = 15
_CHAMPS_IDENTIFIANT = ("login", "sub", "username", "preferred_username", "email")


class CynovIndisponible(RuntimeError):
    """Serveur Cynov non configuré, injoignable ou réponse inexploitable."""


class CynovRefus(RuntimeError):
    """Cynov a refusé : identifiants faux, session expirée ou révoquée."""


def configure() -> bool:
    return bool(CYNOV_AUTH_BASE_URL)


def _poster(route: str, corps: dict, jeton: str | None = None) -> dict:
    if not configure():
        raise CynovIndisponible("Connexion Cynov non configurée (CYNOV_AUTH_BASE_URL).")
    entetes = {"Content-Type": "application/json"}
    if jeton:
        entetes["Authorization"] = f"Bearer {jeton}"
    try:
        rep = requests.post(f"{CYNOV_AUTH_BASE_URL}{route}", json=corps, headers=entetes, timeout=DELAI_S)
    except requests.RequestException as exc:
        raise CynovIndisponible("Serveur d'authentification Cynov injoignable.") from exc
    if rep.status_code in (404, 405):
        raise CynovIndisponible(f"Aucune API d'authentification Cynov sur cette adresse (HTTP {rep.status_code}) : CYNOV_AUTH_BASE_URL doit inclure le préfixe d'application et la version.")
    if rep.status_code >= 500:
        raise CynovIndisponible(f"Serveur d'authentification Cynov en erreur (HTTP {rep.status_code}).")
    try:
        corps_rep = rep.json() if rep.content else {}
    except ValueError as exc:
        raise CynovIndisponible("Réponse illisible du serveur d'authentification Cynov.") from exc
    if rep.status_code >= 400:
        message = corps_rep.get("message") if isinstance(corps_rep, dict) else None
        raise CynovRefus(message or "Identifiants Cynov refusés.")
    return corps_rep if isinstance(corps_rep, dict) else {}


def _paire(corps: dict) -> dict:
    acces, rotation = corps.get("accessToken"), corps.get("refreshToken")
    if not isinstance(acces, str) or not acces or not isinstance(rotation, str) or not rotation:
        raise CynovIndisponible("Le serveur d'authentification Cynov n'a pas rendu de paire de jetons.")
    duree = corps.get("expiresIn")
    duree = int(duree) if isinstance(duree, (int, float)) and not isinstance(duree, bool) and duree > 0 else 1800
    return {"acces": acces, "rotation": rotation, "duree": duree, "identifiant": identifiant_du_jeton(acces)}


def identifiant_du_jeton(jeton: str) -> str | None:
    """Identifiant porté par un jeton Cynov, lu SANS vérifier la signature : seulement sur un jeton que Cynov vient de nous rendre."""
    parties = jeton.split(".")
    if len(parties) != 3:
        return None
    try:
        charge = json.loads(base64.urlsafe_b64decode(parties[1] + "=" * (-len(parties[1]) % 4)))
    except (ValueError, TypeError):
        return None
    if not isinstance(charge, dict):
        return None
    for champ in _CHAMPS_IDENTIFIANT:
        valeur = charge.get(champ)
        if isinstance(valeur, (str, int)) and not isinstance(valeur, bool) and str(valeur).strip():
            return str(valeur).strip()[:128]
    return None


def connecter(identifiant: str, mot_de_passe: str) -> dict:
    return _paire(_poster("/auth/login", {"login": identifiant, "password": mot_de_passe}))


def renouveler(jeton_rotation: str) -> dict:
    """Preuve que la session Cynov vit encore ; le jeton de rotation rendu remplace l'ancien, qui est mort."""
    return _paire(_poster("/auth/refresh", {"refreshToken": jeton_rotation}))


def deconnecter(jeton_rotation: str, jeton_acces: str | None) -> None:
    try:
        _poster("/auth/logout", {"refreshToken": jeton_rotation}, jeton_acces)
    except (CynovIndisponible, CynovRefus):
        pass


def changer_mot_de_passe(identifiant: str, ancien: str, nouveau: str) -> None:
    _poster("/auth/change-password", {"login": identifiant, "oldPassword": ancien, "newPassword": nouveau})
