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
                          compter_blocs_texte, DOCIE_BLOCS_TEXTE_MAX, valider_blocs_ocr, DOCIE_BLOCS_OCR_MAX,
                          DOCIE_BLOC_CARACTERES_MAX, BLOC_CLES, BLOC_SOURCES, reconnaitre_avertissement,
                          resultat_partiel, RAISONS_PARTIEL, MAX_TEXT_BYTES, DocIEBridgeError)

# Jeux d'essai partagés avec bridge.test.js, lus par les TESTS seulement.
FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
BLOCS_TEXTE = json.loads((FIXTURES / "blocs_texte_docie.json").read_text(encoding="utf-8"))
BLOCS_OCR = json.loads((FIXTURES / "blocs_ocr_docie.json").read_text(encoding="utf-8"))
AVERTISSEMENTS = json.loads((FIXTURES / "avertissements_docie.json").read_text(encoding="utf-8"))
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
        # Warnings are carried verbatim, even the ones metadata["partiel"] reads (#194).
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
        limit, maximum, agent = 26 * 1024 * 1024, 20446920, "a" * 128

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
        state = {"status": 200, "calls": [], "retry_after": None}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                state["calls"].append((self.path, self.headers.get("Authorization"), body))
                self.send_response(state["status"])
                self.send_header("Content-Type", "application/json")
                # `Retry-After` seulement sur 429, et seulement quand le test le
                # demande : DocIE l'emet sur le quota par fenetre et le blocage
                # d'IP, PAS sur la limite de concurrence du locataire (mesure
                # chez eux, security.py:178). Les deux cas sont couverts ici.
                if state["status"] == 429 and state["retry_after"] is not None:
                    self.send_header("Retry-After", state["retry_after"])
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
            # Le drapeau n'est plus envoye (#251) — meme contrat que le port JS :
            # l'assertion epingle son ABSENCE, pas sa disparition silencieuse.
            self.assertNotIn("parallel_extraction", payload)
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
                # Sans en-tete, AUCUN code ne porte d'eta : c'est le repli, et il
                # doit rester la regle -- la limite de concurrence du locataire
                # arrive ainsi (429 sans `Retry-After`, security.py:178).
                self.assertIsNone(raised.exception.eta_seconds, status)
                self.assertEqual(len(state["calls"]), before + 1)

            # 429 AVEC `Retry-After` : la valeur remonte dans `eta_seconds`,
            # comme `loading` le fait depuis `detail.eta_seconds`. C'est une
            # LONGUEUR de fenetre, pas un compte a rebours -- le pont la
            # transporte, il ne l'interprete pas.
            #
            # Les chiffres arabes-indiens (« ٣٠ ») ne sont PAS testes ici, et
            # c'est mesure : un en-tete HTTP est du latin-1, donc send_header le
            # refuse, la connexion tombe et le pont rend `network` -- pas
            # `rate_limit`. La valeur ne peut donc jamais arriver par cette voie.
            # Le motif `[0-9]` (et non `\d` ni str.isdigit(), qui les acceptent
            # cote Python) reste la bonne defense, mais elle se verifie sur
            # entier_positif() directement, pas par un aller-retour HTTP.
            state["status"] = 429
            for entete, attendu in (("30", 30), (" 30 ", 30), ("0", 0),
                                    ("-5", None), ("1.5", None), ("abc", None), ("", None),
                                    ("Wed, 21 Oct 2015 07:28:00 GMT", None)):
                state["retry_after"] = entete
                with self.subTest(retry_after=entete), self.assertRaises(DocIEBridgeError) as raised:
                    extract_document(b"pdf", "application/pdf", env=env)
                self.assertEqual(raised.exception.code, "rate_limit")
                self.assertEqual(raised.exception.eta_seconds, attendu)
                # Le message reste constant : l'en-tete renseigne l'eta, jamais
                # le texte.
                self.assertNotIn("test-secret", str(raised.exception))
            state["retry_after"] = None
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
            # `language` est absente PAR DÉFAUT, et c'est un choix : sans langue
            # connue, DocIE lit « Language: unknown », ce qui est VRAI.
            for absent in ("messages", "model", "max_tokens", "parallel_extraction", "ocr_blocks", "language"):
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


