"""
core/rapprochement.py — comparer une fiche de poste à une sélection de CV.

Complète le matching existant, qui compare un besoin **enregistré** à toute la
CVthèque. Ici on part d'un texte libre — la fiche de poste telle qu'on l'a
reçue — et on la confronte aux quelques CV qu'on a en tête.

Deux étages, volontairement séparés :

  1. Le texte est transformé en besoin structuré par un modèle de langage.
     C'est le seul endroit qui en a besoin : lire une annonce rédigée en prose
     et en extraire compétences, séniorité et localisation.

  2. Le classement est ensuite calculé par le moteur déterministe existant
     (`core/matcher`), qui produit déjà score, points forts et points faibles.
     Un score doit être reproductible et explicable : le confier à un modèle
     donnerait un résultat différent à chaque exécution, impossible à
     justifier devant un client.
"""

from __future__ import annotations

import json
import re

from core.matcher import run_matching, _load_cv_db

# Note à partir de laquelle un profil entre au classement. En deçà, il reste
# affiché mais hors classement : la sélection doit trancher, pas ordonner des
# profils qu'on ne présentera pas.
SEUIL_CLASSEMENT = 80

# Champs attendus par le moteur de matching.
_GABARIT = {
    "title": "", "required_skills": [], "seniority": "", "min_years": 0,
    "location": "", "contract_type": "", "languages": [], "remote": "",
}

_PROMPT = """Tu lis une fiche de poste et tu en extrais les critères de recrutement.
Réponds UNIQUEMENT par un objet JSON, sans texte autour, avec exactement ces clés :
{"title":"","required_skills":[],"seniority":"","min_years":0,"location":"","contract_type":"","languages":[],"remote":""}

Règles :
- "title" : l'intitulé du poste, tel qu'écrit.
- "required_skills" : les technologies et compétences EXIGÉES, une par entrée, sans phrase.
- "seniority" : junior, confirmé, senior ou expert — au vu de l'expérience demandée.
- "min_years" : nombre d'années d'expérience minimum, 0 si non précisé.
- "contract_type" : CDI, freelance, portage, stage ou alternance ; "" si absent.
- "remote" : "full", "hybride" ou "sur site" ; "" si absent.
- N'invente rien : ce qui n'est pas dans le texte reste vide."""


def besoin_depuis_texte(description: str, appel_llm) -> dict:
    """
    Transforme une fiche de poste en besoin structuré.

    `appel_llm` est injecté (et non importé) pour que ce module reste testable
    sans réseau, et pour éviter une dépendance croisée avec l'application.
    """
    texte = (description or "").strip()
    if not texte:
        return dict(_GABARIT)

    contenu, _service = appel_llm(
        [{"role": "system", "content": _PROMPT},
         {"role": "user", "content": f"Fiche de poste :\n---\n{texte[:8000]}\n---"}],
        max_tokens=1200, temperature=0, json_mode=True,
    )

    trouve = re.search(r"\{[\s\S]*\}", contenu or "")
    if not trouve:
        raise ValueError("Le modèle n'a pas renvoyé de JSON exploitable.")
    brut = json.loads(trouve.group(0))

    besoin = dict(_GABARIT)
    for cle, defaut in _GABARIT.items():
        valeur = brut.get(cle, defaut)
        if isinstance(defaut, list):
            besoin[cle] = [str(v).strip() for v in (valeur or []) if str(v).strip()]
        elif isinstance(defaut, int):
            try:
                besoin[cle] = int(valeur or 0)
            except (TypeError, ValueError):
                besoin[cle] = 0
        else:
            besoin[cle] = str(valeur or "").strip()
    return besoin


def besoin_de_secours(description: str) -> dict:
    """
    Besoin déduit sans modèle de langage, quand aucun ne répond.

    On ne sait pas lire la prose, mais on sait repérer un intitulé en première
    ligne et une durée d'expérience. Le classement reste alors possible, en
    s'appuyant surtout sur la proximité de titre et les mots-clés.
    """
    lignes = [l.strip() for l in (description or "").splitlines() if l.strip()]
    besoin = dict(_GABARIT)
    if lignes:
        besoin["title"] = lignes[0][:80]
    annees = re.search(r"(\d{1,2})\s*(?:ans|années)", description or "", re.I)
    if annees:
        besoin["min_years"] = int(annees.group(1))
        besoin["seniority"] = ("junior" if besoin["min_years"] <= 2 else
                               "confirmé" if besoin["min_years"] <= 5 else
                               "senior" if besoin["min_years"] <= 9 else "expert")
    return besoin


