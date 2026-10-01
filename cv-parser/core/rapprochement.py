"""core/rapprochement.py — classer une sélection de CV face à une fiche de poste : lecture structurée, puis règles."""

from __future__ import annotations

import re
import traceback

from core.matcher import run_matching, _load_cv_db

# Note à partir de laquelle un profil entre au classement ; en deçà, il reste affiché hors rang.
SEUIL_CLASSEMENT = 80

# Champs attendus par le moteur de matching.
_GABARIT = {
    "title": "", "required_skills": [], "seniority": "", "min_years": 0,
    "location": "", "contract_type": "", "languages": [], "remote": "",
}

_SENIORITES = {"junior": "junior", "confirme": "confirmé", "confirmé": "confirmé",
               "senior": "senior", "expert": "expert"}

COMPETENCES_LUES_MAX = 15

_CONTRATS = (("cdi", "CDI"), ("freelance", "freelance"), ("portage", "portage"),
             ("alternance", "alternance"), ("stage", "stage"))
_TELETRAVAIL = (("full remote", "full"), ("100% télétravail", "full"), ("hybride", "hybride"),
                ("sur site", "sur site"), ("présentiel", "sur site"))


def _seniorite_depuis_annees(annees: int) -> str:
    return ("junior" if annees <= 2 else "confirmé" if annees <= 5 else
            "senior" if annees <= 9 else "expert")


def _annees(valeur) -> int:
    trouve = re.search(r"\d{1,2}", str(valeur or ""))
    return int(trouve.group(0)) if trouve else 0


def _texte_liste(valeur) -> list:
    if isinstance(valeur, str):
        valeur = re.split(r"[,;\n]", valeur)
    sortie = []
    for v in valeur or []:
        if isinstance(v, dict):
            v = next((x for x in v.values() if isinstance(x, str)), "")
        v = str(v or "").strip()
        if v and v.lower() not in {s.lower() for s in sortie}:
            sortie.append(v)
    return sortie


def besoin_depuis_resultat(brut: dict) -> dict:
    """Résultat d'extraction `fiche_de_poste` (enveloppes retirées) -> besoin attendu par run_matching."""
    brut = brut if isinstance(brut, dict) else {}
    besoin = dict(_GABARIT)
    besoin["title"] = str(brut.get("title") or "").strip()
    besoin["required_skills"] = _texte_liste(brut.get("required_skills"))
    besoin["languages"] = _texte_liste(brut.get("languages"))
    besoin["min_years"] = _annees(brut.get("min_years"))
    for cle in ("location", "contract_type", "remote"):
        besoin[cle] = str(brut.get(cle) or "").strip()
    seniorite = _SENIORITES.get(str(brut.get("seniority") or "").strip().lower(), "")
    besoin["seniority"] = seniorite or (_seniorite_depuis_annees(besoin["min_years"]) if besoin["min_years"] else "")
    return besoin


def vocabulaire(cv_db: dict) -> list:
    """Compétences déjà présentes dans la CVthèque, telles qu'écrites sur les fiches."""
    vus = {}
    for cv in (cv_db or {}).values():
        for s in cv.get("skills_flat") or []:
            s = str(s or "").strip()
            if len(s) >= 3 or re.search(r"[^A-Za-z]", s):
                vus.setdefault(s.lower(), s)
    return list(vus.values())


def besoin_de_secours(description: str, competences=()) -> dict:
    """Besoin lu sans modèle : intitulé, années, contrat, télétravail et compétences connues de la CVthèque."""
    texte = description or ""
    bas = texte.lower()
    lignes = [l.strip() for l in texte.splitlines() if l.strip()]
    besoin = dict(_GABARIT)
    if lignes:
        besoin["title"] = lignes[0][:80]
    annees = re.search(r"(\d{1,2})\s*(?:ans|années|years)", texte, re.I)
    if annees:
        besoin["min_years"] = int(annees.group(1))
        besoin["seniority"] = _seniorite_depuis_annees(besoin["min_years"])
    trouvees = []
    for c in competences:
        m = re.search(r"(?<![\w+#.])" + re.escape(c.lower()) + r"(?![\w+#])", bas)
        if m:
            trouvees.append((m.start(), c))
    besoin["required_skills"] = [c for _, c in sorted(trouvees)][:COMPETENCES_LUES_MAX]
    besoin["contract_type"] = next((v for k, v in _CONTRATS if re.search(r"\b" + k + r"\b", bas)), "")
    besoin["remote"] = next((v for k, v in _TELETRAVAIL if k in bas), "")
    return besoin


