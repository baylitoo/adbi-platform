"use strict";
// Recherche société par SIREN/SIRET (lib/integrations.js::getCompany, route
// POST /api/lookup) : un SIREN dont la clé de Luhn est fausse (#201) est
// refusé en 400 AVANT tout appel à gouv.fr, Pappers ou l'INSEE.
//
// Aucun réseau : globalThis.fetch est remplacé par un bouchon qui compte ses
// appels (et rend une réponse gouv.fr factice pour les témoins positifs).
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

test("précondition : source de recherche par défaut (gouv.fr), sans clé Pappers/INSEE configurée", () => {
  // Le refus est placé avant le choix de la source : il vaut quelle que soit
  // la source. Les témoins positifs ci-dessous supposent gouv.fr.
  assert.equal(settingsStatus().source, "gouv");
});

test("SIREN à clé invalide (jeu d'essai #201) : 400 nommé, AUCUN appel sortant", async () => {
  const refuses = SIREN_SIRET.cas
    .filter((c) => typeof c.siren === "string" && c.statut_siren === "cle_invalide" && c.siren.replace(/\D/g, "").length === 9)
    .map((c) => c.siren);
  assert.ok(refuses.length >= 7, "cas du jeu d'essai : " + refuses.length);
  await avecFetchBouchon(async (appels) => {
    for (const q of refuses) {
      await assert.rejects(getCompany(q), (e) => {
        assert.equal(e.status, 400, q);
        assert.equal(e.message, "SIREN « " + q.trim() + " » : clé de contrôle invalide — un chiffre est probablement mal saisi ou mal lu. Recherche non lancée.");
        return true;
      });
    }
    assert.deepEqual(appels, [], "aucun appel à un fournisseur");
  });
});

test("SIRET dont le SIREN contenu a une clé invalide : 400 nommé, aucun appel sortant", async () => {
  await avecFetchBouchon(async (appels) => {
    for (const q of ["12345678900012", "94109131700013", "941 091 317 00013"]) {
      assert.equal(controlerSirenSiret(q.replace(/\D/g, "").slice(0, 9), null).siren.statut, "cle_invalide", "précondition " + q);
      await assert.rejects(getCompany(q), (e) => {
        assert.equal(e.status, 400);
        assert.equal(e.message, "SIRET « " + q + " » : le SIREN qu'il contient (" + q.replace(/\D/g, "").slice(0, 9) + ") a une clé de contrôle invalide — un chiffre est probablement mal saisi ou mal lu. Recherche non lancée.");
        return true;
      });
    }
    assert.deepEqual(appels, []);
  });
});

test("témoins : SIREN / SIRET valides -> la recherche part (un appel, par SIREN)", async () => {
  await avecFetchBouchon(async (appels) => {
    const r = await getCompany("941091316");
    assert.equal(r.stSiren, "941091316");
    await getCompany("941 091 316 00013");
    assert.equal(appels.length, 2);
    for (const u of appels) assert.equal(new URL(u).searchParams.get("q"), "941091316");
  });
});

test("La Poste : SIRET hors Luhn (lacune connue de #201) -> recherche possible, par son SIREN 356000000 qui passe Luhn", async () => {
  const lacune = SIREN_SIRET.cas.find((c) => c.siret === "35600000000001");
  assert.equal(lacune.statut_siret, "cle_invalide", "précondition : #201 le déclare clé invalide");
  await avecFetchBouchon(async (appels) => {
    await getCompany("35600000000001");
    await getCompany("356000000");
    assert.deepEqual(appels.map((u) => new URL(u).searchParams.get("q")), ["356000000", "356000000"]);
  });
  // Même règle pour tout SIRET : seul le SIREN recherché compte (NIC jamais envoyé).
  await avecFetchBouchon(async (appels) => {
    await getCompany("94109131600031"); // clé SIRET fausse, SIREN valide (jeu d'essai)
    assert.equal(appels.length, 1);
  });
});

test("format : message et refus d'avant inchangés (nom de société, 8 chiffres), aucun appel", async () => {
  await avecFetchBouchon(async (appels) => {
    for (const q of ["ADCONSI", "94109131", "", undefined]) {
      await assert.rejects(getCompany(q), { message: "Saisir un SIREN (9 chiffres) ou un SIRET (14 chiffres)." });
    }
    assert.deepEqual(appels, []);
  });
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

test("route POST /api/lookup (vrai gestionnaire de server.js) : 400 + message pour une clé invalide, sans appel sortant ; 200 sinon", async () => {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line no-new-func
  new Function("app", "getCompany", routeLookup())(app, getCompany);
  const serveur = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    await avecFetchBouchon(async (appels) => {
      const port = serveur.address().port;
      const ko = await poster(port, { q: "123456789" });
      assert.equal(ko.status, 400);
      assert.deepEqual(ko.body, { error: "SIREN « 123456789 » : clé de contrôle invalide — un chiffre est probablement mal saisi ou mal lu. Recherche non lancée." });
      assert.deepEqual(appels, []);
      const ok = await poster(port, { q: "941091316" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.stSiren, "941091316");
      assert.equal(appels.length, 1);
    });
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
  }
});
