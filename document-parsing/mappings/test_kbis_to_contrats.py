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
    ANNEE_MAX,
    ANNEE_MIN,
    MOTIF_NOMBRE,
    KbisMappingError,
    _LEGAL_FORM_TOKENS,
    _LIGATURES,
    _check_name,
    _norm,
    _normalize_date,
    _normalize_number,
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

    def test_validation_invalid_marque_le_doute_sans_jeter_les_champs_lus(self):
        """Inventaire de divergence #179, ligne B1. Ce module basculait sur la
        branche "Document illisible" -- il jetait companyName, issuedDate et
        nameMatches, c'est-a-dire EXACTEMENT les trois valeurs que
        contrats/public/app.js::analyzeChecklistDoc lit -- et affichait
        "Aucun texte lisible (PDF scanne sans texte ou image floue)" pour une
        extraction ou le nom et le SIREN avaient ete lus. Une extraction
        douteuse n'est pas une extraction illisible : le portage JS
        (contrats/lib/kbis-mapping.js) avait deja la bonne regle."""
        envelope = json.loads(json.dumps(_load_fixture("kbis_extraction_sample.json")))
        envelope["validation"]["valid"] = False
        mapping = map_docie_kbis_to_analysis(envelope, expected_name="SUND INDUSTRY SYSTEM")
        v = mapping.analysis
        self.assertFalse(v["isValid"])
        self.assertEqual("Extrait Kbis", v["documentType"])
        self.assertEqual("SUND INDUSTRY SYSTEM", v["companyName"])
        self.assertTrue(v["nameMatches"])
        self.assertEqual("2026-09-04", v["issuedDate"])
        self.assertEqual("941091316", v["siren"])
        self.assertIn(
            "DocIE n'a pas validé l'extraction (vérification manuelle recommandée).",
            v["issues"],
        )

    def test_validation_invalide_ET_rien_didentifiant_reste_illisible(self):
        envelope = json.loads(json.dumps(_load_fixture("kbis_extraction_sample_unreadable.json")))
        envelope["validation"]["valid"] = False
        v = map_docie_kbis_to_analysis(envelope).analysis
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


class TestNombrePartage(unittest.TestCase):
    """Inventaire de divergence #179, lignes B2/B3 : ce module s'en remettait a
    float(), le portage JS a Number(), et les deux n'acceptent pas les memes
    textes. La regle est desormais ecrite une seule fois, dans
    document-parsing/fixtures/nombre_docie.json, et les quatre portages
    comparent leur motif ET leur sortie a ce fichier."""

    @classmethod
    def setUpClass(cls):
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "nombre_docie.json", encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_motif_identique_a_la_fixture(self):
        self.assertEqual(self.fixture["motif"], MOTIF_NOMBRE)
        self.assertIn(
            "document-parsing/mappings/kbis_to_contrats.py (Python)",
            self.fixture["_ports"],
        )

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"], preuve=cas["preuve"]):
                warnings: list[str] = []
                self.assertEqual(cas["sortie"], _normalize_number(cas["valeur"], "champ", warnings))
                self.assertEqual(cas["avertit"], bool(warnings))

    def test_capital_reduit_a_des_espaces_ne_devient_pas_zero(self):
        envelope = json.loads(json.dumps(_load_fixture("kbis_extraction_sample.json")))
        envelope["result"]["share_capital"]["amount"] = "   "
        mapping = map_docie_kbis_to_analysis(envelope)
        self.assertEqual("", mapping.analysis["capitalSocial"])
        self.assertEqual("EUR", mapping.analysis["capitalSocialDevise"])
        self.assertFalse(any("nombre non reconnu" in w for w in mapping.warnings))


