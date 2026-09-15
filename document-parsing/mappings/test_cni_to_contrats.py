#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests reels (assertions de valeurs, pas un smoke test) pour le schema
dynamique "cni" (piece d'identite, #170 / #194) et pour cni_to_contrats.py.

Fixtures (structure reprise de sources mesurees, valeurs fabriquees -- voir
fixtures/generate_cni_sample.py et sa reserve : aucune carte reelle lue, aucun
numero de titre reel) :
  - cni_extraction_sample.json             -- cas nominal
  - cni_extraction_sample_edge_cases.json  -- numero de MRZ mal lu, date
    d'expiration impossible, champs absents ou vides, validation negative
  - cni_extraction_sample_unreadable.json  -- ni nom, ni numero, ni MRZ
Jeu d'essai partage traverse de bout en bout : mrz.json.

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

import cni_to_contrats  # noqa: E402
import kbis_to_contrats  # noqa: E402
import mrz  # noqa: E402
import urssaf_to_contrats  # noqa: E402
from cni_to_contrats import (  # noqa: E402
    DOCANALYZE_BASE_KEYS,
    DOCUMENT_TYPE_LABEL,
    ENRICHED_KEYS,
    ILLISIBLE,
    MAPPED_FIELDS,
    SCHEMA_PATH,
    CniMappingError,
    load_schema,
    map_docie_cni_to_analysis,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parent.parent.parent
PARTAGEES = REPO_ROOT / "document-parsing" / "fixtures"
DOCANALYZE_JS = REPO_ROOT / "contrats" / "lib" / "docanalyze.js"
CHECKLIST_JS = REPO_ROOT / "contrats" / "lib" / "checklist.js"
CATALOGUE = REPO_ROOT / "document-parsing" / "models" / "catalogue.json"
SOURCE = Path(__file__).parent / "cni_to_contrats.py"

FIXTURES_CNI = (
    "cni_extraction_sample.json",
    "cni_extraction_sample_edge_cases.json",
    "cni_extraction_sample_unreadable.json",
)

# Les DIX champs retenus, chacun avec l'endroit du document ou il se lit. Figes
# ici plutot que deduits du fichier : un champ ajoute au schema sans
# justification casse ce test (garde-fou « aucun champ invente »).
CHAMPS_JUSTIFIES = {
    "surname": ("string", "nom de famille du titulaire"),
    "given_names": ("string", "prenoms du titulaire"),
    "document_number": ("string", "numero du titre, en clair"),
    "nationality": ("string", "nationalite"),
    "birth_date": ("date", "date de naissance"),
    "sex": ("string", "sexe"),
    "issue_date": ("date", "date de delivrance -> issuedDate"),
    "expiry_date": ("date", "date d'expiration"),
    "mrz_line1": ("string", "MRZ ligne 1 (TD1), porte le chiffre du numero"),
    "mrz_line2": ("string", "MRZ ligne 2 (TD1), porte naissance, expiration et composite"),
}

MESSAGE_NUMERO = ("Numéro de document « SPECIMEM1 » de la MRZ : chiffre de contrôle invalide (lu 3, calculé 0),"
                  " caractère probablement mal lu — valeur conservée, à vérifier sur le document")
MESSAGE_COMPOSITE = ("Chiffre de contrôle composite de la MRZ invalide (lu 6, calculé 3) : au moins un caractère"
                     " des lignes 1 et 2 est mal lu — valeur conservée, à vérifier sur le document")
DOCIE_DOUTEUX = "DocIE n'a pas validé l'extraction (vérification manuelle recommandée)."
NOM_NE_CORRESPOND_PAS = "La société du document ne correspond pas au sous-traitant saisi."


def _charger(chemin: Path) -> dict:
    with open(chemin, encoding="utf-8") as fh:
        return json.load(fh)


def _load_fixture(nom: str) -> dict:
    return _charger(FIXTURES_DIR / nom)


def _enveloppe(valeurs: dict, validation: dict | None = None) -> dict:
    return {
        "schema_name": "cni",
        "result": {nom: {"value": valeur} for nom, valeur in valeurs.items()},
        "validation": validation or {"valid": True, "errors": [], "warnings": []},
    }


class TestSchemaConformeALaSpec(unittest.TestCase):
    """DynamicSchemaSpec (#170) : memes contraintes que test_urssaf_to_contrats.py
    et test_rib_to_contrats.py -- snake_case ^[a-z][a-z0-9_]{0,63}$ (HTTP 422
    sinon, mesure dans register_and_test.py), types autorises, sous-champs
    obligatoires pour object/list et interdits pour un scalaire, noms
    reserves."""

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
        self.assertEqual("cni", dt)
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
                    self.assertTrue(champ["description"].strip(), "chaque champ dit ou il se lit")
                    sous = champ["fields"]
                    if champ["type"] in ("object", "list"):
                        self.assertTrue(sous, "un object/list DOIT declarer des sous-champs")
                        verifier(sous, chemin + nom + ".")
                    else:
                        self.assertEqual([], sous, "un scalaire ne declare PAS de sous-champs")

        verifier(self.schema["fields"])

    def test_aucun_champ_invente(self):
        self.assertEqual(
            {nom: type_ for nom, (type_, _) in CHAMPS_JUSTIFIES.items()},
            {c["name"]: c["type"] for c in self.schema["fields"]},
        )

    def test_aucun_montant_ni_nombre(self):
        # Une piece d'identite n'imprime ni montant ni quantite : les lignes
        # « money » et « number » de #170 ne valent pas pour cette piece, et le
        # module n'importe donc aucun normaliseur de nombre.
        self.assertFalse([c for c in self.schema["fields"] if c["type"] in ("money", "number")])

    def test_deux_lignes_de_mrz_et_pas_trois(self):
        """Le format TD1 compte TROIS lignes de 30 ; seules les deux premieres
        sont demandees, parce qu'elles portent tous les chiffres de controle.
        La troisieme ne porte que les noms, deja demandes en clair."""
        lignes = [c["name"] for c in self.schema["fields"] if c["name"].startswith("mrz_")]
        self.assertEqual(["mrz_line1", "mrz_line2"], lignes)
        self.assertNotIn("mrz_line3", {c["name"] for c in self.schema["fields"]})
        # Le choix du format est ECRIT, pas sous-entendu (il est cite de
        # memoire : la fixture partagee porte la reserve).
        self.assertIn("TD1", _charger(PARTAGEES / "mrz.json")["_format"])

    def test_chaque_champ_du_schema_est_mappe_et_reciproquement(self):
        noms = {c["name"] for c in self.schema["fields"]}
        self.assertEqual(noms, set(MAPPED_FIELDS) | {"issue_date"})

    def test_le_fichier_de_schema_est_bien_a_l_endroit_annonce(self):
        self.assertTrue(SCHEMA_PATH.exists(), SCHEMA_PATH)
        self.assertEqual("cni.schema.json", SCHEMA_PATH.name)


class TestSchemaEtFixturesRestentEnPhase(unittest.TestCase):
    def test_la_fixture_transporte_le_schema_du_fichier(self):
        schema = load_schema()
        for nom in FIXTURES_CNI:
            with self.subTest(fixture=nom):
                envelope = _load_fixture(nom)
                self.assertEqual(schema, envelope["dynamic_schema"])
                self.assertEqual("cni", envelope["schema_name"])
                noms = {c["name"] for c in schema["fields"]}
                self.assertEqual(noms | {"document_type", "extraction_notes"}, set(envelope["result"]))


class TestPieceEtCatalogue(unittest.TestCase):
    """Les faits du depot que ce module cite : la piece existe dans la
    checklist, le catalogue lui donne la voie vision et exige le controle de la
    MRZ, et le libelle de type est celui de docanalyze.js."""

    def test_le_libelle_est_celui_de_docanalyze_js(self):
        self.assertIn('type = "' + DOCUMENT_TYPE_LABEL + '"', DOCANALYZE_JS.read_text(encoding="utf-8"))

    def test_la_checklist_declare_bien_la_piece_cni_sans_champ_date(self):
        ligne = next(l for l in CHECKLIST_JS.read_text(encoding="utf-8").splitlines() if 'id: "cni"' in l)
        # Pas de `dateField` : aucune validite n'est calculee a partir de la
        # date de delivrance, d'ou l'absence du message « Date de delivrance
        # non trouvee » dans ce mapping (a la difference du Kbis et de l'URSSAF).
        self.assertNotIn("dateField", ligne)

    def test_le_catalogue_exige_le_controle_de_la_mrz(self):
        tache = _charger(CATALOGUE)["taches"]["cni"]
        self.assertEqual(["agent"], list(tache["voies"]), "voie vision seulement : une carte arrive en photo")
        self.assertIn("MRZ", tache["voies"]["agent"]["defaut"]["prerequis"])


class TestImportePasRecopie(unittest.TestCase):
    """Garde-fou « importe, pas recopie » des paires URSSAF (#208) et RIB
    (#209), sur trois niveaux : identite d'objet, lecture du source, temoin
    (une copie RENOMMEE, import laisse en place, passe les deux premiers et pas
    le troisieme)."""

    def test_identite_d_objet(self):
        c = cni_to_contrats
        self.assertIs(c._normalize_date, kbis_to_contrats._normalize_date)
        self.assertIs(c._extract_scalar, kbis_to_contrats._extract_scalar)
        self.assertIs(c._normalize_date, urssaf_to_contrats._normalize_date)
        self.assertIs(c.controler_mrz, mrz.controler_mrz)
        self.assertIs(c.messages_mrz, mrz.messages_mrz)

    def test_la_comparaison_de_nom_n_est_meme_pas_importee(self):
        # Ecart VOULU avec les trois autres paires : une carte d'identite porte
        # une personne physique, jamais la societe sous-traitante (voir
        # l'en-tete du module). Un import inutilise serait le debut d'une
        # comparaison ajoutee par megarde.
        self.assertFalse(hasattr(cni_to_contrats, "_check_name"))
        self.assertFalse(hasattr(cni_to_contrats, "_norm"))

    def test_lecture_du_source(self):
        source = SOURCE.read_text(encoding="utf-8")
        self.assertRegex(source, r"(?m)^from mrz import ")
        self.assertRegex(source, r"(?m)^from kbis_to_contrats import ")
        self.assertIsNone(
            re.search(
                r"^\s*def\s+(controler_mrz|messages_mrz|chiffre_controle|valeur_caractere|_controler_ligne"
                r"|_normalize_date|_date_existe|_forme_ecrite|_extract_scalar|_check_name|_norm)\b"
                r"|^\s*(controler_mrz|messages_mrz|POIDS|LONGUEUR_LIGNE|MOTIF_SEPARATEURS|_SEPARATEURS_RE"
                r"|_normalize_date|_check_name|_norm|ANNEE_MIN|ANNEE_MAX|_JOURS_PAR_MOIS|MOIS)\s*=",
                source,
                re.M,
            ),
            "cni_to_contrats.py ne doit PAS redefinir un controle ni un normaliseur partage",
        )
        code = re.sub(r'"""[\s\S]*?"""', "", source)
        code = "\n".join(l for l in code.splitlines() if not l.lstrip().startswith("#"))
        # Ni l'arithmetique des chiffres de controle, ni une seconde fenetre
        # d'annees, ni une comparaison de nom recopiees.
        self.assertNotIn("% 10", code)
        self.assertIsNone(re.search(r"\b(1950|2100)\b", code))
        self.assertNotIn("unicodedata", code)

    def test_temoin_mrz(self):
        c = cni_to_contrats
        temoin = {"ligne1": {"valeur": "t", "compact": None, "statut": "temoin"}}
        with mock.patch.object(c, "controler_mrz", return_value=temoin) as espion, \
                mock.patch.object(c, "messages_mrz", return_value=[{"champ": "mrz_line2", "message": "MRZ TEMOIN"}]):
            mapping = map_docie_cni_to_analysis(_load_fixture("cni_extraction_sample.json"))
        espion.assert_called_once_with("IDFRASPECIMEN13<<<<<<<<<<<<<<<", "8001014M3501014FRA<<<<<<<<<<<6")
        self.assertIs(temoin, mapping.analysis["controleMrz"])
        self.assertIn("MRZ TEMOIN", mapping.analysis["issues"])
        self.assertIn("mrz_line2: MRZ TEMOIN", mapping.warnings)

    def test_temoin_normalisateur_de_date(self):
        c = cni_to_contrats
        with mock.patch.object(c, "_normalize_date", return_value="1999-09-09") as espion:
            a = map_docie_cni_to_analysis(_load_fixture("cni_extraction_sample.json")).analysis
        self.assertEqual("1999-09-09", a["issuedDate"])
        self.assertEqual("1999-09-09", a["dateNaissance"])
        self.assertEqual("1999-09-09", a["dateExpiration"])
        self.assertEqual(3, espion.call_count, "les trois champs date passent par le normaliseur partage")

    def test_ce_module_n_est_liste_comme_portage_d_aucune_regle_qu_il_importe(self):
        # `_ports` enumere les COPIES (ou les executants) d'une regle. Ce module
        # n'est une copie ni du normaliseur de date ni de la comparaison de nom.
        for nom in ("nombre_docie.json", "date_docie.json"):
            ports = _charger(PARTAGEES / nom)["_ports"]
            self.assertEqual(4, len(ports), nom)
            self.assertFalse(any("cni" in p for p in ports), nom)
        self.assertFalse(any("cni" in p for p in _charger(PARTAGEES / "nom_docie.json")["_ports"]))
        # Executant du jeu d'essai MRZ qu'il traverse de bout en bout, en revanche :
        self.assertIn("document-parsing/mappings/cni_to_contrats.py (Python)",
                      _charger(PARTAGEES / "mrz.json")["_ports"])


class TestCasNominal(unittest.TestCase):
    def setUp(self):
        self.envelope = _load_fixture("cni_extraction_sample.json")

    def test_sortie_sur_ensemble_strict_des_cles_docanalyze(self):
        a = map_docie_cni_to_analysis(self.envelope).analysis
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(a))
        self.assertTrue(set(ENRICHED_KEYS).issubset(a))
        for cle in ENRICHED_KEYS:
            self.assertNotIn(cle, DOCANALYZE_BASE_KEYS)
        self.assertNotIn("controleMrz", ENRICHED_KEYS)

    def test_meme_forme_que_la_paire_urssaf(self):
        # Un consommateur doit pouvoir lire cette analyse sans cas particulier.
        cni = map_docie_cni_to_analysis(self.envelope).analysis
        urssaf = urssaf_to_contrats.map_docie_urssaf_to_analysis(
            _load_fixture("urssaf_extraction_sample.json")).analysis
        for cle in DOCANALYZE_BASE_KEYS:
            self.assertIn(cle, cni)
            if cni[cle] is not None and urssaf[cle] is not None:
                self.assertIs(type(urssaf[cle]), type(cni[cle]), cle)

    def test_valeurs(self):
        mapping = map_docie_cni_to_analysis(self.envelope, items=[{"id": "cni"}])
        a = mapping.analysis
        self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
        self.assertEqual("cni", a["matchedId"])
        self.assertIs(True, a["isValid"])
        self.assertEqual("2025-01-02", a["issuedDate"])
        self.assertEqual("SPECIMEN", a["nom"])
        self.assertEqual("JEAN PAUL", a["prenoms"])
        self.assertEqual("SPECIMEN1", a["numeroDocument"])
        self.assertEqual("FRA", a["nationalite"])
        self.assertEqual("1980-01-01", a["dateNaissance"])
        self.assertEqual("M", a["sexe"])
        # 01/01/2035 converti par la voie francaise du normaliseur partage.
        self.assertEqual("2035-01-01", a["dateExpiration"])
        self.assertEqual("IDFRASPECIMEN13<<<<<<<<<<<<<<<", a["mrzLigne1"])
        self.assertEqual("8001014M3501014FRA<<<<<<<<<<<6", a["mrzLigne2"])
        self.assertEqual(DOCUMENT_TYPE_LABEL + " — délivré le 2025-01-02", a["summary"])
        self.assertEqual([], a["issues"])
        self.assertEqual([], mapping.warnings)

    def test_les_quatre_chiffres_de_la_mrz_sont_verifies(self):
        controle = map_docie_cni_to_analysis(self.envelope).analysis["controleMrz"]
        for nom in ("ligne1", "ligne2", "numero_document", "date_naissance", "date_expiration", "composite"):
            self.assertEqual("valide", controle[nom]["statut"], nom)
        self.assertEqual("SPECIMEN1", controle["numero_document"]["valeur"])
        self.assertEqual("800101", controle["date_naissance"]["valeur"])
        self.assertEqual("350101", controle["date_expiration"]["valeur"])

    def test_matched_id(self):
        self.assertIsNone(map_docie_cni_to_analysis(self.envelope, items=[{"id": "kbis"}]).analysis["matchedId"])
        self.assertIsNone(map_docie_cni_to_analysis(self.envelope, items=[]).analysis["matchedId"])
        self.assertIsNone(map_docie_cni_to_analysis(self.envelope).analysis["matchedId"])


class TestPasDeComparaisonDeNom(unittest.TestCase):
    """Ecart VOULU avec les trois autres paires, et le plus important a figer :
    `expectedName` vaut la denomination du SOUS-TRAITANT, alors qu'une carte
    d'identite porte le consultant. Comparer les deux rendrait False sur une
    carte parfaitement valable, donc le message bloquant sur une piece juste."""

    def test_name_matches_reste_none_quel_que_soit_le_nom_attendu(self):
        envelope = _load_fixture("cni_extraction_sample.json")
        for attendu in (None, "", "SUND INDUSTRY SYSTEM", "SPECIMEN", "JEAN PAUL SPECIMEN", "Autre Societe SARL"):
            with self.subTest(expected_name=attendu):
                a = map_docie_cni_to_analysis(envelope, expected_name=attendu).analysis
                self.assertIsNone(a["nameMatches"])
                self.assertIsNone(a["companyName"])
                self.assertNotIn(NOM_NE_CORRESPOND_PAS, a["issues"])

    def test_le_nom_lu_n_est_pas_perdu_pour_autant(self):
        a = map_docie_cni_to_analysis(_load_fixture("cni_extraction_sample.json")).analysis
        self.assertEqual("SPECIMEN", a["nom"])
        self.assertEqual("JEAN PAUL", a["prenoms"])


class TestCasLimites(unittest.TestCase):
    def setUp(self):
        self.mapping = map_docie_cni_to_analysis(_load_fixture("cni_extraction_sample_edge_cases.json"))
        self.a = self.mapping.analysis

    def test_numero_de_mrz_mal_lu_conserve_et_signale_deux_fois(self):
        self.assertEqual("IDFRASPECIMEM13<<<<<<<<<<<<<<<", self.a["mrzLigne1"], "valeur CONSERVEE, jamais videe")
        self.assertEqual("cle_invalide", self.a["controleMrz"]["numero_document"]["statut"])
        self.assertEqual("cle_invalide", self.a["controleMrz"]["composite"]["statut"])
        # Les deux dates de la ligne 2, elles, restent valides.
        self.assertEqual("valide", self.a["controleMrz"]["date_naissance"]["statut"])
        self.assertEqual("valide", self.a["controleMrz"]["date_expiration"]["statut"])
        self.assertIn("mrz_line1: " + MESSAGE_NUMERO, self.mapping.warnings)
        self.assertIn("mrz_line2: " + MESSAGE_COMPOSITE, self.mapping.warnings)

    def test_les_issues_sont_exactement_les_pannes_nommees_dans_l_ordre(self):
        self.assertEqual([DOCIE_DOUTEUX, MESSAGE_NUMERO, MESSAGE_COMPOSITE], self.a["issues"])

    def test_date_impossible_videe_et_nommee_par_le_normaliseur_partage(self):
        self.assertEqual("", self.a["dateExpiration"])
        self.assertTrue(any("date impossible" in w and "expiry_date" in w for w in self.mapping.warnings),
                        self.mapping.warnings)

    def test_date_de_delivrance_ecrite_en_toutes_lettres_est_lue(self):
        # Voie de la table de mois partagee (#179 A10/B10), atteinte parce que
        # ce module importe le normaliseur au lieu d'en ecrire une copie.
        self.assertEqual("2025-01-02", self.a["issuedDate"])
        self.assertFalse(any(w.startswith("issue_date:") for w in self.mapping.warnings))

    def test_champs_absents_ou_vides(self):
        self.assertEqual("", self.a["numeroDocument"], "champ absent de la reponse")
        self.assertEqual("", self.a["sexe"], "champ a null")
        self.assertEqual("   ", self.a["nationalite"], "chaine : rendue telle quelle")

    def test_validation_negative_douteuse_pas_illisible(self):
        self.assertIs(False, self.a["isValid"])
        self.assertEqual(DOCUMENT_TYPE_LABEL, self.a["documentType"])
        self.assertEqual("SPECIMEN", self.a["nom"])
        self.assertTrue(any(w.startswith("DocIE extraction_notes:") for w in self.mapping.warnings))
        self.assertTrue(any(w.startswith("DocIE validation.errors:") for w in self.mapping.warnings))
        self.assertTrue(any(w.startswith("DocIE validation.warnings:") for w in self.mapping.warnings))


class TestIllisible(unittest.TestCase):
    def test_bascule_sur_la_forme_illisible(self):
        a = map_docie_cni_to_analysis(_load_fixture("cni_extraction_sample_unreadable.json")).analysis
        self.assertEqual("Document", a["documentType"])
        self.assertIs(False, a["isValid"])
        self.assertEqual("", a["issuedDate"])
        self.assertIsNone(a["companyName"])
        self.assertIsNone(a["nameMatches"])
        self.assertEqual("Document illisible.", a["summary"])
        self.assertEqual([ILLISIBLE], a["issues"])
        self.assertTrue(set(DOCANALYZE_BASE_KEYS).issubset(a))
        self.assertTrue(set(ENRICHED_KEYS).issubset(a))
        # Un champ isole bel et bien lu n'est pas jete.
        self.assertEqual("FRA", a["nationalite"])
        # Verdict tout de meme present, lisible par machine.
        self.assertEqual("absent", a["controleMrz"]["ligne1"]["statut"])
        self.assertEqual("absent", a["controleMrz"]["composite"]["statut"])

    def test_chaque_signal_identifiant_suffit_a_lui_seul(self):
        # Les quatre signaux : nom, numero du titre, et les deux lignes de MRZ.
        for champ in ("surname", "document_number", "mrz_line1", "mrz_line2"):
            with self.subTest(champ=champ):
                a = map_docie_cni_to_analysis(_enveloppe({champ: "X"})).analysis
                self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
                self.assertNotIn(ILLISIBLE, a["issues"])
        # Le prenom seul, la nationalite seule ou le sexe seul, non.
        for champ in ("given_names", "nationality", "sex"):
            with self.subTest(champ=champ):
                a = map_docie_cni_to_analysis(_enveloppe({champ: "X"})).analysis
                self.assertEqual("Document", a["documentType"])
                self.assertEqual([ILLISIBLE], a["issues"])

    def test_une_mrz_mal_lue_ne_rend_pas_la_carte_illisible(self):
        # Une ligne lue mais fausse est une lecture, pas une absence (#179 B1) :
        # la vider ferait basculer la carte dans la branche illisible.
        a = map_docie_cni_to_analysis(_enveloppe({"mrz_line1": "IDFRASPECIMEN13<<<<<<<<"})).analysis
        self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
        self.assertEqual("IDFRASPECIMEN13<<<<<<<<", a["mrzLigne1"])
        self.assertEqual("format_invalide", a["controleMrz"]["ligne1"]["statut"])
        self.assertIs(True, a["isValid"], "une valeur douteuse ne rend pas la piece invalide")


class TestEntreesInvalides(unittest.TestCase):
    def test_mauvais_schema_name(self):
        envelope = _load_fixture("cni_extraction_sample.json")
        envelope["schema_name"] = "rib"
        with self.assertRaises(CniMappingError):
            map_docie_cni_to_analysis(envelope)

    def test_result_manquant_et_entree_non_dict(self):
        with self.assertRaises(CniMappingError):
            map_docie_cni_to_analysis({"schema_name": "cni"})
        for mauvais in (None, [], "x", 3):
            with self.subTest(entree=mauvais), self.assertRaises(CniMappingError):
                map_docie_cni_to_analysis(mauvais)


class TestJeuDEssaiMrzDeBoutEnBout(unittest.TestCase):
    """Chaque cas de mrz.json traverse le mapping : statuts dans `controleMrz`,
    messages dans `issues` (dans l'ordre), lignes lues conservees telles
    quelles. Le verdict doit arriver dans `analysis`, pas seulement dans
    `warnings` : le chemin de production ne garde que `analysis`."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = _charger(PARTAGEES / "mrz.json")

    def test_chaque_cas(self):
        for cas in self.fixture["cas"]:
            with self.subTest(ligne1=cas["ligne1"], preuve=cas["preuve"]):
                mapping = map_docie_cni_to_analysis(_enveloppe({
                    "surname": "SPECIMEN",
                    "mrz_line1": cas["ligne1"],
                    "mrz_line2": cas["ligne2"],
                }))
                a = mapping.analysis
                for nom, statut in cas["statuts"].items():
                    self.assertEqual(statut, a["controleMrz"][nom]["statut"], nom)
                self.assertEqual([m["message"] for m in cas["messages"]], a["issues"])
                self.assertEqual([f"{m['champ']}: {m['message']}" for m in cas["messages"]], mapping.warnings)
                # Lignes lues CONSERVEES.
                for nom, cle in (("ligne1", "mrzLigne1"), ("ligne2", "mrzLigne2")):
                    self.assertEqual("" if cas[nom] is None else str(cas[nom]), a[cle], nom)
                # Une MRZ douteuse ne rend la carte ni illisible ni invalide.
                self.assertEqual(DOCUMENT_TYPE_LABEL, a["documentType"])
                self.assertIs(True, a["isValid"])


if __name__ == "__main__":
    unittest.main()
