"use strict";
// Transport OpenAI (#194) : aucun appel réseau, fetchImpl simulé.
// Lancement : node --test document-parsing/bridge/tests/openai.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const oa = require("../openai-responses");

const DOSSIER_SCHEMAS = path.join(__dirname, "..", "..", "schemas");
const SCHEMAS = fs.readdirSync(DOSSIER_SCHEMAS).filter((f) => f.endsWith(".schema.json")).sort()
  .map((f) => [f, JSON.parse(fs.readFileSync(path.join(DOSSIER_SCHEMAS, f), "utf8"))]);

// Vérifie récursivement les règles strictes de Structured Outputs sur un nœud converti.
function verifierStrict(noeud, chemin) {
  if (noeud.type === "object") {
    assert.equal(noeud.additionalProperties, false, chemin);
    assert.deepEqual([...noeud.required].sort(), Object.keys(noeud.properties).sort(), chemin);
    for (const [cle, sous] of Object.entries(noeud.properties)) verifierStrict(sous, chemin + "." + cle);
  } else if (noeud.type === "array") {
    verifierStrict(noeud.items, chemin + "[]");
  } else if (Array.isArray(noeud.type)) {
    assert.deepEqual(noeud.type, ["string", "null"], chemin);
  } else {
    assert.equal(noeud.type, "string", chemin);
  }
}

// Même structure que le schéma DocIE : chaque champ, à chaque niveau, avec la forme attendue.
function verifierCorrespondance(champs, noeud, chemin) {
  assert.deepEqual(Object.keys(noeud.properties), champs.map((c) => c.name), chemin);
  for (const champ of champs) {
    const sous = noeud.properties[champ.name];
    const ici = chemin + "." + champ.name;
    if (["string", "date", "number"].includes(champ.type)) assert.deepEqual(sous.type, ["string", "null"], ici);
    if (champ.type === "date") assert.ok(sous.description.includes("AAAA-MM-JJ"), ici);
    if (champ.type === "money") assert.deepEqual(Object.keys(sous.properties), ["amount", "currency"], ici);
    if (champ.type === "object") verifierCorrespondance(champ.fields, sous, ici);
    if (champ.type === "list") {
      assert.equal(sous.type, "array", ici);
      if (champ.fields.length) verifierCorrespondance(champ.fields, sous.items, ici + "[]");
      else assert.deepEqual(sous.items, { type: "string" }, ici);
    }
    assert.ok(!("format" in sous), ici + " : pas de `format` non confirmé");
  }
}

test("conversion : chaque schéma de document-parsing/schemas (CV compris) donne un JSON Schema strict fidèle", () => {
  assert.deepEqual(SCHEMAS.map(([f]) => f),
    ["adbi_resume.schema.json", "contract.schema.json", "rib.schema.json", "urssaf.schema.json"]);
  for (const [fichier, dynamique] of SCHEMAS) {
    const { name, schema } = oa.schemaOpenAI(dynamique);
    assert.equal(name, "adbi_" + dynamique.document_type, fichier);
    assert.equal(schema.type, "object", fichier);
    verifierStrict(schema, fichier);
    verifierCorrespondance(dynamique.fields, schema, fichier);
  }
});

test("conversion : money -> {amount, currency} nullables, date sans motif, list imbriquée, description conservée", () => {
  const contrat = oa.schemaOpenAI(Object.fromEntries(SCHEMAS)["contract.schema.json"]).schema;
  assert.deepEqual(contrat.properties.tjm, {
    type: "object",
    description: "TJM en euros HT / jour",
    properties: {
      amount: { type: ["string", "null"], description: oa.CONSIGNE_MONTANT },
      currency: { type: ["string", "null"], description: oa.CONSIGNE_DEVISE },
    },
    required: ["amount", "currency"],
    additionalProperties: false,
  });
  assert.deepEqual(contrat.properties.date_debut, { type: ["string", "null"], description: oa.CONSIGNE_DATE });
  assert.ok(!("pattern" in contrat.properties.date_debut));
  assert.deepEqual(contrat.properties.delai_paiement, { type: ["string", "null"], description: "Delai de paiement en jours — " + oa.CONSIGNE_NOMBRE });
  assert.deepEqual(contrat.properties.numero_contrat, { type: ["string", "null"] });
  const cv = oa.schemaOpenAI(Object.fromEntries(SCHEMAS)["adbi_resume.schema.json"]).schema;
  assert.deepEqual(cv.properties.skills.items.properties.items.items.properties.item, { type: ["string", "null"] });
  assert.deepEqual(oa.schemaOpenAI({ document_type: "x", fields: [{ name: "tags", type: "list", fields: [] }] }).schema.properties.tags.items, { type: "string" });
});

