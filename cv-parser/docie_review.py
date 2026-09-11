"""Ce que DocIE dit de SA PROPRE extraction, traduit en signal de relecture.

DocIE ne renvoie pas que des valeurs : chaque feuille ancrée arrive enveloppée
(`{value, confidence, evidence_ids}`) et l'agent joint un bloc `validation`
(`{valid, errors, warnings}`). Jusqu'ici cv-parser jetait tout : la confiance
par champ disparaissait au déballage, et `validation` ne servait qu'à lever un
`parse_warning` générique (« relisez la fiche »), sans dire QUEL champ relire.
Une extraction tronquée atterrissait donc dans la CVthèque avec l'apparence
d'une fiche complète — puis était cherchée et rapprochée d'un besoin comme
telle (issue #172, suite listée « hors périmètre » de #173).

Ce module ne fait que traduire, il n'appelle rien :

    revue_docie(data, metadata) -> {"needs_review": [...], "warnings": [...]}

`data` est la sortie de `docie_client.map_resume` (avant normalisation),
`metadata` celle de `docie_bridge_extraction.extract_resume`. Le vocabulaire
est CELUI DE one-pager (`quality.needs_review` / `quality.warnings`, PR #173) :
même seuil, mêmes préfixes d'avertissement, même règle « un chemin sans
équivalent sort en avertissement plutôt qu'en faux chemin ». Deux écrans qui
signalent la même chose doivent le signaler pareil.

Ce que DocIE émet et que ce module NE fait PAS :
  - il n'analyse jamais la prose de `validation.warnings` pour en déduire un
    nom de champ : ce texte n'a aucun format stable, il est repris verbatim ;
  - il n'utilise jamais `model_logprob` (ex-`model_confidence`) comme seuil :
    c'est une log-probabilité (<= 0, non renormalisée), pas un score 0-1 ; la
    comparer à 0.5 signalerait tout champ qui en porte une.
"""
# Le tri des missions appliqué par app.py::normalize_cv_data (#177 ligne 7).
# Importé plutôt que réécrit : une marque ne suit sa mission que si les deux
# appliquent exactement la même permutation.
from periode_mission import ordre_missions, titre_de_repli

# DocIE plafonne à EXACTEMENT 0.5 la confiance d'un champ dont il a dû tronquer
# une liste qui bouclait : la valeur rendue est alors partielle sans que rien,
# dans la fiche, ne le montre. `<= 0.5` est donc le critère sûr de « à relire ».
# Même seuil que one-pager/lib/docie-extract.js::SEUIL_CONFIANCE.
SEUIL_CONFIANCE = 0.5

# ── Chemin DocIE -> chemin de la fiche cv-parser ─────────────────────────────
# Les clés sont les noms de champs du schéma RÉELLEMENT servi
# (cv-parser/adbi_resume.schema.json), verbatim : `name`, `experience[0]
# .start_date`. La table est donc statique et exacte ; un chemin absent de ces
# tables n'est jamais deviné (voir _chemin_fiche).
CHAMPS_RACINE = {"name": "name", "title": "title"}

# `github` est volontairement absent : la fiche le stocke, mais aucun des deux
# onglets de cv_detail.html ne l'affiche. Le marquer ferait annoncer « 1 champ à
# relire » au bandeau sans que rien ne soit marqué nulle part — même traitement
# que experience[].location : avertissement générique, pas faux chemin.
CHAMPS_CONTACT = {"email", "phone", "linkedin", "location"}

# `start_date`/`end_date` sont fusionnés en `period` par map_resume ;
# `location` n'a pas de place dans le modèle de cv-parser et est supprimé à la
# normalisation (noté en suite dans #172) — donc pas de chemin de fiche.
CHAMPS_EXPERIENCE = {
    "company": "company",
    "title": "title",
    "start_date": "period",
    "end_date": "period",
    "description": "description",
    "env_technique": "env_technique",
}

# map_resume : degree -> title, institution -> subtitle, year -> period.
CHAMPS_EDUCATION = {"degree": "title", "institution": "subtitle", "year": "period"}

