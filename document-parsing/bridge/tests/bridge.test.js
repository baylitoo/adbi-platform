"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const cases = require("./contract.json");
const textCases = require("./contract_text.json");
const errorCases = require("./contract_errors.json");
// Jeu d'essai partagé avec test_bridge.py, lu par les TESTS seulement.
const blocsTexte = require("../../fixtures/blocs_texte_docie.json");
const blocsOcr = require("../../fixtures/blocs_ocr_docie.json");
const avertissements = require("../../fixtures/avertissements_docie.json");
const { extractDocument, extractText, parseResponse, parseTextResponse, filePayload, compterBlocsTexte,
  DOCIE_BLOCS_TEXTE_MAX, validerBlocsOcr, DOCIE_BLOCS_OCR_MAX, DOCIE_BLOC_CARACTERES_MAX, BLOC_CLES, BLOC_SOURCES,
  reconnaitreAvertissement, resultatPartiel, RAISONS_PARTIEL, MAX_TEXT_BYTES, DocIEBridgeError } = require("../docie-bridge");

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
  // Warnings are carried verbatim, even the ones metadata.partiel reads (#194).
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
  // `expected_code_text` / `expected_eta_seconds` : le code `loading` (#194)
  // n'existe que sur la voie texte ; la voie agent garde `expected_code`.
  const check = (c, path) => error => {
    const text = path === "text";
    assert.ok(error instanceof DocIEBridgeError, c.name);
    assert.equal(error.code, text ? (c.expected_code_text ?? c.expected_code) : c.expected_code, c.name + " " + path);
    assert.equal(error.status, c.status, c.name);
    assert.equal(error.eta_seconds, text ? (c.expected_eta_seconds ?? null) : null, c.name + " " + path);
    assert.ok(!error.message.includes("test-secret"), c.name);
    assert.ok(!/exceeds the available|exceed_context_size_error|is starting|Retry in/.test(error.message), c.name);
    return true;
  };
  for (const c of errorCases) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response(c.body, { status: c.status }); };
    await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { env, fetchImpl }), check(c, "agent"));
    // Même postJson pour la voie texte : même classement, plus `loading`.
    await assert.rejects(extractText("CV", { env, fetchImpl }), check(c, "text"));
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
  // #194 : un corps `detail.status == "loading"` n'est jamais lu comme une extraction.
  assert.throws(() => parseTextResponse({ detail: { status: "loading", eta_seconds: 3, message: "test-secret" } }, "adbi_resume"),
    error => error.code === "loading" && error.eta_seconds === 3 && error.status === null && !error.message.includes("test-secret"));
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
    // none of it, and `ocr_blocks` is not sent for plain text. `language` is
    // absent BY DEFAULT and c'est un choix : sans langue connue, DocIE lit
    // « Language: unknown », ce qui est VRAI — annoncer une langue fausse ne
    // l'est pas (voir extractText).
    for (const absent of ["messages", "model", "max_tokens", "parallel_extraction", "ocr_blocks", "language"]) {
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

// ------------------------------------------- langue du document -----

test("langue : envoyée telle quelle quand elle est fournie, jamais devinée, jamais sur la voie agent", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  const envoyes = [];
  const fetchImpl = async (url, options) => { envoyes.push(JSON.parse(options.body)); return new Response(JSON.stringify(textCases[1].body)); };
  // Fournie : elle part VERBATIM — DocIE ne valide ni ne normalise rien
  // (schemas/api.py:26), la valeur atteint la ligne du prompt et la fabrique OCR.
  for (const [langue, attendu] of [["fr", "fr"], ["  fr  ", "fr"], ["fr-FR", "fr-FR"], ["EN", "EN"]]) {
    await extractText("CV", { langue, env, fetchImpl });
    assert.equal(envoyes.at(-1).language, attendu, JSON.stringify(langue));
  }
  // Absente : aucune clé. « Language: unknown » côté DocIE est une réponse
  // honnête ; un défaut « fr » posé ici mentirait sur un document anglais.
  await extractText("CV", { env, fetchImpl });
  assert.equal(Object.hasOwn(envoyes.at(-1), "language"), false);
  // Forme refusée AVANT le réseau : cette chaîne entre dans un prompt, et rien
  // ne la filtre côté DocIE. Aucune liste de langues autorisées pour autant —
  // le transport ne décide pas lesquelles existent.
  const avant = envoyes.length;
  for (const mauvais of ["", "   ", "f", "francais_long", "fr;DROP", "fr\nLanguage: en", 42, {}, "fr-"]) {
    await assert.rejects(extractText("CV", { langue: mauvais, env, fetchImpl }),
      error => error instanceof DocIEBridgeError && error.code === "input", JSON.stringify(mauvais));
  }
  assert.equal(envoyes.length, avant, "une langue mal formée ne doit jamais partir");
  // Voie AGENT : le corps n'est pas lu pour la langue (agents/runtime.py:550 —
  // elle vient de la SPEC de l'agent). Rien n'est donc ajouté ici.
  await extractDocument(Buffer.from("pdf"), "application/pdf",
    { env, fetchImpl: async (url, options) => { envoyes.push(JSON.parse(options.body)); return new Response(JSON.stringify(cases[2].body)); } });
  assert.equal(Object.hasOwn(envoyes.at(-1), "language"), false);
});

