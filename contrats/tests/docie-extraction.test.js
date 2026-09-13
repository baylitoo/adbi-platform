"use strict";
// Tests de lib/docie-extraction.js (issue #153). Aucun appel réseau réel :
// le bridge est soit stubbé directement (deps.extractDocument), soit exercé
// pour de vrai avec fetchImpl mocké (cf. document-parsing/bridge/tests —
// même politique : "aucun appel distant DocIE par agent ADBI").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeDocument, mapDocieResult, isEnabled, isEligible,
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

test("flag on + item kbis + succès DocIE: mapping correct, sur-ensemble de la forme locale", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  // Champs réels du schéma DocIE "kbis" (document-parsing/scripts/
  // register_and_test.py, PR #46) tels que déjà déballés par
  // docie-bridge.js::unwrap() — valeurs nues, pas d'enveloppe {value,...}.
  const docieResponse = {
    schema_name: "kbis",
    result: {
      document_type: "kbis",
      company_name: "ACME CONSEIL",
      siren: "123456789",
      siret_siege: "12345678900012",
      legal_form: "SAS",
      share_capital: { amount: "1000", currency: "EUR" },
      registration_date: "2015-06-01",
      issued_date: "2024-03-15",
      rcs_number: "123 456 789 RCS Paris",
      registered_address: "1 rue de la Paix, 75002 Paris",
      activity_code: "6202A",
      legal_representative: "Monsieur Jean DUPONT",
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
  // Sur-ensemble STRICT des 8 clés locales : les clés enrichies (SIREN,
  // SIRET, forme juridique, ...) s'y ajoutent, elles ne les remplacent pas.
  for (const key of LOCAL_SHAPE_KEYS) assert.ok(Object.hasOwn(result, key), key + " manquante");
  assert.equal(result.documentType, "Extrait Kbis");
  assert.equal(result.matchedId, "kbis");
  assert.equal(result.isValid, true);
  assert.equal(result.companyName, "ACME CONSEIL");
  assert.equal(result.nameMatches, true);
  assert.equal(result.issuedDate, "2024-03-15");
  assert.deepEqual(result.issues, []);
  // Champs enrichis — perdus par l'ancienne stratégie « aplatir + regex »,
  // désormais restitués tels quels par lib/kbis-mapping.js.
  assert.equal(result.siren, "123456789");
  assert.equal(result.siret, "12345678900012");
  assert.equal(result.formeJuridique, "SAS");
  assert.equal(result.dateImmatriculation, "2015-06-01");
  assert.equal(result.rcsNumber, "123 456 789 RCS Paris");
  assert.equal(result.adresseSiege, "1 rue de la Paix, 75002 Paris");
  assert.equal(result.codeActivite, "6202A");
  assert.equal(result.representantLegal, "Monsieur Jean DUPONT");
  assert.equal(result.capitalSocial, "1000");
  assert.equal(result.capitalSocialDevise, "EUR");
});

test("flag on + item kbis + validation DocIE négative MAIS champs identifiants présents: isValid=false, champs conservés (pas de faux 'illisible')", async () => {
  // docanalyze.js n'a aucune notion de validation DocIE à imiter : un
  // validation.valid=false avec nom+SIREN bel et bien extraits ne doit pas
  // jeter ces champs avec un message "PDF scanné" trompeur — comportement
  // du module d'avant ce portage (issue #153), conservé ici.
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const docieResponse = {
    schema_name: "kbis",
    result: { company_name: "ACME CONSEIL", siren: "123456789" },
    metadata: { validation: { valid: false, errors: ["champ manquant"] } },
  };
  const extractDocument = async () => docieResponse;
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }] };
  const result = await analyzeDocument(body, { env, extractDocument, analyzeLocal: fakeLocal() });
  assert.equal(result.isValid, false);
  assert.equal(result.documentType, "Extrait Kbis");
  assert.equal(result.companyName, "ACME CONSEIL");
  assert.equal(result.siren, "123456789");
  assert.ok(result.issues.some((m) => /n'a pas validé/.test(m)));
});

