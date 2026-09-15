"use strict";
// Câblage de la voie TEXTE pour l'attestation de vigilance URSSAF — issue #170.
//
// Aucun appel réseau réel : soit le bridge est stubbé (deps.extractText), soit
// il est exercé POUR DE VRAI avec fetchImpl mocké, ce qui fait passer la
// requête par le vrai extractText (validation du dynamic_schema, en-tête
// x-api-key, parseTextResponse, unwrap) — même politique que
// document-parsing/bridge/tests.
//
// Les PDF de test sont de VRAIS PDF construits avec pdfkit (déjà une
// dépendance de ce module, utilisée par lib/render-pdf.js) : le routage se
// décide sur la couche texte réellement présente dans le fichier, il doit donc
// être mesuré sur un fichier réel, pas sur une chaîne base64 inventée.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const PDFDocument = require("pdfkit");
const {
  analyzeDocument, extractUrssafViaTexte, coucheTexteUtilisable, chargerSchemaUrssaf,
} = require("../lib/docie-extraction");
const { analyzeDocumentLocal } = require("../lib/docanalyze");

const SCHEMA = require(path.join(
  __dirname, "..", "..", "document-parsing", "schemas", "urssaf.schema.json"
));

// --- fabrication de PDF réels -----------------------------------------------
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

// Attestation « texte » : couche texte réelle, portant DEUX dates.
//
// Ce texte est construit pour que les deux origines d'analyse ne donnent PAS
// la même date de délivrance — sinon le test passerait aussi bien sans le
// câblage qu'il est censé prouver. Ce n'est pas une supposition : la valeur
// que l'analyse locale en tire est MESURÉE plus bas, par un appel au vrai
// analyzeDocumentLocal, pas figée dans une constante.
//
// Le mécanisme : docanalyze.js::extractIssuedDate retient d'abord une date
// précédée d'un mot-clé de délivrance, et « à jour au » fait partie de sa
// liste. « Situation a jour au 12/01/2026 » l'emporte donc, alors que la date
// d'édition de l'attestation est « Edition du 04/03/2026 » — forme que sa
// liste de mots-clés ne couvre pas. Un champ de schéma n'a pas ce problème :
// il demande la date de délivrance, pas « une date près d'un mot ».
const TEXTE_ATTESTATION = [
  "URSSAF ILE-DE-FRANCE",
  "ATTESTATION DE VIGILANCE",
  "Cotisant : SUND INDUSTRY SYSTEM",
  "SIRET : 94109131600013",
  "Situation a jour au 12/01/2026",
  "Code de securite : A1B2C3D4E5",
  "Edition du 04/03/2026 - a verifier sur urssaf.fr",
].join("\n");

function pdfTexte() {
  return pdf((doc) => doc.fontSize(11).text(TEXTE_ATTESTATION));
}
// Attestation « scannée » : aucune couche texte, uniquement un rectangle.
function pdfScanne() {
  return pdf((doc) => doc.rect(50, 50, 300, 200).fill("#cccccc"));
}
// Deux pages, la seconde muette : le cas exact que le garde structurel doit
// attraper (texte amputé => extraction confiante et fausse).
function pdfTexteEtPageMuette() {
  return pdf((doc) => {
    doc.fontSize(11).text(TEXTE_ATTESTATION);
    doc.addPage().rect(50, 50, 300, 200).fill("#cccccc");
  });
}

const ENV = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example", DOCIE_API_KEY: "cle-test" };
const ITEMS = [{ id: "urssaf", label: "L'attestation de vigilance URSSAF" }];

// Réponse DocIE plate (POST /v1/extract/text), forme mesurée — cf.
// document-parsing/bridge/tests/contract_text.json.
function reponseDocie(issuedDate) {
  return {
    request_id: "req-test-urssaf",
    schema_name: "urssaf",
    model_profile: "lfm2.5-2.6b",
    result: {
      document_type: "urssaf",
      extraction_notes: [],
      company_name: { value: "SUND INDUSTRY SYSTEM", evidence_ids: ["b1"], confidence: 0.98 },
      siren: { value: "941091316", evidence_ids: ["b1"], confidence: 0.97 },
      siret: { value: "94109131600013", evidence_ids: ["b1"], confidence: 0.97 },
      issued_date: { value: issuedDate, evidence_ids: ["b2"], confidence: 0.95 },
      valid_until: { value: null, evidence_ids: [], confidence: 0 },
      security_code: { value: "A1B2C3D4E5", evidence_ids: ["b3"], confidence: 0.9 },
      urssaf_agency: { value: "URSSAF Ile-de-France", evidence_ids: ["b1"], confidence: 0.9 },
      registered_address: null,
      employee_count: null,
      declared_payroll: null,
    },
    validation: { valid: true, errors: [], warnings: [] },
    latency_ms: 4242,
  };
}

