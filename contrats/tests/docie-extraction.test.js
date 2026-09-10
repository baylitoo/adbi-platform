"use strict";
// Tests de lib/docie-extraction.js (issue #153). Aucun appel réseau réel :
// le bridge est soit stubbé directement (deps.extractDocument), soit exercé
// pour de vrai avec fetchImpl mocké (cf. document-parsing/bridge/tests —
// même politique : "aucun appel distant DocIE par agent ADBI").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeDocument, mapDocieResult, resultToText, isEnabled, isEligible,
} = require("../lib/docie-extraction");

const LOCAL_SHAPE_KEYS = [
  "documentType", "matchedId", "isValid", "issuedDate",
  "companyName", "nameMatches", "issues", "summary",
].sort();

function fakeLocal(tag) {
  return async (body) => ({
    documentType: "Document", matchedId: null, isValid: true, issuedDate: "",
    companyName: null, nameMatches: null, issues: [], summary: tag || "local",
  });
}

test("isEnabled / isEligible: flag parsing and Kbis-only scope", () => {
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ DOCIE_EXTRACTION_ENABLED: "false" }), false);
  assert.equal(isEnabled({ DOCIE_EXTRACTION_ENABLED: "TRUE" }), true);
  assert.equal(isEnabled({ DOCIE_EXTRACTION_ENABLED: " true " }), true);
  assert.equal(isEligible([{ id: "kbis" }]), true);
  assert.equal(isEligible([{ id: "urssaf" }]), false);
  assert.equal(isEligible([{ id: "rib" }]), false);
  assert.equal(isEligible([]), false);
  assert.equal(isEligible(undefined), false);
});

test("flag off: local analysis used unchanged, bridge never invoked", async () => {
  let localCalls = 0;
  const analyzeLocal = async (body) => { localCalls++; return fakeLocal("local")(body); };
  const extractDocument = async () => { throw new Error("le bridge ne doit pas être appelé (flag off)"); };
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }], expectedName: "ACME" };
  const result = await analyzeDocument(body, { env: {}, analyzeLocal, extractDocument });
  assert.equal(localCalls, 1);
  assert.equal(result.summary, "local");
});

test("flag on but item non éligible (ex: urssaf): reste local (gap de schéma documenté)", async () => {
  let localCalls = 0;
  const analyzeLocal = async (body) => { localCalls++; return fakeLocal("local")(body); };
  const extractDocument = async () => { throw new Error("le bridge ne doit pas être appelé (item non-kbis)"); };
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "urssaf" }] };
  const result = await analyzeDocument(body, { env, analyzeLocal, extractDocument });
  assert.equal(localCalls, 1);
  assert.equal(result.summary, "local");
});

test("flag on + item kbis + succès DocIE: mapping correct, même forme que l'analyse locale", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const docieResponse = {
    schema_name: "kbis",
    result: {
      document_type: "kbis",
      denomination_sociale: "ACME CONSEIL",
      siren: "123 456 789",
      date_delivrance: "2024-03-15",
    },
    metadata: { request_id: "req-1", agent: "kbis-agent-test", validation: null },
  };
  let seenKind = null;
  const extractDocument = async (buffer, mime, opts) => {
    seenKind = opts.kind;
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(mime, "application/pdf");
    return docieResponse;
  };
  const analyzeLocal = async () => { throw new Error("ne doit pas être appelé (succès DocIE)"); };
  const body = {
    dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
    mimeType: "application/pdf",
    items: [{ id: "kbis", label: "Kbis" }],
    expectedName: "ACME Conseil",
  };
  const result = await analyzeDocument(body, { env, analyzeLocal, extractDocument });
  assert.equal(seenKind, "kbis");
  assert.deepEqual(Object.keys(result).sort(), LOCAL_SHAPE_KEYS);
  assert.equal(result.documentType, "Extrait Kbis");
  assert.equal(result.matchedId, "kbis");
  assert.equal(result.isValid, true);
  assert.equal(result.companyName, "ACME CONSEIL");
  assert.equal(result.nameMatches, true);
  // Champ DocIE probable en snake_case ("date_delivrance") -> repli ISO
  // (extractIssuedDate local ne couvre que DD/MM/YYYY et "DD mois YYYY").
  assert.equal(result.issuedDate, "2024-03-15");
  assert.deepEqual(result.issues, []);
});

test("flag on + item kbis + validation DocIE négative: isValid=false + issue", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const docieResponse = {
    schema_name: "kbis",
    result: { denomination_sociale: "ACME CONSEIL" },
    metadata: { validation: { valid: false, errors: ["champ manquant"] } },
  };
  const extractDocument = async () => docieResponse;
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }] };
  const result = await analyzeDocument(body, { env, extractDocument, analyzeLocal: fakeLocal() });
  assert.equal(result.isValid, false);
  assert.ok(result.issues.some((m) => /validé/.test(m)));
});

