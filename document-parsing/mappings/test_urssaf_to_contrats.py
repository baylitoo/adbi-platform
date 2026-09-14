#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests reels (assertions de valeurs, pas un smoke test) pour
urssaf_to_contrats.py.

Trois fixtures, structure reprise de sources mesurees et valeurs fabriquees --
voir fixtures/generate_urssaf_sample.py pour la provenance exacte et sa reserve
explicite (aucune attestation de vigilance reelle n'a ete lue) :
  - urssaf_extraction_sample.json             -- cas nominal
  - urssaf_extraction_sample_edge_cases.json  -- valeurs nulles/absentes, date
    impossible, nombre non reconnu, devise non-EUR, validation negative
  - urssaf_extraction_sample_unreadable.json  -- nom/SIREN/SIRET tous absents,
    doit basculer sur la branche "Document illisible"

Ce fichier porte aussi la conformite du SCHEMA lui-meme a DynamicSchemaSpec
(types autorises, sous-champs, noms reserves, snake_case) -- la seule
verification de ces contraintes possible sans appel distant.

Lancer : python -m pytest document-parsing/mappings/test_urssaf_to_contrats.py
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import kbis_to_contrats  # noqa: E402
from urssaf_to_contrats import (  # noqa: E402
    ANNEE_MAX,
    ANNEE_MIN,
    DOCANALYZE_BASE_KEYS,
    DOCUMENT_TYPE_LABEL,
    ENRICHED_KEYS,
    MAPPED_FIELDS,
    MOTIF_NOMBRE,
    SCHEMA_PATH,
    UrssafMappingError,
    load_schema,
    map_docie_urssaf_to_analysis,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
DOCANALYZE_JS = REPO_ROOT / "contrats" / "lib" / "docanalyze.js"
CHECKLIST_JS = REPO_ROOT / "contrats" / "lib" / "checklist.js"


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)


class TestSchemaConformeALaSpec(unittest.TestCase):
    """DynamicSchemaSpec, verifie sur le fichier plutot que sur une supposition.

    Les contraintes viennent de l'issue #170 (types disponibles, snake_case
    minuscule <= 64 caracteres, sous-champs obligatoires pour object/list et
    interdits pour un scalaire, noms reserves) et de la mesure enregistree dans
    document-parsing/scripts/register_and_test.py : un nom de champ hors de
    ^[a-z][a-z0-9_]{0,63}$ fait echouer l'enregistrement en HTTP 422
    string_pattern_mismatch (constate a la premiere tentative reelle). C'est la
    seule facon de prouver la conformite sans appel distant.
    """

    TYPES = {"string", "date", "number", "money", "object", "list"}
    NOM_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
    RESERVES = {"document_type", "extraction_notes"}

    @classmethod
    def setUpClass(cls):
        cls.schema = load_schema()

    def test_document_type_snake_case_et_borne(self):
        dt = self.schema["document_type"]
        self.assertTrue(self.NOM_RE.fullmatch(dt), dt)
        self.assertLessEqual(len(dt), 64)

    def test_champs_types_noms_et_sous_champs(self):
        def verifier(champs, chemin=""):
            self.assertIsInstance(champs, list)
            noms = set()
            for champ in champs:
                nom = champ["name"]
                with self.subTest(champ=chemin + nom):
                    self.assertTrue(self.NOM_RE.fullmatch(nom), nom)
                    self.assertNotIn(nom, self.RESERVES, "nom reserve par DocIE")
                    self.assertNotIn(nom, noms, "nom de champ duplique")
                    noms.add(nom)
                    self.assertIn(champ["type"], self.TYPES)
                    self.assertIn("description", champ)
                    sous = champ["fields"]
                    if champ["type"] in ("object", "list"):
                        self.assertTrue(sous, "un object/list DOIT declarer des sous-champs")
                        verifier(sous, chemin + nom + ".")
                    else:
                        # `money` est un SCALAIRE au sens de la spec : il ne
                        # declare pas de sous-champs, meme si sa valeur revient
                        # en {amount, currency} (mesure : share_capital dans
                        # register_and_test.py::SCHEMAS["kbis"]).
                        self.assertEqual([], sous, "un scalaire ne declare PAS de sous-champs")

        verifier(self.schema["fields"])

    def test_le_schema_a_la_meme_forme_que_celui_du_kbis_deja_enregistre(self):
        # Memes cles, meme ordre de cles, que le schema kbis de
        # register_and_test.py (seul schema du depot dont l'enregistrement a
        # ete reellement tente contre un serveur DocIE).
        for champ in self.schema["fields"]:
            self.assertEqual(["name", "type", "description", "fields"], list(champ))

    def test_chaque_cle_mappee_existe_dans_le_schema(self):
        noms = {c["name"] for c in self.schema["fields"]}
        attendus = set(MAPPED_FIELDS) | {"company_name", "issued_date", "declared_payroll"}
        self.assertTrue(attendus.issubset(noms), attendus - noms)
        # L'inverse aussi : aucun champ du schema n'est extrait puis jete.
        self.assertEqual(set(), noms - attendus)


class TestNormaliseursPartagesPasRecopies(unittest.TestCase):
    """Le point le plus important de ce module apres le mapping lui-meme.

    Quatre copies independantes de _normalize_date / _normalize_number ont
    produit six divergences mesurees entre Python et JS (inventaire #179,
    lignes A2-A6 et B2-B3). Ce module n'en ecrit PAS une cinquieme : il importe
    celles de kbis_to_contrats.py. On le verifie par IDENTITE d'objet, pas par
    egalite de comportement -- deux copies identiques aujourd'hui divergent
    demain, le meme objet jamais.
    """

    def test_les_fonctions_sont_litteralement_les_memes_objets(self):
        import urssaf_to_contrats as u

        self.assertIs(u._normalize_date, kbis_to_contrats._normalize_date)
        self.assertIs(u._normalize_number, kbis_to_contrats._normalize_number)
        self.assertIs(u._check_name, kbis_to_contrats._check_name)
        self.assertIs(u._extract_scalar, kbis_to_contrats._extract_scalar)
        self.assertIs(u._extract_money_pair, kbis_to_contrats._extract_money_pair)

    def test_les_constantes_restent_celles_des_fixtures_partagees(self):
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "nombre_docie.json", encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["motif"], MOTIF_NOMBRE)
        with open(REPO_ROOT / "document-parsing" / "fixtures" / "date_docie.json", encoding="utf-8") as fh:
            date_fixture = json.load(fh)
        self.assertEqual(date_fixture["annee_min"], ANNEE_MIN)
        self.assertEqual(date_fixture["annee_max"], ANNEE_MAX)

    def test_ce_module_n_est_pas_liste_comme_un_portage_de_plus(self):
        # `_ports` enumere les COPIES de la regle. Ce module n'en est pas une,
        # il ne doit donc pas y figurer -- s'il y figurait un jour, c'est que
        # quelqu'un aurait recopie le normaliseur ici.
        for nom in ("nombre_docie.json", "date_docie.json"):
            with open(REPO_ROOT / "document-parsing" / "fixtures" / nom, encoding="utf-8") as fh:
                ports = json.load(fh)["_ports"]
            self.assertEqual(4, len(ports), nom)
            self.assertFalse(any("urssaf" in p for p in ports), nom)


