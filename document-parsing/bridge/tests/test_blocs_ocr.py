"""Portage jumeau de blocs-ocr.test.js : même jeu d'essai, mêmes attentes."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blocs_ocr import blocs_depuis_pages, blocs_depuis_lignes
from docie_bridge import valider_blocs_ocr, DOCIE_BLOCS_TEXTE_MAX, DocIEBridgeError

# Jeu d'essai partagé avec blocs-ocr.test.js, lu par les TESTS seulement.
FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
PAQUETS = json.loads((FIXTURES / "paquets_blocs_ocr.json").read_text(encoding="utf-8"))


def identifiant_attendu(page, index, texte):
    """La règle d'identifiant, recalculée ici : le jeu d'essai ne fige aucune
    empreinte, donc une divergence de portage casse un test."""
    graine = "{}:{}:{}".format(page, index, texte).encode("utf-8")
    return "b{}_{}_{}".format(page, index, hashlib.sha256(graine).hexdigest()[:12])


class PaquetsTests(unittest.TestCase):
    def test_shared_fixture_expected_blocks_and_refusals(self):
        for case in PAQUETS["cas"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                if case.get("erreur"):
                    with self.assertRaises(DocIEBridgeError) as raised:
                        blocs_depuis_pages(case["pages"], max_blocs=case["max"])
                    self.assertEqual(raised.exception.code, "input")
                    continue
                blocs, resume = blocs_depuis_pages(case["pages"], max_blocs=case["max"])
                self.assertIs(resume["groupees"], case["groupees"])
                if case.get("blocs_attendus") is not None:
                    self.assertEqual([(b["page"], b["text"]) for b in blocs],
                                     [(b["page"], b["text"]) for b in case["blocs_attendus"]])
                    for bloc, attendu in zip(blocs, case["blocs_attendus"]):
                        self.assertEqual(bloc["id"], identifiant_attendu(attendu["page"], attendu["index"], attendu["text"]))
                if case.get("blocs_max_attendus") is not None:
                    self.assertLessEqual(len(blocs), case["blocs_max_attendus"])
                if case.get("texte_concatene") is not None:
                    # L'ordre de lecture est conservé mot pour mot.
                    self.assertEqual("\n".join(b["text"] for b in blocs), case["texte_concatene"])
                # Ce module n'a pas le droit de produire ce que le pont refuse.
                valider_blocs_ocr(blocs)

    def test_volume_cases_grouping_only_past_the_cap(self):
        for case in PAQUETS["cas_volume"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                par_page = -(-case["lignes"] // case["pages"])
                pages, restant = [], case["lignes"]
                for p in range(case["pages"]):
                    combien = par_page if p < case["pages"] - 1 else restant
                    debut = p * par_page
                    pages.append({"page": p + 1,
                                  "lignes": ["ligne " + str(debut + i) + " du document" for i in range(combien)]})
                    restant -= combien
                blocs, resume = blocs_depuis_pages(pages, max_blocs=case["max"])
                self.assertEqual(resume["lignes"], case["lignes"])
                self.assertIs(resume["groupees"], case["groupees"])
                self.assertLessEqual(len(blocs), case["max"])
                pages_vues = [b["page"] for b in blocs]
                self.assertEqual(pages_vues, sorted(pages_vues))
                toutes = [ligne for page in pages for ligne in page["lignes"]]
                self.assertEqual("\n".join(b["text"] for b in blocs), "\n".join(toutes))

    def test_without_pagination_blocks_land_on_the_named_page(self):
        lignes = ["Alice Dupont", "Développeuse Python", "Paris"]
        blocs, resume = blocs_depuis_lignes(lignes)
        self.assertEqual([b["text"] for b in blocs], lignes)
        self.assertEqual({b["page"] for b in blocs}, {1})
        self.assertIs(resume["groupees"], False)
        page7, _ = blocs_depuis_lignes(lignes, page=7)
        self.assertEqual({b["page"] for b in page7}, {7})
        self.assertNotEqual(blocs[0]["id"], page7[0]["id"])

    def test_identifiers_deterministic_per_page_and_cap_validated(self):
        pages = [{"page": 1, "lignes": ["a", "b"]}, {"page": 2, "lignes": ["a"]}]
        premier, _ = blocs_depuis_pages(pages)
        second, _ = blocs_depuis_pages(pages)
        # Le même document réimporté donne les mêmes ids.
        self.assertEqual([b["id"] for b in premier], [b["id"] for b in second])
        # Même texte, même index, page différente : id différent.
        self.assertNotEqual(premier[0]["id"], premier[2]["id"])
        for maximum in (0, -1, DOCIE_BLOCS_TEXTE_MAX + 1, "800", True, 1.5):
            with self.subTest(max=maximum), self.assertRaises(DocIEBridgeError):
                blocs_depuis_pages(pages, max_blocs=maximum)

    def test_single_line_beyond_the_block_cap_is_refused_never_split(self):
        # La decouper inventerait une frontiere que le document n'a pas.
        with self.assertRaises(DocIEBridgeError) as raised:
            blocs_depuis_lignes(["x" * 20001])
        self.assertEqual(raised.exception.code, "input")


if __name__ == "__main__":
    unittest.main()
