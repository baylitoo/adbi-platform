#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests reels (assertions de valeurs, pas un simple smoke test) pour
kbis_to_contrats.py.

Trois fixtures utilisees, toutes generees a partir des VRAIS modeles
pydantic de DocIE (voir fixtures/generate_kbis_sample.py pour la
provenance) :
  - kbis_extraction_sample.json                -- cas nominal
  - kbis_extraction_sample_edge_cases.json      -- valeurs nulles/absentes,
    date non parseable, devise non-EUR, nom illisible mais SIREN present
  - kbis_extraction_sample_unreadable.json      -- nom/SIREN/SIRET tous
    absents -> doit basculer sur la branche "Document illisible"

Un garde-fou anti-derive (TestDocanalyzeParity.test_base_keys_match_live_js)
relit contrats/lib/docanalyze.js EN DIRECT et EXTRAIT les cles des `return
{...}` de analyzeDocumentLocal (docanalyze.js est une fonction, pas un
tableau statique comme contrats/lib/fields.js -- l'astuce Node "require +
lire un tableau" de test_contract_to_contrats.py ne s'applique pas ici ;
l'extraction se fait donc par un decoupage du code source respectant la
profondeur des {}/[]/() -- fragile par construction vis-a-vis de JS
arbitraire, mais docanalyze.js n'a que 2 `return {` litteraux et aucune
cle calculee, ce qui reste dans le domaine que ce decoupage gere
correctement). Si quelqu'un change les cles renvoyees par
analyzeDocumentLocal sans mettre a jour kbis_to_contrats.py, ce test
echoue.

