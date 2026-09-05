"""
settings_bp.py — Paramétrage, gestion utilisateurs, invitations, activité, profil.
"""
import secrets
from datetime import datetime, timezone, timedelta

from flask import Blueprint, request, jsonify

import requests as _requests
import llm_cascade
from config import PROVIDERS, get_active_llm, set_active_llm
from core.auth import (
    require_auth, require_superuser, get_current_user,
    list_users, get_user_by_id, update_user, delete_user,
    create_user, verify_password, AUTH_ACTIVE,
)
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
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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
    llm = get_active_llm()
    return jsonify({
        "provider": llm["provider"],
        "model":    llm["model"],
        "url":      llm["url"],
        # Modèle enregistré mais écarté car il n'appartient pas au fournisseur
        # actif : l'interface peut ainsi l'expliquer au lieu de laisser croire
        # que c'est lui qui est utilisé.
        "modele_ignore": llm.get("modele_ignore"),
    })


@settings_bp.route("/api/settings/llm", methods=["PATCH"])
@require_superuser
def update_llm_config():
    data     = request.json or {}
    provider = (data.get("provider") or PROVIDERS[0]).strip()
    model    = (data.get("model") or "").strip()
    if provider not in PROVIDERS:
        return jsonify({"error": f"Fournisseur invalide : seul « {PROVIDERS[0]} » reste disponible."}), 400

    resultat = set_active_llm(provider, model)
    # Un modèle qui n'est pas celui du fournisseur n'est pas enregistré : c'est
    # exactement l'inversion qui rendait toutes les requêtes invalides.
    if resultat["refus"]:
        return jsonify({"error": resultat["refus"],
                        "provider": resultat["provider"],
                        "model": resultat["model"]}), 400
    return jsonify({"success": True,
                    "provider": resultat["provider"],
                    "model": resultat["model"]})


@settings_bp.route("/api/settings/llm/test", methods=["POST"])
@require_superuser
def test_llm():
    """Teste la connexion au LLM actif avec un mini-prompt."""
    llm = get_active_llm()
    try:
        resp = _requests.post(
            llm["url"],
            headers={"Authorization": f"Bearer {llm['key']}", "Content-Type": "application/json"},
            json={"model": llm["model"], "messages": [{"role": "user", "content": "Réponds juste 'OK'"}], "max_tokens": 5},
            timeout=10,
        )
        resp.raise_for_status()
        answer = resp.json()["choices"][0]["message"]["content"].strip()
        return jsonify({"success": True, "provider": llm["provider"], "model": llm["model"], "response": answer})
    except _requests.exceptions.Timeout:
        return jsonify({"success": False, "error": "Timeout (10s)"}), 408
    except _requests.exceptions.HTTPError as e:
        body = ""
        try: body = e.response.text[:200]
        except: pass
        return jsonify({"success": False, "error": f"HTTP {e.response.status_code}: {body}"}), 502
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── Chaîne de secours LLM (superuser) ────────────────────────────────────────
#
# La chaîne est essayée dans l'ordre : le premier service qui répond fournit la
# réponse. Un service en panne, à court de quota ou dont la clé a expiré est
# simplement sauté, sans que l'analyse échoue.

def _masquer(cle: str) -> str:
    """Une clé ne repart jamais entière vers le navigateur."""
    if not cle:
        return ""
    return f"{cle[:6]}…{cle[-4:]}" if len(cle) > 14 else "…"


@settings_bp.route("/api/settings/llm/chaine", methods=["GET"])
@require_superuser
def get_llm_chaine():
    entrees = llm_cascade.charger_chaine()
    return jsonify({
        "personnalisee": llm_cascade.CHAINE_FICHIER.exists(),
        "entrees": [{
            "actif":  e.get("actif", True),
            "nom":    e.get("nom", ""),
            "url":    e.get("url", ""),
            "modele": e.get("modele", ""),
            "cle_masquee": _masquer(e.get("cle", "")),
            "a_une_cle":   bool(e.get("cle")),
        } for e in entrees],
    })


@settings_bp.route("/api/settings/llm/chaine", methods=["PUT"])
@require_superuser
def put_llm_chaine():
    """
    Remplace la chaîne complète : ordre, activation, ajouts et suppressions.

    Une entrée dont la clé n'est pas renvoyée (le navigateur n'a reçu qu'un
    masque) conserve la clé déjà enregistrée : modifier l'ordre ne doit pas
    effacer les clés au passage.
    """
    data = request.json or {}
    recues = data.get("entrees")
    if not isinstance(recues, list):
        return jsonify({"error": "Liste d'entrées attendue"}), 400

    anciennes = {(e.get("url"), e.get("modele")): e.get("cle", "")
                 for e in llm_cascade.charger_chaine()}

    fusionnees = []
    for e in recues:
        cle = (e.get("cle") or "").strip()
        if not cle:
            cle = anciennes.get((e.get("url"), e.get("modele")), "")
        fusionnees.append({**e, "cle": cle})

    entrees = llm_cascade.enregistrer_chaine(fusionnees)
    return jsonify({"success": True, "nombre": len(entrees)})


@settings_bp.route("/api/settings/llm/chaine/defaut", methods=["POST"])
@require_superuser
def reset_llm_chaine():
    entrees = llm_cascade.reinitialiser_chaine()
    return jsonify({"success": True, "nombre": len(entrees)})


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
    return jsonify({"success": True})
