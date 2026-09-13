"""Issue #175 : le cache par empreinte perdait l'avertissement de relecture.

Un document déjà analysé n'est pas ré-analysé au re-dépôt : sa fiche est
recopiée (route `/api/upload`, cache par empreinte SHA-256). La copie reprenait
`docie_review` — les champs dont DocIE doute — mais PAS `parse_warning`, la
phrase qui le dit au commercial : `parse_summary.avertissement` revenait vide.

Un CV qui avertissait au premier dépôt se re-déposait donc en silence, c'est-à-
dire que le signal de relecture disparaissait exactement au moment où quelqu'un
revérifie le document.

Ce que ce fichier mesure, sur la VRAIE réponse DocIE enregistrée
(document-parsing/fixtures/cv_samples/results/simple_docie.json) :
  1. la fiche d'origine avertit bien (chaîne réelle map_resume -> revue_docie,
     celle de process_cv) ;
  2. la copie du cache porte le même avertissement, et `avertissement` du
     résumé de parsing n'est plus vide ;
  3. RIEN d'autre que les champs du dépôt n'est perdu à la copie — la garde
     qui casse si un champ d'analyse rejoignait un jour la liste d'exclusion ;
  4. la route et `process_cv` utilisent réellement ce qui est mesuré ici.

`app.py` ouvre PostgreSQL à l'import ; ses fonctions sont donc extraites par
`ast`, comme test_champs_conserves.py et test_periode_mission.py.
"""
import ast
import json
import sys
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from docie_client import map_resume  # noqa: E402
from docie_review import revue_docie  # noqa: E402

REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)
SOURCE_APP = (RACINE / "app.py").read_text(encoding="utf-8")

# Phrase posée par app.py::process_cv quand DocIE signale quelque chose.
AVERTISSEMENT = "DocIE signale des champs à vérifier. Relisez la fiche extraite."


def _de_app(noms):
    """Extrait des noms d'app.py sans l'importer (il ouvre PostgreSQL)."""
    arbre = ast.parse(SOURCE_APP)
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, (ast.FunctionDef, ast.Assign)) and _nom(n) in noms
    )
    espace = {}
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace


def _nom(noeud):
    if isinstance(noeud, ast.FunctionDef):
        return noeud.name
    cibles = [c.id for c in noeud.targets if isinstance(c, ast.Name)]
    return cibles[0] if cibles else ""


APP = _de_app({"fiche_depuis_le_cache", "CHAMPS_PROPRES_AU_DEPOT"})


def _fiche_analysee():
    """La fiche telle que process_cv la construit, depuis la vraie réponse.

    La confiance par champ est celle que DocIE plafonne à 0,5 quand il a dû
    tronquer une liste (issue #172) : le chemin cité par #175 lui-même,
    « experience[1].description ». Le reste — `docie_review`, `parse_warning` —
    suit la chaîne réelle de process_cv, pas une valeur écrite à la main.
    """
    reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
    reponse["schema_name"] = "adbi_resume"
    data = map_resume(reponse, expected_schema="adbi_resume")
    metadata = {"event_id": reponse["request_id"], "model_profile": reponse["model_profile"],
                "validation": reponse["validation"],
                "field_confidence": {"experience[1].description": 0.5}}
    revue = revue_docie(data, metadata)
    fiche = dict(data)
    fiche.update({
        "llm_enriched": True,
        "parsing_mode": "docie-bridge",
        "extraction": "docie-bridge",
        "llm_service": "DocIE Bridge / " + reponse["model_profile"],
        "docie_event_id": metadata["event_id"],
        "docie_validation": metadata["validation"],
        "docie_review": revue,
        "bilan_adbi": {"exploitable": True},
        # Champs du dépôt, propres au fichier d'origine.
        "id": "fiche-origine", "filename": "camille.pdf", "ext": ".pdf",
        "uploaded_at": "2026-01-01T00:00:00", "stored_at": "2026-01-01T00:00:00",
        "empreinte": "sha256-de-test",
        # Recalculé pour chaque réponse, jamais stocké en principe — une fiche
        # ancienne peut en porter un, et la copie doit l'écarter comme avant.
        "parse_summary": {"avertissement": AVERTISSEMENT},
    })
    if revue["needs_review"] or revue["warnings"]:
        fiche["parse_warning"] = AVERTISSEMENT
    return fiche


class CacheEmpreinteTests(unittest.TestCase):
    def setUp(self):
        self.source = _fiche_analysee()
        self.copie = APP["fiche_depuis_le_cache"](self.source)

    def test_la_fiche_dorigine_avertit_vraiment(self):
        """Sans cela le reste du fichier ne mesurerait rien."""
        self.assertTrue(self.source["docie_review"]["needs_review"])
        self.assertEqual(self.source["parse_warning"], AVERTISSEMENT)

    def test_le_readepot_garde_lavertissement_et_la_revue(self):
        """Le cœur de #175 : avant, `docie_review` passait et l'avertissement non."""
        self.assertEqual(self.copie["docie_review"], self.source["docie_review"])
        self.assertEqual(self.copie["parse_warning"], AVERTISSEMENT)

    def test_le_resume_de_parsing_nest_plus_vide(self):
        """`parse_summary.avertissement`, l'expression même de la route."""
        self.assertEqual(self.copie.get("parse_warning", ""), AVERTISSEMENT)

    def test_seuls_les_champs_du_depot_sont_perdus(self):
        """Garde : aucun champ d'ANALYSE ne doit rejoindre la liste d'exclusion.

        C'est la vérification demandée au-delà du champ nommé par #175 — elle
        cassera si `docie_validation`, `docie_event_id`, `llm_service` ou un
        futur signal de relecture venait à être exclu à son tour.
        """
        perdus = set(self.source) - set(self.copie)
        self.assertEqual(perdus, set(APP["CHAMPS_PROPRES_AU_DEPOT"]))
        for cle in ("docie_review", "parse_warning", "docie_validation",
                    "docie_event_id", "llm_service", "parsing_mode", "bilan_adbi"):
            self.assertIn(cle, self.copie, cle)

    def test_la_copie_reste_etiquetee_comme_telle(self):
        """Ce que la reprise doit au contraire CHANGER, et rien de plus."""
        self.assertEqual(self.copie["extraction"], "cache")
        self.assertEqual(self.copie["copie_de"], "fiche-origine")
        self.assertTrue(self.copie["llm_parsed"])

    def test_la_route_et_process_cv_utilisent_bien_ceci(self):
        """Épingle le lien mesuré ici : sinon le test passerait à côté du code."""
        self.assertIn("cv_data = fiche_depuis_le_cache(source_cache)", SOURCE_APP)
        self.assertIn('"avertissement": cv_data.get("parse_warning", "")', SOURCE_APP)
        self.assertIn('cv_data["parse_warning"] = "%s"' % AVERTISSEMENT, SOURCE_APP)


if __name__ == "__main__":
    unittest.main()
