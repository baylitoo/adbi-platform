"use strict";

/**
 * Tests de lib/import-extraction-routes.js — POST /api/contracts/importer/extraire
 * en 202 puis GET /api/taches/:id.
 *
 * Une vraie application express ecoute sur 127.0.0.1 (port choisi par le
 * systeme) ; extractContractValues est remplace (ou, pour le test de charge
 * utile, appele reellement avec un fetchImpl simule) : ni DocIE, ni PostgreSQL.
 * server.js n'est pas charge (il exige DATABASE_URL) : les routes vivent dans
 * un module a dependances injectees, monte ici avec le meme analyseur JSON.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { monterPreremplissage } = require("../lib/import-extraction-routes");
const { creerGestionnaire, TTL_MS, MESSAGES_BRIDGE } = require("../lib/taches-extraction");
const { extractContractValues: extractionReelle } = require("../lib/docie-contract-import");
const { DocIEBridgeError } = require("../../document-parsing/bridge/docie-bridge.js");

const RAW_FIXTURE = require(path.join(
  __dirname, "..", "..", "document-parsing", "mappings", "fixtures", "contract_extraction_sample.json"
));

function differe() {
  let resoudre, rejeter;
  const promesse = new Promise((ok, ko) => { resoudre = ok; rejeter = ko; });
  return { promesse, resoudre, rejeter };
}
const vider = () => new Promise((ok) => setImmediate(ok));

const ENV_ACTIF = { DOCIE_EXTRACTION_ENABLED: "true" };

async function demarrer({ extractContractValues, env = ENV_ACTIF, chargerBridge, maintenant } = {}) {
  const app = express();
  // meme reglage que server.js
  app.use(express.json({ limit: "30mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
  const gestionnaire = creerGestionnaire({ journal: () => {}, ...(maintenant ? { maintenant } : {}) });
  const journal = [];
  monterPreremplissage(app, {
    extractContractValues, gestionnaire, env,
    journal: (etiquette, e) => journal.push([etiquette, e]),
    ...(chargerBridge ? { chargerBridge } : {}),
  });
  const serveur = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return {
    base, gestionnaire, journal,
    fermer: () => new Promise((ok) => serveur.close(ok)),
    post: (corps) => fetch(base + "/api/contracts/importer/extraire", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
    }),
    get: (id) => fetch(base + "/api/taches/" + id),
  };
}

const PDF = Buffer.from("%PDF-1.4 contrat de sous-traitance factice", "latin1");
const CORPS = { mimeType: "application/pdf", dataBase64: PDF.toString("base64") };

/** Interroge jusqu'a la fin (au plus ~2 s), sans horloge truquee. */
async function attendreFin(srv, tache) {
  for (let i = 0; i < 200; i++) {
    const vue = await (await srv.get(tache)).json();
    if (vue.etat !== "en_cours") return vue;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("tache jamais terminee");
}

test("POST repond 202 { tache } tout de suite pendant une extraction non terminee ; GET passe en_cours -> terminee", async () => {
  const lente = differe();
  const appels = [];
  const resultat = {
    requestId: "req-1", values: { numeroContrat: "02-09-2026", stNom: "ADCONSI" },
    warnings: ["DocIE validation.warnings: a"], errors: [], ok: true,
  };
  const srv = await demarrer({
    extractContractValues: async (corps) => { appels.push(corps); await lente.promesse; return resultat; },
  });
  try {
    const t0 = performance.now();
    const r = await srv.post(CORPS);
    const duree = performance.now() - t0;
    assert.equal(r.status, 202);
    const { tache, ...reste } = await r.json();
    assert.deepEqual(reste, {});
    assert.match(tache, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(duree < 1000, `POST en ${duree.toFixed(0)} ms`);

    // L'extraction est lancee avec exactement les deux champs recus — ni req,
    // ni rawBody.
    await vider();
    assert.equal(appels.length, 1);
    assert.deepEqual(appels[0], CORPS);

    const enCours = await (await srv.get(tache)).json();
    assert.equal(enCours.etat, "en_cours");
    assert.equal(enCours.etape, "extraction");
    assert.ok(!Object.hasOwn(enCours, "resultat"));

    lente.resoudre();
    await vider();
    const r2 = await srv.get(tache);
    assert.equal(r2.status, 200);
    const fini = await r2.json();
    assert.equal(fini.etat, "terminee");
    assert.ok(fini.fin && fini.debut);
    assert.deepEqual(fini.resultat, resultat);
  } finally {
    await srv.fermer();
  }
});

test("charge utile : extractContractValues REEL (DocIE simule par fetchImpl) -> resultat identique, cle pour cle, a l'appel direct d'avant", async () => {
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret", DOCIE_AGENT_CONTRACT: "contract-agent-test",
  };
  const fetchImpl = async () => new Response(JSON.stringify({
    id: "chatcmpl-test", model: "contract-agent-test",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(RAW_FIXTURE.result) } }],
  }), { status: 200 });
  const extractContractValues = (corps) => extractionReelle(corps, { env, fetchImpl });
  // Ce que l'ancienne route renvoyait : res.json(await extractContractValues(req.body)).
  const direct = JSON.parse(JSON.stringify(await extractContractValues(CORPS)));

  const srv = await demarrer({ extractContractValues, env });
  try {
    const { tache } = await (await srv.post(CORPS)).json();
    const vue = await attendreFin(srv, tache);
    assert.equal(vue.etat, "terminee");
    assert.deepEqual(Object.keys(vue.resultat), ["requestId", "values", "warnings", "errors", "ok"]);
    assert.deepEqual(Object.keys(vue.resultat), Object.keys(direct));
    assert.deepEqual(vue.resultat, direct);
    assert.equal(Object.keys(vue.resultat.values).length, 19);
    assert.equal(vue.resultat.values.stSiren, "941091316");
  } finally {
    await srv.fermer();
  }
});

