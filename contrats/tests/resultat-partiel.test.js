"use strict";
// Résultat partiel visible dans contrats (#203, #194), sur toutes les voies
// DocIE : pré-remplissage de contrat (agent et texte), URSSAF, RIB, Kbis.
//
// Serveur : DocIE simulé à la frontière fetch du VRAI bridge (les chaînes
// d'avertissement sont celles de document-parsing/fixtures/avertissements_docie.json,
// reconnues par le bridge lui-même), vrais PDF pdfkit. Navigateur : fonctions
// RÉELLES de public/app.js dans un bac à sable vm, module pur
// public/import-champs.js chargé tel quel.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const PDFDocument = require("pdfkit");

const CHAMPS = require("../public/import-champs");
const { analyzeDocument, signauxPartielsPublics } = require("../lib/docie-extraction");
const { extractContractValues } = require("../lib/docie-contract-import");
const { RAISONS_PARTIEL } = require("../../document-parsing/bridge/docie-bridge");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const RAW_CONTRAT = require(path.join(__dirname, "..", "..", "document-parsing", "mappings", "fixtures", "contract_extraction_sample.json"));

function extraireFonction(nom) {
  const debut = APP_JS.search(new RegExp("(async )?function " + nom + "\\("));
  assert.ok(debut !== -1, nom + " introuvable dans app.js");
  const reste = APP_JS.slice(debut);
  const m = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(m, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, m.index + m[0].length);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// Une chaîne DocIE par raison, sur un champ réel de chaque schéma (libellés de
// la fixture partagée, seul le nom de champ change).
const W = {
  boucle: (c) => c + ": model output repeated itself (AB AB); list truncated at the loop start, remaining items dropped; confidence capped to 0.5 as a review flag",
  valeur_abandonnee: (c) => c + ": 12,5 k is not a number; value dropped",
  forme_invalide: (c) => c + ": the model wrote {'a': 1} in a shape this field cannot hold; nothing was kept",
  feuille_abandonnee: (c) => c + ": Input should be a valid string; dropped",
};
const CENT = Array.from({ length: 100 }, (_, i) => "note " + i);

const BASE = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test", DOCIE_API_KEY: "cle-test" };

function pdf(texte) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.fontSize(9).text(texte);
    doc.end();
  });
}
function docie(corps) {
  const appels = [];
  return { appels, fetchImpl: async (url, options) => { appels.push({ url, corps: JSON.parse(options.body) }); return new Response(JSON.stringify(corps), { status: 200 }); } };
}
const champ = (value) => ({ value, evidence_ids: ["b1"], confidence: 0.9 });
function localInterdit() {
  return async () => { throw new Error("analyse locale inattendue"); };
}

// ---------------------------------------------------------------------------
// Serveur : normalisation
// ---------------------------------------------------------------------------

test("signauxPartielsPublics : métadonnées absentes ou illisibles -> aucune clé, jamais d'exception", () => {
  for (const m of [undefined, null, 42, "x", {}, { partiel: "boucle" }, { partiel: [null, 1, { champ: 3, raison: "boucle" }, { champ: "", raison: "boucle" }, { champ: "iban" }] },
    { partiel: [], troncature_possible: false }, { troncature_possible: null }, { troncature_possible: "true" }]) {
    assert.deepEqual(signauxPartielsPublics(m), {}, JSON.stringify(m));
  }
});

test("signauxPartielsPublics : chaque raison du bridge gardée, raison inconnue gardée, troncature seulement si true, clé contrats par racine", () => {
  const partiel = [...RAISONS_PARTIEL, "raison_future"].map((raison, i) => ({ champ: "c" + i, raison }));
  assert.deepEqual(signauxPartielsPublics({ partiel, troncature_possible: true }), { partiel, troncaturePossible: true });
  const cles = { tjm: "tjm", st_siren: "stSiren" };
  assert.deepEqual(signauxPartielsPublics({ partiel: [{ champ: "tjm.amount", raison: "feuille_abandonnee" }, { champ: "st_siren", raison: "boucle" }, { champ: "extraction_notes", raison: "liste_plafonnee_possible" }] }, { cles }).partiel,
    [{ champ: "tjm.amount", raison: "feuille_abandonnee", cle: "tjm" }, { champ: "st_siren", raison: "boucle", cle: "stSiren" }, { champ: "extraction_notes", raison: "liste_plafonnee_possible" }]);
});

