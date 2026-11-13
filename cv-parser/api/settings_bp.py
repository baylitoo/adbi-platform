"""
settings_bp.py — Paramétrage, gestion utilisateurs (comptes Cynov autorisés), activité, profil.
"""
from flask import Blueprint, request, jsonify

import llm_cascade
from core.auth import (
    require_auth, require_superuser, get_current_user,
    list_users, get_user_by_id, update_user, delete_user,
    create_user, AUTH_ACTIVE,
)
from core.activity_pg import get_events, get_user_stats

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


# ── Comptes autorisés ─────────────────────────────────────────────────────────

@settings_bp.route("/api/settings/users", methods=["POST"])
@require_superuser
def authorize_user():
    """Autorise un identifiant Cynov sur ADBI ; la personne se connecte ensuite avec son mot de passe Cynov."""
    data = request.json or {}
    identifiant = (data.get("email") or "").strip().lower()
    role = data.get("role", "user")
    if not identifiant:
        return jsonify({"error": "Identifiant Cynov requis"}), 400
    if role not in ("user", "superuser"):
        return jsonify({"error": "Rôle invalide"}), 400
    try:
        user = create_user(email=identifiant, role=role, full_name=(data.get("full_name") or "").strip())
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    return jsonify({"success": True, "user": user}), 201


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

    if not updates:
        return jsonify({"error": "Aucune modification"}), 400

    update_user(current["sub"], updates)
    return jsonify({"success": True})
