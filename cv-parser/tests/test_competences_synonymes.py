"""Synonymes de compétences partagés — #177 lignes G et H.

Dans UNE catégorie, « Modélisation » / « Modelisation » et « Kubernetes » /
« k8s » donnaient deux compétences dans la CVthèque et une seule dans le
dossier one-page. cv-parser comparait par `it.lower()` et stockait le libellé
tel quel ; one-pager canonicalise par sa taxonomie et compare sans accent.

Deux tables d'alias vivaient côte à côte (skills_normalizer.ALIASES et
one-pager/lib/taxonomy.js). La part sur laquelle elles s'accordaient ET qui ne
relève que de la graphie vit désormais dans
document-parsing/fixtures/competences_synonymes.json, lu à l'exécution par les
deux services. Jumeau JS : one-pager/tests/competences-synonymes.test.js.

Ce que ces tests fixent :
  - le témoin : l'ancienne boucle rejouée donne bien deux items, la nouvelle un ;
  - chaque cas du jeu partagé, nom stocké compris, à l'identique de one-pager ;
  - les écarts connus (familles de taxonomy.js), épinglés des deux côtés ;
  - une seule source : aucune clé de la table partagée recopiée dans ALIASES ;
  - la portée de #187 (jamais à travers les catégories) intacte ;
  - les lecteurs de skills_flat et les fiches déjà stockées inchangés ;
  - l'image Docker embarque la table (lue au démarrage).

`app.py` ouvre PostgreSQL à l'import ; `normalize_cv_data` est extraite par
`ast`, par le harnais de test_competences_portee.py.
"""
import copy
import json
import re
import sys
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
DEPOT = RACINE.parent
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import skills_normalizer as sn  # noqa: E402
from skills_normalizer import (  # noqa: E402
    canonique, cle_competence, compute_skills_flat, normalize_one, normalize_skills, skills_to_flat,
)
from test_competences_portee import _docie, _donnees, _groupes, normalize_cv_data  # noqa: E402

JEU_CHEMIN = DEPOT / "document-parsing/fixtures/competences_synonymes.json"
JEU = json.loads(JEU_CHEMIN.read_text(encoding="utf-8"))


def _attendu(groupes):
    return [(c, list(items)) for c, items in groupes]


def _cas(ident):
    return next(c for c in JEU["cas"] if c["id"] == ident)


def _ancienne_boucle(skills):
    """La boucle de normalize_cv_data avant ce correctif, recopiée (témoin) :
    clé `it.lower()`, libellé stocké tel quel, portée #187 (dans le groupe)."""
    sortie = []
    for sk in skills:
        category = str(sk.get("category") or "").strip()
        raw_items = [str(it).strip() for it in (sk.get("items") or []) if str(it).strip()]
        items, seen_local = [], set()
        for it in raw_items:
            key = it.lower()
            if key not in seen_local:
                items.append(it)
                seen_local.add(key)
        if items:
            sortie.append({"category": category or "Compétences", "items": items})
    return sortie


def _ancien_normalize_skills(raw_skills):
    """normalize_skills avant ce correctif : clé `lower()` sans désaccentuation."""
    seen = {}
    for raw in raw_skills:
        if not raw or not raw.strip():
            continue
        canonical = normalize_one(raw)
        seen.setdefault(canonical.lower(), canonical)
    return list(seen.values())


class TemoinDivergenceTests(unittest.TestCase):
    """L'ancienne règle rejouée : la divergence est constatée, pas supposée."""

    def test_H_k8s_et_kubernetes_etaient_deux_competences(self):
        data = _donnees(_cas("H_alias_meme_categorie")["skills"])
        self.assertEqual(_groupes(_ancienne_boucle(data["skills"])), [("DevOps", ["Kubernetes", "k8s"])])
        self.assertEqual(_groupes(normalize_cv_data(data)), [("DevOps", ["Kubernetes"])])

    def test_G_l_accent_faisait_deux_competences(self):
        data = _donnees(_cas("G_accent_meme_categorie")["skills"])
        self.assertEqual(_groupes(_ancienne_boucle(data["skills"])),
                         [("Méthodes", ["Modélisation", "Modelisation"])])
        self.assertEqual(_groupes(normalize_cv_data(data)), [("Méthodes", ["Modélisation"])])

    def test_G_atteignait_aussi_skills_flat(self):
        """Contrairement à ce que #187 relevait, `normalize_skills` dédoublonnait
        par casse et alias mais PAS par accent : la ligne G atteignait aussi
        /api/skills, la recherche et le rapprochement."""
        brut = ["Modélisation", "Modelisation"]
        self.assertEqual(_ancien_normalize_skills(brut), ["Modélisation", "Modelisation"])
        self.assertEqual(normalize_skills(brut), ["Modélisation"])

    def test_la_nouvelle_fiche_est_celle_que_one_pager_mesurait(self):
        """Les valeurs one-pager d'avant, relevées dans la preuve de chaque cas,
        sont celles qu'attend désormais le jeu partagé."""
        for ident, one_pager in (("H_alias_meme_categorie", [("DevOps", ["Kubernetes"])]),
                                 ("G_accent_meme_categorie", [("Méthodes", ["Modélisation"])])):
            with self.subTest(cas=ident):
                self.assertEqual(_attendu(_cas(ident)["attendu"]), one_pager)


