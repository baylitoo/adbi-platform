"use strict";
// Choix du modèle par action (#194) côté serveur : offres, routes, contrat par
// la voie texte avec le modèle choisi, URSSAF sans repli pour un modèle choisi.
//
// Aucun appel réseau : DocIE est simulé à la frontière HTTP du VRAI bridge
// (fetchImpl), et les PDF sont de vrais PDF pdfkit (le routage se décide sur la
// couche texte réellement présente).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const PDFDocument = require("pdfkit");

const { extractContractValues, MAPPED_FIELDS, SCHEMA_CONTRAT_PATH } = require("../lib/docie-contract-import");
const { analyzeDocument } = require("../lib/docie-extraction");
const { monterPreremplissage } = require("../lib/import-extraction-routes");
const { creerGestionnaire, mapperErreur, MESSAGES_SERVICE } = require("../lib/taches-extraction");
const choix = require("../lib/choix-modele");

const RAW_CONTRAT = require(path.join(
  __dirname, "..", "..", "document-parsing", "mappings", "fixtures", "contract_extraction_sample.json"
));

const BASE = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test", DOCIE_API_KEY: "cle-test" };
const MODELES_CONTRAT = { DOCIE_MODELE_NUEXTRACT3: "store:nuextract3", DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
const MODELES_URSSAF = { DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b", DOCIE_MODELE_LFM25_350M: "store:lfm2.5-350m" };

function pdf(dessine) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    dessine(doc);
    doc.end();
  });
}
const pdfTexte = (texte) => pdf((doc) => doc.fontSize(11).text(texte));
const pdfScanne = () => pdf((doc) => doc.rect(50, 50, 300, 200).fill("#cccccc"));

// DocIE simulé : chaque appel est gardé (URL + corps JSON) ; `repondre` fabrique la réponse.
function docie(repondre) {
  const appels = [];
  const fetchImpl = async (url, options) => {
    appels.push({ url, corps: JSON.parse(options.body) });
    const { status = 200, corps } = repondre(appels.length);
    return new Response(JSON.stringify(corps), { status });
  };
  return { appels, fetchImpl };
}
const reponseContratTexte = (modelProfile) => ({
  corps: {
    request_id: "req-contrat-texte", schema_name: "contract", model_profile: modelProfile,
    result: RAW_CONTRAT.result, validation: { valid: true, errors: [], warnings: [] },
  },
});
const reponseUrssafTexte = (modelProfile) => ({
  corps: {
    request_id: "req-urssaf", schema_name: "urssaf", model_profile: modelProfile,
    result: {
      document_type: "urssaf", extraction_notes: [],
      company_name: { value: "SUND INDUSTRY SYSTEM", evidence_ids: ["b1"], confidence: 0.98 },
      issued_date: { value: "2026-03-04", evidence_ids: ["b2"], confidence: 0.95 },
    },
    validation: { valid: true, errors: [], warnings: [] },
  },
});

const TEXTE_CONTRAT = [
  "CONVENTION DE SOUS-TRAITANCE N° 01-06-2026",
  "Entre ADBI et SUND INDUSTRY SYSTEM",
  "Article 1 - Objet",
].join("\n");

// ---------------------------------------------------------------------------
// Offres et routes
// ---------------------------------------------------------------------------

test("offres publiques : défaut d'abord, plafond de lignes, aucun identifiant réel", () => {
  const offres = choix.offresPubliques("contract", { env: MODELES_CONTRAT });
  assert.deepEqual(offres, [
    { id: "nuextract3", libelle: "NuExtract3", description: "Précis mais lent — plusieurs minutes", role: "defaut", lignesMax: null },
    { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "alternative", lignesMax: 800 },
  ]);
  assert.ok(!JSON.stringify(offres).includes("store:"));
  assert.deepEqual(choix.offresPubliques("urssaf", { env: MODELES_URSSAF }).map((o) => [o.id, o.role]),
    [["lfm25_2_6b", "defaut"], ["lfm25_350m", "alternative"]]);
  assert.deepEqual(choix.offresPubliques("contract", { env: {} }), []);
});

