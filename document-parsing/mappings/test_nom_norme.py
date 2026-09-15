"""Regle de normalisation des noms : les deux portages retirent TOUTE marque
de categorie Unicode M (#179 B7).

Ce fichier est separe de test_kbis_to_contrats.py a dessein : celui-ci verifie
le mapping Kbis, celui-la la regle de nom, qui sert aussi aux mappings RIB et
URSSAF (`checkName` y est importe de contrats/lib/docanalyze.js). Les cas
partages vivent dans document-parsing/fixtures/nom_docie.json et sont deja
executes par les deux portages ; ce qui suit fige la REGLE elle-meme, du cote
Python, avec la mesure qui l'a justifiee.

Le portage JS correspondant est contrats/tests/kbis-mapping.test.js.
"""
import json
from pathlib import Path
import sys
import unicodedata
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kbis_to_contrats import _check_name, _norm  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "nom_docie.json"
NOM = json.loads(FIXTURE.read_text(encoding="utf-8"))

# Marques hors du bloc U+0300-U+036F, celles que l'ancien JS coupait.
MARQUES_HORS_BLOC = ("⃐", "҃", "᪰", "︠", "ٓ")
# Marques de classe combinante NULLE, celles que l'ancien Python coupait :
# espacante (Mc), englobante (Me), et une non espacante de classe nulle (Mn).
MARQUES_CLASSE_NULLE = ("ः", "⃝", "ั")


class RegleNomTests(unittest.TestCase):
    def test_toute_marque_de_categorie_m_est_retiree_au_milieu_d_un_token(self):
        """Une marque au milieu d'un token ne doit JAMAIS couper le token.

        Coupe, le token disparait du texte normalise, `_check_name` ne le
        retrouve plus et rend False -- le verdict BLOQUANT (« ce n'est PAS le
        sous-traitant saisi »). Couper ne peut donc que fabriquer un desaccord,
        jamais en manquer un : c'est ce sens unique qui a justifie la
        correction, pas une preuve qu'un document reel porte une telle marque.
        """
        for marque in MARQUES_HORS_BLOC + MARQUES_CLASSE_NULLE + ("́",):
            with self.subTest(marque="U+%04X" % ord(marque), categorie=unicodedata.category(marque)):
                self.assertEqual("ABC", _norm("AB" + marque + "C"))
                self.assertIs(True, _check_name("AB" + marque + "C", "ABC"))

    def test_la_regle_est_la_categorie_pas_la_classe_combinante(self):
        """Mc et Me ont une classe combinante NULLE.

        `unicodedata.combining()` les manquait, donc l'ancien Python les
        coupait lui aussi : s'aligner sur lui aurait deplace l'ecart au lieu de
        le fermer. Ce test echouerait si quelqu'un revenait a combining().
        """
        for marque in MARQUES_CLASSE_NULLE:
            with self.subTest(marque="U+%04X" % ord(marque)):
                self.assertEqual(0, unicodedata.combining(marque), "ce temoin suppose une classe nulle")
                self.assertTrue(unicodedata.category(marque).startswith("M"))
                self.assertEqual("ABC", _norm("AB" + marque + "C"))

    def test_une_marque_ne_coupe_pas_davantage_un_nom_a_plusieurs_tokens(self):
        self.assertEqual("ACME TECH", _norm("AC⃐ME TECH"))
        self.assertIs(True, _check_name("AC⃐ME TECH", "ACME TECH"))

    def test_les_cas_partages_passent_tous_par_cette_regle(self):
        """Le jeu d'essai partage, execute ici comme cote JS.

        Redondant avec test_kbis_to_contrats.py par construction : c'est le but
        d'un jeu d'essai partage, et cela garde ce fichier autoportant si le
        mapping Kbis bouge.
        """
        for cas in NOM["cas"]:
            with self.subTest(attendu=cas["nom_attendu"], candidat=cas["candidat"], preuve=cas["preuve"]):
                self.assertIs(cas["resultat"], _check_name(cas["candidat"], cas["nom_attendu"]))

    def test_les_accents_francais_restent_le_cas_courant(self):
        for texte, attendu in (("ÉLECTRICITÉ", "ELECTRICITE"), ("CŒUR DEFENSE", "COEUR DEFENSE"),
                               ("Æ GROUPE", "AE GROUPE"), ("MÜLLER STRAßE", "MULLER STRASSE")):
            with self.subTest(texte=texte):
                self.assertEqual(attendu, _norm(texte))


if __name__ == "__main__":
    unittest.main()
