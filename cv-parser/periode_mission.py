"""« Cette mission est-elle toujours en cours ? » — liste de synonymes partagée.

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
