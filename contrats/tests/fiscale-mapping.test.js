"use strict";
// Tests du schéma dynamique "fiscale" (attestation de régularité fiscale,
// #170 / #194) et de lib/fiscale-mapping.js — pendant JS de
// document-parsing/mappings/test_fiscale_to_contrats.py.
//
// Comme urssaf-mapping.test.js, ce fichier lit LES MÊMES fixtures que Python et
// les fait passer par le VRAI déballage du pont (docie-bridge.js::
// parseTextResponse -> unwrap), puis exécute le portage Python sur les mêmes
// entrées et compare les deux sorties (exécution croisée).
//
// Conformité à DynamicSchemaSpec vérifiée HORS LIGNE, comme #209 pour
// rib.schema.json : motif des noms ^[a-z][a-z0-9_]{0,63}$ (HTTP 422 sinon,
// mesuré dans register_and_test.py), types autorisés, sous-champs obligatoires
// pour object/list et interdits pour un scalaire, noms réservés.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const {
  DOCANALYZE_BASE_KEYS, ENRICHED_KEYS, MAPPED_FIELDS, DOCUMENT_TYPE_LABEL, LIBELLES_DATES, ORDRE_DATES,
  mapFiscaleResult,
} = require("../lib/fiscale-mapping");
const { mapUrssafResult } = require("../lib/urssaf-mapping");

const RACINE = path.join(__dirname, "..", "..");
const { parseTextResponse } = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));
const FIXTURES = path.join(RACINE, "document-parsing", "mappings", "fixtures");
const PARTAGEES = path.join(RACINE, "document-parsing", "fixtures");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "fiscale.schema.json"));
const DATES = require(path.join(PARTAGEES, "date_plausible.json"));
const SIREN_SIRET = require(path.join(PARTAGEES, "siren_siret.json"));
const NOM = require(path.join(PARTAGEES, "nom_docie.json"));
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "lib", "fiscale-mapping.js"), "utf8");

// Date du jour FIGÉE des tests : celle du jeu d'essai partagé.
const AUJOURDHUI = DATES.aujourdhui;
const FIXTURES_FISCALE = [
  "fiscale_extraction_sample.json",
  "fiscale_extraction_sample_edge_cases.json",
  "fiscale_extraction_sample_unreadable.json",
];
const ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.";
const DATE_ABSENTE = "Date de délivrance non trouvée dans le document.";

const TYPES = new Set(["string", "date", "number", "money", "object", "list"]);
const NOM_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVES = new Set(["document_type", "extraction_notes"]);

// Les SEPT champs retenus et leur type. Figés ici plutôt que déduits du
// fichier : un champ ajouté au schéma sans justification casse ce test.
const CHAMPS_JUSTIFIES = {
  company_name: "string",
  siren: "string",
  siret: "string",
  tax_office: "string",
  issued_date: "date",
  situation_date: "date",
  regularity_statement: "string",
};

function enveloppe(nom) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, nom), "utf8"));
}
// Le `result` tel que le consommateur JS le reçoit réellement : déballé par le
// pont, pas reconstruit à la main.
function mapperFixture(nom, options = {}) {
  const { result, metadata } = parseTextResponse(enveloppe(nom), "fiscale");
  return mapFiscaleResult(result, { aujourdhui: AUJOURDHUI, validation: metadata.validation, ...options });
}
// Enveloppe DocIE brute (forme Python). Mesuré sur urssaf : le pont ne déballe
// un champ que s'il porte un marqueur DocIE (evidence_ids / confidence).
function champ(value) {
  return { value, evidence_ids: [], confidence: 0.9 };
}
function enveloppeValeurs(valeurs) {
  return {
    schema_name: "fiscale",
    result: Object.fromEntries(Object.entries(valeurs).map(([k, v]) => [k, champ(v)])),
    validation: { valid: true, errors: [], warnings: [] },
  };
}
function mapperValeurs(valeurs, options = {}, mapper = mapFiscaleResult, schema = "fiscale") {
  const env = enveloppeValeurs(valeurs);
  env.schema_name = schema;
  const { result, metadata } = parseTextResponse(env, schema);
  return mapper(result, { aujourdhui: AUJOURDHUI, validation: metadata.validation, ...options });
}

