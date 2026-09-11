"""Un CV sans titre prend celui de sa dernière mission, et le dit — #177 ligne 2.

DocIE ne rend pas toujours de `title` : le schéma servi le déclare, rien ne le
garantit rempli. one-pager se repliait déjà sur le rôle de la mission la plus
récente ET le signalait (`lib/docie-extract.js`, avertissement
`titre_deduit_de_la_mission_la_plus_recente`) ; cv-parser laissait `""`. La
fiche arrivait donc dans la CVthèque avec « — » en en-tête — c'est-à-dire sans
ce qu'un commercial lit en premier —, et le dossier ADBI comme le dossier
client partaient sans intitulé.

Ce que ce fichier vérifie surtout, c'est que le repli n'est jamais SILENCIEUX :
`normalize_cv_data` pose le titre, `docie_review.revue_docie` pose
l'avertissement, et les deux appellent la MÊME fonction (`titre_de_repli`) sur
la MÊME liste. Un test les confronte sur une série d'entrées : aucune ne doit
donner un titre déduit sans avertissement, ni l'inverse.

`app.py` ouvre PostgreSQL à l'import ; `normalize_cv_data` en est donc extraite
par `ast`, comme dans `test_periode_mission.py`.
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

from docie_client import map_resume  # noqa: E402
from docie_review import AVERTISSEMENT_TITRE_DEDUIT, revue_docie  # noqa: E402
from periode_mission import (  # noqa: E402
    analyser_periode,
    index_mois,
    mentionne_en_cours,
    mois_courant,
    ordre_missions,
    periode_lisible,
    titre_de_repli,
)

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
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
        "print": lambda *a, **k: None,
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace["normalize_cv_data"]


# Deux missions dans l'ordre du DOCUMENT : la plus ancienne d'abord. C'est
# l'ordre dans lequel DocIE les rend sur la vraie réponse enregistrée
# (fixtures/cv_samples/results/simple_docie.json), et c'est ce qui rend le repli
# intéressant : prendre « la première » donnerait le mauvais rôle.
MISSIONS = [
    {"company": "Studio Pixelia", "title": "Développeuse junior",
     "start_date": "Septembre 2019", "end_date": "Février 2022"},
    {"company": "Numelia", "title": "Développeuse Full-Stack",
     "start_date": "Mars 2022", "end_date": "Aujourd'hui"},
]


class TitreDeRepliTests(unittest.TestCase):
    def test_prend_le_role_de_la_mission_la_plus_recente_pas_la_premiere(self):
        """« La plus récente » est celle d'`ordre_missions`, pas celle que DocIE
        rend en tête : ici la mission la plus ancienne ouvre la liste."""
        self.assertEqual(titre_de_repli(MISSIONS), "Développeuse Full-Stack")

    def test_saute_une_mission_recente_sans_role(self):
        """Un rôle vide ne fait pas abandonner le repli : on descend."""
        missions = [dict(MISSIONS[0]), dict(MISSIONS[1], title="")]
        self.assertEqual(titre_de_repli(missions), "Développeuse junior")

    def test_rien_a_deduire(self):
        for lignes in ([], None, [{"company": "Numelia"}], [{"title": "   "}], ["pas un dict"]):
            self.assertEqual(titre_de_repli(lignes), "")

    def test_cle_francaise_acceptee(self):
        """`normalize_cv_data` lit `title` OU `poste` (chemin Copilot)."""
        self.assertEqual(titre_de_repli([{"poste": "Chef de projet data"}]), "Chef de projet data")


class FicheTests(unittest.TestCase):
    def setUp(self):
        self.normalize = _normalize_cv_data()

    def test_titre_absent_devient_le_role_de_la_derniere_mission(self):
        fiche = self.normalize({"name": "Camille Béranger", "experience": MISSIONS})
        self.assertEqual(fiche["title"], "Développeuse Full-Stack")   # mesuré avant : ""

    def test_titre_rendu_par_docie_n_est_jamais_ecrase(self):
        fiche = self.normalize({"name": "Camille", "title": "Architecte data",
                                "experience": MISSIONS})
        self.assertEqual(fiche["title"], "Architecte data")

    def test_sans_mission_exploitable_la_fiche_reste_sans_titre(self):
        """Ne rien inventer : une fiche sans titre ET sans rôle reste vide, le
        bilan ADBI la signale comme incomplète."""
        self.assertEqual(self.normalize({"name": "Camille"})["title"], "")
        self.assertEqual(
            self.normalize({"name": "Camille", "experience": [{"company": "Numelia"}]})["title"], "")

    def test_fixture_reelle_inchangee(self):
        """Témoin : la vraie réponse DocIE porte un titre, rien ne bouge."""
        reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
        reponse["schema_name"] = "adbi_resume"
        data = map_resume(reponse, expected_schema="adbi_resume")
        self.assertEqual(data["title"], "Développeuse Full-Stack")
        self.assertEqual(self.normalize(data)["title"], "Développeuse Full-Stack")
        self.assertEqual(revue_docie(data, {"validation": reponse.get("validation")}),
                         {"needs_review": [], "warnings": []})


class AvertissementTests(unittest.TestCase):
    """Le repli est tracé — c'est la moitié de la ligne 2, pas un supplément."""

    def setUp(self):
        self.normalize = _normalize_cv_data()

    def test_titre_deduit_est_signale(self):
        revue = revue_docie({"name": "Camille", "experience": MISSIONS}, {"validation": {}})
        self.assertEqual(revue["warnings"], [AVERTISSEMENT_TITRE_DEDUIT])
        # Un avertissement, pas une marque par champ : un titre ABSENT relève du
        # bilan ADBI, comme le fait aussi le JS (`else if (title_derive)`).
        self.assertEqual(revue["needs_review"], [])

    def test_rien_a_signaler_quand_il_n_y_a_rien_a_deduire(self):
        for data in ({"name": "Camille"},
                     {"name": "Camille", "experience": [{"company": "Numelia"}]},
                     {"name": "Camille", "title": "Architecte data", "experience": MISSIONS}):
            self.assertEqual(revue_docie(data, {"validation": {}})["warnings"], [])

    def test_la_fiche_et_l_avertissement_ne_peuvent_pas_se_contredire(self):
        """Le point de la ligne 2 : jamais de titre inventé sans trace.

        `normalize_cv_data` et `revue_docie` répondent à la même question avec
        la même fonction ; ce test le vérifie sur des entrées où l'une pourrait
        dériver de l'autre (rôle vide, ordre du document inversé, titre
        d'espaces).
        """
        entrees = [
            {"name": "A", "experience": MISSIONS},
            {"name": "B", "title": "", "experience": MISSIONS},
            {"name": "C", "title": "   ", "experience": MISSIONS},
            {"name": "D", "title": "Architecte", "experience": MISSIONS},
            {"name": "E", "experience": [dict(MISSIONS[1], title="")]},
            {"name": "F", "experience": []},
            {"name": "G", "experience": list(reversed(MISSIONS))},
        ]
        for data in entrees:
            with self.subTest(nom=data["name"]):
                fiche = self.normalize(data)
                deduit = bool(fiche["title"]) and not str(data.get("title") or "").strip()
                signale = AVERTISSEMENT_TITRE_DEDUIT in revue_docie(data, {"validation": {}})["warnings"]
                self.assertEqual(deduit, signale)

    def test_le_libelle_est_celui_du_js(self):
        """Deux écrans qui signalent le même fait doivent le nommer pareil.

        Épingle la chaîne dans le fichier JS — pas seulement dans le Python —
        pour qu'un renommage d'un seul côté casse le test de l'autre service,
        même discipline que le libellé « Compétences » de la ligne 12.
        """
        self.assertIn(AVERTISSEMENT_TITRE_DEDUIT, MAPPER_JS.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
