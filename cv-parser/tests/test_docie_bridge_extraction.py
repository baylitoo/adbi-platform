"""Tests du chemin d'extraction via le bridge DocIE partagé (issue #151).

Aucun appel réseau réel : le transport HTTP du bridge
(document-parsing/bridge/docie_bridge.py) est bouché via une session
`requests` simulée, comme document-parsing/bridge/tests/test_bridge.py le
fait déjà pour le bridge lui-même — cf. politique du dépôt : "Aucun appel
distant DocIE par agent ADBI".
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "document-parsing" / "bridge"))

from docie_client import DocIEError
import docie_bridge_extraction as bridge_extraction

BRIDGE_ENV = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
              "DOCIE_AGENT_RESUME": "adbi_agent_1"}

FIXTURE_BODY = {
    "id": "chatcmpl-test", "model": "spark-x2.5-1.7b",
    "choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps({"document_type": "adbi_resume", "name": "Alice Dupont",
                                "title": "Développeuse", "experience": [], "education": [],
                                "skills": [], "languages": [], "projects": [],
                                "certifications": [], "interests": []})}}],
    "usage": {"prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130},
    "docie_agent": {"agent": "adbi_agent_1", "validation": {"valid": True, "errors": [], "warnings": []}},
}


def _fake_session(chunks):
    session = Mock()
    response = MagicMock(status_code=200)
    response.__enter__.return_value = response
    response.iter_content.return_value = chunks
    session.post.return_value = response
    return session


class DocieExtractionEnabledTests(unittest.TestCase):
    def test_default_is_disabled(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOCIE_EXTRACTION_ENABLED", None)
            self.assertFalse(bridge_extraction.docie_extraction_enabled())

    def test_flag_check_never_imports_the_bridge_module(self):
        """Flag off must not require docie_bridge.py to even be importable
        (e.g. before the Docker image's additional_contexts copy lands) —
        this is the structural guarantee behind "flag off = unchanged"."""
        sys.modules.pop("docie_bridge", None)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOCIE_EXTRACTION_ENABLED", None)
            bridge_extraction.docie_extraction_enabled()
        self.assertNotIn("docie_bridge", sys.modules)

    def test_recognized_truthy_values(self):
        for value in ("1", "true", "TRUE", "on", "On"):
            with patch.dict(os.environ, {"DOCIE_EXTRACTION_ENABLED": value}):
                self.assertTrue(bridge_extraction.docie_extraction_enabled())

    def test_other_values_stay_disabled(self):
        for value in ("0", "false", "off", "yes", ""):
            with patch.dict(os.environ, {"DOCIE_EXTRACTION_ENABLED": value}):
                self.assertFalse(bridge_extraction.docie_extraction_enabled())


class BridgeExtractionSuccessTests(unittest.TestCase):
    def test_pdf_goes_through_bridge_and_maps_into_cv_master_shape(self):
        session = _fake_session([json.dumps(FIXTURE_BODY).encode()])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                data, metadata = bridge_extraction.extract_resume(path, session=session)

        # Un seul POST vers l'agent bridge, jamais l'ancien chemin DocIE.
        session.post.assert_called_once()
        endpoint = session.post.call_args.args[0]
        self.assertEqual(endpoint, "https://docie.example/v1/agents/adbi_agent_1/chat/completions")

        # docie_client.map_resume a bien tourné : la structure cv_master (listes
        # education/skills/.../contact) est déjà en place pour normalize_cv_data.
        self.assertEqual(data["name"], "Alice Dupont")
        for key in ("experience", "education", "skills", "languages", "projects", "certifications", "interests"):
            self.assertIn(key, data)
            self.assertIsInstance(data[key], list)

        self.assertEqual(metadata["transport"], "docie-bridge")
        self.assertEqual(metadata["model_profile"], "spark-x2.5-1.7b")
        self.assertEqual(metadata["validation"], {"valid": True, "errors": [], "warnings": []})

    def test_progress_callback_is_invoked(self):
        session = _fake_session([json.dumps(FIXTURE_BODY).encode()])
        seen = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                bridge_extraction.extract_resume(path, progress=seen.append, session=session)
        self.assertTrue(seen)


class BridgeExtractionFailureTests(unittest.TestCase):
    def test_bridge_error_becomes_docie_error_without_a_second_call(self):
        session = Mock()
        session.post.side_effect = __import__("requests").Timeout()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                with self.assertRaises(DocIEError) as raised:
                    bridge_extraction.extract_resume(path, session=session)
        self.assertIn("timeout", str(raised.exception))
        session.post.assert_called_once()

    def test_upstream_http_error_becomes_docie_error(self):
        session = Mock()
        response = MagicMock(status_code=500)
        response.__enter__.return_value = response
        session.post.return_value = response
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                with self.assertRaises(DocIEError):
                    bridge_extraction.extract_resume(path, session=session)
        session.post.assert_called_once()

    def test_missing_configuration_fails_before_any_network_call(self):
        session = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, {**BRIDGE_ENV, "DOCIE_AGENT_RESUME": ""}):
                with self.assertRaises(DocIEError):
                    bridge_extraction.extract_resume(path, session=session)
        session.post.assert_not_called()


class DocxDelegationTests(unittest.TestCase):
    def test_docx_delegates_to_legacy_client_single_call(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.docx"
            path.write_bytes(b"not-a-real-docx")
            fake_legacy = Mock(return_value=({"name": "Bob"}, {"event_id": "e1", "model_profile": "m",
                                                                  "validation": {}}))
            with patch("docie_bridge_extraction.docie_client.extract_resume", fake_legacy):
                with patch.dict(os.environ, BRIDGE_ENV):
                    data, metadata = bridge_extraction.extract_resume(path)
        fake_legacy.assert_called_once()
        self.assertEqual(data["name"], "Bob")
        self.assertEqual(metadata["transport"], "docie")


if __name__ == "__main__":
    unittest.main()
