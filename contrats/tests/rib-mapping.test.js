"use strict";
// Tests de lib/rib-mapping.js — pendant JS de
// document-parsing/mappings/test_rib_to_contrats.py. Lit LES MÊMES fixtures
// que Python et les fait passer par le VRAI déballage du pont
// (docie-bridge.js::parseTextResponse -> unwrap), comme urssaf-mapping.test.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const RIB = require("../lib/rib-mapping");
const {
  DOCANALYZE_BASE_KEYS, ENRICHED_KEYS, MAPPED_FIELDS, DOCUMENT_TYPE_LABEL, IBAN_ABSENT, mapRibResult,
} = RIB;
const IBAN_BIC_LIB = require("../lib/iban-bic");
const { checkName } = require("../lib/docanalyze");

const RACINE = path.join(__dirname, "..", "..");
const { parseTextResponse } = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));
const FIXTURES = path.join(RACINE, "document-parsing", "mappings", "fixtures");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "rib.schema.json"));
const IBAN_BIC = require(path.join(RACINE, "document-parsing", "fixtures", "iban_bic.json"));
const ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.";

function enveloppe(nom) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, nom), "utf8"));
}
function lu(nom) {
  const { result, metadata } = parseTextResponse(enveloppe(nom), "rib");
  return { result, validation: metadata.validation };
}

test("réutilisation : le validateur et checkName sont importés, jamais recopiés", () => {
  assert.equal(RIB.controlerIbanBic, IBAN_BIC_LIB.controlerIbanBic);
  assert.equal(RIB.messagesIbanBic, IBAN_BIC_LIB.messagesIbanBic);
  assert.equal(RIB.checkName, checkName);
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "rib-mapping.js"), "utf8");
  assert.ok(/require\("\.\/iban-bic"\)/.test(source));
  assert.ok(!/function\s+(controlerIbanBic|messagesIbanBic|modulo97|controlerIban|controlerBic|checkName)\b|(const|let|var)\s+(controlerIbanBic|messagesIbanBic|modulo97|checkName)\s*=/.test(source),
    "rib-mapping.js ne doit PAS redéfinir le validateur");
  assert.ok(!/%\s*97/.test(source));
});

test("schéma : chaque champ est mappé et réciproquement ; rien de ce que l'IBAN contient déjà", () => {
  assert.equal(SCHEMA.document_type, "rib");
  assert.deepEqual(new Set(SCHEMA.fields.map((f) => f.name)), new Set(Object.keys(MAPPED_FIELDS)));
  for (const f of SCHEMA.fields) {
    assert.deepEqual(Object.keys(f), ["name", "type", "description", "fields"]);
    assert.match(f.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(f.type, "string");
    assert.deepEqual(f.fields, []);
  }
});

test("cas nominal : mêmes valeurs que le portage Python, IBAN et BIC valides", () => {
  const { result, validation } = lu("rib_extraction_sample.json");
  const { analysis, warnings } = mapRibResult(result, { expectedName: "Sund Industry System", items: [{ id: "rib" }], validation });
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  assert.ok(!ENRICHED_KEYS.includes("controleIbanBic"));
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.equal(analysis.matchedId, "rib");
  assert.equal(analysis.isValid, true);
  assert.equal(analysis.issuedDate, "");
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.nameMatches, true);
  assert.equal(analysis.titulaireCompte, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.iban, "FR14 2004 1010 0505 0001 3M02 606");
  assert.equal(analysis.bic, "BNPAFRPP");
  assert.equal(analysis.nomBanque, "BANQUE EXEMPLE PARIS OPERA");
  assert.equal(analysis.controleIbanBic.iban.statut, "valide");
  assert.equal(analysis.controleIbanBic.iban.compact, "FR1420041010050500013M02606");
  assert.equal(analysis.controleIbanBic.bic.statut, "valide");
  assert.deepEqual(analysis.issues, []);
  assert.deepEqual(warnings, []);
  assert.equal(analysis.summary, "RIB");
});

test("le libellé du type reste celui de docanalyze.js::detectType", () => {
  const source = fs.readFileSync(path.join(RACINE, "contrats", "lib", "docanalyze.js"), "utf8");
  assert.ok(source.includes('type = "' + DOCUMENT_TYPE_LABEL + '"'));
});

