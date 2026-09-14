"""#174 : la fiche dit D'OÙ vient le nombre d'années d'expérience.

Trois sources qui ne valent pas la même chose aboutissent dans la même case :

  * `periodes` — mesuré sur les dates de mission (`compute_years_experience`) ;
  * `docie`    — annoncé par l'extraction, faute de période lisible ;
  * `forfait`  — un an par mission dont la période est illisible ;
  * `manuel`   — retapé à l'écran ;
  * `aucune`   — ni période, ni annonce : le 0 affiché ne vient de rien.

« 12 ans » mesuré sur des dates et « 12 ans » recopiés d'un en-tête de CV
s'affichaient à l'identique, et c'est ce nombre que `core/matcher.py` classe.
`anciennete_source` est la provenance, sur le modèle de `niveau_declare` pour
les langues : calculée côté serveur, absente de `CHAMPS_MODIFIABLES_CV`.

`app.py` ouvre PostgreSQL à l'import ; ses fonctions sont donc extraites par
`ast`, comme test_periode_mission.py.
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
GABARITS = RACINE / "templates"


def _nom(noeud):
    if isinstance(noeud, ast.FunctionDef):
        return noeud.name
    cibles = [c.id for c in noeud.targets if isinstance(c, ast.Name)]
    return cibles[0] if cibles else ""


def _fonctions_de_app(noms, extras=None):
    """Extrait des fonctions d'app.py sans l'importer (il ouvre PostgreSQL).

    Les décorateurs sont retirés : `@app.route` / `@require_auth` exigeraient
    l'application Flask, donc une base.
    """
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    retenus = []
    for noeud in arbre.body:
        if not isinstance(noeud, (ast.FunctionDef, ast.Assign)) or _nom(noeud) not in noms:
            continue
        if isinstance(noeud, ast.FunctionDef):
            noeud.decorator_list = []
        retenus.append(noeud)
    manquants = noms - {_nom(n) for n in retenus}
    assert not manquants, f"introuvables dans app.py : {manquants}"
    espace = {
        "re": re,
        "json": json,
        "datetime": datetime,
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
        "CV_LIST_MAX": 200,
        "CV_SKILLS_FLAT_MAX": 400,
        "CHAMPS_LISTE_CV": ("experience", "education", "languages",
                            "certifications", "interests"),
    }
    espace.update(extras or {})
    exec(compile("\n\n".join(ast.unparse(n) for n in retenus),
                 str(RACINE / "app.py"), "exec"), espace)
    return espace


APP = _fonctions_de_app({
    "normalize_cv_data", "compute_years_experience",
    "marquer_anciennete_manuelle", "_filtrer_champs_cv",
    "CHAMPS_MODIFIABLES_CV", "LISTES_DE_DICTS_CV",
})


def _rendu(gabarit, **contexte):
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    env = Environment(loader=FileSystemLoader(str(GABARITS)),
                      autoescape=select_autoescape(["html"]))
    env.globals["url_for"] = lambda point, **kw: "/static/" + kw.get("filename", "")
    return env.get_template(gabarit).render(**contexte)


class SourceALaNormalisationTests(unittest.TestCase):
    """Chacune des quatre branches de `normalize_cv_data` se nomme."""

    def _fiche(self, missions, annonce=None):
        return APP["normalize_cv_data"](
            {"experience": missions, "years_experience": annonce})

    def test_une_periode_lisible_se_dit_mesuree(self):
        fiche = self._fiche([{"period": "Janvier 2019 - Décembre 2022"}], 12)
        self.assertEqual((fiche["years_experience"], fiche["anciennete_source"]),
                         (4, "periodes"))

    def test_la_valeur_de_docie_se_dit_annoncee(self):
        fiche = self._fiche([{"period": "3 ans"}], 12)
        self.assertEqual((fiche["years_experience"], fiche["anciennete_source"]),
                         (12, "docie"))

    def test_le_forfait_se_dit_forfait(self):
        """DocIE muet : un an par période illisible — un ordre de grandeur."""
        fiche = self._fiche([{"period": "3 ans"}, {"period": "2 ans"}])
        self.assertEqual((fiche["years_experience"], fiche["anciennete_source"]),
                         (2, "forfait"))

    def test_sans_rien_du_tout_la_fiche_le_dit(self):
        """Le 0 affiché ne vient d'aucune source : le dire, pas le maquiller."""
        fiche = self._fiche([], None)
        self.assertEqual((fiche["years_experience"], fiche["anciennete_source"]),
                         (0, "aucune"))
        fiche = self._fiche([{"period": ""}], None)
        self.assertEqual(fiche["anciennete_source"], "aucune")

    def test_zero_an_mesure_reste_une_mesure(self):
        """Trois mois lisibles valent 0 an, et ce 0-là est bien mesuré."""
        fiche = self._fiche([{"period": "Janvier 2024 - Mars 2024"}], 12)
        self.assertEqual((fiche["years_experience"], fiche["anciennete_source"]),
                         (0, "periodes"))

    def test_la_vraie_reponse_docie_se_dit_mesuree(self):
        reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
        reponse["schema_name"] = "adbi_resume"
        fiche = APP["normalize_cv_data"](
            map_resume(reponse, expected_schema="adbi_resume"))
        self.assertEqual(fiche["anciennete_source"], "periodes")

    def test_la_source_suit_toujours_la_valeur_retenue(self):
        """Invariant : la source nommée doit être celle qui a produit le nombre.

        Rejoué sur la table de #177 ligne 3 — si une branche changeait de
        valeur sans changer d'étiquette, l'infobulle mentirait.
        """
        calcul = APP["compute_years_experience"]
        cas = [
            ([], 12), ([{"period": ""}], 12), ([{"period": "3 ans"}], 12),
            ([{"period": "3 ans"}], None), ([], None),
            ([{"period": "Mars 2019 – Poste actuel"}], 12),
            ([{"period": "Janvier 2019 - Décembre 2022"}, {"period": "2 ans"}], 12),
        ]
        for missions, annonce in cas:
            with self.subTest(missions=missions, annonce=annonce):
                fiche = self._fiche(missions, annonce)
                valeur, source = fiche["years_experience"], fiche["anciennete_source"]
                if source == "periodes":
                    self.assertTrue(periode_lisible(fiche["experience"]))
                    self.assertEqual(valeur, calcul(fiche["experience"]))
                elif source == "docie":
                    self.assertEqual(valeur, annonce)
                elif source == "forfait":
                    self.assertEqual(valeur, calcul(fiche["experience"]))
                    self.assertGreater(valeur, 0)
                else:
                    self.assertEqual((source, valeur), ("aucune", 0))