test("flag coupe -> 400 disabled, meme code qu'avant ; aucune tache, ni extraction, ni bridge charge", async () => {
  let extraction = 0, bridge = 0;
  const srv = await demarrer({
    env: { DOCIE_EXTRACTION_ENABLED: "false" },
    extractContractValues: async () => { extraction++; },
    chargerBridge: () => { bridge++; return { MAX_DOCUMENT_BYTES: 1e9 }; },
  });
  try {
    const r = await srv.post(CORPS);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), {
      error: "Extraction DocIE désactivée (DOCIE_EXTRACTION_ENABLED=false) — saisie manuelle requise.",
      code: "disabled",
    });
    assert.equal(srv.gestionnaire.statistiques().conservees, 0);
    assert.equal(extraction, 0);
    assert.equal(bridge, 0);
  } finally {
    await srv.fermer();
  }
});

test("validation synchrone : fichier absent, format refuse, vide ou trop gros -> 400 input, aucune tache", async () => {
  let extraction = 0;
  const srv = await demarrer({
    extractContractValues: async () => { extraction++; },
    chargerBridge: () => ({ MAX_DOCUMENT_BYTES: 64 }),
  });
  try {
    const cas = [
      [{}, "Aucun fichier reçu."],
      [{ mimeType: "application/pdf" }, "Aucun fichier reçu."],
      [{ mimeType: "application/pdf", dataBase64: "" }, "Aucun fichier reçu."],
      [{ mimeType: "application/pdf", dataBase64: 42 }, "Aucun fichier reçu."],
      // Ni type annonce accepte, ni signature reconnue.
      [{ mimeType: "text/plain", dataBase64: Buffer.from("bonjour").toString("base64") }, /Format non pris en charge/],
      // WebP : detecte par sniffMime mais refuse par le bridge.
      [{ mimeType: "image/webp", dataBase64: Buffer.from("RIFF0000WEBPVP8 ").toString("base64") }, /Format non pris en charge/],
      // Base64 qui ne decode rien.
      [{ mimeType: "application/pdf", dataBase64: "!!!!" }, /Document vide ou trop volumineux/],
      [{ mimeType: "application/pdf", dataBase64: Buffer.alloc(65, 0x25).toString("base64") }, /Document vide ou trop volumineux/],
    ];
    for (const [corps, attendu] of cas) {
      const r = await srv.post(corps);
      assert.equal(r.status, 400, JSON.stringify(corps));
      const d = await r.json();
      assert.equal(d.code, "input");
      if (typeof attendu === "string") assert.equal(d.error, attendu);
      else assert.match(d.error, attendu);
    }
    // Un PDF sans type annonce passe par la signature, comme avant.
    assert.equal((await srv.post({ dataBase64: PDF.toString("base64") })).status, 202);
    await vider();
    assert.equal(extraction, 1);
    assert.equal(srv.gestionnaire.statistiques().conservees, 1);
  } finally {
    await srv.fermer();
  }
});

test("le plafond de taille est celui du vrai bridge (MAX_DOCUMENT_BYTES) quand rien n'est injecte", async () => {
  const { MAX_DOCUMENT_BYTES } = require("../../document-parsing/bridge/docie-bridge.js");
  const srv = await demarrer({ extractContractValues: async () => ({}) });
  try {
    const trop = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20);
    trop.write("%PDF-1.4", 0, "latin1");
    const r = await srv.post({ mimeType: "application/pdf", dataBase64: trop.toString("base64") });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Document vide ou trop volumineux \(19 Mo maximum\)/);
  } finally {
    await srv.fermer();
  }
});