async function demarrer({ env, extractContractValues: extraction = async () => ({ ok: true }) }) {
  const app = express();
  app.use(express.json({ limit: "30mb" }));
  const gestionnaire = creerGestionnaire({ journal: () => {} });
  const recus = [];
  monterPreremplissage(app, {
    extractContractValues: async (corps) => { recus.push(corps); return extraction(corps); },
    gestionnaire, env, journal: () => {},
  });
  const serveur = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return {
    base, gestionnaire, recus,
    fermer: () => new Promise((ok) => serveur.close(ok)),
    modeles: (tache) => fetch(base + "/api/modeles?tache=" + tache),
    post: (corps) => fetch(base + "/api/contracts/importer/extraire", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
    }),
  };
}

test("GET /api/modeles : rien de configuré ou flag coupé -> liste vide ; configuré -> offres ; tâche sans sélecteur -> 400", async () => {
  const vide = await demarrer({ env: BASE });
  const avec = await demarrer({ env: { ...BASE, ...MODELES_CONTRAT, ...MODELES_URSSAF } });
  const coupe = await demarrer({ env: { ...MODELES_CONTRAT } });
  try {
    assert.deepEqual(await (await vide.modeles("contract")).json(), { tache: "contract", modeles: [] });
    const r = await (await avec.modeles("contract")).json();
    assert.deepEqual(r.modeles.map((m) => m.id), ["nuextract3", "lfm25_2_6b"]);
    assert.ok(!JSON.stringify(r).includes("store:"));
    assert.deepEqual((await (await avec.modeles("urssaf")).json()).modeles.map((m) => m.id), ["lfm25_2_6b", "lfm25_350m"]);
    assert.deepEqual(await (await coupe.modeles("contract")).json(), { tache: "contract", modeles: [] });
    // Le Kbis a désormais un sélecteur (#194) : tâche sans sélecteur = fiscale.
    const fiscale = await avec.modeles("fiscale");
    assert.equal(fiscale.status, 400);
  } finally {
    await vide.fermer(); await avec.fermer(); await coupe.fermer();
  }
});

test("GET /api/modeles?tache=contract : octet pour octet, le drapeau `experimental` du catalogue (CV) ne sort pas ici", async () => {
  const srv = await demarrer({ env: { ...BASE, ...MODELES_CONTRAT } });
  try {
    assert.equal(await (await srv.modeles("contract")).text(),
      '{"tache":"contract","modeles":[' +
      '{"id":"nuextract3","libelle":"NuExtract3","description":"Précis mais lent — plusieurs minutes","role":"defaut","lignesMax":null},' +
      '{"id":"lfm25_2_6b","libelle":"LFM2.5 2.6B","description":"Rapide","role":"alternative","lignesMax":800}]}');
  } finally {
    await srv.fermer();
  }
});

test("GET /api/modeles : identifiant mal formé -> 500 nommé, la valeur n'est jamais renvoyée", async () => {
  const srv = await demarrer({ env: { ...BASE, DOCIE_MODELE_NUEXTRACT3: "store:secret\u0001" } });
  try {
    const r = await srv.modeles("contract");
    assert.equal(r.status, 500);
    const corps = await r.json();
    assert.equal(corps.code, "configuration");
    assert.ok(!JSON.stringify(corps).includes("secret"));
  } finally { await srv.fermer(); }
});

test("POST extraire : modèle non configuré -> 400 avant toute tâche ; configuré -> transmis ; absent -> corps d'avant", async () => {
  const pdfOk = (await pdfTexte(TEXTE_CONTRAT)).toString("base64");
  const srv = await demarrer({ env: { ...BASE, DOCIE_MODELE_NUEXTRACT3: "store:nuextract3" } });
  try {
    const refus = await srv.post({ mimeType: "application/pdf", dataBase64: pdfOk, modele: "lfm25_2_6b" });
    assert.equal(refus.status, 400);
    assert.deepEqual(await refus.json(), { error: choix.MESSAGES_CHOIX.modele_non_propose, code: "modele_non_propose" });
    const inconnu = await srv.post({ mimeType: "application/pdf", dataBase64: pdfOk, modele: 42 });
    assert.equal(inconnu.status, 400);
    assert.equal(srv.gestionnaire.statistiques().conservees, 0);

    assert.equal((await srv.post({ mimeType: "application/pdf", dataBase64: pdfOk, modele: "nuextract3" })).status, 202);
    assert.equal((await srv.post({ mimeType: "application/pdf", dataBase64: pdfOk })).status, 202);
    await new Promise((ok) => setTimeout(ok, 20));
    assert.deepEqual(srv.recus.map((c) => Object.keys(c).sort()), [["dataBase64", "mimeType", "modele"], ["dataBase64", "mimeType"]]);
    assert.equal(srv.recus[0].modele, "nuextract3");
  } finally { await srv.fermer(); }
});