test("flag on + échec DocIE (réseau/timeout/config): repli automatique sur l'analyse locale", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const err = new Error("DocIE timeout; remote processing may continue.");
  err.code = "timeout";
  const extractDocument = async () => { throw err; };
  let localCalls = 0;
  const analyzeLocal = async (body) => {
    localCalls++;
    return { documentType: "Document", matchedId: null, isValid: true, issuedDate: "", companyName: null, nameMatches: null, issues: [] };
  };
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }] };
  const result = await analyzeDocument(body, { env, extractDocument, analyzeLocal });
  assert.equal(localCalls, 1);
  assert.ok(result.issues.some((m) => m.includes("DocIE indisponible") && m.includes("timeout")));
});

test("flag on + configuration DocIE absente (pas de clé/agent): repli local, jamais d'exception non gérée", async () => {
  // Aucun deps.extractDocument injecté ici : passe par le vrai bridge partagé
  // (document-parsing/bridge/docie-bridge.js) dont configuration() doit
  // rejeter un environnement sans DOCIE_BASE_URL/API_KEY/AGENT_KBIS —
  // AUCUN appel réseau ne doit être tenté (rejeté avant tout fetch).
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  let localCalls = 0;
  const analyzeLocal = async () => { localCalls++; return fakeLocal("local")(); };
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }] };
  const result = await analyzeDocument(body, { env, analyzeLocal });
  assert.equal(localCalls, 1);
  assert.equal(result.summary, "local");
});

test("mapDocieResult: plusieurs dates ISO — choisit celle près d'un mot-clé de délivrance, pas la première du JSON", () => {
  // date_creation (2015, ancienne immatriculation) apparaît AVANT
  // date_delivrance (2024) dans l'objet : un "premier match" naïf renverrait
  // à tort 2015, ce qui ferait déclarer le Kbis périmé côté front.
  const mapped = mapDocieResult({
    result: { denomination_sociale: "ACME", date_creation: "2015-06-01", date_delivrance: "2024-03-15" },
    metadata: {},
  }, { items: [{ id: "kbis" }] });
  assert.equal(mapped.issuedDate, "2024-03-15");
});

test("resultToText / mapDocieResult: aplatissement clé:valeur, sans invention de schéma", () => {
  const text = resultToText({ denomination_sociale: "ACME", adresse: { ville: "Lyon" }, pieces: ["a", "b"] });
  assert.match(text, /denomination sociale: ACME/);
  assert.match(text, /adresse ville: Lyon/);
  assert.match(text, /pieces: a/);
  assert.match(text, /pieces: b/);

  const mapped = mapDocieResult({ result: { denomination_sociale: "ACME" }, metadata: {} }, { items: [{ id: "kbis" }] });
  assert.equal(mapped.documentType, "Extrait Kbis");
  assert.equal(mapped.companyName, "ACME");
  assert.equal(mapped.issuedDate, "");
  assert.ok(mapped.issues.some((m) => /Date de délivrance/.test(m)));
});

// Intégration réelle du bridge partagé (document-parsing/bridge/docie-bridge.js),
// fetchImpl mocké — prouve le câblage réel (kind, endpoint, payload) sans
// jamais toucher le réseau (cf. politique dépôt : aucun appel DocIE distant
// par un agent ADBI).
test("intégration réelle du bridge partagé (fetchImpl mocké, aucun réseau)", async () => {
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true",
    DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret",
    DOCIE_AGENT_KBIS: "kbis-agent-test",
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const content = JSON.stringify({
      document_type: "kbis",
      denomination_sociale: "ACME CONSEIL",
      date_delivrance: "2024-03-15",
    });
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      model: "kbis-agent-test",
      choices: [{ finish_reason: "stop", message: { content } }],
    }), { status: 200 });
  };
  const body = {
    dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
    mimeType: "application/pdf",
    items: [{ id: "kbis" }],
    expectedName: "ACME Conseil",
  };
  const result = await analyzeDocument(body, { env, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://docie.example.test/v1/agents/kbis-agent-test/chat/completions");
  assert.equal(calls[0].body.model, "kbis-agent-test");
  assert.equal(calls[0].body.parallel_extraction, true);
  assert.equal(result.documentType, "Extrait Kbis");
  assert.equal(result.companyName, "ACME CONSEIL");
  assert.equal(result.issuedDate, "2024-03-15");
  assert.equal(result.nameMatches, true);
});
