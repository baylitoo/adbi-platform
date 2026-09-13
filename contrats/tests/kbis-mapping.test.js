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
const path = require("path");
const fs = require("fs");
const {
  DOCANALYZE_BASE_KEYS, ENRICHED_KEYS, MAPPED_FIELDS, mapKbisResult,
  MOTIF_NOMBRE, normalizeNumber, ANNEE_MIN, ANNEE_MAX, normalizeDate,
} = require("../lib/kbis-mapping");
// checkName vient de docanalyze.js : c'est LA fonction que kbis-mapping.js
// importe pour produire nameMatches, et celle dont kbis_to_contrats.py est le
// portage Python (#179 ligne B7).
const { checkName } = require("../lib/docanalyze");
// Jeu d'essai PARTAGÉ avec les trois autres portages du même normaliseur
// (kbis_to_contrats.py, contract_to_contrats.py, lib/docie-contract-import.js) :
// c'est lui qui empêche la divergence de #179 (lignes B2/B3) de revenir.
const NOMBRE = require(path.join(
  __dirname, "..", "..", "document-parsing", "fixtures", "nombre_docie.json"
));
// Même discipline pour les dates : jeu d'essai PARTAGÉ par les quatre mêmes
// portages, qui empêche le retour des lignes A8/A9 de #179 — le rare cas où
// Python et JS étaient d'accord ET tous les deux faux (« 01/13/2026 » rendu
// en « 2026-13-01 », que <input type="date"> affiche vide).
const DATE = require(path.join(
  __dirname, "..", "..", "document-parsing", "fixtures", "date_docie.json"
));

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
  // Une extraction douteuse n'est pas une extraction illisible : ce signal ne
  // doit pas jeter des champs réellement extraits. kbis_to_contrats.py
  // confondait les deux et s'est aligné ici (#179 ligne B1).
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

// ---------------------------------------------------------------------------
// Inventaire de divergence #179, lignes B2/B3 : ce module s'en remettait à
// Number(), kbis_to_contrats.py à float(), et les deux n'acceptent pas les
// mêmes textes. La règle est désormais écrite une seule fois, dans la fixture
// partagée, et les quatre portages comparent leur motif ET leur sortie à ce
// fichier : ajouter une forme d'un seul côté casse le test des autres.
// ---------------------------------------------------------------------------
test("nombre : le motif de ce portage est celui de la fixture partagée (#179 B2/B3)", () => {
  assert.equal(new RegExp(MOTIF_NOMBRE).source, NOMBRE.motif);
  assert.ok(NOMBRE._ports.includes("contrats/lib/kbis-mapping.js (JS)"));
});

test("nombre : les " + NOMBRE.cas.length + " cas du jeu d'essai partagé (#179 B2/B3)", () => {
  for (const cas of NOMBRE.cas) {
    const warnings = [];
    const sortie = normalizeNumber(cas.valeur, "champ", warnings);
    assert.equal(sortie, cas.sortie, cas.valeur + " -> " + JSON.stringify(sortie) + " (" + cas.preuve + ")");
    assert.equal(warnings.length > 0, cas.avertit, "avertissement attendu=" + cas.avertit + " pour " + JSON.stringify(cas.valeur));
  }
});

// ---------------------------------------------------------------------------
// #179 lignes A8/A9, même normaliseur de date que la paire `contract`. Mesuré
// avant correction sur ce module ET sur kbis_to_contrats.py : « 01/13/2026 »
// -> « 2026-13-01 » et « 45/02/2026 » -> « 2026-02-45 », des deux côtés, sans
// un seul avertissement. contrats/public/app.js::analyzeChecklistDoc ne lit
// que issuedDate, companyName et nameMatches : une date de délivrance
// impossible était donc l'une des trois seules valeurs utilisées en aval.
// ---------------------------------------------------------------------------
test("date : les bornes de ce portage sont celles de la fixture partagée (#179 A8/A9)", () => {
  assert.equal(ANNEE_MIN, DATE.annee_min);
  assert.equal(ANNEE_MAX, DATE.annee_max);
  assert.ok(DATE._ports.includes("contrats/lib/kbis-mapping.js (JS)"));
});

test("date : les " + DATE.cas.length + " cas du jeu d'essai partagé (#179 A8/A9)", () => {
  for (const cas of DATE.cas) {
    const warnings = [];
    const sortie = normalizeDate(cas.valeur, "champ", warnings);
    assert.equal(sortie, cas.sortie, cas.valeur + " -> " + JSON.stringify(sortie) + " (" + cas.preuve + ")");
    assert.equal(warnings.length > 0, cas.avertit, "avertissement attendu=" + cas.avertit + " pour " + JSON.stringify(cas.valeur));
  }
});

test("date de délivrance impossible : champ vide + avertissement nommé, jamais une date réparée (#179 A8/A9)", () => {
  const { analysis, warnings } = mapKbisResult(
    Object.assign({}, NOMINAL, { issued_date: "01/13/2026" }),
    { validation: NOMINAL_VALIDATION }
  );
  assert.equal(analysis.issuedDate, "");
  // Surtout pas un 2026-01-13 (jour et mois échangés) ni un 2026-12-01.
  assert.ok(warnings.some((w) => /issued_date/.test(w) && /date impossible/.test(w) && /01\/13\/2026/.test(w)));
  // Le document reste lisible : seule la date manque, et l'écran le dit déjà.
  assert.equal(analysis.isValid, true);
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.ok(analysis.issues.includes("Date de délivrance non trouvée dans le document."));
});

