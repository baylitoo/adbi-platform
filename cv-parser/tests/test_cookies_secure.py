"""Les cookies JWT portent `Secure` dès que le navigateur est en HTTPS.

`_set_cookies` posait `httponly` et `samesite` mais jamais `secure` : sur un
déploiement public, `adbi_access` et `adbi_refresh` restaient envoyables en
clair. Le correctif ne pose pas `secure=True` en dur — ce serait casser le
déploiement actuel, qui est en HTTP : le navigateur cesserait de renvoyer le
cookie et plus personne ne pourrait se connecter. Il suit le schéma RÉEL.

Ce que ce fichier mesure :
  1. en HTTP nu, aucun `Secure` — le déploiement actuel continue de marcher ;
  2. derrière un proxy TLS (`X-Forwarded-Proto: https`), `Secure` est posé —
     c'est le cas de Coolify, où `request.is_secure` vaut toujours False ;
  3. en HTTPS direct (sans proxy), `Secure` est posé aussi ;
  4. `httponly` et `samesite` ne sont jamais perdus au passage ;
  5. la suppression (déconnexion) emploie les mêmes attributs — sinon le
     navigateur ne remplace pas le cookie et le jeton survit.

`api/auth_bp.py` s'importe sans PostgreSQL (la connexion de `core/pg.py` est
paresseuse : `psycopg.connect` n'est appelé que dans `get_conn`), d'où un test
Flask direct plutôt que l'extraction `ast` de test_champs_conserves.py.
"""
import ast
import sys
import unittest
from pathlib import Path

from flask import Flask, make_response

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

import api.auth_bp as auth_bp  # noqa: E402

app = Flask(__name__)


def _code_seul(chemin, sauf=()):
    """Le CODE d'un module, commentaires retirés, fonctions `sauf` exclues.

    `ast.unparse` ne réémet pas les commentaires : chercher une chaîne dans ce
    rendu mesure ce que le programme FAIT, pas ce que ses commentaires disent.
    Sans ça, un bloc qui nomme un en-tête pour expliquer qu'il le refuse ferait
    rougir l'assertion qui vérifie justement qu'il ne le lit pas.
    """
    arbre = ast.parse(Path(chemin).read_text(encoding="utf-8"))
    arbre.body = [n for n in arbre.body
                  if not (isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                          and n.name in sauf)]
    return ast.unparse(arbre)


def _entetes(base_url="http://localhost/", **entetes):
    """Les en-têtes `Set-Cookie` produits par `_set_cookies`."""
    with app.test_request_context(base_url=base_url, headers=entetes):
        resp = auth_bp._set_cookies(make_response(""), "jeton-acces", "jeton-refresh")
        return resp.headers.getlist("Set-Cookie")


def _entetes_suppression(base_url="http://localhost/", **entetes):
    with app.test_request_context(base_url=base_url, headers=entetes):
        resp = auth_bp._clear_cookies(make_response(""))
        return resp.headers.getlist("Set-Cookie")


class SchemaPublicTests(unittest.TestCase):
    """`_schema_public` : ce que voit le navigateur, pas ce que voit Flask."""

    def _schema(self, base_url="http://localhost/", **entetes):
        with app.test_request_context(base_url=base_url, headers=entetes):
            return auth_bp._schema_public()

    def test_http_nu(self):
        self.assertEqual(self._schema(), "http")

    def test_https_direct(self):
        self.assertEqual(self._schema(base_url="https://exemple.fr/"), "https")

    def test_derriere_un_proxy_tls(self):
        """Le cas Coolify : Flask se croit en HTTP, le navigateur est en HTTPS."""
        self.assertEqual(
            self._schema(**{"X-Forwarded-Proto": "https"}), "https")

    def test_chaine_de_proxys_le_premier_element_gagne(self):
        """« https,http » : le client a vu HTTPS, le reste est interne."""
        self.assertEqual(
            self._schema(**{"X-Forwarded-Proto": "https, http"}), "https")

    def test_un_entete_absurde_retombe_sur_le_schema_reel(self):
        """Rien n'est deviné : une valeur hors (http, https) est ignorée."""
        self.assertEqual(
            self._schema(**{"X-Forwarded-Proto": "gopher"}), "http")
        self.assertEqual(
            self._schema(base_url="https://exemple.fr/",
                         **{"X-Forwarded-Proto": "gopher"}), "https")

    def test_un_proxy_qui_annonce_http_ne_durcit_pas(self):
        self.assertEqual(self._schema(**{"X-Forwarded-Proto": "http"}), "http")


