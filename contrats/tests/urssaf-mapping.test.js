"use strict";
// Tests de lib/urssaf-mapping.js — pendant JS de
// document-parsing/mappings/test_urssaf_to_contrats.py.
//
// À la différence de kbis-mapping.test.js, qui recopie à la main l'équivalent
// déballé des fixtures Python, ce fichier lit LES MÊMES fichiers de fixtures
// et les fait passer par le VRAI déballage du pont
// (docie-bridge.js::parseTextResponse -> unwrap). Les deux portages sont donc
// nourris d'un octet identique, et une fixture régénérée ne peut pas mettre
// les deux côtés en désaccord sans faire échouer l'un des deux.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const {
  DOCANALYZE_BASE_KEYS, ENRICHED_KEYS, MAPPED_FIELDS, DOCUMENT_TYPE_LABEL,
  mapUrssafResult, MOTIF_NOMBRE, ANNEE_MIN, ANNEE_MAX,
} = require("../lib/urssaf-mapping");
const { parseTextResponse } = require(path.join(
  __dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js"
));

const RACINE = path.join(__dirname, "..", "..");
const FIXTURES = path.join(RACINE, "document-parsing", "mappings", "fixtures");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "urssaf.schema.json"));
// Jeux d'essai PARTAGÉS des normaliseurs : ce module ne les recopie pas, il
// importe ceux de kbis-mapping.js — on vérifie ici que les constantes
// ré-exportées sont bien celles de la règle unique (#179).
const NOMBRE = require(path.join(RACINE, "document-parsing", "fixtures", "nombre_docie.json"));
const DATE = require(path.join(RACINE, "document-parsing", "fixtures", "date_docie.json"));

function enveloppe(nom) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, nom), "utf8"));
}
// Le `result` tel que le consommateur JS le reçoit réellement : déballé par le
// pont, pas reconstruit à la main.
function deballe(nom) {
  return parseTextResponse(enveloppe(nom), "urssaf").result;
}
function validationDe(nom) {
  return parseTextResponse(enveloppe(nom), "urssaf").metadata.validation;
}

test("normaliseurs : ce portage pointe sur la règle unique, il n'en écrit pas une 5e copie", () => {
  assert.equal(MOTIF_NOMBRE, NOMBRE.motif);
  assert.equal(ANNEE_MIN, DATE.annee_min);
  assert.equal(ANNEE_MAX, DATE.annee_max);
  // Identité d'objet avec le portage kbis : deux copies identiques
  // aujourd'hui divergent demain, le même objet jamais.
  const kbis = require("../lib/kbis-mapping");
  assert.equal(MOTIF_NOMBRE, kbis.MOTIF_NOMBRE);
  const source = fs.readFileSync(path.join(RACINE, "contrats", "lib", "urssaf-mapping.js"), "utf8");
  assert.ok(!/function normalizeDate|function normalizeNumber|function checkName/.test(source),
    "urssaf-mapping.js ne doit PAS redéfinir un normaliseur partagé");
  // `_ports` énumère les COPIES de la règle : ce module n'en est pas une.
  for (const f of [NOMBRE, DATE]) {
    assert.equal(f._ports.length, 4);
    assert.ok(!f._ports.some(p => p.includes("urssaf")));
  }
});

test("schéma : chaque clé mappée existe, et rien du schéma n'est extrait puis jeté", () => {
  const noms = new Set(SCHEMA.fields.map(f => f.name));
  const attendus = new Set([...Object.keys(MAPPED_FIELDS), "company_name", "issued_date", "declared_payroll"]);
  for (const n of attendus) assert.ok(noms.has(n), "champ absent du schéma : " + n);
  for (const n of noms) assert.ok(attendus.has(n), "champ du schéma jamais mappé : " + n);
  assert.equal(SCHEMA.document_type, "urssaf");
});

test("clés de sortie : sur-ensemble strict de docanalyze.js, sans écrasement", () => {
  const { analysis } = mapUrssafResult(deballe("urssaf_extraction_sample.json"), { expectedName: "SUND INDUSTRY SYSTEM" });
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  assert.ok(Object.keys(analysis).length > DOCANALYZE_BASE_KEYS.length);
  // Aucune clé enrichie n'écrase une clé docanalyze.js.
  for (const k of ENRICHED_KEYS) assert.ok(!DOCANALYZE_BASE_KEYS.includes(k), k);
});

