"use strict";
// Câblage de la voie TEXTE pour l'attestation de régularité fiscale — #215.
//
// Même politique que docie-extraction-rib.test.js : aucun appel réseau réel, et
// les PDF sont de VRAIS PDF construits avec pdfkit, parce que le routage se
// décide sur la couche texte réellement présente dans le fichier
// (coucheTexteUtilisable n'est pas injectable). Un `dataBase64` bidon ferait
// retomber le test sur l'analyse locale sans jamais solliciter DocIE : il
// passerait au vert en ne prouvant rien.
//
// La réponse stubbée est la fixture PARTAGÉE avec Python
// (document-parsing/mappings/fixtures/fiscale_extraction_sample.json), passée
// par le VRAI déballage du pont (parseTextResponse) — pas une enveloppe
// reconstruite à la main.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { analyzeDocument, chargerSchema, VOIES, PIECES_TEXTE } = require("../lib/docie-extraction");

const RACINE = path.join(__dirname, "..", "..");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "fiscale.schema.json"));
const { parseTextResponse } = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));
const FIXTURE = path.join(RACINE, "document-parsing", "mappings", "fixtures", "fiscale_extraction_sample.json");

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

// Valeurs fabriquées, cohérentes avec la fixture partagée. Aucune attestation
// réelle : la réserve de fiscale_to_contrats.py (« aucune attestation reelle
// n'a ete lue ») vaut toujours.
const TEXTE_FISCALE = [
  "ATTESTATION DE REGULARITE FISCALE",
  "Service des impots des entreprises : SIE de Paris 2e",
  "Denomination : SUND INDUSTRY SYSTEM",
  "SIREN : 941091316",
  "SIRET : 94109131600013",
  "Delivree le : 04/03/2026",
  "L'entreprise est a jour de ses obligations fiscales declaratives et de paiement",
].join("\n");

const pdfTexte = () => pdf((doc) => doc.fontSize(11).text(TEXTE_FISCALE));
const pdfScanne = () => pdf((doc) => doc.rect(50, 50, 300, 200).fill("#cccccc"));

const ENV = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "cle-test" };
const ITEMS = [{ id: "fiscale", label: "L'attestation de régularité fiscale" }];

// Sortie du pont telle que lib/docie-extraction.js la reçoit : {result, metadata}.
function reponseDocie() {
  return parseTextResponse(JSON.parse(fs.readFileSync(FIXTURE, "utf8")), "fiscale");
}

function localMarque(tag) {
  return async () => ({
    documentType: "Attestation de régularité fiscale", matchedId: "fiscale", isValid: true,
    issuedDate: "", companyName: null, nameMatches: null, issues: [], summary: tag,
  });
}

test("table de routage : fiscale part sur la voie texte avec SON schéma", () => {
  assert.equal(VOIES.fiscale, "texte");
  assert.equal(SCHEMA.document_type, "fiscale");
  assert.deepEqual(chargerSchema("fiscale"), SCHEMA);
  // Le schéma servi n'est pas celui d'une autre pièce (copier-coller du chemin).
  assert.notEqual(PIECES_TEXTE.fiscale.schemaPath, PIECES_TEXTE.urssaf.schemaPath);
  assert.notEqual(PIECES_TEXTE.fiscale.schemaPath, PIECES_TEXTE.rib.schemaPath);
});

test("attestation à couche texte : DocIE sollicité une fois, mapping fiscale appliqué", async () => {
  let appels = 0;
  let recu = null;
  const extractText = async (texte, options) => {
    appels++;
    recu = { texte, options };
    return reponseDocie();
  };
  const extractDocument = async () => { throw new Error("voie agent interdite pour fiscale"); };
  const analyzeLocal = async () => { throw new Error("aucun repli local attendu ici"); };
  const body = {
    dataBase64: (await pdfTexte()).toString("base64"),
    mimeType: "application/pdf",
    items: ITEMS,
    expectedName: "SUND INDUSTRY SYSTEM",
  };
  const result = await analyzeDocument(body, { env: ENV, extractText, extractDocument, analyzeLocal });

  assert.equal(appels, 1);
  // La DÉFINITION du schéma voyage dans le corps : c'est ce qui dispense d'un
  // enregistrement Studio. Un chemin de schéma erroné se voit ici.
  assert.equal(recu.options.kind, "fiscale");
  assert.equal(recu.options.dynamicSchema.document_type, "fiscale");
  assert.ok(recu.texte.includes("SUND INDUSTRY SYSTEM"));
  // Aucun sélecteur pour cette pièce : jamais de modelProfile imposé (#215).
  assert.equal(recu.options.modelProfile, undefined);

  // Mapper de fiscale, et pas un autre : le libellé est celui de docanalyze.js.
  assert.equal(result.documentType, "Attestation de régularité fiscale");
  assert.equal(result.matchedId, "fiscale");
  assert.equal(result.isValid, true);
  assert.equal(result.issuedDate, "2026-03-04");
  assert.equal(result.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(result.siren, "941091316");
  assert.equal(result.siret, "94109131600013");
  assert.equal(result.serviceImpots, "SIE de Paris 2e");
  // Marqueur commun à la voie texte.
  assert.ok(result.summary.endsWith(" (DocIE)"), result.summary);
});

test("attestation scannée : DocIE JAMAIS sollicité, analyse locale et cause nommée", async () => {
  let appels = 0;
  let locaux = 0;
  const extractText = async () => { appels++; throw new Error("jamais appelé : scan"); };
  const analyzeLocal = async (b) => { locaux++; return localMarque("local")(b); };
  const body = {
    dataBase64: (await pdfScanne()).toString("base64"),
    mimeType: "application/pdf",
    items: ITEMS,
  };
  const result = await analyzeDocument(body, { env: ENV, extractText, analyzeLocal });
  assert.equal(appels, 0);
  assert.equal(locaux, 1);
  assert.equal(result.summary, "local");
  assert.ok(result.issues.some((i) => /DocIE non sollicité/.test(i)), JSON.stringify(result.issues));
});

test("flag off : fiscale reste 100% locale, le pont n'est pas touché", async () => {
  let locaux = 0;
  const extractText = async () => { throw new Error("le pont ne doit pas être appelé (flag off)"); };
  const analyzeLocal = async (b) => { locaux++; return localMarque("local")(b); };
  const body = {
    dataBase64: (await pdfTexte()).toString("base64"),
    mimeType: "application/pdf",
    items: ITEMS,
  };
  const result = await analyzeDocument(body, { env: {}, extractText, analyzeLocal });
  assert.equal(locaux, 1);
  assert.equal(result.summary, "local");
});
