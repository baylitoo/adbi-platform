"""Catalogue des modèles (#194) : table retenue, chargeur Python, parité avec le portage Node.

Lancement : python -m unittest discover -s document-parsing/models/tests
Aucun appel réseau.
"""

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI.parent))

import catalogue as cat  # noqa: E402

FIXTURE = json.loads((ICI / "lignes_non_vides.json").read_text(encoding="utf-8"))

# Transcription de « ✅ Liste retenue (2026-09-15) » de #194, tâche par tâche :
# usage, puis par voie (défaut, alternative). Kbis « choisi par type d'entrée » :
# PDF avec couche texte -> voie texte, photo/scan -> voie agent (vision).
TABLE_194 = {
    "resume": ("extraction", {"texte": ("lfm25_2_6b", "nuextract3"), "agent": ("lfm25_2_6b", "nuextract3")}),
    "contract": ("extraction", {"texte": ("nuextract3", "lfm25_2_6b")}),
    "kbis": ("extraction", {"texte": ("lfm25_2_6b", "nuextract3"), "agent": ("nuextract3", None)}),
    "urssaf": ("extraction", {"texte": ("lfm25_2_6b", "lfm25_350m")}),
    "fiscale": ("extraction", {"texte": ("lfm25_2_6b", "lfm25_350m")}),
    "rib": ("extraction", {"texte": ("lfm25_2_6b", "lfm25_350m")}),
    "cni": ("extraction", {"agent": ("nuextract3", None)}),
    "remplissage_extraction": ("extraction", {"texte": ("lfm25_2_6b", None)}),
    "remplissage_redaction": ("chat", {"chat": ("lfm25_2_6b", None)}),
    "rapprochement": ("chat", {"chat": ("lfm25_2_6b", None)}),
    "copilote": ("chat", {"chat": ("lfm25_2_6b", None)}),
    "traduction": ("chat", {"chat": ("lfm25_2_6b", None)}),
}

ENV_CONTRAT = {"DOCIE_MODELE_NUEXTRACT3": "store:nuextract3", "DOCIE_MODELE_LFM25_2_6B": "store:lfm2.5-2.6b"}


class TableRetenue(unittest.TestCase):
    def setUp(self):
        self.c = cat.charger_catalogue()

    def test_toutes_les_taches_de_la_table_et_rien_d_autre(self):
        self.assertEqual(set(self.c["taches"]), set(TABLE_194))

    def test_defauts_alternatives_et_voies_conformes(self):
        for tache, (usage, voies) in TABLE_194.items():
            t = self.c["taches"][tache]
            self.assertEqual(t["usage"], usage, tache)
            self.assertEqual(set(t["voies"]), set(voies), tache)
            for voie, (defaut, alternative) in voies.items():
                v = t["voies"][voie]
                self.assertEqual(v["defaut"]["modele"], defaut, f"{tache}/{voie}")
                self.assertEqual((v.get("alternative") or {}).get("modele"), alternative, f"{tache}/{voie}")

    def test_seulement_les_trois_modeles_retenus(self):
        self.assertEqual(set(self.c["modeles"]), {"lfm25_2_6b", "nuextract3", "lfm25_350m"})
        self.assertEqual(self.c["modeles"]["lfm25_2_6b"]["etiquettes"], ["extraction", "chat"])
        self.assertEqual(self.c["modeles"]["nuextract3"]["etiquettes"], ["extraction"])
        self.assertEqual(self.c["modeles"]["lfm25_350m"]["etiquettes"], ["extraction"])

    def test_libelles_lisibles(self):
        m = self.c["modeles"]
        self.assertEqual(m["lfm25_2_6b"]["description"], "Rapide")
        self.assertEqual(m["nuextract3"]["description"], "Précis mais lent — plusieurs minutes")
        self.assertEqual(m["lfm25_350m"]["description"], "Très rapide — documents simples")

    def test_modeles_refuses_absents_du_fichier(self):
        texte = cat.CHEMIN_CATALOGUE.read_text(encoding="utf-8").lower()
        for refuse in ("spark", "think", "1.2b", "1_2b", "1,2b", "gliformer", "routing_policy"):
            self.assertNotIn(refuse, texte, refuse)

    def test_limites_des_modeles(self):
        m = self.c["modeles"]
        # Prompt générique : plafond silencieux de 800 blocs sur la voie texte (#190).
        self.assertEqual(m["lfm25_2_6b"]["limites"], {"texte": {"lignes_non_vides_max": 800}})
        self.assertEqual(m["lfm25_350m"]["limites"], {"texte": {"lignes_non_vides_max": 800}})
        # Vision : 400 au-delà de 8 pages sur la voie agent.
        self.assertEqual(m["nuextract3"]["limites"], {"agent": {"pages_max": 8}})

    def test_chaque_entree_porte_l_etiquette_de_son_usage(self):
        for tache, t in self.c["taches"].items():
            for voie, v in t["voies"].items():
                for role in ("defaut", "alternative"):
                    if v.get(role):
                        etiquettes = self.c["modeles"][v[role]["modele"]]["etiquettes"]
                        self.assertIn(t["usage"], etiquettes, f"{tache}/{voie}/{role}")
                if t["usage"] == "chat":
                    self.assertEqual(voie, "chat")

    def test_chaque_voie_a_son_motif_de_variable(self):
        for t in self.c["taches"].values():
            for voie in t["voies"]:
                self.assertIn(voie, self.c["variables"])


