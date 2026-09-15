"""Choix du modèle d'extraction d'un CV, par action (#194).

Aucun appel DocIE : sessions `requests` simulées, bridge bouché, process_cv
remplacé dans les routes. Le catalogue lu est le vrai
(document-parsing/models/catalogue.json), les identifiants viennent d'un
environnement de test.
"""
import ast
import os
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch
from zipfile import ZipFile

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import choix_modele  # noqa: E402
import docie_bridge_extraction  # noqa: E402
import taches_upload as tu  # noqa: E402
from test_upload_asynchrone import Base, Lanceur, Montage, erreur_bridge  # noqa: E402

SOURCE_APP = (RACINE / "app.py").read_text(encoding="utf-8")

VARIABLES = ("DOCIE_MODELE_LFM25_2_6B", "DOCIE_MODELE_NUEXTRACT3", "DOCIE_MODELE_LFM25_350M",
             "DOCIE_AGENT_RESUME_LFM25_2_6B", "DOCIE_AGENT_RESUME_NUEXTRACT3",
             "DOCIE_EXTRACTION_ENABLED", "DOCIE_EXTRACTION_MODE", "DOCIE_MODEL_PROFILE", "DOCIE_AGENT_RESUME")

DEUX_TEXTE = {"DOCIE_MODELE_LFM25_2_6B": "store:lfm2.5-2.6b", "DOCIE_MODELE_NUEXTRACT3": "store:nuextract3"}
DEUX_AGENT = {"DOCIE_EXTRACTION_ENABLED": "true",
              "DOCIE_AGENT_RESUME_LFM25_2_6B": "agent_lfm", "DOCIE_AGENT_RESUME_NUEXTRACT3": "agent_nu"}


@contextmanager
def environnement(**valeurs):
    """os.environ sans aucune variable du catalogue, puis `valeurs`."""
    with patch.dict(os.environ, {}, clear=False):
        for nom in VARIABLES:
            os.environ.pop(nom, None)
        os.environ.update(valeurs)
        yield


def fonctions_d_app(*noms, **espace):
    source = "\n\n".join(ast.unparse(n) for n in ast.parse(SOURCE_APP).body
                         if isinstance(n, ast.FunctionDef) and n.name in noms)
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace


def docx(lignes):
    fichier = tempfile.NamedTemporaryFile(suffix=".docx", delete=False)
    fichier.close()
    corps = "".join(f"<w:p><w:r><w:t>Ligne {i}</w:t></w:r></w:p>" for i in range(lignes))
    with ZipFile(fichier.name, "w") as archive:
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/'
                         f'wordprocessingml/2006/main"><w:body>{corps}</w:body></w:document>')
    return Path(fichier.name)


def pdf(pages):
    from pypdf import PdfWriter
    ecrivain = PdfWriter()
    for _ in range(pages):
        ecrivain.add_blank_page(width=72, height=72)
    tampon = BytesIO()
    ecrivain.write(tampon)
    return tampon.getvalue()


# ── Quels modèles proposer ────────────────────────────────────────────────────

def rendre(gabarit, **contexte):
    from flask import Flask
    app = Flask("rendu", template_folder=str(RACINE / "templates"), static_folder=str(RACINE / "static"))
    with app.test_request_context("/"):
        return app.jinja_env.get_template(gabarit).render(**contexte)