test("flag on + item kbis + validation DocIE négative ET aucun champ identifiant: bascule bien sur la branche illisible", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const docieResponse = {
    schema_name: "kbis",
    result: {},
    metadata: { validation: { valid: false, errors: ["scan illisible"] } },
  };
  const extractDocument = async () => docieResponse;
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }] };
  const result = await analyzeDocument(body, { env, extractDocument, analyzeLocal: fakeLocal() });
  assert.equal(result.isValid, false);
  assert.equal(result.documentType, "Document");
  assert.equal(result.companyName, null);
  assert.equal(result.summary, "Document illisible.");
  assert.ok(result.issues.some((m) => /Aucun texte lisible/.test(m)));
});

test("flag on + item kbis + aucun champ identifiant (nom/SIREN/SIRET absents): isValid=false même sans validation négative", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const docieResponse = {
    schema_name: "kbis",
    result: { legal_form: "SAS" },
    metadata: { validation: { valid: true } },
  };
  const extractDocument = async () => docieResponse;
  const body = { dataBase64: "AA==", mimeType: "application/pdf", items: [{ id: "kbis" }] };
  const result = await analyzeDocument(body, { env, extractDocument, analyzeLocal: fakeLocal() });
  assert.equal(result.isValid, false);
  assert.equal(result.summary, "Document illisible.");
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

test("mapDocieResult: registration_date (immatriculation) et issued_date (délivrance) ne sont plus ambigus — schéma structuré, pas de désambiguïsation par mot-clé à faire", () => {
  // Contrairement à l'ancienne stratégie « aplatir en texte + regex » (qui
  // devait deviner laquelle de plusieurs dates ISO était la délivrance), le
  // schéma DocIE sépare déjà registration_date de issued_date : chacune va
  // directement à sa clé de sortie, sans heuristique de proximité.
  const mapped = mapDocieResult({
    result: { company_name: "ACME", registration_date: "2015-06-01", issued_date: "2024-03-15" },
    metadata: {},
  }, { items: [{ id: "kbis" }] });
  assert.equal(mapped.issuedDate, "2024-03-15");
  assert.equal(mapped.dateImmatriculation, "2015-06-01");
});

test("mapDocieResult: champ manquant -> chaîne vide (pas d'invention de valeur), date de délivrance absente signalée", () => {
  const mapped = mapDocieResult({ result: { company_name: "ACME", siren: "123456789" }, metadata: {} }, { items: [{ id: "kbis" }] });
  assert.equal(mapped.documentType, "Extrait Kbis");
  assert.equal(mapped.companyName, "ACME");
  assert.equal(mapped.issuedDate, "");
  assert.equal(mapped.formeJuridique, "");
  assert.equal(mapped.capitalSocial, "");
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
    // Enveloppe brute telle que l'agent DocIE la renvoie réellement (champs
    // wrappés {value, confidence, evidence_ids} / {amount, currency, ...}
    // pour money) — document-parsing/mappings/fixtures/kbis_extraction_sample.json
    // en est le pendant Python. C'est docie-bridge.js::unwrap() (exercé ici
    // pour de vrai, aucun mock) qui la ramène à la forme lue par
    // lib/kbis-mapping.js.
    const content = JSON.stringify({
      document_type: "kbis",
      company_name: { value: "ACME CONSEIL", confidence: 0.97, evidence_ids: ["e1"] },
      siren: { value: "123456789", confidence: 0.99, evidence_ids: ["e2"] },
      issued_date: { value: "2024-03-15", confidence: 0.92, evidence_ids: ["e3"] },
      share_capital: { amount: "1000", currency: "EUR", confidence: 0.85, evidence_ids: [] },
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
  // Preuve que le déballage réel (unwrap) + le mapping structuré sont bien
  // câblés bout en bout : le champ money reste {amount, currency} déballé,
  // pas juste une chaîne aplatie.
  assert.equal(result.siren, "123456789");
  assert.equal(result.capitalSocial, "1000");
  assert.equal(result.capitalSocialDevise, "EUR");
});
