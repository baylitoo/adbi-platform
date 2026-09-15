"""`skills_to_flat` ne casse plus un nom de compétence sur sa barre oblique.

Relevé par #198 (#177, lignes G/H) et non traité là : `skills_to_flat` coupait
sur TOUTE barre oblique. « PL/SQL » donnait deux fausses compétences `PL` et
`SQL` dans `skills_flat` — ce que lisent le rapprochement, /api/skills,
`top_skills` et la recherche. Mesuré avant correctif sur origin/master bdb9d2d :

  PL/SQL      -> [PL, SQL]          CI/CD       -> [CI, CD]
  TCP/IP      -> [TCP, IP]          UX/UI       -> [UX, UI]
  I/O         -> []  (disparu)      A/B testing -> [B testing]
  S/4HANA     -> [4HANA]            Oracle PL/SQL -> [Oracle PL, SQL]

et, côté rapprochement, deux faux positifs nés de ces morceaux : un besoin
« postgres » trouvait le CV « PL/SQL » (`sql` sous-chaîne de `postgresql`), un
besoin « sklearn » trouvait le CV « CI/CD » (`ci` sous-chaîne de `scikit`).

La barre reste un séparateur quand les consultants l'emploient comme tel
(« Python/Java », « AWS / Azure ») : la règle est décrite dans
skills_normalizer.py, au-dessus de `decouper_barres`.

one-pager n'a PAS ce défaut : sa voie DocIE (lib/docie-extract.js::
mapperCompetences) ne découpe jamais un item, et sa voie mise en page comme
`env_technique` (lib/extract.js::splitList) ne coupe que sur une barre entourée
d'espaces. Écart qui subsiste, assumé : « Python/Java » reste un item côté
one-pager, deux entrées de `skills_flat` ici — one-pager n'a pas de liste plate
équivalente (ses technologies sont détectées dans le texte par la taxonomie,
qui y trouve Python et Java séparément).
"""
import re
import sys
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
DEPOT = RACINE.parent
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from skills_normalizer import (  # noqa: E402
    compute_skills_flat, decouper_barres, normalize_skills, skills_to_flat,
)
from test_competences_portee import _docie, _donnees, normalize_cv_data  # noqa: E402


def _ancien_skills_to_flat(skills_structured):
    """skills_to_flat avant ce correctif, recopié tel quel (témoin)."""
    flat = []
    for group in (skills_structured or []):
        for item in (group.get("items") or []):
            for part in re.split(r"[,;/]", str(item)):
                part = part.strip()
                if part and len(part) > 1:
                    flat.append(part)
    return flat


def _plat(item, fonction=skills_to_flat):
    return fonction([{"category": "X", "items": [item]}])


# Noms composés : un seul item, avant comme après normalize_skills.
COMPOSES = {
    "PL/SQL": ["PL", "SQL"],
    "CI/CD": ["CI", "CD"],
    "TCP/IP": ["TCP", "IP"],
    "I/O": [],
    "UX/UI": ["UX", "UI"],
    "A/B testing": ["B testing"],
    "MOA/MOE": ["MOA", "MOE"],
    "S/4HANA": ["4HANA"],
    "C/C++": ["C++"],
    "Pub/Sub": ["Pub", "Sub"],
    "Oracle PL/SQL": ["Oracle PL", "SQL"],
    "GitLab CI/CD": ["GitLab CI", "CD"],
}

# Vraies listes : la barre reste un séparateur.
LISTES = {
    "Python/Java": ["Python", "Java"],
    "AWS / Azure": ["AWS", "Azure"],
    "AWS/Azure": ["AWS", "Azure"],
    "AWS/GCP": ["AWS", "GCP"],
    "SSIS/SSRS": ["SSIS", "SSRS"],
    "SQL/NoSQL": ["SQL", "NoSQL"],
    "ML/DL": ["ML", "DL"],
    "Java/J2EE": ["Java", "J2EE"],
    "R/Python": ["Python"],  # « R » (1 caractère) est jeté, comme avant
    "Talend/Informatica": ["Talend", "Informatica"],
    "Docker/Kubernetes": ["Docker", "Kubernetes"],
    "Git/GitHub": ["Git", "GitHub"],
    "CI/CD/DevOps": ["CI/CD", "DevOps"],
    "Python, Pandas": ["Python", "Pandas"],
}


class TemoinAncienDecoupageTests(unittest.TestCase):
    """L'ancien découpage rejoué : la casse est constatée, pas supposée."""

    def test_l_ancien_code_cassait_chaque_nom_compose(self):
        for item, ancien in COMPOSES.items():
            with self.subTest(item=item):
                self.assertEqual(_plat(item, _ancien_skills_to_flat), ancien)
                self.assertEqual(_plat(item), [item])

    def test_I_O_disparaissait_entierement(self):
        self.assertEqual(normalize_skills(_plat("I/O", _ancien_skills_to_flat)), [])
        self.assertEqual(normalize_skills(_plat("I/O")), ["I/O"])


