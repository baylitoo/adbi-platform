#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de rib_to_contrats.py (schema dynamique "rib", #170 / #194).

Trois fixtures (voir fixtures/generate_rib_sample.py pour leur provenance et
leur reserve : aucun RIB reel lu) + chaque cas de
document-parsing/fixtures/iban_bic.json execute de bout en bout.

Porte aussi la conformite du SCHEMA a DynamicSchemaSpec, verifiable hors ligne.

Lancer : python -m unittest discover -s document-parsing/mappings
"""

from __future__ import annotations

import copy
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import iban_bic  # noqa: E402
import kbis_to_contrats  # noqa: E402
import rib_to_contrats  # noqa: E402
from rib_to_contrats import (  # noqa: E402
    DOCANALYZE_BASE_KEYS,
    DOCUMENT_TYPE_LABEL,
    ENRICHED_KEYS,
    IBAN_ABSENT,
    MAPPED_FIELDS,
    SCHEMA_PATH,
    RibMappingError,
    load_schema,
    map_docie_rib_to_analysis,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
DOCANALYZE_JS = REPO_ROOT / "contrats" / "lib" / "docanalyze.js"
IBAN_BIC_FIXTURE = REPO_ROOT / "document-parsing" / "fixtures" / "iban_bic.json"
ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)


class TestSchemaConformeALaSpec(unittest.TestCase):
    """DynamicSchemaSpec (#170) : memes contraintes que test_urssaf_to_contrats.py
    -- snake_case ^[a-z][a-z0-9_]{0,63}$ (HTTP 422 sinon, mesure dans
    register_and_test.py), types autorises, sous-champs, noms reserves."""

    TYPES = {"string", "date", "number", "money", "object", "list"}
    NOM_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
    RESERVES = {"document_type", "extraction_notes"}

    @classmethod
    def setUpClass(cls):
        cls.schema = load_schema()

    def test_document_type_snake_case_et_borne(self):
        dt = self.schema["document_type"]
        self.assertEqual("rib", dt)
        self.assertTrue(self.NOM_RE.fullmatch(dt), dt)
        self.assertLessEqual(len(dt), 64)

    def test_champs_types_noms_et_sous_champs(self):
        noms = set()
        for champ in self.schema["fields"]:
            with self.subTest(champ=champ["name"]):
                self.assertEqual(["name", "type", "description", "fields"], list(champ))
                self.assertTrue(self.NOM_RE.fullmatch(champ["name"]))
                self.assertNotIn(champ["name"], self.RESERVES)
                self.assertNotIn(champ["name"], noms)
                noms.add(champ["name"])
                self.assertIn(champ["type"], self.TYPES)
                self.assertEqual([], champ["fields"], "un scalaire ne declare PAS de sous-champs")

    def test_chaque_champ_du_schema_est_mappe_et_reciproquement(self):
        self.assertEqual({c["name"] for c in self.schema["fields"]}, set(MAPPED_FIELDS))

    def test_le_schema_ne_demande_pas_ce_que_l_iban_contient_deja(self):
        # Code banque / guichet / compte / cle RIB : dans l'IBAN (voir en-tete).
        noms = " ".join(c["name"] for c in self.schema["fields"])
        for interdit in ("bank_code", "branch", "account_number", "rib_key", "cle"):
            self.assertNotIn(interdit, noms)


class TestReutilisationPasDeCopie(unittest.TestCase):
    def test_identite_des_fonctions_importees(self):
        self.assertIs(rib_to_contrats.controler_iban_bic, iban_bic.controler_iban_bic)
        self.assertIs(rib_to_contrats.messages_iban_bic, iban_bic.messages_iban_bic)
        self.assertIs(rib_to_contrats._check_name, kbis_to_contrats._check_name)
        self.assertIs(rib_to_contrats._extract_scalar, kbis_to_contrats._extract_scalar)

    def test_aucune_redefinition_dans_la_source(self):
        source = (Path(__file__).parent / "rib_to_contrats.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^def (controler_iban_bic|messages_iban_bic|_modulo_97|_controler_iban|_controler_bic|_check_name)\b",
                                    source, re.MULTILINE))
        self.assertNotIn("% 97", source)


class TestCasNominal(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("rib_extraction_sample.json")

    def test_sortie_sur_ensemble_des_cles_docanalyze(self):
        a = map_docie_rib_to_analysis(self.envelope).analysis
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(a))
        self.assertTrue(set(ENRICHED_KEYS).issubset(a))
        self.assertNotIn("controleIbanBic", ENRICHED_KEYS)
        self.assertFalse(set(ENRICHED_KEYS) & set(DOCANALYZE_BASE_KEYS))

    def test_valeurs_et_controle(self):
        m = map_docie_rib_to_analysis(self.envelope, expected_name="Sund Industry System", items=[{"id": "rib"}])
        a = m.analysis
        self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
        self.assertEqual("rib", a["matchedId"])
        self.assertIs(True, a["isValid"])
        self.assertEqual("", a["issuedDate"])
        self.assertEqual("SUND INDUSTRY SYSTEM", a["companyName"])
        self.assertIs(True, a["nameMatches"])
        self.assertEqual("SUND INDUSTRY SYSTEM", a["titulaireCompte"])
        self.assertEqual("FR14 2004 1010 0505 0001 3M02 606", a["iban"])
        self.assertEqual("BNPAFRPP", a["bic"])
        self.assertEqual("BANQUE EXEMPLE PARIS OPERA", a["nomBanque"])
        self.assertEqual("valide", a["controleIbanBic"]["iban"]["statut"])
        self.assertEqual("FR1420041010050500013M02606", a["controleIbanBic"]["iban"]["compact"])
        self.assertEqual("valide", a["controleIbanBic"]["bic"]["statut"])
        self.assertEqual([], a["issues"])
        self.assertEqual([], m.warnings)
        self.assertEqual("RIB", a["summary"])

    def test_libelle_identique_a_docanalyze_js(self):
        self.assertIn('type = "' + DOCUMENT_TYPE_LABEL + '"', DOCANALYZE_JS.read_text(encoding="utf-8"))

    def test_titulaire_d_une_autre_societe(self):
        a = map_docie_rib_to_analysis(self.envelope, expected_name="Autre Societe SARL").analysis
        self.assertIs(False, a["nameMatches"])
        self.assertIn("La société du document ne correspond pas au sous-traitant saisi.", a["issues"])
        self.assertIsNone(map_docie_rib_to_analysis(self.envelope).analysis["nameMatches"])
        self.assertIsNone(map_docie_rib_to_analysis(self.envelope, items=[{"id": "kbis"}]).analysis["matchedId"])


class TestCasLimites(unittest.TestCase):
    def setUp(self):
        self.mapping = map_docie_rib_to_analysis(_load_fixture("rib_extraction_sample_edge_cases.json"),
                                                 expected_name="SUND INDUSTRY SYSTEM")

    def test_iban_mal_lu_conserve_et_signale_bruyamment(self):
        a = self.mapping.analysis
        self.assertEqual("FR14 2004 1010 0505 0001 3M02 607", a["iban"], "valeur CONSERVEE, jamais videe")
        self.assertEqual("cle_invalide", a["controleIbanBic"]["iban"]["statut"])
        self.assertIn("IBAN « FR14 2004 1010 0505 0001 3M02 607 » : clé de contrôle invalide (modulo 97), "
                      "caractère probablement mal lu — valeur conservée, à vérifier sur le document", a["issues"])
        self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])

    def test_bic_mal_forme_conserve_et_signale(self):
        a = self.mapping.analysis
        self.assertEqual("BNPAFRPPX", a["bic"])
        self.assertEqual("format_invalide", a["controleIbanBic"]["bic"]["statut"])
        self.assertTrue(any(i.startswith("BIC « BNPAFRPPX » : format invalide") for i in a["issues"]))

    def test_champ_absent_et_validation_negative(self):
        a = self.mapping.analysis
        self.assertEqual("", a["nomBanque"])
        self.assertIs(False, a["isValid"])
        self.assertIn("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).", a["issues"])
        self.assertTrue(any(w.startswith("iban: IBAN «") for w in self.mapping.warnings))
        self.assertTrue(any("extraction_notes" in w for w in self.mapping.warnings))
        self.assertTrue(any("validation.errors" in w for w in self.mapping.warnings))


class TestIllisible(unittest.TestCase):
    def test_bascule_sur_la_forme_illisible(self):
        a = map_docie_rib_to_analysis(_load_fixture("rib_extraction_sample_unreadable.json")).analysis
        self.assertEqual("Document", a["documentType"])
        self.assertIs(False, a["isValid"])
        self.assertIsNone(a["companyName"])
        self.assertIsNone(a["nameMatches"])
        self.assertEqual("Document illisible.", a["summary"])
        self.assertEqual([ILLISIBLE], a["issues"])
        self.assertEqual("BANQUE", a["nomBanque"])
        self.assertEqual("absent", a["controleIbanBic"]["iban"]["statut"])

    def test_iban_absent_mais_titulaire_lu_est_nomme(self):
        env = _load_fixture("rib_extraction_sample.json")
        env["result"]["iban"]["value"] = None
        a = map_docie_rib_to_analysis(env).analysis
        self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
        self.assertIn(IBAN_ABSENT, a["issues"])


class TestJeuDEssaiIbanBicDeBoutEnBout(unittest.TestCase):
    """Chaque cas de iban_bic.json traverse le mapping : statut dans
    `controleIbanBic`, messages dans `issues` (dans l'ordre), valeurs lues
    conservees telles quelles."""

    def test_chaque_cas(self):
        with open(IBAN_BIC_FIXTURE, encoding="utf-8") as fh:
            cas_liste = json.load(fh)["cas"]
        self.assertIn("document-parsing/mappings/rib_to_contrats.py (Python)",
                      json.loads(IBAN_BIC_FIXTURE.read_text(encoding="utf-8"))["_ports"])
        base = _load_fixture("rib_extraction_sample.json")
        for cas in cas_liste:
            with self.subTest(iban=cas["iban"], bic=cas["bic"]):
                env = copy.deepcopy(base)
                env["result"]["iban"]["value"] = cas["iban"]
                env["result"]["bic"]["value"] = cas["bic"]
                a = map_docie_rib_to_analysis(env).analysis
                self.assertEqual(cas["statut_iban"], a["controleIbanBic"]["iban"]["statut"])
                self.assertEqual(cas["statut_bic"], a["controleIbanBic"]["bic"]["statut"])
                attendus = [m["message"] for m in cas["messages"]]
                self.assertEqual(attendus, [i for i in a["issues"] if i.startswith(("IBAN «", "BIC «"))])
                self.assertEqual("" if cas["iban"] is None else kbis_str(cas["iban"]), a["iban"])
                self.assertEqual("" if cas["bic"] is None else kbis_str(cas["bic"]), a["bic"])


def kbis_str(v):
    # Le mapping rend str(valeur) pour un champ texte, comme urssaf/kbis.
    return str(v)


class TestEntreesInvalides(unittest.TestCase):
    def test_mauvais_schema_name(self):
        env = _load_fixture("rib_extraction_sample.json")
        env["schema_name"] = "urssaf"
        with self.assertRaises(RibMappingError):
            map_docie_rib_to_analysis(env)

    def test_result_manquant_et_entree_non_dict(self):
        with self.assertRaises(RibMappingError):
            map_docie_rib_to_analysis({"schema_name": "rib"})
        for mauvais in (None, [], "x", 3):
            with self.subTest(entree=mauvais), self.assertRaises(RibMappingError):
                map_docie_rib_to_analysis(mauvais)


class TestSchemaEtFixturesRestentEnPhase(unittest.TestCase):
    def test_la_fixture_transporte_le_schema_du_fichier(self):
        schema = load_schema()
        for nom in ("rib_extraction_sample.json", "rib_extraction_sample_edge_cases.json",
                    "rib_extraction_sample_unreadable.json"):
            with self.subTest(fixture=nom):
                self.assertEqual(schema, _load_fixture(nom)["dynamic_schema"])
        self.assertTrue(SCHEMA_PATH.exists())


if __name__ == "__main__":
    unittest.main()
