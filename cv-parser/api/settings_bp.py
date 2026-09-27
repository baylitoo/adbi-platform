"""
settings_bp.py — Paramétrage, gestion utilisateurs, invitations, activité, profil.
"""
import secrets
import traceback
from datetime import datetime, timezone, timedelta

from flask import Blueprint, request, jsonify, make_response

import llm_cascade
from core.auth import (
    require_auth, require_superuser, get_current_user,
    list_users, get_user_by_id, update_user, delete_user,
    create_user, verify_password,
    create_access_token, create_refresh_token,
)
from api.auth_bp import _set_cookies
from core.activity_pg import get_events, get_user_stats
# Alias : évite le conflit avec les routes create_invite()/get_invite_info()
# définies plus bas dans ce même module.
from core.auth_pg import (
    create_invite as pg_create_invite,
    get_invite as pg_get_invite,
    mark_invite_used,
)

settings_bp = Blueprint("settings", __name__)


# ── User management (superuser only) ─────────────────────────────────────────

@settings_bp.route("/api/settings/users", methods=["GET"])
@require_superuser
def list_all_users():
    users = list_users()
    stats_map = {s["user_id"]: s for s in get_user_stats()}
    result = []
    for u in users:
        s = stats_map.get(u["id"], {})
        result.append({
            "id":         u["id"],
            "email":      u["email"],
            "full_name":  u.get("full_name", ""),
            "role":       u["role"],
            "created_at": u.get("created_at", ""),
            "active":     u.get("is_active", True),
            "logins":     s.get("logins", 0),
            "cv_uploads": s.get("cv_uploads", 0),
            "matches":    s.get("matches", 0),
            "last_seen":  s.get("last_seen"),
        })
    return jsonify(result)


@settings_bp.route("/api/settings/users/<user_id>/role", methods=["PATCH"])
@require_superuser
def change_user_role(user_id):
    current = get_current_user()
    if user_id == current["sub"]:
        return jsonify({"error": "Impossible de modifier votre propre rôle"}), 400
    data = request.json or {}
    role = data.get("role")
    if role not in ("user", "superuser"):
        return jsonify({"error": "Rôle invalide"}), 400
    u = get_user_by_id(user_id)
    if not u:
        return jsonify({"error": "Utilisateur introuvable"}), 404
    update_user(user_id, {"role": role})
    return jsonify({"success": True})


@settings_bp.route("/api/settings/users/<user_id>/active", methods=["PATCH"])
@require_superuser
def toggle_user_active(user_id):
    current = get_current_user()
    if user_id == current["sub"]:
        return jsonify({"error": "Impossible de désactiver votre propre compte"}), 400
    data = request.json or {}
    active = bool(data.get("active", True))
    u = get_user_by_id(user_id)
    if not u:
        return jsonify({"error": "Utilisateur introuvable"}), 404
    update_user(user_id, {"is_active": active})
    return jsonify({"success": True})


@settings_bp.route("/api/settings/users/<user_id>", methods=["DELETE"])
@require_superuser
def delete_user_route(user_id):
    current = get_current_user()
    if user_id == current["sub"]:
        return jsonify({"error": "Impossible de supprimer votre propre compte"}), 400
    u = get_user_by_id(user_id)
    if not u:
        return jsonify({"error": "Utilisateur introuvable"}), 404
    delete_user(user_id)
    return jsonify({"success": True})


# ── Invitations ───────────────────────────────────────────────────────────────

@settings_bp.route("/api/settings/invite", methods=["POST"])
@require_superuser
def create_invite():
    data    = request.json or {}
    email   = (data.get("email") or "").strip().lower()
    role    = data.get("role", "user")
    if not email:
        return jsonify({"error": "Email requis"}), 400
    if role not in ("user", "superuser"):
        return jsonify({"error": "Rôle invalide"}), 400

    # Check if user already exists
    users = list_users()
    if any(u["email"] == email for u in users):
        return jsonify({"error": "Un compte existe déjà pour cet email"}), 409

    current = get_current_user()
    token   = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=72)

    # pg_create_invite révoque déjà les invitations en attente pour le même
    # email (DELETE ... WHERE used = false) avant d'insérer la nouvelle —
    # voir core/auth_pg.py::create_invite.
    pg_create_invite(token, email, role, current["email"], expires)

    base_url = request.host_url.rstrip("/")
    invite_url = f"{base_url}/invite/{token}"
    return jsonify({"success": True, "invite_url": invite_url, "expires_at": expires.isoformat()})


@settings_bp.route("/api/settings/invite/<token>", methods=["GET"])
def get_invite_info(token):
    inv = pg_get_invite(token)
    if not inv:
        return jsonify({"error": "Invitation invalide ou expirée"}), 404
    if inv.get("used"):
        return jsonify({"error": "Cette invitation a déjà été utilisée"}), 410
    expires = inv.get("expires_at", "")
    if expires:
        try:
            exp_dt = datetime.fromisoformat(expires)
            if datetime.now(timezone.utc) > exp_dt:
                return jsonify({"error": "Cette invitation a expiré"}), 410
        except Exception:
            pass
    return jsonify({"email": inv["email"], "role": inv["role"]})