class JeuPartageTests(unittest.TestCase):
    """document-parsing/fixtures/competences_synonymes.json, côté Python."""

    def test_chaque_cas_a_sa_preuve(self):
        self.assertGreaterEqual(len(JEU["cas"]), 12)
        for cas in JEU["cas"] + JEU["ecarts_connus"]["cas"]:
            self.assertTrue(cas.get("preuve"), cas["id"])

    def test_normalize_cv_data_suit_chaque_cas_nom_stocke_compris(self):
        """Égalité STRICTE (casse et accents) : c'est le nom stocké qui est partagé."""
        for cas in JEU["cas"]:
            with self.subTest(cas=cas["id"]):
                self.assertEqual(_groupes(normalize_cv_data(_donnees(cas["skills"]))), _attendu(cas["attendu"]))

    def test_ecarts_connus_epingles_cote_cv_parser(self):
        """Les familles de taxonomy.js ne sont pas partagées : cv-parser garde
        chaque compétence. Corriger un seul côté casse l'un des deux tests."""
        for cas in JEU["ecarts_connus"]["cas"]:
            with self.subTest(cas=cas["id"]):
                self.assertEqual(_groupes(normalize_cv_data(_donnees(cas["skills"]))), _attendu(cas["cv_parser"]))
                self.assertNotEqual(cas["cv_parser"], cas["one_pager"])

    def test_le_cas_reel_est_bien_la_reponse_enregistree(self):
        from docie_client import map_resume
        reponse = json.loads((DEPOT / "document-parsing/fixtures/cv_samples/results/simple_docie.json")
                             .read_text(encoding="utf-8"))
        self.assertEqual(map_resume({"result": {"skills": _cas("reponse_reelle")["skills"], "name": "x"}})["skills"],
                         map_resume(reponse)["skills"])

    def test_le_jumeau_js_lit_le_meme_fichier(self):
        js = (DEPOT / "one-pager/tests/competences-synonymes.test.js").read_text(encoding="utf-8")
        self.assertIn('"competences_synonymes.json"', js)


class TableTests(unittest.TestCase):
    """Une seule source, et seulement des synonymes stricts."""

    def test_la_table_chargee_est_le_fichier_partage(self):
        self.assertEqual(sn.SYNONYMES_CHEMIN.resolve(), JEU_CHEMIN.resolve())
        self.assertEqual(sn.SYNONYMES, JEU["synonymes"])

    def test_chaque_cle_de_la_table_donne_son_nom(self):
        for nom, variantes in JEU["synonymes"].items():
            for cle in (nom, *variantes):
                for forme in (cle, cle.upper(), f"  {cle} "):
                    with self.subTest(forme=forme):
                        self.assertEqual(canonique(forme), nom)
                        self.assertEqual(normalize_one(forme), nom)

    def test_aucune_cle_partagee_n_est_recopiee_dans_la_table_locale(self):
        partagees = {sn._key(c) for nom, vs in JEU["synonymes"].items() for c in (nom, *vs)}
        self.assertEqual(partagees & set(sn._ALIASES_LOCAUX), set())

    def test_les_exclusions_ne_sont_pas_dans_la_table(self):
        partagees = {sn._key(c) for nom, vs in JEU["synonymes"].items() for c in (nom, *vs)}
        exclus = JEU["_exclus"]["versions"] + JEU["_exclus"]["editions_ou_declinaisons"]
        self.assertEqual(partagees & set(exclus), set())
        # Toujours reconnues par la recherche, depuis la table locale.
        self.assertEqual(normalize_one("python 3"), "Python")
        self.assertEqual(normalize_one("power bi desktop"), "Power BI")

    def test_un_libelle_inconnu_garde_son_texte(self):
        self.assertEqual(canonique("  Modélisation   des  données "), "Modélisation des données")
        self.assertEqual(canonique("Keras"), "Keras")
        self.assertEqual(canonique(None), "")

    def test_cle_sans_accent_ni_casse(self):
        self.assertEqual(cle_competence("Modélisation"), cle_competence("MODELISATION"))
        self.assertEqual(cle_competence("k8s"), cle_competence("Kubernetes"))
        self.assertNotEqual(cle_competence("Keras"), cle_competence("TensorFlow"))


