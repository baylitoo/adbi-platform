"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const cases = require("./contract.json");
const textCases = require("./contract_text.json");
const errorCases = require("./contract_errors.json");
const { extractDocument, extractText, parseResponse, parseTextResponse, filePayload, DocIEBridgeError } = require("../docie-bridge");

const RESUME_SCHEMA = { document_type: "adbi_resume", fields: [{ name: "name", type: "string" }] };

test("shared contract vectors, latency, validation and per-field confidence preserved", () => {
  for (const c of cases) {
    const result = parseResponse(c.body, "adbi_resume", "adbi_agent_1");
    assert.deepEqual(result.result, c.expected_result);
    assert.equal(result.metadata.schema_reported, c.schema_reported);
    // Same keys and numbers as docie_bridge.py::field_confidences — the two
    // bridges feed the same review signal to their respective consumers.
    assert.deepEqual(result.metadata.field_confidence, c.expected_field_confidence);
    // #190 : transport seul, null quand DocIE ne l'a pas (ou pas lisiblement) rapporté.
    assert.equal(result.metadata.prompt_profile, c.expected_prompt_profile ?? null, c.name);
  }
  assert.equal(parseResponse(cases[0].body, "adbi_resume", "adbi_agent_1").metadata.queue_wait_ms, 125);
  assert.equal(parseResponse(cases[1].body, "adbi_resume", "adbi_agent_1").metadata.validation.valid, false);
  assert.equal(parseResponse(cases[2].body, "adbi_resume", "adbi_agent_1").metadata.validation, null);
  // A list DocIE had to truncate: both the capped confidence and the warning survive.
  const truncated = parseResponse(cases[3].body, "adbi_resume", "adbi_agent_1").metadata;
  assert.equal(truncated.field_confidence["experience[0].description"], 0.5);
  assert.equal(truncated.validation.warnings.length, 1);
  assert.equal(truncated.latency_ms, 285014);
  // Warnings are carried verbatim: their prose has no field-path contract to parse.
  assert.equal(parseResponse(cases[4].body, "adbi_resume", "adbi_agent_1").metadata.validation.warnings[0],
    "derived subtotal not found in the document");
});

test("reject incomplete, malformed, wrong schema and wrong agent responses", () => {
  const bad = [null, {}, { choices: [null] }];
  for (const finish of ["length", "tool_calls", "content_filter", null]) {
    const body = structuredClone(cases[0].body); body.choices[0].finish_reason = finish; bad.push(body);
  }
  for (const content of ["", "not JSON", "[]", "{}", '{"schema_name":"kbis","result":{"name":"Alice"}}']) {
    const body = structuredClone(cases[0].body); body.choices[0].message.content = content; bad.push(body);
  }
  const wrong = structuredClone(cases[0].body); wrong.docie_agent.agent = "other-agent"; bad.push(wrong);
  for (const body of bad) assert.throws(() => parseResponse(body, "adbi_resume", "adbi_agent_1"), DocIEBridgeError);
});

test("configuration and input rejected before network", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  let calls = 0;
  const fetchImpl = () => { calls++; throw Error("Unexpected network"); };
  for (const change of [{ DOCIE_BASE_URL: "http://public.example" }, { DOCIE_BASE_URL: "https://user:secret@host" },
    { DOCIE_BASE_URL: "https://host/v1" }, { DOCIE_API_KEY: "" }, { DOCIE_AGENT_RESUME: "../x" },
    { DOCIE_TIMEOUT_SECONDS: "NaN" }, { DOCIE_MAX_TOKENS: "0" }]) {
    await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { env: { ...env, ...change }, fetchImpl }), DocIEBridgeError);
  }
  // image/webp: DocIE refuses it, so it must fail HERE and not after a round
  // trip. text/plain and image/tiff are in DocIE's upload allowlist but not on
  // the agent chat path this transport uses (#180) — same local refusal.
  for (const [content, mime] of [[Buffer.alloc(0), "application/pdf"], [Buffer.from("x"), "text/plain"],
    [Buffer.from("x"), "image/webp"], [Buffer.from("x"), "image/tiff"]]) {
    await assert.rejects(extractDocument(content, mime, { env, fetchImpl }),
      error => error instanceof DocIEBridgeError && error.code === "input");
  }
  assert.equal(calls, 0);
});

test("timeouts, network errors, response limits and reflected keys", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1", DOCIE_TIMEOUT_SECONDS: "1" };
  const input = Buffer.from("pdf");
  await assert.rejects(extractDocument(input, "application/pdf", { env,
    fetchImpl: async () => { throw Error("test-secret"); } }), error => error.code === "network" && !error.message.includes("test-secret"));
  await assert.rejects(extractDocument(input, "application/pdf", { env,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
    }) }), error => error.code === "timeout");
  for (const content of ["not-json test-secret", "x".repeat(8 * 1024 * 1024 + 1)]) {
    await assert.rejects(extractDocument(input, "application/pdf", { env,
      fetchImpl: async () => new Response(content) }), error => error.code === "response" && !error.message.includes("test-secret"));
  }
  const result = await extractDocument(input, "application/pdf", { env,
    fetchImpl: async () => new Response(JSON.stringify(cases[0].body).replace("Alice Dupont", "test-secret")) });
  assert.equal(result.result.name, "[REDACTED]");
});