class Offre(unittest.TestCase):
    def test_rien_configure_aucun_modele_ni_selecteur(self):
        with environnement():
            self.assertEqual(choix_modele.modeles_proposes(), [])
        self.assertNotIn('id="modeleSelect"', rendre("index.html", modeles=[], modeles_erreur=""))

    def test_un_seul_modele_selecteur_masque(self):
        with environnement(DOCIE_MODELE_LFM25_2_6B="store:lfm2.5-2.6b"):
            modeles = choix_modele.modeles_proposes()
        self.assertEqual([m["id"] for m in modeles], ["lfm25_2_6b"])
        with environnement(DOCIE_MODELE_LFM25_2_6B="store:lfm2.5-2.6b"):
            formats = choix_modele.offres_par_format()
        self.assertEqual(formats, {".pdf": ["lfm25_2_6b"], ".docx": ["lfm25_2_6b"]})
        # Même règle que contrats (#210) : présent (sa valeur part avec le dépôt),
        # mais masqué tant qu'il n'y a pas d'alternative.
        html = rendre("index.html", modeles=modeles, modeles_par_format=formats, modeles_erreur="")
        self.assertRegex(html, r'id="modeleSelect" style="[^"]*" hidden')
        self.assertIn('data-formats="{&#34;.docx&#34;: [&#34;lfm25_2_6b&#34;], &#34;.pdf&#34;: [&#34;lfm25_2_6b&#34;]}"', html)

    def test_deux_modeles_defaut_d_abord_selecteur_affiche_defaut_preselectionne(self):
        with environnement(**DEUX_TEXTE):
            modeles = choix_modele.modeles_proposes()
        self.assertEqual([(m["id"], m["role"]) for m in modeles],
                         [("lfm25_2_6b", "defaut"), ("nuextract3", "alternative")])
        html = rendre("index.html", modeles=modeles, modeles_erreur="")
        self.assertIn('id="modeleSelect"', html)
        self.assertNotRegex(html, r'id="modeleSelect" style="[^"]*" hidden')
        self.assertIn('<option value="lfm25_2_6b" selected>LFM2.5 2.6B', html)
        self.assertIn('<option value="nuextract3">NuExtract3', html)

    def test_alternative_seule_configuree_proposee_seule(self):
        with environnement(DOCIE_MODELE_NUEXTRACT3="store:nuextract3"):
            self.assertEqual([m["id"] for m in choix_modele.modeles_proposes()], ["nuextract3"])

    def test_mode_studio_aucune_voie_du_catalogue(self):
        with environnement(DOCIE_EXTRACTION_MODE="studio", **DEUX_TEXTE):
            self.assertEqual(choix_modele.modeles_proposes(), [])

    def test_bridge_actif_pdf_voie_agent_docx_voie_texte(self):
        with environnement(DOCIE_EXTRACTION_ENABLED="true", DOCIE_AGENT_RESUME_NUEXTRACT3="agent_nu",
                           DOCIE_MODELE_LFM25_2_6B="store:lfm2.5-2.6b"):
            self.assertEqual(choix_modele.voie_pour(".pdf"), "agent")
            self.assertEqual(choix_modele.voie_pour(".docx"), "texte")
            self.assertEqual([m["id"] for m in choix_modele.modeles_proposes(".pdf")], ["nuextract3"])
            self.assertEqual([m["id"] for m in choix_modele.modeles_proposes(".docx")], ["lfm25_2_6b"])
            # Dépôt (format inconnu) : les deux voies réunies, défaut d'abord ; le
            # navigateur n'envoie un modèle que pour un format qui en a un.
            self.assertEqual([m["id"] for m in choix_modele.modeles_proposes()], ["lfm25_2_6b", "nuextract3"])
            self.assertEqual(choix_modele.offres_par_format(), {".pdf": ["nuextract3"], ".docx": ["lfm25_2_6b"]})
        with environnement(DOCIE_EXTRACTION_ENABLED="true", DOCIE_MODELE_LFM25_2_6B="store:lfm2.5-2.6b"):
            self.assertEqual(choix_modele.offres_par_format(), {".pdf": [], ".docx": ["lfm25_2_6b"]},
                             "PDF sans agent configuré : envoyé sans modèle, comme avant")
        with environnement(**DEUX_TEXTE):
            self.assertEqual(choix_modele.voie_pour(".pdf"), "texte")

    def test_ecran_de_fiche_selecteur_selon_la_voie_du_fichier(self):
        cv = {"id": "cv-7", "name": "Alice", "title": "Data", "contact": {}, "ext": ".pdf",
              "modele_extraction": {"voie": "texte", "demande": None,
                                    "servi": {"id": "nuextract3", "libelle": "NuExtract3", "identifiant": "x"}}}
        with environnement(**DEUX_TEXTE):
            deux = choix_modele.modeles_proposes(".pdf")
        html = rendre("cv_detail.html", cv=cv, linked_cvs=[], modeles=deux, modeles_erreur="")
        self.assertIn('id="modeleSelect"', html)
        self.assertIn("Lu par NuExtract3", html)
        self.assertNotIn('id="modeleSelect" hidden', html)
        html = rendre("cv_detail.html", cv=cv, linked_cvs=[], modeles=deux[:1], modeles_erreur="")
        self.assertIn('id="modeleSelect" hidden', html)
        html = rendre("cv_detail.html", cv=cv, linked_cvs=[], modeles=[], modeles_erreur="")
        self.assertNotIn('id="modeleSelect"', html)

    def test_identifiant_mal_forme_pas_de_selecteur_mais_faute_dite(self):
        espace = fonctions_d_app("selecteur_modeles")
        with environnement(DOCIE_MODELE_LFM25_2_6B="store:lfm\x01", DOCIE_MODELE_NUEXTRACT3="store:nu"):
            contexte = espace["selecteur_modeles"]()
        self.assertEqual((contexte["modeles"], contexte["modeles_par_format"]), ([], {}))
        self.assertIn("mal configuré", contexte["modeles_erreur"])
        with environnement(**DEUX_TEXTE):
            self.assertEqual(len(espace["selecteur_modeles"]()["modeles"]), 2)


