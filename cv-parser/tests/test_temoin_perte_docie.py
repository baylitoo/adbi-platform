"""#174 — témoins : rejouer l'ANCIEN chemin et constater la perte.

Les tests de `test_champs_conserves.py` et `test_anciennete_source.py` disent ce
que le code fait AUJOURD'HUI. Ils ne disent pas que la panne existait, ni qu'un
retour en arrière serait vu : leurs commentaires « avant ce correctif : … » sont
de la prose, pas une mesure. C'est le rôle de ce fichier, sur le modèle de
`test_niveau_declare.py::test_sans_le_report_la_provenance_disparaissait`.

L'ancien chemin n'est pas réécrit à la main : il est RECONSTRUIT depuis le
`normalize_cv_data` courant par chirurgie d'AST — retirer la clé `location` du
dictionnaire de mission, la clé `issuer` de celui de certification, et l'`if`
qui laisse passer le `years_experience` de DocIE. Un ancien chemin recopié à la
main dériverait du vrai ; celui-ci ne le peut pas.

Chaque transformation COMPTE ce qu'elle a retiré et échoue si le compte n'y est
pas. Sans cela, un remaniement qui déplacerait ces dictionnaires ferait passer
le témoin à vide — c'est-à-dire « pas de perte » sur un code non corrigé, pire
que pas de témoin du tout.

`app.py` ouvre PostgreSQL à l'import ; la fonction est donc extraite par `ast`,
comme le reste de la suite.
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
from niveau_langue import niveau_cecrl  # noqa: E402
from skills_normalizer import canonique, cle_competence  # noqa: E402
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


def _noeud_normalize():
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    return next(n for n in arbre.body
                if isinstance(n, ast.FunctionDef) and n.name == "normalize_cv_data")


def _compile(noeud):
    """Rend `normalize_cv_data` exécutable, tel ou amputé."""
    espace = {
        "re": re, "datetime": datetime,
        "mentionne_en_cours": mentionne_en_cours,
        "analyser_periode": analyser_periode,
        "ordre_missions": ordre_missions,
        "index_mois": index_mois,
        "mois_courant": mois_courant,
        "periode_lisible": periode_lisible,
        "titre_de_repli": titre_de_repli,
        "niveau_cecrl": niveau_cecrl,
        "canonique": canonique, "cle_competence": cle_competence,
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
        "compute_years_experience": _compute_years_experience,
    }
    exec(compile(ast.unparse(noeud), str(RACINE / "app.py"), "exec"), espace)
    return espace["normalize_cv_data"]


def _extraire_compute():
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    noeud = next(n for n in arbre.body
                 if isinstance(n, ast.FunctionDef) and n.name == "compute_years_experience")
    espace = {"analyser_periode": analyser_periode, "index_mois": index_mois,
              "mois_courant": mois_courant}
    exec(compile(ast.unparse(noeud), str(RACINE / "app.py"), "exec"), espace)
    return espace["compute_years_experience"]


_compute_years_experience = _extraire_compute()


def _est_append_sur(noeud, rubrique):
    """`normalized["<rubrique>"].append(...)` ?"""
    cible = getattr(noeud, "func", None)
    return (isinstance(cible, ast.Attribute) and cible.attr == "append"
            and isinstance(cible.value, ast.Subscript)
            and isinstance(cible.value.value, ast.Name)
            and cible.value.value.id == "normalized"
            and isinstance(cible.value.slice, ast.Constant)
            and cible.value.slice.value == rubrique)


class _SansLaCle(ast.NodeTransformer):
    """Retire une clé du dictionnaire empilé dans une rubrique de la fiche."""

    def __init__(self, rubrique, cle):
        self.rubrique, self.cle, self.retirees = rubrique, cle, 0

    def visit_Call(self, noeud):
        self.generic_visit(noeud)
        if _est_append_sur(noeud, self.rubrique) and noeud.args:
            dico = noeud.args[0]
            if isinstance(dico, ast.Dict):
                garde = [(c, v) for c, v in zip(dico.keys, dico.values)
                         if not (isinstance(c, ast.Constant) and c.value == self.cle)]
                self.retirees += len(dico.keys) - len(garde)
                dico.keys = [c for c, _ in garde]
                dico.values = [v for _, v in garde]
        return noeud


class _SansLeRepliDocie(ast.NodeTransformer):
    """Retire le repli sur le `years_experience` de DocIE et son étiquette.

    Ce qui reste est mot pour mot l'ancien corps : `annees =
    compute_years_experience(...)` puis `normalized['years_experience'] =
    annees`.
    """

    def __init__(self):
        self.retirees = 0

    def visit_If(self, noeud):
        self.generic_visit(noeud)
        test = noeud.test
        if (isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not)
                and isinstance(test.operand, ast.Call)
                and isinstance(test.operand.func, ast.Name)
                and test.operand.func.id == "periode_lisible"):
            self.retirees += 1
            return None
        return noeud

    def visit_Assign(self, noeud):
        self.generic_visit(noeud)
        for cible in noeud.targets:
            if (isinstance(cible, ast.Subscript) and isinstance(cible.value, ast.Name)
                    and cible.value.id == "normalized"
                    and isinstance(cible.slice, ast.Constant)
                    and cible.slice.value == "anciennete_source"):
                self.retirees += 1
                return None
            # `normalized = {...}` : l'étiquette est aussi déclarée dans le
            # squelette de la fiche, il faut l'y retirer pour que l'ancien
            # chemin ne la porte nulle part.
            if (isinstance(cible, ast.Name) and cible.id == "normalized"
                    and isinstance(noeud.value, ast.Dict)):
                dico = noeud.value
                garde = [(c, v) for c, v in zip(dico.keys, dico.values)
                         if not (isinstance(c, ast.Constant)
                                 and c.value == "anciennete_source")]
                self.retirees += len(dico.keys) - len(garde)
                dico.keys = [c for c, _ in garde]
                dico.values = [v for _, v in garde]
        return noeud


def _normalize_ancien(transformations):
    """`normalize_cv_data` amputé, avec contrôle du nombre de retraits."""
    noeud = _noeud_normalize()
    for transformation, attendu in transformations:
        noeud = transformation.visit(noeud)
        assert transformation.retirees == attendu, (
            f"{type(transformation).__name__} : {transformation.retirees} "
            f"retrait(s) au lieu de {attendu} — la chirurgie ne mord plus sur "
            "le code actuel, le témoin passerait à vide")
    ast.fix_missing_locations(noeud)
    return _compile(noeud)


NORMALIZE = _compile(_noeud_normalize())


def _reponse_reelle():
    reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
    reponse["schema_name"] = "adbi_resume"
    return map_resume(reponse, expected_schema="adbi_resume")


class TemoinLieuDeMissionTests(unittest.TestCase):
    """La vraie réponse enregistrée porte « Lyon » ; l'ancien chemin le perdait."""

    def test_l_ancien_chemin_perdait_le_lieu(self):
        ancien = _normalize_ancien([(_SansLaCle("experience", "location"), 1)])
        fiche = ancien(_reponse_reelle())
        self.assertEqual([m.get("location") for m in fiche["experience"]],
                         [None, None])

    def test_le_chemin_actuel_le_garde(self):
        fiche = NORMALIZE(_reponse_reelle())
        self.assertEqual([m["location"] for m in fiche["experience"]],
                         ["Lyon", "Lyon"])

    def test_docie_l_avait_bien_rendu(self):
        """La perte était bien à la normalisation, pas plus haut dans la chaîne."""
        self.assertEqual(
            [m.get("location") for m in _reponse_reelle()["experience"]],
            ["Lyon", "Lyon"])


class TemoinOrganismeTests(unittest.TestCase):
    """Les certifications sont vides dans toutes les fixtures : entrée bâtie
    sur le `dynamic_schema` de la vraie réponse ({name, issuer, year})."""

    CERTIFICATION = {"name": "AWS Certified Solutions Architect",
                     "issuer": "Amazon Web Services", "year": "2023"}

    def test_l_ancien_chemin_perdait_l_organisme(self):
        ancien = _normalize_ancien([(_SansLaCle("certifications", "issuer"), 1)])
        fiche = ancien({"certifications": [self.CERTIFICATION]})
        self.assertEqual(fiche["certifications"],
                         [{"name": "AWS Certified Solutions Architect",
                           "year": "2023"}])

    def test_le_chemin_actuel_le_garde(self):
        fiche = NORMALIZE({"certifications": [self.CERTIFICATION]})
        self.assertEqual(fiche["certifications"][0]["issuer"],
                         "Amazon Web Services")


class TemoinAncienneteTests(unittest.TestCase):
    """L'ancien chemin écrasait le `years_experience` de DocIE par un 0."""

    def test_l_ancien_chemin_ramenait_un_senior_a_zero(self):
        ancien = _normalize_ancien([(_SansLeRepliDocie(), 3)])
        # Un consultant dont aucune mission n'est datée, et dont DocIE a lu
        # « 12 ans d'expérience » dans l'en-tête du CV.
        fiche = ancien({"experience": [], "years_experience": 12})
        self.assertEqual(fiche["years_experience"], 0)
        self.assertNotIn("anciennete_source", fiche)

    def test_le_chemin_actuel_retient_la_valeur_et_la_nomme(self):
        fiche = NORMALIZE({"experience": [], "years_experience": 12})
        self.assertEqual((fiche["years_experience"], fiche["anciennete_source"]),
                         (12, "docie"))

    def test_une_periode_lisible_donne_le_meme_resultat_qu_avant(self):
        """Le témoin doit aussi montrer ce qui n'a PAS changé.

        Là où l'ancien chemin avait de quoi mesurer, la valeur est identique :
        #174 n'a rien pris au calcul, il lui a ajouté un repli.
        """
        ancien = _normalize_ancien([(_SansLeRepliDocie(), 3)])
        donnees = {"experience": [{"period": "Janvier 2019 - Décembre 2022"}],
                   "years_experience": 12}
        self.assertEqual(ancien(donnees)["years_experience"],
                         NORMALIZE(donnees)["years_experience"])


class ChirurgieTests(unittest.TestCase):
    """Le témoin ne vaut que si la chirurgie mord vraiment sur le code actuel."""

    def test_une_cle_absente_fait_echouer_le_temoin(self):
        with self.assertRaises(AssertionError):
            _normalize_ancien([(_SansLaCle("experience", "cle_qui_n_existe_pas"), 1)])

    def test_une_rubrique_inconnue_fait_echouer_le_temoin(self):
        with self.assertRaises(AssertionError):
            _normalize_ancien([(_SansLaCle("rubrique_inconnue", "location"), 1)])


if __name__ == "__main__":
    unittest.main()