test("date : une date impossible s'avertit AUTREMENT qu'une date illisible", () => {
  // Deux pannes qui ne se corrigent pas de la même façon : « DocIE a lu une
  // date fausse » n'est pas « DocIE n'a rien su lire ». La valeur brute
  // survit dans le message, puisque le champ, lui, reste vide.
  const impossible = [];
  assert.equal(normalizeDate("2026-02-30", "registration_date", impossible), "");
  assert.match(impossible[0], /registration_date/);
  assert.match(impossible[0], /date impossible/);

  const illisible = [];
  assert.equal(normalizeDate("le 12 mars 2019", "registration_date", illisible), "");
  assert.match(illisible[0], /date non reconnue/);
  assert.ok(!/date impossible/.test(illisible[0]));
});

test("capital social réduit à des espaces : vide, jamais un 0 fabriqué (#179 B2)", () => {
  const { analysis, warnings } = mapKbisResult(
    Object.assign({}, NOMINAL, { share_capital: { amount: "   ", currency: "EUR" } }),
    { validation: NOMINAL_VALIDATION }
  );
  assert.equal(analysis.capitalSocial, "");
  assert.equal(analysis.capitalSocialDevise, "EUR");
  assert.ok(!warnings.some((w) => /nombre non reconnu/.test(w)));
});

// ---------------------------------------------------------------------------
// #179 ligne B7 : la correspondance de nom a DEUX implémentations — celle-ci
// (docanalyze.js::checkName, importée telle quelle par lib/kbis-mapping.js,
// c'est-à-dire celle qui tourne en production) et son portage Python dans
// document-parsing/mappings/kbis_to_contrats.py::_check_name. #179 les avait
// mesurées d'accord sur les fixtures du dépôt, mais RIEN ne les comparait
// l'une à l'autre : la première dérive serait passée inaperçue jusqu'à
// l'écran. L'enjeu est concret — `nameMatches === false` fait afficher à
// public/app.js::analyzeChecklistDoc un « ⛔ ce n'est PAS le sous-traitant
// saisi » BLOQUANT, donc une divergence accuse à tort un sous-traitant
// légitime. Même discipline que nombre_docie.json et date_docie.json : la
// règle est écrite une seule fois, les deux portages s'y comparent.
// ---------------------------------------------------------------------------
const NOM = require(path.join(
  __dirname, "..", "..", "document-parsing", "fixtures", "nom_docie.json"
));
// checkName garde ses trois constantes en littéraux à l'intérieur de la
// fonction. Elles sont relues DANS LA SOURCE plutôt qu'exportées : c'est déjà
// la façon dont test_kbis_to_contrats.py lit docanalyze.js (qui est une
// fonction, pas une table statique), et cela évite de remanier un fichier de
// production pour le seul confort d'un test.
const DOCANALYZE_SRC = fs.readFileSync(path.join(__dirname, "..", "lib", "docanalyze.js"), "utf8");

test("nom : les constantes de ce portage sont celles de la fixture partagée (#179 B7)", () => {
  const formes = DOCANALYZE_SRC.match(/!\/\^\(([A-Z|]+)\)\$\/\.test\(t\)/);
  assert.ok(formes, "checkName ne filtre plus les formes juridiques par ce littéral — docanalyze.js a changé de forme");
  assert.deepEqual(formes[1].split("|"), NOM.formes_juridiques);

  const longueur = DOCANALYZE_SRC.match(/t\.length >= (\d+)/);
  assert.ok(longueur, "checkName ne filtre plus les tokens par leur longueur");
  assert.equal(Number(longueur[1]), NOM.longueur_token_min);

  const seuil = DOCANALYZE_SRC.match(/Math\.ceil\(tokens\.length \* ([\d.]+)\)/);
  assert.ok(seuil, "checkName ne calcule plus son seuil par ce littéral");
  assert.equal(Number(seuil[1]), NOM.seuil);

  assert.ok(NOM._ports.includes("contrats/lib/docanalyze.js (JS)"));
});

test("nom : les " + NOM.cas.length + " cas du jeu d'essai partagé (#179 B7)", () => {
  for (const cas of NOM.cas) {
    const verdict = checkName(cas.candidat, cas.nom_attendu);
    assert.equal(
      verdict, cas.resultat,
      JSON.stringify(cas.nom_attendu) + " vs " + JSON.stringify(cas.candidat) +
      " -> " + verdict + ", attendu " + cas.resultat + " (" + cas.preuve + ")"
    );
  }
});

test("nom : chaque cas du jeu d'essai traverse aussi mapKbisResult jusqu'à nameMatches (#179 B7)", () => {
  // La fonction seule ne prouve pas ce que l'écran reçoit : mapKbisResult
  // peut neutraliser le verdict (branche « illisible »). On garde donc un
  // siren pour rester hors de cette branche, et on vérifie que nameMatches
  // est bien le verdict de checkName — et que le message bloquant n'est
  // ajouté aux `issues` que sur false, jamais sur null.
  for (const cas of NOM.cas) {
    const { analysis } = mapKbisResult(
      { company_name: cas.candidat, siren: "941091316" },
      { expectedName: cas.nom_attendu, items: [{ id: "kbis" }], validation: NOMINAL_VALIDATION }
    );
    assert.equal(analysis.nameMatches, cas.resultat, JSON.stringify(cas.nom_attendu) + " / " + JSON.stringify(cas.candidat));
    assert.equal(
      analysis.issues.includes("La société du document ne correspond pas au sous-traitant saisi."),
      cas.resultat === false,
      "message bloquant attendu uniquement sur false — " + JSON.stringify(cas.nom_attendu)
    );
  }
});
