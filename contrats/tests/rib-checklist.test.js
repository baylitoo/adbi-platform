"use strict";
// Pièce « rib » de la checklist (#170, #194) : le code RÉEL de public/app.js
// (fonctions relues dans la source et exécutées dans un contexte vm, même
// méthode que kbis-champs.test.js) et la route RÉELLE /api/document/analyze
// (relue dans server.js), DocIE mocké à la frontière fetch du bridge.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const express = require("express");
const PDFDocument = require("pdfkit");

const { mapRibResult } = require("../lib/rib-mapping");
const { analyzeDocument } = require("../lib/docie-extraction");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extraireFonction(nom) {
  const debut = APP_JS.search(new RegExp("(async )?function " + nom + "\\("));
  assert.ok(debut !== -1, nom + " introuvable dans app.js");
  const reste = APP_JS.slice(debut);
  const m = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(m, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, m.index + m[0].length);
}

const RESULTAT = {
  document_type: "rib",
  account_holder: "SUND INDUSTRY SYSTEM",
  iban: "FR14 2004 1010 0505 0001 3M02 606",
  bic: "BNPAFRPP",
  bank_name: "BANQUE EXEMPLE PARIS OPERA",
};
const analyse = (surcharge = {}, expectedName = "Sund Industry System") =>
  mapRibResult(Object.assign({}, RESULTAT, surcharge), { expectedName, items: [{ id: "rib" }] }).analysis;

function contexte(reponse) {
  const ctx = {
    state: { values: { stNom: "Sund Industry System" }, dateState: {}, checkState: {} },
    fileToBase64: async () => "JVBERi0=",
    fetch: async (url, options) => { ctx.envoye = { url, corps: JSON.parse(options.body) }; return { ok: true, status: 200, json: async () => reponse }; },
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(["analyserRib", "ribRetenu", "renderRibResult"].map(extraireFonction).join("\n"), ctx);
  return ctx;
}

async function rendre(reponse) {
  const ctx = contexte(reponse);
  const el = { className: "", textContent: "" };
  await ctx.analyserRib({ id: "rib", label: "Un RIB" }, { name: "rib.pdf", type: "application/pdf" }, el, { textContent: "x" });
  return { ctx, el };
}

test("buildChecklist : la pièce rib reçoit son analyse, sans passer par le bloc des pièces datées", () => {
  const debut = APP_JS.indexOf("function buildChecklist(");
  const corps = APP_JS.slice(debut, APP_JS.indexOf("\n}\n", debut));
  assert.ok(corps.includes('if (it.id === "rib") ajouterAnalyseRib(item, it);'));
  assert.ok(extraireFonction("ajouterAnalyseRib").includes("renderRibResult(status, saved)"));
});

test("RIB lu et contrôlé : ligne ✅, résultat enregistré, case jamais cochée", async () => {
  const { ctx, el } = await rendre(analyse());
  assert.equal(ctx.envoye.url, "/api/document/analyze");
  assert.deepEqual(ctx.envoye.corps.items, [{ id: "rib", label: "Un RIB" }]);
  assert.equal(el.className, "chk-doc-status ok");
  assert.equal(el.textContent, "✅ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN FR14 2004 1010 0505 0001 3M02 606 (clé valide) — BIC BNPAFRPP — BANQUE EXEMPLE PARIS OPERA");
  const res = ctx.state.dateState.rib;
  assert.deepEqual(JSON.parse(JSON.stringify(res.controle)), { iban: "valide", bic: "valide" });
  assert.equal(res.iban, "FR14 2004 1010 0505 0001 3M02 606");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.state.checkState)), {});
});

test("IBAN mal lu : ⛔ avec le message du serveur, valeur lue gardée dans l'état", async () => {
  const { ctx, el } = await rendre(analyse({ iban: "FR14 2004 1010 0505 0001 3M02 607" }));
  assert.equal(el.className, "chk-doc-status err");
  assert.equal(el.textContent, "⛔ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN « FR14 2004 1010 0505 0001 3M02 607 » : clé de contrôle invalide (modulo 97), caractère probablement mal lu — valeur conservée, à vérifier sur le document");
  assert.equal(ctx.state.dateState.rib.iban, "FR14 2004 1010 0505 0001 3M02 607");
  assert.equal(ctx.state.dateState.rib.controle.iban, "cle_invalide");
});

test("IBAN absent : ⛔ nommé ; BIC d'un autre pays : ⚠️ nommé", async () => {
  const sansIban = await rendre(analyse({ iban: null }));
  assert.equal(sansIban.el.className, "chk-doc-status err");
  assert.equal(sansIban.el.textContent, "⛔ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN non trouvé dans le document.");

  const bic = await rendre(analyse({ bic: "DEUTDEFF" }));
  assert.equal(bic.el.className, "chk-doc-status warn");
  assert.ok(bic.el.textContent.startsWith("⚠️ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN FR14 2004 1010 0505 0001 3M02 606 (clé valide) — BIC DEUTDEFF"));
  assert.ok(bic.el.textContent.includes("BIC « DEUTDEFF » : pays DE différent du pays FR"));
});

