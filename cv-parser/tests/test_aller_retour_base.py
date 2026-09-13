"""#174 : les champs conservés survivent à l'écriture EN BASE, pas seulement au dict.

Un champ qui traverse `normalize_cv_data` mais pas la table n'est pas corrigé :
la CVthèque est une base, et c'est ce qu'on en relit qui s'affiche, s'exporte et
se rapproche d'un besoin. `location`, `issuer` et `anciennete_source` doivent
donc revenir identiques d'un aller-retour.

Ce que ce fichier mesure exactement — à dire franchement, car c'est ce qui borne
sa portée :

  * la CHAÎNE réelle est exécutée : `normalize_cv_data` -> `save_cv` ->
    `get_cv` -> `_record`, puis un tour de plus par le PATCH de l'écran
    (`_filtrer_champs_cv`) ;
  * la SÉRIALISATION est celle de psycopg : la valeur passée à `Jsonb(...)` est
    rendue par le dumper que psycopg utiliserait vraiment, en octets, et relue
    depuis ces octets — c'est la frontière où un champ se perd (une colonne
    typée, un `SELECT` qui énumère ses colonnes, un encodage) ;
  * PostgreSQL lui-même n'est PAS exercé : la suite doit tourner sans base. Le
    schéma (`core/schema.sql`) est en revanche vérifié ici : la fiche y est UNE
    colonne `data JSONB`, pas une liste de colonnes — c'est ce qui fait
    qu'aucune migration n'est nécessaire, et c'est vérifié plutôt que supposé.

L'aller-retour a par ailleurs été mesuré UNE FOIS sur un vrai PostgreSQL 17
(conteneur `adbi-postgres`, schéma jetable `verif174` créé puis supprimé, code
`cvstore_pg` inchangé) — résultat reporté dans le message du commit #174. Il
n'est pas rejouable ici faute de base dans la suite ; c'est pourquoi la
vérification permanente est celle ci-dessus.
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

from psycopg.adapt import PyFormat, Transformer  # noqa: E402
from psycopg.types.json import Jsonb  # noqa: E402

from core import cvstore_pg  # noqa: E402
from docie_client import map_resume  # noqa: E402
from niveau_langue import niveau_cecrl  # noqa: E402
from periode_mission import (  # noqa: E402
    analyser_periode,
    index_mois,
    mentionne_en_cours,
    mois_courant,
    ordre_missions,
    periode_lisible,
    titre_de_repli,
)

REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)


def _nom(noeud):
    if isinstance(noeud, ast.FunctionDef):
        return noeud.name
    cibles = [c.id for c in noeud.targets if isinstance(c, ast.Name)]
    return cibles[0] if cibles else ""


def _fonctions_de_app(noms):
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, (ast.FunctionDef, ast.Assign)) and _nom(n) in noms)
    espace = {
        "re": re, "datetime": datetime,
        "mentionne_en_cours": mentionne_en_cours,
        "analyser_periode": analyser_periode, "ordre_missions": ordre_missions,
        "index_mois": index_mois, "mois_courant": mois_courant,
        "periode_lisible": periode_lisible, "titre_de_repli": titre_de_repli,
        "niveau_cecrl": niveau_cecrl,
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
        "CV_LIST_MAX": 200, "CV_SKILLS_FLAT_MAX": 400,
        "CHAMPS_LISTE_CV": ("experience", "education", "languages",
                            "certifications", "interests"),
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace


APP = _fonctions_de_app({
    "normalize_cv_data", "compute_years_experience", "_filtrer_champs_cv",
    "_plafonner_cv", "marquer_anciennete_manuelle",
    "CHAMPS_MODIFIABLES_CV", "LISTES_DE_DICTS_CV",
})


def _octets_jsonb(valeur):
    """Les octets que psycopg enverrait réellement pour ce `Jsonb(...)`."""
    enveloppe = Jsonb(valeur)
    dumper = Transformer().get_dumper(enveloppe, PyFormat.TEXT)
    return bytes(dumper.dump(enveloppe))


class _Table:
    """Une table `cvs` en mémoire, franchie par la sérialisation de psycopg.

    Ce qui est stocké n'est pas le dict fourni : ce sont les octets JSONB que
    psycopg produirait, relus. Un champ que la sérialisation perdrait (ou
    déformerait) se verrait donc ici.
    """

    def __init__(self):
        self.lignes = {}

    # — interface minimale de core/pg.py::get_conn —
    def __call__(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        requete = " ".join(sql.split())
        if requete.startswith("INSERT INTO cvs"):
            cv_id, nom, courriel, enveloppe = params[0], params[1], params[2], params[3]
            self.lignes[cv_id] = {"id": cv_id, "name": nom, "email": courriel,
                                  "data": json.loads(_octets_jsonb(enveloppe.obj))}
            return self
        if requete.startswith("SELECT * FROM cvs WHERE id"):
            self._trouvee = self.lignes.get(params[0])
            return self
        raise AssertionError(f"requête non prévue par ce double : {requete}")

    def fetchone(self):
        return self._trouvee


class _BaseEnMemoire:
    """Remplace `cvstore_pg.get_conn` le temps d'un test."""

    def __enter__(self):
        self.table = _Table()
        self._vrai = cvstore_pg.get_conn
        cvstore_pg.get_conn = self.table
        return self

    def __exit__(self, *exc):
        cvstore_pg.get_conn = self._vrai
        return False


