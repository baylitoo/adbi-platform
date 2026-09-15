"""Le rapprochement compare les compétences d'un besoin par la clé canonique.

Relevé par #198 (#177, lignes G/H) et non traité là : `skills_flat` porte des
noms CANONIQUES, mais `core/matcher.py` ne passait les compétences du besoin que
par `normalize_one(s).lower()` — alias exacts à la casse près, ni accent, ni
forme compacte de la table partagée.

Mesuré avant correctif (origin/master bdb9d2d), sur la CVthèque synthétique
ci-dessous : « k8s », « postgres », « Modelisation », « node js » étaient DÉJÀ
trouvés (alias exacts de la table partagée fusionnée dans ALIASES, similarité
> 0.82). Ce qui ratait :

  besoin « google-cloud »  -> CV GCP        besoin « c-sharp »  -> CV C#
  besoin « Dot Net »       -> CV .NET       besoin « T SQL »    -> CV T-SQL
  besoin « k8s. »          -> CV Kubernetes besoin « Securite » -> CV Sécurité
  besoin « Referentiel »   -> CV Référentiel

(deux accents : similarité 0.75, sous le seuil de 0.82).

D'où viennent les compétences d'un besoin, toutes brutes :
  - templates/needs.html -> POST /api/needs (api/needs_bp.py) -> insert_need,
    stockées telles quelles en JSONB ; PATCH idem ;
  - core/rapprochement.py::besoin_depuis_texte (fiche de poste lue par un
    modèle) -> run_matching, jamais stocké ;
  - scripts/migrer_vers_postgres.py (anciens besoins SQLite).
Toutes passent par `_score_skills` / `_score_missions` : c'est là que la clé est
appliquée, à la comparaison. Un besoin déjà en base n'est pas réécrit et en
profite au prochain lancement du rapprochement ; les résultats déjà
enregistrés (match_results) ne changent qu'à ce relancement.

`core.cvstore_pg` importe psycopg : il est remplacé le temps de l'import par
une CVthèque en mémoire, puis `sys.modules` est restauré.
"""
import importlib
import sys
import types
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from skills_normalizer import normalize_one  # noqa: E402
from test_competences_portee import _docie, _donnees, normalize_cv_data  # noqa: E402

BASE: dict = {}


def _importer_matcher():
    sauves = {nom: sys.modules.get(nom) for nom in ("core.cvstore_pg", "core.matcher")}
    bouchon = types.ModuleType("core.cvstore_pg")
    bouchon.list_cvs = lambda: dict(BASE)
    sys.modules["core.cvstore_pg"] = bouchon
    sys.modules.pop("core.matcher", None)
    try:
        return importlib.import_module("core.matcher")
    finally:
        for nom, module in sauves.items():
            if module is None:
                sys.modules.pop(nom, None)
            else:
                sys.modules[nom] = module


matcher = _importer_matcher()


def _fiche(nom, *competences, env=""):
    """Fiche telle que normalize_cv_data la stocke, sur le schéma servi."""
    fiche = normalize_cv_data(_donnees(_docie(("Compétences", list(competences)))))
    fiche["name"] = nom
    if env:
        fiche["experience"] = [{"title": "Mission", "env_technique": env}]
    return fiche


def _cvtheque():
    return {
        "gcp": _fiche("GCP", "Google Cloud Platform"),
        "csharp": _fiche("CSharp", "C#"),
        "dotnet": _fiche("DotNet", ".NET"),
        "tsql": _fiche("TSQL", "T-SQL"),
        "k8s": _fiche("Kube", "k8s"),
        "securite": _fiche("Secu", "Sécurité"),
        "referentiel": _fiche("Ref", "Référentiel"),
        "pg": _fiche("Postgres", "postgres"),
        "modelisation": _fiche("Modelisation", "Modélisation"),
        "node": _fiche("Node", "Node.js"),
        "ml": _fiche("ML", "Machine Learning"),
        "spark": _fiche("Spark", "Apache Spark"),
    }


# besoin -> CV attendu (noms de fiche)
RATES_AVANT = {
    "google-cloud": "GCP",
    "c-sharp": "CSharp",
    "Dot Net": "DotNet",
    "T SQL": "TSQL",
    "k8s.": "Kube",
    "Securite": "Secu",
    "Referentiel": "Ref",
}
TROUVES_AVANT = {
    "k8s": "Kube",
    "postgres": "Postgres",
    "Modelisation": "Modelisation",
    "node js": "Node",
    "ml": "ML",
    "spark": "Spark",
    "MODÉLISATION": "Modelisation",
}


def _ancien_score_skills(need, candidate_skills):
    """core/matcher.py::_score_skills avant ce correctif, recopié (témoin)."""
    required = [normalize_one(s).lower() for s in (need.get("required_skills") or [])]
    found, missing = [], []
    for req in required:
        matched = any(req == sk or req in sk or sk in req or matcher._sim(req, sk) > 0.82
                      for sk in candidate_skills)
        (found if matched else missing).append(req)
    return missing


def _trouves(besoin):
    resultats = matcher.run_matching({"title": "", "required_skills": [besoin]}, limit=100)
    return sorted(r["candidate_name"] for r in resultats if not r["explanation"]["missing_skills"])


class CVthequeSynthetique(unittest.TestCase):
    def setUp(self):
        BASE.clear()
        BASE.update(_cvtheque())

    def tearDown(self):
        BASE.clear()


