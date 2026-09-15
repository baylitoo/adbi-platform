"use strict";
// Câblage de la voie TEXTE pour le RIB — issues #170 et #194.
//
// Même politique que docie-extraction-urssaf.test.js : aucun appel réseau réel,
// soit le bridge est stubbé (deps.extractText), soit il est exercé POUR DE VRAI
// avec fetchImpl mocké. Les PDF sont de vrais PDF construits avec pdfkit : le
// routage se décide sur la couche texte réellement présente dans le fichier.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const PDFDocument = require("pdfkit");
const { analyzeDocument, extractViaTexte, chargerSchema, VOIES } = require("../lib/docie-extraction");

const SCHEMA = require(path.join(__dirname, "..", "..", "document-parsing", "schemas", "rib.schema.json"));

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

// Valeurs fabriquées : IBAN = exemple FR du registre IBAN (voir `_exemples`
// dans document-parsing/fixtures/iban_bic.json), aucun compte réel.
const TEXTE_RIB = [
  "RELEVE D'IDENTITE BANCAIRE",
  "Titulaire du compte : SUND INDUSTRY SYSTEM",
  "Domiciliation : BANQUE EXEMPLE PARIS OPERA",
  "IBAN : FR14 2004 1010 0505 0001 3M02 606",
  "BIC : BNPAFRPP",
].join("\n");

const pdfTexte = () => pdf((doc) => doc.fontSize(11).text(TEXTE_RIB));
const pdfScanne = () => pdf((doc) => doc.rect(50, 50, 300, 200).fill("#cccccc"));
const pdfTexteEtPageMuette = () => pdf((doc) => {
  doc.fontSize(11).text(TEXTE_RIB);
  doc.addPage().rect(50, 50, 300, 200).fill("#cccccc");
});

const ENV = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "cle-test" };
const ITEMS = [{ id: "rib", label: "Un RIB" }];

// Réponse DocIE plate (POST /v1/extract/text), même forme que
// document-parsing/mappings/fixtures/rib_extraction_sample.json.
function reponseDocie({ iban = "FR14 2004 1010 0505 0001 3M02 606", bic = "BNPAFRPP" } = {}) {
  const champ = (value) => ({ value, evidence_ids: ["b1"], confidence: 0.95 });
  return {
    request_id: "req-test-rib",
    schema_name: "rib",
    model_profile: "lfm2.5-2.6b",
    result: {
      document_type: "rib",
      extraction_notes: [],
      account_holder: champ("SUND INDUSTRY SYSTEM"),
      iban: champ(iban),
      bic: champ(bic),
      bank_name: champ("BANQUE EXEMPLE PARIS OPERA"),
    },
    validation: { valid: true, errors: [], warnings: [] },
    latency_ms: 1234,
  };
}

function localMarque(tag) {
  return async () => ({
    documentType: "RIB", matchedId: "rib", isValid: true, issuedDate: "",
    companyName: null, nameMatches: null, issues: [], summary: tag,
  });
}

test("table de routage : rib part sur la voie texte avec son propre schéma", () => {
  assert.equal(VOIES.rib, "texte");
  assert.deepEqual(chargerSchema("rib"), SCHEMA);
  assert.equal(SCHEMA.document_type, "rib");
});

test("RIB scanné, page muette ou image : DocIE JAMAIS sollicité, analyse locale + cause nommée", async () => {
  for (const [nom, fabrique, mime, motif] of [
    ["scan", pdfScanne, "application/pdf", /sans texte|OCR requis/],
    ["page muette", pdfTexteEtPageMuette, "application/pdf", /page 2/],
    ["image", async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", /pas un PDF/],
  ]) {
    let appels = 0;
    const extractText = async () => { appels++; throw new Error("jamais appelé : " + nom); };
    const body = { dataBase64: (await fabrique()).toString("base64"), mimeType: mime, items: ITEMS };
    const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localMarque("local-" + nom), extractText });
    assert.equal(appels, 0, nom + " : un texte absent ou amputé ne doit jamais partir");
    assert.equal(res.summary, "local-" + nom);
    const avert = res.issues.find((i) => i.startsWith("DocIE non sollicité"));
    assert.ok(avert, nom + " : " + res.issues.join(" | "));
    assert.match(avert, motif);
    assert.ok(!res.issues.some((i) => i.includes("Extraction DocIE indisponible")), nom);
  }
});