// ---------------------------------------------------------------------------
// Contrat : voie texte avec le modèle choisi
// ---------------------------------------------------------------------------

test("contrat + NuExtract3 choisi : voie texte (jamais l'agent), store: envoyé, schéma contract dans la requête, modèle servi rendu", async () => {
  const env = { ...BASE, ...MODELES_CONTRAT, DOCIE_AGENT_CONTRACT: "agent-contrat" };
  const { appels, fetchImpl } = docie(() => reponseContratTexte("nuextract3"));
  const body = { mimeType: "application/pdf", dataBase64: (await pdfTexte(TEXTE_CONTRAT)).toString("base64"), modele: "nuextract3" };
  const res = await extractContractValues(body, { env, fetchImpl });
  assert.equal(appels.length, 1);
  assert.equal(appels[0].url, "https://docie.example.test/v1/extract/text");
  assert.equal(appels[0].corps.model_profile, "store:nuextract3");
  assert.equal(appels[0].corps.schema_name, "contract");
  assert.equal(appels[0].corps.dynamic_schema.document_type, "contract");
  assert.ok(appels[0].corps.text.includes("CONVENTION DE SOUS-TRAITANCE"));
  // Langue : c'est ICI qu'elle est connue — le pont n'en devine aucune. Ce que
  // ce test épingle est le CÂBLAGE, pas l'effet : `nuextract3`, le profil de ce
  // cas, ne rend AUCUNE ligne « Language » (seuls les profils génériques le
  // font, llm/prompts.py:223), donc la valeur ne change rien ici. Elle part
  // quand même parce qu'elle est vraie et que le profil se choisit par appel.
  // Sans cette assertion, `langue: "fr"` peut disparaître de
  // docie-contract-import.js sans qu'un seul test rougisse.
  assert.equal(appels[0].corps.language, "fr");
  assert.deepEqual(res.modele, { id: "nuextract3", libelle: "NuExtract3" });
  assert.equal(res.requestId, "req-contrat-texte");
  assert.equal(res.values.stNom, "SUND INDUSTRY SYSTEM");
  assert.equal(res.values.tjm, "450");
});