// ---------------------------------------------------------------------------
// Schéma
// ---------------------------------------------------------------------------
test("schéma fiscale : racine et document_type conformes à DynamicSchemaSpec", () => {
  assert.deepEqual(Object.keys(SCHEMA), ["document_type", "fields"]);
  assert.equal(SCHEMA.document_type, "fiscale");
  assert.match(SCHEMA.document_type, NOM_RE);
  assert.ok(SCHEMA.document_type.length <= 64);
  assert.ok(!RESERVES.has(SCHEMA.document_type));
});

test("schéma fiscale : noms, types, sous-champs, noms réservés", () => {
  function verifier(champs, chemin) {
    assert.ok(Array.isArray(champs), chemin);
    const noms = new Set();
    for (const c of champs) {
      const libelle = chemin + c.name;
      assert.deepEqual(Object.keys(c), ["name", "type", "description", "fields"], libelle);
      assert.match(c.name, NOM_RE, libelle);
      assert.ok(!RESERVES.has(c.name), "nom réservé par DocIE : " + libelle);
      assert.ok(!noms.has(c.name), "nom de champ dupliqué : " + libelle);
      noms.add(c.name);
      assert.ok(TYPES.has(c.type), libelle);
      if (c.type === "object" || c.type === "list") {
        assert.ok(c.fields.length > 0, "un object/list DOIT déclarer des sous-champs : " + libelle);
        verifier(c.fields, libelle + ".");
      } else {
        assert.deepEqual(c.fields, [], "un scalaire ne déclare PAS de sous-champs : " + libelle);
      }
    }
  }
  verifier(SCHEMA.fields, "");
});

test("schéma fiscale : aucun champ inventé, aucun montant, chaque champ mappé et réciproquement", () => {
  assert.deepEqual(Object.fromEntries(SCHEMA.fields.map((f) => [f.name, f.type])), CHAMPS_JUSTIFIES);
  // L'attestation n'imprime pas de montant : la ligne « money » de #170 ne
  // vaut pas pour cette pièce.
  assert.ok(!SCHEMA.fields.some((f) => f.type === "money"));
  assert.deepEqual(new Set(SCHEMA.fields.map((f) => f.name)), new Set([...Object.keys(MAPPED_FIELDS), "company_name", "issued_date"]));
  assert.deepEqual(new Set(SCHEMA.fields.filter((f) => f.type === "date").map((f) => f.name)), new Set(Object.keys(LIBELLES_DATES)));
  for (const nom of FIXTURES_FISCALE) assert.deepEqual(enveloppe(nom).dynamic_schema, SCHEMA, nom);
});

// ---------------------------------------------------------------------------
// Importé, pas recopié (garde-fou de la paire URSSAF, #208, étendu)
// ---------------------------------------------------------------------------
// Remplace des exports d'un module importé, recharge le mapping, et rend le
// mapper ainsi obtenu. Une copie RENOMMÉE, require laissé en place, passe la
// lecture du source ; elle ne rendrait pas le témoin.
function avecTemoin(cheminModule, remplacements, corps) {
  const cheminMapping = require.resolve("../lib/fiscale-mapping");
  const module = require(cheminModule);
  const originaux = Object.fromEntries(Object.keys(remplacements).map((k) => [k, module[k]]));
  delete require.cache[cheminMapping];
  try {
    Object.assign(module, remplacements);
    corps(require(cheminMapping).mapFiscaleResult);
  } finally {
    Object.assign(module, originaux);
    delete require.cache[cheminMapping];
  }
}