test("conversion : schéma invalide refusé (type inconnu, nom invalide, doublon, objet vide, document_type)", () => {
  const cas = [
    null, {}, { document_type: "Contrat!", fields: [{ name: "a", type: "string" }] },
    { document_type: "x", fields: [] },
    { document_type: "x", fields: [{ name: "a", type: "boolean" }] },
    { document_type: "x", fields: [{ name: "a b", type: "string" }] },
    { document_type: "x", fields: [{ name: "a", type: "string" }, { name: "a", type: "date" }] },
    { document_type: "x", fields: [{ name: "o", type: "object", fields: [] }] },
  ];
  for (const c of cas) assert.throws(() => oa.schemaOpenAI(c), oa.ErreurSchema, JSON.stringify(c));
});

// ---------------------------------------------------------------------------
// Transport : aucune requête réseau, fetchImpl simulé.
// ---------------------------------------------------------------------------
const CLE = "sk-test-secret-1234567890";
const ENV = { OPENAI_API_KEY: CLE };
const CONTRAT = Object.fromEntries(SCHEMAS)["contract.schema.json"];
const EXTRAIT = Object.fromEntries(CONTRAT.fields.map((f) => [f.name, f.type === "money" ? { amount: "650", currency: "EUR" } : null]));
EXTRAIT.st_nom = "ACME SAS";
EXTRAIT.date_debut = "2026-10-01";

function reponse(corps = {}) {
  return {
    id: "resp_abc", object: "response", status: "completed", model: "gpt-4.1-nano-2025-04-14",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(EXTRAIT), annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    ...corps,
  };
}
function simuler(corps, statut = 200) {
  const appels = [];
  const fetchImpl = async (url, options) => {
    appels.push({ url, options, body: JSON.parse(options.body) });
    return new Response(typeof corps === "string" ? corps : JSON.stringify(corps), { status: statut });
  };
  return { appels, fetchImpl };
}
const extraire = (texte, options) => oa.extraireViaOpenAI(texte, { mode: "rapide", dynamicSchema: CONTRAT, env: ENV, ...options });
const sansCle = (e) => !JSON.stringify({ message: e.message, code: e.code, status: e.status, stack: e.stack }).includes(CLE);

test("requête, mode rapide : POST /v1/responses, store:false, schéma strict, gpt-4.1-nano, AUCUN bloc reasoning", async () => {
  const { appels, fetchImpl } = simuler(reponse());
  await extraire("Contrat ACME", { fetchImpl });
  assert.equal(appels.length, 1);
  const [{ url, options, body }] = appels;
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "manual");
  assert.equal(options.headers.Authorization, "Bearer " + CLE);
  assert.equal(body.store, false);
  assert.equal(body.model, "gpt-4.1-nano");
  assert.ok(!Object.hasOwn(body, "reasoning"), "jamais de reasoning en mode rapide");
  assert.deepEqual(body.text.format, { type: "json_schema", name: "adbi_contract", strict: true, schema: oa.schemaOpenAI(CONTRAT).schema });
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "Contrat ACME" }] }]);
  assert.equal(body.max_output_tokens, oa.MAX_OUTPUT_TOKENS);
  assert.ok(/untrusted data/.test(body.instructions) && /never infer, guess, compute or invent/.test(body.instructions));
  assert.ok(!JSON.stringify(body).includes(CLE));
});

test("requête, mode raisonnement : gpt-5-nano avec reasoning.effort = low, rien d'autre dans le bloc", async () => {
  const { appels, fetchImpl } = simuler(reponse({ model: "gpt-5-nano-2025-08-07" }));
  const r = await extraire("Contrat", { mode: "raisonnement", fetchImpl });
  assert.equal(appels[0].body.model, "gpt-5-nano");
  assert.deepEqual(appels[0].body.reasoning, { effort: "low" });
  assert.equal(appels[0].body.store, false);
  assert.equal(r.metadata.mode, "raisonnement");
});

