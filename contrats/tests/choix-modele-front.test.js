"use strict";
// Sélecteurs de modèle (#194) côté navigateur : les VRAIES fonctions de
// public/app.js (remplirSelecteurModeles, preremplirImportDepuisPdf,
// analyzeChecklistDoc), extraites telles quelles et exécutées dans un bac à
// sable vm avec des bouchons DOM/fetch — même technique que
// preremplissage-front.test.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CHAMPS = require("../public/import-champs");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function extraireFonction(nom) {
  const m = new RegExp("(?:async )?function " + nom + "\\(").exec(APP_JS);
  assert.ok(m, nom + " introuvable dans app.js");
  const reste = APP_JS.slice(m.index);
  const fin = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(fin, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, fin.index + fin[0].length);
}

function faux(extra = {}) {
  const classes = new Set();
  return Object.assign({
    textContent: "", className: "", value: "", options: [], disabled: false, dataset: {},
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c), add: (c) => classes.add(c) },
    appendChild(enfant) { this.options.push(enfant); },
    set innerHTML(v) { this.options = []; },
  }, extra);
}

const OFFRES_CONTRAT = [
  { id: "nuextract3", libelle: "NuExtract3", description: "Précis mais lent — plusieurs minutes", role: "defaut", lignesMax: null },
  { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "alternative", lignesMax: 800 },
];
const OFFRES_URSSAF = [
  { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "defaut", lignesMax: 800 },
  { id: "lfm25_350m", libelle: "LFM2.5 350M", description: "Très rapide — documents simples", role: "alternative", lignesMax: 800 },
];

