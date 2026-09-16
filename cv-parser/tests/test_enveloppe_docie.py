"""#171 : les cinq formes qu'un champ DocIE peut prendre, et qui les déballe.

`docie_client.unwrap` traite un objet comme une ENVELOPPE de preuve — et rend
alors son `value` — s'il porte une clé `value` et au moins un marqueur. La liste
de marqueurs était de deux (`confidence`, `evidence_ids`) et laissait passer
deux formes réelles :

  * `{value, model_confidence}` — ce que DocIE émet quand son
    `_flatten_agent_result` échoue à aplatir ;
  * `{value, model_logprob}` — depuis le renommage de la log-probabilité.

Ce n'est pas une exception bruyante : `map_resume` alimente
`normalize_cv_data`, donc un `location` de cette forme entre dans la CVthèque et
s'affiche « {'value': 'Lyon', 'model_confidence': 0.82} ». Même famille de perte
silencieuse que #174, sur la même voie.

Deux choses sont vérifiées ici, et la seconde est le vrai sujet :

  1. les cinq formes sont déballées (table exécutée, pas relue) ;
  2. la liste de ce fichier COUVRE celle des deux ponts partagés, lue dans leur
     source. Le même test d'enveloppe est écrit trois fois dans le dépôt
     (`cv-parser/docie_client.py`, `document-parsing/bridge/docie_bridge.py`,
     `document-parsing/bridge/docie-bridge.js`) ; un marqueur ajouté à un pont
     et pas ici rouvrirait exactement la panne ci-dessus.

Pourquoi lire la source des ponts plutôt que d'ajouter un jeu d'essai partagé
sous `document-parsing/fixtures/` — la discipline habituelle quand deux services
doivent s'accorder : ici les deux parties comparées sont des CONSTANTES DE CODE,
pas des cas d'entrée-sortie. Un fichier de fixture serait un quatrième endroit
où écrire la même liste, et rien n'obligerait un pont à le lire.
Lire la source des ponts compare les deux vraies listes, sans en créer une
troisième.
"""
import ast
import re
import sys
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from docie_client import ENVELOPE_MARKERS, unwrap  # noqa: E402

PONTS = Path(__file__).resolve().parents[2] / "document-parsing/bridge"