# `issuer` est supprimé à la normalisation, comme experience[].location.
CHAMPS_CERTIFICATIONS = {"name": "name", "year": "year"}

# Listes dont l'index DocIE mène à une ligne identifiable dans la fiche :
# normalize_cv_data les recopie sans en filtrer aucune. `skills`, `languages`
# et `interests` en revanche sont dédupliqués/filtrés (une catégorie sans item,
# une langue sans nom, un centre d'intérêt vide disparaissent) : l'index DocIE
# y désignerait la mauvaise ligne, on ne le traduit donc pas — le champ sort en
# avertissement générique plutôt qu'en surlignage d'une ligne au hasard.
#
# `experience` est le seul cas où l'index ne survit PAS tel quel : depuis #177
# ligne 7, normalize_cv_data range les missions de la plus récente à la plus
# ancienne. L'index DocIE y est donc traduit par la permutation de tri (voir
# `positions_apres_tri`), calculée par la MÊME fonction, sur la MÊME liste, que
# celle qu'applique normalize_cv_data — un index non traduit surlignerait une
# autre mission que celle dont DocIE doute, ce qui est pire que rien.
LISTES_ALIGNEES = {
    "experience": CHAMPS_EXPERIENCE,
    "education": CHAMPS_EDUCATION,
    "certifications": CHAMPS_CERTIFICATIONS,
}

# Seule liste réordonnée par normalize_cv_data ; les autres gardent l'ordre
# DocIE, leur permutation est donc l'identité.
LISTES_REORDONNEES = ("experience",)

# Avertissement posé quand la fiche porte un titre que DocIE n'a PAS rendu.
# Chaîne identique — caractère pour caractère — à celle de
# one-pager/lib/docie-extract.js : les deux écrans signalent le même fait, ils
# doivent le nommer pareil. Un test épingle la chaîne dans le fichier JS.
AVERTISSEMENT_TITRE_DEDUIT = "titre_deduit_de_la_mission_la_plus_recente"

# Champs dont la confiance de DocIE ne dit pas ce que la fiche affiche.
#
# `years_experience` : cv-parser le recalcule depuis les périodes
# (compute_years_experience, app.py). Depuis la #177 ligne 3 il ne l'écrase
# plus que si au moins une période est lisible : la valeur de DocIE PEUT donc
# désormais atterrir telle quelle dans la fiche, et sa confiance dirait alors
# quelque chose de ce qu'on affiche. Le champ reste pourtant ignoré ici : le
# marquer demanderait d'ajouter le liant `a-verifier` à
# templates/cv_detail.html (le champ y est éditable, ligne ~722, mais n'a
# aucune marque), c'est-à-dire de toucher le gabarit dans une passe qui ne
# corrige qu'un mapping. Choix de portée, pas un oubli — noté en #177.
CHAMPS_IGNORES = {"years_experience"}

# Feuilles d'une liste de scalaires : le schéma les décrit comme des objets
# (`skills[].items[].item`, `interests[].interest`) mais map_resume les aplatit
# en chaînes. Le chemin de confiance garde le nom de la feuille — sans ce
# repli, chercher la valeur à `skills[1].items[2].item` tomberait sur une
# chaîne, ne trouverait pas `.item`, et conclurait à tort « champ vide, rien à
# signaler » : exactement le champ douteux qu'on cherche à remonter.
FEUILLES_APLATIES = ("item", "interest")


def _segments(chemin):
    """« experience[0].start_date » -> ["experience", 0, "start_date"]."""
    segments = []
    for morceau in str(chemin).split("."):
        nom, _, reste = morceau.partition("[")
        if nom:
            segments.append(nom)
        for index in reste.rstrip("]").split("]["):
            if index.strip().isdigit():
                segments.append(int(index))
    return segments


