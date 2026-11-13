"""api/auth_bp.py — Routes d'authentification : la session Cynov prouve l'identité, cv-parser émet le jeton ADBI."""
import threading
import time
from datetime import timezone, datetime

from flask import Blueprint, jsonify, request, make_response, redirect

from config import (
    ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS,
    LOGIN_MAX_ECHECS, LOGIN_FENETRE_S,
    COOKIE_DOMAIN,
)
from core import cynov_auth
from core.activity_pg import log_event
from core.auth import (
    get_user_by_email, get_user_by_id, list_users,
    create_user, update_user, delete_user,
    verify_refresh_token,
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


def _schema_public() -> str:
    """Le schéma que voit RÉELLEMENT le navigateur, derrière le proxy Coolify.

    `request.is_secure` lit `wsgi.url_scheme`, qui vaut « http » pour toutes
    les requêtes derrière un proxy qui termine le TLS (voir
    docs/deploiement-coolify.md : Coolify pose Let's Encrypt par domaine et
    parle au conteneur en clair sur le réseau interne). S'y fier seul
    reviendrait à ne JAMAIS marquer le cookie `Secure` en déploiement,
    c'est-à-dire à écrire une protection qui ne s'active jamais.

    Pourquoi lire un en-tête fourni par le client ICI, alors que ce fichier
    refuse explicitement `ProxyFix` / `X-Forwarded-For` plus haut (bloc anti
    brute-force) : le modèle de menace est inverse, et c'est la seule raison.

      - Falsifier `X-Forwarded-For` AFFAIBLIT la limite de tentatives —
        l'attaquant se donne une IP apparente neuve à chaque essai. D'où le
        refus, qui reste entier : rien ici ne touche à cette limite.
      - Falsifier `X-Forwarded-Proto: https` ne peut que DURCIR le cookie. Le
        navigateur cessera alors de le renvoyer en clair, au détriment du seul
        falsificateur. Aucun gain pour un attaquant, donc aucune raison
        d'exiger un proxy de confiance pour ce seul usage.

    Pas de variable d'environnement non plus : une bascule qu'on oublie de
    poser après le passage au TLS échoue en SILENCE (cookie non marqué, rien
    à l'écran). Le schéma réel, lui, se corrige tout seul le jour du TLS.
    """
    # Une chaîne de proxys concatène : « https,http ». Le premier élément est
    # celui vu par le client, les suivants sont les sauts internes.
    annonce = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
    if annonce in ("http", "https"):
        return annonce
    return "https" if request.is_secure else "http"


def _portee_cookie() -> dict:
    """`domain=` à passer à set_cookie/delete_cookie, ou rien.

    COOKIE_DOMAIN vide -> dictionnaire VIDE, pas `domain=None` ni `domain=""` :
    l'attribut est alors totalement absent de l'en-tête et le cookie reste
    « host-only », exactement comme aujourd'hui. C'est ce qui garantit qu'un
    déploiement qui ne pose pas la variable ne voit AUCUN changement.

    Posée, elle étend le cookie aux sous-domaines, ce qui permet aux quatre
    services Node de VÉRIFIER le jeton (auth/auth-adbi.js) sans que quiconque
    d'autre que cv-parser n'en émette. Voir #245 pour la série, #253 pour la
    bascule de domaine (qui ne change que la valeur de cette variable).
    """
    return {"domain": COOKIE_DOMAIN} if COOKIE_DOMAIN else {}


def _set_cookies(resp, access_token: str, refresh_token: str):
    # `Secure` suit le schéma réel : absent en HTTP (sinon le navigateur ne
    # renverrait plus le cookie et la connexion cesserait de fonctionner sur
    # le déploiement actuel), posé dès que le TLS est en place.
    secure = _schema_public() == "https"
    portee = _portee_cookie()
    resp.set_cookie(
        "adbi_access", access_token,
        httponly=True, samesite="Lax", secure=secure,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/", **portee,
    )
    resp.set_cookie(
        "adbi_refresh", refresh_token,
        httponly=True, samesite="Lax", secure=secure,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/api/auth/refresh", **portee,
    )
    return resp


def _clear_cookies(resp):
    # Mêmes attributs qu'à la pose : un cookie `Secure`/`SameSite`/`Domain`
    # supprimé avec des attributs discordants n'est pas remplacé par le
    # navigateur — la déconnexion laisserait le jeton en place. `domain` en
    # fait partie : un cookie posé sur .outils.adbi.fr et supprimé sans
    # `domain` survivrait à la déconnexion, sur TOUS les services.
    secure = _schema_public() == "https"
    portee = _portee_cookie()
    resp.delete_cookie("adbi_access", path="/",
                       httponly=True, samesite="Lax", secure=secure, **portee)
    resp.delete_cookie("adbi_refresh", path="/api/auth/refresh",
                       httponly=True, samesite="Lax", secure=secure, **portee)
    return resp


# Jetons Cynov : httpOnly, sur ce seul hôte et ce seul préfixe, jamais vus par les services Node ni par le navigateur.
_COOKIES_CYNOV = ("adbi_cynov_refresh", "adbi_cynov_access")
_CHEMIN_CYNOV = "/api/auth"


def _poser_cookies_cynov(resp, paire: dict):
    secure = _schema_public() == "https"
    resp.set_cookie("adbi_cynov_refresh", paire["rotation"], httponly=True, samesite="Lax", secure=secure,
                    max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400, path=_CHEMIN_CYNOV)
    resp.set_cookie("adbi_cynov_access", paire["acces"], httponly=True, samesite="Lax", secure=secure,
                    max_age=paire["duree"], path=_CHEMIN_CYNOV)
    return resp


def _effacer_cookies_cynov(resp):
    secure = _schema_public() == "https"
    for nom in _COOKIES_CYNOV:
        resp.delete_cookie(nom, path=_CHEMIN_CYNOV, httponly=True, samesite="Lax", secure=secure)
    return resp


def _session(user: dict, paire: dict, corps: dict):
    """Réponse portant la session ADBI ET la paire Cynov qui l'a prouvée (la rotation remplace toujours l'ancienne)."""
    access = create_access_token(user)
    refresh = create_refresh_token(user, paire["identifiant"])
    resp = make_response(jsonify({**corps, "access_token": access, "token_type": "bearer",
                                  "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60}))
    return _poser_cookies_cynov(_set_cookies(resp, access, refresh), paire)


def _deconnecte(message: str, statut: int = 401):
    return _effacer_cookies_cynov(_clear_cookies(make_response(jsonify({"error": message}), statut)))


# ── Login ─────────────────────────────────────────────────────────────────────
@auth_bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    identifiant = (body.get("login") or body.get("email") or "").strip()
    password = body.get("password") or ""
    ip = request.remote_addr or "?"

    if not identifiant or not password:
        return jsonify({"error": "Identifiant et mot de passe Cynov requis"}), 400
    if _trop_de_tentatives(ip, identifiant):
        return jsonify({"error": "Trop de tentatives — réessayez dans quelques minutes."}), 429

    try:
        paire = cynov_auth.connecter(identifiant, password)
    except cynov_auth.CynovRefus as exc:
        _enregistrer_echec(ip, identifiant)
        return jsonify({"error": str(exc)}), 401
    except cynov_auth.CynovIndisponible as exc:
        return jsonify({"error": str(exc)}), 503

    _oublier_echecs(ip, identifiant)
    user = get_user_by_email(identifiant) or (paire["identifiant"] and get_user_by_email(paire["identifiant"]))
    if not user:
        cynov_auth.deconnecter(paire["rotation"], paire["acces"])
        return jsonify({"error": "Compte Cynov valide, mais pas autorisé sur ADBI : demandez l'accès à un administrateur."}), 403
    if not user.get("is_active", True):
        cynov_auth.deconnecter(paire["rotation"], paire["acces"])
        return jsonify({"error": "Compte désactivé sur ADBI"}), 403

    log_event("login", user["id"], user["email"], {"ip": request.remote_addr})
    return _session(user, paire, {"user": {k: v for k, v in user.items() if k != "password_hash"}})


# ── Refresh ───────────────────────────────────────────────────────────────────
@auth_bp.post("/refresh")
def refresh():
    token = request.cookies.get("adbi_refresh")
    rotation = request.cookies.get("adbi_cynov_refresh")
    if not token or not rotation:
        return _deconnecte("Session absente")

    payload = verify_refresh_token(token)
    if not payload:
        return _deconnecte("Session expirée")
    user = get_user_by_id(payload["sub"])
    if not user or not user.get("is_active", True):
        return _deconnecte("Utilisateur introuvable ou désactivé")

    try:
        paire = cynov_auth.renouveler(rotation)
    except cynov_auth.CynovRefus:
        revoke_refresh_token(payload["jti"])
        return _deconnecte("Session Cynov expirée ou révoquée")
    except cynov_auth.CynovIndisponible as exc:
        return jsonify({"error": str(exc)}), 503
    if not paire["identifiant"] or payload.get("cynov") != paire["identifiant"]:
        revoke_refresh_token(payload["jti"])
        cynov_auth.deconnecter(paire["rotation"], paire["acces"])
        return _deconnecte("Session Cynov d'un autre compte")

    revoke_refresh_token(payload["jti"])
    return _session(user, paire, {})


# ── Logout ────────────────────────────────────────────────────────────────────
@auth_bp.post("/logout")
def logout():
    token = request.cookies.get("adbi_refresh")
    if token:
        payload = verify_refresh_token(token)
        if payload:
            revoke_refresh_token(payload["jti"])
    rotation = request.cookies.get("adbi_cynov_refresh")
    if rotation:
        cynov_auth.deconnecter(rotation, request.cookies.get("adbi_cynov_access"))
    return _effacer_cookies_cynov(_clear_cookies(make_response(jsonify({"ok": True}))))


# ── Changement de mot de passe (parcours de première connexion de Cynov) ──────
@auth_bp.post("/change-password")
def change_password():
    body = request.get_json(silent=True) or {}
    identifiant = (body.get("login") or "").strip()
    ancien, nouveau = body.get("old_password") or "", body.get("new_password") or ""
    ip = request.remote_addr or "?"
    if not identifiant or not ancien or not nouveau:
        return jsonify({"error": "Identifiant, mot de passe actuel et nouveau mot de passe requis"}), 400
    if _trop_de_tentatives(ip, identifiant):
        return jsonify({"error": "Trop de tentatives — réessayez dans quelques minutes."}), 429
    try:
        cynov_auth.changer_mot_de_passe(identifiant, ancien, nouveau)
    except cynov_auth.CynovRefus as exc:
        _enregistrer_echec(ip, identifiant)
        return jsonify({"error": str(exc)}), 400
    except cynov_auth.CynovIndisponible as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify({"ok": True})


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
        return jsonify({"error": e.args[0] if e.args else str(e)}), 404 if "introuvable" in str(e) else 400


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
        return jsonify({"error": e.args[0] if e.args else str(e)}), 404