CERTIFICATION = {"name": "AWS Certified Solutions Architect",
                 "issuer": "Amazon Web Services", "year": "2023"}


def _fiche_extraite():
    """La fiche telle que process_cv la construit depuis la vraie réponse."""
    reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
    reponse["schema_name"] = "adbi_resume"
    fiche = APP["normalize_cv_data"](map_resume(reponse, expected_schema="adbi_resume"))
    # Les certifications sont vides dans toutes les fixtures du dépôt : entrée
    # synthétique bâtie sur le `dynamic_schema` de cette même réponse.
    fiche["certifications"] = [dict(CERTIFICATION)]
    return fiche


class SchemaTests(unittest.TestCase):
    """Aucune migration : la fiche est une colonne JSONB, pas des colonnes."""

    def test_la_fiche_est_stockee_en_un_seul_jsonb(self):
        schema = (RACINE / "core/schema.sql").read_text(encoding="utf-8")
        creation = schema[schema.index("CREATE TABLE IF NOT EXISTS cvs"):]
        creation = creation[:creation.index(");")]
        colonnes = {ligne.split()[0] for ligne in
                    (l.strip() for l in creation.splitlines()[1:]) if ligne}
        # `name` et `email` sont dupliqués à plat pour l'index/le tri ; tout le
        # reste de la fiche vit dans `data`. Aucune colonne n'énumère les
        # champs d'une mission : ajouter `location` n'exige donc rien en base.
        self.assertEqual(colonnes, {"id", "name", "email", "data", "cree_le", "maj_le"})

    def test_la_lecture_ne_filtre_aucun_champ(self):
        """`_record` rend le JSONB tel quel : rien n'y est énuméré ni recopié champ par champ."""
        reconstruite = cvstore_pg._record(
            {"id": "cv1", "data": {"experience": [{"location": "Lyon"}],
                                   "anciennete_source": "docie"}})
        self.assertEqual(reconstruite["experience"][0]["location"], "Lyon")
        self.assertEqual(reconstruite["anciennete_source"], "docie")


