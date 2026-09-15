#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de iban_bic.py -- controle de l'IBAN et du BIC lus sur un RIB (#194).

Tous les cas viennent de document-parsing/fixtures/iban_bic.json, que le
portage JS (contrats/tests/iban-bic.test.js) execute lui aussi, messages exacts
compris : une divergence entre les deux langages redevient un echec de test
(discipline de #179). Les deux mappings RIB executent en plus chaque cas de
bout en bout dans leurs propres tests.

Lancer : python -m unittest discover -s document-parsing/mappings
"""

from __future__ import annotations

import json
import re
import string
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from iban_bic import (  # noqa: E402
    CLE_INVALIDE,
    FORMAT_INVALIDE,
    LONGUEURS_IBAN,
    MOTIF_SEPARATEURS,
    PAYS_DISCORDANT,
    STATUTS,
    VALIDE,
    controler_iban_bic,
    messages_iban_bic,
)

REPO_ROOT = Path(__file__).parent.parent.parent
FIXTURE = REPO_ROOT / "document-parsing" / "fixtures" / "iban_bic.json"
ALPHABET = string.digits + string.ascii_uppercase


class TestIbanBicPartage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_motif_longueurs_et_statuts_identiques_a_la_fixture(self):
        self.assertEqual(self.fixture["motif_separateurs"], MOTIF_SEPARATEURS)
        self.assertEqual(self.fixture["longueurs_iban"], LONGUEURS_IBAN)
        self.assertEqual(self.fixture["statuts"], list(STATUTS))
        self.assertIn("document-parsing/mappings/iban_bic.py (Python, validateur)", self.fixture["_ports"])

    def test_chaque_cas_a_une_preuve(self):
        for cas in self.fixture["cas"]:
            with self.subTest(iban=cas["iban"], bic=cas["bic"]):
                self.assertTrue(cas["preuve"].strip())

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(iban=cas["iban"], bic=cas["bic"], preuve=cas["preuve"]):
                controle = controler_iban_bic(cas["iban"], cas["bic"])
                self.assertEqual(cas["statut_iban"], controle["iban"]["statut"])
                self.assertEqual(cas["compact_iban"], controle["iban"]["compact"])
                self.assertEqual(cas["pays_iban"], controle["iban"]["pays"])
                self.assertEqual(cas["statut_bic"], controle["bic"]["statut"])
                self.assertEqual(cas["compact_bic"], controle["bic"]["compact"])
                self.assertEqual(cas["pays_bic"], controle["bic"]["pays"])
                self.assertEqual(cas["messages"], messages_iban_bic(controle))

    def test_chaque_statut_est_exerce_par_la_fixture(self):
        vus = {cas["statut_iban"] for cas in self.fixture["cas"]} | {cas["statut_bic"] for cas in self.fixture["cas"]}
        self.assertEqual(set(STATUTS), vus)

    def test_format_cle_et_pays_ne_s_annoncent_pas_pareil(self):
        libelles = {FORMAT_INVALIDE: "format invalide", CLE_INVALIDE: "clé de contrôle invalide", PAYS_DISCORDANT: "différent du pays"}
        fr = "FR1420041010050500013M02606"
        exemples = {
            FORMAT_INVALIDE: controler_iban_bic(fr[:-1], None),
            CLE_INVALIDE: controler_iban_bic(fr[:-1] + "7", None),
            PAYS_DISCORDANT: controler_iban_bic(fr, "DEUTDEFF"),
        }
        for statut, controle in exemples.items():
            with self.subTest(statut=statut):
                messages = messages_iban_bic(controle)
                self.assertEqual(1, len(messages))
                for autre, libelle in libelles.items():
                    self.assertEqual(autre == statut, libelle in messages[0]["message"])

    def test_la_valeur_lue_n_est_jamais_modifiee(self):
        controle = controler_iban_bic(" fr14 2004 1010 0505 0001 3m02 606", "bnpa fr pp")
        self.assertEqual(" fr14 2004 1010 0505 0001 3m02 606", controle["iban"]["valeur"])
        self.assertEqual("bnpa fr pp", controle["bic"]["valeur"])
        self.assertEqual(VALIDE, controle["iban"]["statut"])

    def test_detection_mesuree_sur_chaque_iban_valide_de_la_fixture(self):
        """La promesse du modulo 97, MESUREE et non supposee : sur chaque IBAN
        valide sans separateur de la fixture, toute substitution chiffre pour
        chiffre ou lettre pour lettre, et toute transposition de deux voisins,
        doit etre refusee. Les substitutions chiffre pour lettre ne sont pas
        promises (voir le cas « LIMITE CONNUE » de la fixture)."""
        exemples = {c["iban"] for c in self.fixture["cas"]
                    if c["statut_iban"] == VALIDE and isinstance(c["iban"], str) and c["iban"] == c["compact_iban"]}
        self.assertGreaterEqual(len(exemples), 4)
        for iban in sorted(exemples):
            if "LIMITE" in next(c["preuve"] for c in self.fixture["cas"] if c["iban"] == iban):
                continue
            with self.subTest(iban=iban):
                for i, car in enumerate(iban):
                    for autre in ALPHABET:
                        if autre == car or autre.isdigit() != car.isdigit():
                            continue
                        faux = iban[:i] + autre + iban[i + 1:]
                        self.assertNotEqual(VALIDE, controler_iban_bic(faux, None)["iban"]["statut"], faux)
                for i in range(len(iban) - 1):
                    if iban[i] != iban[i + 1]:
                        faux = iban[:i] + iban[i + 1] + iban[i] + iban[i + 2:]
                        self.assertNotEqual(VALIDE, controler_iban_bic(faux, None)["iban"]["statut"], faux)

    def test_la_fixture_n_est_chargee_par_aucun_module_python_de_production(self):
        for module in Path(__file__).parent.glob("*.py"):
            if module.name.startswith("test_"):
                continue
            with self.subTest(module=module.name):
                self.assertIsNone(re.search(r"[\"'][^\"'\n]*iban_bic\.json[\"']", module.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
