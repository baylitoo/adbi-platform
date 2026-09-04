"""core/matcher.py — Moteur de matching besoins → candidats.

Score /100 décomposé en 6 critères :
  35 pts — compétences obligatoires
  20 pts — proximité titre / profil
  15 pts — séniorité / expérience
  10 pts — disponibilité
  10 pts — missions / clients / secteur
  10 pts — bonus (langue, certifs, cloud, localisation, contrat)
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from core.cvstore_pg import list_cvs

try:
    from skills_normalizer import normalize_one, normalize_skills, compute_skills_flat
except ImportError:
    def normalize_one(s): return s.strip()
    def normalize_skills(lst): return list(lst)
    def compute_skills_flat(cv): return []


# ── Poids ─────────────────────────────────────────────────────────────────────
WEIGHTS = {
    "skills":       35,
    "title":        20,
    "seniority":    15,
    "availability": 10,
    "missions":     10,
    "bonus":        10,
}

SENIORITY_YEARS = {
    "junior":    (0, 2),
    "confirmé":  (3, 5),
    "senior":    (6, 9),
    "expert":    (10, 99),
}


# ── Chargement CVthèque ───────────────────────────────────────────────────────

def _load_cv_db() -> dict:
    """Toute la CVthèque — lecture PostgreSQL (core/cvstore_pg.py).

    Nom conservé (utilisé par core/rapprochement.py) : un scan complet des
    candidats est un besoin légitime du matching, pas un cache — chaque appel
    relit la table.
    """
    try:
        return list_cvs()
    except Exception:
        return {}


def _get_skills_flat(cv: dict) -> list[str]:
    """Retourne la liste normalisée des skills d'un candidat."""
    flat = cv.get("skills_flat") or []
    if not flat:
        flat = compute_skills_flat(cv)
    return [normalize_one(s).lower() for s in flat]


def _get_all_text(cv: dict) -> str:
    """Concatène tout le texte du CV pour la recherche de mots-clés."""
    parts = [
        cv.get("title", ""),
        cv.get("summary", ""),
    ]
    for exp in (cv.get("experience") or []):
        parts += [
            exp.get("company", ""),
            exp.get("client", ""),
            exp.get("title", ""),
            exp.get("subtitle", ""),
            exp.get("contexte", ""),
            exp.get("objectifs", ""),
            exp.get("description", ""),
            exp.get("env_technique", ""),
        ]
    return " ".join(p for p in parts if p).lower()


# ── Similarité texte ──────────────────────────────────────────────────────────

def _sim(a: str, b: str) -> float:
    """Ratio de similarité entre deux chaînes (0.0–1.0)."""
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _keyword_overlap(query: str, text: str) -> float:
    """Proportion de mots-clés du query trouvés dans text."""
    stop = {"le", "la", "les", "de", "du", "des", "un", "une", "et", "en", "ou", "au", "aux",
            "avec", "pour", "sur", "dans", "par", "est", "sont", "the", "a", "of", "and", "or"}
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2 and w not in stop]
    if not words:
        return 0.5
    found = sum(1 for w in words if w in text)
    return found / len(words)


# ══════════════════════════════════════════════════════════════════════════════
# SCORING — 6 critères
# ══════════════════════════════════════════════════════════════════════════════

def _score_skills(need: dict, candidate_skills: list[str]) -> tuple[float, list[str]]:
    """35 pts — Compétences obligatoires."""
    required = [normalize_one(s).lower() for s in (need.get("required_skills") or [])]
    if not required:
        return WEIGHTS["skills"], []

    found, missing = [], []
    for req in required:
        # Correspondance exacte ou partielle (substring)
        matched = any(
            req == sk or req in sk or sk in req or _sim(req, sk) > 0.82
            for sk in candidate_skills
        )
        if matched:
            found.append(req)
        else:
            missing.append(req)

    ratio = len(found) / len(required)
    return round(ratio * WEIGHTS["skills"], 2), missing


def _score_title(need: dict, cv: dict) -> float:
    """20 pts — Proximité titre / profil."""
    need_title = need.get("title", "")
    if not need_title:
        return WEIGHTS["title"] * 0.5  # neutre

    all_text = _get_all_text(cv)
    cv_title  = cv.get("title", "")

    # Similarité directe avec le titre du candidat
    direct_sim = _sim(need_title, cv_title)
    # Présence de mots-clés dans tout le texte
    kw_score   = _keyword_overlap(need_title, all_text)

    combined = direct_sim * 0.6 + kw_score * 0.4
    return round(combined * WEIGHTS["title"], 2)


