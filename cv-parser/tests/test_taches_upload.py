"""Gestionnaire de tâches de dépôt (taches_upload.py, issue #196).

Aucun HTTP, aucun DocIE, aucune attente réelle : le lanceur des tests garde
les cibles et le test les joue quand il veut ; l'horloge est injectée. Un seul
test utilise de vrais threads (événements, jamais de sleep) pour vérifier le
plafond sous concurrence réelle.
"""
import ast
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

import docie_client  # noqa: E402
import taches_upload as tu  # noqa: E402
from docie_client import DocIEError  # noqa: E402


class Lanceur:
    """Garde les cibles : le test décide quand chaque extraction « tourne »."""

    def __init__(self):
        self.cibles = []

    def __call__(self, cible):
        self.cibles.append(cible)

    def jouer(self, i=0):
        self.cibles.pop(i)()


def gestionnaire(**options):
    lanceur = options.pop("lanceur", None) or Lanceur()
    g = tu.GestionnaireTaches(lancer=lanceur, journal=lambda e: None, **options)
    return g, lanceur


def erreur_bridge(code, message="DocIE request failed (HTTP 500).", eta=None):
    """DocIEError telle que docie_bridge_extraction la lève (cause chaînée)."""
    class DocIEBridgeError(RuntimeError):
        def __init__(self):
            super().__init__(message)
            self.code, self.status, self.eta_seconds = code, None, eta
    try:
        try:
            raise DocIEBridgeError()
        except DocIEBridgeError as exc:
            raise DocIEError(f"DocIE (bridge) : {exc} [{code}]") from exc
    except DocIEError as e:
        return e


CODES_BRIDGE = sorted(tu.MESSAGES_BRIDGE)


