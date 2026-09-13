"use strict";

// Server-side counterpart of docie_bridge.py. No browser API key, OCR or retries.
//
// Two entry points, one per DocIE surface, because the two surfaces are
// genuinely different -- not because text is a "format" the first could take:
//
//   extractDocument(buffer, mimeType)  POST /v1/agents/<agent>/chat/completions
//       The document travels as an `image_url` data URI and DocIE's OCR
//       backends read it. Only what those backends read may be sent.
//
//   extractText(text)                  POST /v1/extract/text
//       The text travels as `text` in the body, no data-URI wrapper, and DocIE
//       blocks it itself. For a source that already HAS readable text.
//
// Routing rule, from DocIE's team (#180): use the structure the source actually
// has. Not "prefer the text path" -- a scanned PDF has no text at all.
//
// Our own caps, chosen locally before DocIE's were known. 20 MiB stays: it sits
// inside DocIE's own guards. DocIE's documented limits, per its team: 25 MB
// upload, 26 MB request body, 1,000,000 characters of text, 1,000 OCR blocks
// per document, 20,000 characters per block, 50 metadata entries, 8 pages
// (vision path only). Those are that service's DEFAULTS, not facts about the
// instance we call -- an operator sets them per deployment, and nothing DocIE
// exposes (/healthz, /readyz, /metrics, /v1/schemas) reports the values in
// force, so this copy can be wrong from a deployment's first day.
//
// The 1,000-block ceiling is the limit that bites first on a long document: a
// dense three-page PDF reaches it at a few megabytes, so MAX_DOCUMENT_BYTES
// guards the wrong dimension and no local check can see that failure coming.
// A document refused for it arrives here after the call, in one of three
// already-handled shapes: HTTP 413 -> code "limits" (below), `validation`
// errors (preserved verbatim in metadata, surfaced by the consumers), or a
// non-"stop" finish_reason -> code "incomplete". Which shape DocIE actually
// uses for the block ceiling is not recorded anywhere we can check; see #180.
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SCHEMAS = { resume: "adbi_resume", contract: "contract", kbis: "kbis" };
// What the AGENT CHAT path accepts, which is not DocIE's upload allowlist.
// This transport posts the document as an `image_url` data URI to
// /v1/agents/<agent>/chat/completions, where DocIE OCRs it: liteparse renders
// PDF pages, tesseract and paddle take images. So the OCR backends, not
// `ALLOWED_UPLOAD_MIME_TYPES`, decide what may be sent here.
//
// `image/webp` was removed: DocIE's allowlist refuses it, so every WebP made a
// pointless round-trip before failing remotely. It now fails locally, named.
//
// `text/plain` and `image/tiff` are in DocIE's upload allowlist but are NOT
// added here. Text has no OCR backend behind the `image_url` wrapper: its path
// is extractText() below, a different endpoint with a different request body
// -- adding a MIME type to this set would send text through the OCR wrapper,
// which is precisely what does not work. TIFF is plausible through the wrapper
// but unverified, and acceptance depends on the deployment's OCR backend, not
// on the allowlist alone. Neither is added on a reading of someone else's
// configuration -- that is exactly how `image/webp` got here (#180).
const MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);
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

// API root, access key and timeout — what BOTH DocIE paths need. Split out of
// configuration() for extractText(): POST /v1/extract/text has no agent in its
// URL, so requiring DOCIE_AGENT_<KIND> there would refuse a text extraction
// over a setting that call never uses.
function connection(env) {
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
  const timeout = Number(env.DOCIE_TIMEOUT_SECONDS ?? "360");
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) fail("configuration", "Invalid DocIE timeout or token budget.");
  return { base, key, timeout };
}

function configuration(kind, env) {
  if (!Object.hasOwn(SCHEMAS, kind)) fail("configuration", "Unsupported document kind.");
  const { base, key, timeout } = connection(env);
  const agent = (env["DOCIE_AGENT_" + kind.toUpperCase()] || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agent)) fail("configuration", "Configure the document kind's DocIE agent name.");
  const tokens = Number(env.DOCIE_MAX_TOKENS ?? "8192");
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 65536) fail("configuration", "Invalid DocIE timeout or token budget.");
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