def _score_seniority(need: dict, cv: dict) -> float:
    """15 pts — Adéquation séniorité / années d'expérience."""
    req_seniority = (need.get("seniority") or "").lower().strip()
    min_years     = int(need.get("min_years") or 0)
    cv_years      = int(cv.get("years_experience") or 0)

    score = 0.0

    # Critère années minimum
    if min_years > 0:
        if cv_years >= min_years:
            score += 0.5
        elif cv_years >= min_years * 0.8:
            score += 0.3    # proche
        # sinon 0

    # Critère niveau séniorité
    if req_seniority and req_seniority in SENIORITY_YEARS:
        low, high = SENIORITY_YEARS[req_seniority]
        if low <= cv_years <= high:
            score += 0.5
        elif cv_years > high:
            # surqualifié — pénalité légère
            score += 0.35
        elif cv_years >= low - 1:
            score += 0.25

    # Si aucun critère séniorité dans le besoin
    if min_years == 0 and not req_seniority:
        score = 0.6  # neutre

    return round(min(score, 1.0) * WEIGHTS["seniority"], 2)


def _score_availability(cv: dict) -> float:
    """10 pts — Disponibilité du candidat."""
    status = (cv.get("availability_status") or "").lower()
    # Chercher aussi dans les champs legacy
    if not status:
        for exp in (cv.get("experience") or []):
            period = (exp.get("period") or "").lower()
            if "actuel" in period or "en cours" in period:
                status = "non disponible"
                break

    mapping = {
        "disponible":      1.0,
        "immédiatement":   1.0,
        "immédiat":        1.0,
        "30 jours":        0.7,
        "1 mois":          0.7,
        "60 jours":        0.4,
        "2 mois":          0.4,
        "3 mois":          0.2,
        "non disponible":  0.0,
    }
    for key, val in mapping.items():
        if key in status:
            return round(val * WEIGHTS["availability"], 2)

    return round(0.5 * WEIGHTS["availability"], 2)  # inconnue → neutre


def _score_missions(need: dict, cv: dict) -> float:
    """10 pts — Pertinence des missions / clients / secteur."""
    all_text = _get_all_text(cv)

    signals = []
    for field in ("client", "sector", "context"):
        val = (need.get(field) or "").strip()
        if val:
            signals.append(_keyword_overlap(val, all_text))

    # Bonus si required_skills trouvées dans les descriptions d'expériences
    req_skills = [normalize_one(s).lower() for s in (need.get("required_skills") or [])]
    if req_skills:
        exp_text = " ".join(
            (exp.get("env_technique") or "") + " " + (exp.get("description") or "")
            for exp in (cv.get("experience") or [])
        ).lower()
        skill_in_exp = sum(1 for s in req_skills if s in exp_text) / max(len(req_skills), 1)
        signals.append(skill_in_exp)

    if not signals:
        return WEIGHTS["missions"] * 0.4  # neutre

    avg = sum(signals) / len(signals)
    return round(avg * WEIGHTS["missions"], 2)


def _score_bonus(need: dict, cv: dict) -> tuple[float, list[str]]:
    """10 pts — Bonus : langue, certifications, cloud, localisation, contrat."""
    max_pts = WEIGHTS["bonus"]
    points  = 0.0
    bonuses = []
    maluses = []

    # Langue (2 pts)
    req_langs = [l.lower() for l in (need.get("languages") or [])]
    cv_langs  = [
        (l.get("language") or l.get("name") or "").lower()
        for l in (cv.get("languages") or [])
    ]
    cv_lang_text = " ".join(cv_langs)
    for lang in req_langs:
        if lang in cv_lang_text:
            points += 2
            bonuses.append(f"{lang.capitalize()} ✓")
            break
    else:
        if req_langs:
            maluses.append(f"Langue requise ({', '.join(req_langs)}) non confirmée")

    # Certifications (2 pts)
    certs = cv.get("certifications") or []
    if certs:
        points += 2
        bonuses.append(f"{len(certs)} certification(s)")

    # Cloud / moderne (2 pts)
    cloud_kw = {"aws", "azure", "gcp", "cloud", "databricks", "snowflake", "kubernetes", "docker"}
    skill_text = " ".join(_get_skills_flat(cv))
    if any(kw in skill_text for kw in cloud_kw):
        points += 2
        bonuses.append("Compétences cloud/DevOps")

    # Localisation (2 pts)
    need_loc = (need.get("location") or "").lower()
    cv_loc   = (cv.get("contact", {}).get("location") or "").lower()
    if need_loc and cv_loc:
        if need_loc in cv_loc or cv_loc in need_loc or _sim(need_loc, cv_loc) > 0.7:
            points += 2
            bonuses.append("Localisation compatible")
        else:
            remote = (need.get("remote") or "").lower()
            if "remote" in remote or "flex" in remote:
                points += 1
                bonuses.append("Remote possible")
            else:
                maluses.append(f"Localisation à vérifier ({cv_loc} vs {need_loc})")

    # Type de contrat (2 pts)
    need_contract = (need.get("contract_type") or "Tous").lower()
    if need_contract not in ("tous", "all", ""):
        # Chercher dans le titre du CV
        cv_text_lower = _get_all_text(cv)
        if need_contract in cv_text_lower:
            points += 2
            bonuses.append(f"Contrat {need.get('contract_type')} ✓")

    return round(min(points, max_pts), 2), maluses


