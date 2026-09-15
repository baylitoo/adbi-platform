"use strict";
// Chargeur Node du catalogue des modèles (#194). La table elle-même est
// vérifiée contre #194 par test_catalogue.py (avec la parité des deux portages).
// Lancement : node --test document-parsing/models/tests/catalogue.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const cat = require("../catalogue");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "lignes_non_vides.json"), "utf8"));
const ENV_CONTRAT = { DOCIE_MODELE_NUEXTRACT3: "store:nuextract3", DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
const ids = (offres) => offres.map((o) => o.id);

test("sans variable configurée : aucune offre, pour toutes les tâches et voies", () => {
  const c = cat.chargerCatalogue();
  for (const [tache, t] of Object.entries(c.taches)) {
    for (const voie of Object.keys(t.voies)) assert.deepEqual(cat.modelesOfferts(tache, voie, { env: {} }), [], tache + "/" + voie);
  }
  // Une voie absente de la tâche (contrat par agent) : liste vide, pas d'erreur.
  assert.deepEqual(cat.modelesOfferts("contract", "agent", { env: ENV_CONTRAT }), []);
});

test("défaut d'abord, identifiants résolus depuis l'environnement (après trim), variables nommées", () => {
  const offres = cat.modelesOfferts("contract", "texte", {
    env: { DOCIE_MODELE_LFM25_2_6B: " store:lfm2.5-2.6b ", DOCIE_MODELE_NUEXTRACT3: "store:nuextract3" },
  });
  assert.deepEqual(offres.map((o) => [o.id, o.role, o.identifiant, o.variable, o.libelle]), [
    ["nuextract3", "defaut", "store:nuextract3", "DOCIE_MODELE_NUEXTRACT3", "NuExtract3"],
    ["lfm25_2_6b", "alternative", "store:lfm2.5-2.6b", "DOCIE_MODELE_LFM25_2_6B", "LFM2.5 2.6B"],
  ]);
  assert.equal(offres[0].description, "Précis mais lent — plusieurs minutes");
  assert.deepEqual(offres[1].limites, { lignes_non_vides_max: 800 });
});

test("un modèle sans identifiant n'est pas proposé ; l'ancien DOCIE_AGENT_<TYPE> n'en propose aucun", () => {
  assert.deepEqual(ids(cat.modelesOfferts("contract", "texte", { env: { DOCIE_MODELE_LFM25_2_6B: "store:x" } })), ["lfm25_2_6b"]);
  assert.deepEqual(cat.modelesOfferts("kbis", "agent", { env: { DOCIE_AGENT_KBIS: "agent_kbis" } }), []);
  assert.deepEqual(ids(cat.modelesOfferts("kbis", "agent", { env: { DOCIE_AGENT_KBIS_NUEXTRACT3: "kbis_n3" } })), ["nuextract3"]);
  assert.equal(cat.nomVariable("agent", "kbis", "nuextract3"), "DOCIE_AGENT_KBIS_NUEXTRACT3");
});

test("URSSAF : LFM2.5 2.6B par défaut, 350M en alternative", () => {
  const env = { DOCIE_MODELE_LFM25_350M: "store:lfm2.5-350m", DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" };
  assert.deepEqual(cat.modelesOfferts("urssaf", "texte", { env }).map((o) => [o.id, o.role]),
    [["lfm25_2_6b", "defaut"], ["lfm25_350m", "alternative"]]);
});

test("limite de lignes : 800 -> LFM2.5 proposé, 801 -> retiré ; document inconnu -> non évalué", () => {
  assert.deepEqual(ids(cat.modelesOfferts("contract", "texte", { env: ENV_CONTRAT, document: { lignesNonVides: 800 } })), ["nuextract3", "lfm25_2_6b"]);
  assert.deepEqual(ids(cat.modelesOfferts("contract", "texte", { env: ENV_CONTRAT, document: { lignesNonVides: 801 } })), ["nuextract3"]);
  assert.deepEqual(ids(cat.modelesOfferts("contract", "texte", { env: ENV_CONTRAT })), ["nuextract3", "lfm25_2_6b"]);
});

test("limite de pages (vision) : 8 -> proposé, 9 -> retiré", () => {
  const env = { DOCIE_AGENT_KBIS_NUEXTRACT3: "kbis_n3" };
  assert.equal(cat.modelesOfferts("kbis", "agent", { env, document: { pages: 8 } }).length, 1);
  assert.deepEqual(cat.modelesOfferts("kbis", "agent", { env, document: { pages: 9 } }), []);
});

test("choisirModele : jamais de substitution — non proposé, limite dépassée, identifiant du navigateur jamais recopié", () => {
  assert.throws(() => cat.choisirModele("contract", "texte", { env: { DOCIE_MODELE_NUEXTRACT3: "store:n" }, modele: "lfm25_2_6b" }),
    (e) => e.name === "CatalogueError" && e.code === "modele_non_propose" && /LFM2\.5 2\.6B/.test(e.message));
  assert.throws(() => cat.choisirModele("contract", "texte", { env: ENV_CONTRAT, document: { lignesNonVides: 801 }, modele: "lfm25_2_6b" }),
    (e) => e.code === "limite" && /800/.test(e.message) && /801/.test(e.message));
  assert.throws(() => cat.choisirModele("contract", "texte", { env: ENV_CONTRAT, modele: "<img src=x>" }),
    (e) => e.code === "modele_non_propose" && !e.message.includes("<img"));
  const ok = cat.choisirModele("contract", "texte", { env: ENV_CONTRAT, document: { lignesNonVides: 800 }, modele: "lfm25_2_6b" });
  assert.equal(ok.identifiant, "store:lfm2.5-2.6b");
});

test("identifiant mal formé : erreur `configuration` qui nomme la variable, jamais la valeur", () => {
  const cas = [
    ["contract", "texte", "DOCIE_MODELE_NUEXTRACT3", "store:a\nb"],
    ["contract", "texte", "DOCIE_MODELE_NUEXTRACT3", "é".repeat(65)],
    ["kbis", "agent", "DOCIE_AGENT_KBIS_NUEXTRACT3", "store:nuextract3"],
  ];
  for (const [tache, voie, variable, valeur] of cas) {
    assert.throws(() => cat.modelesOfferts(tache, voie, { env: { [variable]: valeur } }),
      (e) => e.code === "configuration" && e.message.includes(variable) && !e.message.includes(valeur.trim()), variable);
  }
});

test("tâche inconnue : erreur nommée", () => {
  assert.throws(() => cat.modelesOfferts("devis", "texte", { env: {} }), (e) => e.code === "tache");
});

test("usage : un modèle sans l'étiquette de la tâche n'est jamais proposé, même configuré", () => {
  const faux = JSON.parse(fs.readFileSync(cat.CHEMIN_CATALOGUE, "utf8"));
  faux.taches.rapprochement.voies.chat.alternative = { modele: "nuextract3" };
  const env = { ADBI_LLM_MODELE_LFM25_2_6B: "lfm", ADBI_LLM_MODELE_NUEXTRACT3: "n3" };
  assert.deepEqual(ids(cat.modelesOfferts("rapprochement", "chat", { env, catalogue: faux })), ["lfm25_2_6b"]);
});

test("modeleServi : rapproché avec ou sans store:, sinon nom brut, null si non rapporté", () => {
  assert.deepEqual(cat.modeleServi("contract", "texte", { env: ENV_CONTRAT, metadata: { model: "nuextract3" } }),
    { id: "nuextract3", libelle: "NuExtract3", identifiant: "nuextract3" });
  assert.deepEqual(cat.modeleServi("contract", "texte", { env: ENV_CONTRAT, metadata: { model: "store:lfm2.5-2.6b" } }).id, "lfm25_2_6b");
  assert.deepEqual(cat.modeleServi("contract", "texte", { env: ENV_CONTRAT, metadata: { model: "autre" } }),
    { id: null, libelle: "autre", identifiant: "autre" });
  assert.equal(cat.modeleServi("contract", "texte", { env: ENV_CONTRAT, metadata: { model: null } }), null);
  assert.equal(cat.modeleServi("kbis", "agent", { env: { DOCIE_AGENT_KBIS_NUEXTRACT3: "k3" }, metadata: { agent: "k3", model: "x" } }).id, "nuextract3");
});

test("lignes non vides : cas de la fixture partagée", () => {
  for (const c of FIXTURE.cas) assert.equal(cat.compterLignesNonVides(c.texte), c.lignes, c.nom);
});

test("lignes non vides : chaque blanc Python seul = 0, chaque séparateur coupe, tout autre caractère du BMP = 1 bloc", () => {
  const blancs = new Set(FIXTURE.blancs);
  const separateurs = new Set(FIXTURE.separateurs);
  for (const b of blancs) {
    assert.equal(cat.compterLignesNonVides(b), 0, "blanc U+" + b.codePointAt(0).toString(16));
    assert.equal(cat.compterLignesNonVides("a" + b + "b"), separateurs.has(b) ? 2 : 1, "U+" + b.codePointAt(0).toString(16));
  }
  for (let i = 0; i <= 0xffff; i++) {
    if (i >= 0xd800 && i <= 0xdfff) continue;
    const c = String.fromCharCode(i);
    if (blancs.has(c)) continue;
    assert.equal(cat.compterLignesNonVides(c), 1, "U+" + i.toString(16));
  }
  assert.equal(cat.compterLignesNonVides("\u{1F4C4}"), 1);
  assert.equal(cat.compterLignesNonVides("ligne\n".repeat(801)), 801);
});
