"""Toutes les fixtures d'enveloppe DocIE portent la MÊME forme, figée (#249).

Le problème que ce test résout n'est pas « il manque `queue_wait_ms` » — c'est
que rien dans ce dépôt ne peut dire que l'enveloppe DocIE a bougé. Les
générateurs (`generate_*_sample.py`) construisent les fixtures DEPUIS les vrais
modèles pydantic de DocIE : ils ne peuvent donc produire QUE la forme du commit
épinglé. Une dérive est invisible par construction, et celle-ci s'est vue par
hasard, en régénérant pour une autre raison.

Ce que ce test attrape, concrètement :

  - une régénération PARTIELLE (3 fixtures sur 18 rafraîchies) — les formes
    divergent, rouge immédiat ;
  - un champ ajouté ou retiré par DocIE et répercuté sans mettre à jour la
    règle partagée ;
  - une fixture écrite à la main qui n'aurait pas la forme d'une vraie réponse.

Ce qu'il ne décide PAS : à quel commit DocIE ce dépôt s'aligne. C'est la
question ouverte de #249, et elle revient au propriétaire. Ce test fige l'état
actuel et le rend vérifiable, rien de plus.

Règle partagée : document-parsing/fixtures/enveloppe_docie.json. Elle n'est
jamais recopiée ici — une liste écrite en dur dans le test passerait au vert
pendant que les fixtures changent, ce qui est précisément la panne visée.
"""
import json
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
REGLE = RACINE / "fixtures" / "enveloppe_docie.json"

# Une enveloppe se reconnaît à sa structure, pas à son nom de fichier ni à la
# présence d'un mot. Détecter par `grep "validation"` ramasse les fixtures de
# RÈGLES qui contiennent ce mot dans leur prose — erreur commise en mesurant
# #249, corrigée ici en exigeant le noyau au complet.
NOYAU = {"request_id", "schema_name", "result", "validation", "latency_ms"}

# `scripts/` est ignoré : des captures d'essai non suivies par git y atterrissent
# (a.json, 5,9 ko, une extraction `adbi_resume` complète). Les compter ferait
# diverger le résultat local du résultat CI, où elles n'existent pas.
IGNORES = {"scripts", "node_modules", "__pycache__"}


def charger(chemin):
    """JSON tolérant au BOM : certains fixtures sont en UTF-8 avec signature."""
    return json.loads(chemin.read_bytes().decode("utf-8-sig"))


def enveloppes():
    """(chemin, clés DocIE) de chaque fixture d'enveloppe, annotations exclues."""
    trouvees = []
    for chemin in sorted(RACINE.rglob("*.json")):
        if IGNORES & set(chemin.parts):
            continue
        try:
            donnees = charger(chemin)
        except (ValueError, OSError):
            continue
        if isinstance(donnees, dict) and NOYAU <= set(donnees):
            # Les clés « _ » sont les nôtres (cf. `_annotations_locales`), pas
            # celles de DocIE : les exiger reviendrait à réclamer au serveur des
            # champs que nous avons inventés.
            trouvees.append((chemin, {c for c in donnees if not c.startswith("_")}))
    return trouvees


class EnveloppeDocie(unittest.TestCase):
    def setUp(self):
        self.regle = charger(REGLE)
        self.attendues = set(self.regle["cles_enveloppe"])
        self.fixtures = enveloppes()

    def test_la_regle_et_les_fixtures_sont_lisibles(self):
        """Sentinelle : sans elle, un chemin cassé viderait la liste et rendrait
        tous les tests suivants verts en ne mesurant rien — le défaut même que
        #249 décrit."""
        self.assertGreaterEqual(len(self.attendues), 10, "règle partagée illisible ou vide")
        self.assertGreaterEqual(
            len(self.fixtures), 18,
            f"seulement {len(self.fixtures)} enveloppes trouvées : "
            "chemin de recherche cassé, ou des fixtures ont disparu",
        )

    def test_toutes_les_enveloppes_ont_la_meme_forme(self):
        """Une régénération partielle laisse deux formes en présence."""
        formes = {}
        for chemin, cles in self.fixtures:
            formes.setdefault(tuple(sorted(cles)), []).append(chemin.name)
        self.assertEqual(
            len(formes), 1,
            "plusieurs formes d'enveloppe coexistent (régénération partielle ?) : "
            + "; ".join(f"{len(n)} fixture(s) à {len(f)} clés" for f, n in formes.items()),
        )

    def test_la_forme_est_celle_de_la_regle_partagee(self):
        for chemin, cles in self.fixtures:
            with self.subTest(fixture=chemin.name):
                manquantes = sorted(self.attendues - cles)
                surplus = sorted(cles - self.attendues)
                self.assertEqual(
                    (manquantes, surplus), ([], []),
                    f"{chemin.name} s'écarte de enveloppe_docie.json — "
                    f"absentes : {manquantes} ; en trop : {surplus}",
                )

    def test_les_champs_absents_sont_nommes_et_documentes(self):
        """Le retard doit rester EXPLICITE, pas devenir un oubli silencieux.

        Si un champ connu comme manquant apparaît dans les fixtures, c'est
        qu'elles ont été régénérées : la règle doit alors être mise à jour, et
        ce test le dit plutôt que de passer.
        """
        connus = self.regle.get("champs_absents_connus") or {}
        self.assertTrue(connus, "aucun champ absent documenté : règle incomplète")
        for champ, raison in connus.items():
            with self.subTest(champ=champ):
                self.assertNotIn(champ, self.attendues,
                                 f"{champ} est à la fois attendu et déclaré absent")
                self.assertGreater(len(raison), 40,
                                   f"{champ} : la raison doit dire d'où vient le retard")
                porteuses = [c.name for c, cles in self.fixtures if champ in cles]
                self.assertEqual(
                    porteuses, [],
                    f"{champ} est déclaré absent mais présent dans {porteuses} : "
                    "les fixtures ont été régénérées — mettre à jour "
                    "fixtures/enveloppe_docie.json (cles_enveloppe + "
                    "champs_absents_connus)",
                )


if __name__ == "__main__":
    unittest.main()
