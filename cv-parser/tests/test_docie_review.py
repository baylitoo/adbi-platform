"""Tests de la relecture DocIE côté cv-parser (issue #172).

Aucun appel réseau : `docie_review` est une traduction pure, et l'épreuve de
bout en bout part de la VRAIE réponse DocIE enregistrée dans le dépôt
(document-parsing/fixtures/cv_samples/results/simple_docie.json), passée par
`docie_client.map_resume` puis par la revue — la chaîne réelle de process_cv.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docie_client import map_resume
from docie_review import (SEUIL_CONFIANCE, est_rempli, perimer_revue,
                          positions_apres_tri, revue_docie, valeur_au_chemin)

FIXTURE = (Path(__file__).resolve().parents[2]
           / "document-parsing/fixtures/cv_samples/results/simple_docie.json")


def _fixture_data():
    """Fiche extraite telle que process_cv la reçoit, depuis la vraie réponse."""
    reponse = json.loads(FIXTURE.read_text(encoding="utf-8"))
    reponse["schema_name"] = "adbi_resume"
    return map_resume(reponse, expected_schema="adbi_resume")


def _confiances(resultat, chemin="", dans=None):
    """Reproduit la carte que le bridge rend dans metadata.field_confidence.

    Mêmes chemins que document-parsing/bridge/docie_bridge.py (PR #173) :
    « contact.email », « experience[0].title », « skills[1].items[2].item ».
    Reconstruite ici pour que ce test tourne sur la vraie réponse enregistrée
    sans dépendre de l'ordre de déploiement du bridge.
    """
    dans = {} if dans is None else dans
    if isinstance(resultat, list):
        for index, element in enumerate(resultat):
            _confiances(element, "%s[%d]" % (chemin, index), dans)
    elif isinstance(resultat, dict):
        if "value" in resultat and ("confidence" in resultat or "evidence_ids" in resultat):
            if chemin and isinstance(resultat.get("confidence"), (int, float)):
                dans[chemin] = resultat["confidence"]
            return _confiances(resultat["value"], chemin, dans)
        for cle, valeur in resultat.items():
            _confiances(valeur, ("%s.%s" % (chemin, cle)) if chemin else cle, dans)
    return dans


class CheminsTests(unittest.TestCase):
    def test_chemins_docie_du_schema_servi(self):
        """Les clés sont les noms du schéma RÉELLEMENT servi, pas ceux des
        exemples DocIE : `name`/`experience[0].start_date`, pas `full_name`."""
        data = {"name": "Camille", "experience": [{"start_date": "2020-01"}]}
        self.assertEqual(valeur_au_chemin(data, "name"), "Camille")
        self.assertEqual(valeur_au_chemin(data, "experience[0].start_date"), "2020-01")
        self.assertIsNone(valeur_au_chemin(data, "experience[9].start_date"))
        self.assertIsNone(valeur_au_chemin(data, "full_name"))

    def test_feuille_aplatie_reste_trouvable(self):
        """map_resume aplatit skills[].items[].item en chaînes : sans repli, le
        champ douteux serait pris pour vide et jamais signalé."""
        data = {"skills": [{"category": "Data", "items": ["SQL", "Python"]}],
                "interests": ["Escalade"]}
        self.assertEqual(valeur_au_chemin(data, "skills[0].items[1].item"), "Python")
        self.assertEqual(valeur_au_chemin(data, "interests[0].interest"), "Escalade")

    def test_est_rempli(self):
        for vide in (None, "", "   ", [], {}, False):
            self.assertFalse(est_rempli(vide))
        for rempli in ("x", [1], {"a": 1}, 0.5, True):
            self.assertTrue(est_rempli(rempli))


class RevueTests(unittest.TestCase):
    def test_champ_tronque_devient_a_verifier_sur_le_bon_chemin(self):
        data = {"name": "Camille Béranger",
                "experience": [{"company": "Numelia", "description": "A · B"},
                               {"company": "Studio Pixelia", "description": "C"}]}
        revue = revue_docie(data, {"validation": {"valid": True, "errors": [], "warnings": []},
                                   "field_confidence": {"experience[1].description": 0.5}})
        self.assertEqual(revue["needs_review"], ["experience[1].description"])
        self.assertEqual(revue["warnings"], [])

    def test_confiance_haute_ne_signale_rien_et_champ_vide_non_plus(self):
        data = {"name": "Camille", "contact": {"email": "c@example.fr", "linkedin": ""}}
        revue = revue_docie(data, {"validation": {}, "field_confidence": {
            "name": 1, "contact.email": 0.9, "contact.linkedin": 0}})
        self.assertEqual(revue, {"needs_review": [], "warnings": []})

    def test_seuil_inclusif(self):
        """DocIE plafonne à EXACTEMENT 0.5 un champ tronqué : le seuil doit
        l'attraper, juste au-dessus ne doit rien signaler."""
        data = {"title": "Développeuse"}
        self.assertEqual(SEUIL_CONFIANCE, 0.5)
        self.assertEqual(revue_docie(data, {"validation": {}, "field_confidence": {"title": 0.5}})["needs_review"],
                         ["title"])
        self.assertEqual(revue_docie(data, {"validation": {}, "field_confidence": {"title": 0.51}})["needs_review"],
                         [])

    def test_logprob_n_est_jamais_pris_pour_un_seuil(self):
        """`model_logprob` est une log-probabilité (<= 0), pas un score 0-1 :
        seule `confidence` alimente la revue, sinon tout champ qui en porte une
        serait signalé (-7.5 est sous n'importe quel seuil 0-1)."""
        data = {"name": "Camille"}
        revue = revue_docie(data, {"validation": {}, "field_confidence": {}, "model_logprob": -7.5})
        self.assertEqual(revue["needs_review"], [])

    def test_champ_sans_equivalent_sort_en_avertissement_pas_en_faux_chemin(self):
        """skills/languages/interests sont dédupliqués et filtrés par
        normalize_cv_data : l'index DocIE y désignerait la mauvaise ligne.
        experience[].location et certifications[].issuer sont supprimés."""
        data = {"skills": [{"category": "Data", "items": ["SQL"]}],
                "languages": [{"language": "Anglais", "level": "C1"}],
                "contact": {"github": "github.com/camille"},
                "experience": [{"company": "Numelia", "location": "Lyon"}],
                "certifications": [{"name": "AWS", "issuer": "Amazon"}]}
        revue = revue_docie(data, {"validation": {}, "field_confidence": {
            "skills[0].items[0].item": 0.5, "languages[0].level": 0.4,
            "contact.github": 0.5,
            "experience[0].location": 0.5, "certifications[0].issuer": 0.2}})
        self.assertEqual(revue["needs_review"], [])
        self.assertEqual(sorted(revue["warnings"]), sorted([
            "docie_confiance_faible:skills[0].items[0].item",
            "docie_confiance_faible:languages[0].level",
            # `github` est stocké mais affiché par aucun onglet : le marquer
            # annoncerait un champ à relire introuvable à l'écran.
            "docie_confiance_faible:contact.github",
            "docie_confiance_faible:experience[0].location",
            "docie_confiance_faible:certifications[0].issuer"]))

    def test_renommages_de_map_resume_sont_suivis(self):
        """degree/institution/year deviennent title/subtitle/period, et
        start_date/end_date sont fusionnés en period."""
        data = {"education": [{"degree": "Master", "institution": "Lyon 1", "year": "2019"}],
                "experience": [{"company": "Numelia", "start_date": "2020-01"}]}
        revue = revue_docie(data, {"validation": {}, "field_confidence": {
            "education[0].degree": 0.5, "education[0].institution": 0.5,
            "education[0].year": 0.3, "experience[0].start_date": 0.5}})
        self.assertEqual(revue["needs_review"], [
            "education[0].title", "education[0].subtitle", "education[0].period",
            "experience[0].period"])

    def test_years_experience_recalcule_n_est_pas_signale(self):
        revue = revue_docie({"years_experience": 4},
                            {"validation": {}, "field_confidence": {"years_experience": 0.2}})
        self.assertEqual(revue, {"needs_review": [], "warnings": []})

    def test_avertissements_et_erreurs_docie_verbatim(self):
        """La prose de DocIE n'a aucun format stable : reprise telle quelle,
        jamais analysée pour en déduire un nom de champ."""
        validation = {"valid": False,
                      "errors": ["name : evidence id inconnu"],
                      "warnings": ["experience[1].description truncated after 3 repeats: repetition loop detected"]}
        revue = revue_docie({"name": "Camille"}, {"validation": validation, "field_confidence": {}})
        self.assertEqual(revue["warnings"], [
            "docie_validation_negative",
            "docie_erreur:name : evidence id inconnu",
            "docie_avertissement:experience[1].description truncated after 3 repeats: repetition loop detected"])

    def test_validation_absente_n_est_pas_un_succes(self):
        """`validation` accompagne toute extraction terminée : son absence
        signale une réponse qu'on n'a pas pu vérifier."""
        revue = revue_docie({"name": "Camille"}, {"validation": None, "event_id": "e1"})
        self.assertEqual(revue["warnings"], ["docie_validation_absente"])

    def test_metadonnees_sans_revue_comportement_inchange(self):
        """Rétrocompatibilité : le chemin historique docie_client ne fournit
        pas field_confidence — deux listes vides, aucune marque inventée."""
        self.assertEqual(revue_docie({"name": "Camille"}, {"validation": {}, "event_id": "e1"}),
                         {"needs_review": [], "warnings": []})
        self.assertEqual(revue_docie(None, None), {"needs_review": [], "warnings": []})


class FixtureReelleTests(unittest.TestCase):
    """Bout en bout sur la vraie réponse DocIE enregistrée dans le dépôt."""

    def test_cv_propre_n_ajoute_aucun_bruit(self):
        data = _fixture_data()
        confiances = _confiances(json.loads(FIXTURE.read_text(encoding="utf-8"))["result"])
        self.assertEqual(len(confiances), 40)          # 40 champs ancrés
        reponse = json.loads(FIXTURE.read_text(encoding="utf-8"))
        revue = revue_docie(data, {"validation": reponse.get("validation"),
                                   "field_confidence": confiances})
        # Les seules confiances <= 0.5 du CV sont github/linkedin, VIDES :
        # une absence, déjà couverte par le bilan ADBI — pas une alerte.
        self.assertEqual({c: v for c, v in confiances.items() if v <= SEUIL_CONFIANCE},
                         {"contact.github": 0, "contact.linkedin": 0})
        self.assertEqual(revue, {"needs_review": [], "warnings": []})

    def test_meme_cv_avec_une_liste_tronquee_par_docie(self):
        """DocIE plafonne à 0.5 la confiance d'un champ tronqué et joint
        l'avertissement correspondant : les deux doivent arriver au relecteur."""
        data = _fixture_data()
        confiances = _confiances(json.loads(FIXTURE.read_text(encoding="utf-8"))["result"])
        confiances["experience[1].description"] = 0.5
        validation = {"valid": True, "errors": [], "warnings": [
            "experience[1].description truncated after 3 repeats: repetition loop detected"]}
        revue = revue_docie(data, {"validation": validation, "field_confidence": confiances})
        self.assertEqual(revue["needs_review"], ["experience[1].description"])
        self.assertEqual(revue["warnings"], [
            "docie_avertissement:experience[1].description truncated after 3 repeats: repetition loop detected"])
        # Le champ marqué est bien rempli dans la fiche : c'est une valeur
        # PARTIELLE, pas une absence — invisible sans ce signal.
        self.assertTrue(data["experience"][1]["description"])


class PerimerRevueTests(unittest.TestCase):
    """PATCH /api/cvs/<id> : la rubrique enregistrée a été relue à l'écran."""

    def test_rubrique_enregistree_perd_ses_marques(self):
        cv = {"docie_review": {"needs_review": ["experience[0].company", "contact.email", "title"],
                               "warnings": ["docie_avertissement:truncated"]}}
        perimer_revue(cv, {"experience": [{"company": "Numelia"}]})
        self.assertEqual(cv["docie_review"]["needs_review"], ["contact.email", "title"])
        # Les avertissements décrivent l'extraction, pas un champ éditable.
        self.assertEqual(cv["docie_review"]["warnings"], ["docie_avertissement:truncated"])

    def test_rubrique_non_envoyee_garde_sa_marque(self):
        cv = {"docie_review": {"needs_review": ["education[1].title"], "warnings": []}}
        perimer_revue(cv, {"name": "Camille"})
        self.assertEqual(cv["docie_review"]["needs_review"], ["education[1].title"])

    def test_fiche_sans_revue_est_intacte(self):
        cv = {"name": "Camille"}
        perimer_revue(cv, {"name": "Camille"})
        self.assertNotIn("docie_review", cv)


class GabaritTests(unittest.TestCase):
    """L'écran de relecture (templates/cv_detail.html) doit montrer le signal.

    Rendu via jinja2 directement : importer app.py exigerait une base
    PostgreSQL (init_schema au chargement), sans rien apprendre de plus sur le
    gabarit.
    """

    def _rendu(self, cv):
        from jinja2 import Environment, FileSystemLoader, select_autoescape
        racine = Path(__file__).resolve().parents[1] / "templates"
        env = Environment(loader=FileSystemLoader(str(racine)),
                          autoescape=select_autoescape(["html"]))
        env.globals["url_for"] = lambda point, **kw: "/static/" + kw.get("filename", "")
        return env.get_template("cv_detail.html").render(cv=cv, linked_cvs=[])

    def test_champ_peu_sur_est_marque_et_avertissement_affiche_verbatim(self):
        avertissement = "experience[1].description truncated after 3 repeats: repetition loop detected"
        html = self._rendu({
            "id": "cv1", "name": "Camille Béranger", "title": "Développeuse",
            "contact": {"email": "camille@example.fr"},
            "experience": [{"company": "Numelia", "title": "Dev", "description": "A"},
                           {"company": "Studio Pixelia", "title": "Dev", "description": "B"}],
            "docie_review": {"needs_review": ["experience[1].description", "contact.email"],
                             "warnings": ["docie_avertissement:" + avertissement]},
        })
        self.assertIn("revue-docie", html)
        self.assertIn(avertissement, html)              # verbatim, pas reformulé
        self.assertIn("2 champs à relire", html)
        self.assertIn('class="field-val a-verifier" contenteditable="true" data-section="contact" data-field="email"', html)
        # La marque tombe sur la BONNE mission : la seconde, pas la première.
        self.assertIn('class="bullets-label a-verifier"', html)
        self.assertEqual(html.count("a-verifier\""), 2)
        self.assertLess(html.index("Studio Pixelia"), html.index('class="bullets-label a-verifier"'))

    def test_fiche_sans_revue_rend_l_ecran_inchange(self):
        html = self._rendu({"id": "cv1", "name": "Camille", "experience": [],
                            "contact": {"email": "camille@example.fr"}})
        self.assertNotIn("revue-docie\"", html)
        self.assertNotIn("a-verifier\"", html)


class MarqueApresTriTests(unittest.TestCase):
    """#177 ligne 7 : la marque suit sa mission quand le tri la déplace.

    La vraie réponse enregistrée est DÉJÀ dans l'ordre chronologique — le tri y
    est l'identité et ne prouverait donc rien. Les missions sont ici données à
    l'ENVERS, comme un CV qui les liste de la plus ancienne à la plus récente.
    """

    MISSIONS = [
        {"company": "Ancienne", "title": "Dev junior",
         "start_date": "Septembre 2019", "end_date": "Février 2022",
         "description": "la plus ancienne, donnée en premier par DocIE"},
        {"company": "Recente", "title": "Dev senior",
         "start_date": "Mars 2022", "end_date": "Aujourd'hui",
         "description": "la plus récente, donnée en second"},
    ]

    def test_la_permutation_est_celle_du_tri(self):
        positions = positions_apres_tri({"experience": self.MISSIONS})
        # DocIE 0 (« Ancienne ») descend en position 1 ; DocIE 1 remonte en 0.
        self.assertEqual(positions["experience"], {0: 1, 1: 0})

    def test_un_champ_peu_sur_de_la_mission_ancienne_est_marque_a_sa_nouvelle_place(self):
        revue = revue_docie(
            {"experience": self.MISSIONS},
            {"validation": {}, "field_confidence": {"experience[0].description": 0.5}},
        )
        # Sans traduction, ce serait « experience[0].description », c'est-à-dire
        # la mission « Recente » une fois la fiche triée : la mauvaise.
        self.assertEqual(revue["needs_review"], ["experience[1].description"])

    def test_la_fiche_triee_porte_bien_la_mission_designee(self):
        """Le chemin marqué et la fiche rendue par normalize_cv_data concordent."""
        import ast
        import re as _re
        from datetime import datetime

        from niveau_langue import niveau_cecrl
        from periode_mission import (analyser_periode, index_mois, mois_courant,
                                     ordre_missions, periode_lisible, titre_de_repli)

        racine = Path(__file__).resolve().parents[1]
        arbre = ast.parse((racine / "app.py").read_text(encoding="utf-8"))
        source = "\n\n".join(
            ast.unparse(n) for n in arbre.body
            if isinstance(n, ast.FunctionDef)
            and n.name in {"normalize_cv_data", "compute_years_experience"}
        )
        espace = {"re": _re, "datetime": datetime, "analyser_periode": analyser_periode,
                  "ordre_missions": ordre_missions, "index_mois": index_mois,
                  "mois_courant": mois_courant, "periode_lisible": periode_lisible,
                  "titre_de_repli": titre_de_repli, "niveau_cecrl": niveau_cecrl,
                  "normalize_skills": lambda *a, **k: {},
                  "skills_to_flat": lambda *a, **k: [],
                  "compute_skills_flat": lambda *a, **k: []}
        exec(compile(source, str(racine / "app.py"), "exec"), espace)

        fiche = espace["normalize_cv_data"]({"experience": self.MISSIONS})
        self.assertEqual([e["company"] for e in fiche["experience"]], ["Recente", "Ancienne"])
        revue = revue_docie(
            {"experience": self.MISSIONS},
            {"validation": {}, "field_confidence": {"experience[0].description": 0.5}},
        )
        index = int(revue["needs_review"][0].split("[")[1].split("]")[0])
        self.assertEqual(fiche["experience"][index]["company"], "Ancienne")

    def test_un_index_hors_liste_sort_en_avertissement_pas_en_fausse_position(self):
        revue = revue_docie(
            {"experience": self.MISSIONS},
            {"validation": {}, "field_confidence": {"experience[7].description": 0.4}},
        )
        self.assertEqual(revue["needs_review"], [])

    def test_les_autres_listes_gardent_leur_index(self):
        """Seule `experience` est réordonnée : education et certifications non."""
        data = {"education": [{"degree": "Master", "institution": "Lyon 1"},
                              {"degree": "Licence", "institution": "Rennes 1"}]}
        revue = revue_docie(data, {"validation": {}, "field_confidence": {
            "education[1].degree": 0.5}})
        self.assertEqual(revue["needs_review"], ["education[1].title"])


if __name__ == "__main__":
    unittest.main()
