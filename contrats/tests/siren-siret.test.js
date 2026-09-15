"use strict";
// Tests de lib/siren-siret.js — contrôle de clé du SIREN / SIRET (#194).
// Pendant JS de document-parsing/mappings/test_siren_siret.py : les deux
// exécutent chaque cas de document-parsing/fixtures/siren_siret.json, messages
// exacts compris. Une divergence entre les deux langages redevient donc un
// échec de test (discipline de #179). Les deux mappings JS exécutent en plus
// chaque cas de bout en bout (tests/kbis-mapping.test.js,
// tests/docie-contract-import.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  MOTIF_SEPARATEURS, STATUTS, FORMAT_INVALIDE, CLE_INVALIDE, DISCORDANT,
  controlerSirenSiret, messagesSirenSiret,
} = require("../lib/siren-siret");

const RACINE = path.join(__dirname, "..", "..");
const SIREN_SIRET = require(path.join(RACINE, "document-parsing", "fixtures", "siren_siret.json"));

function libelle(cas) {
  return JSON.stringify([cas.siren, cas.siret]) + " (" + cas.preuve + ")";
}

test("siren/siret : motif et statuts identiques à la fixture partagée", () => {
  assert.equal(MOTIF_SEPARATEURS, SIREN_SIRET.motif_separateurs);
  assert.deepEqual(STATUTS, SIREN_SIRET.statuts);
  assert.ok(SIREN_SIRET._ports.includes("contrats/lib/siren-siret.js (JS, validateur)"));
});

test("siren/siret : chaque cas du jeu d'essai (statuts, chiffres, messages exacts)", () => {
  for (const cas of SIREN_SIRET.cas) {
    const controle = controlerSirenSiret(cas.siren, cas.siret);
    assert.equal(controle.siren.statut, cas.statut_siren, libelle(cas));
    assert.equal(controle.siret.statut, cas.statut_siret, libelle(cas));
    assert.equal(controle.siren.chiffres, cas.chiffres_siren, libelle(cas));
    assert.equal(controle.siret.chiffres, cas.chiffres_siret, libelle(cas));
    assert.deepEqual(messagesSirenSiret(controle), cas.messages, libelle(cas));
  }
});

test("siren/siret : chaque statut est exercé par la fixture", () => {
  const vus = new Set(SIREN_SIRET.cas.flatMap((cas) => [cas.statut_siren, cas.statut_siret]));
  assert.deepEqual([...vus].sort(), [...STATUTS].sort());
});

test("siren/siret : format, clé et discordance ne s'annoncent pas pareil", () => {
  const libelles = { [FORMAT_INVALIDE]: "format invalide", [CLE_INVALIDE]: "clé de contrôle invalide", [DISCORDANT]: "discordant" };
  const exemples = {
    [FORMAT_INVALIDE]: controlerSirenSiret("94109131", null),
    [CLE_INVALIDE]: controlerSirenSiret("941091317", null),
    [DISCORDANT]: controlerSirenSiret("941091316", "55212022200005"),
  };
  for (const [statut, controle] of Object.entries(exemples)) {
    const messages = messagesSirenSiret(controle);
    assert.equal(messages.length, 1, statut);
    for (const [autre, texte] of Object.entries(libelles)) {
      assert.equal(messages[0].message.includes(texte), autre === statut, statut + " / " + texte);
    }
  }
});

test("siren/siret : la valeur lue n'est jamais modifiée", () => {
  const controle = controlerSirenSiret("941 091 317", " 941 091 316 00013");
  assert.equal(controle.siren.valeur, "941 091 317");
  assert.equal(controle.siret.valeur, " 941 091 316 00013");
});

test("siren/siret : même verdict que le portage Python sur chaque cas (exécution croisée)", (t) => {
  // Garde-fou inter-langages : les deux portages sont exécutés ICI sur la
  // même fixture, pas seulement chacun contre elle dans sa propre suite.
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import siren_siret as m",
    "f = json.load(open(sys.argv[2], encoding='utf-8'))",
    "out = []",
    "for c in f['cas']:",
    "    r = m.controler_siren_siret(c['siren'], c['siret'])",
    "    out.append({'controle': r, 'messages': m.messages_siren_siret(r)})",
    "sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))",
  ].join("\n");
  const python = spawnSync(process.platform === "win32" ? "python" : "python3", [
    "-c", script,
    path.join(RACINE, "document-parsing", "mappings"),
    path.join(RACINE, "document-parsing", "fixtures", "siren_siret.json"),
  ], { encoding: "utf-8" });
  if (python.error || python.status !== 0) {
    t.skip("Python indisponible : " + (python.error ? python.error.message : python.stderr));
    return;
  }
  const verdictsPython = JSON.parse(python.stdout);
  assert.equal(verdictsPython.length, SIREN_SIRET.cas.length);
  SIREN_SIRET.cas.forEach((cas, i) => {
    const controle = controlerSirenSiret(cas.siren, cas.siret);
    assert.deepEqual(
      { controle, messages: messagesSirenSiret(controle) },
      verdictsPython[i],
      libelle(cas)
    );
  });
});

test("siren/siret : la fixture n'est chargée par aucun module de production", () => {
  // L'image Docker de contrats ne copie pas cette fixture : aucun littéral de
  // chaîne la nommant hors des tests (les commentaires la citent sans
  // guillemets).
  const fichiers = [
    path.join(__dirname, "..", "server.js"),
    ...fs.readdirSync(path.join(__dirname, "..", "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(__dirname, "..", "lib", f)),
  ];
  for (const fichier of fichiers) {
    assert.doesNotMatch(fs.readFileSync(fichier, "utf-8"), /["'`][^"'`\n]*siren_siret\.json["'`]/, fichier);
  }
});
