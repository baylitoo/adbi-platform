"use strict";
// Recherche société par SIREN/SIRET (lib/integrations.js::getCompany, route
// POST /api/lookup) : un SIREN dont la clé de Luhn est fausse (#201) est
// refusé en 400 AVANT tout appel à gouv.fr, Pappers ou l'INSEE.
//
// Aucun réseau : globalThis.fetch est remplacé par un bouchon qui compte ses
// appels (et rend une réponse gouv.fr factice pour les témoins positifs).
// Indépendant du poste : source et clés Pappers/INSEE épinglées par
// avecConfiguration (secrets.json et variables d'environnement).
// Aucune base : server.js n'est jamais require() (il exige DATABASE_URL) ; la
// route est relue dans sa source et montée sur une app Express de test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");

const { getCompany, settingsStatus } = require("../lib/integrations");
const { controlerSirenSiret } = require("../lib/siren-siret");
const SIREN_SIRET = require(path.join(__dirname, "..", "..", "document-parsing", "fixtures", "siren_siret.json"));
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Bouchon de fetch : chaque appel est noté ; réponse gouv.fr minimale.
async function avecFetchBouchon(fn) {
  const appels = [];
  const avant = globalThis.fetch;
  globalThis.fetch = async (url) => {
    appels.push(String(url));
    const q = new URL(String(url)).searchParams.get("q") || "";
    return new Response(JSON.stringify({ results: [{
      siren: q.slice(0, 9), nom_raison_sociale: "SOCIÉTÉ " + q, siege: { siret: q.slice(0, 9) + "00013" },
    }] }), { status: 200 });
  };
  try { return await fn(appels); } finally { globalThis.fetch = avant; }
}

// Configuration de la recherche ÉPINGLÉE pour la durée d'un test : le résultat
// ne doit pas dépendre du poste. integrations.js choisit la source dans
// data/secrets.json (écran Paramètres) et lit les clés dans PAPPERS_API_KEY /
// INSEE_API_KEY OU dans ce fichier. Mesuré avant cet épinglage : un
// secrets.json « source pappers » avec sa clé, ou « source insee » avec
// INSEE_API_KEY exportée, faisait échouer 4 tests sur 7.
// - variables : PAPPERS_API_KEY et INSEE_API_KEY retirées, ou posées selon
//   `config.env`, puis restaurées ;
// - fichier : integrations.js lit data/secrets.json par fs.existsSync /
//   fs.readFileSync AU MOMENT DE L'APPEL. Ces deux fonctions sont bouchonnées
//   pour ce seul chemin (`config.secrets` null -> fichier absent), puis
//   restaurées : aucun point d'injection ajouté au code de production.
const CHEMIN_SECRETS = path.resolve(__dirname, "..", "data", "secrets.json");
const VARIABLES_CLES = ["PAPPERS_API_KEY", "INSEE_API_KEY"];
const DEFAUT = { nom: "gouv.fr (défaut)", secrets: null, env: {} };
const PAPPERS = { nom: "Pappers", secrets: { source: "pappers" }, env: { PAPPERS_API_KEY: "cle-factice" } };
const INSEE = { nom: "INSEE", secrets: { source: "insee" }, env: { INSEE_API_KEY: "cle-factice" } };
const PAPPERS_SANS_CLE = { nom: "Pappers choisi, clé absente", secrets: { source: "pappers" }, env: {} };
const INSEE_SANS_CLE = { nom: "INSEE choisi, clé absente", secrets: { source: "insee" }, env: {} };
const CONFIGURATIONS = [DEFAUT, PAPPERS, INSEE];

async function avecConfiguration(config, fn) {
  const envAvant = {};
  for (const k of VARIABLES_CLES) {
    envAvant[k] = process.env[k];
    if (config.env[k] === undefined) delete process.env[k];
    else process.env[k] = config.env[k];
  }
  const existsAvant = fs.existsSync;
  const lireAvant = fs.readFileSync;
  const estSecrets = (p) => typeof p === "string" && path.resolve(p) === CHEMIN_SECRETS;
  fs.existsSync = function (p, ...reste) {
    return estSecrets(p) ? config.secrets !== null : existsAvant.call(this, p, ...reste);
  };
  fs.readFileSync = function (p, ...reste) {
    if (!estSecrets(p)) return lireAvant.call(this, p, ...reste);
    if (config.secrets === null) {
      const e = new Error("ENOENT : secrets.json absent (bouchon de test)");
      e.code = "ENOENT";
      throw e;
    }
    return JSON.stringify(config.secrets);
  };
  try {
    return await fn();
  } finally {
    fs.existsSync = existsAvant;
    fs.readFileSync = lireAvant;
    for (const k of VARIABLES_CLES) {
      if (envAvant[k] === undefined) delete process.env[k];
      else process.env[k] = envAvant[k];
    }
  }
}

test("configuration épinglée : la source ne dépend ni du secrets.json ni des variables du poste", async () => {
  // Témoins de l'épinglage lui-même (le bouchon atteint bien integrations.js).
  // « Pappers/INSEE choisi, clé absente » retombe sur gouv.fr SEULEMENT si
  // la PAPPERS_API_KEY / INSEE_API_KEY exportée sur le poste ne fuit pas.
  for (const [config, source] of [[DEFAUT, "gouv"], [PAPPERS_SANS_CLE, "gouv"], [INSEE_SANS_CLE, "gouv"], [PAPPERS, "pappers"], [INSEE, "insee"]]) {
    await avecConfiguration(config, () => assert.equal(settingsStatus().source, source, config.nom));
  }
});