class Chargeur(unittest.TestCase):
    def test_sans_environnement_rien_n_est_propose(self):
        for tache, (_, voies) in TABLE_194.items():
            for voie in voies:
                self.assertEqual(cat.modeles_offerts(tache, voie, env={}), [], f"{tache}/{voie}")

    def test_noms_de_variables(self):
        self.assertEqual(cat.nom_variable("texte", "contract", "lfm25_2_6b"), "DOCIE_MODELE_LFM25_2_6B")
        self.assertEqual(cat.nom_variable("agent", "kbis", "nuextract3"), "DOCIE_AGENT_KBIS_NUEXTRACT3")

    def test_defaut_d_abord_identifiants_resolus(self):
        env = {"DOCIE_MODELE_LFM25_2_6B": "  store:lfm2.5-2.6b ", "DOCIE_MODELE_NUEXTRACT3": "store:nuextract3"}
        offres = cat.modeles_offerts("contract", "texte", env=env)
        self.assertEqual([(o["id"], o["role"], o["identifiant"]) for o in offres],
                         [("nuextract3", "defaut", "store:nuextract3"), ("lfm25_2_6b", "alternative", "store:lfm2.5-2.6b")])

    def test_experimental_nuextract3_alternative_du_cv_seulement(self):
        env = {"DOCIE_MODELE_LFM25_2_6B": "store:l", "DOCIE_MODELE_NUEXTRACT3": "store:n",
               "DOCIE_AGENT_RESUME_LFM25_2_6B": "a_l", "DOCIE_AGENT_RESUME_NUEXTRACT3": "a_n"}
        for voie in ("texte", "agent"):
            self.assertEqual([(o["id"], o["experimental"]) for o in cat.modeles_offerts("resume", voie, env=env)],
                             [("lfm25_2_6b", False), ("nuextract3", True)], voie)
        self.assertEqual([(o["id"], o["experimental"]) for o in cat.modeles_offerts("contract", "texte", env=env)],
                         [("nuextract3", False), ("lfm25_2_6b", False)])

    def test_modele_sans_identifiant_non_propose(self):
        offres = cat.modeles_offerts("contract", "texte", env={"DOCIE_MODELE_LFM25_2_6B": "store:x"})
        self.assertEqual([o["id"] for o in offres], ["lfm25_2_6b"])
        # L'ancien réglage ne suffit pas à proposer un modèle du catalogue.
        self.assertEqual(cat.modeles_offerts("kbis", "agent", env={"DOCIE_AGENT_KBIS": "agent_kbis"}), [])

    def test_800_lignes_proposé_801_non(self):
        self.assertEqual([o["id"] for o in cat.modeles_offerts("contract", "texte", env=ENV_CONTRAT, document={"lignes_non_vides": 800})],
                         ["nuextract3", "lfm25_2_6b"])
        self.assertEqual([o["id"] for o in cat.modeles_offerts("contract", "texte", env=ENV_CONTRAT, document={"lignes_non_vides": 801})],
                         ["nuextract3"])

    def test_8_pages_proposé_9_non(self):
        env = {"DOCIE_AGENT_KBIS_NUEXTRACT3": "kbis_nuextract3"}
        self.assertEqual(len(cat.modeles_offerts("kbis", "agent", env=env, document={"pages": 8})), 1)
        self.assertEqual(cat.modeles_offerts("kbis", "agent", env=env, document={"pages": 9}), [])

    def test_choisir_sans_substitution(self):
        with self.assertRaises(cat.CatalogueError) as e:
            cat.choisir_modele("contract", "texte", "lfm25_2_6b", env={"DOCIE_MODELE_NUEXTRACT3": "store:n"})
        self.assertEqual(e.exception.code, "modele_non_propose")
        with self.assertRaises(cat.CatalogueError) as e:
            cat.choisir_modele("contract", "texte", "lfm25_2_6b", env=ENV_CONTRAT, document={"lignes_non_vides": 801})
        self.assertEqual(e.exception.code, "limite")
        self.assertIn("800", str(e.exception))
        with self.assertRaises(cat.CatalogueError) as e:
            cat.choisir_modele("contract", "texte", "<script>", env=ENV_CONTRAT)
        self.assertNotIn("<script>", str(e.exception))
        self.assertEqual(cat.choisir_modele("contract", "texte", "lfm25_2_6b", env=ENV_CONTRAT,
                                            document={"lignes_non_vides": 800})["identifiant"], "store:lfm2.5-2.6b")

    def test_identifiant_mal_forme_erreur_nommee_sans_la_valeur(self):
        for voie, variable, valeur in (("texte", "DOCIE_MODELE_NUEXTRACT3", "store:a\nb"),
                                       ("texte", "DOCIE_MODELE_NUEXTRACT3", "é" * 65),
                                       ("agent", "DOCIE_AGENT_KBIS_NUEXTRACT3", "store:nuextract3")):
            tache = "kbis" if voie == "agent" else "contract"
            with self.assertRaises(cat.CatalogueError) as e:
                cat.modeles_offerts(tache, voie, env={variable: valeur})
            self.assertEqual(e.exception.code, "configuration")
            self.assertIn(variable, str(e.exception))
            self.assertNotIn(valeur.strip(), str(e.exception))

    def test_tache_inconnue(self):
        with self.assertRaises(cat.CatalogueError) as e:
            cat.modeles_offerts("devis", "texte", env={})
        self.assertEqual(e.exception.code, "tache")

    def test_modele_servi(self):
        servi = cat.modele_servi("contract", "texte", {"model": "nuextract3"}, env=ENV_CONTRAT)
        self.assertEqual(servi, {"id": "nuextract3", "libelle": "NuExtract3", "identifiant": "nuextract3"})
        brut = cat.modele_servi("contract", "texte", {"model": "autre-deploiement"}, env=ENV_CONTRAT)
        self.assertEqual(brut, {"id": None, "libelle": "autre-deploiement", "identifiant": "autre-deploiement"})
        self.assertIsNone(cat.modele_servi("contract", "texte", {"model": None}, env=ENV_CONTRAT))
        agent = cat.modele_servi("kbis", "agent", {"agent": "kbis_n3", "model": "x"}, env={"DOCIE_AGENT_KBIS_NUEXTRACT3": "kbis_n3"})
        self.assertEqual(agent["id"], "nuextract3")