def valeur_au_chemin(racine, chemin):
    """Valeur de `racine` au chemin DocIE donné, ou None si le chemin n'y mène pas."""
    segments = _segments(chemin)
    if len(segments) > 1 and segments[-1] in FEUILLES_APLATIES:
        segments = segments[:-1]
    valeur = racine
    for segment in segments:
        if isinstance(segment, int):
            if not isinstance(valeur, list) or not -len(valeur) <= segment < len(valeur):
                return None
            valeur = valeur[segment]
        else:
            if not isinstance(valeur, dict):
                return None
            valeur = valeur.get(segment)
    return valeur


def est_rempli(valeur):
    """Un champ VIDE à confiance nulle est une absence, pas un doute.

    Les absences sont déjà couvertes par le bilan ADBI (app.py::bilan_adbi) ;
    les signaler ici ferait de chaque `linkedin` non renseigné une alerte.
    """
    if valeur is None or isinstance(valeur, bool):
        return bool(valeur)
    if isinstance(valeur, str):
        return valeur.strip() != ""
    if isinstance(valeur, (list, dict)):
        return len(valeur) > 0
    return True


def positions_apres_tri(data):
    """Index DocIE -> position dans la fiche, par liste réordonnée.

    `normalize_cv_data` range les missions de la plus récente à la plus ancienne
    (#177 ligne 7) : `experience[0]` côté DocIE n'est plus `experience[0]` dans
    la fiche. On rejoue donc ici la MÊME fonction de tri sur la MÊME liste — la
    liste telle que `map_resume` la rend, celle que reçoit aussi
    `normalize_cv_data` — plutôt que de supposer l'un ou l'autre ordre.
    """
    data = data if isinstance(data, dict) else {}
    positions = {}
    for nom in LISTES_REORDONNEES:
        lignes = data.get(nom)
        lignes = lignes if isinstance(lignes, list) else []
        positions[nom] = {
            source: cible for cible, source in enumerate(ordre_missions(lignes))
        }
    return positions


def _chemin_fiche(chemin_docie, positions=None):
    """Chemin DocIE -> chemin dans la fiche cv-parser, "" s'il n'en a pas.

    "" n'est pas un échec : c'est un champ que la fiche n'expose pas (ou pas à
    un index fiable). L'appelant le remonte alors en avertissement générique —
    jamais en chemin inventé qui surlignerait le mauvais champ.

    `positions` traduit les index des listes réordonnées (voir
    `positions_apres_tri`). `None` signifie « aucune traduction connue » et
    laisse l'index tel quel ; une table fournie fait autorité, et un index
    qu'elle ne connaît pas (hors de la liste reçue) sort en "" plutôt qu'en
    position devinée.
    """
    segments = _segments(chemin_docie)
    if len(segments) == 1 and segments[0] in CHAMPS_RACINE:
        return CHAMPS_RACINE[segments[0]]
    if len(segments) == 2 and segments[0] == "contact" and segments[1] in CHAMPS_CONTACT:
        return "contact.%s" % segments[1]
    if len(segments) == 3 and isinstance(segments[1], int) and segments[0] in LISTES_ALIGNEES:
        champ = LISTES_ALIGNEES[segments[0]].get(segments[2])
        index = segments[1]
        if positions is not None and segments[0] in LISTES_REORDONNEES:
            index = positions.get(segments[0], {}).get(segments[1])
        if champ and index is not None and index >= 0:
            return "%s[%d].%s" % (segments[0], index, champ)
    return ""


def _texte_docie(entree):
    """`validation.errors[]` / `warnings[]` sont des chaînes côté DocIE."""
    if isinstance(entree, dict):
        for cle in ("message", "detail", "field"):
            if str(entree.get(cle) or "").strip():
                return str(entree[cle]).strip()
        return ""
    return str(entree or "").strip()