// ------------------------------------------- blocs de la voie texte (#190) -----

test("text blocks: shared fixture, one case per splitlines() separator and strip() edge character", () => {
  assert.ok(blocsTexte.cas.length >= 20);
  for (const c of blocsTexte.cas) assert.equal(compterBlocsTexte(c.texte), c.blocs, c.nom + " — " + c.preuve);
});

test("text blocks: extractText reports blocs_texte and troncature_possible (> 800), agent path reports null", async () => {
  assert.equal(DOCIE_BLOCS_TEXTE_MAX, 800);
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify(textCases[1].body)); };
  // Lignes vides et blancs intercalés : ils ne comptent pas, le texte part intact.
  for (const [lignes, attendu] of [[800, false], [801, true]]) {
    const texte = Array.from({ length: lignes }, (_, i) => "ligne " + i).join("\n \u00a0\n");
    const { metadata } = await extractText(texte, { env, fetchImpl });
    assert.equal(metadata.blocs_texte, lignes);
    assert.equal(metadata.troncature_possible, attendu, String(lignes));
    assert.equal(sent.at(-1).text, texte);
  }
  // Séparateurs Python et BOM seul : 800 lignes visibles par un split naïf, 801 blocs pour DocIE.
  const piege = Array.from({ length: 800 }, (_, i) => "l" + i).join("\n") + "\u2028\ufeff";
  const { metadata: piegee } = await extractText(piege, { env, fetchImpl });
  assert.deepEqual([piegee.blocs_texte, piegee.troncature_possible], [801, true]);
  // Appel direct du parseur : le texte n'y est pas, donc « inconnu ».
  assert.equal(parseTextResponse(textCases[1].body, "adbi_resume").metadata.blocs_texte, null);
  // Voie agent : l'OCR distant fait les blocs, rien à compter ici.
  const agent = await extractDocument(Buffer.from("pdf"), "application/pdf", { env,
    fetchImpl: async () => new Response(JSON.stringify(cases[2].body)) });
  assert.deepEqual([agent.metadata.blocs_texte, agent.metadata.troncature_possible], [null, null]);
});

// ------------------------------------------- blocs fournis par l'appelant -----