def _resume_candidat(resultat: dict, cv: dict) -> str:
    """Profil condensé envoyé au modèle : assez pour juger, assez court pour tenir à plusieurs."""
    exp = []
    for e in (cv.get("experience") or [])[:4]:
        ligne = " / ".join(x for x in (
            str(e.get("title") or ""), str(e.get("company") or ""),
            str(e.get("period") or "")) if x)
        techno = str(e.get("env_technique") or "")[:120]
        exp.append(f"    · {ligne}" + (f" [{techno}]" if techno else ""))

    compétences = []
    for f in (cv.get("skills") or [])[:6]:
        items = ", ".join(str(i) for i in (f.get("items") or [])[:12])
        if items:
            compétences.append(f"{f.get('category')}: {items}")

    return "\n".join([
        f"id: {resultat['candidate_id']}",
        f"  titre: {cv.get('title') or '—'}  ({cv.get('years_experience') or 0} ans)",
        f"  compétences: {' | '.join(compétences)[:600]}",
        "  missions:", *exp,
    ])


def _resume_besoin(besoin: dict) -> str:
    """Ce que la lecture de la fiche a effectivement retenu, en une ligne."""
    morceaux = [besoin.get("title") or "intitulé non repéré"]
    if besoin.get("seniority"):
        morceaux.append(besoin["seniority"])
    if besoin.get("min_years"):
        morceaux.append(f"{besoin['min_years']} ans min")
    nb = len(besoin.get("required_skills") or [])
    if nb:
        morceaux.append(f"{nb} compétence{'s' if nb > 1 else ''} exigée{'s' if nb > 1 else ''}")
    return " · ".join(morceaux)


def classer(description: str, identifiants: list, lire=None, progression=None) -> dict:
    """Classe les CV choisis face à la fiche : `lire(description) -> (résultat brut, modèle)` injecté, repli local sinon."""
    dire = progression or (lambda etape, detail="": None)

    dire("lecture")
    besoin, modele_lecture, erreur_lecture = None, None, None
    if lire:
        try:
            brut, modele_lecture = lire(description)
            besoin = besoin_depuis_resultat(brut)
        except Exception as err:
            erreur_lecture = getattr(err, "public", None)
            if not erreur_lecture:
                erreur_lecture = "Lecture par le modèle impossible."
                traceback.print_exc()
    source = f"modèle ({modele_lecture})" if besoin else "lecture locale"
    if not besoin or not (besoin.get("title") or besoin.get("required_skills")):
        if besoin is not None:
            erreur_lecture = f"{modele_lecture} n'a repéré ni intitulé ni compétences dans la fiche."
        besoin = besoin_de_secours(description, vocabulaire(_load_cv_db()))
        source, modele_lecture = "lecture locale", None
    dire("lecture", _resume_besoin(besoin))

    dire("comparaison", f"{len(identifiants)} CV confrontés aux critères")
    resultats = run_matching(besoin, limit=len(identifiants) or 50, ids=identifiants)
    resultats.sort(key=lambda r: r["score"]["total"], reverse=True)

    retenus = 0
    for r in resultats:
        r["retenu"] = r["score"]["total"] >= SEUIL_CLASSEMENT
        if r["retenu"]:
            retenus += 1
            r["rank"] = retenus
        else:
            r["rank"] = None

    if retenus:
        premier = resultats[0]
        dire("comparaison", f"{retenus} profil{'s' if retenus > 1 else ''} "
                            f"au-dessus de {SEUIL_CLASSEMENT}/100 — en tête : "
                            f"{premier.get('candidate_name') or 'sans nom'} "
                            f"({premier['score']['total']}/100)")
    else:
        dire("comparaison", f"aucun profil n'atteint {SEUIL_CLASSEMENT}/100")

    return {"besoin": besoin, "resultats": resultats, "seuil": SEUIL_CLASSEMENT,
            "nb_retenus": retenus, "nb_ecartes": len(resultats) - retenus,
            "source_besoin": source, "modele_lecture": modele_lecture,
            "erreur_lecture": erreur_lecture}