test("RIB au nom d'une autre société : ⛔ comme pour le Kbis", async () => {
  const { el } = await rendre(analyse({ account_holder: "AUTRE SOCIETE SARL" }));
  assert.equal(el.className, "chk-doc-status err");
  assert.equal(el.textContent, "⛔ RIB au nom de « AUTRE SOCIETE SARL » — ce n'est PAS le sous-traitant saisi (« Sund Industry System »)");
});

test("analyse locale (flag off, scan, repli) : ⚠️ rien de contrôlé, jamais un ✅", async () => {
  const locale = {
    documentType: "RIB", matchedId: "rib", isValid: true, issuedDate: "", companyName: null, nameMatches: null,
    issues: ["Date de délivrance non trouvée dans le document.", "DocIE non sollicité (le document n'est pas un PDF (image : pas de couche texte)) — analyse locale utilisée."],
    summary: "RIB",
  };
  const { ctx, el } = await rendre(locale);
  assert.equal(el.className, "chk-doc-status warn");
  assert.equal(el.textContent, "⚠️ IBAN et BIC non lus ni contrôlés (analyse locale) — vérifier le RIB à la main");
  assert.equal(ctx.state.dateState.rib.controle, null);
});

// ---------------------------------------------------------------------------
// Route réelle : le serveur ne filtre rien, `controleIbanBic` arrive au client.
// ---------------------------------------------------------------------------
function routeAnalyse() {
  const debut = SERVER_JS.indexOf('app.post("/api/document/analyze"');
  assert.ok(debut !== -1);
  const reste = SERVER_JS.slice(debut);
  const m = /\r?\n\}\);\r?\n/.exec(reste);
  return reste.slice(0, m.index + m[0].length);
}

function pdfTexte(texte) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.fontSize(11).text(texte);
    doc.end();
  });
}

function poster(port, corps) {
  return new Promise((resolve, reject) => {
    const donnees = Buffer.from(JSON.stringify(corps));
    const req = http.request({ host: "127.0.0.1", port, path: "/api/document/analyze", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": donnees.length } }, (res) => {
      const morceaux = [];
      res.on("data", (c) => morceaux.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(morceaux).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(donnees);
  });
}

test("route /api/document/analyze (DocIE mocké au bridge) : IBAN mal lu contrôlé de bout en bout, rendu ⛔ côté navigateur", async () => {
  const ENV = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test", DOCIE_API_KEY: "test-secret" };
  const envAvant = {};
  for (const k of Object.keys(ENV)) { envAvant[k] = process.env[k]; process.env[k] = ENV[k]; }
  const fetchAvant = globalThis.fetch;
  const appels = [];
  const champ = (value) => ({ value, confidence: 0.9, evidence_ids: ["b1"] });
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(ENV.DOCIE_BASE_URL)) throw new Error("appel réseau inattendu : " + url);
    appels.push({ url: String(url), payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      request_id: "r", schema_name: "rib", model_profile: "lfm2.5-350m",
      result: { document_type: "rib", account_holder: champ("SUND INDUSTRY SYSTEM"),
        iban: champ("FR14 2004 1010 0505 0001 3M02 607"), bic: champ("BNPAFRPP"), bank_name: champ(null) },
      validation: { valid: true, errors: [], warnings: [] },
    }), { status: 200 });
  };
  const app = express();
  app.use(express.json({ limit: "30mb" }));
  // eslint-disable-next-line no-new-func
  new Function("app", "analyzeDocument", "console", routeAnalyse())(app, analyzeDocument, console);
  const serveur = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const pdf = await pdfTexte("RELEVE D'IDENTITE BANCAIRE\nIBAN : FR14 2004 1010 0505 0001 3M02 607\nBIC : BNPAFRPP");
    const { status, body } = await poster(serveur.address().port, {
      dataBase64: pdf.toString("base64"), mimeType: "application/pdf",
      items: [{ id: "rib", label: "Un RIB" }], expectedName: "Sund Industry System",
    });
    assert.equal(status, 200);
    assert.equal(appels.length, 1);
    assert.equal(appels[0].url, "https://docie.example.test/v1/extract/text");
    assert.equal(appels[0].payload.schema_name, "rib");
    assert.equal(body.controleIbanBic.iban.statut, "cle_invalide");
    assert.equal(body.iban, "FR14 2004 1010 0505 0001 3M02 607");

    const ctx = contexte(body);
    const el = { className: "", textContent: "" };
    await ctx.analyserRib({ id: "rib", label: "Un RIB" }, { name: "rib.pdf", type: "application/pdf" }, el, { textContent: "x" });
    assert.equal(el.className, "chk-doc-status err");
    assert.ok(el.textContent.includes("clé de contrôle invalide (modulo 97)"));
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
    globalThis.fetch = fetchAvant;
    for (const k of Object.keys(ENV)) {
      if (envAvant[k] === undefined) delete process.env[k]; else process.env[k] = envAvant[k];
    }
  }
});
