"use strict";
// Tests de lib/kbis-mapping.js — pendant JS de
// document-parsing/mappings/test_kbis_to_contrats.py. Les objets `result`
// utilisés ici sont l'équivalent DÉJÀ DÉBALLÉ (docie-bridge.js::unwrap())
// des fixtures Python document-parsing/mappings/fixtures/
// kbis_extraction_sample*.json (mêmes valeurs, sans l'enveloppe
// {value, confidence, evidence_ids} / avec {amount, currency} inchangé pour
// money) — voir contrats/tests/docie-extraction.test.js pour un test qui
// exerce le VRAI unwrap() de bout en bout plutôt que ces valeurs pré-déballées.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DOCANALYZE_BASE_KEYS, ENRICHED_KEYS, MAPPED_FIELDS, mapKbisResult } = require("../lib/kbis-mapping");

const NOMINAL = {
  company_name: "SUND INDUSTRY SYSTEM",
  siren: "941091316",
  siret_siege: "94109131600013",
  legal_form: "SAS",
  share_capital: { amount: "1000", currency: "EUR" },
  registration_date: "2019-03-12",
  issued_date: "04/09/2026",
  rcs_number: "941 091 316 RCS Paris",
  registered_address: "60 rue Francois 1er, 75008 Paris",
  activity_code: "6202A",
  legal_representative: "Monsieur Corentin CALVO",
  extraction_notes: ["low confidence on activity_code"],
};
const NOMINAL_VALIDATION = { valid: true, errors: [], warnings: [] };

const EDGE = {
  company_name: null,
  siren: "123456789",
  siret_siege: null,
  legal_form: null,
  share_capital: { amount: "5000.00", currency: "USD" },
  registration_date: "le 12 mars 2019",
  issued_date: "2026-09-01",
  rcs_number: "",
  registered_address: null,
  activity_code: null,
  legal_representative: "Madame Jane DOE, Presidente",
  extraction_notes: ["company_name illisible sur ce scan", "registration_date en toutes lettres, non normalisee"],
};

const UNREADABLE = {
  company_name: null, siren: null, siret_siege: null, legal_form: null, share_capital: null,
  registration_date: null, issued_date: null, rcs_number: null, registered_address: null,
  activity_code: null, legal_representative: null,
  extraction_notes: ["scan illisible, aucun champ identifiant extrait"],
};

test("MAPPED_FIELDS: 8 champs simples (company_name/issued_date/share_capital traités à part)", () => {
  assert.equal(Object.keys(MAPPED_FIELDS).length, 8);
});

test("ENRICHED_KEYS et DOCANALYZE_BASE_KEYS sont disjoints", () => {
  const overlap = ENRICHED_KEYS.filter((k) => DOCANALYZE_BASE_KEYS.includes(k));
  assert.deepEqual(overlap, []);
});

test("nominal: sur-ensemble strict des clés locales", () => {
  const { analysis } = mapKbisResult(NOMINAL, { expectedName: "SUND INDUSTRY SYSTEM", validation: NOMINAL_VALIDATION });
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  assert.ok(Object.keys(analysis).length > DOCANALYZE_BASE_KEYS.length);
});

test("nominal: documentType/isValid", () => {
  const { analysis } = mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.documentType, "Extrait Kbis");
  assert.equal(analysis.isValid, true);
});

test("nominal: companyName + nameMatches=true, pas d'issue de non-correspondance", () => {
  const { analysis } = mapKbisResult(NOMINAL, { expectedName: "SUND INDUSTRY SYSTEM", validation: NOMINAL_VALIDATION });
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.nameMatches, true);
  assert.ok(!analysis.issues.includes("La société du document ne correspond pas au sous-traitant saisi."));
});

test("nominal: nameMatches=false pour un nom attendu sans rapport", () => {
  const { analysis } = mapKbisResult(NOMINAL, { expectedName: "ACME AUTRE SOCIETE", validation: NOMINAL_VALIDATION });
  assert.equal(analysis.nameMatches, false);
  assert.ok(analysis.issues.includes("La société du document ne correspond pas au sous-traitant saisi."));
});

test("nominal: nameMatches=null sans nom attendu", () => {
  const { analysis } = mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.nameMatches, null);
});

test("nominal: forme juridique seule ('SAS') ne suffit pas à matcher — tokens de forme juridique exclus", () => {
  const { analysis } = mapKbisResult(NOMINAL, { expectedName: "SAS", validation: NOMINAL_VALIDATION });
  assert.equal(analysis.nameMatches, null);
});

test("nominal: issued_date FR normalisée en ISO, reflétée dans le résumé", () => {
  const { analysis } = mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.issuedDate, "2026-09-04");
  assert.match(analysis.summary, /délivré le 2026-09-04/);
});

test("nominal: champs enrichis restitués tels quels", () => {
  const { analysis } = mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.siren, "941091316");
  assert.equal(analysis.siret, "94109131600013");
  assert.equal(analysis.formeJuridique, "SAS");
  assert.equal(analysis.dateImmatriculation, "2019-03-12");
  assert.equal(analysis.rcsNumber, "941 091 316 RCS Paris");
  assert.equal(analysis.adresseSiege, "60 rue Francois 1er, 75008 Paris");
  assert.equal(analysis.codeActivite, "6202A");
  assert.equal(analysis.representantLegal, "Monsieur Corentin CALVO");
});