test("contrat : 800 lignes non vides -> LFM2.5 2.6B proposé et envoyé ; 801 -> refus `limite` sans appel ; NuExtract3 à 801 -> accepté", async () => {
  const env = { ...BASE, ...MODELES_CONTRAT };
  const body = { mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64") };
  const couche = (n) => async () => ({ ok: true, texte: "Clause\n\n".repeat(n) });

  const a800 = docie(() => reponseContratTexte("lfm2.5-2.6b"));
  const r800 = await extractContractValues({ ...body, modele: "lfm25_2_6b" }, { env, fetchImpl: a800.fetchImpl, coucheTexteUtilisable: couche(800) });
  assert.equal(a800.appels[0].corps.model_profile, "store:lfm2.5-2.6b");
  assert.deepEqual(r800.modele, { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });

  const a801 = docie(() => { throw new Error("DocIE ne doit pas être appelé"); });
  await assert.rejects(
    () => extractContractValues({ ...body, modele: "lfm25_2_6b" }, { env, fetchImpl: a801.fetchImpl, coucheTexteUtilisable: couche(801) }),
    (e) => e.name === "ErreurChoixModele" && e.code === "limite");
  assert.equal(a801.appels.length, 0);

  const n801 = docie(() => reponseContratTexte("nuextract3"));
  await extractContractValues({ ...body, modele: "nuextract3" }, { env, fetchImpl: n801.fetchImpl, coucheTexteUtilisable: couche(801) });
  assert.equal(n801.appels.length, 1);
});

test("contrat scanné (PDF sans couche texte, ou image) + modèle choisi -> `scan`, ni DocIE ni agent en repli", async () => {
  const env = { ...BASE, ...MODELES_CONTRAT, DOCIE_AGENT_CONTRACT: "agent-contrat" };
  const { appels, fetchImpl } = docie(() => { throw new Error("DocIE ne doit pas être appelé"); });
  const scan = (await pdfScanne()).toString("base64");
  await assert.rejects(() => extractContractValues({ mimeType: "application/pdf", dataBase64: scan, modele: "nuextract3" }, { env, fetchImpl }),
    (e) => e.code === "scan" && e.message === choix.MESSAGES_CHOIX.scan);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  await assert.rejects(() => extractContractValues({ mimeType: "image/png", dataBase64: png, modele: "nuextract3" }, { env, fetchImpl }),
    (e) => e.code === "scan");
  assert.equal(appels.length, 0);
});

test("contrat sans `modele`, même catalogue configuré : agent DOCIE_AGENT_CONTRACT comme avant, aucune clé `modele` ajoutée", async () => {
  const env = { ...BASE, ...MODELES_CONTRAT, DOCIE_AGENT_CONTRACT: "agent-contrat" };
  const { appels, fetchImpl } = docie(() => ({
    corps: { id: "chat-1", model: "agent-contrat", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(RAW_CONTRAT.result) } }] },
  }));
  const res = await extractContractValues({ mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") }, { env, fetchImpl });
  assert.equal(appels[0].url, "https://docie.example.test/v1/agents/agent-contrat/chat/completions");
  assert.equal(Object.hasOwn(res, "modele"), false);
});