Lancer : python -m unittest document-parsing/mappings/test_kbis_to_contrats.py -v
(depuis la racine du depot), ou directement :
    python document-parsing/mappings/test_kbis_to_contrats.py
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from kbis_to_contrats import (  # noqa: E402
    DOCANALYZE_BASE_KEYS,
    ENRICHED_KEYS,
    MAPPED_FIELDS,
    KbisMappingError,
    map_docie_kbis_to_analysis,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
DOCANALYZE_JS = REPO_ROOT / "contrats" / "lib" / "docanalyze.js"


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def _split_top_level_commas(s: str) -> list[str]:
    """Decoupe `s` sur les virgules de profondeur 0 (ignore celles a
    l'interieur de {}/[]/() -- ex: un tableau `issues: [...]` ou un objet
    imbrique ne doit pas etre coupe en plein milieu)."""
    parts, depth, buf = [], 0, []
    for ch in s:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return parts


_IDENT_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def _keys_from_return_block(block: str) -> set[str]:
    """Extrait les noms de cles d'un litteral d'objet JS a plat (properties
    `key: value` ET raccourcis `key,`) -- suffisant pour les 2 `return {...}`
    de analyzeDocumentLocal, qui sont tous deux des objets a un seul niveau."""
    keys = set()
    for part in _split_top_level_commas(block):
        part = part.strip()
        if not part:
            continue
        key = part.split(":", 1)[0].strip() if ":" in part else part
        if _IDENT_RE.match(key):
            keys.add(key)
    return keys


def _docanalyze_return_keys_from_source() -> set[str]:
    text = DOCANALYZE_JS.read_text(encoding="utf-8")
    m = re.search(
        r"async function analyzeDocumentLocal.*?(?=\nmodule\.exports)",
        text,
        re.DOTALL,
    )
    if not m:
        raise AssertionError("Impossible de localiser analyzeDocumentLocal dans docanalyze.js")
    fn_body = m.group(0)
    return_blocks = re.findall(r"return\s*\{(.*?)\}\s*;", fn_body, re.DOTALL)
    if not return_blocks:
        raise AssertionError("Aucun `return {...}` trouve dans analyzeDocumentLocal (docanalyze.js a change de forme)")
    keys: set[str] = set()
    for block in return_blocks:
        keys |= _keys_from_return_block(block)
    return keys


class TestDocanalyzeParity(unittest.TestCase):
    """Garde-fou anti-derive : DOCANALYZE_BASE_KEYS doit rester EXACTEMENT
    ce que contrats/lib/docanalyze.js::analyzeDocumentLocal renvoie
    aujourd'hui (les 2 branches de retour confondues -- elles utilisent le
    meme jeu de cles a l'heure ou ce test est ecrit)."""

    def test_docanalyze_js_is_readable(self):
        self.assertTrue(DOCANALYZE_JS.exists(), f"{DOCANALYZE_JS} introuvable -- verifier REPO_ROOT")

    def test_base_keys_match_live_js(self):
        real_keys = _docanalyze_return_keys_from_source()
        self.assertEqual(
            real_keys,
            DOCANALYZE_BASE_KEYS,
            f"contrats/lib/docanalyze.js::analyzeDocumentLocal a change ses cles de retour -- "
            f"manquantes dans DOCANALYZE_BASE_KEYS: {real_keys - DOCANALYZE_BASE_KEYS}, "
            f"en trop: {DOCANALYZE_BASE_KEYS - real_keys}",
        )

    def test_mapped_fields_are_disjoint_from_base_keys(self):
        # Aucune cle enrichie ne doit ecraser une cle docanalyze.js existante.
        self.assertEqual(set(), ENRICHED_KEYS & DOCANALYZE_BASE_KEYS)


class TestHappyPathFixture(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("kbis_extraction_sample.json")

    def test_output_is_strict_superset_of_docanalyze_keys(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, expected_name="SUND INDUSTRY SYSTEM")
        self.assertTrue(DOCANALYZE_BASE_KEYS.issubset(mapping.analysis.keys()))
        self.assertTrue(ENRICHED_KEYS.issubset(mapping.analysis.keys()))
        # Strict : au moins une cle en plus des 8 de base.
        self.assertGreater(len(mapping.analysis.keys()), len(DOCANALYZE_BASE_KEYS))

    def test_document_type_and_valid(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("Extrait Kbis", mapping.analysis["documentType"])
        self.assertTrue(mapping.analysis["isValid"])

    def test_company_name_and_name_matches_true(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, expected_name="SUND INDUSTRY SYSTEM")
        self.assertEqual("SUND INDUSTRY SYSTEM", mapping.analysis["companyName"])
        self.assertTrue(mapping.analysis["nameMatches"])
        self.assertNotIn("La société du document ne correspond pas au sous-traitant saisi.", mapping.analysis["issues"])

    def test_name_matches_false_for_unrelated_expected_name(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, expected_name="ACME AUTRE SOCIETE")
        self.assertFalse(mapping.analysis["nameMatches"])
        self.assertIn("La société du document ne correspond pas au sous-traitant saisi.", mapping.analysis["issues"])

    def test_name_matches_none_without_expected_name(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertIsNone(mapping.analysis["nameMatches"])

    def test_legal_form_matters_are_stripped_like_docanalyze(self):
        # "SAS" seul (forme juridique) ne doit pas suffire a faire matcher un
        # nom attendu compose uniquement de ce token -- meme filtre que
        # checkName() (tokens de formes juridiques exclus).
        mapping = map_docie_kbis_to_analysis(self.envelope, expected_name="SAS")
        self.assertIsNone(mapping.analysis["nameMatches"])  # aucun token exploitable -> null, comme checkName()

    def test_issued_date_is_normalized_from_french_format(self):
        # Fixture : issued_date = "04/09/2026" (DD/MM/YYYY) -> 2026-09-04.
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("2026-09-04", mapping.analysis["issuedDate"])
        self.assertIn("délivré le 2026-09-04", mapping.analysis["summary"])

    def test_enriched_fields_pass_through(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        v = mapping.analysis
        self.assertEqual("941091316", v["siren"])
        self.assertEqual("94109131600013", v["siret"])
        self.assertEqual("SAS", v["formeJuridique"])
        self.assertEqual("2019-03-12", v["dateImmatriculation"])
        self.assertEqual("941 091 316 RCS Paris", v["rcsNumber"])
        self.assertEqual("60 rue Francois 1er, 75008 Paris", v["adresseSiege"])
        self.assertEqual("6202A", v["codeActivite"])
        self.assertEqual("Monsieur Corentin CALVO", v["representantLegal"])

    def test_money_field_keeps_amount_and_currency_separate(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("1000", mapping.analysis["capitalSocial"])
        self.assertEqual("EUR", mapping.analysis["capitalSocialDevise"])

    def test_extraction_notes_surface_as_warnings_not_issues(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertTrue(any("activity_code" in w for w in mapping.warnings))
        self.assertFalse(any("activity_code" in i for i in mapping.analysis["issues"]))

    def test_matched_id_from_items(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, items=[{"id": "kbis", "label": "Kbis"}])
        self.assertEqual("kbis", mapping.analysis["matchedId"])

    def test_matched_id_none_when_items_id_differs(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, items=[{"id": "urssaf", "label": "URSSAF"}])
        self.assertIsNone(mapping.analysis["matchedId"])

    def test_matched_id_none_without_items(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertIsNone(mapping.analysis["matchedId"])


class TestEdgeCaseFixture(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("kbis_extraction_sample_edge_cases.json")

    def test_still_valid_because_siren_was_read(self):
        # company_name absent mais siren present -> pas assez pour basculer
        # en "illisible" (il faut les 3 : nom + SIREN + SIRET absents).
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertTrue(mapping.analysis["isValid"])
        self.assertEqual("Extrait Kbis", mapping.analysis["documentType"])

    def test_missing_company_name_yields_null_without_expected_name(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertIsNone(mapping.analysis["companyName"])
        self.assertIsNone(mapping.analysis["nameMatches"])

    def test_missing_company_name_with_expected_name_does_not_match(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, expected_name="ACME FREELANCE")
        self.assertFalse(mapping.analysis["nameMatches"])
        self.assertIsNone(mapping.analysis["companyName"])

    def test_absent_wrapper_fields_become_empty_string_not_none(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        v = mapping.analysis
        for key in ("formeJuridique", "adresseSiege", "codeActivite"):
            self.assertEqual("", v[key])
        self.assertEqual("", v["siret"])

    def test_unparseable_date_is_blanked_with_warning(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("", mapping.analysis["dateImmatriculation"])
        self.assertTrue(any("registration_date" in w and "le 12 mars 2019" in w for w in mapping.warnings))

    def test_iso_issued_date_passes_through(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("2026-09-01", mapping.analysis["issuedDate"])

    def test_non_eur_currency_is_flagged_not_converted(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("5000", mapping.analysis["capitalSocial"])
        self.assertEqual("USD", mapping.analysis["capitalSocialDevise"])
        self.assertTrue(any("USD" in w and "share_capital" in w for w in mapping.warnings))

    def test_docie_extraction_notes_surface_as_warnings(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertTrue(any("illisible sur ce scan" in w for w in mapping.warnings))

    def test_qualite_inline_in_representative_string_not_split(self):
        # Gap documente (GAP_NOTES["qualite_representant"]) : la qualite
        # reste imbriquee dans la chaine, non structuree.
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertEqual("Madame Jane DOE, Presidente", mapping.analysis["representantLegal"])


class TestDocieValidationInvalid(unittest.TestCase):
    """Aucune des 3 fixtures n'a validation.valid=False (DocIE n'a jamais
    renvoye ca en pratique, cf register_and_test.py) -- exerce quand meme ce
    chemin en mutant une copie de la fixture nominale, pour ne pas laisser
    `docie_says_invalid` sans couverture."""

    def test_validation_invalid_forces_illisible_shape_even_with_readable_fields(self):
        envelope = json.loads(json.dumps(_load_fixture("kbis_extraction_sample.json")))
        envelope["validation"]["valid"] = False
        mapping = map_docie_kbis_to_analysis(envelope)
        v = mapping.analysis
        self.assertFalse(v["isValid"])
        self.assertEqual("Document", v["documentType"])
        self.assertIsNone(v["companyName"])
        self.assertEqual("Document illisible.", v["summary"])


class TestUnreadableFixture(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("kbis_extraction_sample_unreadable.json")

    def test_falls_back_to_illisible_shape(self):
        mapping = map_docie_kbis_to_analysis(self.envelope, expected_name="PEU IMPORTE")
        v = mapping.analysis
        self.assertFalse(v["isValid"])
        self.assertEqual("Document", v["documentType"])
        self.assertIsNone(v["companyName"])
        self.assertIsNone(v["nameMatches"])
        self.assertEqual("", v["issuedDate"])
        self.assertEqual("Document illisible.", v["summary"])
        self.assertEqual(
            ["Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."],
            v["issues"],
        )

    def test_still_a_superset_of_docanalyze_keys_when_illisible(self):
        mapping = map_docie_kbis_to_analysis(self.envelope)
        self.assertTrue(DOCANALYZE_BASE_KEYS.issubset(mapping.analysis.keys()))


class TestSchemaGuard(unittest.TestCase):
    def test_wrong_schema_name_raises(self):
        bad = {"schema_name": "contract", "result": {}}
        with self.assertRaises(KbisMappingError):
            map_docie_kbis_to_analysis(bad)

    def test_missing_result_key_raises(self):
        bad = {"schema_name": "kbis"}
        with self.assertRaises(KbisMappingError):
            map_docie_kbis_to_analysis(bad)

    def test_non_dict_input_raises(self):
        with self.assertRaises(KbisMappingError):
            map_docie_kbis_to_analysis(None)  # type: ignore[arg-type]


class TestFieldInventory(unittest.TestCase):
    def test_mapped_fields_count_matches_schema(self):
        # 8 champs "simples" mappes 1-pour-1 (siren, siret_siege, legal_form,
        # registration_date, rcs_number, registered_address, activity_code,
        # legal_representative) -- company_name/issued_date/share_capital
        # sont traites a part (voir le module).
        self.assertEqual(8, len(MAPPED_FIELDS))


if __name__ == "__main__":
    unittest.main(verbosity=2)