class TestDatePartage(unittest.TestCase):
    """Inventaire de divergence #179, lignes A8 et A9 -- meme normaliseur de
    date que la paire `contract`, et meme defaut : les deux motifs ne comptent
    que des chiffres, jamais leurs bornes. « 01/13/2026 » ressortait en
    « 2026-13-01 » et « 45/02/2026 » en « 2026-02-45 », ici comme dans les
    trois autres portages, sans un seul avertissement. La regle est desormais
    ecrite une seule fois, dans document-parsing/fixtures/date_docie.json."""

    @classmethod
    def setUpClass(cls):
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "date_docie.json", encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_bornes_identiques_a_la_fixture(self):
        self.assertEqual(self.fixture["annee_min"], ANNEE_MIN)
        self.assertEqual(self.fixture["annee_max"], ANNEE_MAX)
        self.assertIn(
            "document-parsing/mappings/kbis_to_contrats.py (Python)",
            self.fixture["_ports"],
        )

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"], preuve=cas["preuve"]):
                warnings: list[str] = []
                self.assertEqual(cas["sortie"], _normalize_date(cas["valeur"], "champ", warnings))
                self.assertEqual(cas["avertit"], bool(warnings))

    def test_date_impossible_et_date_illisible_ne_s_avertissent_pas_pareil(self):
        impossible: list[str] = []
        self.assertEqual("", _normalize_date("2026-02-30", "registration_date", impossible))
        self.assertIn("registration_date", impossible[0])
        self.assertIn("date impossible", impossible[0])

        illisible: list[str] = []
        self.assertEqual("", _normalize_date("le 12 mars 2019", "registration_date", illisible))
        self.assertIn("date non reconnue", illisible[0])
        self.assertNotIn("date impossible", illisible[0])

    def test_date_de_delivrance_impossible_vide_le_champ_sans_rendre_illisible(self):
        # contrats/public/app.js::analyzeChecklistDoc ne lit que issuedDate,
        # companyName et nameMatches : une date de delivrance impossible est
        # l'une des trois seules valeurs consommees en aval. Elle sort vide et
        # avertie -- jamais reparee, et sans faire basculer le document dans
        # la branche « illisible », qui jetterait les deux autres.
        envelope = json.loads(json.dumps(_load_fixture("kbis_extraction_sample.json")))
        envelope["result"]["issued_date"]["value"] = "01/13/2026"
        mapping = map_docie_kbis_to_analysis(envelope)
        self.assertEqual("", mapping.analysis["issuedDate"])
        self.assertTrue(mapping.analysis["isValid"])
        self.assertEqual("SUND INDUSTRY SYSTEM", mapping.analysis["companyName"])
        self.assertTrue(any("issued_date" in w and "date impossible" in w for w in mapping.warnings))


class TestFieldInventory(unittest.TestCase):
    def test_mapped_fields_count_matches_schema(self):
        # 8 champs "simples" mappes 1-pour-1 (siren, siret_siege, legal_form,
        # registration_date, rcs_number, registered_address, activity_code,
        # legal_representative) -- company_name/issued_date/share_capital
        # sont traites a part (voir le module).
        self.assertEqual(8, len(MAPPED_FIELDS))


