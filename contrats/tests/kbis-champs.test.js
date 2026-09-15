"use strict";
// Tests de public/kbis-champs.js — proposition des valeurs lues sur un Kbis
// (issue #170, ligne « coordonnees »). Aucun appel réseau : DocIE est mocké à
// la frontière du bridge (fetch), comme tests/docie-extraction.test.js.
// Aucune base : server.js n'est jamais require() (il exige DATABASE_URL) ; la
// route est relue dans sa source et montée sur une app Express de test.
//
// Le défaut corrigé : DocIE lit SIREN, SIRET, forme juridique, adresse du
// siège et représentant légal sur le Kbis, /api/document/analyze les renvoie,
// mais app.js::analyzeChecklistDoc n'en gardait que date + société + contrôle
// du nom. L'utilisateur ressaisissait (ou redemandait à Pappers/INSEE) ce que
// le document officiel venait de donner.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const express = require("express");

const K = require("../public/kbis-champs");
const { sousTraitance } = require("../lib/fields");
const { ENRICHED_KEYS, DOCANALYZE_BASE_KEYS, mapKbisResult } = require("../lib/kbis-mapping");
const { analyzeDocument } = require("../lib/docie-extraction");

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Résultat DocIE « kbis » déjà déballé par le bridge (forme lue par
// lib/kbis-mapping.js) — mêmes valeurs que tests/docie-extraction.test.js.
const RESULTAT_KBIS = {
  document_type: "kbis",
  company_name: "ACME CONSEIL",
  siren: "123456789",
  siret_siege: "12345678900012",
  legal_form: "SAS",
  share_capital: { amount: "1000", currency: "EUR" },
  registration_date: "2015-06-01",
  issued_date: "2024-03-15",
  rcs_number: "123 456 789 RCS Paris",
  registered_address: "1 rue de la Paix, 75002 Paris",
  activity_code: "6202A",
  legal_representative: "Monsieur Jean DUPONT",
};

function analyseKbis(expectedName) {
  return mapKbisResult(RESULTAT_KBIS, { expectedName, items: [{ id: "kbis" }] }).analysis;
}

// Forme exacte d'une analyse LOCALE (docanalyze.js) : les 8 clés, rien d'autre.
function analyseLocale() {
  return {
    documentType: "Extrait Kbis", matchedId: "kbis", isValid: true, issuedDate: "2024-03-15",
    companyName: "ACME CONSEIL", nameMatches: true, issues: [], summary: "Extrait Kbis — délivré le 2024-03-15",
  };
}

const parCle = (prop) => Object.fromEntries(prop.champs.map((c) => [c.cle, c]));

test("garde-fou anti-dérive : sources = clés enrichies réelles de kbis-mapping.js, cibles = champs Sous-Traitant de fields.js", () => {
  const cles = new Map(sousTraitance.map((f) => [f.key, f]));
  for (const [source, cible] of K.CORRESPONDANCES) {
    assert.ok(ENRICHED_KEYS.includes(source), source + " n'est pas une clé enrichie de kbis-mapping.js");
    assert.ok(cles.has(cible), cible + " n'existe pas dans fields.js::sousTraitance");
    assert.equal(cles.get(cible).group, "Sous-Traitant", cible);
  }
  for (const [source] of K.INFOS) assert.ok(ENRICHED_KEYS.includes(source), source);
  // Choix explicites : le nom décide que le document est le bon (pas de
  // report), la qualité n'est pas isolée par le schéma kbis.
  const cibles = K.CORRESPONDANCES.map(([, c]) => c);
  const sources = K.CORRESPONDANCES.map(([s]) => s);
  assert.ok(!cibles.includes("stNom"));
  assert.ok(!sources.includes("companyName"));
  assert.ok(!cibles.includes("stQualite"));
  assert.equal(new Set(cibles).size, cibles.length, "cible en double");
  // Chaque clé enrichie est soit reportée, soit montrée pour information :
  // aucune n'est de nouveau jetée sans un mot.
  const couvertes = [...sources, ...K.INFOS.map(([s]) => s), "capitalSocialDevise"].sort();
  assert.deepEqual(couvertes, [...ENRICHED_KEYS].sort());
});

test("extraire : liste blanche des clés utiles, non vides ; analyse locale -> {} ; entrées absurdes -> {}", () => {
  const kbis = K.extraire(analyseKbis("ACME Conseil"));
  assert.deepEqual(kbis, {
    siren: "123456789", siret: "12345678900012", formeJuridique: "SAS",
    adresseSiege: "1 rue de la Paix, 75002 Paris", representantLegal: "Monsieur Jean DUPONT",
    capitalSocial: "1000", capitalSocialDevise: "EUR", rcsNumber: "123 456 789 RCS Paris",
    codeActivite: "6202A", dateImmatriculation: "2015-06-01",
  });
  for (const base of DOCANALYZE_BASE_KEYS) assert.ok(!(base in kbis), base + " ne doit pas être recopiée");
  assert.deepEqual(K.extraire(analyseLocale()), {});
  assert.deepEqual(K.extraire(undefined), {});
  assert.deepEqual(K.extraire(null), {});
  assert.deepEqual(K.extraire("texte"), {});
  // Champ enrichi présent mais vide (DocIE n'a rien lu) : pas proposé.
  assert.deepEqual(K.extraire(Object.assign(analyseLocale(), { siren: "", siret: "  ", formeJuridique: null })), {});
});

test("clés enrichies -> 5 champs proposés, valeurs du document intactes, infos sans champ montrées à part", () => {
  const prop = K.proposer(K.extraire(analyseKbis("ACME Conseil")), true, {});
  assert.equal(prop.nomVerifie, true);
  assert.deepEqual(prop.champs.map((c) => [c.cle, c.kbis, c.etat]), [
    ["stSiren", "123456789", "vide"],
    ["stSiret", "12345678900012", "vide"],
    ["stFormeJuridique", "SAS", "vide"],
    ["stAdresse", "1 rue de la Paix, 75002 Paris", "vide"],
    ["stRepresentant", "Monsieur Jean DUPONT", "vide"],
  ]);
  assert.deepEqual(prop.infos.map((i) => [i.libelle, i.valeur]), [
    ["Capital social", "1000 EUR"],
    ["RCS", "123 456 789 RCS Paris"],
    ["Code activité", "6202A"],
    ["Immatriculé le", "2015-06-01"],
  ]);
});

test("vide / identique / différent : normalisation pour COMPARER seulement (espaces SIREN/SIRET, casse), jamais pour afficher", () => {
  const kbis = K.extraire(analyseKbis("ACME Conseil"));
  const valeurs = {
    stSiren: "123 456 789",                     // mêmes chiffres, espacés -> identique
    stSiret: "",                                 // vide
    stFormeJuridique: "sas",                     // casse -> identique
    stAdresse: "5 avenue Foch, 75116 Paris",     // autre adresse -> différent
    stRepresentant: "Jean DUPONT (Président)",   // forme Pappers -> différent, l'utilisateur tranche
  };
  const c = parCle(K.proposer(kbis, true, valeurs));
  assert.equal(c.stSiren.etat, "identique");
  assert.equal(c.stSiren.actuel, "123 456 789", "valeur saisie non réécrite");
  assert.equal(c.stSiren.kbis, "123456789");
  assert.equal(c.stSiret.etat, "vide");
  assert.equal(c.stFormeJuridique.etat, "identique");
  assert.equal(c.stFormeJuridique.actuel, "sas");
  assert.equal(c.stAdresse.etat, "different");
  assert.equal(c.stRepresentant.etat, "different");
  assert.equal(c.stRepresentant.actuel, "Jean DUPONT (Président)");
  // Un chiffre de différence reste une différence.
  assert.equal(parCle(K.proposer(kbis, true, { stSiren: "123 456 780" })).stSiren.etat, "different");
  // Espaces seuls tolérés pour le texte, pas davantage (pas d'accents retirés, pas de ponctuation).
  assert.equal(parCle(K.proposer(kbis, true, { stAdresse: "  1 rue de la Paix,   75002 PARIS " })).stAdresse.etat, "identique");
  assert.equal(parCle(K.proposer(kbis, true, { stAdresse: "1 rue de la Paix 75002 Paris" })).stAdresse.etat, "different");
});

test("report : les champs vides sont remplis, un champ différent n'est JAMAIS écrasé sans choix explicite", () => {
  const kbis = K.extraire(analyseKbis("ACME Conseil"));
  const valeurs = { stSiren: "123 456 789", stAdresse: "5 avenue Foch, 75116 Paris", stRepresentant: "Jean DUPONT (Président)" };
  const prop = K.proposer(kbis, true, valeurs);
  const choix = K.choixParDefaut(prop);
  assert.deepEqual(choix, { stSiret: true, stFormeJuridique: true, stAdresse: false, stRepresentant: false });

  const defaut = K.aReporter(prop, choix, valeurs);
  assert.deepEqual(defaut.paires, [["stSiret", "12345678900012"], ["stFormeJuridique", "SAS"]]);
  assert.deepEqual(defaut.modifies, []);

  // L'utilisateur choisit le Kbis pour l'adresse, garde son représentant.
  const choisi = K.aReporter(prop, Object.assign({}, choix, { stAdresse: true }), valeurs);
  assert.deepEqual(choisi.paires.map(([k]) => k), ["stSiret", "stFormeJuridique", "stAdresse"]);
  assert.deepEqual(choisi.paires[2], ["stAdresse", "1 rue de la Paix, 75002 Paris"]);

  // Un « identique » n'est jamais réécrit (la saisie espacée reste telle quelle).
  const forceIdentique = K.aReporter(prop, { stSiren: true }, valeurs);
  assert.deepEqual(forceIdentique.paires, []);
});

test("report : un champ modifié entre l'affichage et le clic n'est pas écrasé, il est signalé", () => {
  const kbis = K.extraire(analyseKbis("ACME Conseil"));
  const prop = K.proposer(kbis, true, {});
  const choix = K.choixParDefaut(prop);
  // Entre-temps : saisie manuelle du SIRET, recherche société qui remplit l'adresse.
  const auClic = { stSiret: "99999999900011", stAdresse: "5 avenue Foch, 75116 Paris" };
  const r = K.aReporter(prop, choix, auClic);
  assert.deepEqual(r.modifies, ["stSiret", "stAdresse"]);
  assert.deepEqual(r.paires.map(([k]) => k), ["stSiren", "stFormeJuridique", "stRepresentant"]);
});

test("nameMatches === false : aucune proposition, quelles que soient les valeurs lues", () => {
  const autre = analyseKbis("SUND INDUSTRY SYSTEM");
  assert.equal(autre.nameMatches, false, "précondition : mapKbisResult signale bien une autre société");
  assert.equal(K.proposer(K.extraire(autre), autre.nameMatches, {}), null);
  assert.equal(K.proposer(K.extraire(autre), false, { stSiren: "" }), null);
});

test("nameMatches === null (raison sociale non saisie) : proposée, mais marquée non vérifiée ; stNom jamais proposé", () => {
  const sansNom = analyseKbis("");
  assert.equal(sansNom.nameMatches, null);
  const prop = K.proposer(K.extraire(sansNom), sansNom.nameMatches, {});
  assert.equal(prop.nomVerifie, false);
  assert.ok(!prop.champs.some((c) => c.cle === "stNom"));
});

test("analyse locale sans clé enrichie : pas de proposition, aucune exception", () => {
  const local = analyseLocale();
  assert.equal(K.proposer(K.extraire(local), local.nameMatches, { stNom: "ACME" }), null);
  assert.equal(K.proposer(undefined, true, {}), null);
  assert.equal(K.proposer({}, null, undefined), null);
  assert.deepEqual(K.choixParDefaut(null), {});
  assert.deepEqual(K.aReporter(null, null, null), { paires: [], modifies: [] });
  // Uniquement des infos (capital, RCS) et aucun champ reportable : rien à proposer.
  assert.equal(K.proposer({ capitalSocial: "1000", rcsNumber: "RCS Paris" }, true, {}), null);
});

test("coordonnees : annotation partielle honnête, jamais « complet » tant qu'un champ Sous-Traitant manque", () => {
  assert.equal(K.noteCoordonnees(sousTraitance, {}, []), null);
  assert.equal(K.noteCoordonnees(sousTraitance, {}, undefined), null);

  const apresKbis = {
    stNom: "ACME CONSEIL", stSiren: "123456789", stSiret: "12345678900012", stFormeJuridique: "SAS",
    stAdresse: "1 rue de la Paix, 75002 Paris", stRepresentant: "Monsieur Jean DUPONT",
  };
  const n = K.noteCoordonnees(sousTraitance, apresKbis, ["stAdresse", "stRepresentant", "stSiren"]);
  assert.deepEqual(n.reportes, ["Adresse", "Représentée par", "SIREN"]);
  assert.deepEqual(n.manquants, ["Qualité du représentant", "Email (envoi en signature)"]);
  assert.equal(n.complet, false);

  const toutRempli = Object.assign({}, apresKbis, { stQualite: "Président", stEmail: "contact@acme.fr" });
  assert.equal(K.noteCoordonnees(sousTraitance, toutRempli, ["stAdresse"]).complet, true);
});

test("index.html charge kbis-champs.js avant app.js ; app.js garde les valeurs et passe par le chemin de remplissage partagé", () => {
  const iImport = INDEX_HTML.indexOf('<script src="/import-champs.js">');
  const iKbis = INDEX_HTML.indexOf('<script src="/kbis-champs.js">');
  const iApp = INDEX_HTML.indexOf('<script src="/app.js">');
  assert.ok(iImport !== -1 && iKbis !== -1 && iApp !== -1);
  assert.ok(iKbis < iApp);
  // Une seule routine d'écriture dans le formulaire : la recherche société et
  // le report Kbis passent tous deux par appliquerValeursChamps.
  const selectCompany = extraireFonction("selectCompany");
  const proposition = extraireFonction("renderPropositionKbis");
  assert.ok(selectCompany.includes("appliquerValeursChamps("));
  assert.ok(!selectCompany.includes("setFieldValue("));
  assert.ok(proposition.includes("appliquerValeursChamps("));
  assert.ok(!proposition.includes("setFieldValue("));
  // La case « coordonnees » n'est jamais cochée par ce code.
  assert.ok(!/checkState\.coordonnees|checkState\[["']coordonnees/.test(APP_JS));
});

// Extraction d'une fonction TELLE QUELLE du vrai public/app.js (même méthode
// que tests/import-champs.test.js) : on teste le consommateur réel.
function extraireFonction(nom) {
  const debut = APP_JS.search(new RegExp("(async )?function " + nom + "\\("));
  assert.ok(debut !== -1, nom + " introuvable dans app.js");
  const reste = APP_JS.slice(debut);
  const m = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(m, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, m.index + m[0].length);
}

async function analyserDansNavigateur(itemId, reponse) {
  const propHost = { rendu: null };
  const ctx = {
    CONTRATS_KBIS_CHAMPS: K,
    state: { values: { stNom: "ACME Conseil" }, dateState: {} },
    fileToBase64: async () => "JVBERi0=",
    fetch: async () => ({ ok: true, status: 200, json: async () => reponse }),
    renderChecklistDocResult: () => {},
    renderControleSirenSiret: (el, res) => { propHost.controleRendu = res; },
    renderPropositionKbis: (host, res) => { host.rendu = res; },
    majNoteCoordonnees: () => {},
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("analyzeChecklistDoc"), ctx);
  const statusEl = { parentNode: { querySelector: (sel) => (sel === "[data-kbis-proposition]" ? propHost : null) } };
  await ctx.analyzeChecklistDoc({ id: itemId, label: itemId }, { name: "doc.pdf", type: "application/pdf" }, statusEl, { textContent: "" });
  return { etat: ctx.state, propHost };
}

test("analyzeChecklistDoc (code réel d'app.js) : la réponse Kbis n'est plus jetée ; URSSAF et analyse locale n'emportent rien", async () => {
  const { etat, propHost } = await analyserDansNavigateur("kbis", analyseKbis("ACME Conseil"));
  const res = etat.dateState.kbis;
  assert.equal(res.issuedDate, "2024-03-15");
  assert.equal(res.nameMatches, true);
  assert.equal(res.kbis.siren, "123456789");
  assert.equal(res.kbis.representantLegal, "Monsieur Jean DUPONT");
  assert.equal(propHost.rendu, res, "la proposition est rendue avec l'analyse enregistrée");

  const locale = await analyserDansNavigateur("kbis", analyseLocale());
  assert.deepEqual(locale.etat.dateState.kbis.kbis, {});

  // Une attestation URSSAF avec un « siren » : aucune proposition de champs contrat.
  const urssaf = await analyserDansNavigateur("urssaf", Object.assign(analyseLocale(), { siren: "123456789" }));
  assert.ok(!("kbis" in urssaf.etat.dateState.urssaf));
});

test("appliquerValeursChamps (code réel) : écrit les paires, n'efface jamais avec une valeur vide", () => {
  const ecrits = [];
  const ctx = {
    state: { values: { stSiren: "déjà", stAdresse: "garde" } },
    document: { getElementById: () => null },
    renderPreview: () => ecrits.push("apercu"),
    updateWizardProgress: () => ecrits.push("progression"),
    majNoteCoordonnees: () => ecrits.push("note"),
    String,
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("setFieldValue") + "\n" + extraireFonction("appliquerValeursChamps"), ctx);
  ctx.appliquerValeursChamps([["stSiret", "12345678900012"], ["stAdresse", ""], ["stSiren", "123456789"]]);
  assert.equal(ctx.state.values.stSiret, "12345678900012");
  assert.equal(ctx.state.values.stAdresse, "garde");
  assert.equal(ctx.state.values.stSiren, "123456789");
  assert.deepEqual(ecrits, ["apercu", "progression", "note"]);
});

// ---------------------------------------------------------------------------
// Bout en bout au niveau de la route : le VRAI gestionnaire de
// POST /api/document/analyze (relu dans server.js), le vrai
// lib/docie-extraction.js, le vrai bridge partagé ; seul fetch est mocké, à la
// frontière HTTP du bridge vers DocIE.
// ---------------------------------------------------------------------------
function routeAnalyse() {
  const debut = SERVER_JS.indexOf('app.post("/api/document/analyze"');
  assert.ok(debut !== -1, "route /api/document/analyze introuvable dans server.js");
  const reste = SERVER_JS.slice(debut);
  const m = /\r?\n\}\);\r?\n/.exec(reste);
  assert.ok(m, "fin de la route introuvable");
  return reste.slice(0, m.index + m[0].length);
}

function poster(port, chemin, corps) {
  return new Promise((resolve, reject) => {
    const donnees = Buffer.from(JSON.stringify(corps));
    const req = http.request({
      host: "127.0.0.1", port, path: chemin, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": donnees.length },
    }, (res) => {
      const morceaux = [];
      res.on("data", (c) => morceaux.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(morceaux).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(donnees);
  });
}

test("route /api/document/analyze (DocIE mocké au bridge) : les clés enrichies du Kbis arrivent au client, et deviennent une proposition", async () => {
  const ENV = {
    DOCIE_EXTRACTION_ENABLED: "true",
    DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret",
    DOCIE_AGENT_KBIS: "kbis-agent-test",
  };
  const envAvant = {};
  for (const k of Object.keys(ENV)) { envAvant[k] = process.env[k]; process.env[k] = ENV[k]; }
  const fetchAvant = globalThis.fetch;
  const appelsDocie = [];
  // Enveloppe brute de l'agent DocIE (champs {value, confidence, evidence_ids}).
  const champ = (value) => ({ value, confidence: 0.95, evidence_ids: ["e1"] });
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(ENV.DOCIE_BASE_URL)) throw new Error("appel réseau inattendu : " + url);
    appelsDocie.push(String(url));
    const content = JSON.stringify({
      document_type: "kbis",
      company_name: champ("ACME CONSEIL"),
      siren: champ("123456789"),
      siret_siege: champ("12345678900012"),
      legal_form: champ("SAS"),
      share_capital: { amount: "1000", currency: "EUR", confidence: 0.9, evidence_ids: [] },
      registration_date: champ("2015-06-01"),
      issued_date: champ("2024-03-15"),
      rcs_number: champ("123 456 789 RCS Paris"),
      registered_address: champ("1 rue de la Paix, 75002 Paris"),
      activity_code: champ("6202A"),
      legal_representative: champ("Monsieur Jean DUPONT"),
    });
    return new Response(JSON.stringify({
      id: "chatcmpl-test", model: ENV.DOCIE_AGENT_KBIS,
      choices: [{ finish_reason: "stop", message: { content } }],
    }), { status: 200 });
  };

  const app = express();
  app.use(express.json({ limit: "30mb" }));
  // eslint-disable-next-line no-new-func
  new Function("app", "analyzeDocument", "console", routeAnalyse())(app, analyzeDocument, console);
  const serveur = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const { status, body } = await poster(serveur.address().port, "/api/document/analyze", {
      dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
      mimeType: "application/pdf",
      items: [{ id: "kbis", label: "Kbis" }],
      expectedName: "ACME Conseil",
    });
    assert.equal(status, 200);
    assert.deepEqual(appelsDocie, ["https://docie.example.test/v1/agents/kbis-agent-test/chat/completions"]);
    // Le serveur ne filtre rien : les 10 clés enrichies sont dans la réponse HTTP.
    for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(body, k), k + " absente de la réponse HTTP");
    assert.equal(body.siren, "123456789");
    assert.equal(body.adresseSiege, "1 rue de la Paix, 75002 Paris");
    assert.equal(body.nameMatches, true);

    // Réponse sans le drapeau (dossier enregistré avant #201) : comme avant.
    const prop = K.proposer(K.extraire(body), body.nameMatches, { stNom: "ACME Conseil", stRepresentant: "Jean DUPONT (Président)" });
    assert.deepEqual(prop.champs.map((c) => [c.cle, c.etat]), [
      ["stSiren", "vide"], ["stSiret", "vide"], ["stFormeJuridique", "vide"], ["stAdresse", "vide"], ["stRepresentant", "different"],
    ]);
    // Avec le drapeau que la route transmet réellement : 123456789 et
    // 12345678900012 échouent Luhn, ils ne sont plus proposés au report.
    assert.equal(body.controleSirenSiret.siren.statut, "cle_invalide");
    assert.equal(body.controleSirenSiret.siret.statut, "cle_invalide");
    const avecControle = K.proposer(K.extraire(body), body.nameMatches, { stNom: "ACME Conseil" }, K.controleCompact(body));
    assert.deepEqual(avecControle.champs.map((c) => c.cle), ["stFormeJuridique", "stAdresse", "stRepresentant"]);
    assert.deepEqual(avecControle.aVerifier.map((a) => [a.cle, a.kbis, a.statut]), [
      ["stSiren", "123456789", "cle_invalide"], ["stSiret", "12345678900012", "cle_invalide"],
    ]);
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
    globalThis.fetch = fetchAvant;
    for (const k of Object.keys(ENV)) {
      if (envAvant[k] === undefined) delete process.env[k]; else process.env[k] = envAvant[k];
    }
  }
});

// ---------------------------------------------------------------------------
// Contrôle de clé SIREN / SIRET (PR #201) côté proposition Kbis -> contrat.
// Règle : un numéro n'est proposé au report que si son statut vaut "valide".
// Le jeu d'essai partagé de #201 est parcouru EN ENTIER, à travers le vrai
// lib/kbis-mapping.js (le drapeau n'est jamais fabriqué à la main ici).
// ---------------------------------------------------------------------------
const { STATUTS } = require("../lib/siren-siret");
const SIREN_SIRET = require(path.join(__dirname, "..", "..", "document-parsing", "fixtures", "siren_siret.json"));

function analyseAvec(siren, siret) {
  const r = Object.assign({}, RESULTAT_KBIS, { siren, siret_siege: siret });
  return mapKbisResult(r, { expectedName: "ACME Conseil", items: [{ id: "kbis" }] }).analysis;
}

test("messages : un message fixe par statut non valide de #201, statut inconnu -> message générique (échec fermé)", () => {
  assert.deepEqual(Object.keys(K.MESSAGES_STATUT).sort(), ["cle_invalide", "discordant", "format_invalide"]);
  for (const s of Object.keys(K.MESSAGES_STATUT)) assert.ok(STATUTS.includes(s), s + " n'est pas un statut de lib/siren-siret.js");
  for (const m of Object.values(K.MESSAGES_STATUT)) assert.match(m, / — vérifier sur le document$/);
  assert.equal(K.messageStatut("cle_invalide"), "clé de contrôle invalide — vérifier sur le document");
  assert.equal(K.messageStatut("statut_futur"), K.MESSAGE_STATUT_INCONNU);
  assert.equal(K.messageStatut("constructor"), K.MESSAGE_STATUT_INCONNU, "pas de fuite du prototype");
  assert.equal(K.messageStatut(null), K.MESSAGE_STATUT_INCONNU);
});

test("jeu d'essai #201 entier via kbis-mapping.js : SIREN/SIRET proposé SSI statut valide ; sinon valeur lue + raison ; absent -> rien", () => {
  const vus = { siren: new Set(), siret: new Set() };
  for (const cas of SIREN_SIRET.cas) {
    const a = analyseAvec(cas.siren, cas.siret);
    const controle = K.controleCompact(a);
    const prop = K.proposer(K.extraire(a), a.nameMatches, {}, controle);
    const sansDrapeau = K.proposer(K.extraire(a), a.nameMatches, {});
    for (const champ of ["siren", "siret"]) {
      const statut = cas["statut_" + champ];
      const brut = cas[champ];
      vus[champ].add(statut);
      const quoi = champ + " " + JSON.stringify(brut) + " (" + statut + ")";
      assert.equal(controle[champ].statut, statut, quoi);
      assert.equal(prop.champs.some((c) => c.source === champ), statut === "valide", quoi + " : proposé ?");
      const av = prop.aVerifier.filter((x) => x.source === champ);
      if (statut === "valide" || statut === "absent") {
        assert.equal(av.length, 0, quoi + " : rien à vérifier");
      } else {
        assert.equal(av.length, 1, quoi);
        assert.equal(av[0].statut, statut);
        assert.equal(av[0].kbis, String(brut), quoi + " : valeur lue montrée telle quelle");
        assert.equal(av[0].message, K.MESSAGES_STATUT[statut]);
        assert.equal(av[0].libelle, champ.toUpperCase());
      }
      // Choix par défaut et report : un numéro non valide n'y apparaît jamais,
      // même coché de force.
      if (statut !== "valide") {
        const cle = champ === "siren" ? "stSiren" : "stSiret";
        assert.ok(!(cle in K.choixParDefaut(prop)), quoi);
        assert.ok(!K.aReporter(prop, { [cle]: true }, {}).paires.some(([k]) => k === cle), quoi + " : jamais reporté");
      }
      // Drapeau absent : exactement la règle d'avant (proposé dès que non vide).
      const nonVide = brut !== null && String(brut).trim() !== "";
      assert.equal(sansDrapeau.champs.some((c) => c.source === champ), nonVide, quoi + " sans drapeau");
      assert.deepEqual(sansDrapeau.aVerifier, []);
    }
  }
  for (const champ of ["siren", "siret"]) assert.deepEqual([...vus[champ]].sort(), [...STATUTS].sort(), champ + " : les 5 statuts couverts");
});

test("drapeau absent ou illisible dans la réponse : comportement d'avant #201, aucune exception", () => {
  const a = analyseKbis("ACME Conseil");
  const avant = K.proposer(K.extraire(a), true, {});
  for (const d of [analyseLocale(), undefined, null, "texte", Object.assign({}, a, { controleSirenSiret: undefined }),
    Object.assign({}, a, { controleSirenSiret: null }), Object.assign({}, a, { controleSirenSiret: "valide" })]) {
    const controle = K.controleCompact(d);
    assert.equal(controle, null, JSON.stringify(d && d.controleSirenSiret));
    assert.deepEqual(K.proposer(K.extraire(a), true, {}, controle), avant);
  }
  assert.deepEqual(avant.champs.map((c) => c.cle), ["stSiren", "stSiret", "stFormeJuridique", "stAdresse", "stRepresentant"]);
  assert.deepEqual(avant.aVerifier, []);
  // Analyse locale : toujours rien à proposer.
  const local = analyseLocale();
  assert.equal(K.proposer(K.extraire(local), local.nameMatches, {}, K.controleCompact(local)), null);
});

test("drapeau présent mais entrée manquante, statut non textuel ou inconnu : non proposé (échec fermé), message générique", () => {
  const kbis = { siren: "941091316", siret: "94109131600013", formeJuridique: "SAS" };
  const vide = K.controleCompact({ controleSirenSiret: {} });
  assert.deepEqual(vide, { siren: { statut: null, valeur: "" }, siret: { statut: null, valeur: "" } });
  const p1 = K.proposer(kbis, true, {}, vide);
  assert.deepEqual(p1.champs.map((c) => c.cle), ["stFormeJuridique"]);
  assert.deepEqual(p1.aVerifier.map((a) => [a.cle, a.kbis, a.message]), [
    ["stSiren", "941091316", K.MESSAGE_STATUT_INCONNU], ["stSiret", "94109131600013", K.MESSAGE_STATUT_INCONNU],
  ]);
  const futur = K.controleCompact({ controleSirenSiret: {
    siren: { valeur: "941091316", chiffres: "941091316", statut: "statut_futur" },
    siret: { valeur: "94109131600013", chiffres: "94109131600013", statut: 1 },
  } });
  const p2 = K.proposer(kbis, true, {}, futur);
  assert.deepEqual(p2.champs.map((c) => c.cle), ["stFormeJuridique"]);
  assert.deepEqual(p2.aVerifier.map((a) => a.statut), ["statut_futur", null]);
});

test("numéro non valide identique à la saisie : pas « déjà dans le contrat », il reste à vérifier", () => {
  const a = analyseKbis("ACME Conseil");
  const prop = K.proposer(K.extraire(a), true, { stSiren: "123 456 789" }, K.controleCompact(a));
  assert.ok(!prop.champs.some((c) => c.cle === "stSiren"));
  assert.equal(prop.aVerifier.find((x) => x.cle === "stSiren").kbis, "123456789");
});

test("seul un numéro à vérifier (aucun champ reportable) : proposition affichée quand même ; nameMatches false -> null", () => {
  const controle = { siren: { statut: "cle_invalide", valeur: "123456789" }, siret: { statut: "absent", valeur: "" } };
  const prop = K.proposer({ siren: "123456789" }, true, {}, controle);
  assert.deepEqual(prop.champs, []);
  assert.deepEqual(prop.aVerifier.map((x) => x.cle), ["stSiren"]);
  assert.equal(K.proposer({ siren: "123456789" }, false, {}, controle), null);
  // Absent partout : rien.
  const absent = { siren: { statut: "absent", valeur: "" }, siret: { statut: "absent", valeur: "" } };
  assert.equal(K.proposer({ capitalSocial: "1000" }, true, {}, absent), null);
});

test("analyzeChecklistDoc (code réel) : garde le drapeau d'une analyse DocIE, n'ajoute rien à une analyse locale", async () => {
  const docie = await analyserDansNavigateur("kbis", analyseKbis("ACME Conseil"));
  assert.deepEqual(docie.etat.dateState.kbis.controleSirenSiret, {
    siren: { statut: "cle_invalide", valeur: "123456789" }, siret: { statut: "cle_invalide", valeur: "12345678900012" },
  });
  assert.equal(docie.propHost.controleRendu, docie.etat.dateState.kbis, "la ligne de contrôle est rendue avec l'analyse enregistrée");
  const locale = await analyserDansNavigateur("kbis", analyseLocale());
  assert.equal(JSON.stringify(Object.keys(locale.etat.dateState.kbis)), JSON.stringify(["issuedDate", "companyName", "nameMatches", "fileName", "kbis"]));
});

// ---------------------------------------------------------------------------
// Checklist : ligne de verdict SIREN/SIRET sous le résultat de l'analyse.
// Le VRAI renderChecklistDocResult puis le VRAI renderControleSirenSiret,
// exécutés sur un faux élément : le texte et la classe du résultat
// (⛔ autre société, validité 6 mois) doivent rester ceux d'avant.
// ---------------------------------------------------------------------------
function rendreChecklist(res, aujourdHui) {
  const document = fauxDocument();
  const DateReelle = Date;
  // Date figée : la validité 6 mois dépend du jour.
  const DateFigee = class extends DateReelle {
    constructor(...a) { if (a.length) super(...a); else super(aujourdHui); }
  };
  const ctx = {
    CONTRATS_KBIS_CHAMPS: K, document, Date: DateFigee, Math, isNaN, String,
    state: { values: { stNom: "ACME Conseil" } },
    frDate: (iso) => iso.split("-").reverse().join("/"),
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("isoOf") + "\n" + extraireFonction("renderChecklistDocResult") + "\n" + extraireFonction("renderControleSirenSiret"), ctx);
  const el = document.createElement("div");
  // Ligne d'une analyse précédente : doit disparaître au nouveau rendu.
  el.appendChild({ textContent: "ancienne ligne", children: [] });
  ctx.renderChecklistDocResult(el, res);
  const principal = { className: el.className, textContent: el.textContent };
  ctx.renderControleSirenSiret(el, res);
  return { el, principal, sous: el.children };
}

test("ligneControle : texte compact par statut ; drapeau absent ou deux numéros absents -> null", () => {
  const c = (s1, v1, s2, v2) => ({ siren: { statut: s1, valeur: v1 }, siret: { statut: s2, valeur: v2 } });
  assert.equal(K.ligneControle(null), null);
  assert.equal(K.ligneControle(undefined), null);
  assert.equal(K.ligneControle(c("absent", "", "absent", "")), null);
  assert.deepEqual(K.ligneControle(c("valide", "941091316", "valide", "94109131600013")),
    { texte: "🔢 SIREN 941091316 : clé valide · SIRET 94109131600013 : clé valide", alerte: false });
  assert.deepEqual(K.ligneControle(c("cle_invalide", "123456789", "absent", "")),
    { texte: "⚠️ SIREN « 123456789 » : clé de contrôle invalide — vérifier sur le document", alerte: true });
  assert.deepEqual(K.ligneControle(c("valide", "941091316", "format_invalide", "9410913160001")),
    { texte: "⚠️ SIREN 941091316 : clé valide · SIRET « 9410913160001 » : format invalide — vérifier sur le document", alerte: true });
  assert.equal(K.ligneControle(c("discordant", "941091316", "discordant", "55212022200005")).texte,
    "⚠️ SIREN « 941091316 » : " + K.MESSAGES_STATUT.discordant + " · SIRET « 55212022200005 » : " + K.MESSAGES_STATUT.discordant);
  // Statut inconnu ou entrée illisible : alerte, jamais « clé valide ».
  const inconnu = K.ligneControle(K.controleCompact({ controleSirenSiret: { siren: { statut: "statut_futur", valeur: "941091316" } } }));
  assert.equal(inconnu.alerte, true);
  assert.equal(inconnu.texte, "⚠️ SIREN « 941091316 » : " + K.MESSAGE_STATUT_INCONNU + " · SIRET : " + K.MESSAGE_STATUT_INCONNU);
});

test("checklist (code réel) : chaque statut du jeu d'essai #201 -> ligne sous le résultat, résultat inchangé ; sans drapeau -> rien", () => {
  const AUJOURDHUI = "2024-05-01T12:00:00";
  for (const cas of SIREN_SIRET.cas) {
    const a = analyseAvec(cas.siren, cas.siret);
    const res = { issuedDate: a.issuedDate, companyName: a.companyName, nameMatches: a.nameMatches, fileName: "k.pdf", controleSirenSiret: K.controleCompact(a) };
    const { el, principal, sous } = rendreChecklist(res, AUJOURDHUI);
    const sansDrapeau = rendreChecklist(Object.assign({}, res, { controleSirenSiret: undefined }), AUJOURDHUI);
    const quoi = JSON.stringify([cas.siren, cas.siret]);
    // Résultat principal identique avec ou sans drapeau (délivré le 15/03/2024 : valable).
    assert.deepEqual(principal, sansDrapeau.principal, quoi);
    assert.equal(el.className, "chk-doc-status ok", quoi);
    assert.equal(sansDrapeau.sous.length, 0, quoi + " : sans drapeau, aucune ligne");
    const statuts = [cas.statut_siren, cas.statut_siret];
    if (statuts.every((s) => s === "absent")) { assert.equal(sous.length, 0, quoi); continue; }
    assert.equal(sous.length, 1, quoi + " : une seule ligne, l'ancienne a été effacée");
    const nonValide = statuts.some((s) => s !== "valide" && s !== "absent");
    assert.equal(sous[0].className, nonValide ? "chk-date-status warn" : "cand-sub", quoi);
    for (const [champ, libelle] of [["siren", "SIREN"], ["siret", "SIRET"]]) {
      const s = cas["statut_" + champ];
      if (s === "absent") assert.ok(!sous[0].textContent.includes(libelle + " "), quoi);
      else if (s === "valide") assert.ok(sous[0].textContent.includes(libelle + " " + String(cas[champ]) + " : clé valide"), quoi);
      else assert.ok(sous[0].textContent.includes(libelle + " « " + String(cas[champ]) + " » : " + K.MESSAGES_STATUT[s]), quoi + " " + sous[0].textContent);
    }
  }
});

test("checklist (code réel) : ⛔ autre société et ⛔/⚠️ validité 6 mois intacts ; pas de ligne SIREN pour un document d'une autre société", () => {
  const invalide = K.controleCompact(analyseKbis("ACME Conseil"));
  const base = { issuedDate: "2024-03-15", companyName: "ACME CONSEIL", nameMatches: true, fileName: "k.pdf", controleSirenSiret: invalide };

  const autre = rendreChecklist(Object.assign({}, base, { nameMatches: false, companyName: "SUND" }), "2024-05-01T12:00:00");
  assert.equal(autre.el.className, "chk-doc-status err");
  assert.equal(autre.el.textContent, "⛔ Document au nom de « SUND » — ce n'est PAS le sous-traitant saisi (« ACME Conseil »)");
  assert.equal(autre.sous.length, 0);

  const perime = rendreChecklist(base, "2025-01-01T12:00:00");
  assert.equal(perime.principal.className, "chk-doc-status err");
  assert.equal(perime.principal.textContent, "⛔ Société : ACME CONSEIL ✓ — PÉRIMÉ (plus de 6 mois) — délivré le 15/03/2024, à renouveler");
  assert.equal(perime.el.className, "chk-doc-status err", "classe du résultat non modifiée par la ligne SIREN");
  assert.equal(perime.sous[0].textContent, "⚠️ SIREN « 123456789 » : clé de contrôle invalide — vérifier sur le document · SIRET « 12345678900012 » : clé de contrôle invalide — vérifier sur le document");

  const bientot = rendreChecklist(base, "2024-09-01T12:00:00");
  assert.equal(bientot.principal.className, "chk-doc-status warn");
  assert.ok(bientot.principal.textContent.startsWith("⚠️ Société : ACME CONSEIL ✓ — bientôt périmé"));
  assert.equal(bientot.sous.length, 1);

  const sansDate = rendreChecklist(Object.assign({}, base, { issuedDate: "" }), "2024-05-01T12:00:00");
  assert.equal(sansDate.principal.textContent, "⚠️ Société : ACME CONSEIL ✓ — date de délivrance non lue sur le document");
  assert.equal(sansDate.sous.length, 1);
});

// Faux DOM minimal : assez pour exécuter le vrai renderPropositionKbis.
function fauxDocument() {
  const creer = (tag) => {
    let texteNoeud = "";
    const n = {
      tagName: tag, className: "", children: [], ecouteurs: {}, dataset: {},
      // Comme le vrai DOM : affecter textContent retire les enfants.
      get textContent() { return texteNoeud; },
      set textContent(v) { texteNoeud = v; n.children = []; },
      appendChild(c) { n.children.push(c); return c; },
      append(...cs) { for (const c of cs) n.children.push(typeof c === "string" ? { textContent: c, children: [] } : c); },
      addEventListener(t, fn) { n.ecouteurs[t] = fn; },
      classList: { toggle(cls, on) { if (cls === "hidden") n.masque = !!on; } },
    };
    Object.defineProperty(n, "innerHTML", { set() { n.children = []; }, get() { return ""; } });
    return n;
  };
  return { createElement: creer };
}
const texteDe = (n) => (n.textContent || "") + (n.children || []).map(texteDe).join("");
const noeudsDe = (n, pred) => [...(pred(n) ? [n] : []), ...(n.children || []).flatMap((c) => noeudsDe(c, pred))];

function rendreProposition(res) {
  const reportes = [];
  const document = fauxDocument();
  const ctx = {
    CONTRATS_KBIS_CHAMPS: K, document,
    state: { values: { stNom: "ACME Conseil" }, fields: sousTraitance },
    appliquerValeursChamps: (paires) => reportes.push(...paires),
    majNoteCoordonnees: () => {},
    Set,
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("renderPropositionKbis"), ctx);
  const host = document.createElement("div");
  ctx.renderPropositionKbis(host, res);
  return { host, reportes };
}

test("renderPropositionKbis (code réel) : SIREN/SIRET non valides montrés « à vérifier » sans case, jamais reportés ; sans drapeau, comme avant", () => {
  const a = analyseKbis("ACME Conseil");
  const res = { kbis: K.extraire(a), nameMatches: true, controleSirenSiret: K.controleCompact(a) };
  const { host, reportes } = rendreProposition(res);
  assert.equal(host.masque, false);
  const texte = texteDe(host);
  assert.ok(texte.includes("SIREN à vérifier — non reporté"), texte);
  assert.ok(texte.includes("Lu : « 123456789 » — clé de contrôle invalide — vérifier sur le document"), texte);
  assert.ok(texte.includes("Lu : « 12345678900012 » — clé de contrôle invalide — vérifier sur le document"), texte);
  const cases = noeudsDe(host, (n) => n.type === "checkbox");
  assert.equal(cases.length, 3, "forme juridique, adresse, représentant — pas SIREN ni SIRET");
  noeudsDe(host, (n) => n.tagName === "button")[0].ecouteurs.click();
  assert.deepEqual(reportes.map(([k]) => k), ["stFormeJuridique", "stAdresse", "stRepresentant"]);

  // Dossier enregistré avant #201 (pas de controleSirenSiret) : 5 cases, SIREN reporté.
  const ancien = rendreProposition({ kbis: K.extraire(a), nameMatches: true });
  assert.equal(noeudsDe(ancien.host, (n) => n.type === "checkbox").length, 5);
  assert.ok(!texteDe(ancien.host).includes("à vérifier"));
  noeudsDe(ancien.host, (n) => n.tagName === "button")[0].ecouteurs.click();
  assert.deepEqual(ancien.reportes.map(([k]) => k), ["stSiren", "stSiret", "stFormeJuridique", "stAdresse", "stRepresentant"]);

  // Numéros valides (941091316 / 94109131600013) : proposés et reportés.
  const valide = analyseAvec("941091316", "94109131600013");
  const ok = rendreProposition({ kbis: K.extraire(valide), nameMatches: true, controleSirenSiret: K.controleCompact(valide) });
  assert.equal(noeudsDe(ok.host, (n) => n.type === "checkbox").length, 5);
  noeudsDe(ok.host, (n) => n.tagName === "button")[0].ecouteurs.click();
  assert.deepEqual(ok.reportes.slice(0, 2), [["stSiren", "941091316"], ["stSiret", "94109131600013"]]);
});
