"""POST /api/upload en tâche asynchrone et son suivi (issue #196).

`app.py` ouvre PostgreSQL à l'import : les routes et leurs fonctions en sont
extraites par `ast` (comme test_cache_empreinte.py) et montées, décorateurs
compris, sur une application Flask de test. PostgreSQL, DocIE et
l'authentification sont remplacés ; le code exécuté est celui d'app.py.
"""
import ast
import sys
import tempfile
import threading
import time
import traceback
import unittest
import uuid
from datetime import datetime
from functools import wraps
from io import BytesIO
from pathlib import Path

from flask import Flask, g, jsonify, request

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

import taches_upload as tu  # noqa: E402
from docie_client import DocIEError  # noqa: E402

NOMS = {"upload_cv", "progression_analyse", "noter_progression", "_analyser_depot",
        "_enregistrer_depot", "fiche_depuis_le_cache", "CHAMPS_PROPRES_AU_DEPOT"}
SOURCE_APP = (RACINE / "app.py").read_text(encoding="utf-8")


def _nom(noeud):
    if isinstance(noeud, ast.FunctionDef):
        return noeud.name
    if isinstance(noeud, ast.Assign):
        cibles = [c.id for c in noeud.targets if isinstance(c, ast.Name)]
        return cibles[0] if cibles else ""
    return ""


SOURCE_ROUTES = "\n\n".join(ast.unparse(n) for n in ast.parse(SOURCE_APP).body if _nom(n) in NOMS)


class Lanceur:
    def __init__(self):
        self.cibles = []

    def __call__(self, cible):
        self.cibles.append(cible)

    def jouer(self):
        self.cibles.pop(0)()


class Base:
    """Fiche remplie comme process_cv la rend (champs utiles au test)."""

    @staticmethod
    def fiche(**extra):
        return {"name": "Alice Dupont", "title": "Data Engineer", "experience": [{"title": "ACME"}],
                "skills_flat": ["python"], "education": [], "parsing_mode": "docie",
                "extraction": "docie", "llm_service": "DocIE / défaut", "llm_parsed": True,
                "_timing": {"total_s": 1.5}, **extra}


class Montage(unittest.TestCase):
    def monter(self, *, process_cv=None, lanceur=None, existantes=None, bilan=None, **options):
        self.dossier = tempfile.TemporaryDirectory()
        self.addCleanup(self.dossier.cleanup)
        self.enregistrees, self.journal, self.enrichis, self.appels = {}, [], [], []
        app = Flask("test_upload")
        gestionnaire = tu.GestionnaireTaches(lancer=lanceur or tu._lancer_thread,
                                             journal=lambda e: None, **options)

        def require_auth(f):
            @wraps(f)
            def deco(*a, **k):
                sub = request.headers.get("X-Test-User", "u1")
                g.current_user = {"sub": sub, "email": f"{sub}@adbi.fr"}
                return f(*a, **k)
            return deco

        class Store:
            list_cvs = staticmethod(lambda: dict(existantes or {}))
            get_cv = staticmethod(lambda i: dict(self.enregistrees[i]) if i in self.enregistrees else None)

            @staticmethod
            def save_cv(i, cv):
                self.enregistrees[i] = dict(cv)

        def process_cv_par_defaut(chemin, jeton=None):
            self.appels.append((Path(chemin), jeton))
            return Base.fiche()

        espace = {
            "app": app, "require_auth": require_auth, "request": request, "jsonify": jsonify, "g": g,
            "Path": Path, "uuid": uuid, "threading": threading, "traceback": traceback,
            "datetime": datetime, "UPLOAD_DIR": Path(self.dossier.name),
            "cvstore_pg": Store, "process_cv": process_cv or process_cv_par_defaut,
            "nom_depuis_fichier": lambda nom: "",
            "bilan_adbi": bilan or (lambda cv: {"exploitable": bool(cv.get("experience"))}),
            "_log": lambda *a: self.journal.append(a),
            "get_current_user": lambda: getattr(g, "current_user", None),
            "_enrich_cv_background": lambda i: self.enrichis.append(i),
            "TACHES_UPLOAD": gestionnaire, "FileTachesPleine": tu.FileTachesPleine,
            "PROGRESSION_ANALYSES": {}, "_progression_verrou": threading.Lock(),
        }
        exec(compile(SOURCE_ROUTES, str(RACINE / "app.py"), "exec"), espace)
        self.espace, self.gestionnaire = espace, gestionnaire
        self.client = app.test_client()
        return self.client

    def poster(self, nom="cv.pdf", contenu=b"%PDF-1.4 alice", jeton=None, utilisateur="u1"):
        donnees = {"file": (BytesIO(contenu), nom)}
        if jeton is not None:
            donnees["jeton"] = jeton
        return self.client.post("/api/upload", data=donnees, content_type="multipart/form-data",
                                headers={"X-Test-User": utilisateur})

    def suivre(self, jeton, utilisateur="u1"):
        return self.client.get(f"/api/upload/progression/{jeton}", headers={"X-Test-User": utilisateur})

    def attendre_fin(self, jeton, utilisateur="u1"):
        for _ in range(500):
            vue = self.suivre(jeton, utilisateur).get_json()
            if vue.get("etat") != "en_cours":
                return vue
            threading.Event().wait(0.01)
        self.fail("tâche jamais terminée")


