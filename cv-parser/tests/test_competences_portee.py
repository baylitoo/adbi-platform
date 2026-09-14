"""Portée du dédoublonnage des compétences — #177 ligne 13.

`normalize_cv_data` dédoublonnait `skills[].items` à travers TOUTES les
catégories (`_seen_items_global`) : « Python » sous « Langages » retirait
« python » de « Outils », et une catégorie dont tous les items étaient déjà
apparus plus haut disparaissait entière. one-pager ne dédoublonne que dans le
groupe (`lib/docie-extract.js::mapperCompetences`). Le même CV donnait donc deux
jeux de compétences, et c'est la CVthèque — la source de vérité — qui perdait.

Règle retenue : dans la catégorie seulement, insensible à la casse. La preuve
qui la rend sûre est mesurée ici et non supposée : `skills_flat`, que lisent
core/matcher.py, /api/skills et la recherche, est IDENTIQUE avec l'ancienne et
la nouvelle règle, puisque `normalize_skills` dédoublonne déjà globalement (casse
et alias) au moment d'aplatir. L'ancien ensemble global ne protégeait donc le
rapprochement de rien ; il ne retirait que ce qui s'affiche et s'exporte.

La portée est partagée avec one-pager par
document-parsing/fixtures/competences_portee.json (jumeau JS :
one-pager/tests/competences-portee.test.js).

`app.py` ouvre PostgreSQL à l'import ; les fonctions sont extraites par `ast`,
comme dans test_periode_mission.py et test_niveau_declare.py.
"""
import ast
import copy
import json
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
DEPOT = RACINE.parent
sys.path.insert(0, str(RACINE))

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
from skills_normalizer import (  # noqa: E402
    canonique, cle_competence, compute_skills_flat, normalize_skills, skills_to_flat,
)

REPONSE_DOCIE = DEPOT / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
JEU_PARTAGE = DEPOT / "document-parsing/fixtures/competences_portee.json"
GABARITS = RACINE / "templates"


def _extraire(fichier, noms, espace):
    """Exécute les fonctions `noms` de `fichier` (et les constantes de module
    qu'elles lisent) dans `espace`, sans importer le module."""
    arbre = ast.parse(fichier.read_text(encoding="utf-8"))
    fonctions = [n for n in arbre.body if isinstance(n, ast.FunctionDef) and n.name in noms]
    lus = {x.id for f in fonctions for x in ast.walk(f) if isinstance(x, ast.Name)}
    constantes = [n for n in arbre.body if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id in lus for t in n.targets)]
    for f in fonctions:
        f.decorator_list = []
    source = "\n\n".join(ast.unparse(n) for n in constantes + fonctions)
    exec(compile(source, str(fichier), "exec"), espace)
    return espace


APP = _extraire(RACINE / "app.py", {"normalize_cv_data", "compute_years_experience",
                                    "_pastille_plausible", "_pastilles_adbi"}, {
    "re": re, "datetime": datetime,
    "mentionne_en_cours": mentionne_en_cours, "analyser_periode": analyser_periode,
    "ordre_missions": ordre_missions, "index_mois": index_mois,
    "mois_courant": mois_courant, "periode_lisible": periode_lisible,
    "titre_de_repli": titre_de_repli, "niveau_cecrl": niveau_cecrl,
    "canonique": canonique, "cle_competence": cle_competence,
    # Les vraies : c'est skills_flat, ce que lit le rapprochement, qu'on mesure.
    "normalize_skills": normalize_skills, "skills_to_flat": skills_to_flat,
    "compute_skills_flat": compute_skills_flat,
    "print": lambda *a, **k: None,
})
normalize_cv_data = APP["normalize_cv_data"]


def _ancien_dedoublonnage(skills):
    """L'ancienne boucle de normalize_cv_data, recopiée telle quelle (témoin).

    Seul le libellé par défaut de la ligne 12 y figure en plus, pour isoler la
    ligne 13 : c'est l'état exact du code juste avant ce correctif.
    """
    sortie = []
    _seen_items_global = set()
    for sk in skills:
        category = str(sk.get("category") or sk.get("categorie") or "").strip()
        items_src = sk.get("items") or sk.get("competences") or []
        if isinstance(items_src, str):
            raw_items = [items_src]
        else:
            raw_items = [str(it).strip() for it in items_src if str(it).strip()]
        items, seen_local = [], set()
        for it in raw_items:
            key = it.lower()
            if key not in seen_local and key not in _seen_items_global:
                items.append(it)
                seen_local.add(key)
                _seen_items_global.add(key)
        if items:
            sortie.append({"category": category or "Compétences", "items": items})
    return sortie