class SourceAuPatchTests(unittest.TestCase):
    """Une ancienneté retapée à la main n'est plus « calculée depuis les périodes »."""

    def test_le_client_ne_choisit_pas_la_provenance(self):
        """`anciennete_source` est calculée côté serveur : la liste blanche la refuse."""
        self.assertNotIn("anciennete_source", APP["CHAMPS_MODIFIABLES_CV"])
        retenu = APP["_filtrer_champs_cv"](
            {"years_experience": 12, "anciennete_source": "periodes"})
        self.assertNotIn("anciennete_source", retenu)

    def test_une_valeur_changee_se_dit_manuelle(self):
        cv = {"years_experience": 4, "anciennete_source": "periodes"}
        updates = {"years_experience": 12}
        APP["marquer_anciennete_manuelle"](cv, updates)
        self.assertEqual(updates["anciennete_source"], "manuel")

    def test_une_valeur_inchangee_garde_sa_provenance(self):
        """`collectData()` renvoie l'ancienneté à CHAQUE enregistrement.

        Tamponner sur la seule présence de la clé effacerait la provenance au
        premier « Enregistrer » d'une fiche que personne n'a modifiée — la
        panne de `niveau_declare`, à l'envers.
        """
        cv = {"years_experience": 4, "anciennete_source": "periodes"}
        updates = {"years_experience": 4, "experience": []}
        APP["marquer_anciennete_manuelle"](cv, updates)
        self.assertNotIn("anciennete_source", updates)
        for cle, val in updates.items():       # ce que fait update_cv
            cv[cle] = val
        self.assertEqual(cv["anciennete_source"], "periodes")

    def test_un_patch_sans_anciennete_ne_touche_a_rien(self):
        cv = {"years_experience": 4, "anciennete_source": "docie"}
        updates = {"name": "Camille"}
        APP["marquer_anciennete_manuelle"](cv, updates)
        self.assertNotIn("anciennete_source", updates)

    def test_une_fiche_d_avant_le_correctif_se_fait_tamponner(self):
        """Aucune fiche déjà en base ne porte la clé : elle s'acquiert à l'usage."""
        cv = {"years_experience": 0}
        updates = APP["_filtrer_champs_cv"]({"years_experience": "7"})
        APP["marquer_anciennete_manuelle"](cv, updates)
        self.assertEqual(updates["anciennete_source"], "manuel")


