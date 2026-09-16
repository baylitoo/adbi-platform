#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests reels (assertions de valeurs, pas un smoke test) pour le schema
dynamique "fiscale" (attestation de regularite fiscale, #170 / #194) et pour
fiscale_to_contrats.py.

Fixtures (structure reprise de sources mesurees, valeurs fabriquees -- voir
fixtures/generate_fiscale_sample.py et sa reserve) :
  - fiscale_extraction_sample.json             -- cas nominal
  - fiscale_extraction_sample_edge_cases.json  -- dates incoherentes, SIRET
    absent, champs vides, validation negative
  - fiscale_extraction_sample_unreadable.json  -- nom/SIREN/SIRET absents
Jeux d'essai partages traverses de bout en bout : date_plausible.json,
siren_siret.json, nom_docie.json.

Ce fichier porte aussi la conformite du SCHEMA a DynamicSchemaSpec (types,
sous-champs, noms reserves, snake_case <= 64), verifiee hors ligne comme
test_rib_to_contrats.py (#209).

Lancer : python -m unittest discover -s document-parsing/mappings
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import date_plausible  # noqa: E402
import fiscale_to_contrats  # noqa: E402
import kbis_to_contrats  # noqa: E402
import siren_siret  # noqa: E402
import urssaf_to_contrats  # noqa: E402
from fiscale_to_contrats import (  # noqa: E402
    DOCANALYZE_BASE_KEYS,
    DOCUMENT_TYPE_LABEL,
    ENRICHED_KEYS,
    LIBELLES_DATES,
    MAPPED_FIELDS,
    ORDRE_DATES,
    SCHEMA_PATH,
    FiscaleMappingError,
    load_schema,
    map_docie_fiscale_to_analysis,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
PARTAGEES = REPO_ROOT / "document-parsing" / "fixtures"
DOCANALYZE_JS = REPO_ROOT / "contrats" / "lib" / "docanalyze.js"
SOURCE = Path(__file__).parent / "fiscale_to_contrats.py"

FIXTURES_FISCALE = (
    "fiscale_extraction_sample.json",
    "fiscale_extraction_sample_edge_cases.json",
    "fiscale_extraction_sample_unreadable.json",
)
ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."
DATE_ABSENTE = "Date de délivrance non trouvée dans le document."

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


def _charger(chemin: Path) -> dict:
    with open(chemin, encoding="utf-8") as fh:
        return json.load(fh)


def _load_fixture(name: str) -> dict:
    return _charger(FIXTURES_DIR / name)


DATES = _charger(PARTAGEES / "date_plausible.json")
# Date du jour FIGEE des tests : celle du jeu d'essai partage.
AUJOURDHUI = DATES["aujourdhui"]


def _mapper(envelope, **kwargs):
    kwargs.setdefault("aujourdhui", AUJOURDHUI)
    return map_docie_fiscale_to_analysis(envelope, **kwargs)


def _enveloppe(valeurs: dict) -> dict:
    return {
        "schema_name": "fiscale",
        "result": {nom: {"value": valeur} for nom, valeur in valeurs.items()},
        "validation": {"valid": True, "errors": [], "warnings": []},
    }


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
        cls.schema = load_schema()

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
        self.assertFalse([c for c in self.schema["fields"] if c["type"] == "money"])

    def test_chaque_champ_du_schema_est_mappe_et_reciproquement(self):
        noms = {c["name"] for c in self.schema["fields"]}
        self.assertEqual(noms, set(MAPPED_FIELDS) | {"company_name", "issued_date"})
        dates = {c["name"] for c in self.schema["fields"] if c["type"] == "date"}
        self.assertEqual(dates, set(LIBELLES_DATES))

    def test_le_fichier_de_schema_est_bien_a_l_endroit_annonce(self):
        self.assertTrue(SCHEMA_PATH.exists(), SCHEMA_PATH)
        self.assertEqual("fiscale.schema.json", SCHEMA_PATH.name)


class TestSchemaEtFixturesRestentEnPhase(unittest.TestCase):
    def test_la_fixture_transporte_le_schema_du_fichier(self):
        schema = load_schema()
        for nom in FIXTURES_FISCALE:
            with self.subTest(fixture=nom):
                envelope = _load_fixture(nom)
                self.assertEqual(schema, envelope["dynamic_schema"])
                self.assertEqual("fiscale", envelope["schema_name"])
                noms = {c["name"] for c in schema["fields"]}
                self.assertEqual(noms | {"document_type", "extraction_notes"}, set(envelope["result"]))


class TestImportePasRecopie(unittest.TestCase):
    """Garde-fou « importe, pas recopie » de la paire URSSAF (#208), etendu a
    cette paire et au controle de dates, sur trois niveaux : identite d'objet,
    lecture du source, temoin (une copie RENOMMEE, import laisse en place,
    passe les deux premiers et pas le troisieme)."""

    def test_identite_d_objet(self):
        f = fiscale_to_contrats
        self.assertIs(f._normalize_date, kbis_to_contrats._normalize_date)
        self.assertIs(f._extract_scalar, kbis_to_contrats._extract_scalar)
        self.assertIs(f._check_name, kbis_to_contrats._check_name)
        self.assertIs(f._check_name, urssaf_to_contrats._check_name)
        self.assertIs(f.controler_siren_siret, siren_siret.controler_siren_siret)
        self.assertIs(f.messages_siren_siret, siren_siret.messages_siren_siret)
        self.assertIs(f.controler_siren_siret, urssaf_to_contrats.controler_siren_siret)
        self.assertIs(f.controler_dates, date_plausible.controler_dates)
        self.assertIs(f.messages_dates, date_plausible.messages_dates)
        self.assertIs(date_plausible._normalize_date, f._normalize_date)

    def test_lecture_du_source(self):
        source = SOURCE.read_text(encoding="utf-8")
        self.assertRegex(source, r"(?m)^from siren_siret import ")
        self.assertRegex(source, r"(?m)^from date_plausible import ")
        self.assertRegex(source, r"(?m)^from kbis_to_contrats import ")
        self.assertIsNone(
            re.search(
                r"^\s*def\s+(controler_siren_siret|messages_siren_siret|_luhn_valide|_controler_un"
                r"|controler_dates|messages_dates|date_du_jour|_majuscule_initiale"
                r"|_normalize_date|_date_existe|_forme_ecrite|_extract_scalar|_check_name|_norm)\b"
                r"|^\s*(controler_siren_siret|messages_siren_siret|MOTIF_SEPARATEURS|_SEPARATEURS_RE"
                r"|controler_dates|messages_dates|_normalize_date|_check_name|_norm|_LEGAL_FORM_TOKENS|_LIGATURES"
                r"|ANNEE_MIN|ANNEE_MAX|_JOURS_PAR_MOIS|MOIS)\s*=",
                source,
                re.M,
            ),
            "fiscale_to_contrats.py ne doit PAS redefinir un controle ni un normaliseur partage",
        )
        code = re.sub(r'"""[\s\S]*?"""', "", source)
        code = "\n".join(l for l in code.splitlines() if not l.lstrip().startswith("#"))
        # Ni Luhn, ni seconde fenetre d'annees, ni comparaison de nom recopies.
        self.assertNotIn("% 10", code)
        self.assertIsNone(re.search(r"\b(1950|2100)\b", code))
        self.assertNotIn("unicodedata", code)

    def test_temoin_siren_siret(self):
        f = fiscale_to_contrats
        temoin = {"siren": {"valeur": "t", "chiffres": None, "statut": "temoin"},
                  "siret": {"valeur": "", "chiffres": None, "statut": "absent"}}
        with mock.patch.object(f, "controler_siren_siret", return_value=temoin) as espion, \
                mock.patch.object(f, "messages_siren_siret", return_value=[{"champ": "siren", "message": "MESSAGE TEMOIN"}]):
            mapping = _mapper(_load_fixture("fiscale_extraction_sample.json"))
        espion.assert_called_once_with("941091316", "94109131600013")
        self.assertIs(temoin, mapping.analysis["controleSirenSiret"])
        self.assertIn("MESSAGE TEMOIN", mapping.analysis["issues"])
        self.assertIn("siren: MESSAGE TEMOIN", mapping.warnings)

    def test_temoin_dates(self):
        f = fiscale_to_contrats
        temoin = {"issued_date": {"valeur": "t", "date": "", "statut": "temoin"},
                  "situation_date": {"valeur": "", "date": "", "statut": "absent"}}
        with mock.patch.object(f, "controler_dates", return_value=temoin) as espion, \
                mock.patch.object(f, "messages_dates", return_value=[{"champ": "issued_date", "message": "DATE TEMOIN"}]):
            mapping = _mapper(_load_fixture("fiscale_extraction_sample.json"))
        espion.assert_called_once_with({"issued_date": "2026-03-04", "situation_date": "28/02/2026"},
                                       ordre=ORDRE_DATES, aujourdhui=AUJOURDHUI)
        self.assertIs(temoin, mapping.analysis["controleDates"])
        self.assertIn("DATE TEMOIN", mapping.analysis["issues"])
        self.assertIn("issued_date: DATE TEMOIN", mapping.warnings)

    def test_temoin_nom(self):
        f = fiscale_to_contrats
        with mock.patch.object(f, "_check_name", return_value="TEMOIN") as espion:
            mapping = _mapper(_load_fixture("fiscale_extraction_sample.json"), expected_name="X")
        espion.assert_called_once_with("SUND INDUSTRY SYSTEM", "X")
        self.assertEqual("TEMOIN", mapping.analysis["nameMatches"])

    def test_ce_module_n_est_liste_comme_portage_d_aucune_regle_qu_il_importe(self):
        # `_ports` enumere les COPIES (ou les executants) d'une regle. Ce module
        # n'est une copie ni du normaliseur ni de la comparaison de nom.
        for nom in ("nombre_docie.json", "date_docie.json"):
            ports = _charger(PARTAGEES / nom)["_ports"]
            self.assertEqual(4, len(ports), nom)
            self.assertFalse(any("fiscale" in p for p in ports), nom)
        self.assertFalse(any("fiscale" in p for p in _charger(PARTAGEES / "nom_docie.json")["_ports"]))
        # Executant des jeux d'essai qu'il traverse de bout en bout, en revanche :
        self.assertIn("document-parsing/mappings/fiscale_to_contrats.py (Python)", _charger(PARTAGEES / "siren_siret.json")["_ports"])
        self.assertIn("document-parsing/mappings/fiscale_to_contrats.py (Python)", DATES["_ports"])

    def test_constantes_de_dates_identiques_a_la_fixture(self):
        self.assertEqual(DATES["libelles"], LIBELLES_DATES)
        self.assertEqual([list(p) for p in ORDRE_DATES], DATES["ordre"])
        self.assertEqual([], DATES["futur_admis"])


class TestCasNominal(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("fiscale_extraction_sample.json")

    def test_sortie_sur_ensemble_strict_des_cles_docanalyze(self):
        a = _mapper(self.envelope).analysis
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(a))
        self.assertTrue(set(ENRICHED_KEYS).issubset(a))
        for k in ENRICHED_KEYS:
            self.assertNotIn(k, DOCANALYZE_BASE_KEYS)
        self.assertNotIn("controleSirenSiret", ENRICHED_KEYS)
        self.assertNotIn("controleDates", ENRICHED_KEYS)

    def test_meme_forme_que_la_paire_urssaf(self):
        # La checklist doit pouvoir consommer cette analyse sans cas
        # particulier : memes cles de base, memes verdicts machine.
        fiscale = _mapper(self.envelope).analysis
        urssaf = urssaf_to_contrats.map_docie_urssaf_to_analysis(_load_fixture("urssaf_extraction_sample.json")).analysis
        for k in list(DOCANALYZE_BASE_KEYS) + ["controleSirenSiret"]:
            self.assertIn(k, fiscale)
            self.assertIs(type(urssaf[k]), type(fiscale[k]), k)

    def test_libelle_identique_a_docanalyze_js(self):
        a = _mapper(self.envelope).analysis
        self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
        self.assertIn('type = "' + DOCUMENT_TYPE_LABEL + '"', DOCANALYZE_JS.read_text(encoding="utf-8"))

    def test_valeurs(self):
        mapping = _mapper(self.envelope, expected_name="Sund Industry System", items=[{"id": "fiscale"}])
        a = mapping.analysis
        self.assertEqual("fiscale", a["matchedId"])
        self.assertIs(True, a["isValid"])
        self.assertEqual("2026-03-04", a["issuedDate"])
        self.assertEqual("2026-02-28", a["dateSituation"])
        self.assertEqual("SUND INDUSTRY SYSTEM", a["companyName"])
        self.assertIs(True, a["nameMatches"])
        self.assertEqual("941091316", a["siren"])
        self.assertEqual("94109131600013", a["siret"])
        self.assertEqual("SIE de Paris 2e", a["serviceImpots"])
        self.assertEqual("L'entreprise est a jour de ses obligations fiscales declaratives et de paiement", a["mentionRegularite"])
        self.assertEqual(DOCUMENT_TYPE_LABEL + " — délivré le 2026-03-04", a["summary"])
        self.assertEqual([], a["issues"])
        self.assertEqual([], mapping.warnings)
        self.assertEqual("valide", a["controleSirenSiret"]["siren"]["statut"])
        self.assertEqual({"issued_date": {"valeur": "2026-03-04", "date": "2026-03-04", "statut": "plausible"},
                          "situation_date": {"valeur": "28/02/2026", "date": "2026-02-28", "statut": "plausible"}},
                         a["controleDates"])

    def test_name_matches_et_matched_id(self):
        self.assertIs(False, _mapper(self.envelope, expected_name="Autre Societe SARL").analysis["nameMatches"])
        self.assertIn("La société du document ne correspond pas au sous-traitant saisi.",
                      _mapper(self.envelope, expected_name="Autre Societe SARL").analysis["issues"])
        self.assertIsNone(_mapper(self.envelope).analysis["nameMatches"])
        self.assertIsNone(_mapper(self.envelope, items=[{"id": "urssaf"}]).analysis["matchedId"])
        self.assertIsNone(_mapper(self.envelope, items=[]).analysis["matchedId"])


class TestCasLimites(unittest.TestCase):
    def setUp(self):
        self.mapping = _mapper(_load_fixture("fiscale_extraction_sample_edge_cases.json"), expected_name="SUND INDUSTRY SYSTEM")
        self.a = self.mapping.analysis

    def test_situation_apres_delivrance_nommee_et_conservee(self):
        self.assertEqual("2026-08-31", self.a["issuedDate"])
        self.assertEqual("2026-09-10", self.a["dateSituation"])
        self.assertEqual("incoherente", self.a["controleDates"]["issued_date"]["statut"])
        self.assertEqual("incoherente", self.a["controleDates"]["situation_date"]["statut"])
        message = ("Dates incohérentes : date de situation « 2026-09-10 », date de délivrance « 2026-08-31 »"
                   " — la première ne peut pas suivre la seconde, l'une des deux est mal lue"
                   " — valeurs conservées, à vérifier sur le document")
        self.assertIn(message, self.a["issues"])
        self.assertIn("situation_date: " + message, self.mapping.warnings)
        self.assertNotIn(DATE_ABSENTE, self.a["issues"])

    def test_champs_absents_ou_vides(self):
        self.assertEqual("", self.a["siret"])
        self.assertEqual("absent", self.a["controleSirenSiret"]["siret"]["statut"])
        self.assertEqual("", self.a["serviceImpots"])
        self.assertEqual("   ", self.a["mentionRegularite"])

    def test_validation_negative_douteuse_pas_illisible(self):
        self.assertIs(False, self.a["isValid"])
        self.assertEqual(DOCUMENT_TYPE_LABEL, self.a["documentType"])
        self.assertEqual("SUND INDUSTRY SYSTEM", self.a["companyName"])
        self.assertEqual(["DocIE n'a pas validé l'extraction (vérification manuelle recommandée).",
                          "Dates incohérentes : date de situation « 2026-09-10 », date de délivrance « 2026-08-31 »"
                          " — la première ne peut pas suivre la seconde, l'une des deux est mal lue"
                          " — valeurs conservées, à vérifier sur le document"],
                         self.a["issues"])
        self.assertTrue(any(w.startswith("DocIE extraction_notes:") for w in self.mapping.warnings))
        self.assertTrue(any(w.startswith("DocIE validation.errors:") for w in self.mapping.warnings))
        self.assertTrue(any(w.startswith("DocIE validation.warnings:") for w in self.mapping.warnings))


class TestIllisible(unittest.TestCase):
    def test_bascule_sur_la_forme_illisible(self):
        a = _mapper(_load_fixture("fiscale_extraction_sample_unreadable.json")).analysis
        self.assertEqual("Document", a["documentType"])
        self.assertIs(False, a["isValid"])
        self.assertEqual("", a["issuedDate"])
        self.assertIsNone(a["companyName"])
        self.assertIsNone(a["nameMatches"])
        self.assertEqual("Document illisible.", a["summary"])
        self.assertEqual([ILLISIBLE], a["issues"])
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(a))
        self.assertTrue(set(ENRICHED_KEYS).issubset(a))
        self.assertEqual("SIE", a["serviceImpots"])
        self.assertEqual("absent", a["controleSirenSiret"]["siren"]["statut"])
        self.assertEqual("absent", a["controleDates"]["issued_date"]["statut"])

    def test_une_date_lue_sans_identite_ne_rend_pas_le_document_lisible(self):
        a = _mapper(_enveloppe({"issued_date": "2099-01-01"})).analysis
        self.assertEqual([ILLISIBLE], a["issues"])
        # Verdict tout de meme present, lisible par machine.
        self.assertEqual("future", a["controleDates"]["issued_date"]["statut"])


class TestEntreesInvalides(unittest.TestCase):
    def test_mauvais_schema_name(self):
        envelope = _load_fixture("fiscale_extraction_sample.json")
        envelope["schema_name"] = "urssaf"
        with self.assertRaises(FiscaleMappingError):
            _mapper(envelope)

    def test_result_manquant_et_entree_non_dict(self):
        with self.assertRaises(FiscaleMappingError):
            _mapper({"schema_name": "fiscale"})
        for mauvais in (None, [], "x", 3):
            with self.subTest(entree=mauvais), self.assertRaises(FiscaleMappingError):
                _mapper(mauvais)

    def test_date_du_jour_mal_formee_refusee(self):
        with self.assertRaises(ValueError):
            map_docie_fiscale_to_analysis(_load_fixture("fiscale_extraction_sample.json"), aujourdhui="15/09/2026")


class TestPlausibiliteDesDates(unittest.TestCase):
    """#194 : l'alternative 350M n'est proposee que derriere ces controles. Une
    date future, avant 1950 ou incoherente doit produire un message NOMME,
    distinct de « illisible » et de « non trouvee »."""

    BASE = {"company_name": "SUND INDUSTRY SYSTEM", "siren": "941091316"}

    def _issues(self, **dates):
        return _mapper(_enveloppe({**self.BASE, **dates})).analysis

    def test_chaque_panne_a_son_message(self):
        attendus = {
            "future": ({"issued_date": "2026-09-16"}, "date dans le futur"),
            "impossible": ({"issued_date": "12/05/1949"}, "date impossible"),
            "incoherente": ({"issued_date": "2026-03-04", "situation_date": "2026-03-10"}, "Dates incohérentes"),
            "non_reconnue": ({"issued_date": "mars 2026"}, "date illisible"),
        }
        textes = [t for _, t in attendus.values()] + [DATE_ABSENTE, ILLISIBLE]
        for statut, (dates, texte) in attendus.items():
            with self.subTest(statut=statut):
                a = self._issues(**dates)
                self.assertEqual(statut, a["controleDates"]["issued_date"]["statut"])
                self.assertTrue(a["isValid"])
                for autre in textes:
                    self.assertEqual(autre == texte, any(autre in i for i in a["issues"]), autre)

    def test_date_future_conservee_jamais_videe(self):
        a = self._issues(issued_date="2026-12-01")
        self.assertEqual("2026-12-01", a["issuedDate"])
        self.assertEqual("future", a["controleDates"]["issued_date"]["statut"])
        # Et le verdict suit la date du jour injectee.
        b = map_docie_fiscale_to_analysis(_enveloppe({**self.BASE, "issued_date": "2026-12-01"}), aujourdhui="2027-06-01").analysis
        self.assertEqual("plausible", b["controleDates"]["issued_date"]["statut"])
        self.assertEqual([], b["issues"])

    def test_chaque_cas_du_jeu_d_essai_partage_traverse_le_mapping(self):
        for cas in DATES["cas"]:
            with self.subTest(valeurs=cas["valeurs"], preuve=cas["preuve"]):
                mapping = map_docie_fiscale_to_analysis(
                    _enveloppe({**self.BASE, **cas["valeurs"]}), aujourdhui=cas.get("aujourdhui", AUJOURDHUI))
                a = mapping.analysis
                for champ in cas["valeurs"]:
                    self.assertEqual(cas["statuts"][champ], a["controleDates"][champ]["statut"], champ)
                    self.assertEqual(cas["dates"][champ], a["controleDates"][champ]["date"], champ)
                # issuedDate : la date lue, conservee meme future ou incoherente.
                self.assertEqual(cas["dates"]["issued_date"], a["issuedDate"])
                self.assertEqual(cas["dates"]["situation_date"], a["dateSituation"])
                attendues = [m["message"] for m in cas["messages"]]
                if cas["statuts"]["issued_date"] == "absent":
                    attendues.append(DATE_ABSENTE)
                self.assertEqual(attendues, a["issues"])
                self.assertEqual([f"{m['champ']}: {m['message']}" for m in cas["messages"]],
                                 [w for w in mapping.warnings if w.startswith(("issued_date: D", "situation_date: D"))])
                self.assertTrue(a["isValid"])
                self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])


