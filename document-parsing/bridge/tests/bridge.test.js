"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const cases = require("./contract.json");
const { extractDocument, parseResponse, DocIEBridgeError } = require("../docie-bridge");

test("shared contract vectors, latency and validation preserved", () => {
  for (const c of cases) {
    const result = parseResponse(c.body, "adbi_resume", "adbi_agent_1");
    assert.deepEqual(result.result, c.expected_result);
    assert.equal(result.metadata.schema_reported, c.schema_reported);
  }
  assert.equal(parseResponse(cases[0].body, "adbi_resume", "adbi_agent_1").metadata.queue_wait_ms, 125);
  assert.equal(parseResponse(cases[1].body, "adbi_resume", "adbi_agent_1").metadata.validation.valid, false);
  assert.equal(parseResponse(cases[2].body, "adbi_resume", "adbi_agent_1").metadata.validation, null);
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
  for (const [content, mime] of [[Buffer.alloc(0), "application/pdf"], [Buffer.from("x"), "text/plain"]]) {
    await assert.rejects(extractDocument(content, mime, { env, fetchImpl }), DocIEBridgeError);
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
    for (const next of [302, 401, 403, 429, 500, 502]) {
      status = next; const before = calls.length;
      await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { env }), error => {
        assert.equal(error.status, status); assert.ok(!error.message.includes("test-secret")); return true;
      });
      assert.equal(calls.length, before + 1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
