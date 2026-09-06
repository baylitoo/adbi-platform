"""api/auth_bp.py — Routes d'authentification JWT."""
import threading
import time
from datetime import timezone, datetime

from flask import Blueprint, jsonify, request, make_response, redirect

from config import (
    ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS,
    LOGIN_MAX_ECHECS, LOGIN_FENETRE_S,
)
from core.activity_pg import log_event
from core.auth import (
    get_user_by_email, get_user_by_id, list_users,
    create_user, update_user, delete_user,
    verify_password, verify_refresh_token,
    create_access_token, create_refresh_token,
    revoke_refresh_token, revoke_all_user_tokens,
    require_auth, require_superuser, get_current_user,
)

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


# ── Anti brute-force ──────────────────────────────────────────────────────────
#
# cv-parser tourne en un seul worker Gunicorn, plusieurs threads (voir
# gunicorn.conf.py) : un compteur en mémoire de process suffit, comme
# `_verrous_cv` (app.py) — mais comme lui, il lui faut son propre verrou :
# plusieurs threads peuvent lire/modifier ce dict en même temps (deux
# tentatives de connexion concurrentes), et un accès non protégé pouvait
# lever un KeyError (clé purgée par un thread pendant qu'un autre la lisait)
# qui tombait dans le filet Exception général (voir app.py::handle_exception)
# et renvoyait un 500 exposant la clé (IP + e-mail) au client.
#
# Clé (IP, e-mail) plutôt qu'e-mail seul : verrouiller sur l'e-mail seul
# permettrait à n'importe qui de bloquer le compte d'un tiers rien qu'en
# connaissant son adresse. En déploiement (derrière le reverse proxy Coolify,
# voir docs/deploiement-coolify.md), request.remote_addr est l'IP du proxy
# pour toutes les requêtes tant qu'aucun ProxyFix ne lit X-Forwarded-For —
# absent ici, et volontairement pas ajouté : cet en-tête est fourni par le
# client et se falsifie, ce qui rendrait la limite contournable à volonté. La
# clé se réduit donc en pratique à l'e-mail dans ce cas ; le compromis reste
# préférable à une absence totale de limite.
_echecs_login: dict[str, list[float]] = {}
_echecs_login_verrou = threading.Lock()


def _cle_login(ip: str, email: str) -> str:
    # Email tronqué : un attaquant qui ferait varier une chaîne arbitraire à
    # chaque tentative ne doit pas pouvoir faire grossir ce dict sans borne.
    return f"{ip}|{email.strip().lower()[:200]}"


def _trop_de_tentatives(ip: str, email: str) -> bool:
    """True si (ip, email) a atteint LOGIN_MAX_ECHECS échecs dans la fenêtre."""
    cle = _cle_login(ip, email)
    maintenant = time.time()
    with _echecs_login_verrou:
        horodatages = [t for t in _echecs_login.get(cle, []) if maintenant - t < LOGIN_FENETRE_S]
        if horodatages:
            _echecs_login[cle] = horodatages
        else:
            _echecs_login.pop(cle, None)
        return len(horodatages) >= LOGIN_MAX_ECHECS


def _enregistrer_echec(ip: str, email: str) -> None:
    cle = _cle_login(ip, email)
    with _echecs_login_verrou:
        _echecs_login.setdefault(cle, []).append(time.time())
        # Garde-fou mémoire : un attaquant qui ferait varier l'e-mail à
        # chaque tentative pourrait sinon faire grossir ce dict indéfiniment.
        # Purge large (pas par clé) plutôt qu'un compteur exact — suffisant
        # ici, comme le repli sur fichier vide de factory/server.js
        # (JOURNAL_MAX_OCTETS).
        if len(_echecs_login) > 5000:
            maintenant = time.time()
            for autre_cle in list(_echecs_login):
                if all(maintenant - t >= LOGIN_FENETRE_S for t in _echecs_login[autre_cle]):
                    _echecs_login.pop(autre_cle, None)


def _oublier_echecs(ip: str, email: str) -> None:
    with _echecs_login_verrou:
        _echecs_login.pop(_cle_login(ip, email), None)


