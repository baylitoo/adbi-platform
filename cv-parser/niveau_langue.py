"""« Quel niveau CECRL ce libellé annonce-t-il ? » — table partagée avec one-pager.

DocIE type `languages[].level` en texte libre dans le schéma `adbi_resume` et y
recopie ce que le CV écrit : la vraie réponse enregistrée dans le dépôt
(document-parsing/fixtures/cv_samples/results/simple_docie.json) porte
« natif » et « courant ». Chaque service doit donc classer ce libellé lui-même.

one-pager le fait depuis toujours (`lib/normalize.js::languageLevel`) ;
cv-parser ne faisait **rien** — il stockait le libellé verbatim. Le même CV
donnait donc « natif » dans la CVthèque et « C2 » dans le dossier one-page :
inventaire de divergence #177, ligne 11, troisième de la famille « texte libre
que les deux services doivent classer » après `mission_en_cours.json` et
`date_mission.json`.

La table, les barèmes, l'ordre CECRL **et** le jeu d'essai sont partagés :
document-parsing/fixtures/niveau_langue.json. Les tests des deux côtés
comparent leurs motifs au fichier et leur classement à ses 53 cas — ajouter un
libellé d'un seul côté casse le test de l'autre service.

Ce module ne dit QUE la normalisation. Ce que cv-parser fait d'un libellé non
reconnu lui appartient, et diffère volontairement du JS : `normalize_cv_data`
garde alors le libellé brut dans `level` (une fiche CVthèque n'a pas de second
champ à afficher, et vider un niveau non reconnu est précisément la panne de la
ligne 10), là où one-pager met `level` à "" et garde le brut dans
`self_described`. L'asymétrie est écrite dans la fixture, champ `_regle_repli`.
"""
import re

# Même désaccentuation que le reste du portage partagé — une seule
# implémentation, pour que « avancé » se ramène à « avance » exactement comme
# côté JS (N.deaccent).
from periode_mission import sans_accents

# `re.IGNORECASE` SEUL, et surtout pas `re.ASCII` : il paraît rapprocher du JS
# (dont `\b` est ASCII) mais restreint aussi `\s` à `[ \t\n\r\f\v]`, alors que
# le `\s` de JS franchit l'espace insécable — celui que le texte extrait d'un
# PDF porte entre les mots. Mesuré, avec `re.ASCII` et un U+00A0 :
#
#     « bon<NBSP>niveau »              JS B2  / Python None
#     « niveau<NBSP>scolaire<NBSP>solide »  JS B1  / Python A2
#     « professionnel<NBSP>complet »   JS C1  / Python B2
#
# soit exactement la divergence que ce portage existe pour supprimer. Le `\b`
# reste donc Unicode côté Python : l'écart résiduel ne se voit que sur une
# lettre hors ASCII accolée au motif (« œ », un idéogramme), que la
# désaccentuation ne réduit pas et qu'aucun libellé de niveau ne porte — c'est
# ce que dit le champ `_regle_frontiere` du jeu d'essai partagé.
_DRAPEAUX = re.IGNORECASE

# Table ORDONNÉE : le premier motif qui reconnaît gagne, et on s'arrête là.
# L'ordre fait partie du contrat — c'est lui qui fait valoir B1, et non A2, à
# « niveau scolaire solide ». Identique — caractère pour caractère — au champ
# `niveaux` du jeu d'essai partagé et aux littéraux de one-pager/lib/
# normalize.js. Le `\/` du motif C2 vient de l'échappement du délimiteur de
# littéral JS ; il est conservé tel quel des deux côtés et vaut un `/`.
NIVEAUX = [
    (r"\b(c2|bilingue|langue\s+maternelle|maternelle|nati[fv]e?s?|courant\s*\/?\s*bilingue)\b", "C2"),
    (r"\b(c1|courant|fluent|avance|professionnel\s+complet|full\s+professional)\b", "C1"),
    (r"\b(b2|intermediaire\s+avance|professionnel|upper[\s-]intermediate|bon\s+niveau)\b", "B2"),
    (r"\b(b1|intermediaire|intermediate|niveau\s+scolaire\s+solide)\b", "B1"),
    (r"\b(a2|elementaire|elementary|scolaire)\b", "A2"),
    (r"\b(a1|debutant|notions?|beginner)\b", "A1"),
]

# Barèmes des tests de langue. Paliers du plus haut au plus bas ; sous le
# dernier palier, `defaut`. Chaque test est indépendant et rend au plus un
# niveau.
BAREMES = [
    {"test": "toeic", "motif": r"toeic\D{0,8}(\d{3,4})",
     "paliers": [(945, "C1"), (785, "B2"), (550, "B1")], "defaut": "A2"},
    {"test": "toefl", "motif": r"toefl\D{0,8}(\d{2,3})",
     "paliers": [(95, "C1"), (72, "B2")], "defaut": "B1"},
    {"test": "tcf", "motif": r"tcf\D{0,8}(\d{3})",
     "paliers": [(600, "C1"), (500, "B2"), (400, "B1")], "defaut": "A2"},
]

ORDRE_CECRL = ["A1", "A2", "B1", "B2", "C1", "C2"]

_NIVEAUX_RE = [(re.compile(motif, _DRAPEAUX), niveau) for motif, niveau in NIVEAUX]
_BAREMES_RE = [(re.compile(b["motif"], _DRAPEAUX), b["paliers"], b["defaut"]) for b in BAREMES]


def niveau_cecrl(texte):
    """« natif » -> « C2 », « TOEIC 880 » -> « B2 », « lu, écrit » -> None.

    Portage de one-pager/lib/normalize.js::languageLevel, motif pour motif et
    dans le même ordre ; le jeu d'essai partagé (niveau_langue.json) est le
    contrat que les deux doivent honorer à l'identique.

    Le niveau rendu est le **plus favorable** de ceux collectés : un candidat
    qui écrit « courant » ET « TOEIC 880 » ne doit pas être déprécié par le
    barème du test.
    """
    s = sans_accents(texte)
    niveaux = []

    for motif, paliers, defaut in _BAREMES_RE:
        trouve = motif.search(s)
        if not trouve:
            continue
        score = int(trouve.group(1))
        niveaux.append(next((n for seuil, n in paliers if score >= seuil), defaut))

    for motif, niveau in _NIVEAUX_RE:
        if motif.search(s):
            niveaux.append(niveau)
            break

    if not niveaux:
        return None
    return max(niveaux, key=ORDRE_CECRL.index)
