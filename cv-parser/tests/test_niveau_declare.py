"""`niveau_declare` survit à un enregistrement de la fiche.

Le libellé d'origine du CV (« natif », « courant ») est conservé à côté du
niveau CECRL déduit — l'équivalent du `self_described` de one-pager. Les deux
services le gardent comme provenance et AUCUN des deux ne l'affiche.

D'où la fragilité : l'écran d'édition ne le montre pas, donc `collectData()` ne
le renvoie pas. Et comme les langues y sont reconstruites champ par champ
(`{language, level}` dans cv_detail.html) au lieu d'être parcourues par la
boucle générique `[data-f]`, le premier enregistrement effaçait la provenance
de TOUTES les langues de la fiche, en silence — la même classe de perte que le
lieu et l'organisme (#177 lignes 17-18), mais traitée autrement : ce champ
n'est pas du contenu édité, on le reporte côté serveur plutôt que de le faire
transiter par le navigateur.

`app.py` ouvre PostgreSQL à l'import ; la fonction est donc extraite par `ast`,
comme le reste de la suite.
"""
import ast
import sys
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))


def _preserver():
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, ast.FunctionDef) and n.name == "preserver_niveau_declare"
    )
    espace = {}
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace["preserver_niveau_declare"]


preserver_niveau_declare = _preserver()


def _fiche():
    """Fiche telle que normalize_cv_data la produit pour le CV d'exemple."""
    return {"languages": [
        {"language": "Français", "level": "C2", "niveau_declare": "natif"},
        {"language": "Anglais", "level": "C1", "niveau_declare": "courant"},
    ]}


def _patch_du_navigateur():
    """Ce que collectData() envoie réellement : ni niveau_declare, ni autre clé."""
    return {"languages": [
        {"language": "Français", "level": "C2"},
        {"language": "Anglais", "level": "C1"},
    ]}


class PreservationTests(unittest.TestCase):

    def test_la_provenance_survit_a_un_enregistrement(self):
        cv, updates = _fiche(), _patch_du_navigateur()
        preserver_niveau_declare(cv, updates)
        self.assertEqual(
            [l.get("niveau_declare") for l in updates["languages"]],
            ["natif", "courant"],
        )

    def test_sans_le_report_la_provenance_disparaissait(self):
        """Témoin : c'est bien l'enregistrement qui effaçait, pas autre chose."""
        cv, updates = _fiche(), _patch_du_navigateur()
        # Pas d'appel à preserver_niveau_declare : on simule l'ancien update_cv.
        for cle, val in updates.items():
            cv[cle] = val
        self.assertEqual([l.get("niveau_declare") for l in cv["languages"]], [None, None])

    def test_l_appariement_ignore_la_casse_et_les_espaces(self):
        cv = _fiche()
        updates = {"languages": [{"language": "  FRANÇAIS ", "level": "C2"}]}
        preserver_niveau_declare(cv, updates)
        self.assertEqual(updates["languages"][0]["niveau_declare"], "natif")

    def test_une_langue_ajoutee_a_la_main_n_invente_pas_de_provenance(self):
        cv = _fiche()
        updates = {"languages": [{"language": "Espagnol", "level": "B1"}]}
        preserver_niveau_declare(cv, updates)
        self.assertNotIn("niveau_declare", updates["languages"][0])

    def test_une_provenance_deja_fournie_n_est_pas_ecrasee(self):
        cv = _fiche()
        updates = {"languages": [{"language": "Français", "level": "C1",
                                  "niveau_declare": "bilingue"}]}
        preserver_niveau_declare(cv, updates)
        self.assertEqual(updates["languages"][0]["niveau_declare"], "bilingue")

    def test_un_patch_sans_langues_ne_touche_a_rien(self):
        cv, updates = _fiche(), {"title": "Développeuse"}
        preserver_niveau_declare(cv, updates)
        self.assertEqual(updates, {"title": "Développeuse"})

    def test_une_fiche_sans_langues_ne_fait_pas_echouer(self):
        updates = {"languages": [{"language": "Français", "level": "C2"}]}
        preserver_niveau_declare({}, updates)
        self.assertNotIn("niveau_declare", updates["languages"][0])

    def test_les_entrees_malformees_sont_ignorees(self):
        cv = {"languages": [None, "Français", {"language": "Anglais",
                                               "niveau_declare": "courant"}]}
        updates = {"languages": [None, {"language": "Anglais", "level": "C1"}]}
        preserver_niveau_declare(cv, updates)
        self.assertEqual(updates["languages"][1]["niveau_declare"], "courant")


if __name__ == "__main__":
    unittest.main()