async function remplir(offres) {
  const demandes = [];
  const ctx = {
    getJSON: async (url) => { demandes.push(url); if (offres instanceof Error) throw offres; return { modeles: offres }; },
    document: { createElement: () => ({ value: "", textContent: "" }) },
    encodeURIComponent, Array, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext("const OFFRES_MODELES = {};\n" + extraireFonction("offresModeles") + extraireFonction("remplirSelecteurModeles"), ctx);
  const sel = faux();
  await vm.runInContext("(s) => remplirSelecteurModeles(s, 'contract')", ctx)(sel);
  return { sel, demandes };
}

test("sélecteur : deux modèles -> visible, défaut présélectionné, libellés du catalogue, plafond affiché s'il distingue", async () => {
  const { sel, demandes } = await remplir(OFFRES_CONTRAT);
  assert.deepEqual(demandes, ["/api/modeles?tache=contract"]);
  assert.deepEqual(sel.options.map((o) => [o.value, o.textContent]), [
    ["nuextract3", "NuExtract3 — Précis mais lent — plusieurs minutes"],
    ["lfm25_2_6b", "LFM2.5 2.6B — Rapide (800 lignes au plus)"],
  ]);
  assert.equal(sel.value, "nuextract3");
  assert.equal(sel.classList.contains("hidden"), false);
});

test("sélecteur : un seul modèle -> masqué mais valorisé ; aucun, ou lecture en échec -> masqué et vide", async () => {
  const un = await remplir(OFFRES_CONTRAT.slice(0, 1));
  assert.equal(un.sel.classList.contains("hidden"), true);
  assert.equal(un.sel.value, "nuextract3");
  for (const offres of [[], new Error("HTTP 500")]) {
    const { sel } = await remplir(offres);
    assert.equal(sel.options.length, 0);
    assert.equal(sel.classList.contains("hidden"), true);
  }
});

test("sélecteur URSSAF : plafond commun aux deux modèles -> non affiché", async () => {
  const { sel } = await remplir(OFFRES_URSSAF);
  assert.deepEqual(sel.options.map((o) => o.textContent), ["LFM2.5 2.6B — Rapide", "LFM2.5 350M — Très rapide — documents simples"]);
});

// --- pré-remplissage de contrat ------------------------------------------------
const rep = (status, corps) => ({ ok: status >= 200 && status < 300, status, json: async () => corps });

async function preremplir(selecteur, resultat) {
  const elements = {};
  const el = (id, extra = {}) => (elements[id] = Object.assign({ id, textContent: "", className: "", value: "" }, extra));
  el("impPreremplirStatus");
  el("impPreremplir", { textContent: "🪄 Pré-remplir depuis le PDF", disabled: false });
  el("impFichier", { files: [{ type: "application/pdf" }] });
  el("impType", { value: "sous-traitance" });
  el("impAutres", { open: false });
  if (selecteur) elements.impModele = selecteur;
  const appels = [];
  const file = [rep(202, { tache: "t-1" }), resultat];
  const ctx = {
    $: (s) => elements[s.replace(/^#/, "")],
    document: { getElementById: (id) => elements[id] || null },
    fetch: async (url, opts) => { appels.push({ url, opts }); return file.shift(); },
    setTimeout: (fn) => fn(),
    fileToBase64: async () => "JVBERi0=",
    construireAutresChampsImport: () => {},
    afficherAvertissementsImport: () => {},
    // Marques SIREN/SIRET (#204) : hors sujet ici, bouchon neutre.
    marquerChampsImportAVerifier: () => {},
    CONTRATS_IMPORT_CHAMPS: CHAMPS,
    encodeURIComponent, Promise, Error, JSON, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("preremplirImportDepuisPdf"), ctx);
  await vm.runInContext("preremplirImportDepuisPdf()", ctx);
  return { corps: JSON.parse(appels[0].opts.body), statut: elements.impPreremplirStatus };
}

const TERMINEE = (modele) => rep(200, { etat: "terminee", resultat: { values: { numeroContrat: "1", stNom: "X" }, warnings: [], errors: [], ok: true, ...(modele ? { modele } : {}) } });

test("pré-remplissage : modèle choisi envoyé, modèle servi affiché discrètement dans la ligne d'état", async () => {
  const sel = { options: [{}, {}], value: "lfm25_2_6b" };
  const { corps, statut } = await preremplir(sel, TERMINEE({ id: "lfm25_2_6b", libelle: "LFM2.5 2.6B" }));
  assert.equal(corps.modele, "lfm25_2_6b");
  assert.equal(statut.textContent, "✓ Champs pré-remplis depuis le PDF — à relire avant import — lu par LFM2.5 2.6B");
});

test("pré-remplissage sans modèle proposé (sélecteur vide ou absent) : corps et ligne d'état d'avant", async () => {
  for (const sel of [{ options: [], value: "" }, null]) {
    const { corps, statut } = await preremplir(sel, TERMINEE(null));
    assert.deepEqual(Object.keys(corps).sort(), ["dataBase64", "mimeType"]);
    assert.equal(statut.textContent, "✓ Champs pré-remplis depuis le PDF — à relire avant import");
  }
});

test("pré-remplissage, modèle choisi en échec : message nommé de la tâche, rien d'autre", async () => {
  const sel = { options: [{}], value: "nuextract3" };
  const message = "Document sans couche texte (scan ou image) : le modèle choisi ne peut pas le lire, saisie manuelle requise.";
  const { statut } = await preremplir(sel, rep(200, { etat: "echec", erreur: { code: "scan", message } }));
  assert.equal(statut.textContent, "Pré-remplissage indisponible : " + message);
  assert.equal(statut.className, "status err");
});

// --- analyse URSSAF de la checklist ----------------------------------------------
async function analyser({ selecteur, reponse }) {
  const servi = { textContent: "lu par ancien" };
  const statusEl = { textContent: "", className: "", parentNode: {
    querySelector: (s) => (s === "[data-modele-selecteur]" ? selecteur : s === "[data-modele-servi]" ? servi : null),
  } };
  const btn = { textContent: "📎 Analyser", disabled: false };
  const appels = [];
  const state = { values: { stNom: "" }, dateState: {} };
  const ctx = {
    state, fetch: async (url, opts) => { appels.push(JSON.parse(opts.body)); return reponse; },
    fileToBase64: async () => "JVBERi0=",
    renderChecklistDocResult: (el) => { el.textContent = "rendu"; },
    renderPropositionKbis: () => {}, majNoteCoordonnees: () => {},
    // Verdict SIREN/SIRET (#204) : hors sujet ici, bouchons neutres.
    renderControleSirenSiret: () => {},
    // Résultat partiel (#203) : hors sujet ici, bouchon neutre.
    renderResultatPartiel: () => {},
    CONTRATS_KBIS_CHAMPS: { extraire: () => ({}), controleCompact: () => null },
    JSON, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("analyzeChecklistDoc"), ctx);
  await vm.runInContext("(i, f, s, b) => analyzeChecklistDoc(i, f, s, b)", ctx)(
    { id: "urssaf", label: "URSSAF" }, { type: "application/pdf", name: "a.pdf" }, statusEl, btn);
  return { corps: appels[0], servi, statusEl, state };
}

test("URSSAF : modèle choisi envoyé, « lu par » affiché et gardé avec le résultat", async () => {
  const { corps, servi, state } = await analyser({
    selecteur: { options: [{}, {}], value: "lfm25_350m" },
    reponse: rep(200, { issuedDate: "2026-03-04", modele: { id: "lfm25_350m", libelle: "LFM2.5 350M" } }),
  });
  assert.equal(corps.modele, "lfm25_350m");
  assert.equal(servi.textContent, "lu par LFM2.5 350M");
  assert.deepEqual(state.dateState.urssaf.modele, { id: "lfm25_350m", libelle: "LFM2.5 350M" });
});

test("URSSAF sans sélecteur rempli : aucun `modele` envoyé ; échec d'un modèle choisi : erreur affichée, « lu par » effacé", async () => {
  const sans = await analyser({ selecteur: { options: [], value: "" }, reponse: rep(200, { issuedDate: "" }) });
  assert.equal(Object.hasOwn(sans.corps, "modele"), false);
  assert.equal(sans.servi.textContent, "");
  const echec = await analyser({
    selecteur: { options: [{}], value: "lfm25_2_6b" },
    reponse: rep(400, { error: "Le service d'extraction a répondu en erreur." }),
  });
  assert.equal(echec.statusEl.textContent, "Erreur : Le service d'extraction a répondu en erreur.");
  assert.equal(echec.servi.textContent, "");
});
