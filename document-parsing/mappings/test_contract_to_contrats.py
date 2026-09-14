#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests reels (assertions de valeurs, pas un simple smoke test) pour
contract_to_contrats.py.

Deux fixtures utilisees, toutes deux generees a partir des VRAIS modeles
pydantic de DocIE (voir fixtures/generate_sample.py pour la provenance et
pourquoi aucune extraction "contract" live n'existe a rejouer telle quelle) :
  - contract_extraction_sample.json            -- cas nominal
  - contract_extraction_sample_edge_cases.json -- valeurs nulles, cles
    absentes, date non parseable, devise non-EUR, numero_contrat manquant

Un garde-fou anti-derive (test_all_39_keys_are_accounted_for) relit
contrats/lib/fields.js EN DIRECT (via Node si disponible, sinon par une
extraction regex de secours) : si quelqu'un ajoute/retire un champ de
sousTraitance sans mettre a jour ce module, ce test echoue.

Lancer : python -m unittest document-parsing/mappings/test_contract_to_contrats.py -v
(depuis la racine du depot), ou directement :
    python document-parsing/mappings/test_contract_to_contrats.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from contract_to_contrats import (  # noqa: E402
    ALL_ACCOUNTED_KEYS,
    CONSTANT_FIELDS_NOT_FROM_DOCIE,
    GAP_FIELDS_NO_DOCIE_EQUIVALENT,
    MAPPED_FIELDS,
    ANNEE_MAX,
    ANNEE_MIN,
    MOIS,
    MOTIF_DATE_ECRITE,
    MOTIF_NOMBRE,
    TABLE_MOIS_CHEMIN,
    ContractMappingError,
    _normalize_date,
    _normalize_number,
    build_import_payload,
    map_docie_contract_to_sous_traitance,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
FIELDS_JS = REPO_ROOT / "contrats" / "lib" / "fields.js"


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def _sous_traitance_keys_via_node() -> list[str] | None:
    if not FIELDS_JS.exists():
        return None
    try:
        out = subprocess.run(
            ["node", "-e", "console.log(JSON.stringify(require('./contrats/lib/fields.js').sousTraitance.map(f=>f.key)))"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout.strip())
    except json.JSONDecodeError:
        return None


def _sous_traitance_keys_via_regex() -> list[str]:
    """Repli si Node n'est pas installe : extrait les `key: "..."` du bloc
    `const sousTraitance = [ ... ];` de fields.js. Fragile par construction
    (ne comprend pas le JS) -- Node reste la source de verite."""
    text = FIELDS_JS.read_text(encoding="utf-8")
    m = re.search(r"const sousTraitance\s*=\s*\[(.*?)\n\];", text, re.DOTALL)
    if not m:
        raise AssertionError("Impossible de localiser le bloc sousTraitance dans fields.js (repli regex)")
    block = m.group(1)
    return re.findall(r'key:\s*"([^"]+)"', block)


class TestFieldAccounting(unittest.TestCase):
    """Garde-fou anti-derive : les 3 categories (MAPPED / CONSTANT / GAP)
    doivent partitionner EXACTEMENT les cles reelles de sousTraitance."""

    def test_categories_are_disjoint(self):
        mapped_keys = {contrats_key for contrats_key, _ in MAPPED_FIELDS.values()}
        self.assertEqual(set(), mapped_keys & CONSTANT_FIELDS_NOT_FROM_DOCIE)
        self.assertEqual(set(), mapped_keys & set(GAP_FIELDS_NO_DOCIE_EQUIVALENT))
        self.assertEqual(set(), CONSTANT_FIELDS_NOT_FROM_DOCIE & set(GAP_FIELDS_NO_DOCIE_EQUIVALENT))

    def test_counts_match_design(self):
        # 19 extraits du document + 12 constantes ADBI/compta/clauses/version
        # + 8 lacunes reelles = 39 champs sousTraitance (voir le module).
        mapped_keys = {contrats_key for contrats_key, _ in MAPPED_FIELDS.values()}
        self.assertEqual(19, len(mapped_keys))
        self.assertEqual(12, len(CONSTANT_FIELDS_NOT_FROM_DOCIE))
        self.assertEqual(8, len(GAP_FIELDS_NO_DOCIE_EQUIVALENT))
        self.assertEqual(39, len(ALL_ACCOUNTED_KEYS))

    def test_all_39_keys_are_accounted_for(self):
        keys = _sous_traitance_keys_via_node()
        source = "node"
        if keys is None:
            keys = _sous_traitance_keys_via_regex()
            source = "regex fallback"
        self.assertTrue(keys, f"Aucune cle recuperee depuis fields.js ({source})")
        real_keys = set(keys)
        self.assertEqual(
            real_keys,
            ALL_ACCOUNTED_KEYS,
            f"contrats/lib/fields.js::sousTraitance a change (source: {source}) -- "
            f"manquantes: {real_keys - ALL_ACCOUNTED_KEYS}, "
            f"en trop: {ALL_ACCOUNTED_KEYS - real_keys}",
        )


class TestHappyPathFixture(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("contract_extraction_sample.json")
        self.mapping = map_docie_contract_to_sous_traitance(self.envelope)

    def test_no_blocking_errors(self):
        self.assertEqual([], self.mapping.errors)
        self.assertTrue(self.mapping.ok)

    def test_string_fields_pass_through(self):
        v = self.mapping.values
        self.assertEqual("01-06-2026", v["numeroContrat"])
        self.assertEqual("Paris", v["lieuRedaction"])
        self.assertEqual("SUND INDUSTRY SYSTEM", v["stNom"])
        self.assertEqual("60 rue Francois 1er, 75008 Paris", v["stAdresse"])
        self.assertEqual("941091316", v["stSiren"])
        self.assertEqual("94109131600013", v["stSiret"])
        self.assertEqual("Monsieur Corentin CALVO", v["stRepresentant"])
        self.assertEqual("SAS au capital de 1 000 EUR", v["stFormeJuridique"])
        self.assertEqual("President", v["stQualite"])
        self.assertEqual("Corentin Calvo", v["consultantNom"])
        self.assertEqual("Developpeur Full Stack", v["consultantFonction"])
        self.assertEqual("Groupe Accor", v["clientFinal"])
        self.assertEqual("Developpement full stack de la plateforme de reservation", v["natureTravaux"])
        self.assertEqual("82 rue Henry Farman, 92130 Issy-les-Moulineaux", v["lieuExecution"])

    def test_iso_date_passes_through(self):
        self.assertEqual("2026-01-05", self.mapping.values["dateRedaction"])
        self.assertEqual("2026-12-31", self.mapping.values["dateFin"])

    def test_french_date_is_normalized_to_iso(self):
        # Fixture : date_debut = "01/02/2026" (DD/MM/YYYY) -> 2026-02-01, sans avertissement.
        self.assertEqual("2026-02-01", self.mapping.values["dateDebut"])
        self.assertFalse(any("dateDebut" in w or "date_debut" in w for w in self.mapping.warnings))

    def test_money_field_strips_currency_wrapper(self):
        # tjm est de type "money" cote DocIE ({"amount","currency"}) mais
        # "number" cote fields.js (simple chaine numerique, pas d'objet).
        self.assertEqual("450", self.mapping.values["tjm"])

    def test_number_field_normalizes_whole_decimal(self):
        self.assertEqual("45", self.mapping.values["delaiPaiement"])

    def test_extraction_notes_surface_as_warnings(self):
        self.assertTrue(any("lieu_execution" in w for w in self.mapping.warnings))

    def test_constants_and_gaps_are_absent_from_values(self):
        # Ni les constantes ADBI ni les lacunes ne doivent apparaitre : elles
        # ne sont pas sourcees depuis DocIE (voir le module).
        for key in CONSTANT_FIELDS_NOT_FROM_DOCIE:
            self.assertNotIn(key, self.mapping.values)
        for key in GAP_FIELDS_NO_DOCIE_EQUIVALENT:
            self.assertNotIn(key, self.mapping.values)

    def test_exactly_the_19_mapped_keys_are_present(self):
        expected = {contrats_key for contrats_key, _ in MAPPED_FIELDS.values()}
        self.assertEqual(expected, set(self.mapping.values.keys()))

    def test_build_import_payload_shape(self):
        payload, mapping = build_import_payload(self.envelope)
        self.assertEqual("sous-traitance", payload["type"])
        self.assertIs(mapping.values, payload["values"])
        self.assertEqual("01-06-2026", payload["values"]["numeroContrat"])


class TestEdgeCaseFixture(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("contract_extraction_sample_edge_cases.json")
        self.mapping = map_docie_contract_to_sous_traitance(self.envelope)

    def test_null_required_field_is_blocking(self):
        # numero_contrat: {"value": null} -> "" -> erreur bloquante, miroir
        # de POST /api/contracts/importer.
        self.assertEqual("", self.mapping.values["numeroContrat"])
        self.assertIn("Le numero du contrat est requis.", self.mapping.errors)
        self.assertFalse(self.mapping.ok)

    def test_present_required_field_does_not_block(self):
        self.assertEqual("ACME FREELANCE", self.mapping.values["stNom"])
        self.assertNotIn("Le nom du sous-traitant / co-contractant est requis.", self.mapping.errors)

    def test_unparseable_date_is_blanked_with_warning(self):
        self.assertEqual("", self.mapping.values["dateRedaction"])
        self.assertTrue(any("date_redaction" in w and "le 5 courant" in w for w in self.mapping.warnings))

    def test_absent_wrapper_fields_become_empty_string_not_none(self):
        # lieu_redaction, st_adresse, st_siret, consultant_fonction,
        # nature_travaux, lieu_execution : wrapper entier absent (None) cote
        # DocIE -- doit se comporter EXACTEMENT comme une valeur nulle.
        for key in ("lieuRedaction", "stAdresse", "stSiret", "consultantFonction", "natureTravaux", "lieuExecution"):
            self.assertEqual("", self.mapping.values[key])

    def test_french_date_still_normalizes_alongside_bad_one(self):
        self.assertEqual("31/08/2026", "31/08/2026")  # sanity on the raw fixture value
        self.assertEqual("2026-08-31", self.mapping.values["dateFin"])
        self.assertEqual("2026-03-01", self.mapping.values["dateDebut"])

    def test_non_eur_currency_is_flagged_not_converted(self):
        self.assertEqual("500", self.mapping.values["tjm"])
        self.assertTrue(any("USD" in w and "tjm" in w for w in self.mapping.warnings))

    def test_non_integer_decimal_number_normalizes(self):
        # "30.0" (Decimal serialise en str) -> "30"
        self.assertEqual("30", self.mapping.values["delaiPaiement"])

    def test_docie_validation_warnings_surface(self):
        self.assertTrue(any("low overall confidence" in w for w in self.mapping.warnings))


class TestNombrePartage(unittest.TestCase):
    """Inventaire de divergence #179, lignes A2 a A6 : ce module s'en remettait
    a float(), le portage JS a Number(), et les deux n'acceptent pas les memes
    textes -- dans les DEUX sens. La regle est desormais ecrite une seule fois,
    dans document-parsing/fixtures/nombre_docie.json, et les quatre portages
    comparent leur motif ET leur sortie a ce fichier : ajouter une forme d'un
    seul cote casse le test de l'autre service."""

    @classmethod
    def setUpClass(cls):
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "nombre_docie.json", encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_motif_identique_a_la_fixture(self):
        self.assertEqual(self.fixture["motif"], MOTIF_NOMBRE)
        self.assertIn(
            "document-parsing/mappings/contract_to_contrats.py (Python)",
            self.fixture["_ports"],
        )

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"], preuve=cas["preuve"]):
                warnings: list[str] = []
                self.assertEqual(cas["sortie"], _normalize_number(cas["valeur"], "champ", warnings))
                self.assertEqual(cas["avertit"], bool(warnings))

    def test_none_et_nombre_natif(self):
        warnings: list[str] = []
        self.assertEqual("", _normalize_number(None, "champ", warnings))
        # Un Decimal deja deserialise en float ne doit pas changer de forme.
        self.assertEqual("450", _normalize_number(450, "champ", warnings))
        self.assertEqual("450.5", _normalize_number(450.5, "champ", warnings))
        self.assertEqual([], warnings)


class TestDatePartage(unittest.TestCase):
    """Inventaire de divergence #179, lignes A8 et A9 : le rare cas ou ce module
    et son portage JS etaient d'accord ET tous les deux faux. Les deux motifs de
    date ne comptent que des chiffres, jamais leurs bornes -- « 01/13/2026 »
    ressortait en « 2026-13-01 » et « 45/02/2026 » en « 2026-02-45 », des deux
    cotes, sans un seul avertissement. contrats/lib/fields.js declare ces champs
    en <input type="date">, que le navigateur vide pour une telle valeur : la
    date extraite disparaissait en silence. La regle est desormais ecrite une
    seule fois, dans document-parsing/fixtures/date_docie.json, et les quatre
    portages comparent leurs bornes ET leur sortie a ce fichier."""

    @classmethod
    def setUpClass(cls):
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "date_docie.json", encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_bornes_identiques_a_la_fixture(self):
        self.assertEqual(self.fixture["annee_min"], ANNEE_MIN)
        self.assertEqual(self.fixture["annee_max"], ANNEE_MAX)
        self.assertIn(
            "document-parsing/mappings/contract_to_contrats.py (Python)",
            self.fixture["_ports"],
        )

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"], preuve=cas["preuve"]):
                warnings: list[str] = []
                self.assertEqual(cas["sortie"], _normalize_date(cas["valeur"], "champ", warnings))
                self.assertEqual(cas["avertit"], bool(warnings))
                if cas["avertit"]:
                    # La NATURE de la panne, pas seulement sa presence : une
                    # date ecrite au jour impossible ne doit pas glisser vers
                    # « non reconnue », ni l'inverse.
                    self.assertIn(cas["avertissement"], warnings[0])

    def test_date_impossible_et_date_illisible_ne_s_avertissent_pas_pareil(self):
        # Deux pannes qui ne se corrigent pas de la meme facon : « DocIE a lu
        # une date fausse » n'est pas « DocIE n'a rien su lire ». La valeur
        # brute survit dans le message, puisque le champ, lui, reste vide.
        impossible: list[str] = []
        self.assertEqual("", _normalize_date("01/13/2026", "date_debut", impossible))
        self.assertIn("date_debut", impossible[0])
        self.assertIn("date impossible", impossible[0])
        self.assertIn("01/13/2026", impossible[0])

        illisible: list[str] = []
        self.assertEqual("", _normalize_date("le 5 courant", "date_redaction", illisible))
        self.assertIn("date non reconnue", illisible[0])
        self.assertNotIn("date impossible", illisible[0])

        # Meme frontiere par la voie ecrite (#179 A10) : « le 45 mars 2019 »
        # est une date LUE mais fausse -- jamais remise en forme, jamais
        # « non reconnue ».
        ecrite: list[str] = []
        self.assertEqual("", _normalize_date("le 45 mars 2019", "date_debut", ecrite))
        self.assertIn("date impossible", ecrite[0])
        self.assertNotIn("date non reconnue", ecrite[0])

    def test_table_des_mois_lue_dans_date_mission_jamais_recopiee(self):
        # #179 ligne A10 : la table existe deja (date_mission.json). Elle est
        # LUE, pas recopiee -- une cinquieme copie rouvrirait la porte de #179.
        self.assertEqual(self.fixture["motif_date_ecrite"], MOTIF_DATE_ECRITE)
        self.assertEqual((REPO_ROOT / self.fixture["table_mois"]).resolve(), TABLE_MOIS_CHEMIN)
        with open(TABLE_MOIS_CHEMIN, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["mois"], MOIS)
        # json.load rend un objet neuf : l'identite n'est pas verifiable cote
        # Python, d'ou le scan de la source -- une table litterale y ferait
        # apparaitre ses cles entre guillemets.
        source = (Path(__file__).parent / "contract_to_contrats.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"[\"']janvier[\"']", source))

    def test_date_refusee_jamais_reparee(self):
        # Ni jour/mois echanges, ni jour rabattu sur la borne du mois : une
        # date fausse sort vide avec un avertissement, jamais en valeur
        # plausible fabriquee.
        for valeur in ("01/13/2026", "2026-02-30", "45/02/2026"):
            with self.subTest(valeur=valeur):
                self.assertEqual("", _normalize_date(valeur, "champ", []))

    def test_none_et_date_native(self):
        warnings: list[str] = []
        self.assertEqual("", _normalize_date(None, "champ", warnings))
        self.assertEqual("", _normalize_date("", "champ", warnings))
        self.assertEqual([], warnings)


class TestSchemaGuard(unittest.TestCase):
    def test_wrong_schema_name_raises(self):
        bad = {"schema_name": "resume", "result": {}}
        with self.assertRaises(ContractMappingError):
            map_docie_contract_to_sous_traitance(bad)

    def test_missing_result_key_raises(self):
        bad = {"schema_name": "contract"}
        with self.assertRaises(ContractMappingError):
            map_docie_contract_to_sous_traitance(bad)

    def test_non_dict_input_raises(self):
        with self.assertRaises(ContractMappingError):
            map_docie_contract_to_sous_traitance(None)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main(verbosity=2)
