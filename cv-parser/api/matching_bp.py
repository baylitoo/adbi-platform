"""api/matching_bp.py — Lancement du matching + récupération des résultats."""
from flask import Blueprint, jsonify, request

from core.auth import require_auth, get_current_user, check_need_access
from core.activity_pg import log_event
from core.cvstore_pg import get_cv
from core.database_pg import (
    get_need, upsert_match_results, get_match_results, get_match_result,
)
from core.matcher import run_matching

matching_bp = Blueprint("matching", __name__, url_prefix="/api/needs")


@matching_bp.post("/<need_id>/match")
@require_auth
def launch_match(need_id: str):
    """Lance le matching d'un besoin contre toute la CVthèque."""
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    check_need_access(need)

    limit   = int(request.args.get("limit", 50))
    results = run_matching(need, limit=limit)

    upsert_match_results(need_id, results)

    try:
        u = get_current_user()
        if u:
            log_event("match_run", u["sub"], u.get("email",""),
                      {"need_id": need_id, "results": len(results)})
    except Exception:
        pass

    return jsonify({
        "need_id":        need_id,
        "total_matched":  len(results),
        "top3":           results[:3],
        "results":        results,
    })


@matching_bp.get("/<need_id>/results")
@require_auth
def get_results(need_id: str):
    """Récupère les derniers résultats de matching pour un besoin."""
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    check_need_access(need)

    rows = get_match_results(need_id)
    if not rows:
        return jsonify({"error": "Aucun résultat — lancez d'abord le matching"}), 404

    # Enrichir avec les infos candidat (lecture par ligne — CVthèque PostgreSQL)
    enriched = []
    for r in rows:
        cid = r["candidate_id"]
        cv  = get_cv(cid) or {}
        contact = cv.get("contact") or {}
        r["candidate_name"]  = cv.get("name", r.get("candidate_id", ""))
        r["candidate_title"] = cv.get("title", "")
        r["email"]           = contact.get("email", "")
        r["phone"]           = contact.get("phone", "")
        r["location"]        = contact.get("location", "")
        r["availability"]    = cv.get("availability_status", "")
        r["top_skills"]      = (cv.get("skills_flat") or [])[:8]
        enriched.append(r)

    return jsonify({
        "need_id":  need_id,
        "need":     need,
        "count":    len(enriched),
        "results":  enriched,
    })


@matching_bp.get("/<need_id>/results/<candidate_id>")
@require_auth
def get_detail(need_id: str, candidate_id: str):
    """Détail du match entre un besoin et un candidat spécifique."""
    need = get_need(need_id)
    if not need:
        return jsonify({"error": "Besoin introuvable"}), 404
    check_need_access(need)

    match = get_match_result(need_id, candidate_id)
    if not match:
        return jsonify({"error": "Résultat introuvable pour ce candidat"}), 404

    # Candidat complet (lecture par ligne — CVthèque PostgreSQL)
    cv = get_cv(candidate_id) or {}

    return jsonify({
        "need":      need,
        "match":     match,
        "candidate": cv,
    })
