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
  const debut = APP_JS.search(new RegExp("(async )?function " + nom + "\\("));
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
// Élément simulé : ce que lisent/écrivent les fonctions testées, y compris la
// marque « à vérifier » (classList, aria-invalid, title).
function fauxElement(id, extra = {}) {
  const classes = new Set();
  const attributs = {};
  const e = Object.assign({
    id, textContent: "", className: "", value: "", title: "", ecouteurs: {},
    classList: {
      toggle: (c, oui) => { if (oui) classes.add(c); else classes.delete(c); },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attributs[k] = String(v); },
    removeAttribute: (k) => { delete attributs[k]; if (k === "title") e.title = ""; },
    getAttribute: (k) => (k in attributs ? attributs[k] : null),
    addEventListener: (t, fn) => { e.ecouteurs[t] = fn; },
  }, extra);
  return e;
}

const MARQUAGE = extraireFonction("marquerChampImport") + "\n" + extraireFonction("marquerChampsImportAVerifier") + "\n";

async function lancer(reponses, avantLancement) {
  const elements = {};
  const el = (id, extra = {}) => (elements[id] = fauxElement(id, extra));
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
  if (avantLancement) avantLancement(elements);
  vm.createContext(ctx);
  vm.runInContext(MARQUAGE + extraireFonction("preremplirImportDepuisPdf"), ctx);
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

// ---------------------------------------------------------------------------
// Contrôle de clé SIREN / SIRET (PR #201) dans le pré-remplissage.
// `resultat` est produit par le VRAI lib/docie-contract-import.js (DocIE mocké
// par fetchImpl, aucun réseau), sur chaque cas du jeu d'essai partagé de #201.
// ---------------------------------------------------------------------------
const { extractContractValues } = require("../lib/docie-contract-import");
const RAW_CONTRAT = require(path.join(__dirname, "..", "..", "document-parsing", "mappings", "fixtures", "contract_extraction_sample.json"));
const SIREN_SIRET = require(path.join(__dirname, "..", "..", "document-parsing", "fixtures", "siren_siret.json"));
const { STATUTS } = require("../lib/siren-siret");

async function resultatContrat(siren, siret) {
  const enveloppe = (value) => ({ value, evidence_ids: [], confidence: 0.99 });
  const result = Object.assign({}, RAW_CONTRAT.result, { st_siren: enveloppe(siren), st_siret: enveloppe(siret) });
  const fetchImpl = async () => new Response(JSON.stringify({
    id: "chatcmpl-test", model: "contract-agent-test",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
  }), { status: 200 });
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret", DOCIE_AGENT_CONTRACT: "contract-agent-test",
  };
  return extractContractValues({ dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" }, { env, fetchImpl });
}

const ID_DE = { siren: "impStSiren", siret: "impStSiret" };
const marque = (e) => ({ invalid: e.classList.contains("invalid"), aria: e.getAttribute("aria-invalid"), title: e.title });

test("jeu d'essai #201 entier : champ rempli, marqué SSI statut ni valide ni absent, ligne d'état qui nomme le problème", async () => {
  const vus = { siren: new Set(), siret: new Set() };
  for (const cas of SIREN_SIRET.cas) {
    const resultat = await resultatContrat(cas.siren, cas.siret);
    const quoi = JSON.stringify([cas.siren, cas.siret]);
    assert.equal(JSON.stringify(resultat.errors), "[]", quoi + " : précondition, aucune erreur bloquante");
    const { elements } = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "terminee", resultat })]);
    const aVerifier = [];
    for (const champ of ["siren", "siret"]) {
      const statut = cas["statut_" + champ];
      vus[champ].add(statut);
      const e = elements[ID_DE[champ]];
      // Le champ reste rempli (valeur telle que lue), l'utilisateur relit avant import.
      assert.equal(e.value, resultat.values[champ === "siren" ? "stSiren" : "stSiret"].trim() ? resultat.values[champ === "siren" ? "stSiren" : "stSiret"] : "", quoi);
      if (statut === "valide" || statut === "absent") {
        assert.deepEqual(marque(e), { invalid: false, aria: null, title: "" }, quoi + " " + champ);
      } else {
        const libelle = champ.toUpperCase();
        aVerifier.push(libelle + " : " + CHAMPS.MESSAGES_STATUT[statut]);
        assert.deepEqual(marque(e), { invalid: true, aria: "true", title: libelle + " : " + CHAMPS.MESSAGES_STATUT[statut] }, quoi + " " + champ);
      }
    }
    const st = elements.impPreremplirStatus;
    const n = resultat.warnings.length;
    const notes = n ? " (" + n + " avertissement" + (n > 1 ? "s" : "") + " ci-dessous)" : "";
    if (aVerifier.length) {
      assert.equal(st.className, "status warn", quoi);
      assert.equal(st.textContent, "⚠️ Champs pré-remplis à vérifier — " + aVerifier.join(" ; ") + " (champ signalé)" + notes, quoi);
      assert.equal(elements.impAutres.open, true);
    } else {
      assert.equal(st.className, "status ok", quoi);
      assert.equal(st.textContent, "✓ Champs pré-remplis depuis le PDF — à relire avant import" + notes, quoi);
    }
  }
  for (const champ of ["siren", "siret"]) assert.deepEqual([...vus[champ]].sort(), [...STATUTS].sort(), champ + " : les 5 statuts couverts");
});