_PROMPT_AVIS = """Tu es consultant en recrutement. Tu compares des candidats à une fiche de poste.

Pour CHAQUE candidat fourni, rends un objet avec :
- "id" : l'identifiant du candidat, recopié tel quel
- "forts" : 2 à 4 arguments concrets qui le rapprochent du poste
- "faibles" : 1 à 3 réserves ou manques réels
- "avis" : une phrase de synthèse, franche
- "score" : de 0 à 100, l'adéquation au poste

Réponds UNIQUEMENT par {"candidats":[...]} en JSON, sans texte autour.
Appuie-toi sur ce qui est écrit : n'invente aucune compétence, ne suppose
aucune disponibilité. Un candidat éloigné du poste doit avoir un score bas et
des réserves explicites — un classement où tout le monde convient ne sert à rien."""


def _resume_candidat(resultat: dict, cv: dict) -> str:
    """Profil condensé envoyé au modèle : assez pour juger, assez court pour
    que dix candidats tiennent dans une seule requête."""
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


def _depouiller(contenu: str) -> dict:
    """Lit la réponse d'un modèle et la range par identifiant de candidat."""
    trouve = re.search(r"\{[\s\S]*\}", contenu or "")
    if not trouve:
        raise ValueError("réponse non exploitable")
    brut = json.loads(trouve.group(0))

    par_id = {}
    for c in (brut.get("candidats") or []):
        identifiant = str(c.get("id") or "").strip()
        if not identifiant:
            continue
        try:
            score = max(0, min(100, int(float(c.get("score") or 0))))
        except (TypeError, ValueError):
            score = 0
        par_id[identifiant] = {
            "forts": [str(x).strip() for x in (c.get("forts") or []) if str(x).strip()][:4],
            "faibles": [str(x).strip() for x in (c.get("faibles") or []) if str(x).strip()][:3],
            "avis": str(c.get("avis") or "").strip(),
            "score": score,
        }
    return par_id


def _consensus(par_modele: list) -> dict:
    """
    Fusionne en un seul avis ceux rendus par plusieurs modèles.

    Le score retenu est la moyenne des voix : un modèle isolément sévère ou
    complaisant ne fait plus basculer un candidat d'un côté ou de l'autre du
    seuil à lui tout seul.

    Les arguments, eux, sont repris du modèle le plus proche de cette moyenne,
    et non mélangés : trois commentaires entremêlés se contredisent, et le
    texte affiché doit correspondre à la note affichée. L'écart entre voix est
    conservé (`score_min`, `score_max`) pour qu'un désaccord se voie au lieu de
    disparaître dans la moyenne.
    """
    identifiants = {i for avis, _ in par_modele for i in avis}
    fusion = {}
    for identifiant in identifiants:
        voix = [(avis[identifiant], nom) for avis, nom in par_modele if identifiant in avis]
        notes = [v["score"] for v, _ in voix]
        moyenne = round(sum(notes) / len(notes))
        proche, _nom = min(voix, key=lambda v: abs(v[0]["score"] - moyenne))
        fusion[identifiant] = {
            **proche,
            "score": moyenne,
            "nb_modeles": len(voix),
            "score_min": min(notes),
            "score_max": max(notes),
            "modeles": [nom for _, nom in voix],
        }
    return fusion


def avis_ia(description: str, resultats: list, cv_db: dict, appels_llm,
            nombre_modeles: int = 3) -> tuple:
    """
    Analyse des candidats par plusieurs modèles de langage.

    Un seul appel par modèle pour TOUTE la sélection : dix appels séparés
    épuiseraient le quota du palier gratuit avant la fin du classement, et un
    modèle juge mieux en voyant les candidats les uns à côté des autres.

    Renvoie (avis fusionnés, liste des modèles ayant répondu).
    """
    if not resultats:
        return {}, []

    profils = "\n\n".join(
        _resume_candidat(r, cv_db.get(r["candidate_id"], {})) for r in resultats
    )
    messages = [
        {"role": "system", "content": _PROMPT_AVIS},
        {"role": "user", "content":
         f"FICHE DE POSTE :\n---\n{(description or '')[:4000]}\n---\n\n"
         f"CANDIDATS :\n{profils[:14000]}"},
    ]
    reponses = appels_llm(messages, nombre=nombre_modeles, max_tokens=4000,
                          temperature=0.1, json_mode=True, timeout=120)

    # Un modèle qui renvoie des identifiants inventés n'a pas voté : on ne le
    # compte pas parmi les voix. Sans ce filtre, l'écran annonçait « 2 modèles
    # recoupés » alors qu'un seul portait sur les bons candidats.
    connus = {r["candidate_id"] for r in resultats}
    par_modele = []
    for contenu, service in reponses:
        try:
            avis = {i: v for i, v in _depouiller(contenu).items() if i in connus}
        except Exception as err:
            print(f"[RAPPROCHEMENT] avis illisible de {service} : {err}")
            continue
        if not avis:
            print(f"[RAPPROCHEMENT] {service} n'a reconnu aucun candidat — voix ignorée.")
            continue
        par_modele.append((avis, service))
    if not par_modele:
        raise ValueError("aucun avis exploitable")

    return _consensus(par_modele), [nom for _, nom in par_modele]


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