class Asynchrone(Montage):
    def test_post_202_pendant_que_process_cv_tourne_puis_resultat(self):
        demarre, liberer = threading.Event(), threading.Event()

        def process_cv(chemin, jeton=None):
            self.espace["noter_progression"](jeton, 55, "Analyse du CV", "Envoi du document à DocIE")
            demarre.set()
            self.assertTrue(liberer.wait(10))
            return Base.fiche()

        self.monter(process_cv=process_cv)
        jeton = "a1b2c3d4-0000-4000-8000-00000000abcd"
        reponse = {}

        def envoi():
            reponse["r"] = self.poster(jeton=jeton)

        fil = threading.Thread(target=envoi)
        t0 = time.perf_counter()
        fil.start()
        fil.join(5)
        try:
            self.assertFalse(fil.is_alive(), "la route attend l'extraction")
            self.assertLess(time.perf_counter() - t0, 2)
            r = reponse["r"]
            self.assertEqual(r.status_code, 202)
            self.assertEqual(r.get_json(), {"tache": jeton})
            self.assertTrue(demarre.wait(5))

            en_cours = self.suivre(jeton).get_json()
            self.assertEqual((en_cours["etat"], en_cours["pct"], en_cours["etape"], en_cours["detail"]),
                             ("en_cours", 55, "Analyse du CV", "Envoi du document à DocIE"))
            self.assertNotIn("resultat", en_cours)
        finally:
            liberer.set()

        fini = self.attendre_fin(jeton)
        self.assertEqual((fini["etat"], fini["pct"], fini["etape"]), ("terminee", 100, "Terminé"))
        self.assertIn("fin", fini)
        resultat = fini["resultat"]
        # Ancienne réponse synchrone : la fiche enregistrée, sans `_timing`
        # (passé dans parse_summary), avec le bilan recalculé et parse_summary.
        cv_id = resultat["id"]
        attendu = dict(self.enregistrees[cv_id])
        attendu.pop("_timing")
        attendu["bilan_adbi"] = {"exploitable": True}
        attendu["parse_summary"] = resultat["parse_summary"]
        self.assertEqual(resultat, attendu)
        self.assertTrue(resultat["llm_enriched"])
        self.assertEqual((resultat["filename"], resultat["ext"]), ("cv.pdf", ".pdf"))
        self.assertEqual(resultat["parse_summary"]["avertissement"], "")
        self.assertEqual(resultat["parse_summary"]["timing"], {"total_s": 1.5})
        self.assertTrue((Path(self.dossier.name) / f"{cv_id}.pdf").is_file(), "fichier conservé")
        self.assertEqual(self.enrichis, [], "fiche analysée : pas d'enrichissement de fond")
        # Journal d'activité écrit depuis le thread de tâche, avec l'auteur.
        self.assertEqual(self.journal, [("cv_upload", "u1", "u1@adbi.fr", {"cv_id": cv_id, "name": "Alice Dupont"})])

    def test_position_en_attente(self):
        lanceur = Lanceur()
        self.monter(lanceur=lanceur, max_simultanees=1)
        premier = self.poster().get_json()["tache"]
        second = self.poster(contenu=b"%PDF autre").get_json()["tache"]
        vue = self.suivre(second).get_json()
        self.assertEqual((vue["etat"], vue["position"], vue["etape"]), ("en_cours", 1, tu.ETAPE_ATTENTE))
        lanceur.jouer()
        self.assertEqual(self.suivre(premier).get_json()["etat"], "terminee")
        self.assertNotIn("position", self.suivre(second).get_json())
        lanceur.jouer()
        self.assertEqual(self.suivre(second).get_json()["etat"], "terminee")

    def test_jeton_client_absent_ou_mal_forme(self):
        lanceur = Lanceur()
        self.monter(lanceur=lanceur)
        for jeton in (None, "../x", "court"):
            tache = self.poster(jeton=jeton).get_json()["tache"]
            self.assertRegex(tache, r"^[0-9a-f-]{36}$")
            self.assertEqual(self.suivre(tache).status_code, 200)


