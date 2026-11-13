"""core/auth_pg.py — PostgreSQL pour utilisateurs (comptes Cynov autorisés, sans mot de passe) et refresh tokens.

Même API (noms/formes) que les fonctions de stockage de core/auth.py
(data/users.json, data/tokens.json) et des helpers d'invitation de
api/settings_bp.py (data/invites.json). PORTÉE VOLONTAIREMENT LIMITÉE au
stockage : l'encodage/décodage JWT (create_access_token, verify_access_token,
verify_refresh_token...) et les décorateurs Flask (require_auth,
require_superuser) restent dans core/auth.py — ils ne touchent pas au
stockage et n'ont donc pas besoin d'équivalent Postgres. C'est la frontière
de bascule que PR B devra respecter : remplacer les appels load_users/
save_users/load_tokens/... par ceux d'ici, garder le reste de core/auth.py
tel quel.

N'importe PAS config.py (effets de bord au chargement) : voir core/pg.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from core.pg import get_conn, init_schema

__all__ = [
    "init_db",
    "get_user_by_id", "get_user_by_email", "list_users",
    "create_user", "update_user", "delete_user", "effacer_mots_de_passe_locaux",
    "store_refresh_token", "is_refresh_token_valid",
    "revoke_refresh_token", "revoke_all_user_tokens",
]


def init_db() -> None:
    init_schema()
    print("[DB] Schema PostgreSQL initialise (users/refresh_tokens).")


def effacer_mots_de_passe_locaux() -> None:
    """Les mots de passe sont chez Cynov : aucune empreinte locale ne doit survivre (idempotent)."""
    with get_conn() as con:
        con.execute("UPDATE users SET password_hash = '' WHERE password_hash <> ''")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _public(user: dict) -> dict:
    return {k: v for k, v in user.items() if k != "password_hash"}


def _row_to_user(row: dict) -> dict:
    d = dict(row)
    d["created_at"] = _iso(d.get("created_at"))
    return d


# ══════════════════════════════════════════════════════════════════════════════
# UTILISATEURS
# ══════════════════════════════════════════════════════════════════════════════

def get_user_by_id(user_id: str) -> dict | None:
    with get_conn() as con:
        row = con.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


def get_user_by_email(email: str) -> dict | None:
    with get_conn() as con:
        row = con.execute(
            "SELECT * FROM users WHERE LOWER(email) = LOWER(%s)", (email,)
        ).fetchone()
    return _row_to_user(row) if row else None


def list_users() -> list[dict]:
    with get_conn() as con:
        rows = con.execute("SELECT * FROM users ORDER BY created_at ASC").fetchall()
    return [_public(_row_to_user(r)) for r in rows]


def create_user(email: str, role: str = "user", full_name: str = "") -> dict:
    """Autorise un compte Cynov sur ADBI : `email` est son identifiant Cynov, le mot de passe reste chez Cynov."""
    email = (email or "").strip()
    if not email:
        raise ValueError("Identifiant Cynov requis")
    if get_user_by_email(email):
        raise ValueError(f"Email déjà utilisé : {email}")
    if role not in ("user", "superuser"):
        raise ValueError("Rôle invalide — valeurs acceptées : user, superuser")

    uid = str(uuid.uuid4())
    now = _now()
    with get_conn() as con:
        con.execute(
            """
            INSERT INTO users (id, email, password_hash, role, full_name, is_active, created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            """,
            (uid, email, "", role, full_name or email.split("@")[0], True, now),
        )
    return _public(get_user_by_id(uid))


_ALLOWED_UPDATE_FIELDS = {"full_name", "role", "is_active"}


def update_user(user_id: str, updates: dict) -> dict:
    existing = get_user_by_id(user_id)
    if not existing:
        raise KeyError("Utilisateur introuvable")

    fields, vals = [], []
    for k, v in updates.items():
        if k in _ALLOWED_UPDATE_FIELDS:
            fields.append(f"{k} = %s")
            vals.append(v)
    if fields:
        vals.append(user_id)
        with get_conn() as con:
            con.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = %s", vals)

    return _public(get_user_by_id(user_id))


def _revoquer_tokens_sur(con, user_id: str) -> None:
    """Révoque tous les refresh tokens d'un utilisateur SUR LA CONNEXION
    fournie — pour que ce soit dans la même transaction qu'une autre écriture
    (changement de mot de passe, suppression du compte). Voir revoke_all_user_tokens
    pour l'appel autonome (sa propre connexion/transaction)."""
    con.execute(
        "UPDATE refresh_tokens SET revoked = true WHERE user_id = %s", (user_id,)
    )


def delete_user(user_id: str) -> None:
    if not get_user_by_id(user_id):
        raise KeyError("Utilisateur introuvable")
    # Révocation des tokens ET suppression du compte sur LA MÊME connexion —
    # voir le commentaire équivalent dans update_user : sans ça, un compte
    # supprimé mais dont l'échec de révocation (panne passagère) laisserait
    # ses refresh tokens valides jusqu'à 7 jours, y compris pour un user_id
    # qui n'existe plus (pas de FOREIGN KEY refresh_tokens -> users, voir
    # core/schema.sql).
    with get_conn() as con:
        _revoquer_tokens_sur(con, user_id)
        con.execute("DELETE FROM users WHERE id = %s", (user_id,))


# ══════════════════════════════════════════════════════════════════════════════
# REFRESH TOKENS
# ══════════════════════════════════════════════════════════════════════════════

def store_refresh_token(jti: str, user_id: str, expires_at: datetime) -> None:
    with get_conn() as con:
        con.execute(
            """
            INSERT INTO refresh_tokens (jti, user_id, expires_at, created_at, revoked)
            VALUES (%s,%s,%s,%s,false)
            ON CONFLICT (jti) DO UPDATE SET
              user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at
            """,
            (jti, user_id, expires_at, _now()),
        )


def is_refresh_token_valid(jti: str) -> bool:
    """True si le jti existe, n'est pas révoqué et n'est pas expiré."""
    with get_conn() as con:
        row = con.execute(
            "SELECT revoked, expires_at FROM refresh_tokens WHERE jti = %s", (jti,)
        ).fetchone()
    if not row or row["revoked"]:
        return False
    expires_at = row["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > _now()


def revoke_refresh_token(jti: str) -> None:
    with get_conn() as con:
        con.execute("UPDATE refresh_tokens SET revoked = true WHERE jti = %s", (jti,))


def revoke_all_user_tokens(user_id: str) -> None:
    """Appel autonome (sa propre connexion/transaction). Pour révoquer dans la
    MÊME transaction qu'une autre écriture (changement de mot de passe,
    suppression du compte), voir _revoquer_tokens_sur."""
    with get_conn() as con:
        _revoquer_tokens_sur(con, user_id)