test("nominal: money EUR conservé en montant + devise séparés", () => {
  const { analysis } = mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.capitalSocial, "1000");
  assert.equal(analysis.capitalSocialDevise, "EUR");
});

test("nominal: extraction_notes remonte en warning, pas en issue utilisateur", () => {
  const { analysis, warnings } = mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION });
  assert.ok(warnings.some((w) => w.includes("activity_code")));
  assert.ok(!analysis.issues.some((i) => i.includes("activity_code")));
});

test("nominal: matchedId depuis items[0], seulement si son id vaut 'kbis'", () => {
  assert.equal(mapKbisResult(NOMINAL, { items: [{ id: "kbis", label: "Kbis" }], validation: NOMINAL_VALIDATION }).analysis.matchedId, "kbis");
  assert.equal(mapKbisResult(NOMINAL, { items: [{ id: "urssaf" }], validation: NOMINAL_VALIDATION }).analysis.matchedId, null);
  assert.equal(mapKbisResult(NOMINAL, { validation: NOMINAL_VALIDATION }).analysis.matchedId, null);
});

test("edge cases: siren seul lu (company_name absent) -> reste valide (pas les 3 signaux absents)", () => {
  const { analysis } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.isValid, true);
  assert.equal(analysis.documentType, "Extrait Kbis");
});

test("edge cases: company_name absent -> companyName/nameMatches null sans nom attendu", () => {
  const { analysis } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.nameMatches, null);
});

test("edge cases: company_name absent + nom attendu fourni -> nameMatches=false, companyName reste null", () => {
  const { analysis } = mapKbisResult(EDGE, { expectedName: "ACME FREELANCE", validation: NOMINAL_VALIDATION });
  assert.equal(analysis.nameMatches, false);
  assert.equal(analysis.companyName, null);
});

test("edge cases: champs wrapper absents/null -> chaîne vide, jamais 'null'", () => {
  const { analysis } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.formeJuridique, "");
  assert.equal(analysis.adresseSiege, "");
  assert.equal(analysis.codeActivite, "");
  assert.equal(analysis.siret, "");
});

test("edge cases: date non reconnue -> vide + avertissement (jamais injectée telle quelle)", () => {
  const { analysis, warnings } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.dateImmatriculation, "");
  assert.ok(warnings.some((w) => w.includes("registration_date") && w.includes("le 12 mars 2019")));
});

test("edge cases: issued_date déjà ISO passe telle quelle", () => {
  const { analysis } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.issuedDate, "2026-09-01");
});

test("edge cases: devise non-EUR signalée, jamais convertie", () => {
  const { analysis, warnings } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.capitalSocial, "5000");
  assert.equal(analysis.capitalSocialDevise, "USD");
  assert.ok(warnings.some((w) => w.includes("USD") && w.includes("share_capital")));
});

test("edge cases: extraction_notes multiples surfacent en warnings", () => {
  const { warnings } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.ok(warnings.some((w) => w.includes("illisible sur ce scan")));
});

test("edge cases: qualité imbriquée dans representantLegal reste non structurée (gap documenté)", () => {
  const { analysis } = mapKbisResult(EDGE, { validation: NOMINAL_VALIDATION });
  assert.equal(analysis.representantLegal, "Madame Jane DOE, Presidente");
});

test("validation.valid=false avec des champs identifiants lisibles: isValid=false, mais champs et documentType conservés (pas de branche illisible)", () => {
  // Divergence assumée avec kbis_to_contrats.py (voir kbis-mapping.js) :
  // docanalyze.js n'a pas de notion de validation DocIE à imiter, donc ce
  // signal ne doit pas jeter des champs réellement extraits.
  const { analysis } = mapKbisResult(NOMINAL, { validation: { valid: false, errors: ["x"], warnings: [] } });
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, "Extrait Kbis");
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.siren, "941091316");
  assert.ok(analysis.issues.includes("DocIE n'a pas validé l'extraction (vérification manuelle recommandée)."));
});

test("validation.valid=false ET aucun champ identifiant: bascule bien sur la branche illisible", () => {
  const { analysis } = mapKbisResult(UNREADABLE, { validation: { valid: false, errors: ["x"], warnings: [] } });
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, "Document");
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.summary, "Document illisible.");
});

test("unreadable: bascule intégralement sur la forme illisible", () => {
  const { analysis } = mapKbisResult(UNREADABLE, { expectedName: "PEU IMPORTE", validation: NOMINAL_VALIDATION });
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, "Document");
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.nameMatches, null);
  assert.equal(analysis.issuedDate, "");
  assert.equal(analysis.summary, "Document illisible.");
  assert.deepEqual(analysis.issues, [
    "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.",
  ]);
});

test("unreadable: reste un sur-ensemble des clés locales même illisible", () => {
  const { analysis } = mapKbisResult(UNREADABLE, { validation: NOMINAL_VALIDATION });
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
});

test("garde-fou: résultat non-objet lève une erreur explicite", () => {
  assert.throws(() => mapKbisResult(null), /objet attendu/);
  assert.throws(() => mapKbisResult("nope"), /objet attendu/);
});