test("drapeau absent (réponse d'avant #201) : même numéro faux, AUCUNE marque, ligne d'état exactement comme avant", async () => {
  const resultat = await resultatContrat("123456789", null);
  assert.equal(resultat.controleSirenSiret.siren.statut, "cle_invalide", "précondition");
  const avecDrapeau = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "terminee", resultat })]);
  const ancien = Object.assign({}, resultat);
  delete ancien.controleSirenSiret;
  const sans = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "terminee", resultat: ancien })]);
  assert.equal(sans.elements.impStSiren.value, "123456789");
  assert.deepEqual(marque(sans.elements.impStSiren), { invalid: false, aria: null, title: "" });
  assert.equal(sans.elements.impPreremplirStatus.className, "status ok");
  assert.equal(sans.elements.impPreremplirStatus.textContent, "✓ Champs pré-remplis depuis le PDF — à relire avant import (2 avertissements ci-dessous)");
  // Contraste avec le drapeau présent.
  assert.equal(avecDrapeau.elements.impPreremplirStatus.className, "status warn");
  assert.equal(marque(avecDrapeau.elements.impStSiren).invalid, true);
  // Formes illisibles du drapeau : pas d'exception, rien de signalé.
  for (const drapeau of [null, "valide", 42]) {
    const r = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "terminee", resultat: Object.assign({}, ancien, { controleSirenSiret: drapeau }) })]);
    assert.equal(r.elements.impPreremplirStatus.className, "status ok", JSON.stringify(drapeau));
  }
});

test("errors bloquantes ET SIREN invalide : ligne « à vérifier » qui nomme les deux ; statut inconnu -> signalé (échec fermé)", async () => {
  const { elements } = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "terminee", resultat: {
    values: { stSiren: "941091316", stSiret: "94109131600013" }, warnings: [], errors: ["Le numéro du contrat est requis."], ok: false,
    controleSirenSiret: { siren: { valeur: "941091316", chiffres: "941091316", statut: "statut_futur" }, siret: { valeur: "94109131600013", chiffres: "94109131600013", statut: "valide" } },
  } })]);
  assert.equal(elements.impPreremplirStatus.className, "status warn");
  assert.equal(elements.impPreremplirStatus.textContent,
    "⚠️ Champs pré-remplis à vérifier — Le numéro du contrat est requis. — SIREN : " + CHAMPS.MESSAGE_STATUT_INCONNU + " (champ signalé)");
  assert.equal(marque(elements.impStSiren).invalid, true);
  assert.equal(marque(elements.impStSiret).invalid, false);
});

