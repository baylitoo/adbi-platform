"""api/auth_bp.py — Routes d'authentification JWT."""
from datetime import timezone, datetime
from flask import Blueprint, jsonify, request, make_response, redirect

from config import ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS
from core.activity import log_event
from core.auth import (
    get_user_by_email, get_user_by_id, list_users,
    create_user, update_user, delete_user,
    verify_password, verify_refresh_token,
    create_access_token, create_refresh_token,
    revoke_refresh_token, revoke_all_user_tokens,
    require_auth, require_superuser, get_current_user,
)

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


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

    if not email or not password:
        return jsonify({"error": "Email et mot de passe requis"}), 400

    user = get_user_by_email(email)
    if not user or not verify_password(password, user.get("password_hash", "")):
        return jsonify({"error": "Identifiants invalides"}), 401
    if not user.get("is_active", True):
        return jsonify({"error": "Compte désactivé"}), 403

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
