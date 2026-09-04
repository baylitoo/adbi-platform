"""core/auth.py — Authentification JWT avec stockage fichier JSON.

Deux rôles : 'superuser' (accès total) et 'user' (accès standard).
Tokens : access (1h) + refresh (7j) stockés dans data/tokens.json.
"""
from __future__ import annotations

import json
import os
import uuid
import threading
from datetime import datetime, timezone, timedelta
from functools import wraps
from pathlib import Path

import bcrypt
import jwt
from flask import g, jsonify, redirect, request

from config import (
    JWT_SECRET, JWT_ALGORITHM,
    ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS,
    USERS_FILE, TOKENS_FILE,
    DEFAULT_SUPERUSER_EMAIL, DEFAULT_SUPERUSER_PASSWORD,
)

_lock = threading.Lock()


# ── Utilitaires fichiers ───────────────────────────────────────────────────────

def _load(path: Path, default=None):
    if default is None:
        default = {}
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default


def _save(path: Path, data):
    with _lock:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)


# ── Gestion des utilisateurs ──────────────────────────────────────────────────

def load_users() -> dict:
    return _load(USERS_FILE)


def save_users(users: dict):
    _save(USERS_FILE, users)


def get_user_by_id(user_id: str) -> dict | None:
    return load_users().get(user_id)


def get_user_by_email(email: str) -> dict | None:
    for u in load_users().values():
        if u.get("email", "").lower() == email.lower():
            return u
    return None


def list_users() -> list[dict]:
    return [
        {k: v for k, v in u.items() if k != "password_hash"}
        for u in load_users().values()
    ]


def create_user(
    email: str,
    password: str,
    role: str = "user",
    full_name: str = "",
) -> dict:
    if get_user_by_email(email):
        raise ValueError(f"Email déjà utilisé : {email}")
    if role not in ("user", "superuser"):
        raise ValueError("Rôle invalide — valeurs acceptées : user, superuser")

    uid = str(uuid.uuid4())
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user = {
        "id": uid,
        "email": email,
        "password_hash": pw_hash,
        "role": role,
        "full_name": full_name or email.split("@")[0],
        "is_active": True,
        "created_at": _now_iso(),
    }
    users = load_users()
    users[uid] = user
    save_users(users)
    return _public(user)


def update_user(user_id: str, updates: dict) -> dict:
    users = load_users()
    if user_id not in users:
        raise KeyError("Utilisateur introuvable")
    allowed = {"full_name", "role", "is_active"}
    for k, v in updates.items():
        if k in allowed:
            users[user_id][k] = v
    if "password" in updates and updates["password"]:
        users[user_id]["password_hash"] = bcrypt.hashpw(
            updates["password"].encode(), bcrypt.gensalt()
        ).decode()
    save_users(users)
    return _public(users[user_id])


def delete_user(user_id: str):
    users = load_users()
    if user_id not in users:
        raise KeyError("Utilisateur introuvable")
    del users[user_id]
    save_users(users)
    revoke_all_user_tokens(user_id)


def verify_password(password: str, pw_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), pw_hash.encode())
    except Exception:
        return False


def _public(user: dict) -> dict:
    return {k: v for k, v in user.items() if k != "password_hash"}


# ── Gestion des tokens ────────────────────────────────────────────────────────

def load_tokens() -> dict:
    return _load(TOKENS_FILE)


def save_tokens(tokens: dict):
    _save(TOKENS_FILE, tokens)


def _purge_expired(tokens: dict) -> dict:
    now = datetime.now(timezone.utc)
    return {
        jti: t for jti, t in tokens.items()
        if not t.get("revoked") and datetime.fromisoformat(t["expires_at"]) > now
    }


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

    tokens = load_tokens()
    tokens = _purge_expired(tokens)
    tokens[jti] = {
        "user_id":    user["id"],
        "jti":        jti,
        "expires_at": exp.isoformat(),
        "created_at": now.isoformat(),
        "revoked":    False,
    }
    save_tokens(tokens)
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
        stored = load_tokens().get(p.get("jti"))
        if not stored or stored.get("revoked"):
            return None
        return p
    except jwt.PyJWTError:
        return None


def revoke_refresh_token(jti: str):
    tokens = load_tokens()
    if jti in tokens:
        tokens[jti]["revoked"] = True
        save_tokens(tokens)


def revoke_all_user_tokens(user_id: str):
    tokens = load_tokens()
    for t in tokens.values():
        if t.get("user_id") == user_id:
            t["revoked"] = True
    save_tokens(tokens)


# ── Initialisation ────────────────────────────────────────────────────────────

def ensure_default_superuser():
    if not load_users():
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
        g.current_user = payload
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
        if payload.get("role") != "superuser":
            return jsonify({"error": "Accès réservé aux super-utilisateurs"}), 403
        g.current_user = payload
        return f(*args, **kwargs)
    return decorated


def get_current_user() -> dict | None:
    return getattr(g, "current_user", None)


# ── Utilitaire ────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