test("messages français : exactement une entrée par raison du bridge", () => {
  assert.deepEqual(Object.keys(CHAMPS.MESSAGES_PARTIEL).sort(), [...RAISONS_PARTIEL].sort());
});

// ---------------------------------------------------------------------------
// Serveur : chaque surface, bridge réel
// ---------------------------------------------------------------------------

const TEXTE_URSSAF = "URSSAF ILE-DE-FRANCE\nATTESTATION DE VIGILANCE\nSUND INDUSTRY SYSTEM\nEdition du 04/03/2026";
const reponseUrssaf = (warnings, notes = []) => ({
  request_id: "u", schema_name: "urssaf", model_profile: "lfm2.5-2.6b",
  result: { document_type: "urssaf", extraction_notes: notes, company_name: champ("SUND INDUSTRY SYSTEM"), issued_date: champ(null) },
  validation: { valid: true, errors: [], warnings },
});
const ITEMS_URSSAF = [{ id: "urssaf", label: "URSSAF" }];

test("URSSAF (voie texte, sans choix) : les quatre raisons à libellé et la liste de 100 arrivent dans l'analyse", async () => {
  const warnings = [W.boucle("company_name"), W.valeur_abandonnee("declared_payroll"), W.forme_invalide("issued_date"), W.feuille_abandonnee("siren")];
  const { fetchImpl } = docie(reponseUrssaf(warnings, CENT));
  const body = { mimeType: "application/pdf", dataBase64: (await pdf(TEXTE_URSSAF)).toString("base64"), items: ITEMS_URSSAF };
  const res = await analyzeDocument(body, { env: BASE, fetchImpl, analyzeLocal: localInterdit() });
  assert.deepEqual(res.partiel, [
    { champ: "company_name", raison: "boucle" }, { champ: "declared_payroll", raison: "valeur_abandonnee" },
    { champ: "issued_date", raison: "forme_invalide" }, { champ: "siren", raison: "feuille_abandonnee" },
    { champ: "extraction_notes", raison: "liste_plafonnee_possible" },
  ]);
  assert.equal(Object.hasOwn(res, "troncaturePossible"), false);
});

