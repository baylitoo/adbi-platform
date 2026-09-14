#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de siren_siret.py -- controle de cle du SIREN / SIRET (#194).

Tous les cas viennent de document-parsing/fixtures/siren_siret.json, le jeu
d'essai que le portage JS (contrats/tests/siren-siret.test.js) execute lui
aussi, messages exacts compris : une divergence entre les deux langages
redevient un echec de test (discipline de #179). Les quatre mappings
executent en plus chaque cas de bout en bout dans leurs propres tests.

Lancer : python -m unittest discover -s document-parsing/mappings
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from siren_siret import (  # noqa: E402
    CLE_INVALIDE,
    DISCORDANT,
    FORMAT_INVALIDE,
    MOTIF_SEPARATEURS,
    STATUTS,
    controler_siren_siret,
    messages_siren_siret,
)

REPO_ROOT = Path(__file__).parent.parent.parent
FIXTURE = REPO_ROOT / "document-parsing" / "fixtures" / "siren_siret.json"


class TestSirenSiretPartage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_motif_et_statuts_identiques_a_la_fixture(self):
        self.assertEqual(self.fixture["motif_separateurs"], MOTIF_SEPARATEURS)
        self.assertEqual(self.fixture["statuts"], list(STATUTS))
        self.assertIn("document-parsing/mappings/siren_siret.py (Python, validateur)", self.fixture["_ports"])

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(siren=cas["siren"], siret=cas["siret"], preuve=cas["preuve"]):
                controle = controler_siren_siret(cas["siren"], cas["siret"])
                self.assertEqual(cas["statut_siren"], controle["siren"]["statut"])
                self.assertEqual(cas["statut_siret"], controle["siret"]["statut"])
                self.assertEqual(cas["chiffres_siren"], controle["siren"]["chiffres"])
                self.assertEqual(cas["chiffres_siret"], controle["siret"]["chiffres"])
                self.assertEqual(cas["messages"], messages_siren_siret(controle))

    def test_chaque_statut_est_exerce_par_la_fixture(self):
        vus = {cas["statut_siren"] for cas in self.fixture["cas"]} | {cas["statut_siret"] for cas in self.fixture["cas"]}
        self.assertEqual(set(STATUTS), vus)

    def test_format_cle_et_discordance_ne_s_annoncent_pas_pareil(self):
        # Trois pannes qui ne se corrigent pas de la meme facon : chaque
        # message porte SON libelle et pas celui d'une autre.
        libelles = {FORMAT_INVALIDE: "format invalide", CLE_INVALIDE: "clé de contrôle invalide", DISCORDANT: "discordant"}
        exemples = {
            FORMAT_INVALIDE: controler_siren_siret("94109131", None),
            CLE_INVALIDE: controler_siren_siret("941091317", None),
            DISCORDANT: controler_siren_siret("941091316", "55212022200005"),
        }
        for statut, controle in exemples.items():
            with self.subTest(statut=statut):
                messages = messages_siren_siret(controle)
                self.assertEqual(1, len(messages))
                for autre, libelle in libelles.items():
                    self.assertEqual(autre == statut, libelle in messages[0]["message"])

    def test_la_valeur_lue_n_est_jamais_modifiee(self):
        controle = controler_siren_siret("941 091 317", " 941 091 316 00013")
        self.assertEqual("941 091 317", controle["siren"]["valeur"])
        self.assertEqual(" 941 091 316 00013", controle["siret"]["valeur"])

    def test_la_fixture_n_est_chargee_par_aucun_module_python_de_production(self):
        # Le code de production ne doit jamais dependre de ce fichier : il
        # n'est pas copie dans l'image Docker de contrats. Aucun litteral de
        # chaine le nommant dans les modules qui ne sont pas des tests (les
        # commentaires le citent sans guillemets).
        for module in Path(__file__).parent.glob("*.py"):
            if module.name.startswith("test_"):
                continue
            with self.subTest(module=module.name):
                self.assertIsNone(re.search(r"[\"'][^\"'\n]*siren_siret\.json[\"']", module.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
