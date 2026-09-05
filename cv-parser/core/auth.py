"""core/auth.py — Authentification JWT, stockage PostgreSQL (core/auth_pg.py).

Deux rôles : 'superuser' (accès total) et 'user' (accès standard).
Tokens : access (1h) + refresh (7j).

Bascule PostgreSQL (issue #15, PR B) : la logique JWT (encodage/décodage,
décorateurs Flask) reste ICI, inchangée — seul le stockage (utilisateurs,
refresh tokens) est délégué à core/auth_pg.py. get_user_by_id,
get_user_by_email, list_users, create_user, update_user, delete_user,
verify_password, store_refresh_token, is_refresh_token_valid,
revoke_refresh_token et revoke_all_user_tokens sont ré-exportées telles
quelles depuis core/auth_pg : tout le reste du code (api/*.py) continue de
faire `from core.auth import ...` sans changement.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone, timedelta
from functools import wraps

import jwt
from flask import g, jsonify, redirect, request

from config import (
    JWT_SECRET, JWT_ALGORITHM,
    ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS,
    DEFAULT_SUPERUSER_EMAIL, DEFAULT_SUPERUSER_PASSWORD,
)

# ── Stockage (PostgreSQL) — voir core/auth_pg.py ──────────────────────────────
from core.auth_pg import (
    get_user_by_id, get_user_by_email, list_users,
    create_user, update_user, delete_user, verify_password,
    store_refresh_token, is_refresh_token_valid,
    revoke_refresh_token, revoke_all_user_tokens,
)

__all__ = [
    "get_user_by_id", "get_user_by_email", "list_users",
    "create_user", "update_user", "delete_user", "verify_password",
    "create_access_token", "create_refresh_token",
    "verify_access_token", "verify_refresh_token",
    "revoke_refresh_token", "revoke_all_user_tokens",
    "ensure_default_superuser",
    "require_auth", "require_superuser", "get_current_user",
    "AUTH_ACTIVE",
]


# ── Gestion des tokens ────────────────────────────────────────────────────────

def create_access_token(user: dict) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub":       user["id"],
        "email":     user["email"],
        "role":      user["role"],
        "full_name": user.get("full_name", ""),
        "jti":       str(uuid.uuid4()),
        "iat":       now,
        "exp":       now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "type":      "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(user: dict) -> str:
    now = datetime.now(timezone.utc)
    jti = str(uuid.uuid4())
    exp = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub":  user["id"],
        "jti":  jti,
        "iat":  now,
        "exp":  exp,
        "type": "refresh",
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    store_refresh_token(jti, user["id"], exp)
    return token


def verify_access_token(token: str) -> dict | None:
    try:
        p = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return p if p.get("type") == "access" else None
    except jwt.PyJWTError:
        return None


def verify_refresh_token(token: str) -> dict | None:
    try:
        p = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if p.get("type") != "refresh":
            return None
        if not is_refresh_token_valid(p.get("jti")):
            return None
        return p
    except jwt.PyJWTError:
        return None


# ── Initialisation ────────────────────────────────────────────────────────────

def ensure_default_superuser():
    if not list_users():
        create_user(
            email=DEFAULT_SUPERUSER_EMAIL,
            password=DEFAULT_SUPERUSER_PASSWORD,
            role="superuser",
            full_name="Admin ADBI",
        )
        print(f"[AUTH] ✓ Superuser créé : {DEFAULT_SUPERUSER_EMAIL}  /  {DEFAULT_SUPERUSER_PASSWORD}")


# ── Helpers request ───────────────────────────────────────────────────────────

def _get_token() -> str | None:
    tok = request.cookies.get("adbi_access")
    if tok:
        return tok
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


def _is_api() -> bool:
    return request.path.startswith("/api/")


# ── Mode local sans authentification ──────────────────────────────────────────
#
# L'application tourne sur le poste (127.0.0.1) derrière ADBI Factory : on ne
# demande pas de mot de passe. Les contrôles restent écrits et sont réactivés
# en posant la variable d'environnement ADBI_AUTH=on — indispensable si
# l'application est un jour servie ailleurs qu'en local.

AUTH_ACTIVE = os.environ.get("ADBI_AUTH", "off").strip().lower() in (
    "on", "1", "true", "oui",
)

# Identité endossée quand l'authentification est désactivée. Elle reprend la
# forme d'un payload JWT : app.py, needs_bp et settings_bp lisent 'sub',
# 'email' et 'role'.
UTILISATEUR_LOCAL = {
    "sub": "local",
    "email": DEFAULT_SUPERUSER_EMAIL,
    "role": "superuser",
    "full_name": "Poste local",
    "jti": "local",
    "type": "access",
}


# ── Décorateurs Flask ─────────────────────────────────────────────────────────

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not AUTH_ACTIVE:
            g.current_user = UTILISATEUR_LOCAL
            return f(*args, **kwargs)
        token = _get_token()
        if not token:
            if _is_api():
                return jsonify({"error": "Non authentifié"}), 401
            return redirect("/login")
        payload = verify_access_token(token)
        if not payload:
            if _is_api():
                return jsonify({"error": "Token invalide ou expiré"}), 401
            return redirect("/login")
        user = get_user_by_id(payload["sub"])
        if not user or not user.get("is_active"):
            if _is_api():
                return jsonify({"error": "Compte désactivé"}), 403
            return redirect("/login")
        # Le rôle exposé aux routes vient de la base, pas du JWT : sinon un
        # utilisateur rétrogradé depuis 'superuser' garde les branches
        # "superuser voit tout" (ex. needs_bp.get_needs) tant que son ancien
        # token n'a pas expiré — voir issue #76.
        g.current_user = {**payload, "role": user.get("role", payload.get("role"))}
        return f(*args, **kwargs)
    return decorated


def require_superuser(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not AUTH_ACTIVE:
            g.current_user = UTILISATEUR_LOCAL
            return f(*args, **kwargs)
        token = _get_token()
        if not token:
            return jsonify({"error": "Non authentifié"}), 401
        payload = verify_access_token(token)
        if not payload:
            return jsonify({"error": "Token invalide ou expiré"}), 401
        # Le rôle et l'état actif doivent venir de la base, pas du JWT : un
        # superuser rétrogradé ou désactivé après émission du token ne doit
        # pas garder ses droits d'admin jusqu'à l'expiration de celui-ci
        # (jusqu'à ACCESS_TOKEN_EXPIRE_MINUTES) — voir issue #76.
        user = get_user_by_id(payload["sub"])
        if not user or not user.get("is_active"):
            return jsonify({"error": "Compte désactivé"}), 403
        if user.get("role") != "superuser":
            return jsonify({"error": "Accès réservé aux super-utilisateurs"}), 403
        g.current_user = payload
        return f(*args, **kwargs)
    return decorated


def get_current_user() -> dict | None:
    return getattr(g, "current_user", None)