test("importé, pas recopié : lecture du source", () => {
  for (const module of ["./docanalyze", "./kbis-mapping", "./siren-siret", "./date-plausible"]) {
    assert.ok(SOURCE.includes('require("' + module + '")'), "fiscale-mapping.js doit requérir " + module);
  }
  assert.ok(!/function\s+(checkName|norm|normalizeDate|dateExiste|formeEcrite|controlerSirenSiret|messagesSirenSiret|luhnValide|controlerUn|controlerDates|messagesDates|dateDuJour|majusculeInitiale)\b|(const|let|var)\s+(checkName|norm|normalizeDate|controlerSirenSiret|messagesSirenSiret|luhnValide|controlerDates|messagesDates|LIGATURES|MOTIF_SEPARATEURS|SEPARATEURS_RE|ANNEE_MIN|ANNEE_MAX|JOURS_PAR_MOIS)\s*=/.test(SOURCE),
    "fiscale-mapping.js ne doit PAS redéfinir un contrôle ni un normaliseur partagé");
  const code = SOURCE.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/%\s*10\b/.test(code), "Luhn recopié");
  assert.ok(!/\b(1950|2100)\b/.test(code), "seconde fenêtre d'années écrite en dur");
  assert.ok(!/normalize\("NFD"\)/.test(code), "comparaison de nom recopiée");
  // Déclaré exécutant des jeux d'essai qu'il traverse, jamais copie des règles
  // qu'il importe.
  assert.ok(SIREN_SIRET._ports.includes("contrats/lib/fiscale-mapping.js (JS)"));
  assert.ok(DATES._ports.includes("contrats/lib/fiscale-mapping.js (JS)"));
  assert.ok(!NOM._ports.some((p) => p.includes("fiscale")));
  for (const f of ["date_docie.json", "nombre_docie.json"]) {
    const ports = require(path.join(PARTAGEES, f))._ports;
    assert.equal(ports.length, 4, f);
    assert.ok(!ports.some((p) => p.includes("fiscale")), f);
  }
});

test("importé, pas recopié : témoin du validateur SIREN/SIRET", () => {
  const temoin = { siren: { valeur: "t", chiffres: null, statut: "temoin" }, siret: { valeur: "", chiffres: null, statut: "absent" } };
  const appels = [];
  avecTemoin(require.resolve("../lib/siren-siret"), {
    controlerSirenSiret: (...args) => { appels.push(args); return temoin; },
    messagesSirenSiret: (c) => (c === temoin ? [{ champ: "siren", message: "MESSAGE TÉMOIN" }] : []),
  }, (mapper) => {
    const { result } = parseTextResponse(enveloppe("fiscale_extraction_sample.json"), "fiscale");
    const { analysis, warnings } = mapper(result, { aujourdhui: AUJOURDHUI });
    assert.deepEqual(appels, [["941091316", "94109131600013"]]);
    assert.equal(analysis.controleSirenSiret, temoin);
    assert.ok(analysis.issues.includes("MESSAGE TÉMOIN"));
    assert.ok(warnings.includes("siren: MESSAGE TÉMOIN"));
  });
});

test("importé, pas recopié : témoin du contrôle de dates", () => {
  const temoin = { issued_date: { valeur: "t", date: "", statut: "temoin" }, situation_date: { valeur: "", date: "", statut: "absent" } };
  const appels = [];
  avecTemoin(require.resolve("../lib/date-plausible"), {
    controlerDates: (...args) => { appels.push(args); return temoin; },
    messagesDates: (c) => (c === temoin ? [{ champ: "issued_date", message: "DATE TÉMOIN" }] : []),
  }, (mapper) => {
    const { result } = parseTextResponse(enveloppe("fiscale_extraction_sample.json"), "fiscale");
    const { analysis, warnings } = mapper(result, { aujourdhui: AUJOURDHUI });
    assert.deepEqual(appels, [[{ issued_date: "2026-03-04", situation_date: "28/02/2026" }, { ordre: ORDRE_DATES, aujourdhui: AUJOURDHUI }]]);
    assert.equal(analysis.controleDates, temoin);
    assert.ok(analysis.issues.includes("DATE TÉMOIN"));
    assert.ok(warnings.includes("issued_date: DATE TÉMOIN"));
  });
});

