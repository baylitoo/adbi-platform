import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from docie_client import extract_resume, DocIEError
from test_choix_modele import session_pont

ENV = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "secret",
       "DOCIE_MODEL_PROFILE": "store:nuextract3", "DOCIE_TIMEOUT_SECONDS": "360"}


class InlineTests(unittest.TestCase):
    def test_inline_docx_no_registration_or_polling(self):
        fixture = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
        output = json.loads(fixture.read_text(encoding="utf-8"))
        output.update(schema_name="adbi_resume", request_id="request-1"); output["result"]["document_type"] = "adbi_resume"
        session = session_pont((200, output))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.docx"
            with ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice Dupont</w:t></w:r></w:p></w:body></w:document>')
            with patch.dict(os.environ, {**ENV, "DOCIE_MODEL_PROFILE": "lfm2.5-2.6b"}):
                data, metadata = extract_resume(path, session=session)
        session.post.assert_called_once()
        call = session.post.call_args
        self.assertEqual(call.args, ("https://docie.example/v1/extract/text",))
        self.assertEqual(call.kwargs["json"]["schema_mode"], "dynamic")
        self.assertEqual(call.kwargs["json"]["dynamic_schema"]["document_type"], "adbi_resume")
        self.assertNotIn("dynamic_schema_name", call.kwargs["json"])
        self.assertGreater(call.kwargs["timeout"][1], 350)
        self.assertEqual(metadata["event_id"], "request-1")
        self.assertTrue(data["name"])

    # ── Modèle `store:` en cours de chargement (#194) ─────────────────────
    # Réponses SYNTHÉTIQUES : forme lue dans le code DocIE
    # (`api.resolve_profile` → HTTPException 202), jamais reçue ici.

    def _inline(self, *reponses):
        session = session_pont(*reponses)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.docx"
            with ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice Dupont</w:t></w:r></w:p></w:body></w:document>')
            with patch.dict(os.environ, ENV), patch("time.sleep") as sleep:
                try:
                    return extract_resume(path, session=session)
                finally:
                    # Échouer bruyamment : un seul appel, aucune attente.
                    self.assertEqual(session.post.call_count, 1)
                    sleep.assert_not_called()

    @staticmethod
    def _chargement(status=202, **detail):
        return (status, {"detail": {"status": "loading", "deployment": "nuextract3",
                                    "message": "SECRET-AMONT Retry in ~42s.", **detail}})

    def test_202_de_chargement_leve_un_message_clair_avec_le_delai(self):
        with self.assertRaises(DocIEError) as ctx:
            self._inline(self._chargement(eta_seconds=42))
        self.assertEqual(str(ctx.exception), "Modèle en cours de chargement, réessayez dans ~42 s. [loading]")
        self.assertEqual(ctx.exception.code, "loading")
        self.assertNotIn("SECRET-AMONT", str(ctx.exception))

    def test_delai_fractionnaire_arrondi_au_dessus(self):
        with self.assertRaisesRegex(DocIEError, "~42 s"):
            self._inline(self._chargement(eta_seconds=41.2))

    def test_delai_absent_ou_invalide_sans_nombre(self):
        for eta in (None, "42", -1, float("nan"), float("inf"), True, [42]):
            with self.subTest(eta=eta):
                with self.assertRaises(DocIEError) as ctx:
                    self._inline(self._chargement(eta_seconds=eta))
                self.assertEqual(str(ctx.exception),
                                 "Modèle en cours de chargement, réessayez dans quelques instants. [loading]")

    def test_202_sans_corps_lisible_reste_un_chargement(self):
        with self.assertRaisesRegex(DocIEError, "Modèle en cours de chargement, réessayez dans quelques instants"):
            self._inline((202, b"pas du json"))

    def test_202_sans_detail_reste_un_chargement(self):
        with self.assertRaisesRegex(DocIEError, "Modèle en cours de chargement"):
            self._inline((202, {}))

    def test_statut_loading_sous_200_aussi(self):
        with self.assertRaisesRegex(DocIEError, "~7 s"):
            self._inline(self._chargement(status=200, eta_seconds=7))

    def test_json_invalide_hors_chargement_inchange(self):
        with self.assertRaises(DocIEError) as ctx:
            self._inline((200, b"pas du json"))
        self.assertEqual(str(ctx.exception), "Réponse du service d'extraction invalide. [response]")

    def test_scanned_pdf_fails_before_network(self):
        from pypdf import PdfWriter
        session = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scan.pdf"
            writer = PdfWriter()
            writer.add_blank_page(width=100, height=100)
            with path.open("wb") as stream:
                writer.write(stream)
            with patch.dict(os.environ, ENV):
                with self.assertRaisesRegex(DocIEError, "OCR requis"):
                    extract_resume(path, session=session)
        session.post.assert_not_called()

    def test_schema_matches_existing_contract(self):
        racine = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(racine / "document-parsing/scripts"))
        from register_and_test import SCHEMAS
        expected = copy.deepcopy(SCHEMAS["resume"])
        expected["document_type"] = "adbi_resume"
        actual = json.loads((Path(__file__).resolve().parents[1] / "adbi_resume.schema.json").read_text())
        self.assertEqual(actual, expected)
        # Le schema `adbi_resume` existe en DEUX exemplaires, et c'est voulu :
        # l'image cv-parser n'embarque pas document-parsing/, l'image one-pager
        # n'embarque pas cv-parser/ (one-pager/Dockerfile:33 copie l'exemplaire
        # ci-dessous, whitelist .dockerignore:31-32). Voir
        # document-parsing/bridge/README.md.
        #
        # Seul l'exemplaire cv-parser etait epingle (assert ci-dessus). Celui
        # que one-pager EXPEDIE reellement a DocIE
        # (one-pager/lib/docie-extract.js:54) ne l'etait par aucun test, ni ici
        # ni cote JS : le modifier seul ne faisait rougir personne, et les deux
        # services envoyaient alors deux schemas differents pour le meme
        # document, en silence. Meme classe que #177/#179, sur un schema au
        # lieu d'un mapping.
        #
        # Comparaison sur le JSON ANALYSE, jamais sur les octets : les deux
        # fichiers different deja par 217 fins de ligne (CRLF ici, LF chez
        # cv-parser). Un test octet-pour-octet echouerait aujourd'hui pour la
        # mauvaise raison, et se ferait « reparer » en normalisant les fins de
        # ligne -- ce qui ne garde rien du tout. Ne pas non plus relire le meme
        # fichier des deux cotes : la comparaison passerait pour toujours.
        expedie_par_one_pager = json.loads(
            (racine / "document-parsing/schemas/adbi_resume.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(expedie_par_one_pager, expected)
