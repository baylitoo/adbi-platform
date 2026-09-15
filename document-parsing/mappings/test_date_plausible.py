#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de date_plausible.py -- plausibilite des dates lues par DocIE (#194).

Tous les cas viennent de document-parsing/fixtures/date_plausible.json, que le
portage JS (contrats/tests/date-plausible.test.js) execute lui aussi, messages
exacts compris. Les deux mappings fiscale executent en plus chaque cas de bout
en bout dans leurs propres tests.

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
import kbis_to_contrats  # noqa: E402
from date_plausible import (  # noqa: E402
    FUTURE,
    IMPOSSIBLE,
    INCOHERENTE,
    NON_RECONNUE,
    PLAUSIBLE,
    STATUTS,
    controler_dates,
    date_du_jour,
    messages_dates,
)

REPO_ROOT = Path(__file__).parent.parent.parent
FIXTURE = REPO_ROOT / "document-parsing" / "fixtures" / "date_plausible.json"
DATE_DOCIE = REPO_ROOT / "document-parsing" / "fixtures" / "date_docie.json"


def _charger(chemin: Path) -> dict:
    with open(chemin, encoding="utf-8") as fh:
        return json.load(fh)


class TestDatePlausiblePartage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = _charger(FIXTURE)

    def _controler(self, cas):
        f = self.fixture
        return controler_dates(
            cas["valeurs"],
            ordre=[tuple(p) for p in f["ordre"]],
            futur_admis=f["futur_admis"],
            aujourdhui=cas.get("aujourdhui", f["aujourdhui"]),
        )

    def test_statuts_et_port_declares_dans_la_fixture(self):
        self.assertEqual(self.fixture["statuts"], list(STATUTS))
        self.assertIn("document-parsing/mappings/date_plausible.py (Python, controle)", self.fixture["_ports"])

    def test_tous_les_cas_du_jeu_dessai(self):
        f = self.fixture
        for cas in f["cas"]:
            with self.subTest(valeurs=cas["valeurs"], preuve=cas["preuve"]):
                controle = self._controler(cas)
                self.assertEqual(list(cas["valeurs"]), list(controle))
                for champ, brut in cas["valeurs"].items():
                    self.assertEqual(cas["statuts"][champ], controle[champ]["statut"], champ)
                    self.assertEqual(cas["dates"][champ], controle[champ]["date"], champ)
                    # Valeur lue CONSERVEE, jamais modifiee.
                    self.assertEqual("" if brut is None else str(brut), controle[champ]["valeur"], champ)
                messages = messages_dates(controle, f["libelles"], ordre=[tuple(p) for p in f["ordre"]])
                self.assertEqual(cas["messages"], messages)

    def test_chaque_statut_est_exerce_par_la_fixture(self):
        vus = {s for cas in self.fixture["cas"] for s in cas["statuts"].values()}
        self.assertEqual(set(STATUTS), vus)

    def test_la_date_du_jour_est_bien_lue(self):
        # Les deux cas « 2026-12-01 » ne different que par `aujourdhui`.
        jumeaux = [c for c in self.fixture["cas"] if c["valeurs"]["issued_date"] == "2026-12-01"]
        self.assertEqual(2, len(jumeaux))
        self.assertEqual({FUTURE, PLAUSIBLE}, {self._controler(c)["issued_date"]["statut"] for c in jumeaux})

    def test_les_pannes_ne_s_annoncent_pas_pareil(self):
        libelles = {NON_RECONNUE: "date illisible", IMPOSSIBLE: "date impossible", FUTURE: "dans le futur",
                    INCOHERENTE: "Dates incohérentes"}
        noms = {"a": "date a", "b": "date b"}
        exemples = {
            NON_RECONNUE: {"a": "mars 2026", "b": None},
            IMPOSSIBLE: {"a": "12/05/1949", "b": None},
            FUTURE: {"a": "2026-09-16", "b": None},
            INCOHERENTE: {"a": "2026-03-10", "b": "2026-03-04"},
        }
        for statut, valeurs in exemples.items():
            with self.subTest(statut=statut):
                controle = controler_dates(valeurs, ordre=[("a", "b")], aujourdhui="2026-09-15")
                messages = messages_dates(controle, noms, ordre=[("a", "b")])
                self.assertEqual(1, len(messages))
                for autre, texte in libelles.items():
                    self.assertEqual(autre == statut, texte in messages[0]["message"])

    def test_futur_admis_pour_une_fin_de_validite(self):
        controle = controler_dates({"valid_until": "2027-03-04"}, futur_admis=["valid_until"], aujourdhui="2026-09-15")
        self.assertEqual(PLAUSIBLE, controle["valid_until"]["statut"])
        controle = controler_dates({"valid_until": "2027-03-04"}, aujourdhui="2026-09-15")
        self.assertEqual(FUTURE, controle["valid_until"]["statut"])

    def test_fin_avant_debut_d_une_periode(self):
        # Paire (debut, fin) : une periode qui se termine avant de commencer.
        controle = controler_dates({"debut": "2026-06-01", "fin": "2026-01-01"}, ordre=[("debut", "fin")],
                                   futur_admis=["fin"], aujourdhui="2026-09-15")
        self.assertEqual({INCOHERENTE}, {e["statut"] for e in controle.values()})

    def test_date_du_jour_par_defaut_et_refus_d_une_date_du_jour_mal_formee(self):
        self.assertRegex(date_du_jour(), r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
        # 2100-12-31 est dans la fenetre et future jusqu'a la fin du siecle.
        self.assertEqual(FUTURE, controler_dates({"d": "2100-12-31"})["d"]["statut"])
        for mauvais in ("15/09/2026", "2026-9-15", "", 20260915):
            with self.subTest(aujourdhui=mauvais), self.assertRaises(ValueError):
                controler_dates({"d": "2026-01-01"}, aujourdhui=mauvais)


class TestNormaliseurEtFenetreImportesPasRecopies(unittest.TestCase):
    """Aucune seconde fenetre d'annees, aucun cinquieme normaliseur (#179)."""

    def test_identite_d_objet(self):
        self.assertIs(date_plausible._normalize_date, kbis_to_contrats._normalize_date)
        self.assertEqual(_charger(DATE_DOCIE)["annee_min"], date_plausible.ANNEE_MIN)
        self.assertEqual(_charger(DATE_DOCIE)["annee_max"], date_plausible.ANNEE_MAX)

    def test_lecture_du_source(self):
        source = (Path(__file__).parent / "date_plausible.py").read_text(encoding="utf-8")
        self.assertRegex(source, r"(?m)^from kbis_to_contrats import ANNEE_MAX, ANNEE_MIN, _normalize_date$")
        self.assertIsNone(
            re.search(r"^\s*def\s+(_normalize_date|_date_existe|_est_bissextile|_forme_ecrite)\b"
                      r"|^\s*(_normalize_date|ANNEE_MIN|ANNEE_MAX|_JOURS_PAR_MOIS|MOIS|_FR_DATE_RE|_ISO_DATE_RE)\s*=",
                      source, re.M),
            "date_plausible.py ne doit PAS redefinir le normaliseur ni la fenetre",
        )
        # Pas de borne d'annee ecrite en dur dans le code (les commentaires la citent).
        code = "\n".join(l for l in source.splitlines() if not l.lstrip().startswith("#"))
        code = re.sub(r'"""[\s\S]*?"""', "", code)
        self.assertIsNone(re.search(r"\b(1950|2100)\b", code))

    def test_temoin(self):
        # Une copie renommee du normaliseur passerait les deux tests ci-dessus ;
        # elle ne rendrait pas ce temoin.
        def temoin(brut, champ, avertissements):
            avertissements.append(champ + ": date impossible (TEMOIN)")
            return ""

        with mock.patch.object(date_plausible, "_normalize_date", side_effect=temoin) as espion:
            controle = controler_dates({"d": "2026-01-01"}, aujourdhui="2026-09-15")
        espion.assert_called_once()
        self.assertEqual(IMPOSSIBLE, controle["d"]["statut"])

    def test_ce_module_n_est_pas_liste_comme_un_portage_du_normaliseur(self):
        ports = _charger(DATE_DOCIE)["_ports"]
        self.assertEqual(4, len(ports))
        self.assertFalse(any("plausible" in p for p in ports))

    def test_la_fixture_n_est_chargee_par_aucun_module_python_de_production(self):
        for module in Path(__file__).parent.glob("*.py"):
            if module.name.startswith("test_"):
                continue
            with self.subTest(module=module.name):
                self.assertIsNone(re.search(r"[\"'][^\"'\n]*date_plausible\.json[\"']", module.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