test("ocr blocks: shared fixture, each accepted and each refused shape, with the sent copy holding nothing extra", () => {
  // Le jeu d'essai et le code nomment les mêmes clés et les mêmes sources : une
  // clé ajoutée d'un côté sans l'autre casse ici, pas en production.
  assert.deepEqual([...BLOC_CLES].sort(), [...blocsOcr.cles_bloc].sort());
  assert.deepEqual([...BLOC_SOURCES].sort(), [...blocsOcr.sources_valides].sort());
  for (const c of blocsOcr.cas) {
    const libelle = c.nom + " — " + c.preuve;
    if (!c.valide) {
      assert.throws(() => validerBlocsOcr(c.blocs), error => error.code === "input", libelle);
      continue;
    }
    const { blocs } = validerBlocsOcr(c.blocs);
    assert.equal(blocs.length, c.blocs_comptes, libelle);
    // Copie et non passe-plat : mêmes clés que l'appelant, jamais d'autres.
    for (const [index, bloc] of blocs.entries()) {
      assert.deepEqual(Object.keys(bloc).sort(), Object.keys(c.blocs[index]).sort(), libelle);
      assert.deepEqual(bloc, c.blocs[index], libelle);
    }
  }
});

test("ocr blocks: caps are DocIE's, and characters are code points — not UTF-16 units", () => {
  assert.equal(DOCIE_BLOCS_OCR_MAX, blocsOcr.limites.blocs_max);
  assert.equal(DOCIE_BLOC_CARACTERES_MAX, blocsOcr.limites.caracteres_par_bloc_max);
  for (const c of blocsOcr.cas_plafonds) {
    const libelle = c.nom + " — " + c.preuve;
    let blocs;
    if (c.nombre != null) blocs = Array.from({ length: c.nombre }, (_, i) => ({ id: "b" + i, text: "x" }));
    else if (c.caracteres != null) blocs = [{ id: "b0", text: "x".repeat(c.caracteres) }];
    else blocs = [{ id: "b0", text: c.texte_repete.repeat(c.repetitions) }];
    if (c.valide) assert.equal(validerBlocsOcr(blocs).blocs.length, blocs.length, libelle);
    else assert.throws(() => validerBlocsOcr(blocs), error => error.code === "input", libelle);
  }
});

test("ocr blocks: extractText sends them verbatim, keeps the text, and counts blocks instead of lines", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret" };
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify(textCases[1].body)); };
  // 1 200 lignes non vides, regroupées en 300 blocs de paragraphes : sans blocs
  // le compteur annonce une troncature possible, avec eux il n'y en a plus.
  const texte = Array.from({ length: 1200 }, (_, i) => "ligne " + i).join("\n");
  const sansBlocs = await extractText(texte, { env, fetchImpl });
  assert.deepEqual([sansBlocs.metadata.blocs_texte, sansBlocs.metadata.troncature_possible, sansBlocs.metadata.blocs_fournis],
    [1200, true, false]);
  assert.equal(Object.hasOwn(sent.at(-1), "ocr_blocks"), false);
  const blocs = Array.from({ length: 300 }, (_, i) => ({ id: "p" + (i % 10 + 1) + "b" + i, text: "paragraphe " + i, page: i % 10 + 1, source: "manual" }));
  const avecBlocs = await extractText(texte, { ocrBlocks: blocs, env, fetchImpl });
  assert.deepEqual([avecBlocs.metadata.blocs_texte, avecBlocs.metadata.troncature_possible, avecBlocs.metadata.blocs_fournis],
    [300, false, true]);
  // `text` part quand même (document_hash stable) et les blocs partent tels quels.
  assert.equal(sent.at(-1).text, texte);
  assert.deepEqual(sent.at(-1).ocr_blocks, blocs);
  // Appel direct du parseur : ni texte ni blocs, donc « inconnu » et non « aucun ».
  assert.equal(parseTextResponse(textCases[1].body, "adbi_resume").metadata.blocs_fournis, null);
  // Voie agent : l'OCR distant fait les blocs, et `ocr_blocks` n'existe même pas
  // dans ce corps — null comme ses deux voisins, jamais une clé absente.
  const agent = await extractDocument(Buffer.from("pdf"), "application/pdf",
    { env: { ...env, DOCIE_AGENT_RESUME: "adbi_agent_1" }, fetchImpl: async () => new Response(JSON.stringify(cases[2].body)) });
  assert.equal(agent.metadata.blocs_fournis, null);
});