class Repli(Montage):
    def test_echec_docie_garde_le_repli_fiche_vide(self):
        def process_cv(chemin, jeton=None):
            raise DocIEError("DocIE : modèle en cours de chargement, réessayez dans environ 30 s.")

        lanceur = Lanceur()
        self.monter(process_cv=process_cv, lanceur=lanceur)
        tache = self.poster().get_json()["tache"]
        lanceur.jouer()
        vue = self.suivre(tache).get_json()
        # Comportement d'avant #196 porté tel quel : fiche vide éditable
        # enregistrée, parse_warning = message de l'exception, tâche terminée.
        self.assertEqual(vue["etat"], "terminee")
        self.assertNotIn("erreur", vue)
        r = vue["resultat"]
        self.assertEqual(r["parse_warning"], "DocIE : modèle en cours de chargement, réessayez dans environ 30 s.")
        self.assertEqual(r["parse_summary"]["avertissement"], r["parse_warning"])
        self.assertEqual((r["name"], r["experience"]), ("", []))
        self.assertIn(r["id"], self.enregistrees)
        self.assertEqual(self.enrichis, [])

    def test_echec_hors_repli_devient_erreur_nommee_sans_fuite(self):
        def bilan(cv):
            raise RuntimeError("psycopg: password=SECRET-4242 host=/var/run/pg")

        lanceur = Lanceur()
        self.monter(lanceur=lanceur, bilan=bilan)
        tache = self.poster().get_json()["tache"]
        lanceur.jouer()
        r = self.suivre(tache)
        self.assertEqual(r.status_code, 200)
        vue = r.get_json()
        self.assertEqual((vue["etat"], vue["erreur"]), ("echec", {"code": "interne", "message": tu.MESSAGE_INTERNE}))
        self.assertNotIn("SECRET", r.get_data(as_text=True))


class Cache(Montage):
    def test_cache_synchrone_200_sans_tache_meme_file_pleine(self):
        import hashlib
        contenu = b"%PDF deja vu"
        existante = {**Base.fiche(), "id": "fiche-origine", "filename": "vieux.pdf", "ext": ".pdf",
                     "empreinte": hashlib.sha256(contenu).hexdigest(), "llm_enriched": True,
                     "bilan_adbi": {"exploitable": True}}
        existante.pop("_timing")
        existante.pop("llm_parsed")
        lanceur = Lanceur()
        self.monter(lanceur=lanceur, existantes={"fiche-origine": existante},
                    max_simultanees=1, max_en_attente=1)
        # File pleine : une extraction en cours, une en attente.
        self.poster(contenu=b"%PDF a")
        self.poster(contenu=b"%PDF b")
        self.assertEqual(self.poster(contenu=b"%PDF c").status_code, 503)
        avant = self.gestionnaire.statistiques()

        r = self.poster(nom="copie.pdf", contenu=contenu, jeton="jeton-client-cache")
        self.assertEqual(r.status_code, 200)
        corps = r.get_json()
        self.assertEqual((corps["extraction"], corps["copie_de"], corps["filename"]), ("cache", "fiche-origine", "copie.pdf"))
        self.assertEqual(corps["parse_summary"]["name"], "Alice Dupont")
        self.assertEqual(self.appels, [], "process_cv non appelé")
        self.assertEqual(self.gestionnaire.statistiques(), avant, "aucune tâche créée")
        self.assertIn(corps["id"], self.enregistrees)
        # Libellé « Déjà analysé » noté comme avant sur le jeton du client (hors tâche).
        self.assertEqual(self.espace["PROGRESSION_ANALYSES"]["jeton-client-cache"]["etape"], "Terminé")