// Analyse locale marquée, pour reconnaître le repli dans les tests de bascule.
// Les tests qui comparent les DEUX origines n'utilisent pas ce faux-là : ils
// appellent le vrai analyzeDocumentLocal.
function localQuiEchoue(tag) {
  return async () => ({
    documentType: "Attestation de vigilance URSSAF", matchedId: "urssaf", isValid: true,
    issuedDate: "", companyName: null, nameMatches: null, issues: [],
    summary: tag || "local",
  });
}

// ---------------------------------------------------------------------------
// 1) Le départage se fait à l'exécution, sur le document reçu
// ---------------------------------------------------------------------------

test("routage : un PDF à couche texte est utilisable, un scan ne l'est pas, une image non plus", async () => {
  const texte = await coucheTexteUtilisable(await pdfTexte(), "application/pdf");
  assert.equal(texte.ok, true);
  assert.match(texte.texte, /ATTESTATION DE VIGILANCE/);

  const scan = await coucheTexteUtilisable(await pdfScanne(), "application/pdf");
  assert.equal(scan.ok, false);
  assert.match(scan.raison, /sans texte|scan/i);

  const mixte = await coucheTexteUtilisable(await pdfTexteEtPageMuette(), "application/pdf");
  assert.equal(mixte.ok, false, "une page muette suffit : un texte amputé produirait une date fausse et confiante");
  assert.match(mixte.raison, /page 2/);

  const image = await coucheTexteUtilisable(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
  assert.equal(image.ok, false);
  assert.match(image.raison, /pas un PDF/);

  const casse = await coucheTexteUtilisable(Buffer.from("pas un pdf du tout"), "application/pdf");
  assert.equal(casse.ok, false);
  assert.match(casse.raison, /illisible|sans page/);
});

test("attestation scannée : DocIE n'est JAMAIS sollicité, analyse locale + cause nommée", async () => {
  let appels = 0;
  const extractText = async () => { appels++; throw new Error("jamais appelé sur un scan"); };
  const analyzeLocal = localQuiEchoue("local-scan");
  const body = { dataBase64: (await pdfScanne()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal, extractText });
  assert.equal(appels, 0, "un texte vide ne doit jamais partir sur le réseau");
  assert.equal(res.summary, "local-scan");
  const avert = res.issues.find((i) => i.startsWith("DocIE non sollicité"));
  assert.ok(avert, res.issues.join(" | "));
  assert.match(avert, /OCR requis|sans texte/);
  // Avertissement DISTINCT de celui d'un échec d'extraction : les deux ne se
  // corrigent pas de la même façon.
  assert.ok(!res.issues.some((i) => i.includes("Extraction DocIE indisponible")));
});

test("image déposée pour l'URSSAF : local, sans OCR de routage ni appel DocIE", async () => {
  let appels = 0;
  const extractText = async () => { appels++; throw new Error("jamais appelé sur une image"); };
  const body = { dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
    mimeType: "image/png", items: ITEMS };
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localQuiEchoue("local-image"), extractText });
  assert.equal(appels, 0);
  assert.equal(res.summary, "local-image");
  assert.ok(res.issues.some((i) => i.includes("DocIE non sollicité") && i.includes("image")));
});

// ---------------------------------------------------------------------------
// 2) Le vrai bridge, couche HTTP simulée
// ---------------------------------------------------------------------------

test("PDF texte : le VRAI bridge poste le texte lu localement + la définition du schéma", async () => {
  const requetes = [];
  const fetchImpl = async (url, options) => {
    requetes.push({ url, headers: options.headers, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify(reponseDocie("2026-03-04")), { status: 200 });
  };
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf",
    items: ITEMS, expectedName: "Sund Industry System" };
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localQuiEchoue(), fetchImpl });

  assert.equal(requetes.length, 1);
  const { url, headers, payload } = requetes[0];
  assert.equal(url, "https://docie.example/v1/extract/text");
  assert.equal(headers["x-api-key"], "cle-test");
  assert.equal(headers.Authorization, undefined);
  assert.equal(payload.schema_name, "urssaf");
  assert.equal(payload.schema_mode, "dynamic");
  // LE point de #170 : la définition du schéma part avec la requête.
  assert.deepEqual(payload.dynamic_schema, SCHEMA);
  assert.deepEqual(payload.dynamic_schema, chargerSchemaUrssaf());
  // C'est bien le texte réellement extrait du PDF qui part, pas le PDF.
  assert.match(payload.text, /ATTESTATION DE VIGILANCE/);
  assert.match(payload.text, /Edition du 04\/03\/2026/);
  assert.ok(!payload.text.includes("%PDF"));

  assert.equal(res.documentType, "Attestation de vigilance URSSAF");
  assert.equal(res.matchedId, "urssaf");
  assert.equal(res.nameMatches, true);
  assert.equal(res.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(res.summary, "Attestation de vigilance URSSAF — délivré le 2026-03-04 (DocIE)");
  assert.equal(res.codeSecurite, "A1B2C3D4E5");
  assert.equal(res.organismeUrssaf, "URSSAF Ile-de-France");
});