test("cas limites : IBAN mal lu et BIC mal formé CONSERVÉS, signalés, validation négative", () => {
  const { result, validation } = lu("rib_extraction_sample_edge_cases.json");
  const { analysis, warnings } = mapRibResult(result, { expectedName: "SUND INDUSTRY SYSTEM", validation });
  assert.equal(analysis.iban, "FR14 2004 1010 0505 0001 3M02 607");
  assert.equal(analysis.controleIbanBic.iban.statut, "cle_invalide");
  assert.ok(analysis.issues.includes("IBAN « FR14 2004 1010 0505 0001 3M02 607 » : clé de contrôle invalide (modulo 97), caractère probablement mal lu — valeur conservée, à vérifier sur le document"));
  assert.equal(analysis.bic, "BNPAFRPPX");
  assert.equal(analysis.controleIbanBic.bic.statut, "format_invalide");
  assert.equal(analysis.nomBanque, "");
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.ok(analysis.issues.includes("DocIE n'a pas validé l'extraction (vérification manuelle recommandée)."));
  assert.ok(warnings.some((w) => w.startsWith("iban: IBAN «")));
  assert.ok(warnings.some((w) => w.startsWith("DocIE extraction_notes:")));
});

test("illisible : forme docanalyze.js, champ isolé gardé ; IBAN absent seul : nommé", () => {
  const { result, validation } = lu("rib_extraction_sample_unreadable.json");
  const { analysis } = mapRibResult(result, { validation });
  assert.equal(analysis.documentType, "Document");
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.nameMatches, null);
  assert.equal(analysis.summary, "Document illisible.");
  assert.deepEqual(analysis.issues, [ILLISIBLE]);
  assert.equal(analysis.nomBanque, "BANQUE");

  const r = lu("rib_extraction_sample.json").result;
  r.iban = null;
  const sansIban = mapRibResult(r, {}).analysis;
  assert.equal(sansIban.documentType, DOCUMENT_TYPE_LABEL);
  assert.ok(sansIban.issues.includes(IBAN_ABSENT));
});

test("titulaire d'une autre société / matchedId : port exact de checkName et detectType", () => {
  const r = lu("rib_extraction_sample.json").result;
  const autre = mapRibResult(r, { expectedName: "Autre Societe SARL" }).analysis;
  assert.equal(autre.nameMatches, false);
  assert.ok(autre.issues.includes("La société du document ne correspond pas au sous-traitant saisi."));
  assert.equal(mapRibResult(r, {}).analysis.nameMatches, null);
  assert.equal(mapRibResult(r, { items: [{ id: "kbis" }] }).analysis.matchedId, null);
});

test("jeu d'essai iban_bic.json de bout en bout : statuts, messages dans issues, valeurs conservées", () => {
  assert.ok(IBAN_BIC._ports.includes("contrats/lib/rib-mapping.js (JS)"));
  const base = lu("rib_extraction_sample.json").result;
  for (const cas of IBAN_BIC.cas) {
    const r = Object.assign({}, base, { iban: cas.iban, bic: cas.bic });
    const { analysis } = mapRibResult(r, {});
    const libelle = JSON.stringify([cas.iban, cas.bic]);
    assert.equal(analysis.controleIbanBic.iban.statut, cas.statut_iban, libelle);
    assert.equal(analysis.controleIbanBic.bic.statut, cas.statut_bic, libelle);
    assert.deepEqual(analysis.issues.filter((i) => i.startsWith("IBAN «") || i.startsWith("BIC «")),
      cas.messages.map((m) => m.message), libelle);
    assert.equal(analysis.iban, cas.iban === null ? "" : String(cas.iban), libelle);
    assert.equal(analysis.bic, cas.bic === null ? "" : String(cas.bic), libelle);
  }
});

test("garde-fou : un résultat non-objet lève une erreur explicite", () => {
  for (const mauvais of [null, undefined, [], "x", 3]) {
    assert.throws(() => mapRibResult(mauvais), /Résultat DocIE 'rib' invalide/);
  }
});
