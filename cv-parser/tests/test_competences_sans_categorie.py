"""Une compétence sans catégorie reste dans la fiche — #177 ligne 12.

`normalize_cv_data` jetait le groupe entier (`if category and items`) : un CV
dont la section « Compétences » est une liste à puces, sans en-tête
« Langages : » ni « Outils : », arrivait dans la CVthèque SANS AUCUNE
compétence, sans que rien ne le signale. C'est la base que
`/api/needs/<id>/match` interroge et classe : une compétence absente, c'est un
consultant que le rapprochement ne trouve pas.

one-pager conservait déjà ces groupes sous le libellé « Compétences »
(`lib/docie-extract.js::mapperCompetences`, ligne 118) ; ce test épingle le même
libellé côté Python, pour que le même CV donne la même fiche des deux côtés.

`app.py` ouvre PostgreSQL à l'import ; `normalize_cv_data` en est donc extraite
par `ast`, comme le fait l'inventaire #177 et comme `test_periode_mission.py`.
"""
import ast
import json
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from niveau_langue import niveau_cecrl  # noqa: E402
from periode_mission import (  # noqa: E402
    analyser_periode,
    index_mois,
    mentionne_en_cours,
    mois_courant,
    ordre_missions,
    periode_lisible,
    titre_de_repli,
)
from skills_normalizer import normalize_skills, skills_to_flat  # noqa: E402

REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)
MAPPER_JS = Path(__file__).resolve().parents[2] / "one-pager/lib/docie-extract.js"


