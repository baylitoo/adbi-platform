import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from docie_client import DocIEError, extract_resume, map_resume, document_payload

FIXTURE = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/cv_samples/results/simple_docie.json"


class DocIEClientTests(unittest.TestCase):
    def setUp(self):
        self.output = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.env = patch.dict(os.environ, {"DOCIE_BASE_URL": "http://docie:8080",
                             "DOCIE_API_KEY": "test-secret", "DOCIE_MODEL_PROFILE": "test-model",
                             "DOCIE_SCHEMA_NAME": "resume", "DOCIE_TIMEOUT_SECONDS": "10",
                             "DOCIE_EXTRACTION_MODE": "studio"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_client(self, responses):
        session = Mock()
        session.request.side_effect = [Mock(status_code=status, json=Mock(return_value=value))
                                       for status, value in responses]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"test-document")
            with patch("docie_client.time.sleep"):
                result = extract_resume(path, session=session)
        return result, session

    def test_maps_real_docie_fixture(self):
        data = map_resume(self.output)
        self.assertTrue(data["name"])
        self.assertTrue(data["education"][0]["title"])
        self.assertTrue(data["experience"][0]["period"])
        self.assertTrue(all(isinstance(v, str) for row in data["skills"] for v in row["items"]))
        self.assertNotIn("confidence", data["contact"])

    def test_logprob_envelope_is_unwrapped_like_the_others(self):
        """La confiance par logprob ajoute `model_confidence` à l'enveloppe.

        Une détection limitée à {value, confidence, evidence_ids} laisserait
        alors chaque scalaire arriver en dict : le nom du candidat s'afficherait
        « {'value': ...} » dans la fiche, sans qu'aucune erreur ne soit levée.
        """
        output = {"schema_name": "resume", "result": {
            "name": {"value": "Ada Lovelace", "model_confidence": 0.82},
            "title": {"value": "Analyste", "confidence": 0.5, "model_confidence": 0.31, "evidence_ids": ["b2"]},
            "experience": [{"title": {"value": "Analyste", "model_confidence": 0.6},
                            "company": {"value": "Numelia", "model_confidence": 0.6}}],
            "education": [], "skills": [], "languages": [], "certifications": [], "interests": [],
        }}
        data = map_resume(output)
        self.assertEqual(data["name"], "Ada Lovelace")
        self.assertEqual(data["title"], "Analyste")
        self.assertEqual(data["experience"][0]["company"], "Numelia")

    def test_extract_polls_and_authenticates(self):
        (data, meta), session = self.run_client([
            (200, {"event_ids": ["event-1"]}),
            (200, {"data": [{"status": "Completed", "ended_at": None}]}),
            (200, {"data": [{"status": "Failed", "ended_at": None}]}),
            (200, [{"status": "Completed", "output": self.output}]),
        ])
        self.assertTrue(data["name"])
        self.assertEqual(meta["event_id"], "event-1")
        first = session.request.call_args_list[0]
        self.assertEqual(first.args, ("POST", "http://docie:8080/v1/studio/extract"))
        self.assertEqual(first.kwargs["json"]["dynamic_schema_name"], "resume")
        self.assertEqual(first.kwargs["json"]["model_profile"], "test-model")
        self.assertEqual(first.kwargs["json"]["content_b64"], "dGVzdC1kb2N1bWVudA==")
        for call in session.request.call_args_list:
            self.assertEqual(call.kwargs["headers"], {"x-api-key": "test-secret"})
            self.assertFalse(call.kwargs["allow_redirects"])

    def test_rejects_failed_or_missing_result(self):
        for row in ({"status": "Failed"}, {"status": "Cancelled"}, {"status": "Completed"}):
            with self.subTest(row=row), self.assertRaises(DocIEError):
                self.run_client([(200, {"event_ids": ["event"]}), (200, [row])])

    def test_rejects_bad_credentials_and_redirects(self):
        for status in (401, 403, 302, 500):
            with self.subTest(status=status), self.assertRaises(DocIEError) as exc:
                self.run_client([(status, {"detail": "test-secret"})])
            self.assertNotIn("test-secret", str(exc.exception))

    def test_rejects_empty_and_malformed_extraction(self):
        for value in ({}, {"result": {}}, {"result": {"name": "Person", "skills": "bad"}},
                      {"result": {"name": "Person", "experience": [None]}}):
            value["schema_name"] = "resume"
            with self.subTest(value=value), self.assertRaises(DocIEError):
                map_resume(value)

    def test_no_config_fails_before_network(self):
        with patch.dict(os.environ, {"DOCIE_BASE_URL": ""}), self.assertRaises(DocIEError):
            extract_resume("does-not-exist.pdf", session=Mock())

    def test_rejects_wrong_schema(self):
        self.output["schema_name"] = "contract"
        with self.assertRaises(DocIEError):
            map_resume(self.output)

    def test_timeout_is_bounded(self):
        with patch("docie_client.time.monotonic", side_effect=[0, 0, 11]):
            with self.assertRaisesRegex(DocIEError, "délai"):
                self.run_client([(200, {"event_ids": ["event"]})])

    def test_docx_uses_text_contract_including_tables(self):
        xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice Martin</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Python</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.docx"
            with ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", xml)
            payload = document_payload(path)
        self.assertEqual(payload["text"], "Alice Martin\nPython")
        self.assertNotIn("content_b64", payload)


if __name__ == "__main__":
    unittest.main()