test("importé, pas recopié : témoins de checkName (nom_docie) et de normalizeDate", () => {
  const appelsNom = [];
  avecTemoin(require.resolve("../lib/docanalyze"), {
    checkName: (...args) => { appelsNom.push(args); return "TÉMOIN"; },
  }, (mapper) => {
    const { result } = parseTextResponse(enveloppe("fiscale_extraction_sample.json"), "fiscale");
    assert.equal(mapper(result, { expectedName: "X", aujourdhui: AUJOURDHUI }).analysis.nameMatches, "TÉMOIN");
    assert.deepEqual(appelsNom, [["SUND INDUSTRY SYSTEM", "X"]]);
  });
  avecTemoin(require.resolve("../lib/kbis-mapping"), {
    normalizeDate: () => "1999-09-09",
  }, (mapper) => {
    const { result } = parseTextResponse(enveloppe("fiscale_extraction_sample.json"), "fiscale");
    const { analysis } = mapper(result, { aujourdhui: AUJOURDHUI });
    assert.equal(analysis.issuedDate, "1999-09-09");
    assert.equal(analysis.dateSituation, "1999-09-09");
  });
});

test("constantes de dates identiques au jeu d'essai partagé", () => {
  assert.deepEqual(LIBELLES_DATES, DATES.libelles);
  assert.deepEqual(ORDRE_DATES, DATES.ordre);
  assert.deepEqual(DATES.futur_admis, []);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
test("cas nominal : valeurs, verdicts, même forme que l'URSSAF", () => {
  const { analysis, warnings } = mapperFixture("fiscale_extraction_sample.json", { expectedName: "Sund Industry System", items: [{ id: "fiscale" }] });
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(analysis, k) && !DOCANALYZE_BASE_KEYS.includes(k), k);
  assert.ok(!ENRICHED_KEYS.includes("controleSirenSiret") && !ENRICHED_KEYS.includes("controleDates"));
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.equal(analysis.matchedId, "fiscale");
  assert.equal(analysis.isValid, true);
  assert.equal(analysis.issuedDate, "2026-03-04");
  assert.equal(analysis.dateSituation, "2026-02-28");
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.nameMatches, true);
  assert.equal(analysis.siren, "941091316");
  assert.equal(analysis.siret, "94109131600013");
  assert.equal(analysis.serviceImpots, "SIE de Paris 2e");
  assert.equal(analysis.mentionRegularite, "L'entreprise est a jour de ses obligations fiscales declaratives et de paiement");
  assert.equal(analysis.summary, DOCUMENT_TYPE_LABEL + " — délivré le 2026-03-04");
  assert.deepEqual(analysis.issues, []);
  assert.deepEqual(warnings, []);
  assert.equal(analysis.controleSirenSiret.siren.statut, "valide");
  assert.deepEqual(analysis.controleDates, {
    issued_date: { valeur: "2026-03-04", date: "2026-03-04", statut: "plausible" },
    situation_date: { valeur: "28/02/2026", date: "2026-02-28", statut: "plausible" },
  });
  // Même forme que l'URSSAF : mêmes clés de base et même verdict SIREN/SIRET.
  const { result, metadata } = parseTextResponse(JSON.parse(fs.readFileSync(path.join(FIXTURES, "urssaf_extraction_sample.json"), "utf8")), "urssaf");
  const urssaf = mapUrssafResult(result, { validation: metadata.validation }).analysis;
  const memesOptions = mapperFixture("fiscale_extraction_sample.json").analysis;
  for (const k of [...DOCANALYZE_BASE_KEYS, "controleSirenSiret"]) {
    assert.equal(typeof memesOptions[k], typeof urssaf[k], k);
    assert.equal(Array.isArray(memesOptions[k]), Array.isArray(urssaf[k]), k);
  }
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "lib", "docanalyze.js"), "utf8").includes('type = "' + DOCUMENT_TYPE_LABEL + '"'));
});

