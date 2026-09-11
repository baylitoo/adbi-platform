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
from docie_bridge import extract_document, parse_response, DocIEBridgeError

CASES = json.loads(Path(__file__).with_name("contract.json").read_text())


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
        for content, mime in ((b"", "application/pdf"), (b"x", "text/plain")):
            with self.assertRaises(DocIEBridgeError):
                extract_document(content, mime, env=env, session=session)
        session.post.assert_not_called()

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
            for status in (302, 401, 403, 429, 500, 502):
                state["status"] = status
                before = len(state["calls"])
                with self.assertRaises(DocIEBridgeError) as raised:
                    extract_document(b"pdf", "application/pdf", env=env)
                self.assertEqual(raised.exception.status, status)
                self.assertNotIn("test-secret", str(raised.exception))
                self.assertEqual(len(state["calls"]), before + 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
