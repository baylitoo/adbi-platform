"""No credentials or external network: fake DocIE binds to loopback only."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, MagicMock

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from docie_bridge import (extract_document, extract_text, file_payload, parse_response, parse_text_response,
                          DocIEBridgeError)

CASES = json.loads(Path(__file__).with_name("contract.json").read_text(encoding="utf-8"))
TEXT_CASES = json.loads(Path(__file__).with_name("contract_text.json").read_text(encoding="utf-8"))
ERROR_CASES = json.loads(Path(__file__).with_name("contract_errors.json").read_text(encoding="utf-8"))
RESUME_SCHEMA = {"document_type": "adbi_resume", "fields": [{"name": "name", "type": "string"}]}


class BridgeTests(unittest.TestCase):
    def test_timeouts_network_limits_and_reflected_key(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        for failure, code in ((requests.Timeout(), "timeout"), (requests.ConnectionError("test-secret"), "network")):
            session = Mock()
            session.post.side_effect = failure
            with self.assertRaises(DocIEBridgeError) as raised:
                extract_document(b"pdf", "application/pdf", env=env, session=session)
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("test-secret", str(raised.exception))
            session.post.assert_called_once()
        for chunks, code in (([b"x" * (8 * 1024 * 1024 + 1)], "response"), ([b"not-json test-secret"], "response")):
            session = Mock()
            response = MagicMock(status_code=200)
            response.__enter__.return_value = response
            response.iter_content.return_value = chunks
            session.post.return_value = response
            with self.assertRaises(DocIEBridgeError) as raised:
                extract_document(b"pdf", "application/pdf", env=env, session=session)
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("test-secret", str(raised.exception))
            response.__exit__.assert_called_once()
        response.iter_content.return_value = [json.dumps(CASES[0]["body"]).replace("Alice Dupont", "test-secret").encode()]
        result = extract_document(b"pdf", "application/pdf", env=env, session=session)
        self.assertEqual(result["result"]["name"], "[REDACTED]")

    def test_shared_contract_vectors(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                result = parse_response(case["body"], "adbi_resume", "adbi_agent_1")
                self.assertEqual(result["result"], case["expected_result"])
                self.assertEqual(result["metadata"]["schema_reported"], case["schema_reported"])
                # Same keys and numbers as docie-bridge.js::fieldConfidences — the
                # two bridges feed the same review signal to their consumers.
                self.assertEqual(result["metadata"]["field_confidence"], case["expected_field_confidence"])
                # #190 : transport seul, None quand DocIE ne l'a pas (ou pas lisiblement) rapporté.
                self.assertEqual(result["metadata"]["prompt_profile"], case.get("expected_prompt_profile"))
        meta = parse_response(CASES[0]["body"], "adbi_resume", "adbi_agent_1")["metadata"]
        self.assertEqual(meta["queue_wait_ms"], 125)
        self.assertFalse(parse_response(CASES[1]["body"], "adbi_resume", "adbi_agent_1")["metadata"]["validation"]["valid"])
        self.assertIsNone(parse_response(CASES[2]["body"], "adbi_resume", "adbi_agent_1")["metadata"]["validation"])
        # A list DocIE had to truncate: capped confidence and warning both survive.
        truncated = parse_response(CASES[3]["body"], "adbi_resume", "adbi_agent_1")["metadata"]
        self.assertEqual(truncated["field_confidence"]["experience[0].description"], 0.5)
        self.assertEqual(len(truncated["validation"]["warnings"]), 1)
        self.assertEqual(truncated["latency_ms"], 285014)
        # Warnings are carried verbatim: their prose has no field-path contract.
        self.assertEqual(parse_response(CASES[4]["body"], "adbi_resume", "adbi_agent_1")["metadata"]["validation"]["warnings"][0],
                         "derived subtotal not found in the document")

    def test_rejects_incomplete_invalid_and_wrong_schema(self):
        bad = [None, {}, {"choices": [None]}]
        for finish in ("length", "tool_calls", "content_filter", None):
            item = copy.deepcopy(CASES[0]["body"])
            item["choices"][0]["finish_reason"] = finish
            bad.append(item)
        for content in ("", "not JSON", "[]", "{}", '{"schema_name":"kbis","result":{"name":"Alice"}}'):
            item = copy.deepcopy(CASES[0]["body"])
            item["choices"][0]["message"]["content"] = content
            bad.append(item)
        item = copy.deepcopy(CASES[0]["body"])
        item["docie_agent"]["agent"] = "other-agent"
        bad.append(item)
        for body in bad:
            with self.subTest(body=body), self.assertRaises(DocIEBridgeError):
                parse_response(body, "adbi_resume", "adbi_agent_1")

    def test_configuration_and_input_fail_before_network(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        changes = [{"DOCIE_BASE_URL": "http://public.example"}, {"DOCIE_BASE_URL": "https://user:secret@host"},
                   {"DOCIE_BASE_URL": "https://host/v1"}, {"DOCIE_API_KEY": ""}, {"DOCIE_AGENT_RESUME": "../x"},
                   {"DOCIE_TIMEOUT_SECONDS": "NaN"}, {"DOCIE_MAX_TOKENS": "0"}]
        session = Mock()
        for change in changes:
            with self.subTest(change=change), self.assertRaises(DocIEBridgeError):
                extract_document(b"pdf", "application/pdf", env=env | change, session=session)
        # image/webp: DocIE refuses it, so it must fail HERE and not after a
        # round trip. text/plain and image/tiff are in DocIE's upload allowlist
        # but not on the agent chat path this transport uses (#180) — same
        # local refusal.
        for content, mime in ((b"", "application/pdf"), (b"x", "text/plain"),
                              (b"x", "image/webp"), (b"x", "image/tiff")):
            with self.subTest(mime=mime), self.assertRaises(DocIEBridgeError) as raised:
                extract_document(content, mime, env=env, session=session)
            self.assertEqual(raised.exception.code, "input")
        session.post.assert_not_called()

    def test_error_bodies_context_overflow_named_by_text(self):
        """#190 -- corps d'erreur SYNTHÉTIQUES (tests/contract_errors.json), partagés avec bridge.test.js.

        Le dépassement de contexte se reconnaît au texte, jamais au seul statut,
        et le message ne recopie jamais le corps (ni donc la clé).
        """
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        for case in ERROR_CASES:
            session = Mock()
            response = MagicMock(status_code=case["status"])
            response.__enter__.return_value = response
            response.iter_content.side_effect = lambda *args, body=case["body"]: iter([body.encode("utf-8")] if body else [])
            session.post.return_value = response
            # Même post_json pour la voie texte : même classement, plus `loading`.
            # `expected_code_text` / `expected_eta_seconds` : le code `loading`
            # (#194) n'existe que sur la voie texte ; la voie agent garde `expected_code`.
            paths = (("agent", lambda: extract_document(b"pdf", "application/pdf", env=env, session=session),
                      case["expected_code"], None),
                     ("text", lambda: extract_text("CV", env=env, session=session),
                      case.get("expected_code_text", case["expected_code"]), case.get("expected_eta_seconds")))
            for path, call, code, eta in paths:
                with self.subTest(case=case["name"], path=path), self.assertRaises(DocIEBridgeError) as raised:
                    call()
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(raised.exception.status, case["status"])
                self.assertEqual(raised.exception.eta_seconds, eta)
                self.assertNotIn("test-secret", str(raised.exception))
                self.assertNotRegex(str(raised.exception), "exceeds the available|exceed_context_size_error|is starting|Retry in")
            self.assertEqual(session.post.call_count, 2)

    def test_file_path_limit_fits_docie_request_body(self):
        """#190 -- ce que le bridge accepte tient sous les 26 MiB de corps de DocIE.

        Pire cas autorisé : agent de 128 caractères, max_tokens 65536,
        application/pdf, sérialisé exactement comme requests l'envoie (json=).
        Les deux côtés de la borne : MAX tient, MAX+1 dépasserait et est refusé
        localement, avant tout appel.
        """
        limit, maximum, agent = 26 * 1024 * 1024, 20446896, "a" * 128

        def wire_size(payload):
            prepared = requests.models.PreparedRequest()
            prepared.prepare(method="POST", url="https://docie.example/", json=payload)
            return int(prepared.headers["Content-Length"])

        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
               "DOCIE_AGENT_RESUME": agent, "DOCIE_MAX_TOKENS": "65536"}
        session = Mock()
        response = MagicMock(status_code=200)
        response.__enter__.return_value = response
        response.iter_content.return_value = [json.dumps(CASES[2]["body"]).encode()]
        session.post.return_value = response
        result = extract_document(bytes(maximum), "application/pdf", env=env, session=session)
        self.assertEqual(result["result"]["name"], "Alice Dupont")
        self.assertLessEqual(wire_size(session.post.call_args.kwargs["json"]), limit)
        self.assertGreater(wire_size(file_payload(bytes(maximum + 1), "application/pdf", agent, 65536)), limit)
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_document(bytes(maximum + 1), "application/pdf", env=env, session=session)
        self.assertEqual(raised.exception.code, "input")
        self.assertIn(str(maximum), str(raised.exception))
        self.assertEqual(session.post.call_count, 1)
        # La voie texte garde sa borne propre (pas de base64) : 20 MiB d'UTF-8.
        response.iter_content.return_value = [json.dumps(TEXT_CASES[1]["body"]).encode()]
        extract_text("a" * (maximum + 1), env=env, session=session)
        extract_text("a" * (20 * 1024 * 1024), env=env, session=session)
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_text("a" * (20 * 1024 * 1024 + 1), env=env, session=session)
        self.assertEqual(raised.exception.code, "input")
        self.assertEqual(session.post.call_count, 3)

    def test_http_contract_and_sanitized_failures_no_retries(self):
        state = {"status": 200, "calls": []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                state["calls"].append((self.path, self.headers.get("Authorization"), body))
                self.send_response(state["status"])
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(CASES[0]["body"] if state["status"] == 200 else {"error": "test-secret"}).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {"DOCIE_BASE_URL": "http://127.0.0.1:" + str(server.server_port),
               "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        try:
            result = extract_document(b"pdf-bytes", "application/pdf", env=env)
            self.assertEqual(result["result"]["name"], "Alice Dupont")
            path, auth, payload = state["calls"][0]
            self.assertEqual(path, "/v1/agents/adbi_agent_1/chat/completions")
            self.assertEqual(auth, "Bearer test-secret")
            self.assertIs(payload["parallel_extraction"], True)
            self.assertIs(payload["stream"], False)
            self.assertEqual(payload["model"], "adbi_agent_1")
            self.assertEqual(payload["max_tokens"], 8192)
            self.assertEqual(payload["messages"][0]["content"][1]["image_url"]["url"], "data:application/pdf;base64,cGRmLWJ5dGVz")
            # 413 carries its own code: DocIE refuses documents beyond the
            # limits its deployment configures (size, OCR blocks, pages), and
            # the 1000-block ceiling cannot be checked locally before sending.
            codes = {401: "auth", 403: "auth", 413: "limits", 429: "rate_limit"}
            for status in (302, 401, 403, 413, 429, 500, 502):
                state["status"] = status
                before = len(state["calls"])
                with self.subTest(status=status), self.assertRaises(DocIEBridgeError) as raised:
                    extract_document(b"pdf", "application/pdf", env=env)
                self.assertEqual(raised.exception.status, status)
                self.assertEqual(raised.exception.code, codes.get(status, "upstream"))
                self.assertNotIn("test-secret", str(raised.exception))
                self.assertEqual(len(state["calls"]), before + 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class TextPathTests(unittest.TestCase):
    """POST /v1/extract/text — the entry point for a source that HAS text."""

    ENV = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret"}

    def test_shared_text_contract_vectors(self):
        for case in TEXT_CASES:
            with self.subTest(case=case["name"]):
                result = parse_text_response(case["body"], "adbi_resume")
                self.assertEqual(result["result"], case["expected_result"])
                self.assertEqual(result["metadata"]["schema_reported"], case["schema_reported"])
                # Same keys and numbers as docie-bridge.js::parseTextResponse.
                self.assertEqual(result["metadata"]["field_confidence"], case["expected_field_confidence"])
                for key, value in case["expected_metadata"].items():
                    self.assertEqual(result["metadata"][key], value)
        recorded = parse_text_response(TEXT_CASES[0]["body"], "adbi_resume")["metadata"]
        self.assertEqual(recorded["usage"]["total_tokens"], 5332)
        self.assertTrue(recorded["validation"]["valid"])
        # Absent validation is not a validated success (same rule as the chat path).
        self.assertIsNone(parse_text_response(TEXT_CASES[1]["body"], "adbi_resume")["metadata"]["validation"])
        negative = parse_text_response(TEXT_CASES[2]["body"], "adbi_resume")["metadata"]["validation"]
        self.assertFalse(negative["valid"])
        self.assertEqual(negative["errors"], ["contact manquant"])

    def test_rejects_invalid_and_wrong_schema_text_responses(self):
        bad = [None, [], {}, {"result": {}}, {"result": "text"},
               {"schema_name": "kbis", "result": {"name": "Alice"}},
               {"result": {"document_type": "kbis", "name": "Alice"}},
               {"result": {"name": "Alice"}, "validation": "ok"}]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(DocIEBridgeError):
                parse_text_response(body, "adbi_resume")
        # #194 : un corps `detail.status == "loading"` n'est jamais lu comme une extraction.
        with self.assertRaises(DocIEBridgeError) as raised:
            parse_text_response({"detail": {"status": "loading", "eta_seconds": 3, "message": "test-secret"}}, "adbi_resume")
        self.assertEqual((raised.exception.code, raised.exception.eta_seconds, raised.exception.status), ("loading", 3, None))
        self.assertNotIn("test-secret", str(raised.exception))

    def test_text_input_and_configuration_fail_before_network(self):
        session = Mock()
        for change in ({"DOCIE_BASE_URL": "http://public.example"}, {"DOCIE_API_KEY": ""},
                       {"DOCIE_TIMEOUT_SECONDS": "NaN"}):
            with self.subTest(change=change), self.assertRaises(DocIEBridgeError):
                extract_text("CV", env=self.ENV | change, session=session)
        # No DOCIE_AGENT_RESUME in ENV on purpose: this endpoint has no agent in
        # its URL, so requiring the setting would refuse a call that never uses it.
        for text in ("", "   ", None, b"CV"):
            with self.subTest(text=text), self.assertRaises(DocIEBridgeError) as raised:
                extract_text(text, env=self.ENV, session=session)
            self.assertEqual(raised.exception.code, "input")
        # A schema describing another document type never leaves the process.
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_text("CV", dynamic_schema={"document_type": "kbis"}, env=self.ENV, session=session)
        self.assertEqual(raised.exception.code, "input")
        session.post.assert_not_called()

    def test_text_http_contract_and_failures(self):
        state = {"status": 200, "calls": []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                state["calls"].append((self.path, self.headers.get("x-api-key"), self.headers.get("Authorization"), body))
                self.send_response(state["status"])
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(TEXT_CASES[0]["body"] if state["status"] == 200 else {"error": "test-secret"}).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {"DOCIE_BASE_URL": "http://127.0.0.1:" + str(server.server_port), "DOCIE_API_KEY": "test-secret"}
        try:
            result = extract_text("Alice Dupont\nDéveloppeuse", dynamic_schema=RESUME_SCHEMA, env=env)
            self.assertEqual(result["result"]["name"], "Alice Dupont")
            # Grounding survives the text path: the review signal is intact.
            self.assertEqual(result["metadata"]["field_confidence"]["experience[1].description"], 0.0)
            path, api_key, bearer, payload = state["calls"][0]
            self.assertEqual(path, "/v1/extract/text")
            self.assertEqual(api_key, "test-secret")
            self.assertIsNone(bearer)
            self.assertEqual(payload["text"], "Alice Dupont\nDéveloppeuse")
            self.assertEqual(payload["schema_name"], "adbi_resume")
            self.assertEqual(payload["schema_mode"], "dynamic")
            self.assertEqual(payload["dynamic_schema"], RESUME_SCHEMA)
            # No data-URI wrapper and nothing from the chat path: this endpoint
            # reads none of it, and `ocr_blocks` is not sent for plain text.
            for absent in ("messages", "model", "max_tokens", "parallel_extraction", "ocr_blocks"):
                self.assertNotIn(absent, payload)
            codes = {401: "auth", 403: "auth", 413: "limits", 429: "rate_limit"}
            for status in (401, 413, 429, 500):
                state["status"] = status
                before = len(state["calls"])
                with self.subTest(status=status), self.assertRaises(DocIEBridgeError) as raised:
                    extract_text("CV", dynamic_schema=RESUME_SCHEMA, env=env)
                self.assertEqual(raised.exception.code, codes.get(status, "upstream"))
                self.assertNotIn("test-secret", str(raised.exception))
                self.assertEqual(len(state["calls"]), before + 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
