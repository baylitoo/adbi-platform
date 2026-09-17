"""Parité des listes d'extensions cv-parser <-> allowlist MIME du pont (#241).

Le défaut que ces tests épinglent n'est pas `.webp` en particulier : c'est qu'il
existe DEUX miroirs d'une liste dont l'autorité vit ailleurs, et que rien ne
comparait les trois.

    document-parsing/bridge/docie_bridge.py::MIME_TYPES   <- autorité
    cv-parser/docie_bridge_extraction.py::_MIME_BY_SUFFIX <- miroir 1 (types)
    cv-parser/choix_modele.py::_EXT_BRIDGE                <- miroir 2 (extensions)

#180 a retiré `image/webp` de l'autorité (DocIE le refuse). Les deux miroirs
n'ont pas suivi, et AUCUN test ne mentionnait webp côté cv-parser : la
désynchronisation est restée invisible jusqu'à #241. `voie_pour(".webp")`
annonçait alors la voie « agent » pour un format que le pont rejette.

Ces tests lisent l'allowlist RÉELLE du pont — jamais une copie écrite ici. Une
liste recopiée dans le test passerait au vert pendant que le pont change, ce
qui est exactement la panne qu'on veut rendre impossible.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "document-parsing" / "bridge"))

import choix_modele
import docie_bridge as pont
import docie_bridge_extraction as extraction


class PariteExtensions(unittest.TestCase):
    def test_les_types_declares_sont_acceptes_par_le_pont(self):
        """Tout type de _MIME_BY_SUFFIX doit être dans l'allowlist du pont.

        Un type déclaré ici mais absent là-bas route le fichier vers une voie
        qui le refusera — échec tardif, après que l'utilisateur a déposé.
        """
        declares = set(extraction._MIME_BY_SUFFIX.values())
        autorises = set(pont.MIME_TYPES)
        surplus = declares - autorises
        self.assertEqual(
            surplus, set(),
            "types déclarés par cv-parser mais refusés par le pont : "
            + repr(sorted(surplus))
            + " — le pont fait autorité (docie_bridge.py::MIME_TYPES)",
        )

    def test_les_deux_miroirs_cv_parser_saccordent(self):
        """_EXT_BRIDGE doit lister exactement les clés de _MIME_BY_SUFFIX.

        Le commentaire de _EXT_BRIDGE le présente comme un miroir ; sans
        assertion, « miroir » est une intention, pas une propriété.
        """
        self.assertEqual(
            set(choix_modele._EXT_BRIDGE), set(extraction._MIME_BY_SUFFIX),
            "les deux listes cv-parser ont divergé",
        )

    def test_webp_absent_des_deux_listes(self):
        """Régression #241, épinglée nommément.

        Les deux tests ci-dessus couvrent le cas général ; celui-ci nomme le
        format qui a réellement dérivé, pour qu'un futur « remettons webp »
        échoue avec le bon message plutôt qu'avec « surplus : ['image/webp'] ».
        Le remettre exige d'abord que DocIE l'accepte — question ouverte de #181.
        """
        self.assertNotIn(".webp", extraction._MIME_BY_SUFFIX)
        self.assertNotIn(".webp", choix_modele._EXT_BRIDGE)
        self.assertNotIn("image/webp", set(pont.MIME_TYPES))

    def test_aucune_voie_annoncee_pour_un_format_sans_issue(self):
        """voie_pour() ne doit pas annoncer « agent » pour un format refusé.

        C'est la conséquence visible du miroir désynchronisé : le sélecteur de
        modèles proposait une voie pour un format qui ne pouvait pas aboutir.
        On vérifie sur chaque extension refusée par le pont, pas seulement webp.
        """
        for ext in (".webp", ".gif", ".tiff", ".bmp"):
            with self.subTest(ext=ext):
                self.assertNotEqual(
                    choix_modele.voie_pour(ext), "agent",
                    ext + " : voie « agent » annoncée pour un format que le pont refuse",
                )


if __name__ == "__main__":
    unittest.main()
