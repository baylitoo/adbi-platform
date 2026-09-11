"""#177 lignes 17 et 18 : deux champs que DocIE rend et que cv-parser jetait.

`experience[].location` et `certifications[].issuer` sont déclarés par le
schéma RÉELLEMENT servi (le `dynamic_schema` que DocIE renvoie avec le
résultat, identique à cv-parser/adbi_resume.schema.json), remplis par DocIE,
transmis intacts par `docie_client.map_resume`, conservés par one-pager — et
supprimés par `app.py::normalize_cv_data`, qui reconstruit ses dictionnaires
clé par clé et ne listait ni l'un ni l'autre.

Ce que ce fichier mesure, dans l'ordre de la chaîne réelle :
  1. la valeur arrive jusqu'à la fiche (vraie réponse enregistrée pour le lieu,
     entrée synthétique bâtie sur le schéma servi pour l'organisme, les
     certifications étant vides dans toutes les fixtures du dépôt) ;
  2. elle SURVIT à un enregistrement depuis l'écran d'édition — c'est le piège :
     un champ qui s'affiche mais ne repasse pas par le PATCH est effacé au
     premier « Enregistrer » ;
  3. elle s'affiche : écran d'édition, dossier ADBI, dossier client ;
  4. un doute de DocIE sur ces champs se pose désormais SUR eux.

`app.py` ouvre PostgreSQL à l'import ; ses fonctions sont donc extraites par
`ast`, comme test_periode_mission.py et l'inventaire #177.
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
from docie_review import revue_docie  # noqa: E402
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

REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)
GABARITS = RACINE / "templates"


def _fonctions_de_app(noms):
    """Extrait des fonctions d'app.py sans l'importer (il ouvre PostgreSQL)."""
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, (ast.FunctionDef, ast.Assign)) and _nom(n) in noms
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
        # Hors du périmètre mesuré ici (rapprochement, pas conservation).
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
        "CV_LIST_MAX": 200,
        "CV_SKILLS_FLAT_MAX": 400,
        "CHAMPS_LISTE_CV": ("experience", "education", "languages",
                            "certifications", "interests"),
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace


def _nom(noeud):
    if isinstance(noeud, ast.FunctionDef):
        return noeud.name
    cibles = [c.id for c in noeud.targets if isinstance(c, ast.Name)]
    return cibles[0] if cibles else ""


APP = _fonctions_de_app({
    "normalize_cv_data", "compute_years_experience",
    "_filtrer_champs_cv", "_plafonner_cv",
    "CHAMPS_MODIFIABLES_CV", "LISTES_DE_DICTS_CV",
})


def _fiche_reelle():
    """La fiche telle que process_cv la construit, depuis la vraie réponse."""
    reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
    reponse["schema_name"] = "adbi_resume"
    return APP["normalize_cv_data"](map_resume(reponse, expected_schema="adbi_resume"))


# Certifications : toutes les fixtures du dépôt en ont une liste VIDE
# (`"certifications": []` dans simple_docie.json). L'entrée ci-dessous est donc
# SYNTHÉTIQUE, et bâtie sur le schéma servi — `{name, issuer, year}` verbatim,
# tel que le `dynamic_schema` de cette même réponse les déclare — pas sur une
# forme inventée. Même discipline que l'inventaire #177 pour ses cas hors
# fixture.
CERTIFICATION_SYNTHETIQUE = {
    "name": "AWS Certified Solutions Architect",
    "issuer": "Amazon Web Services",
    "year": "2023",
}


class LieuDeMissionTests(unittest.TestCase):
    """#177 ligne 17 — mesuré sur la VRAIE réponse enregistrée."""

    def test_le_lieu_arrive_dans_la_fiche(self):
        fiche = _fiche_reelle()
        # Avant ce correctif : [] — la clé n'existait pas dans le dictionnaire
        # reconstruit par normalize_cv_data, donc rien à lire.
        self.assertEqual([m["location"] for m in fiche["experience"]],
                         ["Lyon", "Lyon"])

    def test_le_lieu_est_celui_que_docie_a_rendu_mission_par_mission(self):
        """Le tri des missions (#177 ligne 7) ne doit pas dissocier lieu et société."""
        data = map_resume(
            {"schema_name": "adbi_resume", "result": {
                "experience": [
                    {"company": "Ancienne", "title": "Dev", "location": "Bordeaux",
                     "start_date": "Septembre 2019", "end_date": "Février 2022"},
                    {"company": "Recente", "title": "Dev", "location": "Lyon",
                     "start_date": "Mars 2022", "end_date": "Aujourd'hui"},
                ]}},
            expected_schema="adbi_resume")
        fiche = APP["normalize_cv_data"](data)
        self.assertEqual([(m["company"], m["location"]) for m in fiche["experience"]],
                         [("Recente", "Lyon"), ("Ancienne", "Bordeaux")])

    def test_un_lieu_absent_ne_fabrique_rien(self):
        fiche = APP["normalize_cv_data"](
            {"experience": [{"company": "Numelia", "title": "Dev"}]})
        self.assertEqual(fiche["experience"][0]["location"], "")

    def test_meme_nom_et_meme_forme_que_one_pager(self):
        """Corriger une divergence ne doit pas en créer une 23e (#177)."""
        js = (Path(__file__).resolve().parents[2]
              / "one-pager/lib/docie-extract.js").read_text(encoding="utf-8")
        # Chaîne plate, clé `location`, lue sur la même clé DocIE.
        self.assertIn("const location = texte(brut && brut.location);", js)