test("nameMatches / matchedId : port exact de checkName et detectType", () => {
  assert.equal(mapperFixture("fiscale_extraction_sample.json", { expectedName: "Autre Societe SARL" }).analysis.nameMatches, false);
  assert.ok(mapperFixture("fiscale_extraction_sample.json", { expectedName: "Autre Societe SARL" }).analysis.issues
    .includes("La société du document ne correspond pas au sous-traitant saisi."));
  assert.equal(mapperFixture("fiscale_extraction_sample.json").analysis.nameMatches, null);
  assert.equal(mapperFixture("fiscale_extraction_sample.json", { items: [{ id: "urssaf" }] }).analysis.matchedId, null);
  assert.equal(mapperFixture("fiscale_extraction_sample.json", { items: [] }).analysis.matchedId, null);
});

test("cas limites : situation après délivrance nommée et conservée, champs vides, validation négative", () => {
  const { analysis, warnings } = mapperFixture("fiscale_extraction_sample_edge_cases.json", { expectedName: "SUND INDUSTRY SYSTEM" });
  const incoherence = "Dates incohérentes : date de situation « 2026-09-10 », date de délivrance « 2026-08-31 »"
    + " — la première ne peut pas suivre la seconde, l'une des deux est mal lue — valeurs conservées, à vérifier sur le document";
  assert.equal(analysis.issuedDate, "2026-08-31");
  assert.equal(analysis.dateSituation, "2026-09-10");
  assert.equal(analysis.controleDates.issued_date.statut, "incoherente");
  assert.equal(analysis.controleDates.situation_date.statut, "incoherente");
  assert.deepEqual(analysis.issues, ["DocIE n'a pas validé l'extraction (vérification manuelle recommandée).", incoherence]);
  assert.ok(warnings.includes("situation_date: " + incoherence));
  assert.equal(analysis.siret, "");
  assert.equal(analysis.serviceImpots, "");
  assert.equal(analysis.mentionRegularite, "   ");
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.ok(warnings.some((w) => w.startsWith("DocIE extraction_notes:")));
  assert.ok(warnings.some((w) => w.startsWith("DocIE validation.errors:")));
});

test("illisible : forme docanalyze.js, verdicts présents, champ isolé gardé", () => {
  const { analysis } = mapperFixture("fiscale_extraction_sample_unreadable.json");
  assert.equal(analysis.documentType, "Document");
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.issuedDate, "");
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.nameMatches, null);
  assert.equal(analysis.summary, "Document illisible.");
  assert.deepEqual(analysis.issues, [ILLISIBLE]);
  assert.equal(analysis.serviceImpots, "SIE");
  assert.equal(analysis.controleSirenSiret.siren.statut, "absent");
  assert.equal(analysis.controleDates.issued_date.statut, "absent");
  // Une date lue sans identité ne rend pas le document lisible.
  const seule = mapperValeurs({ issued_date: "2099-01-01" }).analysis;
  assert.deepEqual(seule.issues, [ILLISIBLE]);
  assert.equal(seule.controleDates.issued_date.statut, "future");
});

test("garde-fou : entrée non-objet ou date du jour mal formée refusées", () => {
  for (const mauvais of [null, undefined, [], "x", 3]) {
    assert.throws(() => mapFiscaleResult(mauvais), /Résultat DocIE 'fiscale' invalide/);
  }
  const { result } = parseTextResponse(enveloppe("fiscale_extraction_sample.json"), "fiscale");
  assert.throws(() => mapFiscaleResult(result, { aujourdhui: "15/09/2026" }), /aujourdhui/);
});