test("SIREN à clé invalide (jeu d'essai #201) : 400 nommé, AUCUN appel sortant, quelle que soit la source (gouv.fr, Pappers, INSEE)", async () => {
  const refuses = SIREN_SIRET.cas
    .filter((c) => typeof c.siren === "string" && c.statut_siren === "cle_invalide" && c.siren.replace(/\D/g, "").length === 9)
    .map((c) => c.siren);
  assert.ok(refuses.length >= 7, "cas du jeu d'essai : " + refuses.length);
  for (const config of CONFIGURATIONS) {
    await avecConfiguration(config, () => avecFetchBouchon(async (appels) => {
      for (const q of refuses) {
        await assert.rejects(getCompany(q), (e) => {
          assert.equal(e.status, 400, config.nom + " " + q);
          assert.equal(e.message, "SIREN « " + q.trim() + " » : clé de contrôle invalide — un chiffre est probablement mal saisi ou mal lu. Recherche non lancée.");
          return true;
        });
      }
      assert.deepEqual(appels, [], config.nom + " : aucun appel à un fournisseur");
    }));
  }
});

test("SIRET dont le SIREN contenu a une clé invalide : 400 nommé, aucun appel sortant, quelle que soit la source", async () => {
  for (const config of CONFIGURATIONS) {
    await avecConfiguration(config, () => avecFetchBouchon(async (appels) => {
      for (const q of ["12345678900012", "94109131700013", "941 091 317 00013"]) {
        assert.equal(controlerSirenSiret(q.replace(/\D/g, "").slice(0, 9), null).siren.statut, "cle_invalide", "précondition " + q);
        await assert.rejects(getCompany(q), (e) => {
          assert.equal(e.status, 400);
          assert.equal(e.message, "SIRET « " + q + " » : le SIREN qu'il contient (" + q.replace(/\D/g, "").slice(0, 9) + ") a une clé de contrôle invalide — un chiffre est probablement mal saisi ou mal lu. Recherche non lancée.");
          return true;
        });
      }
      assert.deepEqual(appels, [], config.nom);
    }));
  }
});

test("témoins (source gouv.fr épinglée) : SIREN / SIRET valides -> la recherche part (un appel, par SIREN)", async () => {
  await avecConfiguration(DEFAUT, () => avecFetchBouchon(async (appels) => {
    const r = await getCompany("941091316");
    assert.equal(r.stSiren, "941091316");
    await getCompany("941 091 316 00013");
    assert.equal(appels.length, 2);
    for (const u of appels) assert.equal(new URL(u).searchParams.get("q"), "941091316");
  }));
});

test("La Poste (source gouv.fr épinglée) : SIRET hors Luhn (lacune connue de #201) -> recherche possible, par son SIREN 356000000 qui passe Luhn", async () => {
  const lacune = SIREN_SIRET.cas.find((c) => c.siret === "35600000000001");
  assert.equal(lacune.statut_siret, "cle_invalide", "précondition : #201 le déclare clé invalide");
  await avecConfiguration(DEFAUT, () => avecFetchBouchon(async (appels) => {
    await getCompany("35600000000001");
    await getCompany("356000000");
    assert.deepEqual(appels.map((u) => new URL(u).searchParams.get("q")), ["356000000", "356000000"]);
  }));
  // Même règle pour tout SIRET : seul le SIREN recherché compte (NIC jamais envoyé).
  await avecConfiguration(DEFAUT, () => avecFetchBouchon(async (appels) => {
    await getCompany("94109131600031"); // clé SIRET fausse, SIREN valide (jeu d'essai)
    assert.equal(appels.length, 1);
  }));
});

test("format : message et refus d'avant inchangés (nom de société, 8 chiffres), aucun appel, quelle que soit la source", async () => {
  for (const config of CONFIGURATIONS) {
    await avecConfiguration(config, () => avecFetchBouchon(async (appels) => {
      for (const q of ["ADCONSI", "94109131", "", undefined]) {
        await assert.rejects(getCompany(q), { message: "Saisir un SIREN (9 chiffres) ou un SIRET (14 chiffres)." });
      }
      assert.deepEqual(appels, [], config.nom);
    }));
  }
});

function routeLookup() {
  const debut = SERVER_JS.indexOf('app.post("/api/lookup"');
  assert.ok(debut !== -1, "route /api/lookup introuvable dans server.js");
  const reste = SERVER_JS.slice(debut);
  const m = /\r?\n\}\);\r?\n/.exec(reste);
  assert.ok(m, "fin de la route introuvable");
  return reste.slice(0, m.index + m[0].length);
}

function poster(port, corps) {
  return new Promise((resolve, reject) => {
    const donnees = Buffer.from(JSON.stringify(corps));
    const req = http.request({
      host: "127.0.0.1", port, path: "/api/lookup", method: "POST",
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

test("route POST /api/lookup (vrai gestionnaire de server.js, source gouv.fr épinglée) : 400 + message pour une clé invalide, sans appel sortant ; 200 sinon", async () => {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line no-new-func
  new Function("app", "getCompany", routeLookup())(app, getCompany);
  const serveur = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    await avecConfiguration(DEFAUT, () => avecFetchBouchon(async (appels) => {
      const port = serveur.address().port;
      const ko = await poster(port, { q: "123456789" });
      assert.equal(ko.status, 400);
      assert.deepEqual(ko.body, { error: "SIREN « 123456789 » : clé de contrôle invalide — un chiffre est probablement mal saisi ou mal lu. Recherche non lancée." });
      assert.deepEqual(appels, []);
      const ok = await poster(port, { q: "941091316" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.stSiren, "941091316");
      assert.equal(appels.length, 1);
    }));
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
  }
});