class TestSirenSiretPartage(unittest.TestCase):
    """Chaque cas de siren_siret.json traverse le mapping fiscale, avec le meme
    verdict, les memes issues et les memes messages que la paire URSSAF."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = _charger(PARTAGEES / "siren_siret.json")

    @staticmethod
    def _valeurs(cas):
        return {"company_name": "SUND INDUSTRY SYSTEM", "siren": cas["siren"], "siret": cas["siret"], "issued_date": "2026-03-04"}

    def test_chaque_cas_traverse_le_mapping_comme_urssaf(self):
        for cas in self.fixture["cas"]:
            with self.subTest(siren=cas["siren"], siret=cas["siret"], preuve=cas["preuve"]):
                mapping = _mapper(_enveloppe(self._valeurs(cas)))
                a = mapping.analysis
                self.assertEqual("" if cas["siren"] is None else str(cas["siren"]), a["siren"])
                self.assertEqual(cas["statut_siren"], a["controleSirenSiret"]["siren"]["statut"])
                self.assertEqual(cas["statut_siret"], a["controleSirenSiret"]["siret"]["statut"])
                self.assertEqual([m["message"] for m in cas["messages"]], a["issues"])
                self.assertTrue(a["isValid"])
                urssaf = urssaf_to_contrats.map_docie_urssaf_to_analysis(
                    {"schema_name": "urssaf", "result": _enveloppe(self._valeurs(cas))["result"],
                     "validation": {"valid": True, "errors": [], "warnings": []}})
                self.assertEqual(urssaf.analysis["controleSirenSiret"], a["controleSirenSiret"])
                self.assertEqual(urssaf.analysis["issues"], a["issues"])
                prefixes = ("siren: ", "siret: ")
                self.assertEqual([w for w in urssaf.warnings if w.startswith(prefixes)],
                                 [w for w in mapping.warnings if w.startswith(prefixes)])


class TestNomPartage(unittest.TestCase):
    """Chaque cas de nom_docie.json traverse le mapping : nameMatches est le
    verdict de la regle partagee, et le message bloquant n'apparait que sur
    False (null = question non posee)."""

    def test_chaque_cas(self):
        fixture = _charger(PARTAGEES / "nom_docie.json")
        message = "La société du document ne correspond pas au sous-traitant saisi."
        for cas in fixture["cas"]:
            with self.subTest(nom_attendu=cas["nom_attendu"], candidat=cas["candidat"]):
                a = _mapper(_enveloppe({"company_name": cas["candidat"], "siren": "941091316", "issued_date": "2026-03-04"}),
                            expected_name=cas["nom_attendu"]).analysis
                self.assertIs(cas["resultat"], a["nameMatches"])
                self.assertEqual(cas["resultat"] is False, message in a["issues"])


if __name__ == "__main__":
    unittest.main()