class PorteeEtLecteursTests(unittest.TestCase):
    """Les invariants de #187 tiennent."""

    def test_jamais_a_travers_les_categories(self):
        for ident in ("portee_187_alias_deux_categories", "portee_187_accent_deux_categories"):
            with self.subTest(cas=ident):
                fiche = normalize_cv_data(_donnees(_cas(ident)["skills"]))
                self.assertEqual(len(fiche["skills"]), 2)

    def test_skills_flat_se_lit_toujours_depuis_les_noms_stockes(self):
        fiche = normalize_cv_data(_donnees(_docie(("DevOps", ["k8s", "Kubernetes"]),
                                                  ("Méthodes", ["Modélisation"]),
                                                  ("Fonctionnel", ["Modelisation"]))))
        self.assertEqual(fiche["skills_flat"], ["Kubernetes", "Modélisation"])
        self.assertEqual(fiche["skills_flat"], normalize_skills(skills_to_flat(fiche["skills"])))

    def test_une_fiche_deja_canonique_est_un_point_fixe(self):
        """Seule voie qui renormalise sans re-extraire : le Copilot."""
        fiche = normalize_cv_data(_donnees(_cas("alias_et_nom_meme_categorie")["skills"]))
        stockee = {"name": "x", "experience": [], "skills": copy.deepcopy(fiche["skills"])}
        self.assertEqual(_groupes(normalize_cv_data(stockee)), _groupes(fiche))

    def test_une_fiche_stockee_avant_reste_lisible_par_le_rapprochement(self):
        """Fiche écrite avant ce correctif, jamais réécrite : `k8s` stocké brut.
        Le matcher recalcule les noms canoniques à la lecture — il la trouve."""
        stockee = {"skills": [{"category": "DevOps", "items": ["k8s", "Kubernetes"]}],
                   "skills_flat": ["Kubernetes"]}
        self.assertEqual(compute_skills_flat(stockee), ["Kubernetes"])
        espace = {}
        source = (RACINE / "core/matcher.py").read_text(encoding="utf-8")
        import ast
        arbre = ast.parse(source)
        corps = "\n\n".join(ast.unparse(n) for n in arbre.body
                            if isinstance(n, ast.FunctionDef) and n.name == "_get_skills_flat")
        exec(corps, {"normalize_one": normalize_one, "compute_skills_flat": compute_skills_flat}, espace)
        self.assertEqual(espace["_get_skills_flat"](stockee), ["kubernetes"])


def _bloc_service(compose, service):
    texte = (DEPOT / compose).read_text(encoding="utf-8")
    debut = texte.index(f"\n  {service}:\n")
    suite = re.search(r"\n  [a-z][a-z0-9-]*:\n", texte[debut + 1:])
    return texte[debut:debut + 1 + suite.start()] if suite else texte[debut:]


class ImageDockerTests(unittest.TestCase):
    """La table est lue AU DÉMARRAGE des deux services : elle doit être dans
    les images. Ce dépôt a déjà livré trois fois un fichier partagé absent de
    l'image. Vérifié en construisant les images (PR) ; épinglé ici."""

    def test_cv_parser_copie_la_table_au_chemin_lu_par_le_module(self):
        dockerfile = (RACINE / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY --from=fixtures competences_synonymes.json "
                      "/document-parsing/fixtures/competences_synonymes.json", dockerfile)
        # /app/skills_normalizer.py -> parents[1] = / -> /document-parsing/fixtures/
        chemin_image = Path("/app/skills_normalizer.py").parents[1] / "document-parsing/fixtures/competences_synonymes.json"
        self.assertEqual(chemin_image.as_posix(), "/document-parsing/fixtures/competences_synonymes.json")

    def test_les_deux_compose_declarent_le_contexte_fixtures_de_cv_parser(self):
        for compose in ("docker-compose.yml", "docker-compose.local.yml"):
            with self.subTest(compose=compose):
                self.assertIn("fixtures: ./document-parsing/fixtures", _bloc_service(compose, "cv-parser"))

    def test_one_pager_copie_la_table(self):
        dockerfile = (DEPOT / "one-pager/Dockerfile").read_text(encoding="utf-8")
        self.assertIn("document-parsing/fixtures/competences_synonymes.json", dockerfile)


if __name__ == "__main__":
    unittest.main()