test("bridge introuvable au demarrage -> 500 interne, chemin du module jamais expose", async () => {
  const srv = await demarrer({
    extractContractValues: async () => ({}),
    chargerBridge: () => { throw new Error("Cannot find module '/app/document-parsing/bridge/docie-bridge.js'"); },
  });
  try {
    const r = await srv.post(CORPS);
    assert.equal(r.status, 500);
    const d = await r.json();
    assert.deepEqual(d, { error: "Pré-remplissage impossible : erreur interne.", code: "interne" });
    assert.equal(srv.journal.length, 1);
  } finally {
    await srv.fermer();
  }
});

test("echecs dans la tache : code nomme + message constant ; texte amont et secrets jamais exposes", async () => {
  const erreurs = [
    new DocIEBridgeError("configuration", "Configure a valid DOCIE_API_KEY=SECRET."),
    new DocIEBridgeError("loading", "DocIE said x-api-key=SECRET", 202, 30),
    new DocIEBridgeError("upstream", "DocIE request failed (HTTP 500) SECRET.", 500),
    Object.assign(new Error("Extraction DocIE désactivée (DOCIE_EXTRACTION_ENABLED=false) — saisie manuelle requise."), { code: "disabled" }),
    new Error("pg: password authentication failed for user SECRET"),
  ];
  let n = 0;
  const srv = await demarrer({ extractContractValues: async () => { throw erreurs[n++]; } });
  try {
    const vues = [];
    for (let i = 0; i < erreurs.length; i++) {
      const { tache } = await (await srv.post(CORPS)).json();
      vues.push(await attendreFin(srv, tache));
    }
    assert.deepEqual(vues.map((v) => [v.etat, v.erreur]), [
      ["echec", { code: "configuration", message: MESSAGES_BRIDGE.configuration }],
      ["echec", { code: "loading", message: "Modèle en cours de chargement, réessayez dans ~30 s.", eta_seconds: 30 }],
      ["echec", { code: "upstream", message: MESSAGES_BRIDGE.upstream }],
      ["echec", { code: "disabled", message: "Extraction DocIE désactivée (DOCIE_EXTRACTION_ENABLED=false) — saisie manuelle requise." }],
      ["echec", { code: "interne", message: "Pré-remplissage impossible : erreur interne." }],
    ]);
    assert.ok(!JSON.stringify(vues).includes("SECRET"));
    for (const v of vues) assert.ok(v.fin && !Object.hasOwn(v, "resultat"));
  } finally {
    await srv.fermer();
  }
});

test("GET d'un id inconnu ou expire -> 404 avec un message clair", async () => {
  let t = 5_000_000;
  const srv = await demarrer({ extractContractValues: async () => ({ ok: true }), maintenant: () => t });
  try {
    const inconnu = await srv.get(crypto.randomUUID());
    assert.equal(inconnu.status, 404);
    const { error } = await inconnu.json();
    assert.match(error, /Tâche inconnue ou expirée/);
    assert.match(error, /relancez le pré-remplissage/);

    const { tache } = await (await srv.post(CORPS)).json();
    await vider(); await vider();
    assert.equal((await srv.get(tache)).status, 200);
    t += TTL_MS;
    assert.equal((await srv.get(tache)).status, 404);
  } finally {
    await srv.fermer();
  }
});

test("file pleine : 2 en cours + 20 en attente acceptees, la suivante -> 503 avec un message", async () => {
  const bloque = differe();
  const srv = await demarrer({ extractContractValues: () => bloque.promesse });
  try {
    for (let i = 0; i < 22; i++) assert.equal((await srv.post(CORPS)).status, 202);
    const r = await srv.post(CORPS);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Trop de pré-remplissages en attente \(20 maximum\)/);
    assert.deepEqual(srv.gestionnaire.statistiques(), { enCours: 2, enAttente: 20, conservees: 22 });
    bloque.resoudre({ ok: true });
  } finally {
    await srv.fermer();
  }
});

test("server.js monte bien ces routes, et plus aucune route d'extraction synchrone", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /monterPreremplissage\(app, \{ extractContractValues, gestionnaire: creerGestionnaire\(\) \}\);/);
  assert.doesNotMatch(source, /app\.post\("\/api\/contracts\/importer\/extraire"/);
  assert.doesNotMatch(source, /app\.get\("\/api\/taches/);
});
