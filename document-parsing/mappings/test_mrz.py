#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de mrz.py -- chiffres de controle de la MRZ d'une piece d'identite.

Tous les cas viennent de document-parsing/fixtures/mrz.json, que le portage JS
(contrats/tests/mrz.test.js) execute lui aussi, messages exacts compris : une
divergence entre langages redevient un echec de test (discipline de #179). Les
deux mappings CNI executent en plus chaque cas de bout en bout dans leurs
propres tests.

Lancer : python -m unittest discover -s document-parsing/mappings
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from mrz import (  # noqa: E402
    ABSENT,
    CLE_INVALIDE,
    FORMAT_INVALIDE,
    LONGUEUR_LIGNE,
    MOTIF_SEPARATEURS,
    NON_CONTROLE,
    POIDS,
    STATUTS,
    VALIDE,
    chiffre_controle,
    controler_mrz,
    messages_mrz,
    valeur_caractere,
)

REPO_ROOT = Path(__file__).parent.parent.parent
FIXTURE = REPO_ROOT / "document-parsing" / "fixtures" / "mrz.json"
# Alphabet d'une MRZ : le remplissage, les chiffres et les lettres.
ALPHABET = "<0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
CHIFFRES = ("numero_document", "date_naissance", "date_expiration", "composite")


class TestMrzPartage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as fh:
            cls.fixture = json.load(fh)

    def test_constantes_identiques_a_la_fixture(self):
        self.assertEqual(self.fixture["motif_separateurs"], MOTIF_SEPARATEURS)
        self.assertEqual(self.fixture["longueur_ligne"], LONGUEUR_LIGNE)
        self.assertEqual(self.fixture["poids"], list(POIDS))
        self.assertEqual(self.fixture["statuts"], list(STATUTS))
        self.assertIn("document-parsing/mappings/mrz.py (Python, controle)", self.fixture["_ports"])

    def test_chaque_cas_a_une_preuve(self):
        for cas in self.fixture["cas"]:
            with self.subTest(ligne1=cas["ligne1"]):
                self.assertTrue(cas["preuve"].strip())

    def test_tous_les_cas_du_jeu_dessai(self):
        for cas in self.fixture["cas"]:
            with self.subTest(ligne1=cas["ligne1"], ligne2=cas["ligne2"], preuve=cas["preuve"]):
                controle = controler_mrz(cas["ligne1"], cas["ligne2"])
                for nom in ("ligne1", "ligne2"):
                    self.assertEqual(cas["statuts"][nom], controle[nom]["statut"], nom)
                    self.assertEqual(cas["compacts"][nom], controle[nom]["compact"], nom)
                    # Valeur lue CONSERVEE, jamais modifiee.
                    attendue = "" if cas[nom] is None else str(cas[nom])
                    if isinstance(cas[nom], float) and cas[nom].is_integer():
                        attendue = str(int(cas[nom]))  # meme rendu qu'en JS (#179 A14)
                    self.assertEqual(attendue, controle[nom]["valeur"], nom)
                for nom in CHIFFRES:
                    self.assertEqual(cas["statuts"][nom], controle[nom]["statut"], nom)
                    self.assertEqual(cas["valeurs"][nom], controle[nom]["valeur"], nom)
                    self.assertEqual(cas["cles"][nom], [controle[nom]["cle_lue"], controle[nom]["cle_calculee"]], nom)
                self.assertEqual(cas["messages"], messages_mrz(controle))

    def test_chaque_statut_est_exerce_par_la_fixture(self):
        vus = {statut for cas in self.fixture["cas"] for statut in cas["statuts"].values()}
        self.assertEqual(set(STATUTS), vus)

    def test_l_arithmetique_du_chiffre_est_refaite_a_la_main(self):
        """Le cas qui porte `arithmetique` fige le calcul lui-meme : poids
        7-3-1 et table A=10..Z=35. Recalcule ici SANS chiffre_controle(), donc
        sans dependre des tranches citees de memoire (voir `_composite`)."""
        cas = [c for c in self.fixture["cas"] if "arithmetique" in c]
        self.assertEqual(1, len(cas))
        a = cas[0]["arithmetique"]
        produits = [valeur_caractere(car) * POIDS[i % 3] for i, car in enumerate(a["chaine"])]
        self.assertEqual(a["produits"], produits)
        self.assertEqual(a["somme"], sum(produits))
        self.assertEqual(a["chiffre"], str(sum(produits) % 10))
        # Et le code rend bien le meme chiffre.
        self.assertEqual(a["chiffre"], chiffre_controle(a["chaine"]))
        # Ce chiffre est bien celui imprime sur la ligne 1 du specimen.
        tranche = self.fixture["tranches"]["numero_document"]
        self.assertEqual(a["chiffre"], cas[0]["compacts"]["ligne1"][tranche["chiffre"]])
        self.assertEqual(a["chaine"], cas[0]["compacts"]["ligne1"][tranche["debut"]:tranche["fin"]])

    def test_table_des_valeurs(self):
        self.assertEqual(0, valeur_caractere("<"))
        self.assertEqual(0, valeur_caractere("0"))
        self.assertEqual(9, valeur_caractere("9"))
        self.assertEqual(10, valeur_caractere("A"))
        self.assertEqual(35, valeur_caractere("Z"))

    def test_les_pannes_ne_s_annoncent_pas_pareil(self):
        specimen = self._specimen()
        libelles = {
            FORMAT_INVALIDE: "format invalide",
            "numero": "Numéro de document",
            "composite": "composite",
        }
        exemples = {
            FORMAT_INVALIDE: (specimen["ligne1"][:-1], specimen["ligne2"]),
            "numero": (specimen["ligne1"].replace("SPECIMEN1", "SPECIMEM1"), specimen["ligne2"]),
            "composite": (specimen["ligne1"], specimen["ligne2"][:-1] + "7"),
        }
        for panne, (l1, l2) in exemples.items():
            with self.subTest(panne=panne):
                messages = messages_mrz(controler_mrz(l1, l2))
                # Le numero mal lu fait AUSSI echouer le composite : on ne
                # compte donc pas les messages, on verifie que le PREMIER nomme
                # bien la panne, et elle seule.
                premier = messages[0]["message"]
                for autre, texte in libelles.items():
                    self.assertEqual(autre == panne, texte in premier, f"{panne} / {texte}")

    def _specimen(self) -> dict:
        cas = self.fixture["cas"][0]
        return {"ligne1": cas["ligne1"], "ligne2": cas["ligne2"]}

    def test_un_non_controle_ne_produit_aucun_message_de_plus(self):
        # Ligne 1 mal formee : un seul message (celui de la ligne), pas quatre.
        specimen = self._specimen()
        controle = controler_mrz(specimen["ligne1"][:-1], specimen["ligne2"])
        self.assertEqual(NON_CONTROLE, controle["numero_document"]["statut"])
        self.assertEqual(NON_CONTROLE, controle["composite"]["statut"])
        self.assertEqual(1, len(messages_mrz(controle)))
        # Rien du tout quand il n'y a rien a lire.
        controle_vide = controler_mrz(None, None)
        self.assertEqual([ABSENT] * 4, [controle_vide[nom]["statut"] for nom in CHIFFRES])
        self.assertEqual([], messages_mrz(controle_vide))

    def test_couverture_mesuree_sur_le_specimen(self):
        """La promesse du controle, MESUREE et non supposee, et ses limites
        figees : voir `_couverture` dans la fixture. Une cle modulo 10 ne peut
        pas refuser toute substitution d'un caractere, a la difference du
        modulo 97 de l'IBAN -- ce test dit exactement ce qui passe."""
        specimen = self._specimen()
        lignes = [specimen["ligne1"], specimen["ligne2"]]
        total = attrapees = 0
        jamais: dict[int, list[int]] = {0: [], 1: []}
        manquees_en_tranche: list[int] = []
        couvertes = (
            set(range(5, 30)),
            set(range(0, 7)) | set(range(8, 15)) | set(range(18, 30)),
        )
        for numero, ligne in enumerate(lignes):
            for position, caractere in enumerate(ligne):
                refusees = candidates = 0
                for autre in ALPHABET:
                    if autre == caractere:
                        continue
                    candidates += 1
                    faux = ligne[:position] + autre + ligne[position + 1:]
                    entrees = [faux, lignes[1]] if numero == 0 else [lignes[0], faux]
                    controle = controler_mrz(*entrees)
                    if any(controle[nom]["statut"] != VALIDE for nom in CHIFFRES):
                        refusees += 1
                    elif position in couvertes[numero]:
                        # Manquee dans une tranche controlee : l'ecart de
                        # valeur DOIT etre un multiple de 10.
                        ecart = valeur_caractere(autre) - valeur_caractere(caractere)
                        self.assertEqual(0, ecart % 10, f"ligne {numero + 1}, position {position}, {caractere}->{autre}")
                        manquees_en_tranche.append(position)
                total += candidates
                attrapees += refusees
                if refusees == 0:
                    jamais[numero].append(position)
        self.assertEqual(2160, total)
        self.assertEqual(1667, attrapees)
        self.assertEqual(169, len(manquees_en_tranche))
        # Positions qu'AUCUN chiffre ne couvre : code document + code Etat sur
        # la ligne 1 ; sexe et nationalite sur la ligne 2.
        self.assertEqual([0, 1, 2, 3, 4], jamais[0])
        self.assertEqual([7, 15, 16, 17], jamais[1])
        # Et la mesure est bien celle que la fixture annonce.
        couverture = self.fixture["_couverture"]
        for nombre in ("2160", "1667", "493", "169"):
            self.assertIn(nombre, couverture)
        self.assertEqual(493, total - attrapees)

    def test_la_valeur_lue_n_est_jamais_modifiee(self):
        specimen = self._specimen()
        brut = "  " + specimen["ligne1"].lower() + "\n"
        controle = controler_mrz(brut, None)
        self.assertEqual(brut, controle["ligne1"]["valeur"])
        self.assertEqual(specimen["ligne1"], controle["ligne1"]["compact"])
        self.assertEqual(VALIDE, controle["ligne1"]["statut"])

    def test_les_tranches_du_code_sont_celles_de_la_fixture(self):
        """Les tranches vivent dans le code ; la fixture les redit pour qu'un
        lecteur puisse les confronter a ICAO 9303 sans lire le code. Ce test
        verifie qu'elles ne divergent pas -- en recalculant les valeurs
        controlees depuis les tranches de la FIXTURE."""
        cas = self.fixture["cas"][0]
        compacts = {1: cas["compacts"]["ligne1"], 2: cas["compacts"]["ligne2"]}
        tranches = self.fixture["tranches"]
        for nom in ("numero_document", "date_naissance", "date_expiration"):
            t = tranches[nom]
            self.assertEqual(cas["valeurs"][nom], compacts[t["ligne"]][t["debut"]:t["fin"]], nom)
            self.assertEqual(cas["cles"][nom][0], compacts[t["ligne"]][t["chiffre"]], nom)
        composite = tranches["composite"]
        assemble = "".join(compacts[ligne][debut:fin] for ligne, debut, fin in composite["morceaux"])
        self.assertEqual(cas["valeurs"]["composite"], assemble)
        self.assertEqual(cas["cles"]["composite"][0], compacts[2][composite["chiffre"]])

    def test_la_fixture_n_est_chargee_par_aucun_module_python_de_production(self):
        for module in Path(__file__).parent.glob("*.py"):
            if module.name.startswith("test_"):
                continue
            with self.subTest(module=module.name):
                self.assertIsNone(re.search(r"[\"'][^\"'\n]*mrz\.json[\"']", module.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
