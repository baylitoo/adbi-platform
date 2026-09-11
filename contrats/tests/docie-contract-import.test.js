"use strict";
// Tests de lib/docie-contract-import.js. Aucun appel réseau réel : le bridge
// est soit stubbé directement (deps.extractDocument), soit exercé pour de
// vrai avec fetchImpl mocké — même politique que tests/docie-extraction.test.js
// ("aucun appel distant DocIE par agent ADBI").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractContractValues, mapContractResult, MAPPED_FIELDS,
  CONSTANT_FIELDS_NOT_FROM_DOCIE, GAP_FIELDS_NO_DOCIE_EQUIVALENT, ALL_ACCOUNTED_KEYS,
} = require("../lib/docie-contract-import");
const { sousTraitance } = require("../lib/fields");

test("garde-fou anti-dérive : ALL_ACCOUNTED_KEYS == exactement les clés de fields.js::sousTraitance", () => {
  const fieldsKeys = new Set(sousTraitance.map((f) => f.key));
  assert.equal(ALL_ACCOUNTED_KEYS.size, fieldsKeys.size);
  for (const key of fieldsKeys) {
    assert.ok(
      ALL_ACCOUNTED_KEYS.has(key),
      key + " est dans fields.js::sousTraitance mais pas mappé/répertorié dans docie-contract-import.js"
    );
  }
  for (const key of ALL_ACCOUNTED_KEYS) {
    assert.ok(fieldsKeys.has(key), key + " est répertorié ici mais n'existe plus dans fields.js::sousTraitance");
  }
  // Les 3 catégories ne se recouvrent pas.
  const mappedKeys = Object.values(MAPPED_FIELDS).map(([k]) => k);
  for (const k of mappedKeys) {
    assert.ok(!CONSTANT_FIELDS_NOT_FROM_DOCIE.has(k), k + " est à la fois mappé et constant");
    assert.ok(!(k in GAP_FIELDS_NO_DOCIE_EQUIVALENT), k + " est à la fois mappé et gap");
  }
  for (const k of CONSTANT_FIELDS_NOT_FROM_DOCIE) {
    assert.ok(!(k in GAP_FIELDS_NO_DOCIE_EQUIVALENT), k + " est à la fois constant et gap");
  }
});

// Fixture nominale, forme POST-unwrap (document-parsing/bridge/docie-bridge.js
// ::unwrap) — PAS l'enveloppe brute {value,confidence,evidence_ids} de
// document-parsing/mappings/fixtures/contract_extraction_sample.json (celle-ci
// lit le JSON DocIE avant déballage bridge, un contexte différent : voir le
// commentaire d'en-tête de lib/docie-contract-import.js).
const NOMINAL_RESULT = {
  document_type: "contract",
  extraction_notes: ["low confidence on lieu_execution"],
  numero_contrat: "01-06-2026",
  date_redaction: "2026-01-05",
  lieu_redaction: "Paris",
  st_nom: "SUND INDUSTRY SYSTEM",
  st_adresse: "60 rue Francois 1er, 75008 Paris",
  st_siren: "941091316",
  st_siret: "94109131600013",
  st_representant: "Monsieur Corentin CALVO",
  st_forme_juridique: "SAS au capital de 1 000 EUR",
  st_qualite: "President",
  consultant_nom: "Corentin Calvo",
  consultant_fonction: "Developpeur Full Stack",
  client_final: "Groupe Accor",
  nature_travaux: "Developpement full stack de la plateforme de reservation",
  lieu_execution: "82 rue Henry Farman, 92130 Issy-les-Moulineaux",
  date_debut: "01/02/2026",
  date_fin: "2026-12-31",
  tjm: { amount: "450", currency: "EUR", evidence_ids: [], confidence: 0.9 },
  delai_paiement: "45",
};

test("mapContractResult: cas nominal — dates ISO/FR normalisées, montant EUR, notes reportées", () => {
  const mapped = mapContractResult(NOMINAL_RESULT);
  assert.equal(mapped.ok, true);
  assert.deepEqual(mapped.errors, []);
  assert.equal(mapped.values.numeroContrat, "01-06-2026");
  assert.equal(mapped.values.dateRedaction, "2026-01-05");
  assert.equal(mapped.values.lieuRedaction, "Paris");
  assert.equal(mapped.values.stNom, "SUND INDUSTRY SYSTEM");
  assert.equal(mapped.values.stSiren, "941091316");
  // date_debut est en DD/MM/YYYY côté DocIE -> converti en ISO.
  assert.equal(mapped.values.dateDebut, "2026-02-01");
  assert.equal(mapped.values.dateFin, "2026-12-31");
  assert.equal(mapped.values.tjm, "450");
  assert.equal(mapped.values.delaiPaiement, "45");
  assert.ok(mapped.warnings.some((w) => /extraction_notes/.test(w) && /lieu_execution/.test(w)));
  // Champs sans équivalent DocIE : vides, jamais inventés.
  assert.equal(mapped.values.stEmail, undefined); // non émis du tout (voir GAP)
});

