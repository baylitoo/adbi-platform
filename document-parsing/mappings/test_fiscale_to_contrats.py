#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests reels pour le schema dynamique "fiscale" (attestation de regularite
fiscale, #170 / #194) et, a terme, pour fiscale_to_contrats.py.

Ce fichier porte la conformite du SCHEMA lui-meme a DynamicSchemaSpec (types
autorises, sous-champs, noms reserves, snake_case <= 64) -- la seule
verification de ces contraintes possible sans appel distant, comme
test_urssaf_to_contrats.py et test_rib_to_contrats.py (#209).

Lancer : python -m unittest discover -s document-parsing/mappings
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
SCHEMA_FICHIER = REPO_ROOT / "document-parsing" / "schemas" / "fiscale.schema.json"

FIXTURES_FISCALE = (
    "fiscale_extraction_sample.json",
    "fiscale_extraction_sample_edge_cases.json",
    "fiscale_extraction_sample_unreadable.json",
)

# Les SEPT champs retenus, chacun avec l'endroit du document ou il se lit.
# Figes ici plutot que deduits du fichier : un champ ajoute au schema sans
# justification casse ce test (garde-fou « aucun champ invente »).
CHAMPS_JUSTIFIES = {
    "company_name": ("string", "denomination de l'entreprise, bloc d'identification"),
    "siren": ("string", "numero SIREN, bloc d'identification"),
    "siret": ("string", "numero SIRET, quand l'attestation l'imprime"),
    "tax_office": ("string", "service des impots emetteur, en-tete"),
    "issued_date": ("date", "date de delivrance"),
    "situation_date": ("date", "date a laquelle la regularite est attestee"),
    "regularity_statement": ("string", "mention « a jour de ses obligations fiscales »"),
}


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)


def _schema() -> dict:
    return json.loads(SCHEMA_FICHIER.read_text(encoding="utf-8"))


class TestSchemaConformeALaSpec(unittest.TestCase):
    """DynamicSchemaSpec (#170) : memes contraintes que test_urssaf_to_contrats.py
    -- snake_case ^[a-z][a-z0-9_]{0,63}$ (HTTP 422 sinon, mesure dans
    register_and_test.py), types autorises, sous-champs obligatoires pour
    object/list et interdits pour un scalaire, noms reserves."""

    TYPES = {"string", "date", "number", "money", "object", "list"}
    NOM_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
    RESERVES = {"document_type", "extraction_notes"}

    @classmethod
    def setUpClass(cls):
        cls.schema = _schema()

    def test_cles_racine(self):
        self.assertEqual(["document_type", "fields"], list(self.schema))

    def test_document_type_snake_case_et_borne(self):
        dt = self.schema["document_type"]
        self.assertEqual("fiscale", dt)
        self.assertTrue(self.NOM_RE.fullmatch(dt), dt)
        self.assertLessEqual(len(dt), 64)
        self.assertNotIn(dt, self.RESERVES)

    def test_champs_types_noms_et_sous_champs(self):
        def verifier(champs, chemin=""):
            self.assertIsInstance(champs, list)
            noms = set()
            for champ in champs:
                nom = champ["name"]
                with self.subTest(champ=chemin + nom):
                    self.assertEqual(["name", "type", "description", "fields"], list(champ))
                    self.assertTrue(self.NOM_RE.fullmatch(nom), nom)
                    self.assertNotIn(nom, self.RESERVES, "nom reserve par DocIE")
                    self.assertNotIn(nom, noms, "nom de champ duplique")
                    noms.add(nom)
                    self.assertIn(champ["type"], self.TYPES)
                    sous = champ["fields"]
                    if champ["type"] in ("object", "list"):
                        self.assertTrue(sous, "un object/list DOIT declarer des sous-champs")
                        verifier(sous, chemin + nom + ".")
                    else:
                        self.assertEqual([], sous, "un scalaire ne declare PAS de sous-champs")

        verifier(self.schema["fields"])

    def test_aucun_champ_invente(self):
        # Exactement les champs justifies, avec leur type : ni plus, ni moins.
        self.assertEqual(
            {nom: type_ for nom, (type_, _) in CHAMPS_JUSTIFIES.items()},
            {c["name"]: c["type"] for c in self.schema["fields"]},
        )

    def test_aucun_montant(self):
        # Une attestation de regularite fiscale atteste que les declarations
        # sont deposees et les sommes payees ; elle n'imprime pas de montant.
        # La ligne « money » de #170 ne vaut donc pas pour cette piece.
        self.assertFalse([c for c in self.schema["fields"] if c["type"] == "money"])


class TestSchemaEtFixturesRestentEnPhase(unittest.TestCase):
    def test_la_fixture_transporte_le_schema_du_fichier(self):
        # generate_fiscale_sample.py lit le fichier de schema : si le schema
        # change sans regeneration, ce test le dit.
        schema = _schema()
        for nom in FIXTURES_FISCALE:
            with self.subTest(fixture=nom):
                envelope = _load_fixture(nom)
                self.assertEqual(schema, envelope["dynamic_schema"])
                self.assertEqual("fiscale", envelope["schema_name"])
                noms = {c["name"] for c in schema["fields"]}
                self.assertEqual(noms | {"document_type", "extraction_notes"}, set(envelope["result"]))


if __name__ == "__main__":
    unittest.main()