test("nouveau pré-remplissage : les marques précédentes tombent, y compris quand l'extraction échoue", async () => {
  const marquer = (elements) => {
    for (const id of ["impStSiren", "impStSiret"]) {
      elements[id].classList.add("invalid"); elements[id].setAttribute("aria-invalid", "true"); elements[id].title = "ancien";
    }
  };
  const valide = await resultatContrat("941091316", "94109131600013");
  const ok = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "terminee", resultat: valide })], marquer);
  assert.deepEqual(marque(ok.elements.impStSiren), { invalid: false, aria: null, title: "" });
  assert.deepEqual(marque(ok.elements.impStSiret), { invalid: false, aria: null, title: "" });
  const ko = await lancer([reponse(202, { tache: TACHE }), reponse(200, { etat: "echec", erreur: { message: "x" } })], marquer);
  assert.equal(marque(ko.elements.impStSiren).invalid, false);
});

test("validerImport (code réel) : après un import réussi, les marques SIREN/SIRET sont retirées avec les valeurs", async () => {
  const elements = {};
  const el = (id, extra) => (elements[id] = fauxElement(id, extra));
  for (const id of CHAMPS.IDS_A_VIDER) el(id);
  for (const id of ["impStatus", "impPreremplirStatus", "impSigneLe"]) el(id);
  el("impType", { value: "sous-traitance" });
  el("impSigne", { checked: false });
  el("importModal");
  el("impAutres", { open: true });
  elements.impStSiren.value = "123456789";
  elements.impStSiren.classList.add("invalid"); elements.impStSiren.setAttribute("aria-invalid", "true"); elements.impStSiren.title = "SIREN : x";
  const ctx = {
    $: (sel) => elements[sel.replace(/^#/, "")],
    document: { getElementById: (id) => elements[id] || null },
    CONTRATS_IMPORT_CHAMPS: CHAMPS,
    lirePdf: async () => ({ nom: "c.pdf", dataBase64: "JVBERi0=" }),
    fetch: async () => reponse(200, { ok: true }),
    afficherAvertissementsImport: () => {}, setStatus: () => {}, showView: () => {},
    JSON, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(MARQUAGE + extraireFonction("validerImport"), ctx);
  await ctx.validerImport();
  assert.equal(elements.impStSiren.value, "");
  assert.deepEqual(marque(elements.impStSiren), { invalid: false, aria: null, title: "" });
});

test("construireAutresChampsImport (code réel) : modifier SIREN/SIRET retire sa marque ; les autres champs n'écoutent pas", () => {
  const crees = [];
  const grille = { childElementCount: 0, appendChild: () => {} };
  const ctx = {
    $: (sel) => (sel === "#impAutresGrille" ? grille : null),
    document: {
      createElement: (tag) => {
        const e = fauxElement("", { tagName: tag, appendChild: () => {} });
        crees.push(e);
        return e;
      },
      createTextNode: (t) => ({ t }),
      getElementById: () => null,
    },
    CONTRATS_IMPORT_CHAMPS: CHAMPS,
  };
  vm.createContext(ctx);
  vm.runInContext(MARQUAGE + extraireFonction("construireAutresChampsImport"), ctx);
  ctx.construireAutresChampsImport();
  const parId = Object.fromEntries(crees.filter((e) => e.id).map((e) => [e.id, e]));
  assert.equal(Object.keys(parId).length, 12);
  for (const [id, e] of Object.entries(parId)) {
    assert.equal(typeof e.ecouteurs.input === "function", id === "impStSiren" || id === "impStSiret", id);
  }
  ctx.marquerChampImport(parId.impStSiren, { libelle: "SIREN", message: CHAMPS.MESSAGES_STATUT.cle_invalide });
  assert.deepEqual(marque(parId.impStSiren), { invalid: true, aria: "true", title: "SIREN : " + CHAMPS.MESSAGES_STATUT.cle_invalide });
  parId.impStSiren.ecouteurs.input();
  assert.deepEqual(marque(parId.impStSiren), { invalid: false, aria: null, title: "" });
});