test("ocr blocks: text and blocks are bounded together, not one at a time", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret" };
  const fetchImpl = async () => new Response(JSON.stringify(textCases[1].body));
  // Un texte pile au plafond passe seul ; le moindre bloc en plus fait un corps
  // au-dessus, et c'est le corps qui part. Les blocs restent valides un par un
  // (< 20 000 caractères) : sans la borne commune, rien ne verrait ce
  // dépassement avant le refus de DocIE.
  const texte = "x".repeat(MAX_TEXT_BYTES);
  await assert.rejects(extractText(texte, { ocrBlocks: [{ id: "b0", text: "paragraphe" }], env, fetchImpl }),
    error => error.code === "input" && /together/.test(error.message));
});

// ------------------------------------------- résultat partiel (#194) -----

test("partial result: shared fixture of DocIE warning strings, closed reason set, unknown ignored, never throws", () => {
  assert.deepEqual(RAISONS_PARTIEL, avertissements._raisons);
  const couvertes = new Set();
  for (const c of avertissements.avertissements) {
    assert.deepEqual(reconnaitreAvertissement(c.avertissement), c.attendu, c.nom + " — " + c.preuve);
    if (c.attendu) couvertes.add(c.attendu.raison);
  }
  // Listes : par le vrai parseur, donc après déballage des enveloppes.
  for (const c of avertissements.listes) {
    assert.deepEqual(parseTextResponse({ result: c.result }, "adbi_resume").metadata.partiel, c.attendu, c.nom + " — " + c.preuve);
    for (const entree of c.attendu) couvertes.add(entree.raison);
  }
  // Chaque raison du jeu fermé a au moins un cas.
  assert.deepEqual([...couvertes].sort(), [...RAISONS_PARTIEL].sort());
  // Tous les avertissements à la fois : seuls les reconnus, dans l'ordre.
  const warnings = avertissements.avertissements.map(c => c.avertissement);
  assert.deepEqual(resultatPartiel({ valid: true, warnings }, {}),
    avertissements.avertissements.filter(c => c.attendu).map(c => c.attendu));
  // Formes inattendues : jamais d'exception.
  for (const validation of [null, "x", [], { warnings: "skills: model output repeated itself (x)" }, { warnings: null }]) {
    assert.deepEqual(resultatPartiel(validation, { extraction_notes: 7 }), []);
  }
});

test("partial result: metadata.partiel on both paths, warnings kept verbatim, same string in extraction_notes counted once", async () => {
  const cas = nom => avertissements.avertissements.find(c => c.nom === nom).avertissement;
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  // Aucun vecteur existant n'est partiel.
  for (const c of cases) assert.deepEqual(parseResponse(c.body, "adbi_resume", "adbi_agent_1").metadata.partiel, [], c.name);
  for (const c of textCases) assert.deepEqual(parseTextResponse(c.body, "adbi_resume").metadata.partiel, [], c.name);
  // Voie texte : la boucle arrive dans validation.warnings ET result.extraction_notes.
  const text = structuredClone(textCases[0].body);
  text.validation.warnings = [cas("boucle"), "derived subtotal not found in the document", cas("nombre_abandonne")];
  text.result.extraction_notes = [cas("boucle")];
  text.result.interests = { value: Array.from({ length: 100 }, (_, i) => "centre " + i), confidence: 1, evidence_ids: [] };
  const avant = structuredClone(text.validation);
  const lu = await extractText("CV", { env, fetchImpl: async () => new Response(JSON.stringify(text)) });
  assert.deepEqual(lu.metadata.partiel, [{ champ: "skills", raison: "boucle" }, { champ: "tjm", raison: "valeur_abandonnee" },
    { champ: "interests", raison: "liste_plafonnee_possible" }]);
  assert.deepEqual(lu.metadata.validation, avant);
  assert.equal(lu.metadata.validation.valid, true);
  assert.deepEqual(lu.result.extraction_notes, [cas("boucle")]);
  // Sans `validation`, `result.extraction_notes` suffit.
  const notes = { result: { name: "Ada", extraction_notes: [cas("feuille_abandonnee")] } };
  assert.deepEqual(parseTextResponse(notes, "adbi_resume").metadata.partiel, [{ champ: "contact.email", raison: "feuille_abandonnee" }]);
  // Voie agent : docie_agent.validation.warnings.
  const agent = structuredClone(cases[3].body);
  agent.docie_agent.validation.warnings.push(cas("forme_invalide"));
  const avantAgent = structuredClone(agent.docie_agent.validation);
  const luAgent = await extractDocument(Buffer.from("pdf"), "application/pdf", { env,
    fetchImpl: async () => new Response(JSON.stringify(agent)) });
  assert.deepEqual(luAgent.metadata.partiel, [{ champ: "experience[2].dates", raison: "forme_invalide" }]);
  assert.deepEqual(luAgent.metadata.validation, avantAgent);
});