@settings_bp.route("/api/settings/accept-invite", methods=["POST"])
def accept_invite():
    data     = request.json or {}
    token    = (data.get("token") or "").strip()
    name     = (data.get("full_name") or "").strip()
    password = (data.get("password") or "").strip()

    if not token or not name or not password:
        return jsonify({"error": "Tous les champs sont requis"}), 400
    if len(password) < 8:
        return jsonify({"error": "Mot de passe trop court (8 caractères min.)"}), 400

    inv = pg_get_invite(token)
    if not inv:
        return jsonify({"error": "Invitation invalide"}), 404
    if inv.get("used"):
        return jsonify({"error": "Invitation déjà utilisée"}), 410

    expires = inv.get("expires_at", "")
    if expires:
        try:
            if datetime.now(timezone.utc) > datetime.fromisoformat(expires):
                return jsonify({"error": "Invitation expirée"}), 410
        except Exception:
            pass

    # Check email not already taken
    users = list_users()
    if any(u["email"] == inv["email"] for u in users):
        return jsonify({"error": "Un compte existe déjà pour cet email"}), 409

    try:
        create_user(email=inv["email"], password=password,
                    full_name=name, role=inv["role"])
    except Exception:
        traceback.print_exc()
        return jsonify({"error": "Création du compte impossible, réessayez dans quelques instants."}), 500

    mark_invite_used(token)
    return jsonify({"success": True, "email": inv["email"]})


# ── Activity ──────────────────────────────────────────────────────────────────

@settings_bp.route("/api/settings/activity", methods=["GET"])
@require_superuser
def get_activity():
    limit = min(int(request.args.get("limit", 100)), 500)
    user_id = request.args.get("user_id")
    events = get_events(limit=limit, user_id=user_id)
    return jsonify(events)


@settings_bp.route("/api/settings/stats", methods=["GET"])
@require_superuser
def get_stats():
    return jsonify(get_user_stats())


# ── LLM Provider (superuser) ─────────────────────────────────────────────────

@settings_bp.route("/api/settings/llm", methods=["GET"])
@require_superuser
def get_llm_config():
    """Modèles de chat actifs, dans l'ordre de la chaîne ; ni URL ni clé."""
    actifs = [e for e in llm_cascade.charger_chaine() if e.get("actif", True)]
    return jsonify({
        "configure": bool(actifs),
        "modeles":   [{"nom": e.get("nom", ""), "modele": e.get("modele", "")} for e in actifs],
    })


@settings_bp.route("/api/settings/llm/test", methods=["POST"])
@require_superuser
def test_llm():
    """Premier modèle de la chaîne qui répond (llm_cascade.etat) ; jamais le corps amont."""
    etat = llm_cascade.etat()
    if etat.get("ok"):
        return jsonify({"success": True, "service": etat["service"], "rang": etat["rang"], "total": etat["total"]})
    return jsonify({"success": False,
                    "error": f"Aucun des {etat.get('total') or 0} modèles de la chaîne ne répond."}), 502


# ── Chaîne de secours LLM (superuser) ────────────────────────────────────────
#
# La chaîne est essayée dans l'ordre : le premier service qui répond fournit la
# réponse. Un service en panne, à court de quota ou dont la clé a expiré est
# simplement sauté, sans que l'analyse échoue.

@settings_bp.route("/api/settings/llm/chaine", methods=["GET"])
@require_superuser
def get_llm_chaine():
    """Ordre et activation des modèles de chat ; ni URL ni clé : elles ne quittent jamais le serveur."""
    entrees = llm_cascade.charger_chaine()
    return jsonify({
        "personnalisee": llm_cascade.CHAINE_FICHIER.exists(),
        "entrees": [{
            "actif":     e.get("actif", True),
            "nom":       e.get("nom", ""),
            "modele":    e.get("modele", ""),
            "decouvert": bool(e.get("decouvert")),
        } for e in entrees],
    })


@settings_bp.route("/api/settings/llm/chaine", methods=["PUT"])
@require_superuser
def put_llm_chaine():
    """Remplace l'ordre et l'activation ; un modèle qui n'est pas proposé par la passerelle est refusé."""
    data = request.json or {}
    recues = data.get("entrees")
    if not isinstance(recues, list) or not all(isinstance(e, dict) for e in recues):
        return jsonify({"error": "Liste d'entrées attendue"}), 400
    try:
        entrees = llm_cascade.enregistrer_chaine(recues)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"success": True, "nombre": len(entrees)})


@settings_bp.route("/api/settings/llm/chaine/defaut", methods=["POST"])
@require_superuser
def reset_llm_chaine():
    entrees = llm_cascade.reinitialiser_chaine()
    return jsonify({"success": True, "nombre": len(entrees)})


@settings_bp.route("/api/settings/docie/modeles", methods=["GET"])
@require_superuser
def get_docie_modeles():
    """Modèles du store DocIE, lus en direct : ce que les sélecteurs et la chaîne proposent maintenant."""
    import docie_client
    try:
        return jsonify({"modeles": docie_client.lister_modeles_store()})
    except docie_client.DocIEError as exc:
        return jsonify({"error": str(exc), "code": getattr(exc, "code", None)}), 502


