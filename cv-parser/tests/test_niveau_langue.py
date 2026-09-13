"""« natif » vaut C2 des deux côtés — #177 ligne 11.

DocIE rend `languages[].level` en texte libre et y recopie ce que le CV écrit :
la vraie réponse enregistrée dans le dépôt porte « natif » et « courant ».
one-pager en déduisait un niveau CECRL depuis toujours ; cv-parser stockait le
libellé verbatim. Le même CV donnait donc « natif » dans la CVthèque et « C2 »
dans le dossier one-page, et deux CV disant la même chose autrement
(« natif » / « langue maternelle ») donnaient deux fiches différentes pour le
même candidat.

Le jeu d'essai est lu dans document-parsing/fixtures/niveau_langue.json — le
test JS jumeau (one-pager/tests/normalize.test.js) lit exactement le même
fichier. Comparer les MOTIFS, et pas seulement les verdicts, est ce qui empêche
les deux tables de redivergier : ajouter un libellé d'un seul côté casse le
test de l'autre service. Même discipline que mission_en_cours.json et
date_mission.json.

La fixture est le SEUL point de rendez-vous, volontairement : le port JS
(one-pager/lib/normalize.js) est modifié sur la branche de la PR #178, celui-ci
sur la branche de la #176. Épingler en plus le contenu du fichier JS — comme le
fait la ligne 12 pour le libellé « Compétences » — ferait échouer ce test tant
que les deux branches ne sont pas fusionnées. Le blob de la fixture est
identique octet pour octet sur les deux, comme mission_en_cours.json.

`app.py` ouvre PostgreSQL à l'import ; `normalize_cv_data` en est donc extraite
par `ast`, comme dans `test_periode_mission.py`.
"""
import ast
import json
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from docie_client import map_resume  # noqa: E402
from niveau_langue import BAREMES, NIVEAUX, ORDRE_CECRL, niveau_cecrl  # noqa: E402
from periode_mission import (  # noqa: E402
    analyser_periode,
    index_mois,
    mentionne_en_cours,
    mois_courant,
    ordre_missions,
    periode_lisible,
    titre_de_repli,
)

FIXTURE = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/niveau_langue.json"
REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)

JEU = json.loads(FIXTURE.read_text(encoding="utf-8"))


def _normalize_cv_data():
    """Extrait `normalize_cv_data` d'app.py sans l'importer."""
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, ast.FunctionDef)
        and n.name in {"normalize_cv_data", "compute_years_experience"}
    )
    espace = {
        "re": re,
        "datetime": datetime,
        "mentionne_en_cours": mentionne_en_cours,
        "analyser_periode": analyser_periode,
        "ordre_missions": ordre_missions,
        "index_mois": index_mois,
        "mois_courant": mois_courant,
        "periode_lisible": periode_lisible,
        "titre_de_repli": titre_de_repli,
        "niveau_cecrl": niveau_cecrl,
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
        "print": lambda *a, **k: None,
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace["normalize_cv_data"]


class TablePartageeTests(unittest.TestCase):
    """Les deux portages lisent la même table, sinon un test casse."""

    def test_les_motifs_sont_exactement_ceux_du_jeu_d_essai(self):
        # L'ORDRE compte autant que le contenu : le premier motif qui reconnaît
        # gagne, et c'est lui qui fait valoir B1 — et non A2 — à « niveau
        # scolaire solide ». On compare donc la liste entière, pas un ensemble.
        self.assertEqual([list(paire) for paire in NIVEAUX], JEU["niveaux"])

    def test_l_ordre_cecrl_est_celui_du_jeu_d_essai(self):
        self.assertEqual(ORDRE_CECRL, JEU["ordre"])

    def test_les_baremes_sont_ceux_du_jeu_d_essai(self):
        attendu = [{"test": b["test"], "motif": b["motif"],
                    "paliers": [list(p) for p in b["paliers"]], "defaut": b["defaut"]}
                   for b in BAREMES]
        self.assertEqual(attendu, JEU["bareme"])


class ClassementTests(unittest.TestCase):
    def test_chaque_cas_du_jeu_d_essai(self):
        for cas in JEU["cas"]:
            with self.subTest(valeur=cas["valeur"]):
                self.assertEqual(niveau_cecrl(cas["valeur"]), cas["niveau"], cas["preuve"])

    def test_le_niveau_le_plus_favorable_l_emporte(self):
        """Un candidat qui s'écrit « courant » ne doit pas être déprécié par le
        barème de son test — même arbitrage que le JS."""
        self.assertEqual(niveau_cecrl("courant - TOEIC 880"), "C1")
        self.assertEqual(niveau_cecrl("TOEIC 880"), "B2")

    def test_frontieres_de_mot(self):
        """« nativement » n'est pas un niveau : le motif est ancré."""
        self.assertIsNone(niveau_cecrl("parle nativement le klingon"))
        self.assertIsNone(niveau_cecrl(None))


class FicheTests(unittest.TestCase):
    def setUp(self):
        self.normalize = _normalize_cv_data()

    def test_fixture_reelle_avant_apres(self):
        """La vraie réponse DocIE : « natif »/« courant » -> C2/C1, comme le JS."""
        reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
        reponse["schema_name"] = "adbi_resume"
        data = map_resume(reponse, expected_schema="adbi_resume")
        self.assertEqual([l["level"] for l in data["languages"]], ["natif", "courant"])
        fiche = self.normalize(data)
        self.assertEqual([l["level"] for l in fiche["languages"]], ["C2", "C1"])
        # Le libellé d'origine n'est pas perdu — `self_described` du JS.
        self.assertEqual([l["niveau_declare"] for l in fiche["languages"]], ["natif", "courant"])

    def test_un_libelle_non_reconnu_garde_son_texte(self):
        """Jamais vidé : c'est la leçon de la ligne 10, où un libellé inconnu
        de la table sortait en niveau VIDE côté JS. Écart assumé avec one-pager
        (qui met `level` à "" et garde le brut dans `self_described`) : une
        fiche CVthèque n'a qu'un champ à afficher."""
        fiche = self.normalize({"languages": [{"language": "Anglais", "level": "lu, écrit, parlé"}]})
        self.assertEqual(fiche["languages"][0]["level"], "lu, écrit, parlé")
        self.assertEqual(fiche["languages"][0]["niveau_declare"], "lu, écrit, parlé")

    def test_une_langue_sans_niveau_reste_sans_niveau(self):
        fiche = self.normalize({"languages": [{"language": "Anglais"}]})
        self.assertEqual(fiche["languages"][0]["level"], "")

    def test_deux_facons_d_ecrire_la_meme_chose_donnent_la_meme_fiche(self):
        """Le fond de la ligne 11 : « natif » et « langue maternelle » sont le
        même niveau, et donnaient deux fiches différentes."""
        niveaux = [
            self.normalize({"languages": [{"language": "Français", "level": brut}]})["languages"][0]["level"]
            for brut in ("natif", "langue maternelle", "bilingue", "C2")
        ]
        self.assertEqual(niveaux, ["C2", "C2", "C2", "C2"])

    def test_cle_francaise_acceptee(self):
        fiche = self.normalize({"langues": [{"langue": "Anglais", "niveau": "courant"}]})
        self.assertEqual(fiche["languages"][0], {"language": "Anglais", "level": "C1",
                                                 "niveau_declare": "courant"})


if __name__ == "__main__":
    unittest.main()