class Plafond(unittest.TestCase):
    def test_defauts_annonces(self):
        self.assertEqual(tu.MAX_SIMULTANEES_DEFAUT, 2)
        self.assertEqual(tu.MAX_EN_ATTENTE, 20)
        self.assertEqual(tu.TTL_S, 30 * 60)
        g, _ = gestionnaire()
        self.assertEqual(g.max_simultanees, 2)

    def test_plafond_depuis_env(self):
        self.assertEqual(tu.VARIABLE_MAX_SIMULTANEES, "ADBI_EXTRACTION_MAX_CONCURRENT")
        self.assertEqual(tu.max_simultanees_depuis_env({}), 2)
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": ""}), 2)
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": "   "}), 2)
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": " 1 "}), 1)
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": "4"}), 4)
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": "16"}), 16)

    def test_plafond_depuis_env_valeurs_invalides(self):
        for mauvais in ("0", "-1", "deux", "2.5", "1e1", "0x2", "+3", "1_0", "17", "20", "٣"):
            with self.assertRaises(ValueError, msg=mauvais) as ctx:
                tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": mauvais})
            self.assertIn("ADBI_EXTRACTION_MAX_CONCURRENT doit être un entier entre 1 et 16", str(ctx.exception))
            self.assertIn(repr(mauvais), str(ctx.exception))

    def test_ancien_nom_toujours_lu(self):
        # ADBI_UPLOAD_MAX_CONCURRENT (PR #202) : un .env existant garde son réglage.
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_UPLOAD_MAX_CONCURRENT": "1"}), 1)
        self.assertEqual(tu.max_simultanees_depuis_env({"ADBI_UPLOAD_MAX_CONCURRENT": " 3 "}), 3)
        # Le nouveau nom l'emporte dès qu'il est renseigné ; vide, il laisse l'alias.
        self.assertEqual(tu.max_simultanees_depuis_env(
            {"ADBI_EXTRACTION_MAX_CONCURRENT": "1", "ADBI_UPLOAD_MAX_CONCURRENT": "3"}), 1)
        self.assertEqual(tu.max_simultanees_depuis_env(
            {"ADBI_EXTRACTION_MAX_CONCURRENT": "", "ADBI_UPLOAD_MAX_CONCURRENT": "3"}), 3)
        # L'alias est validé de la même façon, et l'erreur nomme la variable lue.
        with self.assertRaises(ValueError) as ctx:
            tu.max_simultanees_depuis_env({"ADBI_UPLOAD_MAX_CONCURRENT": "0"})
        self.assertIn("ADBI_UPLOAD_MAX_CONCURRENT doit être un entier entre 1 et 16", str(ctx.exception))

    def _plafond(self, n):
        g, lanceur = gestionnaire(max_simultanees=n)
        ids = [g.creer(lambda j: "ok", "u1") for _ in range(5)]
        self.assertEqual(len(lanceur.cibles), n)
        self.assertEqual(g.statistiques(), {"en_cours": n, "en_attente": 5 - n, "conservees": 5})
        for k, jeton in enumerate(ids[n:]):
            vue = g.obtenir(jeton, "u1")
            self.assertEqual((vue["etat"], vue["position"]), ("en_cours", k + 1))
        # Chaque fin libère exactement un créneau, jamais plus de n à la fois.
        while lanceur.cibles:
            self.assertLessEqual(len(lanceur.cibles), n)
            lanceur.jouer()
        self.assertEqual(g.statistiques()["en_cours"], 0)
        self.assertTrue(all(g.obtenir(j, "u1")["etat"] == "terminee" for j in ids))

    def test_plafond_2(self):
        self._plafond(2)

    def test_plafond_surcharge_par_env(self):
        self._plafond(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": "1"}))
        self._plafond(tu.max_simultanees_depuis_env({"ADBI_EXTRACTION_MAX_CONCURRENT": "3"}))
        self._plafond(tu.max_simultanees_depuis_env({"ADBI_UPLOAD_MAX_CONCURRENT": "1"}))

    def test_demarrage_d_app_py_lit_l_env_et_echoue_sur_valeur_invalide(self):
        # La ligne d'app.py qui monte le gestionnaire, exécutée telle quelle (elle
        # tourne à l'import du module, donc au démarrage de gunicorn).
        source = (RACINE / "app.py").read_text(encoding="utf-8")
        ligne = next(l for l in source.splitlines() if l.startswith("TACHES_UPLOAD = "))

        def demarrer(**env):
            espace = {"GestionnaireTaches": tu.GestionnaireTaches,
                      "max_simultanees_depuis_env": tu.max_simultanees_depuis_env}
            complet = {"ADBI_EXTRACTION_MAX_CONCURRENT": "", "ADBI_UPLOAD_MAX_CONCURRENT": "", **env}
            with mock.patch.dict(os.environ, complet):
                exec(ligne, espace)
            return espace["TACHES_UPLOAD"].max_simultanees

        self.assertEqual(demarrer(), 2)
        self.assertEqual(demarrer(ADBI_EXTRACTION_MAX_CONCURRENT="3"), 3)
        self.assertEqual(demarrer(ADBI_UPLOAD_MAX_CONCURRENT="1"), 1)
        with self.assertRaises(ValueError):
            demarrer(ADBI_EXTRACTION_MAX_CONCURRENT="deux")

    def test_vrais_threads_jamais_plus_que_le_plafond(self):
        g = tu.GestionnaireTaches(max_simultanees=2, journal=lambda e: None)
        verrou, actifs, pic = threading.Lock(), [0], [0]
        liberer = threading.Event()
        demarres = [threading.Event() for _ in range(5)]
        finis = [threading.Event() for _ in range(5)]

        def travail(i):
            def f(_jeton):
                with verrou:
                    actifs[0] += 1
                    pic[0] = max(pic[0], actifs[0])
                demarres[i].set()
                try:
                    self.assertTrue(liberer.wait(5))
                    return i
                finally:
                    with verrou:
                        actifs[0] -= 1
                    finis[i].set()
            return f

        ids = [g.creer(travail(i), "u1") for i in range(5)]
        self.assertTrue(demarres[0].wait(5) and demarres[1].wait(5))
        self.assertEqual(g.statistiques()["en_attente"], 3)
        self.assertFalse(demarres[2].is_set())
        liberer.set()
        for e in finis:
            self.assertTrue(e.wait(5))
        # Le dernier _finir suit la fin du travail : on attend qu'il soit passé.
        for jeton in ids:
            for _ in range(500):
                if g.obtenir(jeton, "u1")["etat"] == "terminee":
                    break
                threading.Event().wait(0.01)
        self.assertEqual(pic[0], 2)
        self.assertEqual([g.obtenir(j, "u1")["resultat"] for j in ids], [0, 1, 2, 3, 4])


class Ordre(unittest.TestCase):
    def test_fifo(self):
        g, lanceur = gestionnaire()
        demarrees = []
        for i in range(6):
            g.creer(lambda j, i=i: demarrees.append(i), "u1")
        # Les deux premières ont un créneau ; on termine la SECONDE d'abord :
        # le créneau libéré va à la plus ancienne en attente (2), pas à la
        # dernière arrivée.
        lanceur.jouer(1)
        lanceur.jouer(0)
        while lanceur.cibles:
            lanceur.jouer(0)                 # ordre de lancement
        self.assertEqual(demarrees, [1, 0, 2, 3, 4, 5])

    def test_positions_suivent_l_ordre_d_arrivee(self):
        g, lanceur = gestionnaire()
        ids = [g.creer(lambda j: None, "u1") for _ in range(5)]
        self.assertEqual([g.obtenir(j, "u1").get("position") for j in ids], [None, None, 1, 2, 3])
        lanceur.jouer()
        self.assertEqual([g.obtenir(j, "u1").get("position") for j in ids[2:]], [None, 1, 2])


class Echec(unittest.TestCase):
    def test_echec_libere_le_creneau(self):
        g, lanceur = gestionnaire()

        def boum(_j):
            raise RuntimeError("boom")
        ida = g.creer(boum, "u1")
        g.creer(lambda j: "b", "u1")
        idc = g.creer(lambda j: "c", "u1")
        self.assertEqual(len(lanceur.cibles), 2)
        lanceur.jouer(0)
        self.assertEqual(g.obtenir(ida, "u1")["etat"], "echec")
        self.assertEqual(len(lanceur.cibles), 2, "la troisième a pris le créneau libéré")
        self.assertNotIn("position", g.obtenir(idc, "u1"))
        while lanceur.cibles:
            lanceur.jouer()
        self.assertEqual(g.statistiques()["en_cours"], 0)

    def test_base_exception_libere_aussi(self):
        g, lanceur = gestionnaire(max_simultanees=1)

        def sortie(_j):
            raise SystemExit(3)
        ida = g.creer(sortie, "u1")
        idb = g.creer(lambda j: "b", "u1")
        lanceur.jouer()
        self.assertEqual(g.obtenir(ida, "u1")["erreur"]["code"], "interne")
        lanceur.jouer()
        self.assertEqual(g.obtenir(idb, "u1")["resultat"], "b")

    def test_lanceur_en_panne_ne_bloque_pas(self):
        def panne(_cible):
            raise RuntimeError("can't start new thread")
        g = tu.GestionnaireTaches(lancer=panne, journal=lambda e: None)
        jeton = g.creer(lambda j: "x", "u1")
        self.assertEqual(g.obtenir(jeton, "u1")["erreur"]["code"], "interne")
        self.assertEqual(g.statistiques()["en_cours"], 0)


class Vue(unittest.TestCase):
    def test_transitions_et_forme(self):
        t = [1_789_000_000.0]
        g, lanceur = gestionnaire(maintenant=lambda: t[0])
        recu = []
        jeton = g.creer(lambda j: recu.append(j) or {"id": "cv-1"}, "u1")
        self.assertEqual(g.obtenir(jeton, "u1"), {
            "etat": "en_cours", "pct": 0, "etape": "Démarrage", "detail": "",
            "debut": "2026-09-10T00:26:40Z"})
        # Libellés du pipeline : fusionnés, l'état et le propriétaire restent.
        self.assertTrue(g.noter(jeton, 55, "Analyse du CV", "Envoi du document à DocIE"))
        vue = g.obtenir(jeton, "u1")
        self.assertEqual((vue["etat"], vue["pct"], vue["etape"], vue["detail"]),
                         ("en_cours", 55, "Analyse du CV", "Envoi du document à DocIE"))
        t[0] += 4
        lanceur.jouer()
        self.assertEqual(recu, [jeton], "le travail reçoit son jeton (progression)")
        self.assertEqual(g.obtenir(jeton, "u1"), {
            "etat": "terminee", "pct": 100, "etape": "Terminé", "detail": "",
            "resultat": {"id": "cv-1"},
            "debut": "2026-09-10T00:26:40Z", "fin": "2026-09-10T00:26:44Z"})
        self.assertFalse(g.noter("inconnu", 1, "x"))

    def test_jeton_client_repris_s_il_est_propre_et_libre(self):
        g, _ = gestionnaire(max_en_attente=100)
        propre = "2f1e0c1a-7d3b-4c7e-9a51-0c9b5e0d1f22"
        self.assertEqual(g.creer(lambda j: None, "u1", jeton=propre), propre)
        # Déjà pris (même par un autre) -> identifiant du serveur, sans écraser.
        autre = g.creer(lambda j: None, "u2", jeton=propre)
        self.assertNotEqual(autre, propre)
        self.assertIsNotNone(g.obtenir(propre, "u1"))
        for mauvais in (None, "", "court", "a" * 65, "../../etc", "a b c d e f", 42):
            j = g.creer(lambda j: None, "u1", jeton=mauvais)
            self.assertRegex(j, r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_proprietaire_obligatoire(self):
        g, _ = gestionnaire()
        for mauvais in (None, "", 0):
            with self.assertRaises(ValueError):
                g.creer(lambda j: None, mauvais)


class Isolation(unittest.TestCase):
    def test_seul_l_auteur_lit_sa_tache(self):
        g, lanceur = gestionnaire()
        jeton = g.creer(lambda j: {"name": "Alice"}, "u1")
        lanceur.jouer()
        self.assertEqual(g.obtenir(jeton, "u1")["resultat"], {"name": "Alice"})
        for autre in ("u2", "", None, "U1", "local"):
            self.assertIsNone(g.obtenir(jeton, autre), autre)
        # Même réponse qu'un jeton inconnu : l'existence n'est pas confirmée.
        self.assertEqual(g.obtenir(jeton, "u2"), g.obtenir("jamais-vu-0000", "u2"))


class Expiration(unittest.TestCase):
    def test_ttl_sur_les_taches_finies_seulement(self):
        t = [1000.0]
        g, lanceur = gestionnaire(maintenant=lambda: t[0])
        longue = g.creer(lambda j: "tard", "u1")
        courte = g.creer(lambda j: "vite", "u1")
        attente = g.creer(lambda j: "attente", "u1")
        lanceur.jouer(1)                 # courte finit ; attente prend le créneau
        t[0] += tu.TTL_S - 1
        self.assertEqual(g.obtenir(courte, "u1")["etat"], "terminee")
        t[0] += 1
        self.assertIsNone(g.obtenir(courte, "u1"))
        self.assertEqual(g.statistiques()["conservees"], 2, "mémoire rendue, pas seulement masquée")
        t[0] += 10 * tu.TTL_S            # en cours depuis bien plus que le TTL : toujours là
        self.assertEqual(g.obtenir(longue, "u1")["etat"], "en_cours")
        self.assertEqual(g.obtenir(attente, "u1")["etat"], "en_cours")
        lanceur.jouer(0)
        t[0] += tu.TTL_S - 1
        self.assertEqual(g.obtenir(longue, "u1")["resultat"], "tard")
        t[0] += 1
        self.assertIsNone(g.obtenir(longue, "u1"))

    def test_attente_longue_jamais_purgee(self):
        t = [0.0]
        g, lanceur = gestionnaire(max_simultanees=1, maintenant=lambda: t[0])
        g.creer(lambda j: None, "u1")
        en_file = g.creer(lambda j: "enfin", "u1")
        t[0] += 5 * tu.TTL_S
        self.assertEqual(g.obtenir(en_file, "u1")["position"], 1)
        lanceur.jouer()
        lanceur.jouer()
        self.assertEqual(g.obtenir(en_file, "u1")["resultat"], "enfin")

    def test_purge_a_la_creation(self):
        t = [0.0]
        g, lanceur = gestionnaire(maintenant=lambda: t[0])
        for _ in range(2):
            g.creer(lambda j: None, "u1")
        while lanceur.cibles:
            lanceur.jouer()
        t[0] += tu.TTL_S
        g.creer(lambda j: None, "u1")
        self.assertEqual(g.statistiques()["conservees"], 1)


class Cle(unittest.TestCase):
    """Une seule tâche inachevée par clé (ré-analyse d'une même fiche)."""

    def test_refus_tant_que_la_premiere_n_est_pas_finie(self):
        g, lanceur = gestionnaire(max_simultanees=1)
        g.creer(lambda j: "autre", "u1")                       # occupe le créneau
        premiere = g.creer(lambda j: "r1", "u1", cle="fiche:42")
        # En attente : déjà inachevée -> refus, pour tout auteur.
        for auteur in ("u1", "u2"):
            with self.assertRaises(tu.TacheDejaEnCours):
                g.creer(lambda j: "r2", auteur, cle="fiche:42")
        g.creer(lambda j: "ailleurs", "u1", cle="fiche:43")    # autre fiche : accepté
        g.creer(lambda j: "sans cle", "u1")
        lanceur.jouer()
        with self.assertRaises(tu.TacheDejaEnCours):           # en cours : toujours refusé
            g.creer(lambda j: "r2", "u1", cle="fiche:42")
        lanceur.jouer()
        self.assertEqual(g.obtenir(premiere, "u1")["resultat"], "r1")
        g.creer(lambda j: "r2", "u1", cle="fiche:42")          # finie : de nouveau accepté
        # fiche:43 a pris le créneau ; restent « sans cle » et la nouvelle.
        self.assertEqual(g.statistiques()["en_attente"], 2)

    def test_echec_libere_la_cle(self):
        g, lanceur = gestionnaire()

        def boum(_j):
            raise RuntimeError("x")
        g.creer(boum, "u1", cle="fiche:1")
        lanceur.jouer()
        g.creer(lambda j: None, "u1", cle="fiche:1")

    def test_refus_ne_consomme_rien(self):
        g, _ = gestionnaire()
        g.creer(lambda j: None, "u1", cle="fiche:1")
        avant = g.statistiques()
        with self.assertRaises(tu.TacheDejaEnCours):
            g.creer(lambda j: None, "u1", cle="fiche:1", jeton="jeton-refuse-0001")
        self.assertEqual(g.statistiques(), avant)
        self.assertIsNone(g.obtenir("jeton-refuse-0001", "u1"))


class FilePleine(unittest.TestCase):
    def test_file_bornee(self):
        g, lanceur = gestionnaire()
        for _ in range(2 + tu.MAX_EN_ATTENTE):
            g.creer(lambda j: None, "u1")
        self.assertEqual(g.statistiques(), {"en_cours": 2, "en_attente": 20, "conservees": 22})
        with self.assertRaises(tu.FileTachesPleine) as ctx:
            g.creer(lambda j: None, "u1")
        self.assertIn("20 maximum", str(ctx.exception))
        self.assertEqual(g.statistiques(), {"en_cours": 2, "en_attente": 20, "conservees": 22})
        lanceur.jouer()
        g.creer(lambda j: None, "u1")    # une place s'est libérée
        self.assertEqual(g.statistiques()["en_attente"], 20)


class Erreurs(unittest.TestCase):
    def test_codes_du_bridge_releves_dans_le_bridge(self):
        source = (RACINE.parent / "document-parsing/bridge/docie_bridge.py").read_text(encoding="utf-8")
        releves = set()
        for n in ast.walk(ast.parse(source)):
            if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "fail" and n.args \
                    and isinstance(n.args[0], ast.Constant):
                releves.add(n.args[0].value)
            if isinstance(n, ast.Dict) and all(isinstance(k, ast.Constant) and isinstance(k.value, int)
                                               for k in n.keys) and n.keys:
                releves.update(v.value for v in n.values if isinstance(v, ast.Constant))
        self.assertEqual(releves, set(tu.MESSAGES_BRIDGE))

    def test_chaque_code_du_bridge(self):
        messages = set()
        for code in CODES_BRIDGE:
            m = tu.mapper_erreur(erreur_bridge(code, eta=99))
            self.assertEqual(m["code"], code)
            self.assertNotIn("DocIE request failed", m["message"])
            if code != "loading":
                self.assertNotIn("eta_seconds", m)
            messages.add(m["message"])
        self.assertEqual(len(messages), len(CODES_BRIDGE))
        self.assertEqual(tu.mapper_erreur(erreur_bridge("code_futur"))["code"], "interne")

    def test_loading_bridge(self):
        self.assertEqual(tu.mapper_erreur(erreur_bridge("loading", eta=12.2)), {
            "code": "loading", "message": "Modèle en cours de chargement, réessayez dans ~13 s.",
            "eta_seconds": 13})
        for eta in (None, -1, float("nan"), float("inf"), "30", True):
            m = tu.mapper_erreur(erreur_bridge("loading", eta=eta))
            self.assertEqual(m, {"code": "loading", "message": tu.MESSAGES_BRIDGE["loading"]}, repr(eta))

    def test_erreur_metier_rendue_telle_quelle(self):
        self.assertEqual(tu.mapper_erreur(tu.ErreurTache("CV introuvable")),
                         {"code": "input", "message": "CV introuvable"})
        self.assertEqual(tu.mapper_erreur(tu.ErreurTache("x", code="introuvable"))["code"], "introuvable")

    def test_client_historique_et_reste(self):
        msg = "DocIE injoignable ou délai réseau dépassé. Vérifiez la connexion."
        self.assertEqual(tu.mapper_erreur(DocIEError(msg)), {"code": "extraction", "message": msg})
        chemin = DocIEError("Document introuvable ou illisible : [Errno 2] No such file: 'C:\\srv\\uploads\\x.pdf'")
        self.assertEqual(tu.mapper_erreur(chemin),
                         {"code": "extraction", "message": "Document introuvable ou illisible."})
        for e in (RuntimeError("x"), KeyError("k"), SystemExit(1), None, "chaine"):
            self.assertEqual(tu.mapper_erreur(e), {"code": "interne", "message": tu.MESSAGE_INTERNE})

    def test_seuls_messages_dynamiques_connus_du_client(self):
        """Tout `raise DocIEError(f"…")` recopie une valeur : chacun est connu ici.

        Un nouveau message à valeur dynamique (texte amont, chemin) devra être
        examiné avant d'arriver dans `erreur.message`.
        """
        connus = {
            # `key` parcourt un tuple de noms de champs écrit dans map_resume.
            ("docie_client.py", "Plateforme d'inférence interne : champ "),
            ("docie_bridge_extraction.py", "Document introuvable ou illisible : "),
            ("docie_bridge_extraction.py", ""),     # f"{message} [{exc.code}]" : cause bridge
            # Transport externe (#194, modèle HORS ADBI choisi explicitement) :
            # `message` vient d'une table FR FIXE (docie_client._MESSAGES_EXTERNE)
            # et `code` est le code stable du transport. Le texte de l'exception
            # amont n'y entre jamais — c'est précisément ce que ce test protège.
            ("docie_client.py", "Service externe (hors ADBI) : "),
        }
        trouves = set()
        for nom in ("docie_client.py", "docie_bridge_extraction.py"):
            for n in ast.walk(ast.parse((RACINE / nom).read_text(encoding="utf-8"))):
                if isinstance(n, ast.Raise) and isinstance(n.exc, ast.Call) \
                        and getattr(n.exc.func, "id", None) == "DocIEError" and n.exc.args:
                    arg = n.exc.args[0]
                    if isinstance(arg, ast.JoinedStr):
                        tete = arg.values[0].value if isinstance(arg.values[0], ast.Constant) else ""
                        trouves.add((nom, tete))
                    elif not isinstance(arg, ast.Constant):
                        trouves.add((nom, ast.unparse(arg)))
        self.assertEqual(trouves, connus)

    def test_aucun_secret_dans_la_vue_et_journal_serveur(self):
        secret = "sk-docie-SECRET-4242 upstream said: /etc/passwd"
        journal = []
        lanceur = Lanceur()
        g = tu.GestionnaireTaches(lancer=lanceur, journal=journal.append, max_en_attente=100)
        erreurs = [erreur_bridge(c, secret, 5) for c in CODES_BRIDGE] + [
            erreur_bridge(secret, secret), RuntimeError(secret), KeyError(secret), TypeError(secret)]
        ids = []
        for e in erreurs:
            def boum(_j, e=e):
                raise e
            ids.append(g.creer(boum, "u1"))
        while lanceur.cibles:
            lanceur.jouer()
        for jeton in ids:
            vue = g.obtenir(jeton, "u1")
            self.assertEqual(vue["etat"], "echec")
            self.assertNotIn("SECRET", repr(vue))
            self.assertNotIn("passwd", repr(vue))
        self.assertEqual(len(journal), len(erreurs))


if __name__ == "__main__":
    unittest.main()