# ── Un choix est vérifié sur le document réel, jamais substitué ───────────────

class Limites(unittest.TestCase):
    def test_voie_texte_800_lignes_passe_801_refuse(self):
        with environnement(**DEUX_TEXTE):
            choix = choix_modele.Choix("lfm25_2_6b")
            self.assertEqual(choix.pour_texte("\n".join(["x"] * 800) + "\n\n  \n"), "store:lfm2.5-2.6b")
            with self.assertRaises(tu.ErreurTache) as ctx:
                choix.pour_texte("\n".join(["x"] * 801))
            self.assertEqual(ctx.exception.code, "limite")
            self.assertIn("800 lignes non vides (document : 801)", str(ctx.exception))
            # NuExtract3 n'a pas de limite de lignes sur la voie texte.
            self.assertEqual(choix_modele.Choix("nuextract3").pour_texte("\n".join(["x"] * 5000)), "store:nuextract3")

    def test_voie_agent_8_pages_passe_9_refuse_illisible_refuse(self):
        with environnement(**DEUX_AGENT):
            choix = choix_modele.Choix("nuextract3")
            self.assertEqual(choix.pour_agent(8), "agent_nu")
            for pages in (9, None):
                with self.assertRaises(tu.ErreurTache) as ctx:
                    choix.pour_agent(pages)
                self.assertEqual(ctx.exception.code, "limite")
            # LFM2.5 (agent OCR) n'a pas de limite de pages : illisible n'est pas bloquant.
            self.assertEqual(choix_modele.Choix("lfm25_2_6b").pour_agent(None), "agent_lfm")
            self.assertEqual(choix_modele.Choix("lfm25_2_6b").pour_agent(40), "agent_lfm")

    def test_modele_non_configure_ou_inconnu_refuse_jamais_le_defaut(self):
        with environnement(DOCIE_MODELE_LFM25_2_6B="store:lfm2.5-2.6b"):
            for modele, nom in (("nuextract3", "NuExtract3"), ("gpt-9", "demandé")):
                with self.assertRaises(tu.ErreurTache) as ctx:
                    choix_modele.Choix(modele).verifier(".pdf")
                self.assertEqual(ctx.exception.code, "modele_non_propose")
                self.assertIn(nom, str(ctx.exception))
        with environnement(DOCIE_EXTRACTION_MODE="studio", **DEUX_TEXTE):
            with self.assertRaises(tu.ErreurTache) as ctx:
                choix_modele.Choix("lfm25_2_6b").verifier(".pdf")
            self.assertEqual(ctx.exception.code, "modele_non_propose")

    def test_refus_nomme_traverse_la_tache(self):
        erreur = tu.ErreurTache("LFM2.5 2.6B n'est pas proposé au-delà de 800 lignes non vides (document : 801).",
                                code="limite")
        self.assertEqual(tu.mapper_erreur(erreur), {"code": "limite", "message": str(erreur)})