def _normalize_cv_data():
    """Extrait `normalize_cv_data` d'app.py sans l'importer."""
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, ast.FunctionDef)
        and n.name in {"normalize_cv_data", "compute_years_experience"}
    )
    espace = {
        "re": re,
        "datetime": datetime,
        "mentionne_en_cours": mentionne_en_cours,
        "analyser_periode": analyser_periode,
        "ordre_missions": ordre_missions,
        "index_mois": index_mois,
        "mois_courant": mois_courant,
        "periode_lisible": periode_lisible,
        "titre_de_repli": titre_de_repli,
        "niveau_cecrl": niveau_cecrl,
        # Les vraies : ce test mesure aussi ce qui arrive dans skills_flat,
        # c'est-à-dire dans ce que le rapprochement lit.
        "normalize_skills": normalize_skills,
        "skills_to_flat": skills_to_flat,
        "compute_skills_flat": lambda *a, **k: [],
        "print": lambda *a, **k: None,
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace["normalize_cv_data"]


class CompetencesSansCategorieTests(unittest.TestCase):

    def setUp(self):
        self.normalize = _normalize_cv_data()

    def _groupes(self, skills, **reste):
        fiche = self.normalize({"name": "Test", "experience": [], "skills": skills,
                                **reste})
        return [(g["category"], g["items"]) for g in fiche["skills"]], fiche

    def test_un_groupe_sans_categorie_est_conserve(self):
        groupes, fiche = self._groupes(
            [{"category": "", "items": ["Python", "Docker", "Kubernetes"]}]
        )
        self.assertEqual(groupes, [("Compétences", ["Python", "Docker", "Kubernetes"])])
        # Et surtout : les compétences arrivent bien dans ce que lit
        # core/matcher.py, c'est-à-dire skills_flat.
        self.assertEqual(fiche["skills_flat"], ["Python", "Docker", "Kubernetes"])

    def test_categorie_absente_ou_blanche_vaut_pareil(self):
        for valeur in (None, "", "   "):
            with self.subTest(category=valeur):
                groupes, _ = self._groupes([{"category": valeur, "items": ["Go"]}])
                self.assertEqual(groupes, [("Compétences", ["Go"])])

    def test_le_libelle_par_defaut_est_celui_du_JS(self):
        """Le même libellé des deux côtés, sinon le même CV donne deux fiches."""
        self.assertIn('|| "Compétences"', MAPPER_JS.read_text(encoding="utf-8"))

    def test_les_groupes_nommes_gardent_leur_libelle(self):
        groupes, _ = self._groupes([
            {"category": "Langages", "items": ["Python", "SQL"]},
            {"category": "", "items": ["Docker", "Terraform"]},
        ])
        self.assertEqual(groupes, [
            ("Langages", ["Python", "SQL"]),
            ("Compétences", ["Docker", "Terraform"]),
        ])

    def test_plusieurs_groupes_sans_categorie_restent_distincts(self):
        """Parité avec le JS, qui libelle chaque groupe indépendamment."""
        groupes, _ = self._groupes([
            {"category": "", "items": ["Python"]},
            {"category": "", "items": ["Docker"]},
        ])
        self.assertEqual(groupes, [("Compétences", ["Python"]),
                                   ("Compétences", ["Docker"])])

    def test_un_groupe_sans_item_reste_ecarte(self):
        """Un libellé par défaut ne doit pas fabriquer de rubrique vide."""
        groupes, _ = self._groupes([{"category": "", "items": []},
                                    {"category": "Outils", "items": ["  ", ""]}])
        self.assertEqual(groupes, [])

    def test_le_groupe_jete_ne_vidait_pas_que_lui_meme(self):
        """La perte était cumulative — et c'est le dédoublonnage global (ligne 13).

        Les items du groupe sans catégorie étaient consommés par
        `_seen_items_global` AVANT que le groupe ne soit jeté : « Python » y
        disparaissait aussi de la catégorie « Langages » qui suivait. Mesuré,
        avant ce correctif : la fiche ne gardait que `["SQL"]`.

        Conservé ici en témoin. Quel groupe garde « Python » reste décidé par le
        dédoublonnage inter-catégories de la ligne 13, non tranchée.
        """
        groupes, fiche = self._groupes([
            {"category": "", "items": ["Python", "Docker"]},
            {"category": "Langages", "items": ["Python", "SQL"]},
        ])
        self.assertEqual(groupes, [("Compétences", ["Python", "Docker"]),
                                   ("Langages", ["SQL"])])
        self.assertEqual(fiche["skills_flat"], ["Python", "Docker", "SQL"])

    def test_une_vraie_section_prime_sur_le_repli_par_les_missions(self):
        """Le repli « Technologies des missions » ne doit plus masquer la section.

        Il ne se déclenche que si la fiche n'a AUCUNE compétence — ce qui était
        le cas dès que la seule section du CV n'avait pas de catégorie. La fiche
        affichait alors les technologies des missions À LA PLACE des compétences
        que le CV annonçait. Mesuré : `["Java", "Spring", "Oracle DB"]` là où le
        CV disait « Python, Docker ».
        """
        groupes, _ = self._groupes(
            [{"category": "", "items": ["Python", "Docker"]}],
            experience=[{"company": "X", "period": "Janvier 2020 - Décembre 2022",
                         "env_technique": "Java, Spring, Oracle"}],
        )
        self.assertEqual(groupes, [("Compétences", ["Python", "Docker"])])

    def test_le_repli_par_les_missions_fonctionne_toujours_sans_section(self):
        groupes, _ = self._groupes(
            [],
            experience=[{"company": "X", "period": "Janvier 2020 - Décembre 2022",
                         "env_technique": "Java, Spring, Oracle"}],
        )
        self.assertEqual(groupes, [("Technologies des missions",
                                    ["Java", "Spring", "Oracle"])])

    def test_la_vraie_reponse_docie_ne_bouge_pas(self):
        """Témoin : ses trois groupes sont tous nommés, la fiche est inchangée."""
        from docie_client import map_resume
        data = map_resume(json.loads(REPONSE_DOCIE.read_text(encoding="utf-8")))
        fiche = self.normalize(data)
        self.assertEqual(
            [(g["category"], g["items"]) for g in fiche["skills"]],
            [("Langages", ["Python", "JavaScript", "SQL"]),
             ("Frameworks", ["Django", "React", "Node.js"]),
             ("Outils", ["Docker", "Git", "Jenkins"])],
        )


if __name__ == "__main__":
    unittest.main()
