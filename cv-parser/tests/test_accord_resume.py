"""Accord des deux portages du mapping `resume` (#177).

`contract`, `kbis`, `rib` et `urssaf` ont chacun leur reference Python, leur
portage JS et des fixtures communes executees des deux cotes. `resume` n'avait
rien : l'inventaire #177 a mesure une douzaine de divergences reelles -- le meme
CV ne donnait pas les memes donnees selon le service -- corrigees une a une sans
qu'aucun test ne garde l'accord obtenu. Ce fichier est ce garde-fou.

Les deux chaines REELLES sont executees sur la MEME entree :

  * cv-parser : `map_resume` PUIS `normalize_cv_data`. La seconde est
    indispensable -- `map_resume` seule ne dit pas ce que le commercial voit --
    et elle est reprise de test_aller_retour_base.py (`APP`), qui l'extrait
    d'app.py par `ast` parce qu'importer app.py ouvre PostgreSQL. Importee, pas
    recopiee : une deuxieme copie de cette extraction serait exactement la
    duplication que ce test existe pour surveiller.
  * one-pager : `mapperAdbiResume`, appele sur la sortie du VRAI pont
    (`parseTextResponse`), donc sur des valeurs deja desenveloppees comme en
    production. Reimplementer le desenveloppage ici mesurerait autre chose.

Aucun reseau, aucune base, aucun appel a DocIE : les entrees sont la seule
reponse DocIE reelle conservee dans le depot, plus des cas synthetiques batis
sur le schema REELLEMENT SERVI (`dynamic_schema` de cette meme reponse).

La table de correspondance et les differences de forme assumees vivent dans
document-parsing/fixtures/accord_resume.json, avec une `preuve` par ligne.
"""
import json
import subprocess
import sys
import unicodedata
import unittest
from pathlib import Path

ICI = Path(__file__).resolve().parent
RACINE = ICI.parents[1]
sys.path.insert(0, str(ICI))
sys.path.insert(0, str(ICI.parent))

from docie_client import map_resume  # noqa: E402
from test_aller_retour_base import APP  # noqa: E402

FIXTURE = json.loads(
    (RACINE / "document-parsing" / "fixtures" / "accord_resume.json").read_text(encoding="utf-8")
)
ECHANTILLONS = RACINE / "document-parsing" / "fixtures"
PONT_JS = RACINE / "document-parsing" / "bridge" / "docie-bridge.js"
MAPPEUR_JS = RACINE / "one-pager" / "lib" / "docie-extract.js"

# Un seul appel node pour tous les cas : meme raison que
# document-parsing/models/tests/test_catalogue.py, dont ce script reprend la
# convention (charge utile sur l'entree standard, racine en process.argv[1] --
# sous `node -e` il n'y a pas de chemin de script dans argv).
SCRIPT_JS = r"""
const R = process.argv[1].replace(/\\/g, "/") + "/";
const pont = require(R + "document-parsing/bridge/docie-bridge.js");
const { mapperAdbiResume } = require(R + "one-pager/lib/docie-extract.js");
const entree = JSON.parse(require("fs").readFileSync(0, "utf8"));
const sorties = entree.reponses.map((corps) => {
  const { result, metadata } = pont.parseTextResponse(corps, corps.schema_name || "resume");
  return mapperAdbiResume(result, metadata, { filename: "cv.pdf" });
});
process.stdout.write(JSON.stringify(sorties));
"""


def _sans_marques(texte):
    """Majuscules, NFD, marques de categorie M retirees — meme normalisation
    que document-parsing/fixtures/nom_docie.json."""
    forme = unicodedata.normalize("NFD", str(texte if texte is not None else "")).upper()
    return "".join(c for c in forme if not unicodedata.category(c).startswith("M")).strip()


def _national(numero):
    chiffres = "".join(c for c in str(numero or "") if c.isdigit())
    if chiffres.startswith("33"):
        chiffres = chiffres[2:]
    elif chiffres.startswith("0"):
        chiffres = chiffres[1:]
    return chiffres[-9:]


def _egal(regle, a, b):
    if regle == "exact":
        return str(a if a is not None else "").strip() == str(b if b is not None else "").strip()
    if regle == "casse":
        return _sans_marques(a) == _sans_marques(b)
    if regle == "nombre":
        return (a or 0) == (b or 0)
    if regle == "telephone_fr":
        return _national(a) == _national(b)
    if regle == "liste_normalisee":
        propre = lambda liste: sorted(_sans_marques(x) for x in (liste or []) if str(x).strip())  # noqa: E731
        return propre(a) == propre(b)
    raise AssertionError("regle inconnue dans la fixture : " + str(regle))


def _valeur(racine, chemin):
    """Resout « contact.location.city » ou « experience[].company ».

    Pour un chemin de liste, rend la liste des valeurs, dans l'ordre : comparer
    rang par rang verifie aussi que les deux ports ont trie pareil.
    """
    if "[]." in chemin:
        cle, reste = chemin.split("[].", 1)
        return [_valeur(element, reste) for element in (racine.get(cle) or [])]
    courant = racine
    for morceau in chemin.split("."):
        if not isinstance(courant, dict):
            return None
        courant = courant.get(morceau)
    return courant


def _fiche_python(reponse):
    attendu = reponse.get("schema_name") or "resume"
    return APP["normalize_cv_data"](map_resume(reponse, expected_schema=attendu))


