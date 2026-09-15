"use strict";
// Kbis « choisi par type d'entrée » (#194) : PDF à couche texte -> voie texte
// (LFM2.5 2.6B par défaut, schéma dynamique kbis.schema.json) ; photo ou scan ->
// NuExtract3 en vision (voie agent, DOCIE_AGENT_KBIS_NUEXTRACT3, 8 pages au plus).
//
// Aucun appel réseau : DocIE simulé à la frontière fetch du VRAI bridge, vrais
// PDF pdfkit, fonctions RÉELLES de public/app.js dans un bac à sable vm, route
// réelle de server.js montée sur Express sans DATABASE_URL.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const express = require("express");
const PDFDocument = require("pdfkit");

const { analyzeDocument, PIECES_TEXTE, VOIES } = require("../lib/docie-extraction");
const { MAPPED_FIELDS } = require("../lib/kbis-mapping");
const { monterPreremplissage } = require("../lib/import-extraction-routes");
const { creerGestionnaire } = require("../lib/taches-extraction");
const choix = require("../lib/choix-modele");
const K = require("../public/kbis-champs");
const CHAMPS = require("../public/import-champs");

const RACINE = path.join(__dirname, "..", "..");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "kbis.schema.json"));
const RAW_KBIS = require(path.join(RACINE, "document-parsing", "mappings", "fixtures", "kbis_extraction_sample.json"));
const CATALOGUE = require(path.join(RACINE, "document-parsing", "models", "catalogue.js"));

const clone = (x) => JSON.parse(JSON.stringify(x));

function extraireFonction(nom) {
  const debut = APP_JS.search(new RegExp("(async )?function " + nom + "\\("));
  assert.ok(debut !== -1, nom + " introuvable dans app.js");
  const reste = APP_JS.slice(debut);
  const m = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(m, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, m.index + m[0].length);
}