class LignesNonVides(unittest.TestCase):
    def test_blancs_de_la_fixture_exactement_ceux_de_cpython(self):
        blancs = {chr(i) for i in range(0x110000) if chr(i).isspace()}
        self.assertEqual(set(FIXTURE["blancs"]), blancs)

    def test_separateurs_de_la_fixture_exactement_ceux_de_cpython(self):
        separateurs = {chr(i) for i in range(0x110000) if len(("a" + chr(i) + "b").splitlines()) == 2}
        self.assertEqual(set(FIXTURE["separateurs"]), separateurs)

    def test_cas_recalcules_par_cpython(self):
        for c in FIXTURE["cas"]:
            attendu = sum(1 for ligne in c["texte"].splitlines() if ligne.strip())
            self.assertEqual(c["lignes"], attendu, c["nom"])
            self.assertEqual(cat.compter_lignes_non_vides(c["texte"]), attendu, c["nom"])


@unittest.skipUnless(shutil.which("node"), "node absent : parité non vérifiée")
class PariteNode(unittest.TestCase):
    """Mêmes entrées, mêmes offres et même comptage dans les deux portages."""

    def test_offres_et_comptage_identiques(self):
        scenarios = [
            ("contract", "texte", {}, None),
            ("contract", "texte", ENV_CONTRAT, None),
            ("contract", "texte", ENV_CONTRAT, {"lignes_non_vides": 800}),
            ("contract", "texte", ENV_CONTRAT, {"lignes_non_vides": 801}),
            ("urssaf", "texte", {"DOCIE_MODELE_LFM25_350M": "store:350m", "DOCIE_MODELE_LFM25_2_6B": "store:2.6b"}, None),
            ("kbis", "agent", {"DOCIE_AGENT_KBIS_NUEXTRACT3": "k3"}, {"pages": 9}),
            ("rapprochement", "chat", {"ADBI_LLM_MODELE_LFM25_2_6B": "lfm2.5-2.6b", "ADBI_LLM_MODELE_NUEXTRACT3": "n"}, None),
            ("resume", "texte", {"DOCIE_MODELE_LFM25_2_6B": "store:l", "DOCIE_MODELE_NUEXTRACT3": "store:n"}, {"lignes_non_vides": 800}),
            ("resume", "agent", {"DOCIE_AGENT_RESUME_LFM25_2_6B": "a_l", "DOCIE_AGENT_RESUME_NUEXTRACT3": "a_n"}, {"pages": 8}),
        ]
        textes = [c["texte"] for c in FIXTURE["cas"]] + ["x\n" * 801, "\ufeff\n\u00a0\n\x1f"]
        script = r"""
const cat = require(process.argv[1]);
const entree = JSON.parse(require("fs").readFileSync(0, "utf8"));
const offres = entree.scenarios.map(([t, v, env, doc]) =>
  cat.modelesOfferts(t, v, { env, document: doc && { lignesNonVides: doc.lignes_non_vides, pages: doc.pages } })
     .map((o) => [o.id, o.role, o.identifiant, o.variable, o.experimental]));
process.stdout.write(JSON.stringify({ offres, lignes: entree.textes.map(cat.compterLignesNonVides) }));
"""
        sortie = subprocess.run(["node", "-e", script, str(ICI.parent / "catalogue.js")],
                                input=json.dumps({"scenarios": scenarios, "textes": textes}),
                                capture_output=True, text=True, encoding="utf-8", check=True)
        js = json.loads(sortie.stdout)
        py_offres = [[[o["id"], o["role"], o["identifiant"], o["variable"], o["experimental"]]
                      for o in cat.modeles_offerts(t, v, env=env, document=doc)] for t, v, env, doc in scenarios]
        self.assertEqual(js["offres"], py_offres)
        self.assertEqual(js["lignes"], [cat.compter_lignes_non_vides(t) for t in textes])


if __name__ == "__main__":
    unittest.main()
