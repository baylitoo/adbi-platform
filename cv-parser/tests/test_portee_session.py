"""Portée de la session ADBI : domaine du cookie, et `next` validé à la connexion.

Deux mécanismes, une seule raison d'être (#245) : permettre aux services Node de
VÉRIFIER un jeton que seul cv-parser émet, sans ouvrir de redirection au passage.

Ce que ce fichier mesure :
  1. `ADBI_COOKIE_DOMAIN` vide -> AUCUN `Domain=` dans l'en-tête. C'est la
     garantie qu'un déploiement qui ne pose pas la variable ne voit rien
     changer — la propriété la plus importante de cette PR ;
  2. posée -> `Domain=` sur les DEUX cookies, et sur leur suppression (un
     cookie supprimé avec des attributs discordants n'est pas remplacé :
     la déconnexion laisserait le jeton vivant sur tous les services) ;
  3. `next` : liste blanche stricte sur l'ORIGINE d'ADBI_FACTORY_URL. Une page
     de connexion qui redirige vers une URL arbitraire est une redirection
     ouverte à l'endroit le pire possible ;
  4. le gabarit n'interpole pas la valeur brute dans son bloc <script>.

`api/auth_bp.py` s'importe sans PostgreSQL (connexion paresseuse dans
core/pg.py). `app.py`, lui, ouvre la base à l'import : `_retour_apres_connexion`
est donc extrait par `ast`, comme dans test_champs_conserves.py.
"""
import ast
import json
import sys
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, make_response, request

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

import api.auth_bp as auth_bp  # noqa: E402

app = Flask(__name__)


def _retour_avec(factory_url):
    """`_retour_apres_connexion` d'app.py, lié à un ADBI_FACTORY_URL donné."""
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    fonction = next(n for n in arbre.body
                    if isinstance(n, ast.FunctionDef) and n.name == "_retour_apres_connexion")
    espace = {"request": request, "urlsplit": urlsplit, "FACTORY_URL": factory_url}
    exec(compile(ast.unparse(fonction), str(RACINE / "app.py"), "exec"), espace)
    return espace["_retour_apres_connexion"]


def _entetes(domaine, base_url="http://localhost/"):
    """En-têtes Set-Cookie produits par `_set_cookies` pour un domaine donné."""
    origine = auth_bp.COOKIE_DOMAIN
    auth_bp.COOKIE_DOMAIN = domaine
    try:
        with app.test_request_context(base_url=base_url):
            resp = auth_bp._set_cookies(make_response(""), "acces", "refresh")
            return resp.headers.getlist("Set-Cookie")
    finally:
        auth_bp.COOKIE_DOMAIN = origine


def _entetes_suppression(domaine):
    origine = auth_bp.COOKIE_DOMAIN
    auth_bp.COOKIE_DOMAIN = domaine
    try:
        with app.test_request_context(base_url="http://localhost/"):
            resp = auth_bp._clear_cookies(make_response(""))
            return resp.headers.getlist("Set-Cookie")
    finally:
        auth_bp.COOKIE_DOMAIN = origine


class DomaineDuCookieTests(unittest.TestCase):

    def test_variable_vide_aucun_domaine_pose(self):
        """LA garantie de non-régression : sans la variable, rien ne change."""
        entetes = _entetes("")
        self.assertEqual(len(entetes), 2)
        for e in entetes:
            with self.subTest(cookie=e.split("=")[0]):
                self.assertNotIn("Domain", e)

    def test_variable_posee_les_deux_cookies_la_portent(self):
        entetes = _entetes("outils.adbi.fr")
        self.assertEqual(len(entetes), 2)
        for e in entetes:
            with self.subTest(cookie=e.split("=")[0]):
                self.assertIn("Domain=outils.adbi.fr", e)

    def test_un_domaine_sslip_a_cinq_etiquettes_est_accepte(self):
        """Forme des domaines générés par Coolify avant la bascule (#253).

        Adresse de DOCUMENTATION (RFC 5737, TEST-NET-1) : un jeu d'essai ne
        doit jamais figer l'adresse d'un serveur réel.
        """
        for e in _entetes("192.0.2.10.sslip.io"):
            self.assertIn("Domain=192.0.2.10.sslip.io", e)

    def test_les_autres_attributs_survivent(self):
        for domaine in ("", "outils.adbi.fr"):
            for e in _entetes(domaine):
                with self.subTest(domaine=domaine, cookie=e.split("=")[0]):
                    self.assertIn("HttpOnly", e)
                    self.assertIn("SameSite=Lax", e)

    def test_secure_reste_pilote_par_le_schema(self):
        """#246 n'est pas défait : `Secure` suit toujours X-Forwarded-Proto."""
        origine = auth_bp.COOKIE_DOMAIN
        auth_bp.COOKIE_DOMAIN = "outils.adbi.fr"
        try:
            with app.test_request_context(base_url="http://localhost/",
                                          headers={"X-Forwarded-Proto": "https"}):
                resp = auth_bp._set_cookies(make_response(""), "a", "r")
                for e in resp.headers.getlist("Set-Cookie"):
                    self.assertIn("Secure", e)
                    self.assertIn("Domain=outils.adbi.fr", e)
        finally:
            auth_bp.COOKIE_DOMAIN = origine

    def test_la_suppression_porte_le_meme_domaine(self):
        """Attributs discordants = cookie non remplacé = déconnexion sans effet."""
        for e in _entetes_suppression("outils.adbi.fr"):
            with self.subTest(cookie=e.split("=")[0]):
                self.assertIn("Domain=outils.adbi.fr", e)

    def test_la_suppression_sans_variable_ne_pose_pas_de_domaine(self):
        for e in _entetes_suppression(""):
            self.assertNotIn("Domain", e)