const BASE = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test", DOCIE_API_KEY: "cle-test", DOCIE_AGENT_KBIS: "kbis-historique" };
const MODELES_KBIS = { DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b", DOCIE_MODELE_NUEXTRACT3: "store:nuextract3", DOCIE_AGENT_KBIS_NUEXTRACT3: "kbis-nuextract3" };
const ITEMS = [{ id: "kbis", label: "Extrait Kbis" }];
const W_LEGAL_FORM = "legal_form: Input should be a valid string; dropped";

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
const pdfTexte = () => pdf((doc) => doc.fontSize(11).text("EXTRAIT KBIS\nSUND INDUSTRY SYSTEM\nSIREN 941 091 316\nDelivre le 04/09/2026"));
const pdfScanne = (pages = 1) => pdf((doc) => {
  for (let i = 0; i < pages; i++) { if (i) doc.addPage(); doc.rect(50, 50, 300, 200).fill("#cccccc"); }
});
const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");

// DocIE simulé : réponse selon l'URL appelée (voie texte ou agent).
function docie({ status = 200, result = RAW_KBIS.result, warnings = [] } = {}) {
  const appels = [];
  const fetchImpl = async (url, options) => {
    const corps = JSON.parse(options.body);
    appels.push({ url, corps });
    if (status !== 200) return new Response(JSON.stringify({ error: "boom" }), { status });
    const validation = { valid: true, errors: [], warnings };
    if (url.endsWith("/v1/extract/text")) {
      return new Response(JSON.stringify({ request_id: "t", schema_name: "kbis", model_profile: String(corps.model_profile || "").replace(/^store:/, ""), result, validation }), { status: 200 });
    }
    const agent = url.split("/v1/agents/")[1].split("/")[0];
    return new Response(JSON.stringify({
      id: "chat-kbis", model: agent, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
      docie_agent: { agent, schema_name: "kbis", validation },
    }), { status: 200 });
  };
  return { appels, fetchImpl };
}
function localCompte() {
  const appels = [];
  return { appels, analyzeLocal: async () => { appels.push(1); return { documentType: "Document", issues: [], summary: "local" }; } };
}
const corps = (buffer, extra = {}) => ({
  mimeType: extra.mimeType || "application/pdf", dataBase64: buffer.toString("base64"), items: ITEMS, expectedName: "Sund Industry System", ...extra,
});
const URL_TEXTE = "https://docie.example.test/v1/extract/text";
const urlAgent = (a) => "https://docie.example.test/v1/agents/" + a + "/chat/completions";

// ---------------------------------------------------------------------------
// Schéma de la voie texte
// ---------------------------------------------------------------------------

test("kbis.schema.json : exactement le schéma enregistré pour l'agent (fixture générée depuis DocIE), rien d'inventé ni de manquant", () => {
  assert.deepEqual(SCHEMA, RAW_KBIS.dynamic_schema);
  const noms = SCHEMA.fields.map((f) => f.name);
  assert.deepEqual([...noms].sort(), [...Object.keys(MAPPED_FIELDS), "company_name", "issued_date", "share_capital"].sort());
  assert.equal(PIECES_TEXTE.kbis.schemaPath, path.join(RACINE, "document-parsing", "schemas", "kbis.schema.json"));
});

test("kbis.schema.json : contraintes DynamicSchemaSpec (#170) — snake_case <= 64, types admis, noms réservés, scalaires sans sous-champs", () => {
  assert.equal(SCHEMA.document_type, "kbis");
  const TYPES = new Set(["string", "date", "number", "money", "object", "list"]);
  const vus = new Set();
  for (const f of SCHEMA.fields) {
    assert.deepEqual(Object.keys(f), ["name", "type", "description", "fields"]);
    assert.match(f.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(!["document_type", "extraction_notes"].includes(f.name));
    assert.ok(!vus.has(f.name)); vus.add(f.name);
    assert.ok(TYPES.has(f.type), f.type);
    assert.deepEqual(f.fields, [], "aucun object/list ici : tout est scalaire, money compris");
  }
});

// ---------------------------------------------------------------------------
// Routage par type d'entrée
// ---------------------------------------------------------------------------

test("rien de configuré pour le catalogue : Kbis sur l'agent DOCIE_AGENT_KBIS quel que soit le fichier, corps d'avant", async () => {
  for (const buffer of [await pdfTexte(), await pdfScanne()]) {
    const { appels, fetchImpl } = docie();
    const res = await analyzeDocument(corps(buffer), { env: BASE, fetchImpl, analyzeLocal: localCompte().analyzeLocal });
    assert.deepEqual(appels.map((a) => a.url), [urlAgent("kbis-historique")]);
    assert.equal(appels[0].corps.model, "kbis-historique");
    assert.equal(Object.hasOwn(res, "modele"), false);
    assert.equal(res.documentType, "Extrait Kbis");
  }
  // Seul l'agent NuExtract3 configuré (pas de modèle texte) : toujours l'agent d'avant sans choix.
  const { appels, fetchImpl } = docie();
  await analyzeDocument(corps(await pdfTexte()), { env: { ...BASE, DOCIE_AGENT_KBIS_NUEXTRACT3: "kbis-nuextract3" }, fetchImpl });
  assert.deepEqual(appels.map((a) => a.url), [urlAgent("kbis-historique")]);
  assert.equal(VOIES.kbis, "agent");
});

test("sans choix, LFM2.5 2.6B configuré : PDF à couche texte -> voie texte avec ce modèle et le schéma ; scan, image -> agent d'avant", async () => {
  const env = { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
  const texte = docie();
  const r = await analyzeDocument(corps(await pdfTexte()), { env, fetchImpl: texte.fetchImpl, analyzeLocal: localCompte().analyzeLocal });
  assert.deepEqual(texte.appels.map((a) => a.url), [URL_TEXTE]);
  assert.equal(texte.appels[0].corps.model_profile, "store:lfm2.5-2.6b");
  assert.deepEqual(texte.appels[0].corps.dynamic_schema, SCHEMA);
  assert.match(texte.appels[0].corps.text, /SUND INDUSTRY SYSTEM/);
  assert.equal(Object.hasOwn(r, "modele"), false, "sans choix : aucune clé modele");
  for (const [buffer, mimeType] of [[await pdfScanne(), "application/pdf"], [PNG, "image/png"]]) {
    const agent = docie();
    await analyzeDocument(corps(buffer, { mimeType }), { env, fetchImpl: agent.fetchImpl, analyzeLocal: localCompte().analyzeLocal });
    assert.deepEqual(agent.appels.map((a) => a.url), [urlAgent("kbis-historique")], mimeType);
  }
});

test("modèle choisi : PDF texte -> voie texte avec CE modèle ; scan ou image + NuExtract3 -> vision DOCIE_AGENT_KBIS_NUEXTRACT3 ; « lu par » = modèle servi", async () => {
  const env = { ...BASE, ...MODELES_KBIS };
  for (const [modele, profil, id] of [["lfm25_2_6b", "store:lfm2.5-2.6b", "lfm25_2_6b"], ["nuextract3", "store:nuextract3", "nuextract3"]]) {
    const d = docie();
    const r = await analyzeDocument(corps(await pdfTexte(), { modele }), { env, fetchImpl: d.fetchImpl, analyzeLocal: localCompte().analyzeLocal });
    assert.deepEqual(d.appels.map((a) => [a.url, a.corps.model_profile]), [[URL_TEXTE, profil]]);
    assert.equal(r.modele.id, id);
  }
  for (const [buffer, mimeType] of [[await pdfScanne(3), "application/pdf"], [PNG, "image/png"]]) {
    const d = docie();
    const r = await analyzeDocument(corps(buffer, { mimeType, modele: "nuextract3" }), { env, fetchImpl: d.fetchImpl, analyzeLocal: localCompte().analyzeLocal });
    assert.deepEqual(d.appels.map((a) => a.url), [urlAgent("kbis-nuextract3")], mimeType);
    assert.deepEqual(r.modele, { id: "nuextract3", libelle: "NuExtract3" });
  }
});

test("échouer bruyamment : scan + modèle de la voie texte -> `scan` ; > 8 pages en vision -> `limite` ; non configuré -> `modele_non_propose` ; ni DocIE ni local", async () => {
  const env = { ...BASE, ...MODELES_KBIS };
  const cas = [
    [corps(await pdfScanne(), { modele: "lfm25_2_6b" }), env, "scan"],
    [corps(PNG, { mimeType: "image/png", modele: "lfm25_2_6b" }), env, "scan"],
    [corps(await pdfScanne(9), { modele: "nuextract3" }), env, "limite"],
    [corps(await pdfScanne(), { modele: "nuextract3" }), { ...BASE, DOCIE_MODELE_NUEXTRACT3: "store:nuextract3" }, "scan"],
    [corps(await pdfTexte(), { modele: "nuextract3" }), { ...BASE, DOCIE_AGENT_KBIS_NUEXTRACT3: "kbis-nuextract3" }, "modele_non_propose"],
    [corps(await pdfScanne(), { modele: "lfm25_350m" }), env, "modele_non_propose"],
  ];
  for (const [body, e, code] of cas) {
    const d = docie();
    const local = localCompte();
    await assert.rejects(() => analyzeDocument(body, { env: e, fetchImpl: d.fetchImpl, analyzeLocal: local.analyzeLocal }),
      (err) => err.code === code && err.message === choix.MESSAGES_CHOIX[code], code);
    assert.equal(d.appels.length + local.appels.length, 0, code);
  }
  // 8 pages : admis.
  const huit = docie();
  await analyzeDocument(corps(await pdfScanne(8), { modele: "nuextract3" }), { env, fetchImpl: huit.fetchImpl });
  assert.equal(huit.appels.length, 1);
});

test("échec DocIE : modèle choisi -> erreur nommée sur les deux voies, aucune analyse locale ; sans choix -> repli local d'avant", async () => {
  const env = { ...BASE, ...MODELES_KBIS };
  for (const body of [corps(await pdfTexte(), { modele: "lfm25_2_6b" }), corps(await pdfScanne(), { modele: "nuextract3" })]) {
    const d = docie({ status: 500 });
    const local = localCompte();
    await assert.rejects(() => analyzeDocument(body, { env, fetchImpl: d.fetchImpl, analyzeLocal: local.analyzeLocal }),
      (e) => e.code === "upstream" && e.message === "Le service d'extraction a répondu en erreur.");
    assert.equal(d.appels.length, 1);
    assert.equal(local.appels.length, 0);
  }
  for (const buffer of [await pdfTexte(), await pdfScanne()]) {
    const d = docie({ status: 500 });
    const local = localCompte();
    const res = await analyzeDocument(corps(buffer), { env, fetchImpl: d.fetchImpl, analyzeLocal: local.analyzeLocal });
    assert.equal(local.appels.length, 1);
    assert.deepEqual(res.issues, ["Extraction DocIE indisponible (upstream) — analyse locale utilisée en repli."]);
  }
});

// ---------------------------------------------------------------------------
// Même analyse sur les deux voies (#201/#204, #197, #212)
// ---------------------------------------------------------------------------

test("une même lecture par la voie texte et par la voie agent : analyses identiques (hors `modele`), SIREN/SIRET, issues, proposition, partiel compris", async () => {
  const env = { ...BASE, ...MODELES_KBIS };
  for (const [nom, result] of [
    ["fixture nominale", RAW_KBIS.result],
    ["SIREN/SIRET à clé fausse", { ...clone(RAW_KBIS.result), siren: { value: "123456789", evidence_ids: [], confidence: 0.9 }, siret_siege: { value: "12345678900012", evidence_ids: [], confidence: 0.9 } }],
  ]) {
    const t = docie({ result, warnings: [W_LEGAL_FORM] });
    const a = docie({ result, warnings: [W_LEGAL_FORM] });
    const viaTexte = await analyzeDocument(corps(await pdfTexte(), { modele: "lfm25_2_6b" }), { env, fetchImpl: t.fetchImpl });
    const viaAgent = await analyzeDocument(corps(await pdfScanne(), { modele: "nuextract3" }), { env, fetchImpl: a.fetchImpl });
    assert.equal(t.appels[0].url, URL_TEXTE, nom);
    assert.equal(a.appels[0].url, urlAgent("kbis-nuextract3"), nom);
    assert.deepEqual(viaTexte.modele, { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
    assert.deepEqual(viaAgent.modele, { id: "nuextract3", libelle: "NuExtract3" });
    const sansModele = (x) => { const c = clone(x); delete c.modele; return c; };
    assert.deepEqual(sansModele(viaTexte), sansModele(viaAgent), nom);
    // Et identiques à la voie agent d'avant (aucun modèle, DOCIE_AGENT_KBIS).
    const avant = await analyzeDocument(corps(await pdfTexte()), { env: BASE, fetchImpl: docie({ result, warnings: [W_LEGAL_FORM] }).fetchImpl });
    assert.deepEqual(sansModele(viaTexte), clone(avant), nom);
    assert.deepEqual(viaTexte.partiel, [{ champ: "legal_form", raison: "feuille_abandonnee" }]);
    assert.equal(Object.hasOwn(viaTexte, "troncaturePossible"), false);
    assert.deepEqual(K.extraire(viaTexte), K.extraire(viaAgent));
    assert.deepEqual(K.proposer(K.extraire(viaTexte), viaTexte.nameMatches, {}, K.controleCompact(viaTexte)),
      K.proposer(K.extraire(viaAgent), viaAgent.nameMatches, {}, K.controleCompact(viaAgent)));
    assert.deepEqual(CHAMPS.lignesPartiel(CHAMPS.signauxPartiels(viaTexte), "kbis"), CHAMPS.lignesPartiel(CHAMPS.signauxPartiels(viaAgent), "kbis"));
  }
  const t = docie();
  const nominal = await analyzeDocument(corps(await pdfTexte(), { modele: "lfm25_2_6b" }), { env, fetchImpl: t.fetchImpl });
  assert.equal(nominal.controleSirenSiret.siren.statut, "valide");
  assert.equal(nominal.controleSirenSiret.siret.statut, "valide");
  assert.equal(nominal.siren, "941091316");
  assert.equal(nominal.capitalSocial, "1000");
  assert.equal(nominal.issuedDate, "2026-09-04");
  assert.equal(nominal.summary, "Extrait Kbis — délivré le 2026-09-04 (DocIE)");
  const faux = docie({ result: { ...clone(RAW_KBIS.result), siren: { value: "123456789", evidence_ids: [], confidence: 0.9 } } });
  const cle = await analyzeDocument(corps(await pdfTexte(), { modele: "lfm25_2_6b" }), { env, fetchImpl: faux.fetchImpl });
  assert.equal(cle.controleSirenSiret.siren.statut, "cle_invalide");
  assert.ok(cle.issues.some((i) => i.startsWith("SIREN « 123456789 » : clé de contrôle invalide")));
  assert.equal(K.proposer(K.extraire(cle), cle.nameMatches, {}, K.controleCompact(cle)).aVerifier[0].cle, "stSiren");
});

// ---------------------------------------------------------------------------
// Offres : GET /api/modeles?tache=kbis[&voie=…]
// ---------------------------------------------------------------------------

async function demarrer(env) {
  const app = express();
  app.use(express.json());
  monterPreremplissage(app, { extractContractValues: async () => ({}), gestionnaire: creerGestionnaire({ journal: () => {} }), env, journal: () => {} });
  const serveur = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return {
    get: async (qs) => { const r = await fetch(base + "/api/modeles?" + qs); return { status: r.status, texte: await r.text() }; },
    fermer: () => new Promise((ok) => serveur.close(ok)),
  };
}

test("GET /api/modeles?tache=kbis : voie texte (défaut) LFM2.5 2.6B puis NuExtract3 ; voie agent NuExtract3 seul ; aucun identifiant réel ; voie inconnue -> 400", async () => {
  const srv = await demarrer({ ...BASE, ...MODELES_KBIS });
  const rien = await demarrer(BASE);
  try {
    const defaut = await srv.get("tache=kbis");
    assert.deepEqual(JSON.parse(defaut.texte).modeles.map((m) => [m.id, m.role]), [["lfm25_2_6b", "defaut"], ["nuextract3", "alternative"]]);
    const texte = await srv.get("tache=kbis&voie=texte");
    assert.equal(JSON.parse(texte.texte).voie, "texte");
    assert.deepEqual(JSON.parse(texte.texte).modeles.map((m) => m.id), ["lfm25_2_6b", "nuextract3"]);
    const agent = await srv.get("tache=kbis&voie=agent");
    assert.deepEqual(JSON.parse(agent.texte), { tache: "kbis", voie: "agent", modeles: [{ id: "nuextract3", libelle: "NuExtract3", description: "Précis mais lent — plusieurs minutes", role: "defaut", lignesMax: null }] });
    for (const r of [defaut, texte, agent]) assert.ok(!/store:|kbis-nuextract3|kbis-historique/.test(r.texte));
    assert.equal((await srv.get("tache=kbis&voie=chat")).status, 400);
    assert.equal((await srv.get("tache=urssaf&voie=agent")).status, 400);
    assert.deepEqual(JSON.parse((await rien.get("tache=kbis&voie=agent")).texte), { tache: "kbis", voie: "agent", modeles: [] });
  } finally {
    await srv.fermer(); await rien.fermer();
  }
});

// ---------------------------------------------------------------------------
// Navigateur : sélecteur par type de fichier, envoi, « lu par »
// ---------------------------------------------------------------------------

const OFFRES = {
  texte: [
    { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "defaut", lignesMax: 800 },
    { id: "nuextract3", libelle: "NuExtract3", description: "Précis mais lent — plusieurs minutes", role: "alternative", lignesMax: null },
  ],
  agent: [{ id: "nuextract3", libelle: "NuExtract3", description: "Précis mais lent — plusieurs minutes", role: "defaut", lignesMax: null }],
};

function selecteur() {
  const classes = new Set(["hidden"]);
  return {
    options: [], value: "", dataset: { modeleSelecteur: "1", voie: "texte" },
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    appendChild(o) { this.options.push(o); },
    set innerHTML(v) { this.options = []; },
  };
}

function navigateur(offres = OFFRES, reponses = []) {
  const demandes = [];
  const envois = [];
  const ctx = {
    state: { values: { stNom: "Sund Industry System" }, dateState: {} },
    getJSON: async (url) => { demandes.push(url); const voie = /voie=(\w+)/.exec(url); return { modeles: offres[voie ? voie[1] : "texte"] || [] }; },
    fetch: async (url, options) => { envois.push(JSON.parse(options.body)); const r = reponses.shift(); return { ok: true, status: 200, json: async () => r }; },
    fileToBase64: async () => "JVBERi0=",
    document: { createElement: () => ({ value: "", textContent: "" }) },
    renderChecklistDocResult: (el) => { el.className = "chk-doc-status ok"; el.textContent = "✅ verdict"; },
    renderControleSirenSiret: () => {}, renderPropositionKbis: () => {}, majNoteCoordonnees: () => {}, renderResultatPartiel: () => {},
    CONTRATS_KBIS_CHAMPS: K, CONTRATS_IMPORT_CHAMPS: CHAMPS,
    encodeURIComponent, Array, Promise, JSON, Error, Object, String,
  };
  vm.createContext(ctx);
  vm.runInContext("const OFFRES_MODELES = {};\n" + ["offresModeles", "voieKbisDuFichier", "preparerSelecteurKbis", "remplirSelecteurModeles", "analyzeChecklistDoc"].map(extraireFonction).join("\n"), ctx);
  return { ctx, demandes, envois };
}

async function analyserKbis(nav, sel, fichier) {
  const servi = { textContent: "" };
  const statusEl = { textContent: "", className: "", parentNode: { querySelector: (s) => (s === "[data-modele-selecteur]" ? sel : s === "[data-modele-servi]" ? servi : null) } };
  await nav.ctx.analyzeChecklistDoc({ id: "kbis", label: "Extrait Kbis" }, fichier, statusEl, { textContent: "📎" });
  return { servi, statusEl };
}

test("voieKbisDuFichier : PDF (type ou nom) -> texte ; image ou inconnu -> agent", () => {
  const { ctx } = navigateur();
  assert.equal(ctx.voieKbisDuFichier({ type: "application/pdf", name: "k.pdf" }), "texte");
  assert.equal(ctx.voieKbisDuFichier({ type: "", name: "KBIS.PDF" }), "texte");
  assert.equal(ctx.voieKbisDuFichier({ type: "image/jpeg", name: "photo.pdf" }), "agent");
  assert.equal(ctx.voieKbisDuFichier({ type: "image/png", name: "k.png" }), "agent");
});

test("sélecteur Kbis : PDF -> offres texte (visible, défaut) ; choix gardé sur la même voie ; photo -> NuExtract3 (masqué, envoyé) ; retour PDF -> défaut présélectionné", async () => {
  const lu = (id, libelle) => ({ issuedDate: "2026-09-04", nameMatches: true, modele: { id, libelle } });
  const nav = navigateur(OFFRES, [lu("lfm25_2_6b", "LFM2.5 2.6B"), lu("nuextract3", "NuExtract3"), lu("nuextract3", "NuExtract3"), lu("lfm25_2_6b", "LFM2.5 2.6B")]);
  const sel = selecteur();
  // Remplissage initial (buildChecklist) : voie texte.
  await nav.ctx.remplirSelecteurModeles(sel, "kbis", "texte");
  assert.equal(sel.value, "lfm25_2_6b");
  assert.equal(sel.classList.contains("hidden"), false);

  const pdf1 = await analyserKbis(nav, sel, { type: "application/pdf", name: "kbis.pdf" });
  assert.equal(nav.envois[0].modele, "lfm25_2_6b");
  assert.equal(pdf1.servi.textContent, "lu par LFM2.5 2.6B");
  assert.deepEqual(clone(nav.ctx.state.dateState.kbis.modele), { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
  assert.equal(nav.ctx.state.dateState.kbis.choixModele, true);

  sel.value = "nuextract3"; // choix de l'utilisateur, même voie
  await analyserKbis(nav, sel, { type: "application/pdf", name: "kbis2.pdf" });
  assert.equal(nav.envois[1].modele, "nuextract3");

  const photo = await analyserKbis(nav, sel, { type: "image/jpeg", name: "kbis.jpg" });
  assert.equal(sel.dataset.voie, "agent");
  assert.equal(nav.envois[2].modele, "nuextract3");
  assert.equal(sel.classList.contains("hidden"), true, "un seul modèle en vision : masqué");
  assert.equal(photo.servi.textContent, "lu par NuExtract3");

  await analyserKbis(nav, sel, { type: "application/pdf", name: "kbis3.pdf" });
  assert.equal(sel.dataset.voie, "texte");
  assert.equal(nav.envois[3].modele, "lfm25_2_6b", "changement de voie : défaut du type de fichier présélectionné");
  assert.deepEqual(nav.demandes, ["/api/modeles?tache=kbis&voie=texte", "/api/modeles?tache=kbis&voie=agent"]);
});

test("sélecteur Kbis sans modèle configuré : aucun `modele` envoyé, résultat gardé à la forme d'avant", async () => {
  const nav = navigateur({ texte: [], agent: [] }, [{ issuedDate: "2026-09-04", nameMatches: true }, { issuedDate: "2026-09-04", nameMatches: true }]);
  const sel = selecteur();
  for (const fichier of [{ type: "application/pdf", name: "k.pdf" }, { type: "image/png", name: "k.png" }]) {
    const { servi } = await analyserKbis(nav, sel, fichier);
    assert.equal(servi.textContent, "");
  }
  assert.ok(nav.envois.every((c) => !Object.hasOwn(c, "modele")));
  assert.equal(Object.hasOwn(nav.ctx.state.dateState.kbis, "choixModele"), false);
});

test("buildChecklist : le Kbis a son sélecteur, rempli pour la voie texte avant tout dépôt", () => {
  const corpsFn = extraireFonction("buildChecklist");
  assert.match(corpsFn, /it\.id === "urssaf" \|\| it\.id === "kbis"/);
  assert.match(corpsFn, /selModele\.dataset\.voie = "texte";\s*remplirSelecteurModeles\(selModele, "kbis", "texte"\)/);
});

test("résultat partiel, Kbis + modèle choisi : champ du verdict perdu -> ⛔ « lecture non retenue » ; sans choix -> ligne seule", () => {
  const ctx = { CONTRATS_IMPORT_CHAMPS: CHAMPS, document: { createElement: () => ({ className: "", textContent: "" }) } };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("renderResultatPartiel"), ctx);
  const rendre = (res) => {
    const el = { className: "chk-doc-status ok", textContent: "✅ verdict", enfants: [], appendChild(e) { this.enfants.push(e); } };
    ctx.renderResultatPartiel(el, res, "kbis");
    return el;
  };
  for (const champ of ["company_name", "issued_date", "siren", "siret_siege"]) {
    const el = rendre({ partiel: [{ champ, raison: "boucle" }], choixModele: true });
    assert.equal(el.className, "chk-doc-status err", champ);
    assert.match(el.textContent, /^⛔ Lecture non retenue — résultat partiel du modèle choisi sur : /);
    assert.equal(rendre({ partiel: [{ champ, raison: "boucle" }] }).textContent, "✅ verdict", champ);
  }
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

function poster(port, body) {
  return new Promise((resolve, reject) => {
    const donnees = Buffer.from(JSON.stringify(body));
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

test("route /api/document/analyze : PDF texte + LFM2.5 2.6B et scan + NuExtract3 -> même proposition Kbis, verdict SIREN, « lu par » ; scan + LFM -> 400 `scan`", async () => {
  const ENV = { ...BASE, ...MODELES_KBIS };
  const envAvant = {};
  for (const k of Object.keys(ENV)) { envAvant[k] = process.env[k]; process.env[k] = ENV[k]; }
  const fetchAvant = globalThis.fetch;
  const d = docie();
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(ENV.DOCIE_BASE_URL)) throw new Error("appel réseau inattendu : " + url);
    return d.fetchImpl(url, options);
  };
  const app = express();
  app.use(express.json({ limit: "30mb" }));
  // eslint-disable-next-line no-new-func
  new Function("app", "analyzeDocument", "console", routeAnalyse())(app, analyzeDocument, { error: () => {} });
  const serveur = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = serveur.address().port;
    const texte = await poster(port, corps(await pdfTexte(), { modele: "lfm25_2_6b" }));
    const vision = await poster(port, corps(await pdfScanne(), { modele: "nuextract3" }));
    assert.deepEqual(d.appels.map((a) => a.url), [URL_TEXTE, urlAgent("kbis-nuextract3")]);
    assert.equal(texte.status, 200);
    assert.equal(vision.status, 200);
    assert.deepEqual(texte.body.modele, { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" });
    assert.deepEqual(vision.body.modele, { id: "nuextract3", libelle: "NuExtract3" });
    assert.equal(texte.body.controleSirenSiret.siren.statut, "valide");
    const prop = (b) => K.proposer(K.extraire(b), b.nameMatches, {}, K.controleCompact(b));
    assert.deepEqual(prop(texte.body), prop(vision.body));
    assert.deepEqual(prop(texte.body).champs.map((c) => c.cle).sort(), ["stAdresse", "stFormeJuridique", "stRepresentant", "stSiren", "stSiret"]);
    const refus = await poster(port, corps(await pdfScanne(), { modele: "lfm25_2_6b" }));
    assert.equal(refus.status, 400);
    assert.equal(refus.body.error, choix.MESSAGES_CHOIX.scan);
    assert.equal(d.appels.length, 2);
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
    globalThis.fetch = fetchAvant;
    for (const k of Object.keys(ENV)) {
      if (envAvant[k] === undefined) delete process.env[k]; else process.env[k] = envAvant[k];
    }
  }
});

// ---------------------------------------------------------------------------
// Déploiement : chaque variable du Kbis atteint le conteneur contrats
// ---------------------------------------------------------------------------

// Variables que la tâche `kbis` du catalogue lit (toutes voies, défaut et
// alternative), plus l'agent d'avant le catalogue.
function variablesKbis() {
  const cat = CATALOGUE.chargerCatalogue();
  const noms = new Set(["DOCIE_AGENT_KBIS"]);
  for (const [voie, v] of Object.entries(cat.taches.kbis.voies)) {
    for (const role of ["defaut", "alternative"]) if (v[role]) noms.add(CATALOGUE.nomVariable(voie, "kbis", v[role].modele));
  }
  return [...noms].sort();
}

function blocService(texte, service) {
  const lignes = texte.split(/\r?\n/);
  const debut = lignes.findIndex((l) => l === "  " + service + ":");
  assert.ok(debut !== -1, "service " + service + " introuvable");
  const fin = lignes.findIndex((l, i) => i > debut && /^ {0,2}\S/.test(l));
  return lignes.slice(debut, fin === -1 ? undefined : fin).join("\n");
}

test("compose et .env.example : chaque variable du Kbis (catalogue) est transmise au conteneur contrats et documentée", () => {
  const noms = variablesKbis();
  assert.deepEqual(noms, ["DOCIE_AGENT_KBIS", "DOCIE_AGENT_KBIS_NUEXTRACT3", "DOCIE_MODELE_LFM25_2_6B", "DOCIE_MODELE_NUEXTRACT3"]);
  for (const [fichier, service] of [["docker-compose.yml", "contrats"], ["docker-compose.local.yml", "contrats"], [path.join("contrats", "docker-compose.yml"), "adbi-contrats"]]) {
    const bloc = blocService(fs.readFileSync(path.join(RACINE, fichier), "utf8"), service);
    for (const nom of noms) assert.ok(bloc.includes("      " + nom + ": ${" + nom + ":-}"), fichier + " : " + nom);
  }
  for (const fichier of [".env.example", path.join("contrats", ".env.example")]) {
    const texte = fs.readFileSync(path.join(RACINE, fichier), "utf8");
    for (const nom of noms) assert.match(texte, new RegExp("^" + nom + "=", "m"), fichier + " : " + nom);
  }
});
