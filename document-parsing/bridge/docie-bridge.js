"use strict";

// Server-side counterpart of docie_bridge.py. No browser API key, OCR or retries.
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SCHEMAS = { resume: "adbi_resume", contract: "contract", kbis: "kbis" };
const MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
// A grounded field arrives as {value, ...} alongside at least one of these keys.
// The logprob key is in the set on purpose: DocIE's logprob confidence adds it as
// a fourth key, and an envelope test that ignores it lets a scalar reach the
// consumer as a dict ("Ada" becoming {"value": "Ada", ...}).
//
// BOTH logprob spellings are accepted. DocIE renamed `model_confidence` to
// `model_logprob` -- the value is a natural-log probability, not a 0-1 score, and
// the old name invited exactly that confusion -- but that rename ships in a PR
// that is not merged yet. Accepting both keeps unwrapping correct whichever side
// deploys first, and costs nothing once the rename lands.
//
// Only `confidence` is ever collected as a review signal. `model_logprob` is a
// natural-log probability (<= 0, closer to 0 = more confident), deliberately NOT
// renormalised upstream: comparing it against `confidence`'s 0-1 scale would flag
// every field carrying one, since -7.5 sits well below any 0-1 threshold. It
// ranks fields within one extraction; it is not a threshold input.
const ENVELOPE_MARKERS = ["confidence", "evidence_ids", "model_confidence", "model_logprob"];

class DocIEBridgeError extends Error {
  constructor(code, message, status = null) {
    super(message); this.name = "DocIEBridgeError"; this.code = code; this.status = status;
  }
}
function fail(code, message, status) { throw new DocIEBridgeError(code, message, status); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function configuration(kind, env) {
  if (!Object.hasOwn(SCHEMAS, kind)) fail("configuration", "Unsupported document kind.");
  const base = (env.DOCIE_BASE_URL || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(base); } catch { fail("configuration", "Invalid DocIE API root URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") {
    fail("configuration", "DOCIE_BASE_URL must be the API root without credentials or path.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && env.DOCIE_ALLOW_HTTP !== "true") {
    fail("configuration", "Use HTTPS or explicitly set DOCIE_ALLOW_HTTP=true for a trusted private network.");
  }
  const key = (env.DOCIE_API_KEY || "").trim();
  if (!key || /[\r\n]/.test(key)) fail("configuration", "Configure a valid DOCIE_API_KEY.");
  const agent = (env["DOCIE_AGENT_" + kind.toUpperCase()] || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agent)) fail("configuration", "Configure the document kind's DocIE agent name.");
  const timeout = Number(env.DOCIE_TIMEOUT_SECONDS ?? "360");
  const tokens = Number(env.DOCIE_MAX_TOKENS ?? "8192");
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600 || !Number.isInteger(tokens) || tokens < 1 || tokens > 65536) {
    fail("configuration", "Invalid DocIE timeout or token budget.");
  }
  return { endpoint: base + "/v1/agents/" + agent + "/chat/completions", key, agent, timeout, tokens };
}

function envelope(value) { return object(value) && Object.hasOwn(value, "value") && ENVELOPE_MARKERS.some(key => Object.hasOwn(value, key)); }
function number(value) { return typeof value === "number" && Number.isFinite(value); }

function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (!object(value)) return value;
  if (envelope(value)) return unwrap(value.value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
}

// Per-field confidence, collected before unwrap() drops the envelopes. DocIE
// caps a field's confidence when it had to truncate a repeated/looping list, so
// this is the only per-field "partial, have a human read it" signal it emits.
// Only `confidence` is collected: `model_confidence` is a logprob score on a
// different scale, and the "<= 0.5 means review me" rule holds for the former.
// Keys match docie_bridge.py::field_confidences exactly: "contact.email",
// "experience[0].title", "skills[1].items[2].item". Transport only: the review
// threshold and the mapping to application field paths belong to the consumer.
function fieldConfidences(value, path = "", into = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => fieldConfidences(item, path + "[" + index + "]", into));
  } else if (object(value)) {
    if (envelope(value)) {
      if (path && number(value.confidence)) into[path] = value.confidence;
      return fieldConfidences(value.value, path, into);
    }
    for (const [key, item] of Object.entries(value)) fieldConfidences(item, path ? path + "." + key : key, into);
  }
  return into;
}

