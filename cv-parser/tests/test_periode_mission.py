"""« Mission en cours ? » : le Python et le JS doivent répondre pareil.

Le jeu d'essai et le motif sont lus dans la fixture partagée
document-parsing/fixtures/mission_en_cours.json — le test JS jumeau
(one-pager/tests/docie-extract.test.js) lit exactement le même fichier. Comparer
le motif, et pas seulement les verdicts, est ce qui empêche les deux listes de
redivergier : ajouter un synonyme d'un seul côté casse le test de l'autre.

`app.py` ouvre PostgreSQL à l'import ; `compute_years_experience` et
`normalize_cv_data` en sont donc extraites par `ast`, comme l'inventaire #177.
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

from periode_mission import (  # noqa: E402
    MISSION_EN_COURS_RE,
    mentionne_en_cours,
    mission_en_cours,
    sans_accents,
)

FIXTURE = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/mission_en_cours.json"
REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)


def _fonctions_de_app(noms):
    """Extrait des fonctions d'app.py sans l'importer (il ouvre PostgreSQL)."""
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, ast.FunctionDef) and n.name in noms
    )
    espace = {
        "re": re,
        "datetime": datetime,
        "mentionne_en_cours": mentionne_en_cours,
        # normalize_cv_data appelle ces trois-là hors du périmètre mesuré ici.
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace


def _periode_comme_map_resume(lignes):
    """Reproduit docie_client.map_resume : `period` = début – fin."""
    sorties = []
    for ligne in lignes:
        ligne = dict(ligne)
        ligne["period"] = ligne.get("period") or " – ".join(
            str(ligne[k]) for k in ("start_date", "end_date") if ligne.get(k)
        )
        sorties.append(ligne)
    return sorties


class MotifPartageTests(unittest.TestCase):
    """Le motif Python est celui de la fixture, donc celui du JS."""

    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_le_motif_est_celui_de_la_fixture_partagee(self):
        self.assertEqual(MISSION_EN_COURS_RE.pattern, self.fixture["motif"])

    def test_chaque_cas_du_jeu_dessai_partage(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"]):
                self.assertEqual(
                    mission_en_cours(cas["valeur"]), cas["en_cours"], cas["preuve"]
                )

    def test_une_date_de_fin_absente_vaut_en_cours(self):
        self.assertTrue(self.fixture["vide_est_en_cours"])
        for vide in ("", "   ", None):
            with self.subTest(valeur=vide):
                self.assertTrue(mission_en_cours(vide))
        # `mentionne_en_cours` répond à l'autre question : le texte porte-t-il
        # une marque ? Une période vide n'en porte pas.
        self.assertFalse(mentionne_en_cours(""))

    def test_accents_et_casse(self):
        self.assertEqual(sans_accents("Présent à ce jour"), "Present a ce jour")
        for valeur in ("PRÉSENT", "présent", "Présent"):
            with self.subTest(valeur=valeur):
                self.assertTrue(mentionne_en_cours(valeur))


class AncienneteTests(unittest.TestCase):
    """#177 lignes 4, 5 et 6, mesurées de bout en bout."""

    def setUp(self):
        espace = _fonctions_de_app({"compute_years_experience", "normalize_cv_data"})
        self.normalize = espace["normalize_cv_data"]

    def annees(self, lignes):
        fiche = self.normalize({"experience": _periode_comme_map_resume(lignes)})
        return fiche["years_experience"], [e["period"] for e in fiche["experience"]]

    def test_poste_actuel_compte_jusqu_a_aujourdhui(self):
        # Avant : 0 an — « actuel » manquait à la liste Python (#177 ligne 4).
        annees, periodes = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": "Poste actuel"}]
        )
        self.assertEqual(annees, max(0, datetime.now().year - 2019))
        self.assertEqual(periodes, ["Mars 2019 – Poste actuel"])

    def test_maintenant_compte_jusqu_a_aujourdhui(self):
        annees, _ = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": "Maintenant"}]
        )
        self.assertEqual(annees, max(0, datetime.now().year - 2019))

    def test_sans_date_de_fin_la_mission_est_en_cours(self):
        # Avant : période « Mars 2019 » seule, donc 0 an (#177 ligne 6).
        annees, periodes = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": ""}]
        )
        self.assertEqual(periodes, ["Depuis Mars 2019"])
        self.assertEqual(annees, max(0, datetime.now().year - 2019))

    def test_une_mission_terminee_reste_bornee(self):
        annees, _ = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": "Juin 2021"}]
        )
        self.assertEqual(annees, 2)

    def test_la_vraie_reponse_docie_du_depot_est_inchangee(self):
        """Non-régression sur la fixture « Camille Béranger » : 7 ans avant."""
        def deballe(valeur):
            if isinstance(valeur, dict):
                if "value" in valeur and ("confidence" in valeur or "evidence_ids" in valeur):
                    return deballe(valeur["value"])
                return {k: deballe(v) for k, v in valeur.items()}
            if isinstance(valeur, list):
                return [deballe(v) for v in valeur]
            return valeur

        reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
        missions = deballe(reponse["result"]).get("experience") or []
        annees, periodes = self.annees(missions)
        self.assertEqual(periodes[0], "Mars 2022 – Aujourd'hui")
        # « Aujourd'hui » était déjà reconnu : mission en cours depuis 2022,
        # plus 2019 -> 2022. Le total ne doit pas bouger.
        attendu = (datetime.now().year - 2022) + (2022 - 2019)
        self.assertEqual(annees, attendu)


if __name__ == "__main__":
    unittest.main()