// ---------------------------------------------------------------------------
// Plausibilité des dates (#194)
// ---------------------------------------------------------------------------
const BASE = { company_name: "SUND INDUSTRY SYSTEM", siren: "941091316" };

test("dates : future, avant 1950, incohérente et illisible ont chacune leur message, distinct de « non trouvée »", () => {
  const attendus = {
    future: [{ issued_date: "2026-09-16" }, "date dans le futur"],
    impossible: [{ issued_date: "12/05/1949" }, "date impossible"],
    incoherente: [{ issued_date: "2026-03-04", situation_date: "2026-03-10" }, "Dates incohérentes"],
    non_reconnue: [{ issued_date: "mars 2026" }, "date illisible"],
  };
  const textes = [...Object.values(attendus).map(([, t]) => t), DATE_ABSENTE, ILLISIBLE];
  for (const [statut, [dates, texte]] of Object.entries(attendus)) {
    const { analysis } = mapperValeurs({ ...BASE, ...dates });
    assert.equal(analysis.controleDates.issued_date.statut, statut);
    assert.equal(analysis.isValid, true, statut);
    for (const autre of textes) assert.equal(analysis.issues.some((i) => i.includes(autre)), autre === texte, statut + " / " + autre);
  }
  // Date future conservée, et verdict qui suit la date du jour injectée.
  assert.equal(mapperValeurs({ ...BASE, issued_date: "2026-12-01" }).analysis.issuedDate, "2026-12-01");
  const plus_tard = mapperValeurs({ ...BASE, issued_date: "2026-12-01" }, { aujourdhui: "2027-06-01" }).analysis;
  assert.equal(plus_tard.controleDates.issued_date.statut, "plausible");
  assert.deepEqual(plus_tard.issues, []);
});

test("dates : chaque cas du jeu d'essai partagé traverse le vrai pont puis le mapping", () => {
  for (const cas of DATES.cas) {
    const libelle = JSON.stringify(cas.valeurs) + " (" + cas.preuve + ")";
    const { analysis, warnings } = mapperValeurs({ ...BASE, ...cas.valeurs }, { aujourdhui: cas.aujourdhui || AUJOURDHUI });
    for (const c of Object.keys(cas.valeurs)) {
      assert.equal(analysis.controleDates[c].statut, cas.statuts[c], libelle + " " + c);
      assert.equal(analysis.controleDates[c].date, cas.dates[c], libelle + " " + c);
    }
    assert.equal(analysis.issuedDate, cas.dates.issued_date, libelle);
    assert.equal(analysis.dateSituation, cas.dates.situation_date, libelle);
    const attendues = cas.messages.map((m) => m.message);
    if (cas.statuts.issued_date === "absent") attendues.push(DATE_ABSENTE);
    assert.deepEqual(analysis.issues, attendues, libelle);
    assert.deepEqual(
      warnings.filter((w) => w.startsWith("issued_date: D") || w.startsWith("situation_date: D")),
      cas.messages.map((m) => m.champ + ": " + m.message),
      libelle
    );
    assert.equal(analysis.isValid, true, libelle);
  }
});

// ---------------------------------------------------------------------------
// SIREN/SIRET et nom : jeux d'essai partagés
// ---------------------------------------------------------------------------
function valeursSiren(cas) {
  return { company_name: "SUND INDUSTRY SYSTEM", siren: cas.siren, siret: cas.siret, issued_date: "2026-03-04" };
}