def _node_disponible():
    try:
        sonde = subprocess.run(["node", "-e", "0"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as erreur:
        return "node introuvable : " + str(erreur)
    if sonde.returncode != 0:
        return "node indisponible : " + (sonde.stderr or "")
    if not MAPPEUR_JS.exists() or not PONT_JS.exists():
        return "portage JS absent de ce checkout : " + str(MAPPEUR_JS)
    return None


def _cv_masters(reponses):
    """Sorties one-pager pour toutes les reponses, dans l'ordre.

    `check=True` a dessein : un script JS casse doit FAIRE ECHOUER ce test, pas
    le faire sauter. On ne saute que si node lui-meme manque (voir
    `_node_disponible`) — meme correction que l'execution croisee de
    contrats/tests/siren-siret.test.js, ou sauter sur tout statut non nul
    masquait un validateur casse en « interpreteur indisponible ».
    """
    sortie = subprocess.run(
        ["node", "-e", SCRIPT_JS, str(RACINE)],
        input=json.dumps({"reponses": reponses}),
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=300,
    )
    return json.loads(sortie.stdout)


def _reponses_de_la_fixture():
    reponses, noms = [], []
    for cas in FIXTURE["cas"]:
        if "fichier" in cas:
            chemin = ECHANTILLONS / cas["fichier"]
            reponses.append(json.loads(chemin.read_text(encoding="utf-8")))
        else:
            reponses.append(cas["reponse"])
        noms.append(cas["nom"])
    return noms, reponses


class AccordResumeTests(unittest.TestCase):
    """Les deux portages lisent la meme chose dans le meme CV."""

    @classmethod
    def setUpClass(cls):
        cls.raison = _node_disponible()
        if cls.raison:
            return
        cls.noms, cls.reponses = _reponses_de_la_fixture()
        cls.fiches = [_fiche_python(r) for r in cls.reponses]
        cls.masters = _cv_masters(cls.reponses)

    def setUp(self):
        if self.raison:
            self.skipTest(self.raison)

    def test_chaque_champ_de_la_table_de_correspondance(self):
        for nom, fiche, master in zip(self.noms, self.fiches, self.masters):
            for ligne in FIXTURE["correspondance"]:
                valeur_py = _valeur(fiche, ligne["py"])
                valeur_js = _valeur(master, ligne["js"])
                with self.subTest(cas=nom, champ=ligne["py"], preuve=ligne["preuve"]):
                    if isinstance(valeur_py, list) or isinstance(valeur_js, list):
                        self.assertEqual(
                            len(valeur_py or []), len(valeur_js or []),
                            "%s : %s a %d entrees, %s en a %d"
                            % (nom, ligne["py"], len(valeur_py or []), ligne["js"], len(valeur_js or [])),
                        )
                        for rang, (a, b) in enumerate(zip(valeur_py or [], valeur_js or [])):
                            self.assertTrue(
                                _egal(ligne["regle"], a, b),
                                "%s : %s[%d]=%r contre %s[%d]=%r (regle %s)"
                                % (nom, ligne["py"], rang, a, ligne["js"], rang, b, ligne["regle"]),
                            )
                    else:
                        self.assertTrue(
                            _egal(ligne["regle"], valeur_py, valeur_js),
                            "%s : %s=%r contre %s=%r (regle %s)"
                            % (nom, ligne["py"], valeur_py, ligne["js"], valeur_js, ligne["regle"]),
                        )

    def test_aucune_liste_perdue_d_un_seul_cote(self):
        """Une mission, une formation ou une langue perdue d'un seul cote est la
        panne la plus grave de #177 : elle ne se voit sur aucun ecran."""
        for nom, fiche, master in zip(self.noms, self.fiches, self.masters):
            for compte in FIXTURE["comptes"]:
                with self.subTest(cas=nom, liste=compte["py"], preuve=compte["preuve"]):
                    self.assertEqual(
                        len(fiche.get(compte["py"]) or []), len(master.get(compte["js"]) or []),
                        "%s : %s=%d contre %s=%d" % (nom, compte["py"], len(fiche.get(compte["py"]) or []),
                                                     compte["js"], len(master.get(compte["js"]) or [])),
                    )

    def test_les_differences_de_forme_declarees_existent_toujours(self):
        """Le pendant du test precedent : si une difference DECLAREE disparait,
        la fixture ment et doit etre corrigee. Sans cela, elle vieillirait en
        affirmant des ecarts que le code n'a plus."""
        fiche, master = self.fiches[0], self.masters[0]
        # #177 ligne 19 : meme numero, deux formes.
        telephone_py = (fiche.get("contact") or {}).get("phone")
        telephone_js = (master.get("contact") or {}).get("phone")
        self.assertNotEqual(telephone_py, telephone_js, "l'E.164 du one-pager a disparu")
        self.assertEqual(_national(telephone_py), _national(telephone_js))
        # Champs propres a chaque produit : leur absence de l'autre cote est voulue.
        self.assertIn("projects", fiche)
        self.assertNotIn("projects", master)
        self.assertIn("technologies", master)
        self.assertNotIn("technologies", fiche)

    def test_la_fixture_decrit_les_deux_portages_reellement_executes(self):
        """Garde-fou sur la fixture elle-meme : elle nomme les deux chaines, et
        ce test les execute bien toutes les deux."""
        self.assertEqual(len(self.fiches), len(self.masters))
        self.assertGreaterEqual(len(self.fiches), 5, "un cas reel plus quatre cas synthetiques")
        self.assertTrue(any("fichier" in cas for cas in FIXTURE["cas"]),
                        "au moins une REPONSE DocIE reelle doit etre rejouee")


if __name__ == "__main__":
    unittest.main()