class TestCasNominal(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("urssaf_extraction_sample.json")

    def test_sortie_sur_ensemble_strict_des_cles_docanalyze(self):
        mapping = map_docie_urssaf_to_analysis(self.envelope, expected_name="SUND INDUSTRY SYSTEM")
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(mapping.analysis))
        self.assertTrue(set(ENRICHED_KEYS).issubset(mapping.analysis))
        self.assertGreater(len(mapping.analysis), len(DOCANALYZE_BASE_KEYS))

    def test_document_type_identique_au_libelle_de_docanalyze_js(self):
        mapping = map_docie_urssaf_to_analysis(self.envelope)
        self.assertEqual(DOCUMENT_TYPE_LABEL, mapping.analysis["documentType"])
        # Le libelle doit rester celui que detectType() produit pour cette
        # piece : l'origine de l'analyse ne change pas ce que l'on affiche.
        source = DOCANALYZE_JS.read_text(encoding="utf-8")
        self.assertIn('type = "' + DOCUMENT_TYPE_LABEL + '"', source)

    def test_issued_date_iso_traverse_et_alimente_issued_date(self):
        mapping = map_docie_urssaf_to_analysis(self.envelope)
        self.assertEqual("2026-03-04", mapping.analysis["issuedDate"])
        self.assertEqual([], mapping.warnings)
        self.assertIn("2026-03-04", mapping.analysis["summary"])

    def test_valid_until_francaise_est_convertie(self):
        mapping = map_docie_urssaf_to_analysis(self.envelope)
        self.assertEqual("2026-09-04", mapping.analysis["dateValidite"])

    def test_champs_enrichis_traversent(self):
        a = map_docie_urssaf_to_analysis(self.envelope).analysis
        self.assertEqual("941091316", a["siren"])
        self.assertEqual("94109131600013", a["siret"])
        self.assertEqual("12 rue de la Paix, 75002 Paris", a["adresseSiege"])
        self.assertEqual("A1B2C3D4E5", a["codeSecurite"])
        self.assertEqual("URSSAF Ile-de-France", a["organismeUrssaf"])
        self.assertEqual("12", a["nombreSalaries"])

    def test_montant_garde_sa_devise_a_part(self):
        a = map_docie_urssaf_to_analysis(self.envelope).analysis
        self.assertEqual("480000", a["masseSalariale"])
        self.assertEqual("EUR", a["masseSalarialeDevise"])

    def test_name_matches(self):
        self.assertIs(True, map_docie_urssaf_to_analysis(self.envelope, expected_name="Sund Industry System").analysis["nameMatches"])
        self.assertIs(False, map_docie_urssaf_to_analysis(self.envelope, expected_name="Autre Societe SARL").analysis["nameMatches"])
        self.assertIsNone(map_docie_urssaf_to_analysis(self.envelope).analysis["nameMatches"])

    def test_matched_id(self):
        self.assertEqual("urssaf", map_docie_urssaf_to_analysis(self.envelope, items=[{"id": "urssaf"}]).analysis["matchedId"])
        self.assertIsNone(map_docie_urssaf_to_analysis(self.envelope, items=[{"id": "kbis"}]).analysis["matchedId"])
        self.assertIsNone(map_docie_urssaf_to_analysis(self.envelope).analysis["matchedId"])