class VoieTexte(unittest.TestCase):
    ENV = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "secret",
           "DOCIE_EXTRACTION_MODE": "inline", "DOCIE_MODEL_PROFILE": "profil-env", **DEUX_TEXTE}

    def extraire(self, lignes, choix):
        from docie_client import extract_resume
        session = Mock()
        sortie = {"schema_name": "adbi_resume", "request_id": "r1", "model_profile": "store:nuextract3",
                  "result": {"name": "Alice Dupont"}, "validation": {"valid": True, "errors": [], "warnings": []}}
        session.request.return_value = Mock(status_code=200, json=lambda: sortie)
        chemin = docx(lignes)
        self.addCleanup(chemin.unlink)
        options = {"choix": choix} if choix else {}
        with environnement(**self.ENV):
            resultat = extract_resume(chemin, session=session, **options)
        return session, resultat

    def test_modele_choisi_envoye_pour_cette_requete(self):
        with environnement(**DEUX_TEXTE):
            choix = choix_modele.Choix("nuextract3")
        session, (_, metadata) = self.extraire(1200, choix)
        self.assertEqual(session.request.call_args.kwargs["json"]["model_profile"], "store:nuextract3")
        self.assertEqual(metadata["model_profile"], "store:nuextract3")

    def test_limite_depassee_refus_avant_tout_appel(self):
        choix = choix_modele.Choix("lfm25_2_6b")
        session = None
        with self.assertRaises(tu.ErreurTache) as ctx:
            session, _ = self.extraire(801, choix)
        self.assertEqual(ctx.exception.code, "limite")
        # 800 lignes : envoyé, avec l'identifiant du modèle choisi.
        session, _ = self.extraire(800, choix)
        self.assertEqual(session.request.call_args.kwargs["json"]["model_profile"], "store:lfm2.5-2.6b")

    def test_sans_choix_comportement_d_avant(self):
        session, _ = self.extraire(1200, None)
        self.assertEqual(session.request.call_args.kwargs["json"]["model_profile"], "profil-env")


class VoieAgent(unittest.TestCase):
    def extraire(self, contenu, choix):
        faux = MagicMock()
        faux.DocIEBridgeError = type("DocIEBridgeError", (Exception,), {})
        faux.extract_document.return_value = {
            "schema_name": "adbi_resume", "result": {"name": "Alice Dupont"},
            "metadata": {"request_id": "r1", "agent": "agent_nu", "validation": None}}
        with tempfile.TemporaryDirectory() as dossier:
            chemin = Path(dossier) / "cv.pdf"
            chemin.write_bytes(contenu)
            with environnement(**DEUX_AGENT), \
                    patch("docie_bridge_extraction._load_bridge", return_value=faux):
                options = {"choix": choix} if choix else {}
                resultat = docie_bridge_extraction.extract_resume(chemin, **options)
        return faux, resultat

    def test_8_pages_agent_du_modele_choisi(self):
        faux, (_, metadata) = self.extraire(pdf(8), choix_modele.Choix("nuextract3"))
        self.assertEqual(faux.extract_document.call_args.kwargs["agent"], "agent_nu")
        self.assertEqual(metadata["agent"], "agent_nu")

    def test_9_pages_ou_illisible_refuse_sans_appel(self):
        for contenu in (pdf(9), b"%PDF-illisible"):
            faux = None
            with self.assertRaises(tu.ErreurTache) as ctx:
                faux, _ = self.extraire(contenu, choix_modele.Choix("nuextract3"))
            self.assertEqual(ctx.exception.code, "limite")

    def test_scan_long_accepte_pour_l_agent_ocr(self):
        faux, _ = self.extraire(pdf(12), choix_modele.Choix("lfm25_2_6b"))
        self.assertEqual(faux.extract_document.call_args.kwargs["agent"], "agent_lfm")

    def test_sans_choix_aucun_agent_par_appel(self):
        faux, _ = self.extraire(pdf(12), None)
        self.assertNotIn("agent", faux.extract_document.call_args.kwargs)


