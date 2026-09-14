"use strict";
// Tests du vrai public/app.js::preremplirImportDepuisPdf (démarrer -> interroger,
// issue #196). La fonction est extraite TELLE QUELLE d'app.js et exécutée dans
// un bac à sable (vm), avec des bouchons pour le DOM, fetch et setTimeout
// (immédiat : aucune attente réelle). Même technique que import-champs.test.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CHAMPS = require("../public/import-champs");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function extraireFonction(nom) {
  const debut = APP_JS.indexOf("async function " + nom + "(");
  assert.ok(debut !== -1, nom + " introuvable dans app.js");
  const reste = APP_JS.slice(debut);
  const m = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(m, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, m.index + m[0].length);
}

function reponse(status, corps) {
  return { ok: status >= 200 && status < 300, status, json: async () => corps };
}

/**
 * Lance preremplirImportDepuisPdf avec une suite de réponses : chaque élément
 * est une réponse (ou une Error, pour un échec réseau) servie dans l'ordre.
 */
async function lancer(reponses) {
  const elements = {};
  const el = (id, extra = {}) => (elements[id] = Object.assign({ id, textContent: "", className: "", value: "" }, extra));
  el("impPreremplirStatus");
  el("impPreremplir", { textContent: "🪄 Pré-remplir depuis le PDF", disabled: false });
  el("impFichier", { files: [{ type: "application/pdf" }] });
  el("impType", { value: "sous-traitance" });
  el("impAutres", { open: false });
  for (const [, id] of CHAMPS.CHAMPS_PRINCIPAUX) el(id);
  for (const c of CHAMPS.CHAMPS_AUTRES) el(c.id);

  const appels = [];
  const etats = [];
  const avertissements = [];
  const file = [...reponses];
  const ctx = {
    $: (sel) => elements[sel.replace(/^#/, "")],
    document: { getElementById: (id) => elements[id] || null },
    fetch: async (url, opts) => {
      appels.push({ url, opts });
      etats.push(elements.impPreremplirStatus.textContent);
      const r = file.shift();
      if (!r) throw new Error("appel fetch non prévu : " + url);
      if (r instanceof Error) throw r;
      return r;
    },
    setTimeout: (fn, ms) => { ctx.delais.push(ms); fn(); },
    delais: [],
    fileToBase64: async () => "JVBERi0=",
    construireAutresChampsImport: () => {},
    afficherAvertissementsImport: (w) => avertissements.push(w),
    CONTRATS_IMPORT_CHAMPS: CHAMPS,
    encodeURIComponent,
    Promise, Error, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("preremplirImportDepuisPdf"), ctx);
  await vm.runInContext("preremplirImportDepuisPdf()", ctx);
  return { elements, appels, etats, avertissements, delais: ctx.delais };
}

const TACHE = "0b3f6a52-6f1e-4a39-9d2a-3c1f6a0e9b11";

test("202 -> en_attente -> extraction -> terminee : étape affichée, formulaire rempli comme avant, tous les avertissements", async () => {
  const warnings = ["a", "b", "c", "d", "e"];
  const values = { numeroContrat: "02-09-2026", stNom: "ADCONSI", stSiren: "941091316", delaiPaiement: "45" };
  const { elements, appels, etats, avertissements, delais } = await lancer([
    reponse(202, { tache: TACHE }),
    reponse(200, { etat: "en_cours", etape: "en_attente", position: 2, debut: "x" }),
    reponse(200, { etat: "en_cours", etape: "extraction", debut: "x" }),
    reponse(200, { etat: "terminee", resultat: { requestId: null, values, warnings, errors: [], ok: true }, debut: "x", fin: "y" }),
  ]);
  assert.equal(appels[0].url, "/api/contracts/importer/extraire");
  assert.equal(appels[0].opts.method, "POST");
  assert.deepEqual(appels.slice(1).map((a) => a.url), Array(3).fill("/api/taches/" + TACHE));
  assert.deepEqual(delais, [2000, 2000, 2000]);
  // Ce que l'utilisateur voyait au moment de chaque relevé suivant.
  assert.equal(etats[2], "⏳ En attente d'une extraction libre (position 2)…");
  assert.equal(etats[3], "🔎 Extraction DocIE en cours…");

  assert.equal(elements.impNumero.value, "02-09-2026");
  assert.equal(elements.impSt.value, "ADCONSI");
  const siren = CHAMPS.CHAMPS_AUTRES.find((c) => c.key === "stSiren");
  assert.equal(elements[siren.id].value, "941091316");
  assert.equal(elements.impAutres.open, true);
  assert.deepEqual(avertissements, [warnings]);
  assert.equal(elements.impPreremplirStatus.className, "status ok");
  assert.equal(elements.impPreremplirStatus.textContent, "✓ Champs pré-remplis depuis le PDF — à relire avant import (5 avertissements ci-dessous)");
  assert.equal(elements.impPreremplir.disabled, false);
  assert.equal(elements.impPreremplir.textContent, "🪄 Pré-remplir depuis le PDF");
});

test("terminee avec errors : ligne d'état « à vérifier », comme avant", async () => {
  const { elements } = await lancer([
    reponse(202, { tache: TACHE }),
    reponse(200, { etat: "terminee", resultat: { values: {}, warnings: [], errors: ["Le numéro du contrat est requis."], ok: false } }),
  ]);
  assert.equal(elements.impPreremplirStatus.className, "status warn");
  assert.equal(elements.impPreremplirStatus.textContent, "⚠️ Champs pré-remplis à vérifier — Le numéro du contrat est requis.");
});

test("echec : message nommé affiché, formulaire intact, aucune nouvelle tentative", async () => {
  const { elements, appels, avertissements } = await lancer([
    reponse(202, { tache: TACHE }),
    reponse(200, { etat: "echec", erreur: { code: "loading", message: "Modèle en cours de chargement, réessayez dans ~42 s.", eta_seconds: 42 } }),
  ]);
  assert.equal(appels.length, 2);
  assert.equal(elements.impPreremplirStatus.className, "status err");
  assert.equal(elements.impPreremplirStatus.textContent, "Pré-remplissage indisponible : Modèle en cours de chargement, réessayez dans ~42 s.");
  assert.equal(elements.impNumero.value, "");
  // Tableau créé dans le bac à sable vm (autre royaume) : on compare la forme.
  assert.equal(JSON.stringify(avertissements), "[[]]");
  assert.equal(elements.impPreremplir.disabled, false);
});

test("refus au démarrage (400 disabled, 503) : message du serveur, aucune interrogation", async () => {
  for (const [status, error] of [[400, "Extraction DocIE désactivée (DOCIE_EXTRACTION_ENABLED=false) — saisie manuelle requise."], [503, "Trop de pré-remplissages en attente (20 maximum) : réessayez dans un instant."]]) {
    const { elements, appels } = await lancer([reponse(status, { error, code: "disabled" })]);
    assert.equal(appels.length, 1);
    assert.equal(elements.impPreremplirStatus.textContent, "Pré-remplissage indisponible : " + error);
  }
});

test("404 pendant le suivi (tâche expirée ou service redémarré) : message du serveur", async () => {
  const { elements } = await lancer([
    reponse(202, { tache: TACHE }),
    reponse(404, { error: "Tâche inconnue ou expirée : relancez le pré-remplissage." }),
  ]);
  assert.equal(elements.impPreremplirStatus.textContent, "Pré-remplissage indisponible : Tâche inconnue ou expirée : relancez le pré-remplissage.");
});

test("échecs réseau : deux d'affilée sont tolérés, le troisième abandonne", async () => {
  const ok = await lancer([
    reponse(202, { tache: TACHE }),
    new TypeError("Failed to fetch"), new TypeError("Failed to fetch"),
    reponse(200, { etat: "terminee", resultat: { values: { numeroContrat: "N" }, warnings: [], errors: [], ok: true } }),
  ]);
  assert.equal(ok.elements.impNumero.value, "N");
  assert.equal(ok.elements.impPreremplirStatus.className, "status ok");

  const ko = await lancer([
    reponse(202, { tache: TACHE }),
    new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), new TypeError("Failed to fetch"),
  ]);
  assert.equal(ko.appels.length, 4);
  assert.equal(ko.elements.impPreremplirStatus.textContent, "Pré-remplissage indisponible : serveur injoignable pendant l'extraction.");
});

test("plafond : 900 relevés toujours en_cours -> abandon du suivi après 30 minutes", async () => {
  const enCours = reponse(200, { etat: "en_cours", etape: "extraction" });
  const { appels, elements, delais } = await lancer([reponse(202, { tache: TACHE }), ...Array(900).fill(enCours)]);
  assert.equal(appels.length, 901);
  assert.equal(delais.length * 2000, 30 * 60 * 1000);
  assert.equal(elements.impPreremplirStatus.textContent, "Pré-remplissage indisponible : extraction trop longue : abandon du suivi après 30 minutes.");
});