class TestNomPartage(unittest.TestCase):
    """Inventaire de divergence #179, ligne B7 : la correspondance de nom a
    DEUX implementations -- contrats/lib/docanalyze.js::checkName (le JS, qui
    tourne en production, importe tel quel par lib/kbis-mapping.js) et
    _check_name ici. #179 les a mesurees d'accord sur les fixtures du depot,
    mais RIEN ne les comparait l'une a l'autre : la premiere derive serait
    passee inapercue jusqu'a l'ecran. L'enjeu est concret --
    `nameMatches === false` fait afficher a contrats/public/app.js::
    analyzeChecklistDoc un « ⛔ ce n'est PAS le sous-traitant saisi »
    BLOQUANT, donc une divergence accuse a tort un sous-traitant legitime.
    La regle est desormais ecrite une seule fois, dans
    document-parsing/fixtures/nom_docie.json, et les deux portages comparent
    leurs constantes ET leur verdict a ce fichier."""

    @classmethod
    def setUpClass(cls):
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "nom_docie.json", encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_formes_juridiques_identiques_a_la_fixture(self):
        self.assertEqual(set(self.fixture["formes_juridiques"]), _LEGAL_FORM_TOKENS)
        self.assertIn(
            "document-parsing/mappings/kbis_to_contrats.py (Python)",
            self.fixture["_ports"],
        )

    def test_formes_juridiques_du_portage_js_identiques_a_la_fixture(self):
        # Meme garde-fou que TestDocanalyzeParity : docanalyze.js est relu EN
        # DIRECT, parce que checkName garde ses constantes en litteraux a
        # l'interieur de la fonction. Modifier la liste d'un seul cote sans
        # toucher la fixture casse donc ce test.
        source = DOCANALYZE_JS.read_text(encoding="utf-8")
        m = re.search(r"!/\^\(([A-Z|]+)\)\$/\.test\(t\)", source)
        self.assertIsNotNone(
            m,
            "checkName ne filtre plus les formes juridiques par ce litteral -- "
            "contrats/lib/docanalyze.js a change de forme",
        )
        self.assertEqual(self.fixture["formes_juridiques"], m.group(1).split("|"))

    def test_ligatures_identiques_a_la_fixture(self):
        # Issue #182. NFD ne decompose PAS Œ/Æ (ce sont des lettres, pas des
        # lettres accentuees) : sans cette table elles tombaient dans
        # [^A-Z0-9 ] et coupaient le jeton, d'ou un « ⛔ ce n'est PAS le
        # sous-traitant saisi » BLOQUANT sur « CŒUR DEFENSE ».
        self.assertEqual(
            [list(paire) for paire in _LIGATURES], self.fixture["ligatures"]
        )
        # ß n'a PAS a y figurer : str.upper() le deplie deja en « SS » des
        # deux cotes (mesure). Voir `_pourquoi_pas_ss` et son temoin.
        self.assertNotIn("ß", [paire[0] for paire in _LIGATURES])
        self.assertEqual("SS", _norm("ß"))
        # La translitteration precede bien le passage [^A-Z0-9 ].
        self.assertEqual("COEUR DEFENSE", _norm("CŒUR DEFENSE"))
        self.assertEqual("AE GROUPE", _norm("Æ GROUPE"))
        self.assertEqual("ELECTRICITE", _norm("ÉLECTRICITÉ"))

    def test_ligatures_du_portage_js_identiques_a_la_fixture(self):
        # Meme garde-fou que pour les formes juridiques : docanalyze.js est
        # relu EN DIRECT, LIGATURES n'etant pas exportee. Modifier la table
        # d'un seul cote sans toucher la fixture casse donc ce test.
        source = DOCANALYZE_JS.read_text(encoding="utf-8")
        m = re.search(r"const LIGATURES = (\[.*\]);", source)
        self.assertIsNotNone(
            m,
            "contrats/lib/docanalyze.js ne declare plus la table des ligatures "
            "par ce litteral (#182)",
        )
        self.assertEqual(self.fixture["ligatures"], json.loads(m.group(1)))

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(attendu=cas["nom_attendu"], candidat=cas["candidat"], preuve=cas["preuve"]):
                self.assertIs(cas["resultat"], _check_name(cas["candidat"], cas["nom_attendu"]))

    def test_tous_les_cas_jusqu_a_name_matches(self):
        # La fonction seule ne prouve pas ce que l'ecran recoit :
        # map_docie_kbis_to_analysis peut neutraliser le verdict (branche
        # « illisible »). On garde donc un siren pour rester hors de cette
        # branche, et on verifie que nameMatches est bien le verdict de
        # _check_name -- et que le message bloquant n'est ajoute aux `issues`
        # que sur False, jamais sur None.
        bloquant = "La société du document ne correspond pas au sous-traitant saisi."
        for cas in self.fixture["cas"]:
            with self.subTest(attendu=cas["nom_attendu"], candidat=cas["candidat"]):
                envelope = {
                    "schema_name": "kbis",
                    "result": {
                        "company_name": {"value": cas["candidat"], "confidence": 0.9, "evidence_ids": ["e1"]},
                        "siren": {"value": "941091316", "confidence": 0.99, "evidence_ids": ["e2"]},
                    },
                    "validation": {"valid": True, "errors": [], "warnings": []},
                }
                analysis = map_docie_kbis_to_analysis(
                    envelope, expected_name=cas["nom_attendu"], items=[{"id": "kbis"}]
                ).analysis
                self.assertIs(cas["resultat"], analysis["nameMatches"])
                self.assertEqual(cas["resultat"] is False, bloquant in analysis["issues"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