def _set_cookies(resp, access_token: str, refresh_token: str):
    resp.set_cookie(
        "adbi_access", access_token,
        httponly=True, samesite="Lax", max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    resp.set_cookie(
        "adbi_refresh", refresh_token,
        httponly=True, samesite="Lax", max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/api/auth/refresh",
    )
    return resp


def _clear_cookies(resp):
    resp.delete_cookie("adbi_access",  path="/")
    resp.delete_cookie("adbi_refresh", path="/api/auth/refresh")
    return resp


# ── Login ─────────────────────────────────────────────────────────────────────
@auth_bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    email    = (body.get("email") or "").strip()
    password = body.get("password") or ""
    ip       = request.remote_addr or "?"

    if not email or not password:
        return jsonify({"error": "Email et mot de passe requis"}), 400

    if _trop_de_tentatives(ip, email):
        return jsonify({
            "error": "Trop de tentatives — réessayez dans quelques minutes.",
        }), 429

    user = get_user_by_email(email)
    if not user or not verify_password(password, user.get("password_hash", "")):
        _enregistrer_echec(ip, email)
        return jsonify({"error": "Identifiants invalides"}), 401
    if not user.get("is_active", True):
        return jsonify({"error": "Compte désactivé"}), 403

    _oublier_echecs(ip, email)
    access  = create_access_token(user)
    refresh = create_refresh_token(user)
    public  = {k: v for k, v in user.items() if k != "password_hash"}

    log_event("login", user["id"], user["email"], {"ip": request.remote_addr})

    resp = make_response(jsonify({
        "access_token": access,
        "token_type":   "bearer",
        "expires_in":   ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user":         public,
    }))
    return _set_cookies(resp, access, refresh)


# ── Refresh ───────────────────────────────────────────────────────────────────
@auth_bp.post("/refresh")
def refresh():
    token = request.cookies.get("adbi_refresh") or (request.get_json(silent=True) or {}).get("refresh_token")
    if not token:
        return jsonify({"error": "Refresh token manquant"}), 401

    payload = verify_refresh_token(token)
    if not payload:
        return jsonify({"error": "Refresh token invalide ou expiré"}), 401

    user = get_user_by_id(payload["sub"])
    if not user or not user.get("is_active", True):
        return jsonify({"error": "Utilisateur introuvable ou désactivé"}), 401

    # Rotation : révoque l'ancien, crée un nouveau
    revoke_refresh_token(payload["jti"])
    new_access  = create_access_token(user)
    new_refresh = create_refresh_token(user)

    resp = make_response(jsonify({
        "access_token": new_access,
        "expires_in":   ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }))
    return _set_cookies(resp, new_access, new_refresh)


# ── Logout ────────────────────────────────────────────────────────────────────
@auth_bp.post("/logout")
def logout():
    token = request.cookies.get("adbi_refresh")
    if token:
        payload = verify_refresh_token(token)
        if payload:
            revoke_refresh_token(payload["jti"])
    resp = make_response(jsonify({"ok": True}))
    return _clear_cookies(resp)


# ── Me ────────────────────────────────────────────────────────────────────────
@auth_bp.get("/me")
@require_auth
def me():
    u = get_current_user()
    return jsonify(u)


# ── Register (superuser only) ─────────────────────────────────────────────────
@auth_bp.post("/register")
@require_superuser
def register():
    body = request.get_json(silent=True) or {}
    try:
        user = create_user(
            email=body.get("email", ""),
            password=body.get("password", ""),
            role=body.get("role", "user"),
            full_name=body.get("full_name", ""),
        )
        return jsonify(user), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ── List users (superuser only) ───────────────────────────────────────────────
@auth_bp.get("/users")
@require_superuser
def get_users():
    return jsonify(list_users())


# ── Update user (superuser only) ──────────────────────────────────────────────
@auth_bp.patch("/users/<user_id>")
@require_superuser
def patch_user(user_id: str):
    body = request.get_json(silent=True) or {}
    try:
        user = update_user(user_id, body)
        return jsonify(user)
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 404 if "introuvable" in str(e) else 400


# ── Delete user (superuser only) ──────────────────────────────────────────────
@auth_bp.delete("/users/<user_id>")
@require_superuser
def remove_user(user_id: str):
    current = get_current_user()
    if current and current["sub"] == user_id:
        return jsonify({"error": "Impossible de supprimer votre propre compte"}), 400
    try:
        delete_user(user_id)
        return jsonify({"ok": True})
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