# ══════════════════════════════════════════════════════════════════════════════
# EXPLICATION RICHE
# ══════════════════════════════════════════════════════════════════════════════

def _build_explanation(
    need: dict,
    cv: dict,
    scores: dict,
    missing_skills: list[str],
    maluses: list[str],
) -> dict:
    strengths    = []
    weaknesses   = []
    reservations = []

    name  = cv.get("name", "Ce candidat")
    total = scores["total"]

    # Compétences obligatoires
    req = need.get("required_skills") or []
    if missing_skills:
        nb_missing = len(missing_skills)
        nb_req     = len(req)
        weaknesses.append(
            f"Compétences manquantes ({nb_missing}/{nb_req}) : {', '.join(missing_skills[:5])}"
        )
    elif req:
        strengths.append(f"Toutes les compétences obligatoires sont couvertes")

    # Titre
    if scores["title"] >= 12:
        strengths.append(f"Profil très proche du poste ({cv.get('title', '')})")
    elif scores["title"] <= 6:
        weaknesses.append(f"Titre candidat éloigné : {cv.get('title', '')}")

    # Séniorité
    cv_years = cv.get("years_experience", 0) or 0
    min_years = need.get("min_years", 0) or 0
    if cv_years >= (min_years or 0):
        strengths.append(f"{cv_years} ans d'expérience")
    else:
        weaknesses.append(f"Expérience insuffisante ({cv_years} ans requis : {min_years}+)")

    # Disponibilité
    avail = cv.get("availability_status", "")
    if avail:
        if scores["availability"] >= 8:
            strengths.append(f"Disponibilité : {avail}")
        elif scores["availability"] == 0:
            weaknesses.append(f"Non disponible ({avail})")
        else:
            reservations.append(f"Disponibilité à confirmer : {avail}")
    else:
        reservations.append("Disponibilité non renseignée — à confirmer")

    # Bonus / malus
    for m in maluses:
        reservations.append(m)

    # Résumé
    if total >= 75:
        summary = f"Excellent match ({total:.0f}/100). {name} répond aux critères clés."
    elif total >= 55:
        summary = f"Bon profil ({total:.0f}/100) avec quelques points à valider."
    elif total >= 35:
        summary = f"Profil partiel ({total:.0f}/100). Des lacunes à discuter."
    else:
        summary = f"Match faible ({total:.0f}/100). Profil éloigné du besoin."

    return {
        "strengths":      strengths,
        "weaknesses":     weaknesses,
        "reservations":   reservations,
        "missing_skills": missing_skills,
        "summary":        summary,
    }


# ══════════════════════════════════════════════════════════════════════════════
# POINT D'ENTRÉE
# ══════════════════════════════════════════════════════════════════════════════

def run_matching(need: dict, limit: int = 50, ids: list[str] | None = None) -> list[dict]:
    """
    Calcule le score de chaque candidat de la CVthèque vs le besoin.
    Retourne la liste triée du meilleur au moins bon.

    `ids` restreint la comparaison à une sélection de candidats : c'est le cas
    d'usage « je colle une fiche de poste et je compare ces dix CV », où passer
    toute la CVthèque n'aurait aucun sens.
    """
    db = _load_cv_db()
    if ids:
        retenus = [i for i in ids if i in db]
        db = {i: db[i] for i in retenus}
    results = []

    for cid, cv in db.items():
        candidate_skills = _get_skills_flat(cv)
        skill_score, missing_skills = _score_skills(need, candidate_skills)
        title_score       = _score_title(need, cv)
        seniority_score   = _score_seniority(need, cv)
        avail_score       = _score_availability(cv)
        mission_score     = _score_missions(need, cv)
        bonus_score, maluses = _score_bonus(need, cv)

        total = (
            skill_score + title_score + seniority_score
            + avail_score + mission_score + bonus_score
        )
        total = round(min(total, 100.0), 2)

        scores = {
            "total":        total,
            "skills":       skill_score,
            "title":        title_score,
            "seniority":    seniority_score,
            "availability": avail_score,
            "missions":     mission_score,
            "bonus":        bonus_score,
        }
        explanation = _build_explanation(need, cv, scores, missing_skills, maluses)

        contact = cv.get("contact") or {}
        results.append({
            "candidate_id":    cid,
            "candidate_name":  cv.get("name", ""),
            "candidate_title": cv.get("title", ""),
            "score":           scores,
            "explanation":     explanation,
            "email":           contact.get("email", ""),
            "phone":           contact.get("phone", ""),
            "location":        contact.get("location", ""),
            "availability":    cv.get("availability_status", ""),
            "top_skills":      candidate_skills[:8],
        })

    # Trier par score décroissant
    results.sort(key=lambda r: r["score"]["total"], reverse=True)

    # Affecter les rangs
    for i, r in enumerate(results):
        r["rank"] = i + 1

    return results[:limit]