// ------------------------------------------------ choix par appel (#194) -----
// Mock à la frontière HTTP : on lit l'URL et le corps réellement envoyés.

test("text path: per-call modelProfile overrides DOCIE_MODEL_PROFILE for that call only; metadata reports the response", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_MODEL_PROFILE: "store:env-default" };
  const snapshot = structuredClone(env);
  const sent = [];
  let status = 200;
  const answer = { ...structuredClone(textCases[1].body), model_profile: "store:served-by-docie" };
  const fetchImpl = async (url, options) => {
    sent.push({ url, payload: JSON.parse(options.body) });
    return status === 200 ? new Response(JSON.stringify(answer))
      : new Response(JSON.stringify({ detail: { status: "loading", deployment: "nuextract3", eta_seconds: 42, message: "test-secret" } }), { status });
  };
  // Surcharge : la requête change, `metadata.model` reste ce que DocIE rapporte.
  const chosen = await extractText("CV", { modelProfile: "store:lfm2.5-2.6b", env, fetchImpl });
  assert.equal(sent[0].url, "https://docie.example/v1/extract/text");
  assert.deepEqual(sent[0].payload, { text: "CV", schema_name: "adbi_resume", model_profile: "store:lfm2.5-2.6b" });
  assert.equal(chosen.metadata.model, "store:served-by-docie");
  // Même objet env, sans surcharge : la valeur d'environnement revient.
  await extractText("CV", { env, fetchImpl });
  assert.deepEqual(sent[1].payload, { text: "CV", schema_name: "adbi_resume", model_profile: "store:env-default" });
  // Ni surcharge ni variable : aucun `model_profile`, comme avant.
  await extractText("CV", { env: { DOCIE_BASE_URL: env.DOCIE_BASE_URL, DOCIE_API_KEY: env.DOCIE_API_KEY }, fetchImpl });
  assert.deepEqual(sent[2].payload, { text: "CV", schema_name: "adbi_resume" });
  // Trim comme DOCIE_MODEL_PROFILE ; `store:<nom>` sans autre transformation.
  await extractText("CV", { modelProfile: "  store:NuExtract3_v1.2  ", env, fetchImpl });
  assert.equal(sent[3].payload.model_profile, "store:NuExtract3_v1.2");
  // Le `store:` choisi par appel mène au code `loading` déjà en place.
  status = 202;
  await assert.rejects(extractText("CV", { modelProfile: "store:nuextract3", env, fetchImpl }),
    error => error.code === "loading" && error.eta_seconds === 42 && !error.message.includes("test-secret"));
  assert.equal(sent[4].payload.model_profile, "store:nuextract3");
  assert.equal(sent.length, 5);
  assert.deepEqual(env, snapshot);
});

