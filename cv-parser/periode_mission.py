"""Les dates de mission d'un CV : les lire, et dire si la mission continue.

Deux questions, deux jeux d'essai partagés avec one-pager :

  - « cette mission est-elle toujours en cours ? »  ->
    document-parsing/fixtures/mission_en_cours.json (#177 lignes 4 à 6) ;
  - « quelle date ce texte porte-t-il ? »  ->
    document-parsing/fixtures/date_mission.json (#177 lignes 7, 8 et 9).

La seconde est arrivée après : cv-parser n'analysait **aucune** date. Il
collait les deux bouts en une chaîne (`period`) et y cherchait une année à
quatre chiffres, là où one-pager avait un vrai analyseur (`N.parseMonthYear`).
D'où trois divergences d'un coup sur le même CV — l'ordre des missions, le
mois de début, l'ancienneté totale.

« Cette mission est-elle toujours en cours ? » — liste de synonymes partagée.

DocIE type `experience[].start_date` / `end_date` en `date` dans le schéma
`adbi_resume`, mais les renvoie en **texte libre** : la vraie réponse
enregistrée dans le dépôt (document-parsing/fixtures/cv_samples/results/
simple_docie.json) porte « Mars 2022 » et « Aujourd'hui ». Chaque service doit
donc reconnaître lui-même « la mission continue », et les deux listes avaient
divergé — inventaire #177, lignes 4, 5 et 6 : le JS connaissait « actuel » sans
« maintenant », ce fichier-ci l'inverse.

Conséquence mesurée : une mission ouverte depuis mars 2019 dont DocIE rend
« Poste actuel » valait **0 an** d'expérience dans la CVthèque. C'est la base
que /api/needs/<id>/match classe : un senior devenait silencieusement
irrepérable.

Le motif ET le jeu d'essai sont partagés avec one-pager
(document-parsing/fixtures/mission_en_cours.json) ; le port JS vit dans
one-pager/lib/docie-extract.js. Les tests des deux côtés comparent leur motif à
ce fichier : une nouvelle divergence redevient un échec de test, pas une dérive
silencieuse.
"""
import re
import unicodedata
from datetime import datetime

# Le texte est désaccentué avant l'essai : le motif n'a donc que des formes sans
# accent (« present » couvre « Présent »), et il est identique — caractère pour
# caractère — au littéral JS et au champ `motif` de la fixture partagée.
# « ce jour » sans son « à » : dans « du 02/2022 à ce jour », le « à » est
# souvent déjà consommé comme séparateur de période.
MOTIF_MISSION_EN_COURS = r"\b(?:aujourd.?hui|ce\s+jour|actuel(?:le(?:ment)?)?|en\s+cours|maintenant|depuis|present|current|now|to\s+date)\b"
MISSION_EN_COURS_RE = re.compile(MOTIF_MISSION_EN_COURS, re.IGNORECASE)


def sans_accents(valeur) -> str:
    """« Présent » -> « present » ; même repli que N.deaccent côté JS."""
    return "".join(
        c for c in unicodedata.normalize("NFD", str(valeur or ""))
        if not unicodedata.combining(c)
    )


def mentionne_en_cours(texte) -> bool:
    """Ce texte porte-t-il une marque de mission en cours ?

    S'applique aussi bien à une date de fin (« Poste actuel ») qu'à une période
    entière (« Mars 2019 – Aujourd'hui », « Depuis mars 2019 ») : c'est la même
    question. Un texte vide ne porte aucune marque — voir `mission_en_cours`
    pour le cas d'une date de fin absente.
    """
    return bool(MISSION_EN_COURS_RE.search(sans_accents(texte).lower()))


def mission_en_cours(date_fin) -> bool:
    """La mission est-elle en cours, vu sa seule date de fin ?

    Une date de fin absente vaut « en cours » : une mission sans fin connue est
    ouverte, pas ponctuelle (#177 ligne 6). C'est le contrat que le JS applique
    déjà (`!endRaw || ...`).
    """
    return not sans_accents(date_fin).strip() or mentionne_en_cours(date_fin)


# ── « Quelle date ce texte porte-t-il ? » ────────────────────────────────────
# Table des noms de mois identique — clé pour clé — au champ `mois` de
# document-parsing/fixtures/date_mission.json et à la table `MOIS` de
# one-pager/lib/normalize.js. Les tests des deux côtés comparent la table à la
# fixture : ajouter un libellé d'un seul côté casse le test de l'autre service.
#
# Les libellés sont désaccentués et en minuscules, comme le texte auquel ils
# sont confrontés (« Août » -> « aout », « Février » -> « fevrier »).
MOIS = {
    "janvier": 1, "janv": 1, "jan": 1, "january": 1,
    "fevrier": 2, "fevr": 2, "fev": 2, "feb": 2, "february": 2,
    "mars": 3, "mar": 3, "march": 3,
    "avril": 4, "avr": 4, "apr": 4, "april": 4,
    "mai": 5, "may": 5,
    "juin": 6, "jun": 6, "june": 6,
    "juillet": 7, "juil": 7, "jul": 7, "july": 7,
    "aout": 8, "aou": 8, "aug": 8, "august": 8,
    "septembre": 9, "sept": 9, "sep": 9, "september": 9,
    "octobre": 10, "oct": 10, "october": 10,
    "novembre": 11, "nov": 11, "november": 11,
    "decembre": 12, "dec": 12, "december": 12,
}