test("cas nominal : mêmes valeurs que le portage Python sur la même fixture", () => {
  const { analysis, warnings } = mapUrssafResult(deballe("urssaf_extraction_sample.json"),
    { expectedName: "Sund Industry System", items: [{ id: "urssaf" }], validation: validationDe("urssaf_extraction_sample.json") });
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.equal(analysis.isValid, true);
  assert.equal(analysis.matchedId, "urssaf");
  assert.equal(analysis.issuedDate, "2026-03-04");
  assert.equal(analysis.dateValidite, "2026-09-04"); // 04/09/2026 converti
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.nameMatches, true);
  assert.equal(analysis.siren, "941091316");
  assert.equal(analysis.siret, "94109131600013");
  assert.equal(analysis.adresseSiege, "12 rue de la Paix, 75002 Paris");
  assert.equal(analysis.codeSecurite, "A1B2C3D4E5");
  assert.equal(analysis.organismeUrssaf, "URSSAF Ile-de-France");
  assert.equal(analysis.nombreSalaries, "12");
  assert.equal(analysis.masseSalariale, "480000");
  assert.equal(analysis.masseSalarialeDevise, "EUR");
  assert.equal(analysis.summary, DOCUMENT_TYPE_LABEL + " — délivré le 2026-03-04");
  assert.deepEqual(warnings, []);
  assert.deepEqual(analysis.issues, []);
});

test("le libellé du type reste celui de docanalyze.js::detectType", () => {
  const source = fs.readFileSync(path.join(RACINE, "contrats", "lib", "docanalyze.js"), "utf8");
  assert.ok(source.includes('type = "' + DOCUMENT_TYPE_LABEL + '"'),
    "docanalyze.js n'annonce plus ce libellé pour l'URSSAF — les deux origines d'analyse divergeraient");
});

test("cas limites : chaque dégradation est nommée, aucune valeur fabriquée", () => {
  const nom = "urssaf_extraction_sample_edge_cases.json";
  const { analysis, warnings } = mapUrssafResult(deballe(nom),
    { expectedName: "SUND INDUSTRY SYSTEM", validation: validationDe(nom) });
  assert.equal(analysis.issuedDate, "2026-08-31");       // 31/08/2026 converti
  assert.equal(analysis.dateValidite, "");               // 30/02/2027 : impossible
  assert.ok(warnings.some(w => w.includes("date impossible") && w.includes("valid_until")), warnings.join(" | "));
  assert.equal(analysis.nombreSalaries, "douze");        // reporté tel quel
  assert.ok(warnings.some(w => w.includes("nombre non reconnu") && w.includes("employee_count")));
  assert.equal(analysis.masseSalariale, "480000");
  assert.equal(analysis.masseSalarialeDevise, "CHF");
  assert.ok(warnings.some(w => w.includes("CHF")));
  assert.equal(analysis.siret, "");                      // champ absent de la réponse
  assert.equal(analysis.adresseSiege, "");               // champ à null
  assert.equal(analysis.codeSecurite, "   ");            // chaîne : rendue telle quelle
  // validation.valid=false : extraction DOUTEUSE, pas illisible.
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.ok(analysis.issues.includes("DocIE n'a pas validé l'extraction (vérification manuelle recommandée)."));
  assert.ok(warnings.some(w => w.startsWith("DocIE extraction_notes:")));
  assert.ok(warnings.some(w => w.startsWith("DocIE validation.errors:")));
  assert.ok(warnings.some(w => w.startsWith("DocIE validation.warnings:")));
});

test("illisible : bascule intégralement sur la forme docanalyze.js, sans jeter un champ isolé", () => {
  const nom = "urssaf_extraction_sample_unreadable.json";
  const { analysis } = mapUrssafResult(deballe(nom), { validation: validationDe(nom) });
  assert.equal(analysis.documentType, "Document");
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.issuedDate, "");
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.nameMatches, null);
  assert.equal(analysis.summary, "Document illisible.");
  assert.ok(analysis.issues.includes(
    "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."));
  assert.equal(analysis.organismeUrssaf, "URSSAF");
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
});

test("nameMatches / matchedId : port exact de checkName et detectType", () => {
  const r = deballe("urssaf_extraction_sample.json");
  assert.equal(mapUrssafResult(r, { expectedName: "Autre Societe SARL" }).analysis.nameMatches, false);
  assert.equal(mapUrssafResult(r, {}).analysis.nameMatches, null);
  assert.equal(mapUrssafResult(r, { items: [{ id: "kbis" }] }).analysis.matchedId, null);
  assert.equal(mapUrssafResult(r, { items: [] }).analysis.matchedId, null);
  assert.ok(mapUrssafResult(r, { expectedName: "Autre Societe SARL" }).analysis.issues
    .includes("La société du document ne correspond pas au sous-traitant saisi."));
});

test("garde-fou : un résultat non-objet lève une erreur explicite", () => {
  for (const mauvais of [null, undefined, [], "x", 3]) {
    assert.throws(() => mapUrssafResult(mauvais), /Résultat DocIE 'urssaf' invalide/);
  }
});

test("sans date de délivrance : champ vide, problème nommé, validité 6 mois non calculable", () => {
  const r = deballe("urssaf_extraction_sample.json");
  r.issued_date = null;
  const { analysis } = mapUrssafResult(r, {});
  assert.equal(analysis.issuedDate, "");
  assert.ok(analysis.issues.includes("Date de délivrance non trouvée dans le document."));
  assert.equal(analysis.summary, DOCUMENT_TYPE_LABEL);
});