test("mapContractResult: cas limite — null/absent, date non reconnue, devise non-EUR, numéro manquant", () => {
  const edge = {
    document_type: "contract",
    extraction_notes: ["numero_contrat absent du document source", "date_redaction ambigue, verifier manuellement"],
    numero_contrat: null,
    date_redaction: "le 5 courant",
    lieu_redaction: null,
    st_nom: "ACME FREELANCE",
    st_adresse: null,
    st_siren: "123456789",
    st_siret: null,
    st_representant: "Jane DOE",
    st_forme_juridique: "EI",
    st_qualite: "",
    consultant_nom: "Jane Doe",
    consultant_fonction: null,
    client_final: "Client Test SAS",
    nature_travaux: null,
    lieu_execution: null,
    date_debut: "2026-03-01",
    date_fin: "31/08/2026",
    tjm: { amount: "500", currency: "USD", evidence_ids: [], confidence: 0.6 },
    delai_paiement: "30.0",
  };
  const mapped = mapContractResult(edge);
  assert.equal(mapped.ok, false);
  assert.ok(mapped.errors.some((e) => /numéro du contrat/.test(e)));
  assert.equal(mapped.values.numeroContrat, "");
  assert.equal(mapped.values.lieuRedaction, "");
  assert.equal(mapped.values.stAdresse, "");
  assert.equal(mapped.values.stSiret, "");
  assert.equal(mapped.values.stQualite, "");
  assert.equal(mapped.values.consultantFonction, "");
  assert.equal(mapped.values.natureTravaux, "");
  assert.equal(mapped.values.lieuExecution, "");
  assert.equal(mapped.values.dateDebut, "2026-03-01");
  assert.equal(mapped.values.dateFin, "2026-08-31");
  // Date non reconnue ("le 5 courant") -> vide + avertissement, jamais inventée.
  assert.equal(mapped.values.dateRedaction, "");
  assert.ok(mapped.warnings.some((w) => /date_redaction/.test(w) && /non reconnue/.test(w)));
  // Devise non-EUR -> montant reporté tel quel + avertissement.
  assert.equal(mapped.values.tjm, "500");
  assert.ok(mapped.warnings.some((w) => /tjm/.test(w) && /USD/.test(w)));
  // Nombre décimal -> "30" (entier).
  assert.equal(mapped.values.delaiPaiement, "30");
});

test("mapContractResult: montant absent -> tjm vide, sans avertissement de devise", () => {
  const mapped = mapContractResult(Object.assign({}, NOMINAL_RESULT, { tjm: null, numero_contrat: "X", st_nom: "Y" }));
  assert.equal(mapped.values.tjm, "");
  assert.ok(!mapped.warnings.some((w) => /devise/.test(w)));
});

test("extractContractValues: flag off -> erreur explicite (code=disabled), bridge jamais appelé", async () => {
  const extractDocument = async () => { throw new Error("le bridge ne doit pas être appelé (flag off)"); };
  await assert.rejects(
    () => extractContractValues({ dataBase64: "AA==", mimeType: "application/pdf" }, { env: {}, extractDocument }),
    (err) => { assert.equal(err.code, "disabled"); return true; }
  );
});

test("extractContractValues: aucun fichier reçu -> erreur input", async () => {
  await assert.rejects(
    () => extractContractValues({}, { env: { DOCIE_EXTRACTION_ENABLED: "true" } }),
    (err) => { assert.equal(err.code, "input"); return true; }
  );
});

test("extractContractValues: flag on + succès DocIE -> values mappées, kind='contract' transmis au bridge", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  let seenKind = null;
  const extractDocument = async (buffer, mime, opts) => {
    seenKind = opts.kind;
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(mime, "application/pdf");
    return { schema_name: "contract", result: NOMINAL_RESULT, metadata: { request_id: "req-42" } };
  };
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  const result = await extractContractValues(body, { env, extractDocument });
  assert.equal(seenKind, "contract");
  assert.equal(result.requestId, "req-42");
  assert.equal(result.ok, true);
  assert.equal(result.values.stNom, "SUND INDUSTRY SYSTEM");
});

test("extractContractValues: échec DocIE (ex. config manquante) -> exception propagée avec un code, pas de crash", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const err = new Error("Configure the document kind's DocIE agent name.");
  err.code = "configuration";
  const extractDocument = async () => { throw err; };
  await assert.rejects(
    () => extractContractValues({ dataBase64: "AA==", mimeType: "application/pdf" }, { env, extractDocument }),
    (e) => { assert.equal(e.code, "configuration"); return true; }
  );
});

// Intégration réelle du bridge partagé (document-parsing/bridge/docie-bridge.js),
// fetchImpl mocké — prouve le câblage réel (kind="contract", endpoint, payload)
// sans jamais toucher le réseau.
test("intégration réelle du bridge partagé (fetchImpl mocké, aucun réseau)", async () => {
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true",
    DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret",
    DOCIE_AGENT_CONTRACT: "contract-agent-test",
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const content = JSON.stringify({ document_type: "contract", result: NOMINAL_RESULT });
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      model: "contract-agent-test",
      choices: [{ finish_reason: "stop", message: { content } }],
    }), { status: 200 });
  };
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  const result = await extractContractValues(body, { env, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://docie.example.test/v1/agents/contract-agent-test/chat/completions");
  assert.equal(calls[0].body.model, "contract-agent-test");
  assert.equal(result.values.stNom, "SUND INDUSTRY SYSTEM");
  assert.equal(result.values.numeroContrat, "01-06-2026");
});