class TemoinAncienMatcherTests(CVthequeSynthetique):
    """L'ancien `_score_skills` rejoué sur les mêmes fiches : le raté est constaté."""

    def test_l_ancien_matcher_ratait_ces_variantes(self):
        for besoin, nom in RATES_AVANT.items():
            with self.subTest(besoin=besoin):
                cv = next(c for c in BASE.values() if c["name"] == nom)
                self.assertEqual(_ancien_score_skills({"required_skills": [besoin]},
                                                      matcher._get_skills_flat(cv)),
                                 [normalize_one(besoin).lower()])

    def test_l_ancien_matcher_trouvait_deja_celles_ci(self):
        for besoin, nom in TROUVES_AVANT.items():
            with self.subTest(besoin=besoin):
                cv = next(c for c in BASE.values() if c["name"] == nom)
                self.assertEqual(_ancien_score_skills({"required_skills": [besoin]},
                                                      matcher._get_skills_flat(cv)), [])


class BesoinCanoniqueTests(CVthequeSynthetique):

    def test_chaque_variante_trouve_son_cv(self):
        for besoin, nom in {**RATES_AVANT, **TROUVES_AVANT}.items():
            with self.subTest(besoin=besoin):
                self.assertIn(nom, _trouves(besoin))

    def test_la_forme_canonique_et_ses_variantes_trouvent_les_memes_cv(self):
        for variantes in (("GCP", "google-cloud", "Google Cloud", "google_cloud_platform"),
                          ("C#", "c-sharp", "csharp", "C Sharp"),
                          ("Sécurité", "Securite", "SÉCURITÉ", "securité")):
            with self.subTest(variantes=variantes):
                attendu = _trouves(variantes[0])
                self.assertTrue(attendu)
                for v in variantes[1:]:
                    self.assertEqual(_trouves(v), attendu, v)

    def test_la_table_locale_reste_appliquee(self):
        """`cle_competence` seule ignore la table locale (« ml », « tf »…) :
        c'est pourquoi la clé compose normalize_one PUIS cle_competence."""
        self.assertIn("ML", _trouves("ml"))
        self.assertIn("Spark", _trouves("spark"))

    def test_le_libelle_manquant_affiche_est_inchange(self):
        resultat = next(r for r in matcher.run_matching(
            {"title": "", "required_skills": ["Kotlin", "k8s"]}, limit=100)
            if r["candidate_name"] == "Kube")
        self.assertEqual(resultat["explanation"]["missing_skills"], ["kotlin"])

    def test_un_besoin_stocke_avec_des_libelles_bruts_en_profite_sans_migration(self):
        """Ce que get_need() rend d'un besoin saisi avant : JSONB brut."""
        stocke = {"id": "n1", "title": "Dev .NET", "required_skills": ["Dot Net", "c-sharp"],
                  "bonus_skills": [], "languages": [], "min_years": 0}
        self.assertEqual(matcher._score_skills(stocke, matcher._get_skills_flat(BASE["dotnet"])),
                         (17.5, ["c-sharp"]))
        self.assertEqual(matcher._score_skills(stocke, matcher._get_skills_flat(BASE["csharp"])),
                         (17.5, ["dot net"]))

    def test_une_fiche_stockee_avant_198_avec_un_libelle_brut(self):
        """Fiche jamais réécrite : `skills_flat` d'avant #198, variante brute."""
        ancienne = {"name": "Ancienne", "skills_flat": ["google-cloud", "Securite"]}
        cand = matcher._get_skills_flat(ancienne)
        self.assertEqual(matcher._score_skills({"required_skills": ["GCP", "Sécurité"]}, cand),
                         (35.0, []))

    def test_le_texte_des_missions_se_compare_sans_accent(self):
        cv = _fiche("Mission", "Kotlin", env="Sécurité réseau, pare-feu")
        need = {"required_skills": ["Securite"]}
        self.assertEqual(matcher._score_missions(need, cv), 10.0)
        # Jamais moins qu'avant : l'ancienne forme reste cherchée telle quelle.
        self.assertEqual(matcher._score_missions({"required_skills": ["sécurité"]}, cv), 10.0)


class RapprochementDepuisFicheDePosteTests(CVthequeSynthetique):
    """core/rapprochement.py passe le besoin extrait par le modèle à run_matching."""

    def test_le_besoin_extrait_par_le_modele_est_canonicalise_aussi(self):
        sys.modules.setdefault("core.matcher", matcher)
        try:
            rapprochement = importlib.import_module("core.rapprochement")
        finally:
            if sys.modules.get("core.matcher") is matcher:
                sys.modules.pop("core.matcher")
        rapprochement.run_matching = matcher.run_matching
        rapprochement._load_cv_db = matcher._load_cv_db
        appel = lambda *a, **k: ('{"title":"Dev","required_skills":["google-cloud"]}', "test")
        resultat = rapprochement.classer("Dev GCP", ["gcp", "csharp"], appel_llm=appel)
        par_nom = {r["candidate_name"]: r["explanation"]["missing_skills"] for r in resultat["resultats"]}
        self.assertEqual(par_nom, {"GCP": [], "CSharp": ["google-cloud"]})
        sys.modules.pop("core.rapprochement", None)


if __name__ == "__main__":
    unittest.main()