test("agent path: per-call agent overrides DOCIE_AGENT_<KIND> for that call only; metadata.agent is the agent called", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1" };
  const snapshot = structuredClone(env);
  const sent = [];
  // Le faux DocIE répond au nom de l'agent présent dans l'URL.
  const fetchImpl = async (url, options) => {
    sent.push({ url, payload: JSON.parse(options.body) });
    const body = structuredClone(cases[0].body);
    body.docie_agent.agent = url.split("/")[5];
    return new Response(JSON.stringify(body));
  };
  const chosen = await extractDocument(Buffer.from("pdf"), "application/pdf", { agent: "adbi_resume_nuextract3", env, fetchImpl });
  assert.equal(sent[0].url, "https://docie.example/v1/agents/adbi_resume_nuextract3/chat/completions");
  // Corps inchangé à part l'agent : aucun champ `model` ajouté (DocIE l'écrase).
  assert.deepEqual(sent[0].payload, filePayload(Buffer.from("pdf"), "application/pdf", "adbi_resume_nuextract3", 8192));
  assert.equal(chosen.metadata.agent, "adbi_resume_nuextract3");
  // Même objet env, sans surcharge : l'agent d'environnement revient.
  const fallback = await extractDocument(Buffer.from("pdf"), "application/pdf", { env, fetchImpl });
  assert.equal(sent[1].url, "https://docie.example/v1/agents/adbi_agent_1/chat/completions");
  assert.equal(fallback.metadata.agent, "adbi_agent_1");
  assert.deepEqual(env, snapshot);
  // Avec un agent par appel, DOCIE_AGENT_RESUME n'est pas exigé ; sans, il l'est toujours.
  const noAgentEnv = { DOCIE_BASE_URL: env.DOCIE_BASE_URL, DOCIE_API_KEY: env.DOCIE_API_KEY };
  assert.equal((await extractDocument(Buffer.from("pdf"), "application/pdf", { agent: " spark ", env: noAgentEnv, fetchImpl })).metadata.agent, "spark");
  assert.equal(sent[2].url, "https://docie.example/v1/agents/spark/chat/completions");
  await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { env: noAgentEnv, fetchImpl }), error => error.code === "configuration");
  // Une réponse d'un autre agent que celui appelé reste refusée.
  const other = async () => new Response(JSON.stringify(cases[0].body)); // docie_agent.agent = adbi_agent_1
  await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { agent: "adbi_resume_nuextract3", env, fetchImpl: other }),
    error => error.code === "schema");
  assert.equal(sent.length, 3);
});

test("per-call modelProfile and agent: format checked before network with code input, no allowlist", async () => {
  const env = { DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "test-secret", DOCIE_AGENT_RESUME: "adbi_agent_1",
    DOCIE_MODEL_PROFILE: "store:env-default" };
  let calls = 0;
  const refuse = () => { calls++; throw Error("Unexpected network"); };
  for (const modelProfile of ["", "   ", "store:a\nb", "store:a\u0000b", "a\tb", "a\u007fb", "x".repeat(129), "é".repeat(65), 42, {}]) {
    await assert.rejects(extractText("CV", { modelProfile, env, fetchImpl: refuse }),
      error => error instanceof DocIEBridgeError && error.code === "input", JSON.stringify(modelProfile));
  }
  for (const agent of ["", "   ", "../x", "a/b", "store:x", "a b", "a".repeat(129), 7]) {
    await assert.rejects(extractDocument(Buffer.from("pdf"), "application/pdf", { agent, env, fetchImpl: refuse }),
      error => error instanceof DocIEBridgeError && error.code === "input", JSON.stringify(agent));
  }
  assert.equal(calls, 0);
  // Forme seule : tout nom bien formé part, au plafond compris — la liste est au catalogue.
  const sent = [];
  const textOk = async (url, options) => { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify(textCases[1].body)); };
  for (const modelProfile of ["x".repeat(128), "é".repeat(64), "store:absent-de-tout-catalogue", "models.yaml-profile"]) {
    await extractText("CV", { modelProfile, env, fetchImpl: textOk });
    assert.equal(sent.at(-1).model_profile, modelProfile);
  }
  const fileOk = async () => new Response(JSON.stringify(cases[2].body));
  await extractDocument(Buffer.from("pdf"), "application/pdf", { agent: "a".repeat(128), env, fetchImpl: fileOk });
});
