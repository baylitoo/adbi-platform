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
from docie_client import DocIEError, extract_resume, map_resume, document_payload
from test_choix_modele import docx, session_pont

FIXTURE = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/cv_samples/results/simple_docie.json"


class DocIEClientTests(unittest.TestCase):
    def setUp(self):
        self.output = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.env = patch.dict(os.environ, {"DOCIE_BASE_URL": "http://docie:8080", "DOCIE_ALLOW_HTTP": "true",
                             "DOCIE_API_KEY": "test-secret", "DOCIE_MODEL_PROFILE": "test-model",
                             "DOCIE_TIMEOUT_SECONDS": "10"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_client(self, responses):
        session = session_pont(*responses)
        path = docx(3)
        self.addCleanup(path.unlink)
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

    def test_extract_authenticates_and_sends_the_text_contract(self):
        self.output.update(schema_name="adbi_resume", request_id="request-1"); self.output["result"]["document_type"] = "adbi_resume"
        (data, meta), session = self.run_client([(200, self.output)])
        self.assertTrue(data["name"])
        self.assertEqual(meta["event_id"], "request-1")
        call = session.post.call_args
        self.assertEqual(call.args, ("http://docie:8080/v1/extract/text",))
        self.assertEqual(call.kwargs["headers"], {"x-api-key": "test-secret"})
        self.assertEqual(call.kwargs["json"]["model_profile"], "test-model")
        self.assertEqual(call.kwargs["json"]["dynamic_schema"]["document_type"], "adbi_resume")
        self.assertFalse(call.kwargs["allow_redirects"])

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
            extract_resume(docx(1), session=Mock())

    def test_rejects_wrong_schema(self):
        self.output["schema_name"] = "contract"
        with self.assertRaises(DocIEError):
            map_resume(self.output)

    def test_schema_absent_est_traite_et_non_refuse(self):
        """#177 ligne 21 : un schéma TU n'est pas un schéma FAUX.

        Le bridge partagé, ses deux ports, accepte une réponse qui ne nomme
        pas son schéma (`item is not None and item != expected`) ; ce client
        la refusait. Le même document passait donc chez one-pager et échouait
        chez cv-parser — une divergence de disponibilité, pas de donnée.
        """
        del self.output["schema_name"]
        data = map_resume(self.output)
        self.assertTrue(data["name"])
        self.assertTrue(data["experience"])

    def test_schema_absent_ne_laisse_pas_passer_un_autre_document(self):
        """Ce que la tolérance ne coûte PAS : une réponse d'un autre schéma
        ne survit pas aux contrôles de structure, faute d'un seul champ de CV."""
        kbis = {"result": {"siren": "123456789", "denomination": "Numelia SAS"}}
        with self.assertRaisesRegex(DocIEError, "aucune donnée"):
            map_resume(kbis)

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