class RegleTests(unittest.TestCase):

    def test_les_vraies_listes_sont_toujours_coupees(self):
        for item, attendu in LISTES.items():
            with self.subTest(item=item):
                self.assertEqual(_plat(item), attendu)

    def test_les_listes_coupees_avant_le_sont_encore(self):
        """Aucune vraie liste ne régresse : même résultat qu'avant correctif."""
        for item in ("Python/Java", "AWS / Azure", "AWS/Azure", "SQL/NoSQL", "Java/J2EE",
                     "Talend/Informatica", "Docker/Kubernetes", "Git/GitHub", "Python, Pandas"):
            with self.subTest(item=item):
                self.assertEqual(_plat(item), _plat(item, _ancien_skills_to_flat))

    def test_une_barre_entouree_d_espace_separe_toujours(self):
        """La règle de one-pager (lib/extract.js::splitList), même sur des sigles."""
        self.assertEqual(decouper_barres("CI / CD"), ["CI ", " CD"])
        self.assertEqual(_plat("TCP / IP"), ["TCP", "IP"])

    def test_limite_assumee_deux_sigles_inconnus_restent_ensemble(self):
        self.assertEqual(_plat("HTML/CSS"), ["HTML/CSS"])

    def test_barres_en_bordure(self):
        self.assertEqual(_plat("/Java"), ["Java"])
        self.assertEqual(_plat("Java/"), ["Java"])
        self.assertEqual(_plat("SQL//NoSQL"), ["SQL", "NoSQL"])


class CheminReelTests(unittest.TestCase):
    """De la réponse DocIE à `skills_flat`, par normalize_cv_data."""

    def test_skills_flat_d_une_fiche_neuve(self):
        fiche = normalize_cv_data(_donnees(_docie(
            ("Bases", ["Oracle PL/SQL", "PostgreSQL"]),
            ("DevOps", ["CI/CD", "Docker/Kubernetes"]),
            ("Réseau", ["TCP/IP"]),
        )))
        self.assertEqual(fiche["skills_flat"],
                         ["Oracle PL/SQL", "PostgreSQL", "CI/CD", "Docker", "Kubernetes", "TCP/IP"])

    def test_la_fiche_structuree_etait_deja_intacte(self):
        """Seule la liste plate cassait : `skills` gardait « PL/SQL »."""
        fiche = normalize_cv_data(_donnees(_docie(("Bases", ["PL/SQL"]))))
        self.assertEqual(fiche["skills"][0]["items"], ["PL/SQL"])
        self.assertEqual(_ancien_skills_to_flat(fiche["skills"]), ["PL", "SQL"])


class FichesExistantesTests(unittest.TestCase):
    """Rien n'est réécrit en base : l'effet sur les anciennes fiches est borné."""

    def test_un_skills_flat_stocke_n_est_pas_recalcule(self):
        """Le matcher, /api/skills et la recherche lisent `skills_flat` s'il est
        présent : une fiche stockée avec [PL, SQL] le garde jusqu'à un nouveau
        dépôt ou /reanalyser."""
        stockee = {"skills": [{"category": "Bases", "items": ["PL/SQL"]}],
                   "skills_flat": ["PL", "SQL"]}
        self.assertEqual(stockee.get("skills_flat") or compute_skills_flat(stockee), ["PL", "SQL"])

    def test_une_fiche_sans_skills_flat_profite_de_la_regle_a_la_lecture(self):
        stockee = {"skills": [{"category": "Bases", "items": ["PL/SQL"]}]}
        self.assertEqual(compute_skills_flat(stockee), ["PL/SQL"])


class AccordOnePagerTests(unittest.TestCase):

    def test_one_pager_ne_coupe_que_sur_une_barre_entouree_d_espaces(self):
        """Épingle la comparaison : si one-pager se mettait à couper « CI/CD »,
        les deux services divergeraient sur les noms composés."""
        js = (DEPOT / "one-pager/lib/extract.js").read_text(encoding="utf-8")
        corps = js[js.index("function splitList"):js.index("function trailingYear")]
        self.assertIn(r"\s+\/\s+", corps)
        self.assertNotIn(r"[,;/", corps)

    def test_les_noms_composes_cites_par_one_pager_restent_entiers_ici(self):
        for item in ("SAP S/4HANA", "CI/CD", "MOA/MOE"):
            with self.subTest(item=item):
                self.assertEqual(_plat(item), [item])


if __name__ == "__main__":
    unittest.main()