def _marqueurs_du_pont_python():
    """Les marqueurs du pont Python, sous l'une ou l'autre de ses écritures.

    Aujourd'hui ils sont en dur dans le `if` d'`unwrap` ; #173 les sort dans une
    constante `ENVELOPE_MARKERS`. Les deux formes sont acceptées pour que ce
    test ne casse pas au passage de l'une à l'autre — c'est le contenu qui
    compte, pas la mise en page.
    """
    arbre = ast.parse((PONTS / "docie_bridge.py").read_text(encoding="utf-8"))
    for noeud in arbre.body:
        if (isinstance(noeud, ast.Assign)
                and any(isinstance(c, ast.Name) and c.id == "ENVELOPE_MARKERS"
                        for c in noeud.targets)):
            return {e.value for e in ast.walk(noeud.value)
                    if isinstance(e, ast.Constant) and isinstance(e.value, str)}
    unwrap_pont = next(n for n in arbre.body
                       if isinstance(n, ast.FunctionDef) and n.name == "unwrap")
    trouves = set()
    for noeud in ast.walk(unwrap_pont):
        if not isinstance(noeud, ast.If):
            continue
        trouves |= {n.value for n in ast.walk(noeud.test)
                    if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    return trouves - {"value"}


def _marqueurs_du_pont_js():
    source = (PONTS / "docie-bridge.js").read_text(encoding="utf-8")
    constante = re.search(r"ENVELOPE_MARKERS\s*=\s*\[([^\]]*)\]", source)
    if constante:
        return set(re.findall(r'"([^"]+)"', constante.group(1)))
    debut = source.index("function unwrap")
    corps = source[debut:source.index("function parseResponse")]
    return set(re.findall(r'Object\.hasOwn\(value,\s*"([^"]+)"\)', corps)) - {"value"}


class CinqFormesTests(unittest.TestCase):
    """Table exécutée. Les trois premières lignes passaient déjà : elles doivent
    passer à l'identique — élargir la liste ne doit rien casser."""

    FORMES = [
        ("plate", "Ada Lovelace"),
        ("value + evidence_ids + confidence",
         {"value": "Ada Lovelace", "evidence_ids": ["e1"], "confidence": 0.9}),
        ("value + evidence_ids + confidence + model_confidence",
         {"value": "Ada Lovelace", "evidence_ids": ["e1"], "confidence": 0.9,
          "model_confidence": 0.82}),
        ("value + model_confidence (résidu d'un aplatissement en échec)",
         {"value": "Ada Lovelace", "model_confidence": 0.82}),
        ("value + model_logprob (log-probabilité renommée)",
         {"value": "Ada Lovelace", "model_logprob": -0.18}),
    ]

    def test_les_cinq_formes_rendent_le_scalaire(self):
        for libelle, forme in self.FORMES:
            with self.subTest(forme=libelle):
                self.assertEqual(unwrap(forme), "Ada Lovelace")

    def test_un_lieu_de_mission_arrive_en_chaine_et_non_en_dictionnaire(self):
        """Le cas concret : `map_resume` alimente `normalize_cv_data`."""
        from docie_client import map_resume
        data = map_resume({"schema_name": "adbi_resume", "result": {
            "name": "Camille Béranger",
            "experience": [{"company": "Numelia", "title": "Dev",
                            "location": {"value": "Lyon", "model_confidence": 0.82}}],
        }}, expected_schema="adbi_resume")
        self.assertEqual(data["experience"][0]["location"], "Lyon")


class PasDEnveloppeTests(unittest.TestCase):
    """Élargir la liste ne doit pas faire prendre un objet du schéma pour une
    enveloppe : il faut TOUJOURS une clé `value` en plus d'un marqueur."""

    def test_un_objet_sans_value_est_conserve(self):
        objet = {"confidence": 0.9, "model_logprob": -0.2}
        self.assertEqual(unwrap(objet), objet)

    def test_un_objet_avec_value_seule_est_conserve(self):
        objet = {"value": "Lyon", "unite": "ville"}
        self.assertEqual(unwrap(objet), objet)

    def test_les_enveloppes_imbriquees_et_les_listes_traversent(self):
        self.assertEqual(
            unwrap({"contact": {"email": {"value": "a@b.fr", "model_logprob": -0.1}},
                    "interests": [{"value": "Voile", "model_confidence": 0.7}]}),
            {"contact": {"email": "a@b.fr"}, "interests": ["Voile"]})


class MemeListeQueLesPontsTests(unittest.TestCase):
    """Le même test d'enveloppe est écrit trois fois : il ne doit pas diverger.

    L'exigence est une COUVERTURE, pas une égalité : ce fichier peut connaître
    un marqueur qu'un pont ignore encore (c'est le cas aujourd'hui, les deux
    ponts en sont à deux marqueurs et #173 les porte à trois), mais jamais
    l'inverse — un pont qui reconnaîtrait une enveloppe que `docie_client`
    laisse passer rouvrirait la panne : un dictionnaire dans la fiche.
    """

    def test_la_liste_couvre_celle_du_pont_python(self):
        self.assertLessEqual(_marqueurs_du_pont_python(), set(ENVELOPE_MARKERS))

    def test_la_liste_couvre_celle_du_pont_js(self):
        self.assertLessEqual(_marqueurs_du_pont_js(), set(ENVELOPE_MARKERS))

    def test_les_deux_ponts_disent_la_meme_chose(self):
        self.assertEqual(_marqueurs_du_pont_python(), _marqueurs_du_pont_js())

    def test_la_lecture_des_ponts_trouve_vraiment_quelque_chose(self):
        """Sans ce garde-fou, une lecture qui ne trouve rien passerait à vide."""
        for marqueurs in (_marqueurs_du_pont_python(), _marqueurs_du_pont_js()):
            self.assertIn("evidence_ids", marqueurs)
            self.assertIn("confidence", marqueurs)


if __name__ == "__main__":
    unittest.main()