// #190 — corps d'erreur SYNTHÉTIQUES (tests/contract_errors.json), partagés avec
// test_bridge.py : le dépassement de contexte se reconnaît au texte, jamais au
// seul statut, et le message ne recopie jamais le corps (ni donc la clé).
test("error bodies: context overflow named by its text, other failures unchanged", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  const check = c => error => {
    assert.ok(error instanceof DocIEBridgeError, c.name);
    assert.equal(error.code, c.expected_code, c.name);
    assert.equal(error.status, c.status, c.name);
    assert.ok(!error.message.includes("test-secret"), c.name);
    assert.ok(!/exceeds the available|exceed_context_size_error/.test(error.message), c.name);
    return true;
  };
  for (const c of errorCases) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response(c.body, { status: c.status }); };
    await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { env, fetchImpl }), check(c));
    // Même postJson pour la voie texte : même classement.
    await assert.rejects(extractText("CV", { env, fetchImpl }), check(c));
    assert.equal(calls, 2, c.name);
  }
});

// #190 — plafond de la voie fichier : ce que le bridge accepte tient sous les
// 26 MiB de corps de DocIE. Pire cas autorisé : agent de 128 caractères,
// max_tokens 65536, application/pdf. Côté Node (JSON.stringify compact) MAX+1
// tiendrait encore ; la borne commune est fixée par l'enveloppe Python, plus
// grosse — test_bridge.py vérifie que MAX+1 y dépasserait.
test("file path: largest accepted document fits DocIE's 26 MiB request body, one byte more is refused locally", async () => {
  const LIMIT = 26 * 1024 * 1024, MAX = 20446896;
  const agent = "a".repeat(128);
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: agent, DOCIE_MAX_TOKENS: "65536" };
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push(Buffer.byteLength(options.body)); return new Response(JSON.stringify(cases[2].body)); };
  const result = await extractDocument(Buffer.alloc(MAX), "application/pdf", { env, fetchImpl });
  assert.equal(result.result.name, "Alice Dupont");
  assert.equal(sent.length, 1);
  assert.ok(sent[0] <= LIMIT, "sent " + sent[0] + " > " + LIMIT);
  assert.equal(sent[0], Buffer.byteLength(JSON.stringify(filePayload(Buffer.alloc(MAX), "application/pdf", agent, 65536))));
  await assert.rejects(extractDocument(Buffer.alloc(MAX + 1), "application/pdf", { env, fetchImpl }),
    error => error.code === "input" && error.message.includes(String(MAX)));
  assert.equal(sent.length, 1);
  // La voie texte garde sa borne propre (pas de base64) : 20 MiB d'UTF-8.
  const textSent = [];
  const textFetch = async (url, options) => { textSent.push(options.body.length); return new Response(JSON.stringify(textCases[1].body)); };
  await extractText("a".repeat(MAX + 1), { env, fetchImpl: textFetch });
  await extractText("a".repeat(20 * 1024 * 1024), { env, fetchImpl: textFetch });
  await assert.rejects(extractText("a".repeat(20 * 1024 * 1024 + 1), { env, fetchImpl: textFetch }), error => error.code === "input");
  assert.equal(textSent.length, 2);
});