def _donnees(skills_docie):
    """`map_resume` sur la vraie réponse enregistrée, compétences remplacées.

    Les entrées synthétiques sont bâties sur le schéma servi
    (`skills[]{category, items[]{item}}`, dynamic_schema de la même réponse).
    """
    reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
    reponse["result"]["skills"] = copy.deepcopy(skills_docie)
    return map_resume(reponse)


def _groupes(fiche_ou_skills):
    skills = fiche_ou_skills.get("skills") if isinstance(fiche_ou_skills, dict) else fiche_ou_skills
    return [(g["category"], g["items"]) for g in skills]


def _docie(*groupes):
    return [{"category": c, "items": [{"item": i} for i in items]} for c, items in groupes]


# Cas hors jeu partagé : ils mêlent la clé (accent, alias — fixée depuis par
# competences_synonymes.json, #177 G/H) à la portée. Ils servent à montrer que
# skills_flat ne bouge pas, quelle que soit la forme du doublon.
CAS_CLE = {
    "accent_deux_categories": _docie(("Méthodes", ["Modélisation"]), ("Fonctionnel", ["Modelisation"])),
    "alias_deux_categories": _docie(("Conteneurs", ["Kubernetes"]), ("DevOps", ["k8s"])),
    "accent_meme_categorie": _docie(("Méthodes", ["Modélisation", "Modelisation"])),
    "alias_meme_categorie": _docie(("DevOps", ["Kubernetes", "k8s"])),
    "casse_categorie_entiere": _docie(("Données", ["SQL", "PostgreSQL"]), ("Bases", ["sql", "postgresql"])),
}


def _jeu_partage():
    return json.loads(JEU_PARTAGE.read_text(encoding="utf-8"))


class TemoinPerteTests(unittest.TestCase):
    """L'ancienne règle, rejouée : la perte est constatée, pas supposée."""

    def test_l_ancienne_regle_retirait_un_item_d_une_autre_categorie(self):
        data = _donnees(_docie(("Langages", ["Python", "SQL"]), ("Outils", ["python", "Docker"])))
        self.assertEqual(_groupes(_ancien_dedoublonnage(data["skills"])),
                         [("Langages", ["Python", "SQL"]), ("Outils", ["Docker"])])
        # Nom canonique depuis #177 G/H (competences_synonymes.json) : « python »
        # est GARDÉ sous Outils — c'est la portée qu'on mesure ici — et stocké
        # sous sa graphie canonique.
        self.assertEqual(_groupes(normalize_cv_data(data)),
                         [("Langages", ["Python", "SQL"]), ("Outils", ["Python", "Docker"])])

    def test_l_ancienne_regle_supprimait_une_categorie_entiere(self):
        data = _donnees(_docie(("Données", ["SQL", "PostgreSQL"]), ("Bases", ["sql", "postgresql"])))
        self.assertEqual(_groupes(_ancien_dedoublonnage(data["skills"])),
                         [("Données", ["SQL", "PostgreSQL"])])
        self.assertEqual(_groupes(normalize_cv_data(data)),
                         [("Données", ["SQL", "PostgreSQL"]), ("Bases", ["SQL", "PostgreSQL"])])

    def test_l_ancienne_regle_faisait_dependre_la_fiche_de_l_ordre_du_document(self):
        """Mêmes groupes, ordre inverse : l'ancienne règle ne gardait pas la même fiche."""
        a = _donnees(_docie(("Langages", ["Python"]), ("Outils", ["Python", "Git"])))
        b = _donnees(_docie(("Outils", ["Python", "Git"]), ("Langages", ["Python"])))
        self.assertEqual(dict(_groupes(_ancien_dedoublonnage(a["skills"]))),
                         {"Langages": ["Python"], "Outils": ["Git"]})
        self.assertEqual(dict(_groupes(_ancien_dedoublonnage(b["skills"]))),
                         {"Outils": ["Python", "Git"]})
        self.assertEqual(dict(_groupes(normalize_cv_data(a))), dict(_groupes(normalize_cv_data(b))))

    def test_le_dedoublonnage_dans_la_categorie_demeure(self):
        data = _donnees(_docie(("Langages", ["Python", "python", "PYTHON", "SQL"])))
        self.assertEqual(_groupes(normalize_cv_data(data)), [("Langages", ["Python", "SQL"])])