class Isolation(Montage):
    def test_seul_l_auteur_suit_son_depot(self):
        lanceur = Lanceur()
        self.monter(lanceur=lanceur)
        tache = self.poster(utilisateur="u1").get_json()["tache"]
        lanceur.jouer()
        self.assertEqual(self.suivre(tache, "u1").status_code, 200)
        autre = self.suivre(tache, "u2")
        inconnu = self.suivre("jamais-vu-00000000", "u2")
        self.assertEqual(autre.status_code, 404)
        self.assertEqual(autre.get_data(), inconnu.get_data(), "même réponse qu'un jeton inconnu")
        self.assertNotIn("Alice", autre.get_data(as_text=True))

    def test_jeton_d_autrui_non_reutilisable(self):
        lanceur = Lanceur()
        self.monter(lanceur=lanceur)
        jeton = "partage-0000-0000-0000"
        self.assertEqual(self.poster(jeton=jeton, utilisateur="u1").get_json()["tache"], jeton)
        pris = self.poster(jeton=jeton, utilisateur="u2", contenu=b"%PDF u2").get_json()["tache"]
        self.assertNotEqual(pris, jeton)
        self.assertEqual(self.suivre(jeton, "u2").status_code, 404)

    def test_expiration_404(self):
        t = [1000.0]
        lanceur = Lanceur()
        self.monter(lanceur=lanceur, maintenant=lambda: t[0])
        tache = self.poster().get_json()["tache"]
        lanceur.jouer()
        t[0] += tu.TTL_S
        r = self.suivre(tache)
        self.assertEqual(r.status_code, 404)
        self.assertIn("30 min", r.get_json()["error"])


class Validation(Montage):
    def test_validation_synchrone_inchangee(self):
        lanceur = Lanceur()
        self.monter(lanceur=lanceur)
        r = self.client.post("/api/upload", data={}, content_type="multipart/form-data")
        self.assertEqual((r.status_code, r.get_json()), (400, {"error": "Aucun fichier fourni"}))
        r = self.poster(nom="cv.doc")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Format non supporté", r.get_json()["error"])
        self.assertEqual(self.gestionnaire.statistiques()["conservees"], 0)

    def test_file_pleine_503_et_fichier_retire(self):
        lanceur = Lanceur()
        self.monter(lanceur=lanceur, max_simultanees=1, max_en_attente=1)
        self.assertEqual(self.poster(contenu=b"%PDF 1").status_code, 202)
        self.assertEqual(self.poster(contenu=b"%PDF 2").status_code, 202)
        r = self.poster(contenu=b"%PDF 3")
        self.assertEqual(r.status_code, 503)
        self.assertIn("réessayez", r.get_json()["error"])
        self.assertEqual(len(list(Path(self.dossier.name).iterdir())), 2, "pas de fichier orphelin")

    def test_jeton_hors_tache_garde_l_ancien_suivi(self):
        self.monter(lanceur=Lanceur())
        self.espace["noter_progression"]("jeton-reanalyse-1", 40, "Analyse du CV")
        r = self.suivre("jeton-reanalyse-1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.get_json()["pct"], r.get_json()["etape"]), (40, "Analyse du CV"))


class Branchement(unittest.TestCase):
    def test_app_monte_le_gestionnaire_depuis_l_env(self):
        self.assertIn("TACHES_UPLOAD = GestionnaireTaches(max_simultanees=max_simultanees_depuis_env())", SOURCE_APP)
        self.assertNotIn("cv_data = process_cv(file_path, jeton=jeton)\n    except", SOURCE_APP)


if __name__ == "__main__":
    unittest.main()
