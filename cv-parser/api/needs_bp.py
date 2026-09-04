"""api/needs_bp.py — CRUD des besoins clients."""
from flask import Blueprint, jsonify, request

from core.auth import require_auth, get_current_user
from core.database_pg import (
    insert_need, get_need, list_needs, update_need, delete_need,
)

needs_bp = Blueprint("needs", __name__, url_prefix="/api/needs")


@needs_bp.get("")
@require_auth
def get_needs():
    user   = get_current_user()
    status = request.args.get("status")
    # superuser voit tous les besoins, user voit les siens
    if user.get("role") == "superuser":
        items = list_needs(status=status)
    else:
        items = list_needs(created_by=user["sub"], status=status)
    return jsonify(items)


@needs_bp.post("")
@require_auth
def create_need():
    user = get_current_user()
    body = request.get_json(silent=True) or {}
    if not body.get("title"):
        return jsonify({"error": "Le champ 'title' est obligatoire"}), 400
    need = insert_need(body, created_by=user["sub"])
    return jsonify(need), 201


@needs_bp.get("/<need_id>")
@require_auth
def get_one(need_id: str):
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    _check_access(need)
    return jsonify(need)


@needs_bp.patch("/<need_id>")
@require_auth
def patch_need(need_id: str):
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    _check_access(need)
    body    = request.get_json(silent=True) or {}
    updated = update_need(need_id, body)
    return jsonify(updated)


@needs_bp.delete("/<need_id>")
@require_auth
def remove_need(need_id: str):
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    _check_access(need)
    delete_need(need_id)
    return jsonify({"ok": True})


def _check_access(need: dict):
    user = get_current_user()
    if user.get("role") == "superuser":
        return
    if need.get("created_by") != user.get("sub"):
        from flask import abort
        abort(403)