test("loopback HTTP contract and sanitized failures without retries", async () => {
  let status = 200;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, auth: req.headers.authorization, payload: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status === 200 ? cases[0].body : { error: "test-secret" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { DOCIE_BASE_URL: "http://127.0.0.1:" + server.address().port,
    DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  try {
    const result = await extractDocument(Buffer.from("pdf-bytes"), "application/pdf", { env });
    assert.equal(result.result.name, "Alice Dupont");
    const { url, auth, payload } = calls[0];
    assert.equal(url, "/v1/agents/adbi_agent_1/chat/completions");
    assert.equal(auth, "Bearer test-secret");
    assert.equal(payload.parallel_extraction, true);
    assert.equal(payload.stream, false);
    assert.equal(payload.model, "adbi_agent_1");
    assert.equal(payload.max_tokens, 8192);
    assert.equal(payload.messages[0].content[1].image_url.url, "data:application/pdf;base64,cGRmLWJ5dGVz");
    // 413 carries its own code: DocIE refuses documents beyond the limits its
    // deployment configures (size, OCR blocks, pages), and the 1000-block
    // ceiling cannot be checked locally before sending.
    const codes = { 401: "auth", 403: "auth", 413: "limits", 429: "rate_limit" };
    for (const next of [302, 401, 403, 413, 429, 500, 502]) {
      status = next; const before = calls.length;
      await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { env }), error => {
        assert.equal(error.status, status); assert.equal(error.code, codes[status] || "upstream");
        assert.ok(!error.message.includes("test-secret")); return true;
      });
      assert.equal(calls.length, before + 1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------- voie texte -----
// POST /v1/extract/text — le point d'entree d'une source qui A du texte.

test("shared text contract vectors: flat response, grounding and metadata preserved", () => {
  for (const c of textCases) {
    const result = parseTextResponse(c.body, "adbi_resume");
    assert.deepEqual(result.result, c.expected_result);
    assert.equal(result.metadata.schema_reported, c.schema_reported);
    // Same keys and numbers as docie_bridge.py::parse_text_response.
    assert.deepEqual(result.metadata.field_confidence, c.expected_field_confidence);
    for (const [key, value] of Object.entries(c.expected_metadata)) assert.deepEqual(result.metadata[key], value);
  }
  const recorded = parseTextResponse(textCases[0].body, "adbi_resume").metadata;
  assert.equal(recorded.usage.total_tokens, 5332);
  assert.equal(recorded.validation.valid, true);
  // Absent validation is not a validated success (same rule as the chat path).
  assert.equal(parseTextResponse(textCases[1].body, "adbi_resume").metadata.validation, null);
  const negative = parseTextResponse(textCases[2].body, "adbi_resume").metadata.validation;
  assert.equal(negative.valid, false);
  assert.deepEqual(negative.errors, ["contact manquant"]);
});

test("reject malformed and wrong-schema text responses", () => {
  const bad = [null, [], {}, { result: {} }, { result: "text" },
    { schema_name: "kbis", result: { name: "Alice" } },
    { result: { document_type: "kbis", name: "Alice" } },
    { result: { name: "Alice" }, validation: "ok" }];
  for (const body of bad) assert.throws(() => parseTextResponse(body, "adbi_resume"), DocIEBridgeError);
});

test("text input and configuration rejected before network", async () => {
  // No DOCIE_AGENT_RESUME on purpose: this endpoint has no agent in its URL, so
  // requiring the setting would refuse a call that never uses it.
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret" };
  let calls = 0;
  const fetchImpl = () => { calls++; throw Error("Unexpected network"); };
  for (const change of [{ DOCIE_BASE_URL: "http://public.example" }, { DOCIE_API_KEY: "" }, { DOCIE_TIMEOUT_SECONDS: "NaN" }]) {
    await assert.rejects(extractText("CV", { env: { ...env, ...change }, fetchImpl }), DocIEBridgeError);
  }
  for (const text of ["", "   ", null, Buffer.from("CV")]) {
    await assert.rejects(extractText(text, { env, fetchImpl }),
      error => error instanceof DocIEBridgeError && error.code === "input");
  }
  // A schema describing another document type never leaves the process.
  await assert.rejects(extractText("CV", { dynamicSchema: { document_type: "kbis" }, env, fetchImpl }),
    error => error.code === "input");
  assert.equal(calls, 0);
});

test("text loopback HTTP contract: /v1/extract/text, x-api-key, no data-URI wrapper", async () => {
  let status = 200;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, apiKey: req.headers["x-api-key"], bearer: req.headers.authorization, payload: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status === 200 ? textCases[0].body : { error: "test-secret" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { DOCIE_BASE_URL: "http://127.0.0.1:" + server.address().port, DOCIE_API_KEY: "test-secret" };
  try {
    const result = await extractText("Alice Dupont\nDéveloppeuse", { dynamicSchema: RESUME_SCHEMA, env });
    assert.equal(result.result.name, "Alice Dupont");
    // Grounding survives the text path: the review signal is intact.
    assert.equal(result.metadata.field_confidence["experience[1].description"], 0);
    const { url, apiKey, bearer, payload } = calls[0];
    assert.equal(url, "/v1/extract/text");
    assert.equal(apiKey, "test-secret");
    assert.equal(bearer, undefined);
    assert.equal(payload.text, "Alice Dupont\nDéveloppeuse");
    assert.equal(payload.schema_name, "adbi_resume");
    assert.equal(payload.schema_mode, "dynamic");
    assert.deepEqual(payload.dynamic_schema, RESUME_SCHEMA);
    // No data-URI wrapper and nothing from the chat path: this endpoint reads
    // none of it, and `ocr_blocks` is not sent for plain text.
    for (const absent of ["messages", "model", "max_tokens", "parallel_extraction", "ocr_blocks"]) {
      assert.equal(Object.hasOwn(payload, absent), false, absent);
    }
    const codes = { 401: "auth", 413: "limits", 429: "rate_limit" };
    for (const next of [401, 413, 429, 500]) {
      status = next; const before = calls.length;
      await assert.rejects(extractText("CV", { dynamicSchema: RESUME_SCHEMA, env }), error => {
        assert.equal(error.code, codes[status] || "upstream");
        assert.ok(!error.message.includes("test-secret")); return true;
      });
      assert.equal(calls.length, before + 1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