test("siren/siret : chaque cas traverse mapFiscaleResult avec le verdict, les issues et les messages de l'URSSAF", () => {
  const prefixes = ["siren: ", "siret: "];
  for (const cas of SIREN_SIRET.cas) {
    const libelle = JSON.stringify([cas.siren, cas.siret]) + " (" + cas.preuve + ")";
    const fiscale = mapperValeurs(valeursSiren(cas));
    const urssaf = mapperValeurs(valeursSiren(cas), {}, mapUrssafResult, "urssaf");
    assert.equal(fiscale.analysis.siren, cas.siren === null ? "" : String(cas.siren), libelle);
    assert.equal(fiscale.analysis.controleSirenSiret.siren.statut, cas.statut_siren, libelle);
    assert.equal(fiscale.analysis.controleSirenSiret.siret.statut, cas.statut_siret, libelle);
    assert.deepEqual(fiscale.analysis.issues, cas.messages.map((m) => m.message), libelle);
    assert.deepEqual(fiscale.analysis.controleSirenSiret, urssaf.analysis.controleSirenSiret, libelle);
    assert.deepEqual(fiscale.analysis.issues, urssaf.analysis.issues, libelle);
    const filtre = (w) => w.filter((x) => prefixes.some((p) => x.startsWith(p)));
    assert.deepEqual(filtre(fiscale.warnings), filtre(urssaf.warnings), libelle);
    assert.equal(fiscale.analysis.isValid, true, libelle);
  }
});

test("nom : chaque cas de nom_docie.json traverse le mapping, message bloquant seulement sur false", () => {
  const message = "La société du document ne correspond pas au sous-traitant saisi.";
  for (const cas of NOM.cas) {
    const { analysis } = mapperValeurs({ company_name: cas.candidat, siren: "941091316", issued_date: "2026-03-04" }, { expectedName: cas.nom_attendu });
    const libelle = JSON.stringify([cas.nom_attendu, cas.candidat]);
    assert.equal(analysis.nameMatches, cas.resultat, libelle);
    assert.equal(analysis.issues.includes(message), cas.resultat === false, libelle);
  }
});