# ── process_cv : modèle servi enregistré ──────────────────────────────────────

class ModeleServi(unittest.TestCase):
    def process_cv(self):
        return fonctions_d_app("process_cv", Path=Path, noter_progression=lambda *a, **k: None,
                               normalize_cv_data=lambda d: dict(d), bilan_adbi=lambda cv: {})["process_cv"]

    @staticmethod
    def faux_extracteur(appels, metadata):
        def extraire(chemin, progress=None, **options):
            appels.append(options)
            return ({"name": "Alice Dupont"},
                    {"event_id": "r1", "validation": {"valid": True, "errors": [], "warnings": []},
                     "field_confidence": {}, "schema_reported": True, **metadata})
        return extraire

    def test_voie_texte_modele_de_la_reponse_pas_celui_demande(self):
        appels = []
        with environnement(**DEUX_TEXTE), \
                patch("docie_client.extract_resume", self.faux_extracteur(appels, {"model_profile": "lfm2.5-2.6b"})):
            fiche = self.process_cv()("cv.pdf", modele="nuextract3")
        self.assertIsInstance(appels[0]["choix"], choix_modele.Choix)
        self.assertEqual(fiche["modele_extraction"], {
            "voie": "texte", "demande": "nuextract3",
            "servi": {"id": "lfm25_2_6b", "libelle": "LFM2.5 2.6B"},
            "partiel": [], "troncature_possible": None})

    def test_sans_choix_modele_servi_enregistre_aussi(self):
        appels = []
        with environnement(**DEUX_TEXTE), \
                patch("docie_client.extract_resume", self.faux_extracteur(appels, {"model_profile": "store:nuextract3"})):
            fiche = self.process_cv()("cv.docx")
        self.assertEqual(appels, [{}], "aucun choix transmis à l'extraction")
        self.assertEqual(fiche["modele_extraction"]["demande"], None)
        self.assertEqual(fiche["modele_extraction"]["servi"]["libelle"], "NuExtract3")

    def test_voie_agent_agent_appele(self):
        appels = []
        with environnement(**DEUX_AGENT), patch(
                "docie_bridge_extraction.extract_resume",
                self.faux_extracteur(appels, {"model_profile": "agent_lfm", "agent": "agent_lfm",
                                              "transport": "docie-bridge"})):
            fiche = self.process_cv()("cv.pdf", modele="lfm25_2_6b")
        self.assertEqual(fiche["modele_extraction"]["voie"], "agent")
        self.assertEqual(fiche["modele_extraction"]["servi"]["id"], "lfm25_2_6b")

    BOUCLE = ("skills: model output repeated itself (Python, Python); list truncated at the loop start, "
              "remaining items dropped; confidence capped to 0.5 as a review flag")

    def test_resultat_partiel_voie_agent_dit_pour_un_modele_choisi(self):
        appels = []
        partiel = [{"champ": "skills", "raison": "boucle"}, {"champ": "experience", "raison": "liste_plafonnee_possible"}]
        with environnement(**DEUX_AGENT), patch(
                "docie_bridge_extraction.extract_resume",
                self.faux_extracteur(appels, {"model_profile": "agent_nu", "agent": "agent_nu",
                                              "transport": "docie-bridge", "partiel": partiel})):
            fiche = self.process_cv()("cv.pdf", modele="nuextract3")
            sans = self.process_cv()("cv.pdf")
        self.assertEqual(fiche["modele_extraction"]["partiel"], partiel)
        self.assertIn("Résultat partiel du modèle choisi (skills, experience)", fiche["parse_warning"])
        self.assertNotIn("partiel", sans["modele_extraction"], "sans choix : inchangé")
        self.assertNotIn("Résultat partiel", sans.get("parse_warning", ""))

    def test_resultat_partiel_voie_texte_releve_par_le_bridge(self):
        appels = []
        metadata = {"model_profile": "store:lfm2.5-2.6b"}
        extracteur = self.faux_extracteur(appels, metadata)

        def avec_boucle(chemin, progress=None, **options):
            data, meta = extracteur(chemin, progress, **options)
            meta["validation"] = {"valid": True, "errors": [], "warnings": [self.BOUCLE]}
            return data, meta

        with environnement(**DEUX_TEXTE), patch("docie_client.extract_resume", avec_boucle):
            fiche = self.process_cv()("cv.pdf", modele="lfm25_2_6b")
        self.assertEqual(fiche["modele_extraction"]["partiel"], [{"champ": "skills", "raison": "boucle"}])
        self.assertIn("(skills)", fiche["parse_warning"])

    def test_modele_non_propose_refuse_avant_l_extraction(self):
        appels = []
        with environnement(DOCIE_MODELE_LFM25_2_6B="store:lfm2.5-2.6b"), \
                patch("docie_client.extract_resume", self.faux_extracteur(appels, {"model_profile": "x"})):
            with self.assertRaises(tu.ErreurTache) as ctx:
                self.process_cv()("cv.pdf", modele="nuextract3")
        self.assertEqual((ctx.exception.code, appels), ("modele_non_propose", []))