class RetourApresConnexionTests(unittest.TestCase):
    """`next` : liste blanche d'ORIGINE, jamais de comparaison par préfixe."""

    HUB = "https://outils.adbi.fr"

    def _resultat(self, next_param, factory_url=HUB):
        fonction = _retour_avec(factory_url)
        url = "/login" if next_param is None else f"/login?next={next_param}"
        with app.test_request_context(url):
            return fonction()

    def test_sans_next_racine(self):
        self.assertEqual(self._resultat(None), "/")

    def test_next_vide_racine(self):
        self.assertEqual(self._resultat(""), "/")

    def test_factory_url_non_posee_aucun_next_accepte(self):
        self.assertEqual(self._resultat(self.HUB, factory_url=""), "/")

    def test_origine_exacte_acceptee(self):
        self.assertEqual(self._resultat(self.HUB), self.HUB)

    def test_meme_origine_avec_chemin_acceptee(self):
        cible = self.HUB + "/module.html"
        self.assertEqual(self._resultat(cible), cible)

    def test_suffixe_trompeur_refuse(self):
        """Le cas qu'une comparaison par préfixe laisserait passer."""
        self.assertEqual(self._resultat("https://outils.adbi.fr.attaquant.test"), "/")

    def test_schema_different_refuse(self):
        self.assertEqual(self._resultat("http://outils.adbi.fr"), "/")

    def test_port_different_refuse(self):
        self.assertEqual(self._resultat("https://outils.adbi.fr:8443"), "/")

    def test_autre_hote_refuse(self):
        self.assertEqual(self._resultat("https://attaquant.test"), "/")

    def test_relative_au_protocole_refusee(self):
        """« //evil.test » hérite du schéma courant : ce n'est pas une URL locale."""
        self.assertEqual(self._resultat("//evil.test"), "/")

    def test_javascript_refuse(self):
        self.assertEqual(self._resultat("javascript:alert(1)"), "/")

    def test_chemin_relatif_refuse(self):
        """Seule l'origine du hub est acceptée : un chemin nu retombe sur "/"."""
        self.assertEqual(self._resultat("/app"), "/")


class GabaritConnexionTests(unittest.TestCase):
    """Le gabarit ne doit jamais interpoler `retour` brut dans <script>."""

    def _rendu(self, retour):
        from jinja2 import Environment, FileSystemLoader, select_autoescape
        env = Environment(loader=FileSystemLoader(str(RACINE / "templates")),
                          autoescape=select_autoescape(["html"]))
        env.globals["url_for"] = lambda point, **kw: "/static/" + kw.get("filename", "")
        return env.get_template("login.html").render(retour=retour)

    def test_la_destination_est_un_litteral_json(self):
        html = self._rendu("https://outils.adbi.fr")
        self.assertIn('window.location.href = "https://outils.adbi.fr"', html)

    def test_sans_retour_la_racine(self):
        html = self._rendu(None)
        self.assertIn('window.location.href = "/"', html)

    def test_aucune_interpolation_brute(self):
        """Une valeur hostile ressort ÉCHAPPÉE, pas exécutable.

        Première version de ce test : `assertNotIn('";alert(1);//"', html)`.
        Elle rougissait sur un rendu pourtant CORRECT
        (`window.location.href = "\\";alert(1);//";`) parce que le motif
        cherché est un sous-ensemble de la chaîne ÉCHAPPÉE — le test mesurait
        la présence de caractères, pas l'échappement.

        La bonne mesure est l'égalité avec le littéral JSON attendu : si
        `tojson` a échappé, le rendu est exactement `json.dumps(valeur)` et
        aucun guillemet ne peut clore la chaîne plus tôt.
        """
        charge = '";alert(1);//'
        html = self._rendu(charge)
        self.assertIn("window.location.href = " + json.dumps(charge), html)
        # Et la forme qui aurait permis l'évasion n'apparaît pas : un
        # guillemet fermant NON précédé d'une barre oblique inverse.
        self.assertNotIn('href = "";alert(1)', html)


if __name__ == "__main__":
    unittest.main()