def revue_docie(data, metadata):
    """{"needs_review": [chemins de la fiche], "warnings": [messages]}.

    `needs_review` liste les champs que l'écran d'édition doit marquer « à
    vérifier » ; `warnings` ce que DocIE a dit, repris verbatim, à afficher au
    relecteur. Additif : des métadonnées sans les clés attendues (chemin
    historique `docie_client`, réponse d'une version antérieure de DocIE)
    donnent deux listes vides, donc le comportement actuel.
    """
    data = data if isinstance(data, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    needs_review, warnings = [], []
    # Les missions sont réordonnées par normalize_cv_data (#177 ligne 7) : sans
    # cette traduction, une marque posée sur `experience[0]` par DocIE
    # surlignerait la mission qui se trouve en tête APRÈS le tri, pas la sienne.
    positions = positions_apres_tri(data)

    # #177 ligne 2 : la fiche porte-t-elle un titre que DocIE n'a pas rendu ?
    # `normalize_cv_data` se replie sur le rôle de la mission la plus récente
    # quand `title` est vide — repli utile (une fiche sans intitulé est pire
    # qu'une fiche intitulée d'après sa dernière mission), mais qui ne doit
    # JAMAIS être silencieux : le relecteur doit savoir que cet en-tête est
    # déduit, pas lu. Même prédicat et même fonction que la normalisation,
    # appliqués à la même liste, donc les deux ne peuvent pas se contredire.
    #
    # Avertissement et non `needs_review` : c'est aussi l'arbitrage du JS
    # (lib/docie-extract.js, `else if (title_derive)`), et un titre ABSENT est
    # une absence, déjà du ressort du bilan ADBI — pas d'une marque par champ.
    if not est_rempli(data.get("title")) and titre_de_repli(data.get("experience")):
        warnings.append(AVERTISSEMENT_TITRE_DEDUIT)

    validation = metadata.get("validation")
    if validation is None:
        # `validation` accompagne toute extraction terminée (listes vides quand
        # tout va bien) : son absence n'est pas un succès, c'est une réponse
        # qu'on n'a pas pu vérifier. La taire serait présenter pour propre une
        # extraction dont personne n'a validé quoi que ce soit.
        if metadata:
            warnings.append("docie_validation_absente")
    elif isinstance(validation, dict):
        if validation.get("valid") is False:
            warnings.append("docie_validation_negative")
        for cle, prefixe in (("errors", "docie_erreur"), ("warnings", "docie_avertissement")):
            entrees = validation.get(cle)
            for entree in entrees if isinstance(entrees, list) else []:
                message = _texte_docie(entree)
                if message:
                    warnings.append("%s:%s" % (prefixe, message))

    confiances = metadata.get("field_confidence")
    for chemin_docie, confiance in (confiances if isinstance(confiances, dict) else {}).items():
        if isinstance(confiance, bool) or not isinstance(confiance, (int, float)):
            continue
        if confiance > SEUIL_CONFIANCE or confiance != confiance:  # NaN exclu
            continue
        if chemin_docie in CHAMPS_IGNORES:
            continue
        if not est_rempli(valeur_au_chemin(data, chemin_docie)):
            continue
        chemin = _chemin_fiche(chemin_docie, positions)
        if not chemin:
            warnings.append("docie_confiance_faible:%s" % chemin_docie)
        elif chemin not in needs_review:
            needs_review.append(chemin)

    return {"needs_review": needs_review, "warnings": warnings}


def perimer_revue(cv, updates):
    """Retire les marques « à vérifier » des rubriques que l'écran vient
    d'enregistrer (PATCH /api/cvs/<id>).

    Un PATCH remplace la rubrique ENTIÈRE — l'écran d'édition renvoie toute la
    liste des missions, pas le seul champ modifié (cv_detail.html::collectData)
    — et ces listes sont réordonnables à la souris. Garder
    `experience[0].company` après un enregistrement, c'est au mieux marquer un
    champ déjà corrigé, au pire surligner une AUTRE mission que celle dont
    DocIE doutait : exactement le mauvais champ signalé. La rubrique renvoyée
    a été relue à l'écran, la marque tombe avec elle.

    `warnings` n'est pas touché : ce sont des faits sur l'extraction (ce que
    DocIE a signalé, une validation absente), pas l'état d'un champ éditable.
    """
    revue = cv.get("docie_review")
    if not isinstance(revue, dict) or not revue.get("needs_review"):
        return
    cv["docie_review"] = {**revue, "needs_review": [
        chemin for chemin in revue["needs_review"]
        if str(chemin).split(".")[0].split("[")[0] not in updates]}