test("modèle servi : ce que DocIE rapporte, pas ce qui a été demandé", async () => {
  const env = { ...BASE, ...MODELES_CONTRAT };
  const body = { mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64"), modele: "nuextract3" };
  const couche = async () => ({ ok: true, texte: TEXTE_CONTRAT });
  const autre = docie(() => reponseContratTexte("deploiement-inconnu"));
  assert.deepEqual((await extractContractValues(body, { env, fetchImpl: autre.fetchImpl, coucheTexteUtilisable: couche })).modele,
    { id: null, libelle: "deploiement-inconnu" });
  const lfm = docie(() => reponseContratTexte("store:lfm2.5-2.6b"));
  assert.deepEqual((await extractContractValues(body, { env, fetchImpl: lfm.fetchImpl, coucheTexteUtilisable: couche })).modele,
    { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
  const muet = docie(() => reponseContratTexte(null));
  assert.equal((await extractContractValues(body, { env, fetchImpl: muet.fetchImpl, coucheTexteUtilisable: couche })).modele, null);
});

test("schéma contract de la voie texte : exactement les 19 champs mappés", () => {
  const schema = require(SCHEMA_CONTRAT_PATH);
  assert.equal(schema.document_type, "contract");
  assert.deepEqual(schema.fields.map((f) => f.name).sort(), Object.keys(MAPPED_FIELDS).sort());
});

test("tâche en échec pour un choix de modèle : code nommé, message constant", () => {
  for (const code of ["modele_non_propose", "limite", "scan", "configuration"]) {
    assert.deepEqual(mapperErreur(new choix.ErreurChoixModele(code)), { code, message: choix.MESSAGES_CHOIX[code] });
    assert.equal(MESSAGES_SERVICE[code], choix.MESSAGES_CHOIX[code]);
  }
});

// ---------------------------------------------------------------------------
// URSSAF : échouer bruyamment pour un modèle choisi, inchangé sinon
// ---------------------------------------------------------------------------

const ITEMS_URSSAF = [{ id: "urssaf", label: "L'attestation de vigilance URSSAF" }];
const TEXTE_URSSAF = "URSSAF ILE-DE-FRANCE\nATTESTATION DE VIGILANCE\nEdition du 04/03/2026";
function localInterdit() {
  const appels = [];
  const analyzeLocal = async () => { appels.push(1); return { documentType: "Local", issues: [], summary: "local" }; };
  return { appels, analyzeLocal };
}

test("URSSAF + modèle choisi + DocIE en panne : erreur nommée, AUCUNE analyse locale", async () => {
  const env = { ...BASE, ...MODELES_URSSAF };
  const { fetchImpl } = docie(() => ({ status: 500, corps: { error: "boom" } }));
  const local = localInterdit();
  const body = { mimeType: "application/pdf", dataBase64: (await pdfTexte(TEXTE_URSSAF)).toString("base64"), items: ITEMS_URSSAF, modele: "lfm25_350m" };
  await assert.rejects(() => analyzeDocument(body, { env, fetchImpl, analyzeLocal: local.analyzeLocal }),
    (e) => e.code === "upstream" && e.message === "Le service d'extraction a répondu en erreur.");
  assert.equal(local.appels.length, 0);
});

test("URSSAF sans modèle, catalogue configuré, DocIE en panne : repli local comme avant", async () => {
  const env = { ...BASE, ...MODELES_URSSAF };
  const { appels, fetchImpl } = docie(() => ({ status: 500, corps: { error: "boom" } }));
  const local = localInterdit();
  const body = { mimeType: "application/pdf", dataBase64: (await pdfTexte(TEXTE_URSSAF)).toString("base64"), items: ITEMS_URSSAF };
  const res = await analyzeDocument(body, { env, fetchImpl, analyzeLocal: local.analyzeLocal });
  assert.equal(local.appels.length, 1);
  assert.equal(Object.hasOwn(appels[0].corps, "model_profile"), false);
  assert.ok(res.issues.some((i) => i.includes("analyse locale utilisée en repli")));
  assert.equal(Object.hasOwn(res, "modele"), false);
});

test("URSSAF scannée + modèle choisi : `scan`, ni DocIE ni analyse locale", async () => {
  const env = { ...BASE, ...MODELES_URSSAF };
  const { appels, fetchImpl } = docie(() => { throw new Error("DocIE ne doit pas être appelé"); });
  const local = localInterdit();
  const body = { mimeType: "application/pdf", dataBase64: (await pdfScanne()).toString("base64"), items: ITEMS_URSSAF, modele: "lfm25_2_6b" };
  await assert.rejects(() => analyzeDocument(body, { env, fetchImpl, analyzeLocal: local.analyzeLocal }), (e) => e.code === "scan");
  assert.equal(appels.length + local.appels.length, 0);
});

test("URSSAF + 350M choisi : store: envoyé, modèle servi dans l'analyse", async () => {
  const env = { ...BASE, ...MODELES_URSSAF };
  const { appels, fetchImpl } = docie(() => reponseUrssafTexte("lfm2.5-350m"));
  const body = { mimeType: "application/pdf", dataBase64: (await pdfTexte(TEXTE_URSSAF)).toString("base64"), items: ITEMS_URSSAF, modele: "lfm25_350m" };
  const res = await analyzeDocument(body, { env, fetchImpl, analyzeLocal: localInterdit().analyzeLocal });
  assert.equal(appels[0].corps.model_profile, "store:lfm2.5-350m");
  assert.deepEqual(res.modele, { id: "lfm25_350m", libelle: "LFM2.5 350M" });
  assert.equal(res.issuedDate, "2026-03-04");
});

test("URSSAF + modèle non configuré pour l'URSSAF : `modele_non_propose`, ni DocIE ni local", async () => {
  const env = { ...BASE, ...MODELES_URSSAF };
  const { appels, fetchImpl } = docie(() => reponseUrssafTexte("x"));
  const local = localInterdit();
  const body = { mimeType: "application/pdf", dataBase64: (await pdfTexte(TEXTE_URSSAF)).toString("base64"), items: ITEMS_URSSAF, modele: "nuextract3" };
  await assert.rejects(() => analyzeDocument(body, { env, fetchImpl, analyzeLocal: local.analyzeLocal }), (e) => e.code === "modele_non_propose");
  assert.equal(appels.length + local.appels.length, 0);
});
