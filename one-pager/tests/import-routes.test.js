"use strict";

/**
 * Tests de lib/import-routes.js — POST /api/import en 202 puis GET /api/taches/:id.
 *
 * Une vraie application express ecoute sur 127.0.0.1 (port choisi par le
 * systeme) ; importerCv et la base sont remplaces : ni DocIE, ni PostgreSQL.
 * server.js n'est pas charge (il exige DATABASE_URL) : on monte les memes
 * routes, avec le meme analyseur JSON.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { monterImport } = require("../lib/import-routes");
const { creerGestionnaire, TTL_MS } = require("../lib/import-taches");
const { importerCv: importerCvReel, ImportError } = require("../lib/import-pipeline");

function differe() {
  let resoudre, rejeter;
  const promesse = new Promise((ok, ko) => { resoudre = ok; rejeter = ko; });
  return { promesse, resoudre, rejeter };
}
const vider = () => new Promise((ok) => setImmediate(ok));

async function demarrer({ importerCv, db = { findByHash: async () => null }, maintenant } = {}) {
  const app = express();
  app.use(express.json({ limit: "25mb" })); // meme reglage que server.js
  const gestionnaire = creerGestionnaire({ journal: () => {}, ...(maintenant ? { maintenant } : {}) });
  monterImport(app, { importerCv, db, gestionnaire });
  const serveur = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return {
    base, gestionnaire,
    fermer: () => new Promise((ok) => serveur.close(ok)),
    post: (corps) => fetch(base + "/api/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
    }),
    get: (id) => fetch(base + "/api/taches/" + id),
  };
}

const CONTENU = Buffer.from("Alice Dupont\nData Engineer\nalice.dupont@example.com\n", "utf8");
const CORPS = { filename: "cv.txt", contentBase64: CONTENU.toString("base64") };

test("POST repond 202 { tache } tout de suite, meme si l'extraction dure ; GET passe en_cours -> terminee", async () => {
  const lente = differe();
  const appels = [];
  const master = { identity: { full_name: "Alice DUPONT" }, experiences: [], quality: { warnings: [] } };
  const srv = await demarrer({
    importerCv: async (buffer, filename) => { appels.push({ buffer, filename }); await lente.promesse; return master; },
  });
  try {
    const t0 = performance.now();
    const r = await srv.post(CORPS);
    const duree = performance.now() - t0;
    assert.equal(r.status, 202);
    const { tache, ...reste } = await r.json();
    assert.deepEqual(reste, {});
    assert.match(tache, /^[0-9a-f-]{36}$/);
    assert.ok(duree < 1000, `POST en ${duree.toFixed(0)} ms`);

    // L'extraction est bien lancee, avec le document et le nom recus.
    await vider();
    assert.equal(appels.length, 1);
    assert.ok(appels[0].buffer.equals(CONTENU));
    assert.equal(appels[0].filename, "cv.txt");

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
    // Meme charge utile que l'ancienne route synchrone, cle pour cle.
    assert.deepEqual(Object.keys(fini.resultat), ["id", "hash", "master", "duree_ms", "doublon"]);
    assert.match(fini.resultat.id, /^[0-9a-f-]{36}$/);
    assert.equal(fini.resultat.hash, crypto.createHash("sha256").update(CONTENU).digest("hex"));
    assert.deepEqual(fini.resultat.master, master);
    assert.equal(typeof fini.resultat.duree_ms, "number");
    assert.equal(fini.resultat.doublon, null);
  } finally {
    await srv.fermer();
  }
});

test("doublon : un fichier deja en base est signale dans le resultat, comme avant", async () => {
  const hashes = [];
  const srv = await demarrer({
    importerCv: async () => ({ identity: {} }),
    db: { findByHash: async (h) => { hashes.push(h); return { id: "cv-1", nom: "Alice", maj_le: "2026-09-01", master: { lourd: true } }; } },
  });
  try {
    const { tache } = await (await srv.post(CORPS)).json();
    await vider(); await vider();
    const fini = await (await srv.get(tache)).json();
    assert.deepEqual(fini.resultat.doublon, { id: "cv-1", nom: "Alice", maj_le: "2026-09-01" });
    assert.deepEqual(hashes, [crypto.createHash("sha256").update(CONTENU).digest("hex")]);
  } finally {
    await srv.fermer();
  }
});

test("validation synchrone : sans fichier -> 400 et aucune tache creee", async () => {
  let appele = 0;
  const srv = await demarrer({ importerCv: async () => { appele++; } });
  try {
    for (const corps of [{}, { filename: "cv.pdf" }, { filename: "cv.pdf", contentBase64: "" }]) {
      const r = await srv.post(corps);
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: "Aucun fichier reçu." });
    }
    assert.equal(srv.gestionnaire.statistiques().conservees, 0);
    assert.equal(appele, 0);
  } finally {
    await srv.fermer();
  }
});

test("echec : ImportError -> etat echec, code input, message de l'import ; texte amont jamais expose", async () => {
  const msg = "Ce PDF ne contient pas de texte : il s'agit probablement d'un scan ou d'une image.";
  const erreurs = [
    new ImportError(422, msg),
    Object.assign(new Error("DocIE said x-api-key=SECRET"), { name: "DocIEBridgeError", code: "loading", eta_seconds: 30 }),
    new Error("pg: password authentication failed for user SECRET"),
  ];
  let n = 0;
  const srv = await demarrer({ importerCv: async () => { throw erreurs[n++]; } });
  try {
    const vues = [];
    for (let i = 0; i < erreurs.length; i++) {
      const { tache } = await (await srv.post(CORPS)).json();
      await vider(); await vider();
      vues.push(await (await srv.get(tache)).json());
    }
    assert.deepEqual(vues.map((v) => [v.etat, v.erreur]), [
      ["echec", { code: "input", message: msg }],
      ["echec", { code: "loading", message: "Modèle en cours de chargement, réessayez dans ~30 s.", eta_seconds: 30 }],
      ["echec", { code: "interne", message: "Lecture impossible : erreur interne." }],
    ]);
    assert.ok(!JSON.stringify(vues).includes("SECRET"));
  } finally {
    await srv.fermer();
  }
});

test("GET d'un id inconnu ou expire -> 404 avec un message clair", async () => {
  let t = 5_000_000;
  const srv = await demarrer({ importerCv: async () => ({ identity: {} }), maintenant: () => t });
  try {
    const inconnu = await srv.get(crypto.randomUUID());
    assert.equal(inconnu.status, 404);
    const { error } = await inconnu.json();
    assert.match(error, /Tâche inconnue ou expirée/);
    assert.match(error, /relancez l'import/);

    const { tache } = await (await srv.post(CORPS)).json();
    await vider(); await vider();
    assert.equal((await srv.get(tache)).status, 200);
    t += TTL_MS;
    assert.equal((await srv.get(tache)).status, 404);
  } finally {
    await srv.fermer();
  }
});

test("file pleine : 503 avec un message, pas de tache perdue", async () => {
  const bloque = differe();
  const srv = await demarrer({ importerCv: () => bloque.promesse });
  try {
    for (let i = 0; i < 22; i++) assert.equal((await srv.post(CORPS)).status, 202);
    const r = await srv.post(CORPS);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Trop d'imports en attente/);
    bloque.resoudre({ identity: {} });
  } finally {
    await srv.fermer();
  }
});

test("importerCv reel, DocIE en echec (fetch simule) : le repli local et ses avertissements traversent la tache", async () => {
  // Aucune socket vers DocIE : fetchImpl renvoie une 500 fabriquee ici.
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.test",
    DOCIE_API_KEY: "test-key", DOCIE_AGENT_RESUME: "adbi_agent_1",
  };
  const fetchImpl = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  const importerCv = (buffer, filename) => importerCvReel(buffer, filename, { env, fetchImpl });
  const direct = await importerCv(CONTENU, "cv.txt");

  const srv = await demarrer({ importerCv });
  try {
    const { tache } = await (await srv.post(CORPS)).json();
    let vue;
    for (let i = 0; i < 200; i++) {
      vue = await (await srv.get(tache)).json();
      if (vue.etat !== "en_cours") break;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.equal(vue.etat, "terminee");
    assert.equal(vue.resultat.master.source.extraction_method, "local_fallback:upstream");
    assert.ok(vue.resultat.master.quality.warnings.includes("docie_indisponible_repli_local:upstream"));
    // Le cv_master traverse la tache sans retouche (serialisation JSON mise a
    // part) ; seul l'horodatage d'analyse differe entre les deux lectures.
    const attendu = JSON.parse(JSON.stringify(direct));
    attendu.source.parsed_at = vue.resultat.master.source.parsed_at;
    assert.deepEqual(vue.resultat.master, attendu);
  } finally {
    await srv.fermer();
  }
});

test("server.js monte bien ces routes (et plus de gestionnaire synchrone)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Le gestionnaire prend le plafond lu dans ADBI_EXTRACTION_MAX_CONCURRENT
  // (#196), jamais le defaut du module en silence.
  assert.match(source, /MAX_EXTRACTIONS_SIMULTANEES = maxSimultaneesDepuisEnv\(\);/);
  assert.match(source, /monterImport\(app, \{ importerCv, db, gestionnaire: creerGestionnaire\(\{ maxSimultanees: MAX_EXTRACTIONS_SIMULTANEES \}\) \}\)/);
  assert.doesNotMatch(source, /app\.post\("\/api\/import"/);
});