// ---------------------------------------------------------------------------
// Exécution croisée des deux mappings
// ---------------------------------------------------------------------------
// Avertissements du normaliseur partagé (« date non reconnue », « date
// impossible ») : leur TEXTE diffère entre les deux portages, mesuré ici —
// citation par repr() ('mars 2026') contre JSON.stringify ("mars 2026"), et
// « laissee vide -- … annee » sans accents côté Python contre « laissée vide —
// … année » côté JS. Écart PRÉEXISTANT dans kbis_to_contrats.py /
// kbis-mapping.js, que date_docie.json ne fige pas (seule la panne nommée y est
// comparée, règle `_avertissement`) : on compare donc le champ et la panne,
// pas le reste de la phrase. Les messages du contrôle de dates, eux, sont
// comparés au caractère près.
function sansCitation(warnings) {
  return warnings.map((w) => w.replace(/^(\w+: date (?:non reconnue|impossible)) \(.*$/, "$1"));
}

test("fiscale : même sortie que le portage Python sur fixtures et jeux d'essai (exécution croisée)", (t) => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import fiscale_to_contrats as f",
    "fixtures, partagees, aujourdhui = sys.argv[2], sys.argv[3], sys.argv[4]",
    "def charge(chemin): return json.load(open(chemin, encoding='utf-8'))",
    "def env(valeurs): return {'schema_name': 'fiscale', 'result': {k: {'value': v} for k, v in valeurs.items()},",
    "                          'validation': {'valid': True, 'errors': [], 'warnings': []}}",
    "def sortie(m): return {'analysis': m.analysis, 'warnings': m.warnings}",
    "out = {'fixtures': [], 'dates': [], 'siren': [], 'nom': []}",
    "for nom in json.loads(sys.argv[5]):",
    "    out['fixtures'].append(sortie(f.map_docie_fiscale_to_analysis(charge(fixtures + '/' + nom), expected_name='SUND INDUSTRY SYSTEM', items=[{'id': 'fiscale'}], aujourdhui=aujourdhui)))",
    "base = {'company_name': 'SUND INDUSTRY SYSTEM', 'siren': '941091316'}",
    "for c in charge(partagees + '/date_plausible.json')['cas']:",
    "    out['dates'].append(sortie(f.map_docie_fiscale_to_analysis(env({**base, **c['valeurs']}), aujourdhui=c.get('aujourdhui', aujourdhui))))",
    "for c in charge(partagees + '/siren_siret.json')['cas']:",
    "    out['siren'].append(sortie(f.map_docie_fiscale_to_analysis(env({'company_name': 'SUND INDUSTRY SYSTEM', 'siren': c['siren'], 'siret': c['siret'], 'issued_date': '2026-03-04'}), aujourdhui=aujourdhui)))",
    "for c in charge(partagees + '/nom_docie.json')['cas']:",
    "    out['nom'].append(sortie(f.map_docie_fiscale_to_analysis(env({'company_name': c['candidat'], 'siren': '941091316', 'issued_date': '2026-03-04'}), expected_name=c['nom_attendu'], aujourdhui=aujourdhui)))",
    "sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))",
  ].join("\n");
  const interpreteur = process.platform === "win32" ? "python" : "python3";
  // On ne saute QUE si l'interpréteur manque (motif corrigé par #208) : un
  // mapping Python cassé doit faire échouer ce test, pas le sauter.
  const sonde = spawnSync(interpreteur, ["-c", "pass"], { encoding: "utf-8" });
  if (sonde.error || sonde.status !== 0) {
    t.skip("Python indisponible : " + (sonde.error ? sonde.error.message : sonde.stderr));
    return;
  }
  const python = spawnSync(interpreteur, [
    "-c", script, path.join(RACINE, "document-parsing", "mappings"), FIXTURES, PARTAGEES, AUJOURDHUI, JSON.stringify(FIXTURES_FISCALE),
  ], { encoding: "utf-8" });
  assert.equal(python.status, 0, "le mapping Python a échoué : " + python.stderr);
  const py = JSON.parse(python.stdout);
  const comparer = (js, attendu, libelle, { sansNumeros = false } = {}) => {
    const a = { ...js.analysis };
    const b = { ...attendu.analysis };
    // #179 A14 : un SIREN rendu en flottant entier (941091316.0) reste
    // "941091316.0" côté Python et devient "941091316" côté JS dans le champ
    // mappé. Préexistant, commun au Kbis et à l'URSSAF ; le verdict, lui, est
    // comparé.
    if (sansNumeros) { delete a.siren; delete a.siret; delete b.siren; delete b.siret; }
    assert.deepEqual(a, b, libelle);
    assert.deepEqual(sansCitation(js.warnings), sansCitation(attendu.warnings), libelle);
  };
  assert.equal(py.fixtures.length, FIXTURES_FISCALE.length);
  FIXTURES_FISCALE.forEach((nom, i) => comparer(mapperFixture(nom, { expectedName: "SUND INDUSTRY SYSTEM", items: [{ id: "fiscale" }] }), py.fixtures[i], nom));
  assert.equal(py.dates.length, DATES.cas.length);
  DATES.cas.forEach((cas, i) => comparer(mapperValeurs({ ...BASE, ...cas.valeurs }, { aujourdhui: cas.aujourdhui || AUJOURDHUI }), py.dates[i], JSON.stringify(cas.valeurs)));
  assert.equal(py.siren.length, SIREN_SIRET.cas.length);
  SIREN_SIRET.cas.forEach((cas, i) => comparer(mapperValeurs(valeursSiren(cas)), py.siren[i], JSON.stringify([cas.siren, cas.siret]), { sansNumeros: true }));
  assert.equal(py.nom.length, NOM.cas.length);
  NOM.cas.forEach((cas, i) => comparer(
    mapperValeurs({ company_name: cas.candidat, siren: "941091316", issued_date: "2026-03-04" }, { expectedName: cas.nom_attendu }),
    py.nom[i], JSON.stringify([cas.nom_attendu, cas.candidat])
  ));
});