class CookiesPosesTests(unittest.TestCase):

    def test_en_http_aucun_secure(self):
        """Le déploiement actuel est en HTTP : poser `Secure` le casserait."""
        for entete in _entetes():
            with self.subTest(cookie=entete.split("=")[0]):
                self.assertNotIn("Secure", entete)

    def test_derriere_un_proxy_tls_les_deux_cookies_sont_secure(self):
        entetes = _entetes(**{"X-Forwarded-Proto": "https"})
        self.assertEqual(len(entetes), 2)
        for entete in entetes:
            with self.subTest(cookie=entete.split("=")[0]):
                self.assertIn("Secure", entete)

    def test_en_https_direct_aussi(self):
        for entete in _entetes(base_url="https://exemple.fr/"):
            with self.subTest(cookie=entete.split("=")[0]):
                self.assertIn("Secure", entete)

    def test_httponly_et_samesite_ne_sont_jamais_perdus(self):
        """Le correctif ajoute un attribut, il n'en remplace aucun."""
        for base, entetes_requete in (("http://localhost/", {}),
                                      ("http://localhost/", {"X-Forwarded-Proto": "https"}),
                                      ("https://exemple.fr/", {})):
            for entete in _entetes(base, **entetes_requete):
                with self.subTest(base=base, cookie=entete.split("=")[0]):
                    self.assertIn("HttpOnly", entete)
                    self.assertIn("SameSite=Lax", entete)

    def test_les_chemins_restent_distincts(self):
        """`adbi_refresh` n'est envoyé qu'à la route de rafraîchissement."""
        entetes = " | ".join(_entetes(**{"X-Forwarded-Proto": "https"}))
        self.assertIn("adbi_access", entetes)
        self.assertIn("Path=/api/auth/refresh", entetes)


class CookiesSupprimesTests(unittest.TestCase):
    """Déconnexion : des attributs discordants laissent le jeton en place."""

    def test_la_suppression_est_secure_derriere_tls(self):
        for entete in _entetes_suppression(**{"X-Forwarded-Proto": "https"}):
            with self.subTest(cookie=entete.split("=")[0]):
                self.assertIn("Secure", entete)

    def test_la_suppression_reste_sans_secure_en_http(self):
        for entete in _entetes_suppression():
            with self.subTest(cookie=entete.split("=")[0]):
                self.assertNotIn("Secure", entete)

    def test_la_suppression_garde_les_memes_chemins(self):
        entetes = " | ".join(_entetes_suppression())
        self.assertIn("Path=/api/auth/refresh", entetes)
        self.assertIn("adbi_access", entetes)


class DecisionProxyFixTests(unittest.TestCase):
    """La décision documentée sur `X-Forwarded-For` reste intacte.

    `auth_bp.py` refuse explicitement `ProxyFix` pour l'étranglement des
    tentatives de connexion : `X-Forwarded-For` est falsifiable et rendrait la
    limite contournable. Ce correctif ne lit QUE `X-Forwarded-Proto`, dont la
    falsification ne peut que durcir le cookie. Si quelqu'un ajoute un jour
    ProxyFix, que ce soit une décision prise, pas un effet de bord de cette
    PR.
    """

    def test_aucun_proxyfix_n_a_ete_introduit(self):
        self.assertNotIn("ProxyFix", _code_seul(RACINE / "app.py"))
        self.assertNotIn("ProxyFix", _code_seul(RACINE / "api/auth_bp.py",
                                                sauf=("_schema_public",)))

    def test_la_limite_de_tentatives_ne_lit_pas_x_forwarded_for(self):
        """Mesuré sur le CODE, pas sur le texte.

        Le bloc anti brute-force NOMME `X-Forwarded-For` dans son commentaire,
        pour expliquer pourquoi il le refuse : chercher la chaîne dans le
        fichier brut trouverait cette prose et rougirait à tort. `ast.unparse`
        laisse tomber les commentaires ; `_schema_public` est exclu, sa
        docstring citant délibérément les deux en-têtes.
        """
        code = _code_seul(RACINE / "api/auth_bp.py", sauf=("_schema_public",))
        self.assertNotIn("X-Forwarded-For", code)
        # Et le correctif, lui, lit bien le seul en-tête qu'il revendique.
        self.assertIn("X-Forwarded-Proto",
                      (RACINE / "api/auth_bp.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