test("URSSAF (voie texte, sans choix) : 801 lignes non vides -> troncaturePossible ; avec un modèle LFM choisi, refus `limite` avant tout appel", async () => {
  const long = TEXTE_URSSAF + "\n" + Array.from({ length: 800 }, (_, i) => "ligne " + i).join("\n");
  const dataBase64 = (await pdf(long)).toString("base64");
  const { fetchImpl, appels } = docie(reponseUrssaf([]));
  const res = await analyzeDocument({ mimeType: "application/pdf", dataBase64, items: ITEMS_URSSAF }, { env: BASE, fetchImpl, analyzeLocal: localInterdit() });
  assert.ok(appels[0].corps.text.split("\n").filter((l) => l.trim()).length > 800, "précondition : plus de 800 lignes envoyées");
  assert.equal(res.troncaturePossible, true);
  assert.equal(Object.hasOwn(res, "partiel"), false);
  const env = { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
  await assert.rejects(() => analyzeDocument({ mimeType: "application/pdf", dataBase64, items: ITEMS_URSSAF, modele: "lfm25_2_6b" }, { env, fetchImpl, analyzeLocal: localInterdit() }),
    (e) => e.code === "limite");
  assert.equal(appels.length, 1);
});

test("RIB (voie texte, modèle choisi) : `partiel` à côté du modèle servi et du contrôle IBAN/BIC", async () => {
  const env = { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
  const { fetchImpl } = docie({
    request_id: "r", schema_name: "rib", model_profile: "lfm2.5-2.6b",
    result: { document_type: "rib", extraction_notes: [], account_holder: champ("SUND INDUSTRY SYSTEM"), iban: champ(null), bic: champ("BNPAFRPP"), bank_name: champ(null) },
    validation: { valid: true, errors: [], warnings: [W.forme_invalide("iban")] },
  });
  const texte = "RELEVE D'IDENTITE BANCAIRE\nTitulaire : SUND INDUSTRY SYSTEM\nIBAN : FR14 2004 1010 0505 0001 3M02 606";
  const res = await analyzeDocument({ mimeType: "application/pdf", dataBase64: (await pdf(texte)).toString("base64"), items: [{ id: "rib" }], modele: "lfm25_2_6b" },
    { env, fetchImpl, analyzeLocal: localInterdit() });
  assert.deepEqual(res.partiel, [{ champ: "iban", raison: "forme_invalide" }]);
  assert.deepEqual(res.modele, { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
  assert.equal(res.controleIbanBic.iban.statut, "absent");
});

test("Kbis (voie agent) : `partiel` lu dans docie_agent.validation ; jamais de troncature (non mesurable)", async () => {
  const env = { ...BASE, DOCIE_AGENT_KBIS: "agent-kbis" };
  const result = { document_type: "kbis", company_name: "ACME CONSEIL", siren: "123456789", legal_form: null, issued_date: "2026-03-01" };
  const { fetchImpl, appels } = docie({
    id: "chat-kbis", model: "agent-kbis",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
    docie_agent: { agent: "agent-kbis", schema_name: "kbis", validation: { valid: true, errors: [], warnings: [W.feuille_abandonnee("legal_form")] } },
  });
  const res = await analyzeDocument({ mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64"), items: [{ id: "kbis" }], expectedName: "ACME Conseil" },
    { env, fetchImpl, analyzeLocal: localInterdit() });
  assert.match(appels[0].url, /\/v1\/agents\/agent-kbis\/chat\/completions$/);
  assert.deepEqual(res.partiel, [{ champ: "legal_form", raison: "feuille_abandonnee" }]);
  assert.equal(Object.hasOwn(res, "troncaturePossible"), false);
});

test("contrat (agent, sans choix) : `partiel` avec la clé contrats ; (texte, NuExtract3 choisi, 801 lignes) : troncaturePossible", async () => {
  const agent = docie({
    id: "chat-1", model: "agent-contrat",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(RAW_CONTRAT.result) } }],
    docie_agent: { agent: "agent-contrat", validation: { valid: true, errors: [], warnings: [W.valeur_abandonnee("tjm"), W.boucle("st_siren")] } },
  });
  const a = await extractContractValues({ mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    { env: { ...BASE, DOCIE_AGENT_CONTRACT: "agent-contrat" }, fetchImpl: agent.fetchImpl });
  assert.deepEqual(a.partiel, [{ champ: "tjm", raison: "valeur_abandonnee", cle: "tjm" }, { champ: "st_siren", raison: "boucle", cle: "stSiren" }]);
  assert.equal(Object.hasOwn(a, "troncaturePossible"), false);
  assert.equal(Object.hasOwn(a, "modele"), false);

  const texte = docie({ request_id: "t", schema_name: "contract", model_profile: "nuextract3", result: RAW_CONTRAT.result, validation: { valid: true, errors: [], warnings: [] } });
  const t = await extractContractValues({ mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64"), modele: "nuextract3" },
    { env: { ...BASE, DOCIE_MODELE_NUEXTRACT3: "store:nuextract3" }, fetchImpl: texte.fetchImpl, coucheTexteUtilisable: async () => ({ ok: true, texte: "Clause\n".repeat(801) }) });
  assert.equal(t.troncaturePossible, true);
  assert.equal(Object.hasOwn(t, "partiel"), false);
  assert.deepEqual(t.modele, { id: "nuextract3", libelle: "NuExtract3" });
});

test("métadonnées absentes (réponse d'avant #203, bridge simulé) et analyse locale : sortie inchangée, aucune clé ajoutée", async () => {
  const sansMeta = { result: reponseUrssaf([]).result, metadata: { validation: { valid: true, errors: [], warnings: [] } } };
  const body = { mimeType: "application/pdf", dataBase64: (await pdf(TEXTE_URSSAF)).toString("base64"), items: ITEMS_URSSAF };
  const res = await analyzeDocument(body, { env: BASE, extractText: async () => sansMeta, analyzeLocal: localInterdit() });
  assert.equal(Object.hasOwn(res, "partiel") || Object.hasOwn(res, "troncaturePossible"), false);
  const nul = await analyzeDocument(body, { env: BASE, extractText: async () => ({ result: sansMeta.result, metadata: null }), analyzeLocal: localInterdit() });
  assert.equal(Object.hasOwn(nul, "partiel") || Object.hasOwn(nul, "troncaturePossible"), false);
  const local = await analyzeDocument({ ...body, items: ITEMS_URSSAF }, { env: {}, analyzeLocal: async () => ({ documentType: "Local", issues: [] }) });
  assert.deepEqual(local, { documentType: "Local", issues: [] });
  const contrat = await extractContractValues({ mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    { env: BASE, extractDocument: async () => ({ result: RAW_CONTRAT.result }) });
  assert.equal(Object.hasOwn(contrat, "partiel") || Object.hasOwn(contrat, "troncaturePossible"), false);
});

// ---------------------------------------------------------------------------
// Navigateur : module pur
// ---------------------------------------------------------------------------

test("lignesPartiel : une ligne nommée par champ et par raison, sur chaque pièce ; troncature ; raison inconnue affichée", () => {
  for (const raison of RAISONS_PARTIEL) {
    assert.deepEqual(CHAMPS.lignesPartiel({ partiel: [{ champ: "iban", raison }], troncaturePossible: false }, "rib"),
      ["Résultat partiel — IBAN : " + CHAMPS.MESSAGES_PARTIEL[raison]]);
  }
  assert.deepEqual(CHAMPS.lignesPartiel({ partiel: [{ champ: "issued_date", raison: "boucle" }], troncaturePossible: true }, "urssaf"),
    ["Résultat partiel — Date de délivrance : " + CHAMPS.MESSAGES_PARTIEL.boucle, CHAMPS.LIGNE_TRONCATURE]);
  assert.ok(CHAMPS.LIGNE_TRONCATURE.toLowerCase().includes("document peut-être tronqué (> 800 lignes)"));
  assert.deepEqual(CHAMPS.lignesPartiel({ partiel: [{ champ: "legal_form", raison: "feuille_abandonnee" }], troncaturePossible: false }, "kbis"),
    ["Résultat partiel — Forme juridique : " + CHAMPS.MESSAGES_PARTIEL.feuille_abandonnee]);
  assert.deepEqual(CHAMPS.lignesPartiel({ partiel: [{ champ: "tjm.amount", raison: "feuille_abandonnee", cle: "tjm" }, { champ: "extraction_notes", raison: "raison_future" }], troncaturePossible: false }, "contract"),
    ["Résultat partiel — TJM (€ HT / jour) (tjm.amount) : " + CHAMPS.MESSAGES_PARTIEL.feuille_abandonnee,
      "Résultat partiel — champ « extraction_notes » : " + CHAMPS.MESSAGE_PARTIEL_INCONNU + " (raison_future)"]);
  for (const d of [null, undefined, {}, { partiel: "x" }, { partiel: [null, { champ: 1, raison: "boucle" }] }, { troncaturePossible: "true" }]) {
    assert.equal(CHAMPS.signauxPartiels(d), null, JSON.stringify(d));
    assert.deepEqual(CHAMPS.lignesPartiel(CHAMPS.signauxPartiels(d), "rib"), []);
  }
});

test("libellés des 7 champs principaux : ceux du modal (index.html)", () => {
  for (const [cle, id] of CHAMPS.CHAMPS_PRINCIPAUX) {
    const libelle = CHAMPS.LIBELLES_PRINCIPAUX[cle];
    assert.ok(libelle, cle);
    const m = new RegExp("<label[^>]*>([^<]*)<input id=\"" + id + "\"").exec(INDEX_HTML);
    assert.ok(m, id);
    assert.equal(m[1].replace(/\s*\*$/, "").trim(), libelle, id);
  }
  assert.equal(CHAMPS.IDS_CHAMPS.length, 19);
});

// ---------------------------------------------------------------------------
// Navigateur : checklist (URSSAF, RIB, Kbis)
// ---------------------------------------------------------------------------

function faux(extra = {}) {
  return Object.assign({ className: "", textContent: "", enfants: [], appendChild(e) { this.enfants.push(e); } }, extra);
}
function rendrePartiel(res, piece, depart = { className: "chk-doc-status ok", textContent: "✅ verdict" }) {
  const ctx = { CONTRATS_IMPORT_CHAMPS: CHAMPS, document: { createElement: () => faux() } };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("renderResultatPartiel"), ctx);
  const el = faux(depart);
  ctx.renderResultatPartiel(el, res, piece);
  return { el, lignes: el.enfants.map((e) => [e.className, e.textContent]) };
}

test("checklist sans choix : lignes ajoutées sous le verdict, verdict intact (URSSAF, RIB, Kbis)", () => {
  const u = rendrePartiel({ partiel: [{ champ: "issued_date", raison: "forme_invalide" }], troncaturePossible: true }, "urssaf");
  assert.equal(u.el.className, "chk-doc-status ok");
  assert.equal(u.el.textContent, "✅ verdict");
  assert.deepEqual(u.lignes, [
    ["chk-date-status warn", "⚠ Résultat partiel — Date de délivrance : " + CHAMPS.MESSAGES_PARTIEL.forme_invalide],
    ["chk-date-status warn", "⚠ " + CHAMPS.LIGNE_TRONCATURE],
  ]);
  const r = rendrePartiel({ partiel: [{ champ: "iban", raison: "boucle" }] }, "rib");
  assert.equal(r.el.textContent, "✅ verdict");
  assert.deepEqual(r.lignes, [["chk-date-status warn", "⚠ Résultat partiel — IBAN : " + CHAMPS.MESSAGES_PARTIEL.boucle]]);
  // Kbis (#194, sélecteur par type d'entrée) : un champ HORS verdict, même avec
  // un modèle choisi, n'ajoute que la ligne ; le cas bloquant est testé à part.
  const k = rendrePartiel({ partiel: [{ champ: "legal_form", raison: "liste_plafonnee_possible" }], choixModele: true }, "kbis");
  assert.equal(k.el.textContent, "✅ verdict", "Kbis : champ hors verdict, verdict intact");
  assert.equal(k.lignes.length, 1);
  const kSansChoix = rendrePartiel({ partiel: [{ champ: "siren", raison: "liste_plafonnee_possible" }] }, "kbis");
  assert.equal(kSansChoix.el.textContent, "✅ verdict", "Kbis sans choix : jamais bloquant");
});

test("checklist, modèle choisi : champ du verdict perdu -> ⛔ « lecture non retenue » ; champ hors verdict, autre société ou troncature seule -> verdict intact", () => {
  const u = rendrePartiel({ partiel: [{ champ: "issued_date", raison: "feuille_abandonnee" }], choixModele: true }, "urssaf");
  assert.equal(u.el.className, "chk-doc-status err");
  assert.equal(u.el.textContent, "⛔ Lecture non retenue — résultat partiel du modèle choisi sur : Date de délivrance (à vérifier sur le document)");
  assert.equal(u.lignes.length, 1);
  const r = rendrePartiel({ partiel: [{ champ: "iban", raison: "forme_invalide" }, { champ: "bic", raison: "boucle" }], choixModele: true, modele: { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" } }, "rib");
  assert.equal(r.el.textContent, "⛔ Lecture non retenue — résultat partiel du modèle choisi sur : IBAN, BIC (à vérifier sur le document) — lu par LFM2.5 2.6B");
  for (const [res, piece] of [
    [{ partiel: [{ champ: "bank_name", raison: "boucle" }], choixModele: true }, "rib"],
    [{ partiel: [{ champ: "declared_payroll", raison: "valeur_abandonnee" }], choixModele: true }, "urssaf"],
    [{ partiel: [{ champ: "issued_date", raison: "boucle" }], choixModele: true, nameMatches: false }, "urssaf"],
    [{ troncaturePossible: true, choixModele: true }, "urssaf"],
  ]) {
    const x = rendrePartiel(res, piece);
    assert.equal(x.el.textContent, "✅ verdict", JSON.stringify(res));
    assert.equal(x.lignes.length, 1);
  }
});

test("checklist, rien à dire (analyse locale, réponse d'avant #203) : aucun effet", () => {
  for (const res of [{}, { partiel: [] }, { troncaturePossible: false, choixModele: true }]) {
    const x = rendrePartiel(res, "urssaf");
    assert.equal(x.el.textContent, "✅ verdict");
    assert.equal(x.lignes.length, 0);
  }
});

test("analyzeChecklistDoc (code réel) : signaux et choix gardés avec le résultat, rendus après le verdict ; réponse sans signal : forme d'avant", async () => {
  async function analyser(itemId, reponse) {
    const ordre = [];
    const ctx = {
      state: { values: { stNom: "" }, dateState: {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => reponse }),
      fileToBase64: async () => "JVBERi0=",
      renderChecklistDocResult: (el) => { ordre.push("verdict"); el.className = "chk-doc-status ok"; el.textContent = "✅ verdict"; },
      renderControleSirenSiret: () => ordre.push("siren"),
      renderPropositionKbis: () => {}, majNoteCoordonnees: () => {},
      CONTRATS_KBIS_CHAMPS: { extraire: () => ({}), controleCompact: () => null },
      CONTRATS_IMPORT_CHAMPS: CHAMPS,
      document: { createElement: () => faux() },
      JSON, Error,
    };
    vm.createContext(ctx);
    vm.runInContext(extraireFonction("analyzeChecklistDoc") + extraireFonction("renderResultatPartiel"), ctx);
    const statusEl = faux({ parentNode: { querySelector: () => null } });
    await ctx.analyzeChecklistDoc({ id: itemId, label: itemId }, { name: "a.pdf", type: "application/pdf" }, statusEl, { textContent: "" });
    return { res: clone(ctx.state.dateState[itemId]), statusEl, ordre };
  }
  const avec = await analyser("urssaf", { issuedDate: "", partiel: [{ champ: "issued_date", raison: "boucle" }], troncaturePossible: true, modele: null });
  assert.deepEqual(avec.res.partiel, [{ champ: "issued_date", raison: "boucle" }]);
  assert.equal(avec.res.troncaturePossible, true);
  assert.equal(avec.res.choixModele, true, "clé `modele` présente même nulle = choix explicite");
  assert.equal(avec.statusEl.className, "chk-doc-status err");
  assert.equal(avec.statusEl.enfants.length, 2);
  assert.deepEqual(avec.ordre, ["verdict", "siren"]);
  const kbis = await analyser("kbis", { issuedDate: "2026-03-01", partiel: [{ champ: "legal_form", raison: "feuille_abandonnee" }] });
  assert.equal(kbis.statusEl.textContent, "✅ verdict");
  assert.deepEqual(kbis.statusEl.enfants.map((e) => e.textContent), ["⚠ Résultat partiel — Forme juridique : " + CHAMPS.MESSAGES_PARTIEL.feuille_abandonnee]);
  const sans = await analyser("urssaf", { issuedDate: "2026-03-01" });
  assert.deepEqual(Object.keys(sans.res).sort(), ["companyName", "fileName", "issuedDate"]);
  assert.equal(["partiel", "troncaturePossible", "choixModele"].some((k) => Object.hasOwn(sans.res, k)), false);
  assert.equal(sans.statusEl.enfants.length, 0);
});

test("analyserRib (code réel) : modèle choisi + IBAN perdu -> ⛔ ; sans choix -> verdict de #209 et ligne ajoutée", async () => {
  async function rib(reponse) {
    const ctx = {
      state: { values: { stNom: "" }, dateState: {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => reponse }),
      fileToBase64: async () => "JVBERi0=",
      CONTRATS_IMPORT_CHAMPS: CHAMPS,
      document: { createElement: () => faux() },
      JSON, Error,
    };
    vm.createContext(ctx);
    vm.runInContext(["analyserRib", "ribRetenu", "renderRibResult", "renderResultatPartiel"].map(extraireFonction).join("\n"), ctx);
    const el = faux();
    await ctx.analyserRib({ id: "rib", label: "RIB" }, { name: "r.pdf", type: "application/pdf" }, el, { textContent: "" });
    return { el, res: clone(ctx.state.dateState.rib) };
  }
  const base = { companyName: "X", nameMatches: null, titulaireCompte: "X", iban: "FR14 2004 1010 0505 0001 3M02 606", bic: "BNPAFRPP", nomBanque: "",
    issues: [], controleIbanBic: { iban: { statut: "valide" }, bic: { statut: "valide" } } };
  const choisi = await rib({ ...base, partiel: [{ champ: "iban", raison: "forme_invalide" }], modele: { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" } });
  assert.equal(choisi.el.className, "chk-doc-status err");
  assert.ok(choisi.el.textContent.startsWith("⛔ Lecture non retenue — résultat partiel du modèle choisi sur : IBAN"));
  assert.equal(choisi.res.choixModele, true);
  const libre = await rib({ ...base, partiel: [{ champ: "iban", raison: "forme_invalide" }] });
  assert.equal(libre.el.className, "chk-doc-status ok");
  assert.ok(libre.el.textContent.startsWith("✅ Titulaire : X"));
  assert.deepEqual(libre.el.enfants.map((e) => e.textContent), ["⚠ Résultat partiel — IBAN : " + CHAMPS.MESSAGES_PARTIEL.forme_invalide]);
  const rien = await rib(base);
  assert.equal(["partiel", "troncaturePossible", "choixModele"].some((k) => Object.hasOwn(rien.res, k)), false);
  assert.equal(rien.el.enfants.length, 0);
});

test("buildChecklist et ajouterAnalyseRib : un résultat gardé est re-rendu avec ses lignes de résultat partiel", () => {
  const debut = APP_JS.indexOf("function buildChecklist(");
  const corps = APP_JS.slice(debut, APP_JS.indexOf("\n}\n", debut));
  assert.ok(/renderChecklistDocResult\(status, saved\);\s*renderResultatPartiel\(status, saved, it\.id\);\s*renderControleSirenSiret\(status, saved\);/.test(corps));
  assert.ok(/renderRibResult\(status, saved\);\s*renderResultatPartiel\(status, saved, it\.id\);/.test(extraireFonction("ajouterAnalyseRib")));
});

// ---------------------------------------------------------------------------
// Navigateur : pré-remplissage de contrat
// ---------------------------------------------------------------------------

function fauxElement(id, extra = {}) {
  const classes = new Set();
  const attributs = {};
  const e = Object.assign({
    id, textContent: "", className: "", value: "", title: "",
    classList: { toggle: (c, oui) => { if (oui) classes.add(c); else classes.delete(c); }, add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => { attributs[k] = String(v); },
    removeAttribute: (k) => { delete attributs[k]; if (k === "title") e.title = ""; },
    getAttribute: (k) => (k in attributs ? attributs[k] : null),
  }, extra);
  return e;
}
const rep = (status, corps) => ({ ok: status >= 200 && status < 300, status, json: async () => corps });

// Modal complet : pré-remplissage puis import, fonctions réelles.
function modal() {
  const elements = {};
  const el = (id, extra) => (elements[id] = fauxElement(id, extra));
  for (const id of CHAMPS.IDS_A_VIDER) el(id);
  for (const id of ["impStatus", "impPreremplirStatus", "impSigneLe"]) el(id);
  el("impPreremplir", { textContent: "🪄", disabled: false });
  el("impFichier", { files: [{ type: "application/pdf" }] });
  el("impType", { value: "sous-traitance" });
  el("impSigne", { checked: false });
  el("importModal");
  el("impAutres", { open: false });
  const file = [];
  const appels = [];
  const avertissements = [];
  const ctx = {
    $: (s) => elements[s.replace(/^#/, "")],
    document: { getElementById: (id) => elements[id] || null },
    fetch: async (url, opts) => { appels.push(url); return file.shift(); },
    setTimeout: (fn) => fn(),
    fileToBase64: async () => "JVBERi0=",
    lirePdf: async () => ({ nom: "c.pdf", dataBase64: "JVBERi0=" }),
    construireAutresChampsImport: () => {},
    afficherAvertissementsImport: (w) => avertissements.push(clone(w)),
    setStatus: () => {}, showView: () => {},
    CONTRATS_IMPORT_CHAMPS: CHAMPS,
    encodeURIComponent, Promise, Error, JSON, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(["marquerChampImport", "marquerChampsImportAVerifier", "preremplirImportDepuisPdf", "validerImport"].map(extraireFonction).join("\n"), ctx);
  return {
    elements, appels, avertissements,
    preremplir: async (resultat) => { file.push(rep(202, { tache: "t" }), rep(200, { etat: "terminee", resultat })); await ctx.preremplirImportDepuisPdf(); },
    importer: async () => { file.push(rep(200, { ok: true })); const n = appels.length; await ctx.validerImport(); return appels.length > n; },
  };
}
const RESULTAT = (extra) => ({ values: { numeroContrat: "01", stNom: "SUND", tjm: "", stSiren: "941091316" }, warnings: ["DocIE validation.warnings: x"], errors: [], ok: true, ...extra });
const PARTIEL_TJM = { partiel: [{ champ: "tjm", raison: "valeur_abandonnee", cle: "tjm" }], troncaturePossible: true };
const marque = (e) => ({ invalid: e.classList.contains("invalid"), title: e.title });

test("contrat sans choix : lignes en tête de liste, ligne d'état ⚠️ qui les nomme, champ marqué, import NON bloqué", async () => {
  const m = modal();
  await m.preremplir(RESULTAT(PARTIEL_TJM));
  const st = m.elements.impPreremplirStatus;
  assert.equal(st.className, "status warn");
  assert.equal(st.textContent, "⚠️ Champs pré-remplis à vérifier — résultat partiel : TJM (€ HT / jour) — document peut-être tronqué (> 800 lignes) (3 avertissements ci-dessous)");
  assert.deepEqual(m.avertissements.at(-1), [
    "Résultat partiel — TJM (€ HT / jour) : " + CHAMPS.MESSAGES_PARTIEL.valeur_abandonnee, CHAMPS.LIGNE_TRONCATURE, "DocIE validation.warnings: x",
  ]);
  assert.deepEqual(marque(m.elements.impTjm), { invalid: true, title: "TJM (€ HT / jour) : résultat partiel, " + CHAMPS.MESSAGES_PARTIEL.valeur_abandonnee });
  assert.equal(m.elements.impTjm.partielBloquant, null);
  assert.equal(await m.importer(), true, "import envoyé");
  assert.equal(m.elements.impStatus.className, "status");
});

test("contrat, modèle choisi : ligne d'état ⛔, import BLOQUÉ tant que le champ perdu n'est pas modifié, puis accepté et démarqué", async () => {
  const m = modal();
  await m.preremplir(RESULTAT({ ...PARTIEL_TJM, modele: { id: "nuextract3", libelle: "NuExtract3" } }));
  const st = m.elements.impPreremplirStatus;
  assert.equal(st.className, "status err");
  assert.equal(st.textContent, "⛔ Résultat partiel du modèle choisi — à ressaisir avant import : TJM (€ HT / jour) (3 avertissements ci-dessous) — lu par NuExtract3");
  assert.equal(await m.importer(), false, "aucun appel d'import");
  assert.equal(m.elements.impStatus.className, "status err");
  assert.equal(m.elements.impStatus.textContent, "Échec : import bloqué — résultat partiel du modèle choisi, champ(s) à ressaisir : TJM (€ HT / jour).");
  assert.equal(marque(m.elements.impTjm).invalid, true);
  m.elements.impTjm.value = "450";
  assert.equal(await m.importer(), true);
  assert.equal(marque(m.elements.impTjm).invalid, false);
  assert.equal(m.elements.impTjm.partielBloquant, null);
});

test("contrat, modèle choisi : partiel ET clé SIREN invalide sur le même champ -> messages joints ; champ non rattaché -> ligne seule ; troncature seule -> non bloquant", async () => {
  const m = modal();
  await m.preremplir(RESULTAT({
    modele: null,
    partiel: [{ champ: "st_siren", raison: "boucle", cle: "stSiren" }, { champ: "extraction_notes", raison: "liste_plafonnee_possible" }],
    controleSirenSiret: { siren: { statut: "cle_invalide" }, siret: { statut: "absent" } },
  }));
  assert.deepEqual(marque(m.elements.impStSiren), { invalid: true, title: "SIREN : " + CHAMPS.MESSAGES_STATUT.cle_invalide + " ; résultat partiel, " + CHAMPS.MESSAGES_PARTIEL.boucle });
  assert.equal(m.elements.impPreremplirStatus.className, "status err");
  assert.ok(m.avertissements.at(-1).includes("Résultat partiel — champ « extraction_notes » : " + CHAMPS.MESSAGES_PARTIEL.liste_plafonnee_possible));
  assert.equal(await m.importer(), false);

  const t = modal();
  await t.preremplir(RESULTAT({ modele: { id: "nuextract3", libelle: "NuExtract3" }, troncaturePossible: true }));
  assert.equal(t.elements.impPreremplirStatus.className, "status warn");
  assert.equal(await t.importer(), true);
});

test("contrat sans signal : ligne d'état, liste et marques d'avant ; un nouveau pré-remplissage lève un blocage précédent", async () => {
  const m = modal();
  await m.preremplir(RESULTAT({}));
  assert.equal(m.elements.impPreremplirStatus.className, "status ok");
  assert.equal(m.elements.impPreremplirStatus.textContent, "✓ Champs pré-remplis depuis le PDF — à relire avant import (1 avertissement ci-dessous)");
  assert.deepEqual(m.avertissements.at(-1), ["DocIE validation.warnings: x"]);
  assert.equal(CHAMPS.IDS_CHAMPS.some((id) => m.elements[id].classList.contains("invalid")), false);

  const b = modal();
  await b.preremplir(RESULTAT({ ...PARTIEL_TJM, modele: null }));
  assert.equal(await b.importer(), false);
  await b.preremplir(RESULTAT({}));
  assert.equal(await b.importer(), true);
});
