"""Résultat partiel (#203) dit sur TOUTES les voies DocIE, choix de modèle ou non (#194).

Aucun appel DocIE : `revue_docie` est pure, process_cv est extrait d'app.py
par `ast` (app.py ouvre PostgreSQL à l'import) avec des extracteurs simulés,
et la voie texte historique (docie_client) reçoit une session `requests`
simulée. Les chaînes d'avertissement sont reconnues par le VRAI bridge
(`resultat_partiel`), jamais par une copie.
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import docie_client  # noqa: E402
from docie_review import (AVERTISSEMENT_TRONCATURE, LIBELLES_PARTIEL,  # noqa: E402
                          libelle_partiel, revue_docie)
from test_choix_modele import DEUX_AGENT, DEUX_TEXTE, docx, environnement, fonctions_d_app, rendre  # noqa: E402

RAISONS = ("boucle", "valeur_abandonnee", "forme_invalide", "feuille_abandonnee", "liste_plafonnee_possible")

# Chaînes DocIE réelles (formes figées par document-parsing/fixtures/avertissements_docie.json).
AVERTISSEMENTS = {
    "boucle": ("skills: model output repeated itself (Python, SQL); list truncated at the loop start, "
               "remaining items dropped; confidence capped to 0.5 as a review flag"),
    "valeur_abandonnee": "years_experience: douze is not a number; value dropped",
    "forme_invalide": "experience[0].end_date: the model wrote {'x': 1} in a shape this field cannot hold; nothing was kept",
    "feuille_abandonnee": "contact.email: value is not a valid email address; dropped",
}

# DocIE rend la plus ancienne mission d'abord ; la fiche les retrie (#177 ligne 7).
MISSIONS = [
    {"company": "Ancienne", "title": "Dev junior", "start_date": "Septembre 2019", "end_date": "",
     "period": "Septembre 2019"},
    {"company": "Recente", "title": "Dev senior", "start_date": "Mars 2022", "end_date": "Aujourd'hui",
     "period": "Mars 2022 – Aujourd'hui"},
]


def donnees():
    return {"name": "Alice Dupont", "title": "Data Engineer", "contact": {"email": ""},
            "experience": [dict(m) for m in MISSIONS], "education": [], "skills": [{"category": "Data", "items": ["SQL"]}],
            "languages": [], "certifications": [], "interests": [f"i{n}" for n in range(100)]}


PARTIEL_COMPLET = [
    {"champ": "skills", "raison": "boucle"},
    {"champ": "years_experience", "raison": "valeur_abandonnee"},
    {"champ": "experience[0].end_date", "raison": "forme_invalide"},
    {"champ": "contact.email", "raison": "feuille_abandonnee"},
    {"champ": "interests", "raison": "liste_plafonnee_possible"},
]

VALIDATION_OK = {"valid": True, "errors": [], "warnings": []}


class Revue(unittest.TestCase):
    """docie_review.revue_docie : le partiel rejoint la revue existante."""

    def test_chaque_raison_a_sa_ligne_francaise(self):
        revue = revue_docie(donnees(), {"validation": VALIDATION_OK, "partiel": PARTIEL_COMPLET})
        self.assertEqual(set(LIBELLES_PARTIEL), set(RAISONS))
        for entree in PARTIEL_COMPLET:
            ligne = "Résultat partiel — %s : %s" % (entree["champ"], LIBELLES_PARTIEL[entree["raison"]])
            self.assertIn(ligne, revue["warnings"])
        self.assertIn("Résultat partiel — skills : la sortie du modèle se répétait, la liste a été coupée "
                      "et la suite abandonnée", revue["warnings"])
        self.assertIn("Résultat partiel — interests : liste d'exactement 100 éléments, peut-être plafonnée",
                      revue["warnings"])
        for texte in revue["warnings"]:
            self.assertNotIn("valeur_abandonnee", texte, "jamais le code brut à la place du libellé")

    def test_chemins_traduits_vers_la_fiche_missions_retriees_comprises(self):
        revue = revue_docie(donnees(), {"validation": VALIDATION_OK, "partiel": PARTIEL_COMPLET})
        # experience[0] côté DocIE = « Ancienne » = position 1 après tri ; end_date -> period.
        # contact.email est VIDE (valeur abandonnée) et doit quand même être marqué.
        self.assertEqual(revue["needs_review"], ["experience[1].period", "contact.email"])

    def test_nom_et_titre_marques(self):
        revue = revue_docie({"name": "A", "title": "B"}, {"validation": VALIDATION_OK, "partiel": [
            {"champ": "name", "raison": "feuille_abandonnee"}, {"champ": "title", "raison": "forme_invalide"}]})
        self.assertEqual(revue["needs_review"], ["name", "title"])

    def test_index_hors_liste_n_invente_aucune_position(self):
        revue = revue_docie(donnees(), {"validation": VALIDATION_OK,
                                        "partiel": [{"champ": "experience[7].title", "raison": "forme_invalide"}]})
        self.assertEqual(revue["needs_review"], [])
        self.assertEqual(len([w for w in revue["warnings"] if w.startswith("Résultat partiel")]), 1)

    def test_troncature_avertissement_de_fiche_sans_marque(self):
        revue = revue_docie({"name": "A"}, {"validation": VALIDATION_OK, "troncature_possible": True})
        self.assertEqual(revue, {"needs_review": [], "warnings": [AVERTISSEMENT_TRONCATURE]})
        self.assertEqual(AVERTISSEMENT_TRONCATURE, "CV peut-être tronqué : plus de 800 lignes")
        for valeur in (False, None, "true", 1):
            self.assertEqual(revue_docie({"name": "A"}, {"validation": VALIDATION_OK, "troncature_possible": valeur}),
                             {"needs_review": [], "warnings": []})

    def test_metadonnees_absentes_ou_bancales_revue_d_avant(self):
        base = revue_docie(donnees(), {"validation": VALIDATION_OK})
        for partiel in (None, [], "skills", {"champ": "skills"}, [None, 3, {"raison": "boucle"}, {"champ": ""}]):
            self.assertEqual(revue_docie(donnees(), {"validation": VALIDATION_OK, "partiel": partiel}), base)
        self.assertEqual(revue_docie(donnees(), None)["needs_review"], [])

    def test_raison_inconnue_gardee_et_doublon_dit_une_fois(self):
        revue = revue_docie({"name": "A"}, {"validation": VALIDATION_OK, "partiel": [
            {"champ": "name", "raison": "nouvelle_raison"}, {"champ": "name", "raison": "nouvelle_raison"}]})
        self.assertEqual(revue["warnings"], ["Résultat partiel — name : nouvelle_raison"])
        self.assertEqual(revue["needs_review"], ["name"])
        self.assertEqual(libelle_partiel("name", "nouvelle_raison"), "Résultat partiel — name : nouvelle_raison")

    def test_meme_libelles_que_one_pager(self):
        source = (RACINE.parent / "one-pager" / "public" / "app.js").read_text(encoding="utf-8")
        for raison, libelle in LIBELLES_PARTIEL.items():
            self.assertIn(f'{raison}: "{libelle}"', source)
        self.assertIn(f'"{AVERTISSEMENT_TRONCATURE}"', source)


class ProcessCv(unittest.TestCase):
    """process_cv (extrait d'app.py) : toutes les voies, choix ou non."""

    def process_cv(self):
        return fonctions_d_app("process_cv", Path=Path, noter_progression=lambda *a, **k: None,
                               normalize_cv_data=lambda d: dict(d), bilan_adbi=lambda cv: {})["process_cv"]

    @staticmethod
    def extracteur(metadata, data=None):
        def extraire(chemin, progress=None, **options):
            return (data if data is not None else donnees(),
                    {"event_id": "r1", "model_profile": "", "validation": dict(VALIDATION_OK),
                     "field_confidence": {}, "schema_reported": True, **metadata})
        return extraire

    def test_voie_bridge_sans_choix_marques_et_lignes_donnees_intactes(self):
        meta = {"agent": "agent_nu", "transport": "docie-bridge"}
        with environnement(**DEUX_AGENT):
            with patch("docie_bridge_extraction.extract_resume",
                       self.extracteur({**meta, "partiel": PARTIEL_COMPLET, "troncature_possible": None})):
                fiche = self.process_cv()("cv.pdf")
            with patch("docie_bridge_extraction.extract_resume", self.extracteur({**meta, "partiel": []})):
                propre = self.process_cv()("cv.pdf")
        revue = fiche["docie_review"]
        self.assertEqual(revue["needs_review"], ["experience[1].period", "contact.email"])
        self.assertEqual(sum(w.startswith("Résultat partiel — ") for w in revue["warnings"]), 5)
        self.assertEqual(fiche["parse_warning"], "DocIE signale des champs à vérifier. Relisez la fiche extraite.")
        # Non bloquant : seules la revue et la phrase d'avertissement diffèrent.
        self.assertNotIn("partiel", fiche["modele_extraction"])
        pareil = lambda f: {k: v for k, v in f.items() if k not in ("docie_review", "parse_warning", "_timing")}
        self.assertEqual(pareil(fiche), pareil(propre))
        self.assertNotIn("parse_warning", propre)
        self.assertEqual(propre["docie_review"], {"needs_review": [], "warnings": []})

    def test_voie_texte_historique_sans_choix_reconnue_par_le_bridge(self):
        """docie_client ne passe pas par le bridge : aucun `partiel` dans ses
        métadonnées. Chaque raison est relevée par `resultat_partiel` du bridge."""
        avec_avertissements = self.extracteur({"model_profile": "store:nuextract3", "troncature_possible": True})

        def extraire(chemin, progress=None, **options):
            data, meta = avec_avertissements(chemin, progress, **options)
            meta["validation"]["warnings"] = list(AVERTISSEMENTS.values())
            return data, meta

        with environnement(**DEUX_TEXTE), patch("docie_client.extract_resume", extraire):
            fiche = self.process_cv()("cv.docx")
        revue = fiche["docie_review"]
        for entree in PARTIEL_COMPLET:
            self.assertIn(libelle_partiel(entree["champ"], entree["raison"]), revue["warnings"])
        self.assertEqual(revue["needs_review"], ["experience[1].period", "contact.email"])
        self.assertIn(AVERTISSEMENT_TRONCATURE, revue["warnings"])
        self.assertEqual(fiche["modele_extraction"]["demande"], None)
        self.assertNotIn("partiel", fiche["modele_extraction"])

    def test_choix_explicite_comportement_211_inchange_et_marques_en_plus(self):
        partiel = [{"champ": "skills", "raison": "boucle"}, {"champ": "experience", "raison": "liste_plafonnee_possible"}]
        with environnement(**DEUX_AGENT), patch(
                "docie_bridge_extraction.extract_resume",
                self.extracteur({"agent": "agent_nu", "transport": "docie-bridge", "partiel": partiel,
                                 "troncature_possible": None}, data={"name": "Alice Dupont"})):
            fiche = self.process_cv()("cv.pdf", modele="nuextract3")
        self.assertEqual(fiche["modele_extraction"]["partiel"], partiel)
        self.assertIsNone(fiche["modele_extraction"]["troncature_possible"])
        self.assertTrue(fiche["parse_warning"].endswith(
            "Résultat partiel du modèle choisi (skills, experience) : relisez ces champs."))
        self.assertEqual(fiche["parse_warning"].count("Résultat partiel du modèle choisi"), 1)
        self.assertIn(libelle_partiel("skills", "boucle"), fiche["docie_review"]["warnings"])

    def test_choix_explicite_troncature_seule_alerte_211(self):
        with environnement(**DEUX_TEXTE), patch(
                "docie_client.extract_resume",
                self.extracteur({"model_profile": "store:nuextract3", "troncature_possible": True},
                                data={"name": "Alice Dupont"})):
            fiche = self.process_cv()("cv.docx", modele="nuextract3")
        self.assertEqual(fiche["modele_extraction"]["troncature_possible"], True)
        self.assertIn("Document au-delà de 800 lignes non vides : le modèle a pu en ignorer la fin.", fiche["parse_warning"])
        self.assertIn(AVERTISSEMENT_TRONCATURE, fiche["docie_review"]["warnings"])

    def test_metadonnees_d_avant_ni_partiel_ni_validation_aucune_exception(self):
        def ancien(chemin, progress=None, **options):
            return {"name": "Alice Dupont"}, {"event_id": "r1", "model_profile": "", "validation": None}
        with environnement(**DEUX_TEXTE), patch("docie_client.extract_resume", ancien):
            fiche = self.process_cv()("cv.docx")
        self.assertEqual(fiche["docie_review"], {"needs_review": [], "warnings": ["docie_validation_absente"]})

    def test_bridge_introuvable_sans_choix_revue_d_avant(self):
        def extraire(chemin, progress=None, **options):
            return donnees(), {"event_id": "r1", "model_profile": "", "field_confidence": {},
                               "validation": {"valid": True, "errors": [], "warnings": [AVERTISSEMENTS["boucle"]]}}
        with environnement(**DEUX_TEXTE), patch("docie_client.extract_resume", extraire), \
                patch("docie_bridge_extraction._load_bridge", side_effect=ImportError("absent")):
            fiche = self.process_cv()("cv.docx")
        self.assertEqual(fiche["docie_review"]["needs_review"], [])
        self.assertEqual(fiche["docie_review"]["warnings"], ["docie_avertissement:" + AVERTISSEMENTS["boucle"]])


class VoieTexteHistorique(unittest.TestCase):
    """docie_client.extract_resume (inline) mesure désormais `troncature_possible`."""

    FIXTURE = RACINE.parent / "document-parsing/fixtures/cv_samples/results/simple_docie.json"

    def extraire(self, lignes, mode="inline"):
        sortie = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        sortie.update(schema_name="adbi_resume", request_id="request-1")
        session = Mock()
        session.request.return_value = Mock(status_code=200, json=lambda: sortie)
        chemin = docx(lignes)
        try:
            with patch.dict(os.environ, {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_EXTRACTION_MODE": mode}):
                return docie_client.extract_resume(chemin, session=session)[1]
        finally:
            chemin.unlink(missing_ok=True)

    def test_800_blocs_non_801_oui(self):
        self.assertEqual(self.extraire(800)["blocs_texte"], 800)
        self.assertIs(self.extraire(800)["troncature_possible"], False)
        self.assertIs(self.extraire(801)["troncature_possible"], True)

    def test_bridge_introuvable_non_mesurable(self):
        with patch("docie_bridge_extraction._load_bridge", side_effect=ImportError("absent")):
            meta = self.extraire(900)
        self.assertEqual((meta["blocs_texte"], meta["troncature_possible"]), (None, None))


class Affichage(unittest.TestCase):
    def test_fiche_marque_le_champ_et_dit_la_raison(self):
        revue = revue_docie(donnees(), {"validation": VALIDATION_OK, "partiel": PARTIEL_COMPLET,
                                        "troncature_possible": True})
        cv = {"id": "cv-1", "name": "Alice Dupont", "title": "Data Engineer", "contact": {"email": ""},
              "ext": ".pdf", "docie_review": revue}
        html = rendre("cv_detail.html", cv=cv, linked_cvs=[], modeles=[], modeles_erreur="")
        self.assertIn("2 champs à relire", html)
        self.assertRegex(html, r'class="field-val a-verifier"[^>]*data-field="email"')
        self.assertIn("Résultat partiel — contact.email : valeur invalide abandonnée", html)
        self.assertIn("CV peut-être tronqué : plus de 800 lignes", html)


class Cache(unittest.TestCase):
    def test_fiche_existante_reprise_telle_quelle(self):
        """Une fiche d'avant n'est pas réécrite : sa revue revient à l'identique ;
        seule une nouvelle analyse applique les marques."""
        espace = fonctions_d_app("fiche_depuis_le_cache",
                                 CHAMPS_PROPRES_AU_DEPOT=("id", "filename", "ext", "uploaded_at", "stored_at", "parse_summary"))
        ancienne = {"id": "a", "name": "Alice", "llm_enriched": True,
                    "docie_review": {"needs_review": [], "warnings": []}, "modele_extraction": {"demande": None}}
        copie = espace["fiche_depuis_le_cache"](ancienne)
        self.assertEqual(copie["docie_review"], {"needs_review": [], "warnings": []})
        self.assertNotIn("parse_warning", copie)


if __name__ == "__main__":
    unittest.main()