class OrganismeDeCertificationTests(unittest.TestCase):
    """#177 ligne 18 — entrée synthétique bâtie sur le schéma servi."""

    def test_l_organisme_arrive_dans_la_fiche(self):
        fiche = APP["normalize_cv_data"](
            {"certifications": [CERTIFICATION_SYNTHETIQUE]})
        # Avant ce correctif : {"name": ..., "year": ...} — l'organisme tombait.
        self.assertEqual(fiche["certifications"], [{
            "name": "AWS Certified Solutions Architect",
            "issuer": "Amazon Web Services",
            "year": "2023",
        }])

    def test_un_organisme_absent_ne_fabrique_rien(self):
        fiche = APP["normalize_cv_data"]({"certifications": [{"name": "ITIL"}]})
        self.assertEqual(fiche["certifications"][0]["issuer"], "")

    def test_meme_nom_et_meme_forme_que_one_pager(self):
        js = (Path(__file__).resolve().parents[2]
              / "one-pager/lib/docie-extract.js").read_text(encoding="utf-8")
        self.assertIn("issuer: texte(c && c.issuer),", js)


class AllerRetourPatchTests(unittest.TestCase):
    """Le piège de cette ligne : un champ qui s'affiche mais ne revient pas.

    `PATCH /api/cvs/<id>` remplace la rubrique ENTIÈRE par ce que
    `cv_detail.html::collectData()` a ramassé. Un champ absent de ce ramassage
    est donc effacé au premier enregistrement — c'est ce qui est arrivé à
    `niveau_declare` (noté, non corrigé). Les deux moitiés sont vérifiées :
    le serveur laisse passer, et l'écran renvoie bien la valeur.
    """

    FICHE_EDITEE = {
        "name": "Camille Béranger",
        "experience": [{"company": "Numelia", "title": "Dev", "location": "Lyon",
                        "period": "Mars 2022 – Aujourd'hui"}],
        "certifications": [CERTIFICATION_SYNTHETIQUE],
        "empreinte": "sha-volée",          # champ interne : doit être refusé
    }

    def test_le_serveur_laisse_passer_les_deux_champs(self):
        retenu = APP["_filtrer_champs_cv"](self.FICHE_EDITEE)
        self.assertNotIn("empreinte", retenu)       # la liste blanche tient
        self.assertEqual(retenu["experience"][0]["location"], "Lyon")
        self.assertEqual(retenu["certifications"][0]["issuer"],
                         "Amazon Web Services")

    def test_le_plafonnement_ne_les_ampute_pas(self):
        retenu = APP["_filtrer_champs_cv"](self.FICHE_EDITEE)
        self.assertIsNone(APP["_plafonner_cv"](retenu))

class RevueDocieTests(unittest.TestCase):
    """Tant que les champs étaient jetés, un doute sur eux sortait en
    avertissement générique — le seul choix honnête. Maintenant qu'ils
    s'affichent, il doit désigner la case."""

    def test_le_doute_sur_le_lieu_designe_la_case_de_la_fiche(self):
        revue = revue_docie(
            {"experience": [{"company": "Numelia", "location": "Lyon",
                             "start_date": "Mars 2022"}]},
            {"validation": {}, "field_confidence": {"experience[0].location": 0.5}},
        )
        self.assertEqual(revue["needs_review"], ["experience[0].location"])
        self.assertEqual(revue["warnings"], [])

    def test_le_doute_sur_l_organisme_designe_la_case_de_la_fiche(self):
        revue = revue_docie(
            {"certifications": [CERTIFICATION_SYNTHETIQUE]},
            {"validation": {}, "field_confidence": {"certifications[0].issuer": 0.4}},
        )
        self.assertEqual(revue["needs_review"], ["certifications[0].issuer"])


if __name__ == "__main__":
    unittest.main()