# Essayés DANS CET ORDRE, le premier qui reconnaît gagne — même ordre que
# parseMonthYear côté JS, et c'est l'ordre qui tranche « 12/04/2025 » : la
# forme JJ/MM/AAAA passe APRÈS MM/AAAA, qui y reconnaît déjà « 04/2025 ».
_RE_MM_AAAA = re.compile(r"\b(\d{1,2})[/.-](\d{4})\b")
_RE_AAAA_MM = re.compile(r"\b(\d{4})[/.-](\d{1,2})\b")
_RE_JJ_MM_AA = re.compile(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b")
_RE_MOIS_AAAA = re.compile(r"\b([a-z]{3,10})\.?\s+(\d{4})\b")
_RE_AAAA = re.compile(r"\b(\d{4})\b")

# Fenêtre d'années plausibles : un nombre à quatre chiffres dans un CV n'est pas
# forcément une année (une référence de poste, un effectif, un montant).
ANNEE_MIN, ANNEE_MAX = 1950, 2100


def _iso(annee, mois) -> str | None:
    """« AAAA-MM », ou « AAAA » si le mois est inconnu ou hors 1-12, ou None."""
    if not annee or annee < ANNEE_MIN or annee > ANNEE_MAX:
        return None
    if not mois or mois < 1 or mois > 12:
        return str(annee)
    return "%d-%02d" % (annee, mois)


def analyser_date(texte) -> str | None:
    """« Mars 2022 » -> « 2022-03 » ; « 2019 » -> « 2019 » ; sinon None.

    Portage de one-pager/lib/normalize.js::parseMonthYear, motif pour motif et
    dans le même ordre ; le jeu d'essai partagé (date_mission.json) est le
    contrat que les deux doivent honorer à l'identique.

    Sur une période entière (« Mars 2019 – Juin 2021 »), rend la PREMIÈRE date
    rencontrée : découper une période en deux bornes est le travail de
    `analyser_periode`, pas celui-ci.
    """
    s = sans_accents(texte).lower().strip()

    m = _RE_MM_AAAA.search(s)                       # 04/2025
    if m:
        return _iso(int(m.group(2)), int(m.group(1)))

    m = _RE_AAAA_MM.search(s)                       # 2025-04
    if m:
        return _iso(int(m.group(1)), int(m.group(2)))

    m = _RE_JJ_MM_AA.search(s)                      # 12/04/2025
    if m:
        annee = m.group(3)
        return _iso(int("20" + annee) if len(annee) == 2 else int(annee), int(m.group(2)))

    m = _RE_MOIS_AAAA.search(s)                     # avril 2025
    if m and m.group(1) in MOIS:
        return _iso(int(m.group(2)), MOIS[m.group(1)])

    m = _RE_AAAA.search(s)                          # 2019 seule
    if m and ANNEE_MIN <= int(m.group(1)) <= ANNEE_MAX:
        return m.group(1)

    return None


def index_mois(iso) -> int:
    """« 2022-03 » -> un numéro de mois absolu, comparable et soustractible.

    Une année seule vaut JANVIER — convention de
    one-pager/lib/extract.js::monthIndex, celle dont sort l'ancienneté
    affichée ; s'en écarter ici ferait diverger les deux services d'un an sur
    tout CV daté à l'année.
    """
    morceaux = str(iso or "").split("-")
    annee = int(morceaux[0]) if morceaux[0].isdigit() else 0
    mois = int(morceaux[1]) if len(morceaux) > 1 and morceaux[1].isdigit() else 1
    return annee * 12 + mois


def duree_mois(debut, fin) -> int:
    """Longueur d'une période en mois, BORNES INCLUSES.

    Janvier -> décembre fait douze mois, pas onze ; une mission d'un seul mois
    en fait un, pas zéro. Rend 0 si la fin précède le début.
    """
    return max(0, index_mois(fin) - index_mois(debut) + 1)


def mois_courant() -> str:
    """Le mois d'aujourd'hui au format « AAAA-MM » (N.isoNow côté JS)."""
    maintenant = datetime.now()
    return "%d-%02d" % (maintenant.year, maintenant.month)


# Sépare les deux bornes d'une période. Le séparateur doit être ENTOURÉ
# D'ESPACES — sans quoi « 2019-03 » serait coupé en deux et la date perdue.
# « à » figure désaccentué (« a ») : le motif est appliqué au texte désaccentué.
_RE_SEPARATEUR_PERIODE = re.compile(
    r"\s(?:[-–—−]{1,2}|a|au|to|until|jusqu.?\s*(?:au?|en))\s",
    re.IGNORECASE,
)


def analyser_periode(texte):
    """« Septembre 2019 - Février 2022 » -> ("2019-09", "2022-02", False).

    Rend `(debut_iso, fin_iso, en_cours)`. Une mission en cours n'a pas de fin :
    `fin_iso` vaut alors None, comme le fait déjà le JS.

    **La marque « en cours » n'est cherchée que dans la borne de FIN.** C'est
    la correction de l'asymétrie relevée en #177 : tant que cv-parser n'avait
    pas d'analyseur, il appliquait le motif à la période entière, et
    « Depuis 2015 jusqu'en 2018 » — période fermée — était comptée jusqu'à
    aujourd'hui parce que « depuis » figurait quelque part dans la chaîne.
    Sans séparateur, la question redevient celle de la chaîne entière :
    « Depuis Mars 2019 » est bien une mission ouverte.
    """
    brut = sans_accents(texte).strip()
    if not brut:
        return (None, None, False)

    coupe = _RE_SEPARATEUR_PERIODE.search(brut)
    if coupe:
        gauche, droite = brut[:coupe.start()], brut[coupe.end():]
        debut = analyser_date(gauche)
        if debut:
            # `mission_en_cours` et non `mentionne_en_cours` : une borne de fin
            # vide vaut « en cours » (#177 ligne 6).
            en_cours = mission_en_cours(droite)
            return (debut, None if en_cours else analyser_date(droite), en_cours)

    en_cours = mentionne_en_cours(brut)
    debut = analyser_date(brut)
    return (debut, None if en_cours else debut, en_cours)


def periode_lisible(lignes) -> bool:
    """Au moins une mission dont la période donne un intervalle exploitable ?

    C'est la question « avons-nous mieux que ce que DocIE annonce ? » de la
    #177 ligne 3, et c'est aussi celle que pose le JS avant de se replier sur
    `years_experience` (`lib/docie-extract.js` : `experiences.some(e =>
    e.start_date)`).

    Le critère reprend **mot pour mot** celui qui fait entrer une mission dans
    le cumul de `compute_years_experience` (app.py) — un début analysable et un
    intervalle non inverse. Les deux doivent rester d'accord : une période
    présente mais illisible (« 3 ans ») ne compte PAS ici, et c'est ce qui
    permet à la valeur de DocIE de prendre le relais dans ce cas précis.
    """
    for ligne in lignes or []:
        ligne = ligne if isinstance(ligne, dict) else {}
        debut, fin, en_cours = analyser_periode(ligne.get("period") or "")
        if debut and index_mois(mois_courant() if en_cours or not fin else fin) >= index_mois(debut):
            return True
    return False


def debut_mission(ligne) -> str | None:
    """Date de début d'une mission DocIE ou d'une mission déjà normalisée.

    `start_date` d'abord (ce que DocIE renvoie), la période ensuite : après
    `normalize_cv_data` la fiche ne garde que `period`, et le chemin « Copilot »
    (app.py) renormalise une fiche qui n'a jamais eu de `start_date`.
    """
    ligne = ligne if isinstance(ligne, dict) else {}
    debut = analyser_date(ligne.get("start_date"))
    if debut:
        return debut
    return analyser_periode(ligne.get("period") or ligne.get("periode"))[0]


def ordre_missions(lignes) -> list[int]:
    """Indices des missions, de la plus récente à la plus ancienne.

    C'est l'ordre qu'un CV annonce, et celui que one-pager applique déjà
    (`lib/docie-extract.js`, tri sur `start_date` décroissante) ; cv-parser
    gardait l'ordre du document DocIE — #177 ligne 7.

    Tri **stable** : deux missions de même date de début, ou sans date
    exploitable, gardent leur ordre d'origine. Une mission sans date sort en
    dernier plutôt que de remonter en tête.

    Fonction PURE d'une liste de lignes : `normalize_cv_data` et
    `docie_review.revue_docie` l'appellent sur la MÊME liste et obtiennent donc
    forcément la même permutation — c'est ce qui garantit qu'une marque « à
    vérifier » posée sur `experience[0]` par DocIE suit sa mission après le tri.
    """
    return sorted(range(len(lignes)), key=lambda i: debut_mission(lignes[i]) or "", reverse=True)