class TestCasLimites(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("urssaf_extraction_sample_edge_cases.json")
        self.mapping = map_docie_urssaf_to_analysis(self.envelope, expected_name="SUND INDUSTRY SYSTEM")

    def test_issued_date_francaise_convertie(self):
        self.assertEqual("2026-08-31", self.mapping.analysis["issuedDate"])

    def test_date_impossible_videe_et_nommee(self):
        self.assertEqual("", self.mapping.analysis["dateValidite"])
        self.assertTrue(any("date impossible" in w and "valid_until" in w for w in self.mapping.warnings),
                        self.mapping.warnings)

    def test_nombre_non_reconnu_reporte_tel_quel_avec_avertissement(self):
        self.assertEqual("douze", self.mapping.analysis["nombreSalaries"])
        self.assertTrue(any("nombre non reconnu" in w and "employee_count" in w for w in self.mapping.warnings))

    def test_devise_etrangere_signalee_jamais_convertie(self):
        self.assertEqual("480000", self.mapping.analysis["masseSalariale"])
        self.assertEqual("CHF", self.mapping.analysis["masseSalarialeDevise"])
        self.assertTrue(any("CHF" in w for w in self.mapping.warnings))

    def test_champ_absent_devient_chaine_vide_pas_none(self):
        # siret n'est pas dans la reponse du tout, registered_address y est a null.
        self.assertEqual("", self.mapping.analysis["siret"])
        self.assertEqual("", self.mapping.analysis["adresseSiege"])

    def test_champ_reduit_a_des_espaces_reste_tel_quel_cote_chaine(self):
        self.assertEqual("   ", self.mapping.analysis["codeSecurite"])

    def test_validation_negative_marque_le_doute_sans_jeter_les_champs_lus(self):
        # Regle alignee sur le portage JS (inventaire #179, ligne B1) :
        # extraction douteuse != document illisible.
        self.assertIs(False, self.mapping.analysis["isValid"])
        self.assertEqual(DOCUMENT_TYPE_LABEL, self.mapping.analysis["documentType"])
        self.assertEqual("SUND INDUSTRY SYSTEM", self.mapping.analysis["companyName"])
        self.assertEqual("2026-08-31", self.mapping.analysis["issuedDate"])
        self.assertIn("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).",
                      self.mapping.analysis["issues"])

    def test_notes_et_validation_sortent_en_warnings_pas_en_issues(self):
        self.assertTrue(any("extraction_notes" in w for w in self.mapping.warnings))
        self.assertTrue(any("validation.errors" in w for w in self.mapping.warnings))
        self.assertTrue(any("validation.warnings" in w for w in self.mapping.warnings))


class TestIllisible(unittest.TestCase):
    def setUp(self):
        self.mapping = map_docie_urssaf_to_analysis(_load_fixture("urssaf_extraction_sample_unreadable.json"))

    def test_bascule_sur_la_forme_illisible_de_docanalyze(self):
        a = self.mapping.analysis
        self.assertEqual("Document", a["documentType"])
        self.assertIs(False, a["isValid"])
        self.assertEqual("", a["issuedDate"])
        self.assertIsNone(a["companyName"])
        self.assertIsNone(a["nameMatches"])
        self.assertEqual("Document illisible.", a["summary"])
        self.assertIn("Aucun texte lisible (PDF scanné sans texte ou image floue). "
                      "Fournir un PDF texte ou une image nette.", a["issues"])

    def test_reste_un_sur_ensemble_des_cles_locales(self):
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(self.mapping.analysis))
        self.assertTrue(set(ENRICHED_KEYS).issubset(self.mapping.analysis))
        # Un champ isole bel et bien lu n'est pas jete pour autant.
        self.assertEqual("URSSAF", self.mapping.analysis["organismeUrssaf"])