test("PDF texte : le VRAI bridge poste le texte lu localement + la définition du schéma rib", async () => {
  const requetes = [];
  const fetchImpl = async (url, options) => {
    requetes.push({ url, headers: options.headers, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify(reponseDocie()), { status: 200 });
  };
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf",
    items: ITEMS, expectedName: "Sund Industry System" };
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localMarque("local"), fetchImpl });

  assert.equal(requetes.length, 1);
  const { url, headers, payload } = requetes[0];
  assert.equal(url, "https://docie.example/v1/extract/text");
  assert.equal(headers["x-api-key"], "cle-test");
  assert.equal(payload.schema_name, "rib");
  assert.equal(payload.schema_mode, "dynamic");
  assert.deepEqual(payload.dynamic_schema, SCHEMA);
  assert.match(payload.text, /IBAN : FR14 2004 1010 0505 0001 3M02 606/);
  assert.ok(!payload.text.includes("%PDF"));

  assert.equal(res.documentType, "RIB");
  assert.equal(res.matchedId, "rib");
  assert.equal(res.summary, "RIB (DocIE)");
  assert.equal(res.nameMatches, true);
  assert.equal(res.titulaireCompte, "SUND INDUSTRY SYSTEM");
  assert.equal(res.iban, "FR14 2004 1010 0505 0001 3M02 606");
  assert.equal(res.bic, "BNPAFRPP");
  assert.equal(res.controleIbanBic.iban.statut, "valide");
  assert.equal(res.controleIbanBic.bic.statut, "valide");
  assert.deepEqual(res.issues, []);
});

test("IBAN mal lu par DocIE : valeur CONSERVÉE, statut cle_invalide, message dans issues", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(reponseDocie({ iban: "FR14 2004 1010 0505 0001 3M02 607" })), { status: 200 });
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localMarque("local"), fetchImpl });
  assert.equal(res.iban, "FR14 2004 1010 0505 0001 3M02 607");
  assert.equal(res.controleIbanBic.iban.statut, "cle_invalide");
  assert.ok(res.issues.includes("IBAN « FR14 2004 1010 0505 0001 3M02 607 » : clé de contrôle invalide (modulo 97), caractère probablement mal lu — valeur conservée, à vérifier sur le document"));
  assert.equal(res.documentType, "RIB", "le document reste un RIB lisible : c'est une valeur qui est douteuse");
});

test("BIC d'un autre pays que l'IBAN valide : pays_discordant sur le BIC seul", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(reponseDocie({ bic: "DEUTDEFF" })), { status: 200 });
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localMarque("local"), fetchImpl });
  assert.equal(res.controleIbanBic.iban.statut, "valide");
  assert.equal(res.controleIbanBic.bic.statut, "pays_discordant");
  assert.equal(res.bic, "DEUTDEFF");
  assert.ok(res.issues.some((i) => i.startsWith("BIC « DEUTDEFF » : pays DE différent du pays FR")));
});

test("échec DocIE ou configuration absente sur la voie texte : repli local, cause nommée", async () => {
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  for (const [fetchImpl, motif] of [
    [async () => new Response("{}", { status: 500 }), /upstream/],
    [async () => { throw new Error("réseau coupé"); }, /network/],
  ]) {
    const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localMarque("local-repli"), fetchImpl });
    assert.equal(res.summary, "local-repli");
    assert.match(res.issues.find((i) => i.startsWith("Extraction DocIE indisponible")) || "", motif);
  }
  const sansConfig = await analyzeDocument(body, { env: { DOCIE_EXTRACTION_ENABLED: "true" },
    analyzeLocal: localMarque("local-sans-config"), fetchImpl: async () => { throw new Error("jamais atteint"); } });
  assert.equal(sansConfig.summary, "local-sans-config");
  assert.ok(sansConfig.issues.some((i) => i.includes("Extraction DocIE indisponible (configuration)")));
});

test("flag désactivé : RIB analysé localement, bridge jamais chargé", async () => {
  let appels = 0;
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  const res = await analyzeDocument(body, { env: {}, analyzeLocal: localMarque("local-flag-off"),
    extractText: async () => { appels++; throw new Error("jamais"); } });
  assert.equal(appels, 0);
  assert.equal(res.summary, "local-flag-off");
  assert.deepEqual(res.issues, []);
});

test("extractViaTexte : pièce inconnue refusée, jamais d'analyse sans texte à envoyer", async () => {
  await assert.rejects(extractViaTexte("kbis", { dataBase64: "AA==" }, { env: ENV }), /Pièce sans voie texte/);
  const { analysis, raisonRepli } = await extractViaTexte("rib",
    { dataBase64: (await pdfScanne()).toString("base64"), mimeType: "application/pdf", items: ITEMS },
    { env: ENV, extractText: async () => { throw new Error("jamais"); } });
  assert.equal(analysis, null);
  assert.ok(raisonRepli);
});