class JeuPartageTests(unittest.TestCase):
    """document-parsing/fixtures/competences_portee.json, côté Python."""

    def test_chaque_cas_a_sa_preuve(self):
        jeu = _jeu_partage()
        self.assertGreaterEqual(len(jeu["cas"]), 6)
        for cas in jeu["cas"]:
            self.assertTrue(cas.get("preuve"), cas["id"])

    def test_le_cas_reel_est_bien_la_reponse_enregistree(self):
        cas = next(c for c in _jeu_partage()["cas"] if c["id"] == "reponse_reelle")
        reelle = map_resume(json.loads(REPONSE_DOCIE.read_text(encoding="utf-8")))["skills"]
        self.assertEqual(map_resume({"result": {"skills": cas["skills"], "name": "x"}})["skills"], reelle)

    def test_normalize_cv_data_suit_la_regle_partagee(self):
        def minuscules(groupes):
            return [(c.lower(), [i.lower() for i in items]) for c, items in groupes]
        for cas in _jeu_partage()["cas"]:
            with self.subTest(cas=cas["id"]):
                fiche = normalize_cv_data(_donnees(cas["skills"]))
                self.assertEqual(minuscules(_groupes(fiche)),
                                 minuscules([tuple(g) for g in cas["attendu"]]))

    def test_le_jumeau_js_lit_le_meme_fichier(self):
        js = (DEPOT / "one-pager/tests/competences-portee.test.js").read_text(encoding="utf-8")
        self.assertIn('"competences_portee.json"', js)


class RapprochementInchangeTests(unittest.TestCase):
    """Le point de consommation plat dédoublonnait déjà : rien n'y bouge."""

    def test_skills_flat_est_identique_avec_l_ancienne_et_la_nouvelle_regle(self):
        tous = {c["id"]: c["skills"] for c in _jeu_partage()["cas"]}
        tous.update(CAS_CLE)
        for nom, skills in tous.items():
            with self.subTest(cas=nom):
                data = _donnees(skills)
                ancien = normalize_skills(skills_to_flat(_ancien_dedoublonnage(copy.deepcopy(data["skills"]))))
                self.assertEqual(normalize_cv_data(data)["skills_flat"], ancien)

    def test_le_matcher_lit_skills_flat_et_non_skills(self):
        """Épingle la raison de l'invariance : si le matcher se mettait à lire
        `skills` groupe par groupe, cette ligne ne tiendrait plus."""
        source = (RACINE / "core/matcher.py").read_text(encoding="utf-8")
        corps = source[source.index("def _get_skills_flat"):source.index("def _get_all_text")]
        self.assertIn('cv.get("skills_flat")', corps)
        self.assertIn("compute_skills_flat(cv)", corps)


class FichesExistantesTests(unittest.TestCase):
    """Les fiches déjà en base ont été écrites avec l'ancienne règle."""

    def test_renormaliser_une_ancienne_fiche_ne_change_rien(self):
        """Seule voie qui renormalise une fiche stockée sans re-extraire : le
        Copilot (`normalize_cv_data` sur le JSON rendu par le modèle). Une fiche
        déjà dédoublonnée globalement est un point fixe de la nouvelle règle —
        rien n'est ni ajouté ni retiré."""
        data = _donnees(_docie(("Langages", ["Python", "SQL"]), ("Outils", ["python", "Docker"]),
                               ("Bases", ["sql"])))
        stockee = {"name": "Ancienne", "experience": [], "skills": _ancien_dedoublonnage(data["skills"])}
        self.assertEqual(_groupes(normalize_cv_data(copy.deepcopy(stockee))), _groupes(stockee))

    def test_le_skills_flat_recalcule_d_une_ancienne_fiche_ne_change_pas(self):
        """Fiche d'avant `skills_flat` : le matcher le recalcule à la lecture."""
        stockee = {"skills": [{"category": "Langages", "items": ["Python", "SQL"]},
                              {"category": "Outils", "items": ["Docker"]}]}
        self.assertEqual(compute_skills_flat(stockee), ["Python", "SQL", "Docker"])


def _rendu(gabarit, **contexte):
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    env = Environment(loader=FileSystemLoader(str(GABARITS)), autoescape=select_autoescape(["html"]))
    env.globals["url_for"] = lambda point, **kw: "/static/" + kw.get("filename", "")
    return env.get_template(gabarit).render(**contexte)