test("modèles : défauts, surcharges permises, noms hors liste du mode -> configuration nommant la variable seule", async () => {
  assert.equal(oa.configurationOpenAI(ENV, "rapide").modele, "gpt-4.1-nano");
  assert.equal(oa.configurationOpenAI(ENV, "raisonnement").modele, "gpt-5-nano");
  const mini = simuler(reponse({ model: "gpt-4.1-mini-2025-04-14" }));
  await extraire("x", { env: { ...ENV, OPENAI_MODELE_RAPIDE: " gpt-4.1-mini " }, fetchImpl: mini.fetchImpl });
  assert.equal(mini.appels[0].body.model, "gpt-4.1-mini");
  assert.ok(!Object.hasOwn(mini.appels[0].body, "reasoning"));
  // Le mode vient du catalogue, jamais du nom : un modèle à raisonnement en
  // mode rapide (ou l'inverse) est refusé, jamais « corrigé ».
  const refus = [
    ["rapide", "OPENAI_MODELE_RAPIDE", "gpt-5-nano"],
    ["rapide", "OPENAI_MODELE_RAPIDE", "gpt-4o"],
    ["raisonnement", "OPENAI_MODELE_RAISONNEMENT", "gpt-4.1-nano"],
    ["raisonnement", "OPENAI_MODELE_RAISONNEMENT", "gpt-5"],
  ];
  for (const [mode, variable, valeur] of refus) {
    const { appels, fetchImpl } = simuler(reponse());
    await assert.rejects(extraire("x", { mode, env: { ...ENV, [variable]: valeur }, fetchImpl }),
      (e) => e.code === "configuration" && e.message.includes(variable) && !e.message.includes(valeur), variable + "=" + valeur);
    assert.equal(appels.length, 0);
  }
  for (const mode of [undefined, "gpt-5-nano", "RAPIDE", ""]) {
    await assert.rejects(extraire("x", { mode, fetchImpl: simuler(reponse()).fetchImpl }), (e) => e.code === "input", String(mode));
  }
});

test("configuration : clé, URL racine HTTPS, délai aligné sur DOCIE_TIMEOUT_SECONDS", async () => {
  const cas = [{}, { OPENAI_API_KEY: "  " }, { OPENAI_API_KEY: "a\nb" }, { ...ENV, OPENAI_BASE_URL: "http://api.example" },
    { ...ENV, OPENAI_BASE_URL: "https://api.openai.com/v1" }, { ...ENV, OPENAI_BASE_URL: "https://u:p@api.openai.com" },
    { ...ENV, OPENAI_TIMEOUT_SECONDS: "0" }, { ...ENV, OPENAI_TIMEOUT_SECONDS: "abc" }];
  for (const env of cas) {
    const { appels, fetchImpl } = simuler(reponse());
    await assert.rejects(extraire("x", { env, fetchImpl }), (e) => e.code === "configuration" && sansCle(e), JSON.stringify(env));
    assert.equal(appels.length, 0);
  }
  assert.equal(oa.configurationOpenAI(ENV, "rapide").timeout, 360);
  assert.equal(oa.configurationOpenAI({ ...ENV, DOCIE_TIMEOUT_SECONDS: "900" }, "rapide").timeout, 900);
  assert.equal(oa.configurationOpenAI({ ...ENV, DOCIE_TIMEOUT_SECONDS: "900", OPENAI_TIMEOUT_SECONDS: "120" }, "rapide").timeout, 120);
  assert.equal(oa.configurationOpenAI({ ...ENV, OPENAI_TIMEOUT_SECONDS: "", DOCIE_TIMEOUT_SECONDS: "" }, "rapide").timeout, 360);
  const eu = simuler(reponse());
  await extraire("x", { env: { ...ENV, OPENAI_BASE_URL: "https://eu.api.openai.com/" }, fetchImpl: eu.fetchImpl });
  assert.equal(eu.appels[0].url, "https://eu.api.openai.com/v1/responses");
});

test("texte seulement : PDF, image, tampon, vide, binaire, trop long ou schéma invalide -> input, sans appel", async () => {
  const cas = [[Buffer.from("%PDF-1.7"), CONTRAT], [new Uint8Array([137, 80, 78, 71]), CONTRAT], [{ mime: "image/png" }, CONTRAT],
    ["", CONTRAT], ["   \n", CONTRAT], ["%PDF\u0000binaire", CONTRAT], ["x".repeat(oa.MAX_TEXT_BYTES + 1), CONTRAT],
    ["texte", null], ["texte", { document_type: "contract", fields: [{ name: "a", type: "image" }] }]];
  for (const [texte, dynamicSchema] of cas) {
    const { appels, fetchImpl } = simuler(reponse());
    await assert.rejects(extraire(texte, { dynamicSchema, fetchImpl }), (e) => e instanceof oa.DocIEBridgeError && e.code === "input");
    assert.equal(appels.length, 0);
  }
});

