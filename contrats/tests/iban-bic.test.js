"use strict";
// Tests de lib/iban-bic.js — contrôle de l'IBAN et du BIC lus sur un RIB (#194).
// Pendant JS de document-parsing/mappings/test_iban_bic.py : les deux
// exécutent chaque cas de document-parsing/fixtures/iban_bic.json, messages
// exacts compris, et le test d'exécution croisée ci-dessous compare les deux
// portages sur la même fixture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  MOTIF_SEPARATEURS, LONGUEURS_IBAN, STATUTS, FORMAT_INVALIDE, CLE_INVALIDE, PAYS_DISCORDANT, VALIDE,
  controlerIbanBic, messagesIbanBic,
} = require("../lib/iban-bic");

const RACINE = path.join(__dirname, "..", "..");
const IBAN_BIC = require(path.join(RACINE, "document-parsing", "fixtures", "iban_bic.json"));
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const estChiffre = (c) => c >= "0" && c <= "9";

function libelle(cas) {
  return JSON.stringify([cas.iban, cas.bic]) + " (" + cas.preuve + ")";
}

test("iban/bic : motif, longueurs et statuts identiques à la fixture partagée", () => {
  assert.equal(MOTIF_SEPARATEURS, IBAN_BIC.motif_separateurs);
  assert.deepEqual(LONGUEURS_IBAN, IBAN_BIC.longueurs_iban);
  assert.deepEqual(STATUTS, IBAN_BIC.statuts);
  assert.ok(IBAN_BIC._ports.includes("contrats/lib/iban-bic.js (JS, validateur)"));
});

test("iban/bic : chaque cas du jeu d'essai (statuts, compacts, pays, messages exacts)", () => {
  for (const cas of IBAN_BIC.cas) {
    const controle = controlerIbanBic(cas.iban, cas.bic);
    assert.equal(controle.iban.statut, cas.statut_iban, libelle(cas));
    assert.equal(controle.iban.compact, cas.compact_iban, libelle(cas));
    assert.equal(controle.iban.pays, cas.pays_iban, libelle(cas));
    assert.equal(controle.bic.statut, cas.statut_bic, libelle(cas));
    assert.equal(controle.bic.compact, cas.compact_bic, libelle(cas));
    assert.equal(controle.bic.pays, cas.pays_bic, libelle(cas));
    assert.deepEqual(messagesIbanBic(controle), cas.messages, libelle(cas));
  }
});

test("iban/bic : chaque statut est exercé par la fixture", () => {
  const vus = new Set(IBAN_BIC.cas.flatMap((cas) => [cas.statut_iban, cas.statut_bic]));
  assert.deepEqual([...vus].sort(), [...STATUTS].sort());
});

test("iban/bic : format, clé et pays ne s'annoncent pas pareil", () => {
  const fr = "FR1420041010050500013M02606";
  const libelles = { [FORMAT_INVALIDE]: "format invalide", [CLE_INVALIDE]: "clé de contrôle invalide", [PAYS_DISCORDANT]: "différent du pays" };
  const exemples = {
    [FORMAT_INVALIDE]: controlerIbanBic(fr.slice(0, -1), null),
    [CLE_INVALIDE]: controlerIbanBic(fr.slice(0, -1) + "7", null),
    [PAYS_DISCORDANT]: controlerIbanBic(fr, "DEUTDEFF"),
  };
  for (const [statut, controle] of Object.entries(exemples)) {
    const messages = messagesIbanBic(controle);
    assert.equal(messages.length, 1, statut);
    for (const [autre, texte] of Object.entries(libelles)) {
      assert.equal(messages[0].message.includes(texte), autre === statut, statut + " / " + texte);
    }
  }
});

test("iban/bic : la valeur lue n'est jamais modifiée", () => {
  const controle = controlerIbanBic(" fr14 2004 1010 0505 0001 3m02 606", "bnpa fr pp");
  assert.equal(controle.iban.valeur, " fr14 2004 1010 0505 0001 3m02 606");
  assert.equal(controle.bic.valeur, "bnpa fr pp");
  assert.equal(controle.iban.statut, VALIDE);
});

test("iban/bic : détection MESURÉE — substitutions de même classe et transpositions toutes refusées", () => {
  const exemples = [...new Set(IBAN_BIC.cas
    .filter((c) => c.statut_iban === VALIDE && typeof c.iban === "string" && c.iban === c.compact_iban && !c.preuve.includes("LIMITE"))
    .map((c) => c.iban))];
  assert.ok(exemples.length >= 4);
  for (const iban of exemples) {
    for (let i = 0; i < iban.length; i++) {
      for (const autre of ALPHABET) {
        if (autre === iban[i] || estChiffre(autre) !== estChiffre(iban[i])) continue;
        const faux = iban.slice(0, i) + autre + iban.slice(i + 1);
        assert.notEqual(controlerIbanBic(faux, null).iban.statut, VALIDE, faux);
      }
    }
    for (let i = 0; i < iban.length - 1; i++) {
      if (iban[i] === iban[i + 1]) continue;
      const faux = iban.slice(0, i) + iban[i + 1] + iban[i] + iban.slice(i + 2);
      assert.notEqual(controlerIbanBic(faux, null).iban.statut, VALIDE, faux);
    }
  }
});

test("iban/bic : même verdict que le portage Python sur chaque cas (exécution croisée)", (t) => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import iban_bic as m",
    "f = json.load(open(sys.argv[2], encoding='utf-8'))",
    "out = []",
    "for c in f['cas']:",
    "    r = m.controler_iban_bic(c['iban'], c['bic'])",
    "    out.append({'controle': r, 'messages': m.messages_iban_bic(r)})",
    "sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))",
  ].join("\n");
  const python = spawnSync(process.platform === "win32" ? "python" : "python3", [
    "-c", script,
    path.join(RACINE, "document-parsing", "mappings"),
    path.join(RACINE, "document-parsing", "fixtures", "iban_bic.json"),
  ], { encoding: "utf-8" });
  if (python.error || python.status !== 0) {
    t.skip("Python indisponible : " + (python.error ? python.error.message : python.stderr));
    return;
  }
  const verdictsPython = JSON.parse(python.stdout);
  assert.equal(verdictsPython.length, IBAN_BIC.cas.length);
  IBAN_BIC.cas.forEach((cas, i) => {
    const controle = controlerIbanBic(cas.iban, cas.bic);
    assert.deepEqual({ controle, messages: messagesIbanBic(controle) }, verdictsPython[i], libelle(cas));
  });
});

test("iban/bic : la fixture n'est chargée par aucun module de production", () => {
  const fichiers = [
    path.join(__dirname, "..", "server.js"),
    ...fs.readdirSync(path.join(__dirname, "..", "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(__dirname, "..", "lib", f)),
  ];
  for (const fichier of fichiers) {
    assert.doesNotMatch(fs.readFileSync(fichier, "utf-8"), /["'`][^"'`\n]*iban_bic\.json["'`]/, fichier);
  }
});
