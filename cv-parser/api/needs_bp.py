"""api/needs_bp.py — CRUD des besoins clients."""
from flask import Blueprint, jsonify, request

from core.auth import require_auth, get_current_user, check_need_access
from core.database_pg import (
    insert_need, get_need, list_needs, update_need, delete_need,
)
from core.models import NeedStatus
from config import NEED_SHORT_MAX, NEED_TEXT_MAX, NEED_LIST_MAX, NEED_ITEM_MAX

needs_bp = Blueprint("needs", __name__, url_prefix="/api/needs")

# Champs courts (intitulé, statut...) : bornés à NEED_SHORT_MAX.
_CHAMPS_COURTS = ("title", "seniority", "location", "remote", "contract_type",
                  "budget", "start_date")
# Champs texte libre (fiche de poste collée, contexte de mission...) : bornés
# à NEED_TEXT_MAX, plus large.
_CHAMPS_TEXTE = ("context", "notes", "raw_text", "client", "sector")
# Listes relues par core/matcher.py pour chaque CV de la CVthèque : bornées
# en nombre d'entrées ET en longueur par entrée.
_CHAMPS_LISTE = ("required_skills", "bonus_skills", "languages")
# `status` a bien une énumération dédiée (core/models.py::NeedStatus), mais
# cette route travaille sur des dicts bruts sans jamais passer par les
# modèles Pydantic (NeedCreate/NeedUpdate — non utilisés ailleurs dans le
# code) : rien ne la fait respecter avant ce correctif. `insert_need()` fixe
# toujours "active" à la création (POST), donc seul PATCH est concerné.
_STATUTS_VALIDES = {s.value for s in NeedStatus}


def _longueur_entree(champ: str, item) -> int:
    """Longueur textuelle d'une entrée de liste — `languages` peut porter des
    objets `{"language": "..."}` plutôt que de simples chaînes."""
    if isinstance(item, str):
        return len(item)
    if champ == "languages" and isinstance(item, dict):
        return len(str(item.get("language") or item.get("name") or ""))
    return len(str(item))


def _valider_besoin(body: dict) -> str | None:
    """Plafonne les champs d'un besoin AVANT tout enregistrement.

    Sans cela, un besoin devient un vecteur de déni de service : voir
    issue #72 — core/matcher.py::run_matching relit ces champs pour CHAQUE
    CV de la CVthèque (SequenceMatcher, recherche de mots-clés par
    sous-chaîne), sans aucune borne haute côté écriture jusqu'ici.
    Renvoie un message d'erreur, ou None si le besoin est acceptable.
    """
    for cle in _CHAMPS_COURTS:
        v = body.get(cle)
        if isinstance(v, str) and len(v) > NEED_SHORT_MAX:
            return f"Le champ '{cle}' dépasse {NEED_SHORT_MAX} caractères."

    for cle in _CHAMPS_TEXTE:
        v = body.get(cle)
        if isinstance(v, str) and len(v) > NEED_TEXT_MAX:
            return f"Le champ '{cle}' dépasse {NEED_TEXT_MAX} caractères."

    for cle in _CHAMPS_LISTE:
        v = body.get(cle)
        if v is None:
            continue
        if not isinstance(v, list):
            return f"Le champ '{cle}' doit être une liste."
        if len(v) > NEED_LIST_MAX:
            return f"Le champ '{cle}' accepte au plus {NEED_LIST_MAX} entrées."
        for item in v:
            if _longueur_entree(cle, item) > NEED_ITEM_MAX:
                return f"Une entrée de '{cle}' dépasse {NEED_ITEM_MAX} caractères."

    statut = body.get("status")
    if statut is not None and (not isinstance(statut, str) or statut not in _STATUTS_VALIDES):
        return (
            "Le champ 'status' doit être l'une des valeurs : "
            + ", ".join(sorted(_STATUTS_VALIDES)) + "."
        )

    return None


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
    erreur = _valider_besoin(body)
    if erreur:
        return jsonify({"error": erreur}), 400
    need = insert_need(body, created_by=user["sub"])
    return jsonify(need), 201


@needs_bp.get("/<need_id>")
@require_auth
def get_one(need_id: str):
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    check_need_access(need)
    return jsonify(need)


@needs_bp.patch("/<need_id>")
@require_auth
def patch_need(need_id: str):
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    _check_access(need)
    body   = request.get_json(silent=True) or {}
    erreur = _valider_besoin(body)
    if erreur:
        return jsonify({"error": erreur}), 400
    updated = update_need(need_id, body)
    return jsonify(updated)


@needs_bp.delete("/<need_id>")
@require_auth
def remove_need(need_id: str):
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    check_need_access(need)
    delete_need(need_id)
    return jsonify({"ok": True})