test("échec DocIE sur la voie texte : repli local, cause nommée, forme préservée", async () => {
  const b64 = (await pdfTexte()).toString("base64");
  const body = { dataBase64: b64, mimeType: "application/pdf", items: ITEMS };
  for (const [fetchImpl, motif] of [
    [async () => new Response("{}", { status: 500 }), /upstream/],
    [async () => new Response("{}", { status: 401 }), /auth/],
    [async () => new Response("pas du json", { status: 200 }), /response/],
    [async () => { throw new Error("réseau coupé"); }, /network/],
  ]) {
    const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localQuiEchoue("local-repli"), fetchImpl });
    assert.equal(res.summary, "local-repli");
    const avert = res.issues.find((i) => i.startsWith("Extraction DocIE indisponible"));
    assert.ok(avert, res.issues.join(" | "));
    assert.match(avert, motif);
  }
});

test("configuration DocIE absente : repli local, jamais une page cassée", async () => {
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  const fetchImpl = async () => { throw new Error("ne doit pas être atteint sans configuration"); };
  const res = await analyzeDocument(body, { env: { DOCIE_EXTRACTION_ENABLED: "true" },
    analyzeLocal: localQuiEchoue("local-sans-config"), fetchImpl });
  assert.equal(res.summary, "local-sans-config");
  assert.ok(res.issues.some((i) => i.includes("Extraction DocIE indisponible (configuration)")));
});

// ---------------------------------------------------------------------------
// 3) Le vrai gain : la validité 6 mois suit la date DocIE, pas la regex
// ---------------------------------------------------------------------------

// Port exact de l'arithmétique de public/app.js::renderChecklistDocResult
// (lignes « limit.setMonth(limit.getMonth() + 6) » puis « days »), pour
// mesurer le verdict que l'utilisateur verra sur la valeur produite ici.
function verdictChecklist(issuedDate, aujourdhui) {
  const dd = new Date(issuedDate);
  if (isNaN(dd)) return "illisible";
  const limit = new Date(dd);
  limit.setMonth(limit.getMonth() + 6);
  const days = Math.round((limit - new Date(aujourdhui)) / 86400000);
  if (days < 0) return "perime";
  if (days <= 30) return "bientot";
  return "valable";
}

test("validité 6 mois : le verdict suit la date DocIE et PAS la date que la regex locale choisit", async () => {
  const b64 = (await pdfTexte()).toString("base64");
  const body = { dataBase64: b64, mimeType: "application/pdf", items: ITEMS, expectedName: "Sund Industry System" };

  // MESURE, pas hypothèse : ce que le VRAI analyzeDocumentLocal tire de ce
  // même PDF. Si docanalyze.js change d'avis un jour, ce test le dira au lieu
  // de continuer à comparer à une constante périmée.
  const local = await analyzeDocumentLocal(body);
  assert.equal(local.issuedDate, "2026-01-12", "la regex retient « a jour au », pas la date d'edition");

  // DocIE lit le champ issued_date du schéma : la date d'édition, 2026-03-04.
  const fetchImpl = async () => new Response(JSON.stringify(reponseDocie("2026-03-04")), { status: 200 });
  const res = await analyzeDocument(body, { env: ENV, fetchImpl });
  assert.equal(res.issuedDate, "2026-03-04");
  assert.notEqual(res.issuedDate, local.issuedDate, "sinon ce test passerait aussi sans ce câblage");

  // Au 20 août 2026, les deux dates ne donnent PAS le même verdict : la date
  // regex (limite 12/07/2026) est périmée, la date DocIE (limite 04/09/2026)
  // ne l'est pas. C'est très exactement l'erreur que ce câblage supprime — et
  // une date fausse de deux mois ne se voit pas à l'œil, contrairement à un
  // montant aberrant.
  assert.equal(verdictChecklist(local.issuedDate, "2026-08-20"), "perime");
  assert.equal(verdictChecklist(res.issuedDate, "2026-08-20"), "bientot");
  assert.equal(verdictChecklist(res.issuedDate, "2026-06-01"), "valable");
  assert.equal(verdictChecklist(res.issuedDate, "2026-10-01"), "perime");
});