test("résultat normalisé : forme du bridge, sans_preuve, modèle SERVI (pas le demandé), fournisseur, mode", async () => {
  const { fetchImpl } = simuler(reponse());
  const r = await extraire("Contrat", { fetchImpl });
  assert.equal(r.schema_name, "contract");
  assert.deepEqual(r.result, EXTRAIT);
  assert.deepEqual(r.result.tjm, { amount: "650", currency: "EUR" });
  const { elapsed_ms, ...meta } = r.metadata;
  assert.ok(Number.isInteger(elapsed_ms) && elapsed_ms >= 0);
  assert.deepEqual(meta, {
    request_id: "resp_abc", fournisseur: "openai", mode: "rapide", model: "gpt-4.1-nano-2025-04-14", agent: null,
    sans_preuve: true, field_confidence: null, validation: null, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    prompt_profile: null, partiel: [], blocs_texte: null, troncature_possible: false, schema_reported: false,
  });
  // Un autre modèle que la famille demandée : refus nommé, jamais accepté.
  for (const model of ["gpt-4o-2024-08-06", "gpt-4.1-nano2", "gpt-4.1-mini-2025-04-14", null]) {
    await assert.rejects(extraire("x", { fetchImpl: simuler(reponse({ model })).fetchImpl }), (e) => e.code === "schema", String(model));
  }
});

test("réponses : incomplete, refus, échec, sortie vide, JSON invalide, clés hors schéma", async () => {
  const cas = [
    [reponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), "incomplete"],
    [reponse({ status: "incomplete", incomplete_details: { reason: "content_filter" } }), "incomplete"],
    [reponse({ output: [{ type: "message", content: [{ type: "refusal", refusal: "I'm sorry" }] }] }), "refusal"],
    [reponse({ status: "failed", error: { code: "server_error", message: CLE } }), "upstream"],
    [reponse({ status: "in_progress" }), "upstream"],
    [reponse({ output: [{ type: "reasoning", summary: [] }] }), "response"],
    [reponse({ output: [{ type: "message", content: [{ type: "output_text", text: "pas du JSON" }] }] }), "response"],
    [reponse({ output: [{ type: "message", content: [{ type: "output_text", text: '{"st_nom":"A"}' }] }] }), "response"],
    [reponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...EXTRAIT, invente: 1 }) }] }] }), "response"],
    ["[]", "response"],
  ];
  for (const [corps, code] of cas) {
    await assert.rejects(extraire("x", { fetchImpl: simuler(corps).fetchImpl }), (e) => e.code === code && sansCle(e), code);
  }
  // Refus : le texte du refus n'est pas recopié non plus.
  await assert.rejects(extraire("x", { fetchImpl: simuler(cas[2][0]).fetchImpl }), (e) => !e.message.includes("I'm sorry"));
});

test("erreurs HTTP et transport : codes existants, statut conservé, clé jamais recopiée (même réfléchie dans le corps)", async () => {
  const corpsCle = JSON.stringify({ error: { message: "Incorrect API key provided: " + CLE + " (sk-test-...7890)", type: "invalid_request_error", code: "invalid_api_key" } });
  const cas = [
    [401, corpsCle, "auth"], [403, corpsCle, "auth"], [413, corpsCle, "limits"], [429, corpsCle, "rate_limit"],
    [400, JSON.stringify({ error: { message: "Your input exceeds the context window of this model. " + CLE, code: "context_length_exceeded" } }), "context"],
    [400, corpsCle, "upstream"], [404, corpsCle, "upstream"], [500, corpsCle, "upstream"], [503, corpsCle, "upstream"], [302, "", "upstream"],
  ];
  for (const [statut, corps, code] of cas) {
    await assert.rejects(extraire("x", { fetchImpl: simuler(corps, statut).fetchImpl }),
      (e) => e.code === code && e.status === statut && sansCle(e) && !e.message.includes("Your input exceeds") && !e.message.includes("sk-test"), statut + " " + code);
  }
  await assert.rejects(extraire("x", { fetchImpl: async () => { throw Error("boom " + CLE); } }), (e) => e.code === "network" && sansCle(e));
  await assert.rejects(extraire("x", { env: { ...ENV, OPENAI_TIMEOUT_SECONDS: "1" },
    fetchImpl: (url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Error(CLE)), { once: true })) }),
  (e) => e.code === "timeout" && sansCle(e));
  for (const corps of ["pas du JSON " + CLE, "x".repeat(8 * 1024 * 1024 + 1)]) {
    await assert.rejects(extraire("x", { fetchImpl: simuler(corps).fetchImpl }), (e) => e.code === "response" && sansCle(e));
  }
  // Clé réfléchie dans une réponse RÉUSSIE (valeur extraite) : caviardée, absente de tout le résultat.
  const reflet = reponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...EXTRAIT, st_nom: CLE }) }] }] });
  const r = await extraire("x", { fetchImpl: simuler(reflet).fetchImpl });
  assert.equal(r.result.st_nom, "[REDACTED]");
  assert.ok(!JSON.stringify(r).includes(CLE));
});