class AllerRetourTests(unittest.TestCase):
    """Écrire, relire : la valeur écrite doit être la valeur relue."""

    def test_la_fiche_extraite_revient_identique(self):
        fiche = _fiche_extraite()
        with _BaseEnMemoire():
            cvstore_pg.save_cv("cv1", fiche)
            relue = cvstore_pg.get_cv("cv1")
        self.assertEqual([m["location"] for m in relue["experience"]],
                         [m["location"] for m in fiche["experience"]])
        self.assertEqual([m["location"] for m in relue["experience"]], ["Lyon", "Lyon"])
        self.assertEqual(relue["certifications"][0]["issuer"], "Amazon Web Services")
        self.assertEqual(relue["anciennete_source"], fiche["anciennete_source"])
        # Et rien d'autre n'a bougé : la fiche relue EST la fiche écrite.
        self.assertEqual(relue, {**fiche, "id": "cv1"})

    def test_les_accents_et_les_tirets_cadratins_traversent(self):
        """« Béranger », « — » : la sérialisation ne doit rien échapper de travers."""
        fiche = {"name": "Camille Béranger",
                 "experience": [{"company": "Numelia", "location": "Saint-Étienne"}],
                 "certifications": [{"name": "ITIL — Foundation",
                                     "issuer": "AXELOS"}]}
        with _BaseEnMemoire():
            cvstore_pg.save_cv("cv1", fiche)
            relue = cvstore_pg.get_cv("cv1")
        self.assertEqual(relue["experience"][0]["location"], "Saint-Étienne")
        self.assertEqual(relue["certifications"][0]["name"], "ITIL — Foundation")

    def test_un_enregistrement_depuis_l_ecran_ne_perd_rien(self):
        """Extraction -> base -> écran -> PATCH -> base : le tour complet.

        C'est le chemin qui efface pour de bon : la première sauvegarde manuelle
        remplace la rubrique ENTIÈRE par ce que `collectData()` a ramassé.
        """
        with _BaseEnMemoire():
            cvstore_pg.save_cv("cv1", _fiche_extraite())
            fiche = cvstore_pg.get_cv("cv1")

            # Ce que l'écran renvoie : rubriques entières, telles qu'affichées.
            envoi = {"name": fiche["name"],
                     "years_experience": fiche["years_experience"],
                     "experience": fiche["experience"],
                     "certifications": fiche["certifications"]}
            updates = APP["_filtrer_champs_cv"](envoi)
            self.assertIsNone(APP["_plafonner_cv"](updates))
            APP["marquer_anciennete_manuelle"](fiche, updates)
            for cle, val in updates.items():           # ce que fait update_cv
                fiche[cle] = val
            cvstore_pg.save_cv("cv1", fiche)
            relue = cvstore_pg.get_cv("cv1")

        self.assertEqual([m["location"] for m in relue["experience"]], ["Lyon", "Lyon"])
        self.assertEqual(relue["certifications"][0]["issuer"], "Amazon Web Services")
        # L'ancienneté n'a pas changé : la provenance mesurée tient.
        self.assertEqual(relue["anciennete_source"], "periodes")

    def test_une_anciennete_retapee_a_l_ecran_se_dit_manuelle_en_base(self):
        with _BaseEnMemoire():
            cvstore_pg.save_cv("cv1", _fiche_extraite())
            fiche = cvstore_pg.get_cv("cv1")
            updates = APP["_filtrer_champs_cv"]({"years_experience": "12"})
            APP["marquer_anciennete_manuelle"](fiche, updates)
            for cle, val in updates.items():
                fiche[cle] = val
            cvstore_pg.save_cv("cv1", fiche)
            relue = cvstore_pg.get_cv("cv1")
        self.assertEqual((relue["years_experience"], relue["anciennete_source"]),
                         (12, "manuel"))

    def test_une_fiche_d_avant_le_correctif_se_relit_sans_ces_cles(self):
        """Rétrocompatibilité : une fiche déjà en base n'en porte aucune."""
        ancienne = {"name": "Camille", "years_experience": 7,
                    "experience": [{"company": "Numelia", "title": "Dev"}],
                    "certifications": [{"name": "ITIL", "year": "2020"}]}
        with _BaseEnMemoire():
            cvstore_pg.save_cv("cv1", ancienne)
            relue = cvstore_pg.get_cv("cv1")
        self.assertNotIn("location", relue["experience"][0])
        self.assertNotIn("issuer", relue["certifications"][0])
        self.assertNotIn("anciennete_source", relue)


class DoubleDeBaseTests(unittest.TestCase):
    """Le double ne vaut que s'il perd ce qu'une vraie perte perdrait."""

    def test_le_double_passe_bien_par_la_serialisation(self):
        """Une clé non sérialisable échouerait ici comme en base."""
        with _BaseEnMemoire():
            with self.assertRaises(TypeError):
                cvstore_pg.save_cv("cv1", {"experience": [{"location": object()}]})


if __name__ == "__main__":
    unittest.main()