test("le repli local rend bien, lui, la date de la regex — les deux chemins restent distincts", async () => {
  const body = { dataBase64: (await pdfScanne()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  // Scan : DocIE n'est pas sollicité, c'est le vrai analyzeDocumentLocal qui
  // répond. Sur un PDF sans texte il annonce « Document illisible », et la
  // validité 6 mois n'est alors calculable par personne — comportement
  // d'aujourd'hui, inchangé, plus la cause nommée.
  const res = await analyzeDocument(body, { env: ENV, extractText: async () => { throw new Error("jamais"); } });
  assert.equal(res.documentType, "Document");
  assert.equal(res.issuedDate, "");
  assert.ok(res.issues.some((i) => i.startsWith("DocIE non sollicité")));
});

test("validité 6 mois : une date DocIE impossible vide le champ au lieu d'en fabriquer une", async () => {
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf", items: ITEMS };
  // 30 février : reconnue par le motif, refusée par le calendrier (#179 A8/A9).
  const fetchImpl = async () => new Response(JSON.stringify(reponseDocie("30/02/2026")), { status: 200 });
  const res = await analyzeDocument(body, { env: ENV, analyzeLocal: localQuiEchoue(), fetchImpl });
  assert.equal(res.issuedDate, "");
  assert.ok(res.issues.includes("Date de délivrance non trouvée dans le document."));
  assert.equal(res.summary, "Attestation de vigilance URSSAF (DocIE)");
  // Les champs bel et bien lus ne sont pas jetés pour autant.
  assert.equal(res.companyName, "SUND INDUSTRY SYSTEM");
});

test("extractUrssafViaTexte : ne renvoie jamais d'analyse sans avoir eu du texte à envoyer", async () => {
  const extractText = async () => { throw new Error("ne doit pas être appelé"); };
  const { analysis, raisonRepli } = await extractUrssafViaTexte(
    { dataBase64: (await pdfScanne()).toString("base64"), mimeType: "application/pdf", items: ITEMS },
    { env: ENV, extractText }
  );
  assert.equal(analysis, null);
  assert.ok(raisonRepli);
  await assert.rejects(extractUrssafViaTexte({}, { env: ENV, extractText }), /Aucun fichier reçu/);
});

test("clé SIREN/SIRET (#194) : le verdict traverse analyzeDocument jusqu'à la réponse, sans rien vider", async () => {
  // Chemin de production réel : PDF texte, vrai bridge (fetchImpl simulé),
  // mapUrssafDocieResult. docie-extraction.js ne garde que `analysis` : le
  // verdict et le message doivent donc y être, pas seulement dans `warnings`.
  const { messagesSirenSiret, controlerSirenSiret } = require("../lib/siren-siret");
  const body = { dataBase64: (await pdfTexte()).toString("base64"), mimeType: "application/pdf",
    items: ITEMS, expectedName: "Sund Industry System" };

  const juste = await analyzeDocument(body, { env: ENV, analyzeLocal: localQuiEchoue(),
    fetchImpl: async () => new Response(JSON.stringify(reponseDocie("2026-03-04")), { status: 200 }) });
  assert.equal(juste.controleSirenSiret.siren.statut, "valide");
  assert.equal(juste.controleSirenSiret.siret.statut, "valide");
  assert.deepEqual(juste.issues, []);

  const reponse = reponseDocie("2026-03-04");
  reponse.result.siren.value = "123456789"; // somme de Luhn 47 : clé fausse
  const faux = await analyzeDocument(body, { env: ENV, analyzeLocal: localQuiEchoue(),
    fetchImpl: async () => new Response(JSON.stringify(reponse), { status: 200 }) });
  assert.equal(faux.summary, "Attestation de vigilance URSSAF — délivré le 2026-03-04 (DocIE)");
  assert.equal(faux.siren, "123456789");
  assert.equal(faux.isValid, true);
  assert.equal(faux.controleSirenSiret.siren.statut, "cle_invalide");
  assert.equal(faux.controleSirenSiret.siret.statut, "valide");
  assert.deepEqual(faux.issues, messagesSirenSiret(controlerSirenSiret("123456789", "94109131600013")).map((m) => m.message));
  assert.deepEqual(faux.issues,
    ["SIREN « 123456789 » : clé de contrôle invalide, chiffre probablement mal lu — valeur conservée, à vérifier sur le document"]);
});

test("le schéma embarqué est bien celui du dépôt, chargé depuis document-parsing/schemas", () => {
  assert.deepEqual(chargerSchemaUrssaf(), SCHEMA);
  assert.equal(SCHEMA.document_type, "urssaf");
});