class TestEntreesInvalides(unittest.TestCase):
    def test_mauvais_schema_name(self):
        envelope = _load_fixture("urssaf_extraction_sample.json")
        envelope["schema_name"] = "kbis"
        with self.assertRaises(UrssafMappingError):
            map_docie_urssaf_to_analysis(envelope)

    def test_result_manquant(self):
        with self.assertRaises(UrssafMappingError):
            map_docie_urssaf_to_analysis({"schema_name": "urssaf"})

    def test_entree_non_dict(self):
        for mauvais in (None, [], "x", 3):
            with self.subTest(entree=mauvais), self.assertRaises(UrssafMappingError):
                map_docie_urssaf_to_analysis(mauvais)


class TestValidite6Mois(unittest.TestCase):
    """La raison d'etre de ce mapping : la date de delivrance extraite pilote
    la validite 6 mois affichee par contrats/public/app.js.

    Ce test refait ici l'arithmetique de renderChecklistDocResult (limite =
    issuedDate + 6 mois, perime si la limite est passee) sur la valeur que ce
    module produit, pour prouver que le verdict SUIT la date DocIE.
    """

    @staticmethod
    def _jours_restants(iso: str, aujourdhui: tuple[int, int, int]) -> int:
        from datetime import date

        annee, mois, jour = (int(p) for p in iso.split("-"))
        mois_limite = mois + 6
        annee_limite = annee + (mois_limite - 1) // 12
        mois_limite = (mois_limite - 1) % 12 + 1
        limite = date(annee_limite, mois_limite, jour)
        return (limite - date(*aujourdhui)).days

    def test_la_checklist_declare_bien_urssaf_en_champ_date(self):
        source = CHECKLIST_JS.read_text(encoding="utf-8")
        ligne = next(l for l in source.splitlines() if '"urssaf"' in l or "'urssaf'" in l)
        self.assertIn("dateField: true", ligne)
        self.assertIn("6 mois", ligne)

    def test_le_verdict_suit_la_date_docie(self):
        envelope = _load_fixture("urssaf_extraction_sample.json")
        # Date DocIE = 2026-03-04 -> limite 2026-09-04.
        iso = map_docie_urssaf_to_analysis(envelope).analysis["issuedDate"]
        self.assertEqual("2026-03-04", iso)
        self.assertGreater(self._jours_restants(iso, (2026, 6, 1)), 30)   # valable
        self.assertLessEqual(self._jours_restants(iso, (2026, 8, 20)), 30)  # bientot perime
        self.assertLess(self._jours_restants(iso, (2026, 10, 1)), 0)      # perime

        # Et il change quand la date DocIE change : ce n'est pas un test qui
        # passerait aussi avec une date figee ailleurs.
        envelope["result"]["issued_date"]["value"] = "2026-07-15"
        iso2 = map_docie_urssaf_to_analysis(envelope).analysis["issuedDate"]
        self.assertEqual("2026-07-15", iso2)
        self.assertGreater(self._jours_restants(iso2, (2026, 10, 1)), 30)

    def test_date_de_delivrance_ecrite_en_toutes_lettres_est_lue(self):
        # Ce module n'ecrit pas de normaliseur de date : il importe celui de
        # kbis_to_contrats.py. La table de mois partagee (#179 A10/B10)
        # l'atteint donc aussi -- mesure avant : "" + « date non reconnue »,
        # donc validite 6 mois non calculable.
        envelope = _load_fixture("urssaf_extraction_sample.json")
        envelope["result"]["issued_date"]["value"] = "le 4 mars 2026"
        mapping = map_docie_urssaf_to_analysis(envelope)
        self.assertEqual("2026-03-04", mapping.analysis["issuedDate"])
        self.assertFalse(any(w.startswith("issued_date:") for w in mapping.warnings), mapping.warnings)
        self.assertNotIn("Date de délivrance non trouvée dans le document.", mapping.analysis["issues"])

    def test_sans_date_de_delivrance_le_probleme_est_nomme(self):
        envelope = _load_fixture("urssaf_extraction_sample.json")
        envelope["result"]["issued_date"]["value"] = None
        mapping = map_docie_urssaf_to_analysis(envelope)
        self.assertEqual("", mapping.analysis["issuedDate"])
        self.assertIn("Date de délivrance non trouvée dans le document.", mapping.analysis["issues"])


class TestSchemaEtFixturesRestentEnPhase(unittest.TestCase):
    def test_la_fixture_transporte_le_schema_du_fichier(self):
        # generate_urssaf_sample.py lit le fichier de schema : si le schema
        # change sans regeneration, ce test le dit.
        schema = load_schema()
        for nom in ("urssaf_extraction_sample.json", "urssaf_extraction_sample_edge_cases.json",
                    "urssaf_extraction_sample_unreadable.json"):
            with self.subTest(fixture=nom):
                self.assertEqual(schema, _load_fixture(nom)["dynamic_schema"])

    def test_le_fichier_de_schema_est_bien_a_l_endroit_annonce(self):
        self.assertTrue(SCHEMA_PATH.exists(), SCHEMA_PATH)
        self.assertEqual("urssaf.schema.json", SCHEMA_PATH.name)


if __name__ == "__main__":
    unittest.main()