// POST /v1/extract/text answers FLAT — no `choices`, no `finish_reason`. A real
// recorded answer (document-parsing/scripts/test_api.py against the deployment)
// carries: request_id, schema_name, model_profile, document_hash, result,
// validation, usage, latency_ms, dynamic_schema, routing, response_format_style.
// The service blocks the text itself, so `result` is grounded exactly like the
// chat path's — {value, confidence, evidence_ids} per leaf — and every review
// signal built on that keeps working unchanged.
//
// Same metadata contract as parseResponse, same stable error codes, with two
// honest differences that come from the endpoint, not from a choice here:
//   * `agent` is null. There is no agent on this path; claiming one would name
//     a component that took no part in the extraction.
//   * no `incomplete` code. That code reads `finish_reason`, which a chat
//     completion has and this response does not. A truncation shows up here as
//     `validation` errors or an HTTP 413 -> `limits`, both already handled.
function parseTextResponse(body, expectedSchema) {
  if (!object(body)) fail("response", "Invalid DocIE extraction response.");
  const result = body.result;
  if (!object(result) || !Object.keys(result).length) fail("response", "DocIE returned an empty or malformed result.");
  // Same arbitration as the chat path: a NAMED and wrong schema is refused, a
  // SILENT one is accepted and reported as unverified (schema_reported).
  const reported = [body.schema_name, result.document_type];
  if (reported.some(item => item != null && item !== expectedSchema)) fail("schema", "DocIE returned an unexpected document schema.");
  const validation = body.validation ?? null;
  if (validation != null && !object(validation)) fail("response", "Invalid DocIE validation metadata.");
  const confidence = reportedFieldConfidence(body);
  const metadata = { request_id: body.request_id ?? null, agent: null, model: body.model_profile ?? null,
    validation, usage: body.usage ?? null, field_confidence: confidence ?? fieldConfidences(result),
    schema_reported: reported.some(item => item != null) };
  for (const name of ["queue_wait_ms", "latency_ms", "generation_ms"]) {
    const value = body[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metadata[name] = value;
  }
  return { schema_name: expectedSchema, result: unwrap(result), metadata };
}

// One POST, never a retry: DocIE work is potentially billable. Shared by both
// entry points on purpose — status classification, the response ceiling, the
// timeout and the reflected-key redaction are the same guarantees whichever
// DocIE surface is called, and a second copy of them is exactly the drift this
// module exists to prevent.
async function postJson(endpoint, headers, payload, key, timeout, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  const started = performance.now();
  let reader;
  try {
    const response = await fetchImpl(endpoint, { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status !== 200) {
      await response.body?.cancel();
      // 413 gets its own code: DocIE refuses a document that is beyond the
      // limits its deployment configures, and a named failure beats a generic
      // upstream one for the only limit we cannot measure before sending.
      fail(({ 401: "auth", 403: "auth", 413: "limits", 429: "rate_limit" })[response.status] || "upstream",
        response.status === 413
          ? "DocIE refused the document as beyond its configured limits (size, OCR blocks or pages)."
          : "DocIE request failed (HTTP " + response.status + ").", response.status);
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
    return { body, elapsed: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof DocIEBridgeError) throw error;
    if (controller.signal.aborted) fail("timeout", "DocIE timeout; remote processing may continue.");
    fail("network", "DocIE network or TLS failure.");
  } finally {
    clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
}

// Send one PDF/image to the configured agent. DOCX and text are not sent here:
// the `image_url` wrapper feeds DocIE's OCR backends, which read PDF and images
// only. A source that already carries machine-readable text goes to
// extractText() instead — a different endpoint, not a MIME type to add above.
async function extractDocument(content, mimeType, { kind = "resume", env = process.env, fetchImpl = fetch } = {}) {
  const { endpoint, key, agent, timeout, tokens } = configuration(kind, env);
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_DOCUMENT_BYTES) fail("input", "Document must contain between 1 byte and 20 MiB.");
  if (!MIME_TYPES.has(mimeType)) fail("input", "Unsupported document MIME type; use PDF, PNG or JPEG.");
  const payload = { model: agent, parallel_extraction: true, stream: false, max_tokens: tokens,
    messages: [{ role: "user", content: [
      { type: "text", text: "Extract the document using your configured schema. Do not invent missing information." },
      { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + content.toString("base64") } },
    ] }] };
  const { body, elapsed } = await postJson(endpoint, { Authorization: "Bearer " + key }, payload, key, timeout, fetchImpl);
  const result = parseResponse(body, SCHEMAS[kind], agent);
  result.metadata.elapsed_ms = elapsed;
  return result;
}

/**
 * Send already-readable text to POST /v1/extract/text. One call, no retry.
 *
 * For a source that HAS machine-readable text — a .txt, a DOCX's paragraphs, a
 * PDF whose text layer was already read. Not a fallback for the file path: a
 * scanned document has no text to send and belongs to extractDocument().
 *
 * Request body, ported from the one shape with a recorded successful grounded
 * answer in this repo (cv-parser/docie_client.py L169 and document-parsing/
 * scripts/test_api.py, whose response is the fixture behind
 * tests/contract_text.json): {text, schema_name, schema_mode, dynamic_schema}.
 * Nothing from the chat path is sent — no `model`, `messages` or `max_tokens` —
 * because nothing shows this endpoint reads them.
 *
 * `dynamicSchema` is the caller's JSON schema and stays the caller's: a
 * transport does not own a business schema. It is not optional in practice for
 * a CUSTOM schema — register_and_test.py records that `schema_name` alone
 * resolves only DocIE's small built-in registry, so `adbi_resume` needs its
 * definition in the request — but omitting it is allowed for the built-in names
 * rather than refused on an assumption about someone's deployment.
 *
 * `ocr_blocks` is deliberately absent. DocIE splits the text itself, and for
 * plain text there is nothing better to offer; cv-parser's DOCX path has sent
 * text without it since it was written. It becomes an optional argument passed
 * straight through the day a caller can prove better segmentation.
 */
async function extractText(text, { kind = "resume", dynamicSchema = null, env = process.env, fetchImpl = fetch } = {}) {
  if (!Object.hasOwn(SCHEMAS, kind)) fail("configuration", "Unsupported document kind.");
  const { base, key, timeout } = connection(env);
  const schema = SCHEMAS[kind];
  if (typeof text !== "string" || !text.trim()) fail("input", "Document text must not be empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) fail("input", "Document must contain between 1 byte and 20 MiB.");
  const payload = { text, schema_name: schema };
  if (dynamicSchema != null) {
    if (!object(dynamicSchema) || !Object.keys(dynamicSchema).length) fail("input", "dynamic_schema must be a non-empty schema object.");
    if (dynamicSchema.document_type != null && dynamicSchema.document_type !== schema) fail("input", "dynamic_schema describes another document type.");
    payload.schema_mode = "dynamic";
    payload.dynamic_schema = dynamicSchema;
  }
  const profile = (env.DOCIE_MODEL_PROFILE || "").trim();
  if (profile) payload.model_profile = profile;
  // `x-api-key`, not `Authorization: Bearer`: that is the header every recorded
  // success on this endpoint used (cv-parser/docie_client.py, the response saved
  // by document-parsing/scripts/test_api.py). The chat path keeps its own
  // header, equally by measurement.
  const { body, elapsed } = await postJson(base + "/v1/extract/text", { "x-api-key": key }, payload, key, timeout, fetchImpl);
  const result = parseTextResponse(body, schema);
  result.metadata.elapsed_ms = elapsed;
  return result;
}

module.exports = { extractDocument, extractText, parseResponse, parseTextResponse, configuration, DocIEBridgeError };