class SortiesTests(unittest.TestCase):
    """Une fiche qui stocke davantage ne doit dupliquer aucune ligne à l'affichage.

    Chaque lecteur de `skills` rend UNE ligne par catégorie : la même techno
    sous deux catégories donne deux lignes DIFFÉRENTES, chacune fidèle à son
    libellé — jamais la même ligne deux fois, jamais un item répété dans une
    ligne. Mesuré sur chaque sortie.

    Le CV écrit « python » sous Outils ; la fiche le stocke « Python » depuis
    #177 G/H (nom canonique de competences_synonymes.json). La ligne Outils
    reste distincte de la ligne Langages.
    """

    FICHE = {
        "id": "cv1", "name": "Camille Béranger", "title": "Développeuse Python",
        "years_experience": 7, "contact": {}, "languages": [], "education": [],
        "certifications": [],
        "experience": [{"company": "Numelia", "title": "Dev", "period": "Mars 2022 – Aujourd'hui",
                        # Ordre inverse de la ligne Outils : les comptes de texte des
                        # exports ne doivent mesurer que la ligne de compétences.
                        "env_technique": "Docker, Python", "description": "A"}],
    }

    @classmethod
    def setUpClass(cls):
        data = _donnees(_docie(("Langages", ["Python", "SQL"]), ("Outils", ["python", "Docker"])))
        cls.FICHE = dict(cls.FICHE, skills=normalize_cv_data(data)["skills"])

    def test_la_fiche_mesuree_est_bien_celle_d_un_doublon_inter_categories(self):
        self.assertEqual(_groupes(self.FICHE),
                         [("Langages", ["Python", "SQL"]), ("Outils", ["Python", "Docker"])])

    def test_ecran_de_la_fiche(self):
        html = _rendu("cv_detail.html", cv=self.FICHE, linked_cvs=[])
        # Vue profil : un groupe par catégorie.
        self.assertEqual(html.count('class="pv-skill-group"'), 2)
        # Écran d'édition : une ligne par catégorie, que collectData renvoie
        # telle quelle — l'aller-retour PATCH conserve les deux.
        self.assertEqual(html.count('class="skill-row"'), 2)
        lignes = re.findall(r'data-skill-items="\d+">(.*?)<input', html, re.S)
        items = [re.findall(r'<span class="tag">(.*?)<button', l) for l in lignes]
        self.assertEqual(items, [["Python", "SQL"], ["Python", "Docker"]])

    def test_dossier_adbi(self):
        html = _rendu("adbi_cv.html", cv=self.FICHE, pastilles=[], savoir_faire=[], max_familles=7)
        lignes = re.findall(r'<div class="intitule">(.*?)</div>\s*<div class="valeur">(.*?)</div>', html)
        self.assertEqual(lignes, [("Langages", "Python, SQL"), ("Outils", "Python, Docker")])

    def test_dossier_client(self):
        html = _rendu("company_cv.html", cv=self.FICHE, anon=False, color="orange")
        lignes = re.findall(r"<tr>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*</tr>", html)
        self.assertEqual(lignes, [("Langages", "Python, SQL"), ("Outils", "Python, Docker")])

    def test_export_pdf(self):
        import fitz
        from export_dossier import en_pdf
        with fitz.open(stream=en_pdf(self.FICHE, [], []).read(), filetype="pdf") as document:
            texte = "\n".join(page.get_text() for page in document)
        self.assertEqual(texte.count("Python, SQL"), 1)
        self.assertEqual(texte.count("Python, Docker"), 1)

    def test_export_word_de_export_dossier(self):
        from docx import Document
        from export_dossier import en_word
        document = Document(en_word(self.FICHE, [], []))
        lignes = [tuple(c.text for c in r.cells) for t in document.tables for r in t.rows
                  if len(r.cells) == 2 and r.cells[0].text in ("Langages", "Outils")]
        self.assertEqual(lignes, [("Langages", "Python, SQL"), ("Outils", "Python, Docker")])

    def test_export_word_de_app(self):
        """La cinquième sortie (`app.py::export_word`), même harnais que
        test_champs_conserves.py."""
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_champs_conserves import _export_word
        texte = _export_word(self.FICHE)
        self.assertEqual(texte.count("Python, SQL"), 1)
        self.assertEqual(texte.count("Python, Docker"), 1)

    def test_pastilles_du_dossier_adbi(self):
        """Clé en minuscules, déjà dédoublonnée : pas de « PYTHON » deux fois."""
        pastilles = APP["_pastilles_adbi"](self.FICHE)
        self.assertEqual(pastilles.count("PYTHON"), 1)
        self.assertEqual(len(pastilles), len(set(pastilles)))

    def test_profil_envoye_au_modele_du_rapprochement(self):
        espace = _extraire(RACINE / "core/rapprochement.py", {"_resume_candidat"}, {})
        texte = espace["_resume_candidat"]({"candidate_id": "cv1"}, self.FICHE)
        self.assertIn("compétences: Langages: Python, SQL | Outils: Python, Docker", texte)


if __name__ == "__main__":
    unittest.main()
