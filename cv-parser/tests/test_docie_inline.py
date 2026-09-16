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
from docie_client import extract_resume, DocIEError


class InlineTests(unittest.TestCase):
    def test_inline_docx_no_registration_or_polling(self):
        fixture = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
        output = json.loads(fixture.read_text(encoding="utf-8"))
        output.update(schema_name="adbi_resume", request_id="request-1")
        session = Mock()
        session.request.return_value = Mock(status_code=200, json=lambda: output)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.docx"
            with ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice Dupont</w:t></w:r></w:p></w:body></w:document>')
            with patch.dict(os.environ, {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "secret",
                    "DOCIE_EXTRACTION_MODE": "inline", "DOCIE_MODEL_PROFILE": "lfm2.5-2.6b", "DOCIE_TIMEOUT_SECONDS": "360"}):
                data, metadata = extract_resume(path, session=session)
        session.request.assert_called_once()
        call = session.request.call_args
        self.assertEqual(call.args, ("POST", "https://docie.example/v1/extract/text"))
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
        session = Mock()
        session.request.side_effect = list(reponses)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.docx"
            with ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice Dupont</w:t></w:r></w:p></w:body></w:document>')
            with patch.dict(os.environ, {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_EXTRACTION_MODE": "inline",
                                         "DOCIE_MODEL_PROFILE": "store:nuextract3"}), \
                    patch("docie_client.time.sleep") as sleep:
                try:
                    return extract_resume(path, session=session)
                finally:
                    # Échouer bruyamment : un seul appel, aucune attente.
                    self.assertEqual(session.request.call_count, 1)
                    sleep.assert_not_called()

    @staticmethod
    def _chargement(status=202, **detail):
        corps = {"detail": {"status": "loading", "deployment": "nuextract3",
                            "message": "SECRET-AMONT Retry in ~42s.", **detail}}
        return Mock(status_code=status, json=Mock(return_value=corps))

    def test_202_de_chargement_leve_un_message_clair_avec_le_delai(self):
        with self.assertRaises(DocIEError) as ctx:
            self._inline(self._chargement(eta_seconds=42))
        self.assertEqual(str(ctx.exception), "DocIE : modèle en cours de chargement, réessayez dans environ 42 s.")
        self.assertNotIn("SECRET-AMONT", str(ctx.exception))

    def test_delai_fractionnaire_arrondi_au_dessus(self):
        with self.assertRaisesRegex(DocIEError, "environ 42 s"):
            self._inline(self._chargement(eta_seconds=41.2))

    def test_delai_absent_ou_invalide_sans_nombre(self):
        for eta in (None, "42", -1, float("nan"), float("inf"), True, [42]):
            with self.subTest(eta=eta):
                with self.assertRaises(DocIEError) as ctx:
                    self._inline(self._chargement(eta_seconds=eta))
                self.assertEqual(str(ctx.exception),
                                 "DocIE : modèle en cours de chargement, réessayez dans quelques instants.")

    def test_202_sans_corps_lisible_reste_un_chargement(self):
        reponse = Mock(status_code=202, json=Mock(side_effect=ValueError))
        with self.assertRaisesRegex(DocIEError, "modèle en cours de chargement, réessayez dans quelques instants"):
            self._inline(reponse)

    def test_202_sans_detail_reste_un_chargement(self):
        with self.assertRaisesRegex(DocIEError, "modèle en cours de chargement"):
            self._inline(Mock(status_code=202, json=Mock(return_value={})))

    def test_statut_loading_sous_200_aussi(self):
        with self.assertRaisesRegex(DocIEError, "environ 7 s"):
            self._inline(self._chargement(status=200, eta_seconds=7))

    def test_json_invalide_hors_chargement_inchange(self):
        with self.assertRaises(DocIEError) as ctx:
            self._inline(Mock(status_code=200, json=Mock(side_effect=ValueError)))
        self.assertEqual(str(ctx.exception), "DocIE : réponse JSON invalide.")

    def test_voie_studio_un_202_avec_event_ids_n_est_pas_un_chargement(self):
        """Pourquoi la détection est limitée à la voie texte : sur studio, un
        202 peut être un « accepté » ordinaire (réponses synthétiques)."""
        output = json.loads((Path(__file__).resolve().parents[2] / "document-parsing/fixtures/cv_samples/results/simple_docie.json").read_text(encoding="utf-8"))
        session = Mock()
        session.request.side_effect = [
            Mock(status_code=202, json=Mock(return_value={"event_ids": ["event-1"]})),
            Mock(status_code=200, json=Mock(return_value=[{"status": "Completed", "output": output}])),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"test-document")
            with patch.dict(os.environ, {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_EXTRACTION_MODE": "studio",
                                         "DOCIE_SCHEMA_NAME": "resume"}), patch("docie_client.time.sleep"):
                data, metadata = extract_resume(path, session=session)
        self.assertEqual(metadata["event_id"], "event-1")
        self.assertTrue(data["name"])

    def test_scanned_pdf_fails_before_network(self):
        from pypdf import PdfWriter
        session = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scan.pdf"
            writer = PdfWriter()
            writer.add_blank_page(width=100, height=100)
            with path.open("wb") as stream:
                writer.write(stream)
            with patch.dict(os.environ, {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_EXTRACTION_MODE": "inline"}):
                with self.assertRaisesRegex(DocIEError, "OCR requis"):
                    extract_resume(path, session=session)
        session.request.assert_not_called()

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