class PeremptionDeLaRevueTests(unittest.TestCase):
    """`marquer_anciennete_manuelle` ajoute une clé à `updates` — et `update_cv`
    passe ce MÊME dictionnaire à `perimer_revue` juste après la fusion.

    `perimer_revue` n'interroge `updates` que par appartenance (« cette rubrique
    vient-elle d'être remplacée ? »), donc une clé de plus ne devrait rien
    périmer. Mesuré plutôt que supposé : c'est le genre d'effet de bord qui
    effacerait en silence une marque « à vérifier » sur une tout autre rubrique.
    """

    FICHE = {"years_experience": 4, "anciennete_source": "periodes",
             "docie_review": {"needs_review": ["experience[0].company",
                                               "contact.email"],
                              "warnings": ["docie_avertissement: liste tronquée"]}}

    def test_la_cle_de_provenance_ne_perime_aucune_marque(self):
        from docie_review import perimer_revue
        cv = {**self.FICHE, "docie_review": dict(self.FICHE["docie_review"])}
        updates = {"years_experience": 12}
        APP["marquer_anciennete_manuelle"](cv, updates)
        self.assertEqual(updates["anciennete_source"], "manuel")
        for cle, val in updates.items():
            cv[cle] = val
        perimer_revue(cv, updates)
        self.assertEqual(cv["docie_review"]["needs_review"],
                         ["experience[0].company", "contact.email"])
        self.assertEqual(cv["docie_review"]["warnings"],
                         ["docie_avertissement: liste tronquée"])

    def test_une_rubrique_reellement_remplacee_est_toujours_perimee(self):
        """Témoin : la péremption n'est pas cassée pour autant."""
        from docie_review import perimer_revue
        cv = {**self.FICHE, "docie_review": dict(self.FICHE["docie_review"])}
        updates = {"years_experience": 12, "experience": []}
        APP["marquer_anciennete_manuelle"](cv, updates)
        perimer_revue(cv, updates)
        self.assertEqual(cv["docie_review"]["needs_review"], ["contact.email"])


class SourceALaCreationTests(unittest.TestCase):
    """POST /api/cvs : ni période mesurée, ni extraction — donc manuel, ou rien."""

    def _creer(self, corps):
        vu = {}

        class _Store:
            @staticmethod
            def create_cv(cid, record):
                vu["record"] = record
                return True

        espace = _fonctions_de_app(
            {"store_cv", "_filtrer_champs_cv", "_plafonner_cv",
             "CHAMPS_MODIFIABLES_CV", "LISTES_DE_DICTS_CV", "bilan_adbi",
             "_RUBRIQUES_ADBI"},
            extras={
                "request": type("R", (), {"json": corps})(),
                "jsonify": lambda *a, **k: (a[0] if a else k),
                "cvstore_pg": _Store,
                "uuid": __import__("uuid"),
            })
        espace["store_cv"]()
        return vu["record"]

    def test_une_creation_avec_anciennete_se_dit_manuelle(self):
        self.assertEqual(
            self._creer({"name": "Camille", "years_experience": 7})["anciennete_source"],
            "manuel")

    def test_une_creation_sans_anciennete_ne_revendique_rien(self):
        self.assertEqual(
            self._creer({"name": "Camille"})["anciennete_source"], "aucune")

    def test_la_provenance_envoyee_par_le_client_est_ignoree(self):
        record = self._creer({"name": "Camille", "years_experience": 7,
                              "anciennete_source": "periodes"})
        self.assertEqual(record["anciennete_source"], "manuel")


class InfobulleTests(unittest.TestCase):
    """L'écran doit permettre d'apprendre d'où vient le nombre affiché."""

    FICHE = {"id": "cv1", "name": "Camille Béranger", "contact": {},
             "years_experience": 12, "experience": [], "certifications": []}

    def test_chaque_source_a_son_libelle(self):
        attendus = {
            "periodes": "Calculé depuis les périodes",
            "docie": "Annoncé par l&#39;extraction DocIE",
            "forfait": "Estimé à un an par mission",
            "manuel": "Saisi à la main",
        }
        for source, extrait in attendus.items():
            with self.subTest(source=source):
                html = _rendu("cv_detail.html",
                              cv={**self.FICHE, "anciennete_source": source},
                              linked_cvs=[])
                self.assertIn('class="ph-badge exp" title="', html)
                self.assertIn(extrait, html)

    def test_une_fiche_d_avant_le_correctif_s_affiche_sans_infobulle(self):
        """Aucune fiche déjà en base ne porte la clé : pas d'erreur, pas d'infobulle."""
        html = _rendu("cv_detail.html", cv=self.FICHE, linked_cvs=[])
        self.assertIn("12 ans d'expérience", html)
        self.assertNotIn('class="ph-badge exp" title="', html)

    def test_une_source_inconnue_ne_fabrique_pas_d_infobulle(self):
        html = _rendu("cv_detail.html",
                      cv={**self.FICHE, "anciennete_source": "?"}, linked_cvs=[])
        self.assertNotIn('class="ph-badge exp" title="', html)


if __name__ == "__main__":
    unittest.main()
