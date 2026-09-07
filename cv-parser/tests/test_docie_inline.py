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
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "document-parsing/scripts"))
        from register_and_test import SCHEMAS
        expected = copy.deepcopy(SCHEMAS["resume"])
        expected["document_type"] = "adbi_resume"
        actual = json.loads((Path(__file__).resolve().parents[1] / "adbi_resume.schema.json").read_text())
        self.assertEqual(actual, expected)