# ── Routes : échouer bruyamment sur un choix, rien ne change sans choix ───────

class Routes(Montage):
    def poster_modele(self, modele=None, contenu=b"%PDF-1.4 alice", utilisateur="u1"):
        donnees = {"file": (BytesIO(contenu), "cv.pdf")}
        if modele is not None:
            donnees["modele"] = modele
        return self.client.post("/api/upload", data=donnees, content_type="multipart/form-data",
                                headers={"X-Test-User": utilisateur})

    def monter_avec(self, erreur=None, fiche=None, **options):
        self.recus = []

        def process_cv(chemin, jeton=None, **kw):
            self.recus.append(kw)
            if erreur is not None:
                raise erreur
            return fiche or Base.fiche()

        lanceur = Lanceur()
        self.monter(process_cv=process_cv, lanceur=lanceur, **options)
        return lanceur

    def test_choix_explicite_echec_docie_tache_en_echec_sans_fiche_ni_fichier(self):
        lanceur = self.monter_avec(erreur=erreur_bridge("upstream"))
        tache = self.poster_modele("nuextract3").get_json()["tache"]
        lanceur.jouer()
        r = self.suivre(tache)
        self.assertEqual((r.get_json()["etat"], r.get_json()["erreur"]),
                         ("echec", {"code": "upstream", "message": tu.MESSAGES_BRIDGE["upstream"]}))
        self.assertNotIn("SECRET", r.get_data(as_text=True))
        self.assertEqual(self.recus, [{"modele": "nuextract3"}])
        self.assertEqual(self.enregistrees, {}, "aucune fiche vide de repli")
        self.assertEqual(list(Path(self.dossier.name).iterdir()), [], "fichier déposé retiré")

    def test_choix_explicite_refus_du_catalogue_code_limite(self):
        erreur = tu.ErreurTache("LFM2.5 2.6B n'est pas proposé au-delà de 800 lignes non vides (document : 900).",
                                code="limite")
        lanceur = self.monter_avec(erreur=erreur)
        tache = self.poster_modele("lfm25_2_6b").get_json()["tache"]
        lanceur.jouer()
        self.assertEqual(self.suivre(tache).get_json()["erreur"], {"code": "limite", "message": str(erreur)})

    def test_sans_choix_meme_echec_garde_le_repli(self):
        lanceur = self.monter_avec(erreur=erreur_bridge("upstream"))
        tache = self.poster_modele().get_json()["tache"]
        lanceur.jouer()
        vue = self.suivre(tache).get_json()
        self.assertEqual(vue["etat"], "terminee")
        self.assertEqual(self.recus, [{}], "process_cv appelé exactement comme avant")
        self.assertIn(vue["resultat"]["id"], self.enregistrees)
        # Champ vide = pas de choix.
        tache = self.poster_modele("  ", contenu=b"%PDF autre").get_json()["tache"]
        lanceur.jouer()
        self.assertEqual(self.suivre(tache).get_json()["etat"], "terminee")

    def test_choix_reussi_modele_servi_dans_la_synthese(self):
        fiche = Base.fiche(modele_extraction={"voie": "texte", "demande": "nuextract3",
                                              "servi": {"id": "nuextract3", "libelle": "NuExtract3", "identifiant": "s"}})
        lanceur = self.monter_avec(fiche=fiche)
        tache = self.poster_modele("nuextract3").get_json()["tache"]
        lanceur.jouer()
        resultat = self.suivre(tache).get_json()["resultat"]
        self.assertEqual(resultat["parse_summary"]["modele"], "NuExtract3")
        self.assertEqual(self.enregistrees[resultat["id"]]["modele_extraction"]["servi"]["id"], "nuextract3")

    def test_isolation_inchangee_avec_un_choix(self):
        lanceur = self.monter_avec(erreur=erreur_bridge("timeout"))
        tache = self.poster_modele("nuextract3", utilisateur="u1").get_json()["tache"]
        lanceur.jouer()
        self.assertEqual(self.suivre(tache, "u1").status_code, 200)
        self.assertEqual(self.suivre(tache, "u2").get_data(), self.suivre("jamais-vu-00000000", "u2").get_data())

    def test_cache_repris_seulement_si_ce_modele_a_servi(self):
        import hashlib
        contenu = b"%PDF deja vu"
        existante = {**Base.fiche(), "id": "origine", "filename": "vieux.pdf", "ext": ".pdf",
                     "empreinte": hashlib.sha256(contenu).hexdigest(), "llm_enriched": True,
                     "bilan_adbi": {"exploitable": True},
                     "modele_extraction": {"servi": {"id": "lfm25_2_6b", "libelle": "LFM2.5 2.6B"}}}
        self.monter_avec(existantes={"origine": existante})
        self.assertEqual(self.poster_modele(contenu=contenu).status_code, 200, "sans choix : cache inchangé")
        self.assertEqual(self.poster_modele("lfm25_2_6b", contenu=contenu).status_code, 200)
        r = self.poster_modele("nuextract3", contenu=contenu)
        self.assertEqual(r.status_code, 202, "autre modèle choisi : nouvelle analyse")
        self.assertEqual(self.gestionnaire.statistiques()["conservees"], 1)
        # Fiche en cache sans modèle enregistré (avant #194) : jamais reprise pour un choix.
        existante.pop("modele_extraction")
        self.assertEqual(self.poster_modele("lfm25_2_6b", contenu=contenu).status_code, 202)

    def test_reanalyse_avec_choix_sans_repli_fiche_intacte(self):
        lanceur = self.monter_avec(erreur=erreur_bridge("context"))
        fiche = {"id": "cv-7", "filename": "alice.pdf", "ext": ".pdf", "name": "Alice (saisi)"}
        self.enregistrees["cv-7"] = dict(fiche)
        (Path(self.dossier.name) / "cv-7.pdf").write_bytes(b"%PDF alice")
        tache = self.client.post("/api/cv/cv-7/reanalyser", data={"modele": "nuextract3"},
                                 headers={"X-Test-User": "u1"}).get_json()["tache"]
        lanceur.jouer()
        self.assertEqual(self.suivre(tache).get_json()["erreur"]["code"], "context")
        self.assertEqual(self.recus, [{"modele": "nuextract3"}])
        self.assertEqual(self.enregistrees["cv-7"], fiche)
        # Sans champ : appel identique à avant.
        tache = self.client.post("/api/cv/cv-7/reanalyser", headers={"X-Test-User": "u1"}).get_json()["tache"]
        lanceur.jouer()
        self.assertEqual(self.recus[-1], {})


if __name__ == "__main__":
    unittest.main()
