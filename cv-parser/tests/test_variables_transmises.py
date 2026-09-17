"""Toute variable documentée ET lue doit être TRANSMISE au conteneur (piège #164).

Le dépôt nomme ce piège une demi-douzaine de fois dans ses commentaires : une
variable listée dans `.env.example` mais absente du bloc `environment:` du
service n'atteint jamais le conteneur. L'opérateur la renseigne, rien ne change,
et rien ne le signale.

Deux occurrences VIVANTES trouvées en écrivant ce test, toutes deux sur le
chemin d'authentification, toutes deux silencieuses :

  ADBI_COOKIE_DOMAIN  lue par config.py:38, transmise par AUCUN compose.
                      Vide -> `_portee_cookie()` rend {} -> le cookie de session
                      reste « host-only » chez cv-parser -> les quatre services
                      Node de #245 ne le reçoivent jamais.

  ADBI_FACTORY_URL    lue par config.py:47, présente seulement dans le bloc de
                      `factory`. Vide -> `_retour_apres_connexion()` rend "/"
                      (app.py:1896) -> le `next` du hub est silencieusement
                      abandonné après connexion.

La règle vérifiée ici est étroite et mécanique : pour cv-parser, l'intersection
de « documentée à la racine » et « lue par config.py » doit être incluse dans
les clés du bloc `environment:`, dans les DEUX composes.

Pas de PyYAML : il n'est pas dans requirements.txt, et CI n'installe que
celui-ci plus pytest. Analyse ligne à ligne, comme les tests de garde des
services Node.
"""
import re
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
COMPOSES = ("docker-compose.yml", "docker-compose.local.yml")


def variables_documentees(chemin):
    """Noms déclarés dans un .env.example (`NOM=`), commentaires ignorés."""
    noms = set()
    for ligne in chemin.read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if not ligne or ligne.startswith("#"):
            continue
        trouve = re.match(r"^([A-Z][A-Z0-9_]*)=", ligne)
        if trouve:
            noms.add(trouve.group(1))
    return noms


def variables_lues(chemin):
    """Noms lus par os.environ dans config.py."""
    texte = chemin.read_text(encoding="utf-8")
    return set(re.findall(r"os\.environ(?:\.get)?\(?\[?[\"']([A-Z][A-Z0-9_]*)[\"']", texte))


def env_du_service(chemin, service):
    """Clés du bloc `environment:` d'un service, sans PyYAML.

    Le bloc s'arrête au prochain service (indenté de 2) OU à une clé de premier
    niveau en colonne 0 (`volumes:`) : sans cette seconde condition, le dernier
    service du fichier avalerait ce qui le suit.
    """
    lignes = chemin.read_text(encoding="utf-8").splitlines()
    debut = next((i for i, l in enumerate(lignes) if l.rstrip() == f"  {service}:"), None)
    if debut is None:
        return None

    fin = len(lignes)
    for i in range(debut + 1, len(lignes)):
        if re.match(r"^ {2}\S", lignes[i]) or re.match(r"^\S", lignes[i]):
            fin = i
            break
    bloc = lignes[debut:fin]

    i_env = next((i for i, l in enumerate(bloc) if l.strip() == "environment:"), None)
    if i_env is None:
        return set()

    cles = set()
    for ligne in bloc[i_env + 1:]:
        if ligne.strip() and not re.match(r"^ {6}\S", ligne):
            break  # fin du bloc environment (indentation remontée)
        trouve = re.match(r"^ {6}([A-Z][A-Z0-9_]*):", ligne)
        if trouve:
            cles.add(trouve.group(1))
    return cles


class VariablesTransmises(unittest.TestCase):
    def setUp(self):
        self.documentees = variables_documentees(RACINE / ".env.example")
        self.lues = variables_lues(RACINE / "cv-parser" / "config.py")

    def test_les_deux_sources_sont_lisibles(self):
        """Sans cette garde, une regex cassée rendrait les tests suivants vides
        — donc verts — et le piège #164 repasserait inaperçu."""
        self.assertGreater(len(self.documentees), 20, ".env.example racine illisible")
        self.assertGreater(len(self.lues), 10, "config.py illisible")
        self.assertIn("ADBI_JWT_SECRET", self.documentees)
        self.assertIn("ADBI_COOKIE_DOMAIN", self.lues)

    def test_toute_variable_documentee_et_lue_est_transmise(self):
        attendues = self.documentees & self.lues
        self.assertGreater(len(attendues), 3, "intersection suspecte : regex à revoir")

        for compose in COMPOSES:
            with self.subTest(compose=compose):
                env = env_du_service(RACINE / compose, "cv-parser")
                self.assertIsNotNone(env, f"{compose} : service cv-parser introuvable")
                manquantes = sorted(attendues - env)
                self.assertEqual(
                    manquantes, [],
                    f"{compose} : documentée(s) dans .env.example et lue(s) par "
                    f"config.py, mais JAMAIS transmise(s) au conteneur "
                    f"cv-parser : {manquantes} — piège #164",
                )

    def test_les_deux_variables_du_chemin_d_authentification(self):
        """Régression nommée : les deux occurrences vivantes trouvées ici.

        Le test général ci-dessus les couvre ; celui-ci les nomme pour qu'un
        retrait échoue avec le bon message plutôt qu'avec une liste générique.
        """
        for compose in COMPOSES:
            env = env_du_service(RACINE / compose, "cv-parser")
            with self.subTest(compose=compose):
                self.assertIn("ADBI_COOKIE_DOMAIN", env,
                              "sans elle, le cookie reste host-only : #245 ne voit aucune session")
                self.assertIn("ADBI_FACTORY_URL", env,
                              "sans elle, le `next` du hub est abandonné après connexion (#254)")

    def test_factory_garde_sa_propre_url(self):
        """cv-parser VALIDE le `next`, factory l'ÉMET : les deux en ont besoin.

        Ajouter la variable chez cv-parser ne devait pas la retirer de factory.
        """
        for compose in COMPOSES:
            env = env_du_service(RACINE / compose, "factory")
            with self.subTest(compose=compose):
                self.assertIsNotNone(env, f"{compose} : service factory introuvable")
                self.assertIn("ADBI_FACTORY_URL", env)


if __name__ == "__main__":
    unittest.main()