// `docie_agent.field_confidence` — {"experience[0].title": {"confidence": 0.5}}.
// DocIE's own per-field map, authoritative when the agent emits it: same dotted
// paths, and it survives an agent that flattens its result before answering
// (there are then no envelopes left for fieldConfidences to read). Returns null
// when absent or unusable, so the caller falls back to the envelopes rather than
// claiming DocIE reported nothing.
function reportedFieldConfidence(meta) {
  const raw = meta.field_confidence;
  if (!object(raw)) return null;
  const reported = {};
  for (const [path, entry] of Object.entries(raw)) {
    const confidence = object(entry) ? entry.confidence : entry;
    if (path && number(confidence)) reported[path] = confidence;
  }
  return reported;
}

function parseResponse(body, expectedSchema, agent) {
  if (!object(body)) fail("response", "Invalid DocIE chat envelope.");
  const choice = Array.isArray(body.choices) && body.choices[0];
  if (!object(choice)) fail("response", "Missing DocIE completion.");
  if (choice.finish_reason !== "stop") fail("incomplete", "DocIE did not finish extraction successfully.");
  let content = choice.message?.content;
  if (typeof content !== "string" || !content.trim()) fail("response", "DocIE returned no final extraction JSON.");
  content = content.trim();
  if (content.startsWith("```") && content.endsWith("```")) content = content.split(/\r?\n/).slice(1, -1).join("\n");
  let extracted;
  try { extracted = JSON.parse(content); } catch { fail("response", "DocIE returned invalid extraction JSON."); }
  if (!object(extracted)) fail("response", "DocIE extraction must be an object.");
  const result = Object.hasOwn(extracted, "result") ? extracted.result : extracted;
  if (!object(result) || !Object.keys(result).length) fail("response", "DocIE returned an empty or malformed result.");
  const meta = body.docie_agent ?? {};
  if (!object(meta)) fail("response", "Invalid DocIE agent metadata.");
  if (meta.agent != null && meta.agent !== agent) fail("schema", "DocIE responded from an unexpected agent.");
  const reported = [extracted.schema_name, result.document_type, meta.schema_name];
  if (reported.some(item => item != null && item !== expectedSchema)) fail("schema", "DocIE returned an unexpected document schema.");
  const validation = Object.hasOwn(meta, "validation") ? meta.validation : (extracted.validation ?? null);
  if (validation != null && !object(validation)) fail("response", "Invalid DocIE validation metadata.");
  const confidence = reportedFieldConfidence(meta);
  const metadata = { request_id: body.id ?? null, agent, model: body.model ?? null,
    validation, usage: body.usage ?? null, field_confidence: confidence ?? fieldConfidences(result),
    schema_reported: reported.some(item => item != null) };
  for (const name of ["queue_wait_ms", "latency_ms", "generation_ms"]) {
    const value = Object.hasOwn(meta, name) ? meta[name] : (Object.hasOwn(extracted, name) ? extracted[name] : body[name]);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metadata[name] = value;
  }
  return { schema_name: expectedSchema, result: unwrap(result), metadata };
}

async function extractDocument(content, mimeType, { kind = "resume", env = process.env, fetchImpl = fetch } = {}) {
  const { endpoint, key, agent, timeout, tokens } = configuration(kind, env);
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_DOCUMENT_BYTES) fail("input", "Document must contain between 1 byte and 20 MiB.");
  if (!MIME_TYPES.has(mimeType)) fail("input", "Unsupported document MIME type; use PDF, PNG, JPEG or WebP.");
  const payload = { model: agent, parallel_extraction: true, stream: false, max_tokens: tokens,
    messages: [{ role: "user", content: [
      { type: "text", text: "Extract the document using your configured schema. Do not invent missing information." },
      { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + content.toString("base64") } },
    ] }] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  const started = performance.now();
  let reader;
  try {
    const response = await fetchImpl(endpoint, { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status !== 200) {
      await response.body?.cancel();
      fail(({ 401: "auth", 403: "auth", 429: "rate_limit" })[response.status] || "upstream", "DocIE request failed (HTTP " + response.status + ").", response.status);
    }
    if (!response.body) fail("response", "DocIE returned an empty response.");
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("response", "DocIE response exceeded 8 MiB.");
      chunks.push(Buffer.from(value));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8").split(key).join("[REDACTED]")); }
    catch { fail("response", "DocIE returned invalid JSON."); }
    const result = parseResponse(body, SCHEMAS[kind], agent);
    result.metadata.elapsed_ms = Math.round(performance.now() - started);
    return result;
  } catch (error) {
    if (error instanceof DocIEBridgeError) throw error;
    if (controller.signal.aborted) fail("timeout", "DocIE timeout; remote processing may continue.");
    fail("network", "DocIE network or TLS failure.");
  } finally {
    clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
}

module.exports = { extractDocument, parseResponse, configuration, DocIEBridgeError };