@settings_bp.route("/api/llm/apercu", methods=["GET"])
@require_auth
def apercu_llm():
    """
    Aperçu léger pour l'indicateur d'en-tête : quel modèle a réellement servi au
    dernier appel, et lesquels peuvent prendre la relève.

    Aucun appel réseau n'est fait ici — l'infobulle doit s'ouvrir instantanément
    et ne doit surtout pas consommer de quota à chaque survol.
    """
    dernier = llm_cascade.dernier_service()
    chaine = []
    for rang, e in enumerate(llm_cascade.charger_chaine(), start=1):
        etiquette = f"{e.get('nom')}/{e.get('modele')}"
        chaine.append({
            "rang":    rang,
            "nom":     e.get("nom"),
            "modele":  e.get("modele"),
            "actif":   e.get("actif", True),
            "courant": etiquette == dernier.get("service"),
        })
    return jsonify({"dernier": dernier, "chaine": chaine})


@settings_bp.route("/api/settings/llm/chaine/test", methods=["POST"])
@require_superuser
def test_llm_chaine():
    """
    Teste une entrée précise (par `index`), ou tout l'état de la chaîne.

    Le test d'une seule entrée est volontaire : tester les six d'un coup
    consommerait le quota de chacune pour n'afficher qu'un voyant.
    """
    data = request.json or {}
    entrees = llm_cascade.charger_chaine()

    if "index" in data:
        try:
            entree = entrees[int(data["index"])]
        except (ValueError, IndexError):
            return jsonify({"error": "Index hors de la chaîne"}), 400
        return jsonify(llm_cascade.tester_entree(entree))

    return jsonify(llm_cascade.etat())


# ── Profile (any authenticated user) ─────────────────────────────────────────

@settings_bp.route("/api/settings/profile", methods=["GET"])
@require_auth
def get_profile():
    current = get_current_user()
    if not AUTH_ACTIVE:
        # Mode local (ADBI_AUTH != on) : g.current_user est la pseudo-identité
        # UTILISATEUR_LOCAL (core/auth.py), qui ne correspond à aucune ligne
        # de la table users — get_user_by_id() y renverrait toujours None.
        # On répond directement à partir d'elle plutôt que de faire échouer
        # cette lecture (voir issue #80).
        return jsonify({
            "id":        current["sub"],
            "email":     current["email"],
            "full_name": current.get("full_name", ""),
            "role":      current["role"],
        })
    u = get_user_by_id(current["sub"])
    if not u:
        return jsonify({"error": "Utilisateur introuvable"}), 404
    return jsonify({
        "id":        u["id"],
        "email":     u["email"],
        "full_name": u.get("full_name", ""),
        "role":      u["role"],
    })


@settings_bp.route("/api/settings/profile", methods=["PATCH"])
@require_auth
def update_profile():
    current = get_current_user()
    if not AUTH_ACTIVE:
        # Même raison qu'en GET ci-dessus : "local" n'est l'id d'aucun
        # utilisateur réel, update_user()/get_user_by_id() planteraient
        # (KeyError / AttributeError non rattrapées, voir issue #80) au lieu
        # de modifier quoi que ce soit de sensé.
        return jsonify({"error": "Profil non modifiable en mode local (authentification désactivée, ADBI_AUTH)."}), 400
    data = request.json or {}
    updates = {}

    if "full_name" in data:
        name = data["full_name"].strip()
        if not name:
            return jsonify({"error": "Le nom ne peut pas être vide"}), 400
        updates["full_name"] = name

    new_pw = None
    if "password" in data:
        new_pw = data["password"]
        old_pw = data.get("old_password", "")
        u = get_user_by_id(current["sub"])
        if not verify_password(old_pw, u.get("password_hash", "")):
            return jsonify({"error": "Mot de passe actuel incorrect"}), 403
        if len(new_pw) < 8:
            return jsonify({"error": "Nouveau mot de passe trop court (8 car. min.)"}), 400

    if not updates and new_pw is None:
        return jsonify({"error": "Aucune modification"}), 400

    if updates:
        update_user(current["sub"], updates)
    if new_pw is not None:
        update_user(current["sub"], {"password": new_pw})
        # update_user()/auth_pg révoque déjà tous les refresh tokens de
        # l'utilisateur dès qu'un mot de passe change (self-service ici, ou
        # remise à zéro par un superuser via PATCH /api/auth/users/<id>) :
        # un cookie de session volé avant ce changement ne doit pas continuer
        # à fonctionner après. On ré-émet donc une paire access/refresh pour
        # que l'auteur du changement, lui, reste connecté — sans quoi il
        # perdrait sa propre session au prochain appel.
        user = get_user_by_id(current["sub"])
        access = create_access_token(user)
        refresh = create_refresh_token(user)
        resp = make_response(jsonify({"success": True}))
        return _set_cookies(resp, access, refresh)
    return jsonify({"success": True})