class TextBlocksTests(unittest.TestCase):
    """#190 -- blocs que DocIE fera du texte envoyé, plafond silencieux de 800."""

    def test_shared_fixture_matches_cpython_splitlines_and_strip(self):
        self.assertGreaterEqual(len(BLOCS_TEXTE["cas"]), 20)
        for case in BLOCS_TEXTE["cas"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                # La règle DocIE elle-même, recalculée ici : le fichier ne peut
                # pas s'écarter de CPython sans que ce test casse.
                self.assertEqual(sum(1 for ligne in case["texte"].splitlines() if ligne.strip()), case["blocs"])
                self.assertEqual(compter_blocs_texte(case["texte"]), case["blocs"])

    def test_extract_text_reports_blocks_and_possible_truncation_agent_path_null(self):
        self.assertEqual(DOCIE_BLOCS_TEXTE_MAX, 800)
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        session, sent = fake_session(lambda url, payload: TEXT_CASES[1]["body"])
        # Lignes vides et blancs intercalés : ils ne comptent pas, le texte part intact.
        for lignes, attendu in ((800, False), (801, True)):
            texte = "\n \u00a0\n".join("ligne " + str(i) for i in range(lignes))
            metadata = extract_text(texte, env=env, session=session)["metadata"]
            self.assertEqual(metadata["blocs_texte"], lignes)
            self.assertIs(metadata["troncature_possible"], attendu)
            self.assertEqual(sent[-1][1]["text"], texte)
        # Séparateurs Python et BOM seul : 800 lignes pour un split naïf, 801 blocs pour DocIE.
        piege = "\n".join("l" + str(i) for i in range(800)) + "\u2028\ufeff"
        metadata = extract_text(piege, env=env, session=session)["metadata"]
        self.assertEqual((metadata["blocs_texte"], metadata["troncature_possible"]), (801, True))
        # Appel direct du parseur : le texte n'y est pas, donc « inconnu ».
        self.assertIsNone(parse_text_response(TEXT_CASES[1]["body"], "adbi_resume")["metadata"]["blocs_texte"])
        # Voie agent : l'OCR distant fait les blocs, rien à compter ici.
        agent_session, _ = fake_session(lambda url, payload: CASES[2]["body"])
        metadata = extract_document(b"pdf", "application/pdf", env=env, session=agent_session)["metadata"]
        self.assertEqual((metadata["blocs_texte"], metadata["troncature_possible"]), (None, None))


class OcrBlocksTests(unittest.TestCase):
    """Blocs fournis par l'appelant : ils remplacent le découpage de DocIE."""

    def test_shared_fixture_accepted_and_refused_shapes_and_sent_copy(self):
        # Le jeu d'essai et le code nomment les mêmes clés et les mêmes sources :
        # une clé ajoutée d'un côté sans l'autre casse ici, pas en production.
        self.assertEqual(set(BLOC_CLES), set(BLOCS_OCR["cles_bloc"]))
        self.assertEqual(set(BLOC_SOURCES), set(BLOCS_OCR["sources_valides"]))
        for case in BLOCS_OCR["cas"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                if not case["valide"]:
                    with self.assertRaises(DocIEBridgeError) as raised:
                        valider_blocs_ocr(case["blocs"])
                    self.assertEqual(raised.exception.code, "input")
                    continue
                propres, _ = valider_blocs_ocr(case["blocs"])
                self.assertEqual(len(propres), case["blocs_comptes"])
                # Copie et non passe-plat : mêmes clés que l'appelant, jamais d'autres.
                for propre, fourni in zip(propres, case["blocs"]):
                    self.assertEqual(set(propre), set(fourni))
                    self.assertEqual(propre, fourni)

    def test_caps_are_docie_s_and_characters_are_code_points(self):
        self.assertEqual(DOCIE_BLOCS_OCR_MAX, BLOCS_OCR["limites"]["blocs_max"])
        self.assertEqual(DOCIE_BLOC_CARACTERES_MAX, BLOCS_OCR["limites"]["caracteres_par_bloc_max"])
        for case in BLOCS_OCR["cas_plafonds"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                if case.get("nombre") is not None:
                    blocs = [{"id": "b" + str(i), "text": "x"} for i in range(case["nombre"])]
                elif case.get("caracteres") is not None:
                    blocs = [{"id": "b0", "text": "x" * case["caracteres"]}]
                else:
                    blocs = [{"id": "b0", "text": case["texte_repete"] * case["repetitions"]}]
                if case["valide"]:
                    self.assertEqual(len(valider_blocs_ocr(blocs)[0]), len(blocs))
                else:
                    with self.assertRaises(DocIEBridgeError) as raised:
                        valider_blocs_ocr(blocs)
                    self.assertEqual(raised.exception.code, "input")

    def test_extract_text_sends_blocks_verbatim_keeps_text_and_counts_blocks(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
               "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        session, sent = fake_session(lambda url, payload: TEXT_CASES[1]["body"])
        # 1 200 lignes non vides, regroupées en 300 blocs de paragraphes : sans
        # blocs le compteur annonce une troncature possible, avec eux non.
        texte = "\n".join("ligne " + str(i) for i in range(1200))
        sans = extract_text(texte, env=env, session=session)["metadata"]
        self.assertEqual((sans["blocs_texte"], sans["troncature_possible"], sans["blocs_fournis"]), (1200, True, False))
        self.assertNotIn("ocr_blocks", sent[-1][1])
        blocs = [{"id": "p" + str(i % 10 + 1) + "b" + str(i), "text": "paragraphe " + str(i),
                  "page": i % 10 + 1, "source": "manual"} for i in range(300)]
        avec = extract_text(texte, ocr_blocks=blocs, env=env, session=session)["metadata"]
        self.assertEqual((avec["blocs_texte"], avec["troncature_possible"], avec["blocs_fournis"]), (300, False, True))
        # `text` part quand même (document_hash stable), les blocs tels quels.
        self.assertEqual(sent[-1][1]["text"], texte)
        self.assertEqual(sent[-1][1]["ocr_blocks"], blocs)
        # Appel direct du parseur : ni texte ni blocs, donc « inconnu ».
        self.assertIsNone(parse_text_response(TEXT_CASES[1]["body"], "adbi_resume")["metadata"]["blocs_fournis"])
        # Voie agent : l'OCR distant fait les blocs, et `ocr_blocks` n'existe
        # même pas dans ce corps — None comme ses deux voisins, jamais absent.
        agent_session, _ = fake_session(lambda url, payload: CASES[2]["body"])
        agent = extract_document(b"pdf", "application/pdf", env=env, session=agent_session)["metadata"]
        self.assertIsNone(agent["blocs_fournis"])

    def test_text_and_blocks_are_bounded_together(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret"}
        session, _ = fake_session(lambda url, payload: TEXT_CASES[1]["body"])
        # Un texte pile au plafond passe seul ; le moindre bloc en plus fait un
        # corps au-dessus, et c'est le corps qui part. Les blocs, eux, restent
        # valides un par un (< 20 000 caractères) : sans la borne commune, rien
        # ne verrait ce dépassement avant le refus de DocIE.
        texte = "x" * MAX_TEXT_BYTES
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_text(texte, ocr_blocks=[{"id": "b0", "text": "paragraphe"}], env=env, session=session)
        self.assertEqual(raised.exception.code, "input")
        self.assertIn("together", str(raised.exception))


class PartialResultTests(unittest.TestCase):
    """#194 -- avertissements DocIE de résultat partiel -> metadata["partiel"]."""

    def test_shared_fixture_closed_reasons_unknown_ignored_never_raises(self):
        self.assertEqual(list(RAISONS_PARTIEL), AVERTISSEMENTS["_raisons"])
        couvertes = set()
        for case in AVERTISSEMENTS["avertissements"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                self.assertEqual(reconnaitre_avertissement(case["avertissement"]), case["attendu"])
            if case["attendu"]:
                couvertes.add(case["attendu"]["raison"])
        # Listes : par le vrai parseur, donc après déballage des enveloppes.
        for case in AVERTISSEMENTS["listes"]:
            with self.subTest(case=case["nom"], preuve=case["preuve"]):
                self.assertEqual(parse_text_response({"result": case["result"]}, "adbi_resume")["metadata"]["partiel"],
                                 case["attendu"])
            couvertes.update(entree["raison"] for entree in case["attendu"])
        # Chaque raison du jeu fermé a au moins un cas.
        self.assertEqual(couvertes, set(RAISONS_PARTIEL))
        # Tous les avertissements à la fois : seuls les reconnus, dans l'ordre.
        warnings = [case["avertissement"] for case in AVERTISSEMENTS["avertissements"]]
        self.assertEqual(resultat_partiel({"valid": True, "warnings": warnings}, {}),
                         [case["attendu"] for case in AVERTISSEMENTS["avertissements"] if case["attendu"]])
        # Formes inattendues : jamais d'exception.
        for validation in (None, "x", [], {"warnings": "skills: model output repeated itself (x)"}, {"warnings": None}):
            self.assertEqual(resultat_partiel(validation, {"extraction_notes": 7}), [])

    def test_both_paths_warnings_verbatim_extraction_notes_counted_once(self):
        cas = {case["nom"]: case["avertissement"] for case in AVERTISSEMENTS["avertissements"]}
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        # Aucun vecteur existant n'est partiel.
        for case in CASES:
            self.assertEqual(parse_response(case["body"], "adbi_resume", "adbi_agent_1")["metadata"]["partiel"], [], case["name"])
        for case in TEXT_CASES:
            self.assertEqual(parse_text_response(case["body"], "adbi_resume")["metadata"]["partiel"], [], case["name"])
        # Voie texte : la boucle arrive dans validation.warnings ET result.extraction_notes.
        text = copy.deepcopy(TEXT_CASES[0]["body"])
        text["validation"]["warnings"] = [cas["boucle"], "derived subtotal not found in the document", cas["nombre_abandonne"]]
        text["result"]["extraction_notes"] = [cas["boucle"]]
        text["result"]["interests"] = {"value": ["centre " + str(i) for i in range(100)], "confidence": 1, "evidence_ids": []}
        avant = copy.deepcopy(text["validation"])
        session, _ = fake_session(lambda url, payload: text)
        lu = extract_text("CV", env=env, session=session)
        self.assertEqual(lu["metadata"]["partiel"], [{"champ": "skills", "raison": "boucle"},
                                                     {"champ": "tjm", "raison": "valeur_abandonnee"},
                                                     {"champ": "interests", "raison": "liste_plafonnee_possible"}])
        self.assertEqual(lu["metadata"]["validation"], avant)
        self.assertIs(lu["metadata"]["validation"]["valid"], True)
        self.assertEqual(lu["result"]["extraction_notes"], [cas["boucle"]])
        # Sans `validation`, `result.extraction_notes` suffit.
        notes = {"result": {"name": "Ada", "extraction_notes": [cas["feuille_abandonnee"]]}}
        self.assertEqual(parse_text_response(notes, "adbi_resume")["metadata"]["partiel"],
                         [{"champ": "contact.email", "raison": "feuille_abandonnee"}])
        # Voie agent : docie_agent.validation.warnings.
        agent = copy.deepcopy(CASES[3]["body"])
        agent["docie_agent"]["validation"]["warnings"].append(cas["forme_invalide"])
        avant_agent = copy.deepcopy(agent["docie_agent"]["validation"])
        agent_session, _ = fake_session(lambda url, payload: agent)
        lu_agent = extract_document(b"pdf", "application/pdf", env=env, session=agent_session)
        self.assertEqual(lu_agent["metadata"]["partiel"], [{"champ": "experience[2].dates", "raison": "forme_invalide"}])
        self.assertEqual(lu_agent["metadata"]["validation"], avant_agent)


def fake_session(answer, status=200):
    """Frontière HTTP simulée : garde (url, corps envoyé) de chaque POST.

    `answer(url, payload)` construit le corps renvoyé ; `status` est lu à
    chaque appel (liste à un élément, modifiable par le test).
    """
    status = status if isinstance(status, list) else [status]
    sent = []

    def post(url, **kwargs):
        sent.append((url, copy.deepcopy(kwargs["json"])))
        response = MagicMock(status_code=status[0])
        response.__enter__.return_value = response
        body = json.dumps(answer(url, kwargs["json"])).encode()
        response.iter_content.side_effect = lambda *args: iter([body])
        return response

    session = Mock()
    session.post.side_effect = post
    return session, sent


class PerCallChoiceTests(unittest.TestCase):
    """#194 -- modèle (voie texte) ou agent (voie agent) choisi par appel."""

    def test_text_model_profile_overrides_env_for_that_call_only(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
               "DOCIE_MODEL_PROFILE": "store:env-default"}
        snapshot = dict(env)
        status = [200]
        answer = dict(copy.deepcopy(TEXT_CASES[1]["body"]), model_profile="store:served-by-docie")
        loading = {"detail": {"status": "loading", "deployment": "nuextract3", "eta_seconds": 42, "message": "test-secret"}}
        session, sent = fake_session(lambda url, payload: answer if status[0] == 200 else loading, status)
        # Surcharge : la requête change, metadata["model"] reste ce que DocIE rapporte.
        chosen = extract_text("CV", model_profile="store:lfm2.5-2.6b", env=env, session=session)
        self.assertEqual(sent[0][0], "https://docie.example/v1/extract/text")
        self.assertEqual(sent[0][1], {"text": "CV", "schema_name": "adbi_resume", "model_profile": "store:lfm2.5-2.6b"})
        self.assertEqual(chosen["metadata"]["model"], "store:served-by-docie")
        # Même dict env, sans surcharge : la valeur d'environnement revient.
        extract_text("CV", env=env, session=session)
        self.assertEqual(sent[1][1], {"text": "CV", "schema_name": "adbi_resume", "model_profile": "store:env-default"})
        # Ni surcharge ni variable : aucun `model_profile`, comme avant.
        extract_text("CV", env={"DOCIE_BASE_URL": env["DOCIE_BASE_URL"], "DOCIE_API_KEY": env["DOCIE_API_KEY"]}, session=session)
        self.assertEqual(sent[2][1], {"text": "CV", "schema_name": "adbi_resume"})
        # Strip comme DOCIE_MODEL_PROFILE ; `store:<nom>` sans autre transformation.
        extract_text("CV", model_profile="  store:NuExtract3_v1.2  ", env=env, session=session)
        self.assertEqual(sent[3][1]["model_profile"], "store:NuExtract3_v1.2")
        # Le `store:` choisi par appel mène au code `loading` déjà en place.
        status[0] = 202
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_text("CV", model_profile="store:nuextract3", env=env, session=session)
        self.assertEqual((raised.exception.code, raised.exception.eta_seconds), ("loading", 42))
        self.assertNotIn("test-secret", str(raised.exception))
        self.assertEqual(sent[4][1]["model_profile"], "store:nuextract3")
        self.assertEqual(len(sent), 5)
        self.assertEqual(env, snapshot)

    def test_agent_overrides_env_for_that_call_only(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret", "DOCIE_AGENT_RESUME": "adbi_agent_1"}
        snapshot = dict(env)

        def answer(url, payload):
            # Le faux DocIE répond au nom de l'agent présent dans l'URL.
            body = copy.deepcopy(CASES[0]["body"])
            body["docie_agent"]["agent"] = url.split("/")[5]
            return body

        session, sent = fake_session(answer)
        chosen = extract_document(b"pdf", "application/pdf", agent="adbi_resume_nuextract3", env=env, session=session)
        self.assertEqual(sent[0][0], "https://docie.example/v1/agents/adbi_resume_nuextract3/chat/completions")
        # Corps inchangé à part l'agent : aucun champ `model` ajouté (DocIE l'écrase).
        self.assertEqual(sent[0][1], file_payload(b"pdf", "application/pdf", "adbi_resume_nuextract3", 8192))
        self.assertEqual(chosen["metadata"]["agent"], "adbi_resume_nuextract3")
        # Même dict env, sans surcharge : l'agent d'environnement revient.
        fallback = extract_document(b"pdf", "application/pdf", env=env, session=session)
        self.assertEqual(sent[1][0], "https://docie.example/v1/agents/adbi_agent_1/chat/completions")
        self.assertEqual(fallback["metadata"]["agent"], "adbi_agent_1")
        self.assertEqual(env, snapshot)
        # Avec un agent par appel, DOCIE_AGENT_RESUME n'est pas exigé ; sans, il l'est toujours.
        no_agent_env = {"DOCIE_BASE_URL": env["DOCIE_BASE_URL"], "DOCIE_API_KEY": env["DOCIE_API_KEY"]}
        self.assertEqual(extract_document(b"pdf", "application/pdf", agent=" spark ", env=no_agent_env,
                                          session=session)["metadata"]["agent"], "spark")
        self.assertEqual(sent[2][0], "https://docie.example/v1/agents/spark/chat/completions")
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_document(b"pdf", "application/pdf", env=no_agent_env, session=session)
        self.assertEqual(raised.exception.code, "configuration")
        # Une réponse d'un autre agent que celui appelé reste refusée.
        other, _ = fake_session(lambda url, payload: CASES[0]["body"])  # docie_agent.agent = adbi_agent_1
        with self.assertRaises(DocIEBridgeError) as raised:
            extract_document(b"pdf", "application/pdf", agent="adbi_resume_nuextract3", env=env, session=other)
        self.assertEqual(raised.exception.code, "schema")
        self.assertEqual(len(sent), 3)

    def test_format_checked_before_network_with_input_code_no_allowlist(self):
        env = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
               "DOCIE_AGENT_RESUME": "adbi_agent_1", "DOCIE_MODEL_PROFILE": "store:env-default"}
        session = Mock()
        for profile in ("", "   ", "store:a\nb", "store:a\x00b", "a\tb", "a\x7fb", "x" * 129, "é" * 65, 42, {}):
            with self.subTest(model_profile=profile), self.assertRaises(DocIEBridgeError) as raised:
                extract_text("CV", model_profile=profile, env=env, session=session)
            self.assertEqual(raised.exception.code, "input")
        for agent in ("", "   ", "../x", "a/b", "store:x", "a b", "a" * 129, 7):
            with self.subTest(agent=agent), self.assertRaises(DocIEBridgeError) as raised:
                extract_document(b"pdf", "application/pdf", agent=agent, env=env, session=session)
            self.assertEqual(raised.exception.code, "input")
        session.post.assert_not_called()
        # Forme seule : tout nom bien formé part, au plafond compris -- la liste est au catalogue.
        text_ok, sent = fake_session(lambda url, payload: TEXT_CASES[1]["body"])
        for profile in ("x" * 128, "é" * 64, "store:absent-de-tout-catalogue", "models.yaml-profile"):
            extract_text("CV", model_profile=profile, env=env, session=text_ok)
            self.assertEqual(sent[-1][1]["model_profile"], profile)
        file_ok, _ = fake_session(lambda url, payload: CASES[2]["body"])
        extract_document(b"pdf", "application/pdf", agent="a" * 128, env=env, session=file_ok)


class LanguageTests(unittest.TestCase):
    """Langue du document : fournie par l'appelant, jamais devinée ici."""

    ENV = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
           "DOCIE_AGENT_RESUME": "adbi_agent_1"}

    def test_language_sent_verbatim_absent_by_default_never_on_agent_path(self):
        session, sent = fake_session(lambda url, payload: TEXT_CASES[1]["body"])
        # Fournie : elle part VERBATIM. DocIE ne valide ni ne normalise rien
        # (`language: str | None`, schemas/api.py:26) ; la valeur atteint la ligne
        # du prompt et la fabrique OCR sans être touchée.
        for langue, attendu in (("fr", "fr"), ("  fr  ", "fr"), ("fr-FR", "fr-FR"), ("EN", "EN")):
            with self.subTest(langue=langue):
                extract_text("CV", langue=langue, env=self.ENV, session=session)
                self.assertEqual(sent[-1][1]["language"], attendu)
        # Absente : aucune clé. « Language: unknown » côté DocIE est une réponse
        # honnête ; un défaut « fr » posé ici mentirait sur un document anglais.
        extract_text("CV", env=self.ENV, session=session)
        self.assertNotIn("language", sent[-1][1])
        # Voie AGENT : la langue vient de la SPEC de l'agent (agents/runtime.py:550),
        # jamais du corps. L'ajouter ici serait accepté puis ignoré en silence.
        agent_session, agent_sent = fake_session(lambda url, payload: CASES[2]["body"])
        extract_document(b"pdf", "application/pdf", env=self.ENV, session=agent_session)
        self.assertNotIn("language", agent_sent[-1][1])

    def test_malformed_language_refused_before_network_no_allowlist(self):
        session = Mock()
        # Seule justification : cette chaîne entre VERBATIM dans un prompt et
        # rien ne la filtre côté DocIE (pas de validateur sur
        # `language: str | None`). PAS de casse OCR à invoquer ici : la voie
        # texte n'instancie aucun backend OCR (extract/service.py:344-384), la
        # fabrique n'étant atteinte que par les voies fichier (:452, :557).
        for langue in ("", "   ", "f", "francais_long", "fr;DROP", "fr\nLanguage: en", 42, {}, "fr-"):
            with self.subTest(langue=langue), self.assertRaises(DocIEBridgeError) as raised:
                extract_text("CV", langue=langue, env=self.ENV, session=session)
            self.assertEqual(raised.exception.code, "input")
        session.post.assert_not_called()
        # Forme seule : aucune liste de langues autorisées. Le transport ne décide
        # pas lesquelles existent -- c'est DocIE et son moteur OCR qui tranchent.
        ok, sent = fake_session(lambda url, payload: TEXT_CASES[1]["body"])
        for langue in ("de", "pt-BR", "zh", "ar"):
            extract_text("CV", langue=langue, env=self.ENV, session=ok)
            self.assertEqual(sent[-1][1]["language"], langue)


if __name__ == "__main__":
    unittest.main()
