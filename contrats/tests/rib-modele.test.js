"use strict";
// Sélecteur de modèle du RIB (#194) : offres, échec bruyant d'un choix
// explicite, modèle servi, et garde de l'alternative LFM2.5 350M (admise
// seulement derrière le contrôle IBAN modulo 97 + format BIC).
//
// Aucun appel réseau : DocIE simulé à la frontière fetch du VRAI bridge, vrais
// PDF pdfkit, fonctions RÉELLES de public/app.js exécutées dans un bac à sable
// vm (même technique que rib-checklist.test.js et choix-modele-front.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const express = require("express");
const PDFDocument = require("pdfkit");

const { analyzeDocument } = require("../lib/docie-extraction");
const { mapRibResult } = require("../lib/rib-mapping");
const { monterPreremplissage } = require("../lib/import-extraction-routes");
const { creerGestionnaire } = require("../lib/taches-extraction");
const choix = require("../lib/choix-modele");

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

const BASE = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test", DOCIE_API_KEY: "cle-test" };
const MODELES_RIB = { DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b", DOCIE_MODELE_LFM25_350M: "store:lfm2.5-350m" };
const ITEMS = [{ id: "rib", label: "Un RIB" }];
const IBAN_OK = "FR14 2004 1010 0505 0001 3M02 606";
const IBAN_FAUX = "FR14 2004 1010 0505 0001 3M02 607";
const TEXTE_RIB = ["RELEVE D'IDENTITE BANCAIRE", "Titulaire du compte : SUND INDUSTRY SYSTEM", "IBAN : " + IBAN_OK, "BIC : BNPAFRPP"].join("\n");

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
const pdfTexte = () => pdf((doc) => doc.fontSize(11).text(TEXTE_RIB));
const pdfScanne = () => pdf((doc) => doc.rect(50, 50, 300, 200).fill("#cccccc"));

function docie(repondre) {
  const appels = [];
  const fetchImpl = async (url, options) => {
    appels.push({ url, corps: JSON.parse(options.body) });
    const { status = 200, corps } = repondre(appels.length);
    return new Response(JSON.stringify(corps), { status });
  };
  return { appels, fetchImpl };
}
const champ = (value) => ({ value, evidence_ids: ["b1"], confidence: 0.95 });
const reponseRib = (modelProfile, { iban = IBAN_OK, bic = "BNPAFRPP" } = {}) => ({
  corps: {
    request_id: "req-rib", schema_name: "rib", model_profile: modelProfile,
    result: { document_type: "rib", extraction_notes: [], account_holder: champ("SUND INDUSTRY SYSTEM"),
      iban: champ(iban), bic: champ(bic), bank_name: champ("BANQUE EXEMPLE") },
    validation: { valid: true, errors: [], warnings: [] },
  },
});
function localInterdit() {
  const appels = [];
  return { appels, analyzeLocal: async () => { appels.push(1); return { documentType: "RIB", issues: [], summary: "local" }; } };
}
const corpsRib = async (extra = {}) => ({
  mimeType: "application/pdf", dataBase64: (await pdfTexte()).toString("base64"), items: ITEMS,
  expectedName: "Sund Industry System", ...extra,
});

// ---------------------------------------------------------------------------
// Offres : GET /api/modeles?tache=rib
// ---------------------------------------------------------------------------

async function demarrer(env) {
  const app = express();
  app.use(express.json());
  monterPreremplissage(app, { extractContractValues: async () => ({}), gestionnaire: creerGestionnaire({ journal: () => {} }), env, journal: () => {} });
  const serveur = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return {
    modeles: async () => { const r = await fetch(base + "/api/modeles?tache=rib"); return { status: r.status, texte: await r.text() }; },
    fermer: () => new Promise((ok) => serveur.close(ok)),
  };
}

test("RIB : la tâche a un sélecteur, sur la voie texte", () => {
  assert.equal(choix.TACHES.rib, "texte");
});

test("GET /api/modeles?tache=rib : deux modèles -> 2.6B par défaut puis 350M ; un seul -> lui ; rien ou flag coupé -> vide ; aucun store:", async () => {
  const deux = await demarrer({ ...BASE, ...MODELES_RIB });
  const un = await demarrer({ ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" });
  const rien = await demarrer(BASE);
  const coupe = await demarrer({ ...MODELES_RIB });
  try {
    const r = await deux.modeles();
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.texte).modeles.map((m) => [m.id, m.role, m.libelle]),
      [["lfm25_2_6b", "defaut", "LFM2.5 2.6B"], ["lfm25_350m", "alternative", "LFM2.5 350M"]]);
    assert.ok(!r.texte.includes("store:"));
    assert.deepEqual(JSON.parse((await un.modeles()).texte).modeles.map((m) => m.id), ["lfm25_2_6b"]);
    assert.deepEqual(JSON.parse((await rien.modeles()).texte), { tache: "rib", modeles: [] });
    assert.deepEqual(JSON.parse((await coupe.modeles()).texte), { tache: "rib", modeles: [] });
  } finally {
    await deux.fermer(); await un.fermer(); await rien.fermer(); await coupe.fermer();
  }
});

// ---------------------------------------------------------------------------
// Serveur : choix explicite
// ---------------------------------------------------------------------------

test("RIB + modèle choisi + DocIE en panne : erreur nommée, AUCUNE analyse locale", async () => {
  const { fetchImpl } = docie(() => ({ status: 500, corps: { error: "boom" } }));
  const local = localInterdit();
  const corps = await corpsRib({ modele: "lfm25_350m" });
  await assert.rejects(() => analyzeDocument(corps, { env: { ...BASE, ...MODELES_RIB }, fetchImpl, analyzeLocal: local.analyzeLocal }),
    (e) => e.code === "upstream" && e.message === "Le service d'extraction a répondu en erreur.");
  assert.equal(local.appels.length, 0);
});

test("RIB + modèle non configuré : `modele_non_propose` ; RIB scanné + modèle choisi : `scan` ; ni DocIE ni local", async () => {
  const { appels, fetchImpl } = docie(() => { throw new Error("DocIE ne doit pas être appelé"); });
  const local = localInterdit();
  const env = { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
  const nonConfigure = await corpsRib({ modele: "lfm25_350m" });
  await assert.rejects(() => analyzeDocument(nonConfigure, { env, fetchImpl, analyzeLocal: local.analyzeLocal }),
    (e) => e.code === "modele_non_propose" && e.message === choix.MESSAGES_CHOIX.modele_non_propose);
  const scan = { ...(await corpsRib({ modele: "lfm25_2_6b" })), dataBase64: (await pdfScanne()).toString("base64") };
  await assert.rejects(() => analyzeDocument(scan, { env, fetchImpl, analyzeLocal: local.analyzeLocal }), (e) => e.code === "scan");
  assert.equal(appels.length + local.appels.length, 0);
});

test("RIB sans `modele`, catalogue configuré, DocIE en panne : repli local comme avant, aucune clé ajoutée", async () => {
  const { appels, fetchImpl } = docie(() => ({ status: 500, corps: { error: "boom" } }));
  const local = localInterdit();
  const res = await analyzeDocument(await corpsRib(), { env: { ...BASE, ...MODELES_RIB }, fetchImpl, analyzeLocal: local.analyzeLocal });
  assert.equal(local.appels.length, 1);
  assert.equal(Object.hasOwn(appels[0].corps, "model_profile"), false);
  assert.equal(Object.hasOwn(res, "modele"), false);
  assert.equal(Object.hasOwn(res, "controleIbanBicExige"), false);
});

test("RIB + 350M choisi : store: envoyé, modèle servi rendu, contrôle IBAN/BIC exigé ; 2.6B : pas de drapeau", async () => {
  const env = { ...BASE, ...MODELES_RIB };
  const petit = docie(() => reponseRib("lfm2.5-350m"));
  const r350 = await analyzeDocument(await corpsRib({ modele: "lfm25_350m" }), { env, fetchImpl: petit.fetchImpl, analyzeLocal: localInterdit().analyzeLocal });
  assert.equal(petit.appels[0].url, "https://docie.example.test/v1/extract/text");
  assert.equal(petit.appels[0].corps.model_profile, "store:lfm2.5-350m");
  assert.deepEqual(r350.modele, { id: "lfm25_350m", libelle: "LFM2.5 350M" });
  assert.equal(r350.controleIbanBicExige, true);

  const defaut = docie(() => reponseRib("lfm2.5-2.6b"));
  const r26 = await analyzeDocument(await corpsRib({ modele: "lfm25_2_6b" }), { env, fetchImpl: defaut.fetchImpl, analyzeLocal: localInterdit().analyzeLocal });
  assert.deepEqual(r26.modele, { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
  assert.equal(Object.hasOwn(r26, "controleIbanBicExige"), false);
});

test("garde du 350M : exigée si le modèle DEMANDÉ ou le modèle SERVI est l'alternative", async () => {
  const env = { ...BASE, ...MODELES_RIB };
  const serviPetit = docie(() => reponseRib("store:lfm2.5-350m"));
  const a = await analyzeDocument(await corpsRib({ modele: "lfm25_2_6b" }), { env, fetchImpl: serviPetit.fetchImpl, analyzeLocal: localInterdit().analyzeLocal });
  assert.equal(a.controleIbanBicExige, true);
  const serviInconnu = docie(() => reponseRib("deploiement-inconnu"));
  const b = await analyzeDocument(await corpsRib({ modele: "lfm25_350m" }), { env, fetchImpl: serviInconnu.fetchImpl, analyzeLocal: localInterdit().analyzeLocal });
  assert.deepEqual(b.modele, { id: null, libelle: "deploiement-inconnu" });
  assert.equal(b.controleIbanBicExige, true);
  assert.equal(choix.exigeControleIbanBic("urssaf", { id: "lfm25_350m" }, null, { env }), false);
});

// ---------------------------------------------------------------------------
// Navigateur : sélecteur, envoi, « lu par », garde du 350M
// ---------------------------------------------------------------------------

function faux(extra = {}) {
  const classes = new Set();
  return Object.assign({
    textContent: "", className: "", value: "", options: [], enfants: [], dataset: {}, style: {},
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c), add: (c) => classes.add(c) },
    appendChild(enfant) { this.enfants.push(enfant); },
    addEventListener() {},
  }, extra);
}

test("ajouterAnalyseRib : sélecteur de modèle rempli pour la tâche rib, masqué par défaut", () => {
  const remplis = [];
  const ctx = {
    state: { values: {}, dateState: {} },
    document: { createElement: (tag) => faux({ tag }) },
    remplirSelecteurModeles: (sel, tache) => remplis.push([sel, tache]),
    renderRibResult: () => {}, analyserRib: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("ajouterAnalyseRib"), ctx);
  const item = faux();
  vm.runInContext("(i, it) => ajouterAnalyseRib(i, it)", ctx)(item, { id: "rib", label: "Un RIB" });
  assert.equal(remplis.length, 1);
  const [sel, tache] = remplis[0];
  assert.equal(tache, "rib");
  assert.equal(sel.tag, "select");
  assert.equal(sel.dataset.modeleSelecteur, "1");
  assert.ok(sel.className.split(" ").includes("hidden"));
  assert.ok(item.enfants[0].enfants.includes(sel), "le sélecteur est dans la ligne du bouton d'analyse");
});

test("remplirSelecteurModeles(rib) : un seul modèle -> masqué mais valorisé ; deux -> visible, défaut présélectionné", async () => {
  const OFFRES = [
    { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "defaut", lignesMax: 800 },
    { id: "lfm25_350m", libelle: "LFM2.5 350M", description: "Très rapide — documents simples", role: "alternative", lignesMax: 800 },
  ];
  for (const [offres, cache, valeur] of [[OFFRES.slice(0, 1), true, "lfm25_2_6b"], [OFFRES, false, "lfm25_2_6b"]]) {
    const demandes = [];
    const ctx = {
      getJSON: async (url) => { demandes.push(url); return { modeles: offres }; },
      document: { createElement: () => ({ value: "", textContent: "" }) },
      encodeURIComponent, Array, Promise,
    };
    vm.createContext(ctx);
    vm.runInContext("const OFFRES_MODELES = {};\n" + extraireFonction("offresModeles") + extraireFonction("remplirSelecteurModeles"), ctx);
    const sel = faux({ appendChild(o) { this.options.push(o); }, set innerHTML(v) { this.options = []; } });
    await vm.runInContext("(s) => remplirSelecteurModeles(s, 'rib')", ctx)(sel);
    assert.deepEqual(demandes, ["/api/modeles?tache=rib"]);
    assert.equal(sel.value, valeur);
    assert.equal(sel.classList.contains("hidden"), cache);
  }
});

const analyse = (surcharge = {}, extra = {}) =>
  Object.assign(mapRibResult(Object.assign({ document_type: "rib", account_holder: "SUND INDUSTRY SYSTEM", iban: IBAN_OK, bic: "BNPAFRPP",
    bank_name: "BANQUE EXEMPLE" }, surcharge), { expectedName: "Sund Industry System", items: ITEMS }).analysis, extra);
const PETIT = { modele: { id: "lfm25_350m", libelle: "LFM2.5 350M" }, controleIbanBicExige: true };

async function analyserDansNavigateur({ reponse, status = 200, selecteur = null }) {
  const envois = [];
  const ctx = {
    state: { values: { stNom: "Sund Industry System" }, dateState: {} },
    fileToBase64: async () => "JVBERi0=",
    fetch: async (url, options) => { envois.push(JSON.parse(options.body)); return { ok: status < 300, status, json: async () => reponse }; },
    // Résultat partiel (#203) : couvert par resultat-partiel.test.js, bouchon neutre.
    renderResultatPartiel: () => {},
    JSON, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(["analyserRib", "ribRetenu", "renderRibResult"].map(extraireFonction).join("\n"), ctx);
  const el = { className: "", textContent: "", parentNode: { querySelector: (s) => (s === "[data-modele-selecteur]" ? selecteur : null) } };
  await ctx.analyserRib({ id: "rib", label: "Un RIB" }, { name: "rib.pdf", type: "application/pdf" }, el, { textContent: "x" });
  return { el, corps: envois[0], ctx };
}

test("analyserRib : modèle choisi envoyé, « lu par » dans la ligne d'état et gardé avec le résultat", async () => {
  const { el, corps, ctx } = await analyserDansNavigateur({
    reponse: analyse({}, { modele: { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" } }),
    selecteur: { options: [{}, {}], value: "lfm25_2_6b" },
  });
  assert.equal(corps.modele, "lfm25_2_6b");
  assert.equal(el.className, "chk-doc-status ok");
  assert.equal(el.textContent, "✅ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN " + IBAN_OK + " (clé valide) — BIC BNPAFRPP — BANQUE EXEMPLE — lu par LFM2.5 2.6B");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.state.dateState.rib.modele)), { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
  assert.equal(Object.hasOwn(ctx.state.dateState.rib, "controleExige"), false);
});

test("analyserRib sans modèle proposé (sélecteur vide ou absent) : aucun `modele` envoyé, ligne de #209 à l'identique", async () => {
  for (const selecteur of [{ options: [], value: "" }, null]) {
    const { el, corps, ctx } = await analyserDansNavigateur({ reponse: analyse(), selecteur });
    assert.equal(Object.hasOwn(corps, "modele"), false);
    assert.equal(el.textContent, "✅ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN " + IBAN_OK + " (clé valide) — BIC BNPAFRPP — BANQUE EXEMPLE");
    assert.deepEqual(Object.keys(ctx.state.dateState.rib).sort(), ["alertes", "banque", "bic", "companyName", "controle", "fileName", "iban", "nameMatches", "titulaire"]);
  }
});

test("analyserRib, modèle choisi en échec : erreur nommée affichée, aucun résultat gardé", async () => {
  const { el, ctx } = await analyserDansNavigateur({
    reponse: { error: choix.MESSAGES_CHOIX.scan }, status: 400, selecteur: { options: [{}], value: "lfm25_350m" },
  });
  assert.equal(el.className, "chk-doc-status err");
  assert.equal(el.textContent, "Erreur : " + choix.MESSAGES_CHOIX.scan);
  assert.equal(ctx.state.dateState.rib, undefined);
});

test("garde du 350M : IBAN mal lu -> ⛔ « lecture non retenue », jamais ✅ ni ⚠️", async () => {
  const { el } = await analyserDansNavigateur({ reponse: analyse({ iban: IBAN_FAUX }, PETIT) });
  assert.equal(el.className, "chk-doc-status err");
  assert.ok(el.textContent.startsWith("⛔ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN « " + IBAN_FAUX + " » : clé de contrôle invalide (modulo 97)"), el.textContent);
  assert.ok(el.textContent.includes("lecture non retenue : ce modèle n'est admis qu'avec un IBAN et un BIC contrôlés valides"));
  assert.ok(el.textContent.endsWith(" — lu par LFM2.5 350M"));
});

test("garde du 350M : BIC douteux ou absent -> ⛔ (⚠️ avec le modèle par défaut, comme #209)", async () => {
  for (const bic of ["DEUTDEFF", null]) {
    const petit = await analyserDansNavigateur({ reponse: analyse({ bic }, PETIT) });
    assert.equal(petit.el.className, "chk-doc-status err", String(bic));
    assert.ok(petit.el.textContent.includes("lecture non retenue"));
    const defaut = await analyserDansNavigateur({ reponse: analyse({ bic }) });
    assert.equal(defaut.el.className, "chk-doc-status warn", String(bic));
  }
});

test("garde du 350M : réponse sans contrôle IBAN/BIC -> ⛔, jamais le ⚠️ « analyse locale » ; IBAN et BIC valides -> ✅", async () => {
  const sansControle = analyse({}, PETIT);
  delete sansControle.controleIbanBic;
  const { el } = await analyserDansNavigateur({ reponse: sansControle });
  assert.equal(el.className, "chk-doc-status err");
  assert.ok(el.textContent.startsWith("⛔ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN et BIC non contrôlés — lecture non retenue"));
  const ok = await analyserDansNavigateur({ reponse: analyse({}, PETIT) });
  assert.equal(ok.el.className, "chk-doc-status ok");
  assert.equal(ok.el.textContent, "✅ Titulaire : SUND INDUSTRY SYSTEM ✓ — IBAN " + IBAN_OK + " (clé valide) — BIC BNPAFRPP — BANQUE EXEMPLE — lu par LFM2.5 350M");
});

// ---------------------------------------------------------------------------
// De bout en bout : route réelle, bridge réel, DocIE mocké au fetch global
// ---------------------------------------------------------------------------

function routeAnalyse() {
  const debut = SERVER_JS.indexOf('app.post("/api/document/analyze"');
  assert.ok(debut !== -1);
  const reste = SERVER_JS.slice(debut);
  const m = /\r?\n\}\);\r?\n/.exec(reste);
  return reste.slice(0, m.index + m[0].length);
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

test("route /api/document/analyze : 350M choisi, IBAN mal lu -> drapeau de garde transmis, rendu ⛔ côté navigateur", async () => {
  const ENV = { ...BASE, ...MODELES_RIB };
  const envAvant = {};
  for (const k of Object.keys(ENV)) { envAvant[k] = process.env[k]; process.env[k] = ENV[k]; }
  const fetchAvant = globalThis.fetch;
  const appels = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(ENV.DOCIE_BASE_URL)) throw new Error("appel réseau inattendu : " + url);
    appels.push(JSON.parse(options.body));
    return new Response(JSON.stringify(reponseRib("lfm2.5-350m", { iban: IBAN_FAUX }).corps), { status: 200 });
  };
  const app = express();
  app.use(express.json({ limit: "30mb" }));
  // eslint-disable-next-line no-new-func
  new Function("app", "analyzeDocument", "console", routeAnalyse())(app, analyzeDocument, console);
  const serveur = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const { status, body } = await poster(serveur.address().port, await corpsRib({ modele: "lfm25_350m" }));
    assert.equal(status, 200);
    assert.equal(appels[0].model_profile, "store:lfm2.5-350m");
    assert.equal(body.controleIbanBicExige, true);
    assert.equal(body.controleIbanBic.iban.statut, "cle_invalide");
    const { el } = await analyserDansNavigateur({ reponse: body });
    assert.equal(el.className, "chk-doc-status err");
    assert.ok(el.textContent.includes("lecture non retenue"));
    assert.ok(!el.textContent.startsWith("✅"));
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
    globalThis.fetch = fetchAvant;
    for (const k of Object.keys(ENV)) {
      if (envAvant[k] === undefined) delete process.env[k]; else process.env[k] = envAvant[k];
    }
  }
});