def classer(description: str, identifiants: list, appel_llm=None,
            appels_llm=None, nombre_modeles: int = 3, progression=None) -> dict:
    """
    Classe les CV choisis face à la fiche de poste.

    Renvoie {besoin, resultats, source_besoin} — `source_besoin` dit si les
    critères viennent du modèle ou du repli, pour que l'interface puisse
    nuancer le résultat plutôt que de le présenter comme définitif.

    `progression(etape, detail)` est appelé au fil du traitement. Deux appels
    au modèle s'enchaînent ici, soit près d'une minute d'attente : l'écran doit
    pouvoir dire où il en est, et le dire d'après ce qui se passe réellement.
    Rappeler la même étape en met simplement le détail à jour.
    """
    dire = progression or (lambda etape, detail="": None)

    # Repli : un appelant qui ne fournit qu'une fonction d'appel simple obtient
    # une seule voix plutôt que rien du tout.
    if appels_llm is None and appel_llm is not None:
        appels_llm = lambda messages, nombre=1, **reste: [appel_llm(messages, **reste)]

    dire("lecture")
    source = "modèle de langage"
    besoin = None
    if appel_llm:
        try:
            besoin = besoin_depuis_texte(description, appel_llm)
        except Exception as err:
            print(f"[RAPPROCHEMENT] extraction par le modèle impossible : {err}")
    if not besoin or not (besoin.get("title") or besoin.get("required_skills")):
        besoin = besoin_de_secours(description)
        source = "lecture locale (aucun modèle disponible)"
    dire("lecture", _resume_besoin(besoin))

    dire("comparaison", f"{len(identifiants)} CV confrontés aux critères")
    resultats = run_matching(besoin, limit=len(identifiants) or 50, ids=identifiants)
    dire("comparaison", f"{len(resultats)} profil{'s' if len(resultats) > 1 else ''} "
                        f"noté{'s' if len(resultats) > 1 else ''} par les règles")

    # Analyse par le modèle : elle apporte le jugement qualitatif que des
    # règles ne savent pas produire — pourquoi ce profil convient, ce qui
    # manque vraiment. Le score chiffré, lui, reste calculé par les règles ;
    # les deux sont combinés et affichés séparément, pour qu'un écart entre
    # eux se voie plutôt que de se dissoudre dans une moyenne.
    avis, source_avis, modeles = {}, "aucune (modèle indisponible)", []
    if appels_llm and resultats:
        dire("analyse", f"{nombre_modeles} modèles lisent les {len(resultats)} profils")
        try:
            avis, modeles = avis_ia(description, resultats, _load_cv_db(),
                                    appels_llm, nombre_modeles)
            source_avis = f"{len(modeles)} modèle{'s' if len(modeles) > 1 else ''} recoupé" \
                          f"{'s' if len(modeles) > 1 else ''}"
            dire("analyse", f"{len(modeles)} modèle{'s' if len(modeles) > 1 else ''} "
                            f"ont rendu leur avis : " + ", ".join(
                                m.split("/")[-1] for m in modeles))
        except Exception as err:
            print(f"[RAPPROCHEMENT] analyse par les modèles impossible : {err}")
            dire("analyse", "modèles indisponibles — classement sur les seules règles")
    else:
        dire("analyse", "aucun modèle disponible")

    dire("classement")
    for r in resultats:
        a = avis.get(r["candidate_id"])
        r["ia"] = a
        regles = r["score"]["total"]
        r["score_regles"] = regles
        r["score_ia"] = a["score"] if a else None
        # 60 % règles, 40 % modèle : les règles restent majoritaires parce
        # qu'elles sont reproductibles et justifiables ligne à ligne.
        r["score"]["total"] = round(regles * 0.6 + a["score"] * 0.4, 1) if a else regles

    resultats.sort(key=lambda r: r["score"]["total"], reverse=True)

    # Seuil de présentation : seuls les profils à SEUIL_CLASSEMENT et plus sont
    # classés. Les autres restent visibles — on veut savoir qui a été écarté et
    # pourquoi — mais hors numérotation : un rang laisse croire à un candidat
    # présentable, alors qu'un profil sous le seuil ne part pas chez le client.
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
        dire("classement", f"{retenus} profil{'s' if retenus > 1 else ''} "
                           f"au-dessus de {SEUIL_CLASSEMENT}/100 — en tête : "
                           f"{premier.get('candidate_name') or 'sans nom'} "
                           f"({premier['score']['total']}/100)")
    else:
        dire("classement", f"aucun profil n'atteint {SEUIL_CLASSEMENT}/100")

    return {"besoin": besoin, "resultats": resultats, "seuil": SEUIL_CLASSEMENT,
            "nb_retenus": retenus, "nb_ecartes": len(resultats) - retenus,
            "modeles": modeles,
            "source_besoin": source, "source_avis": source_avis}
