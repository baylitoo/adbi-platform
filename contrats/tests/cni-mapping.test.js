"use strict";
// Tests du schéma dynamique "cni" (pièce d'identité, #170 / #194) et de
// lib/cni-mapping.js — pendant JS de
// document-parsing/mappings/test_cni_to_contrats.py.
//
// Comme urssaf-mapping.test.js et rib-mapping.test.js, ce fichier lit LES
// MÊMES fixtures que Python et les fait passer par le VRAI déballage du pont
// (docie-bridge.js::parseTextResponse -> unwrap), puis exécute le portage
// Python sur les mêmes entrées et compare les deux sorties (exécution croisée).
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
  DOCANALYZE_BASE_KEYS, ENRICHED_KEYS, MAPPED_FIELDS, DOCUMENT_TYPE_LABEL, ILLISIBLE, mapCniResult,
} = require("../lib/cni-mapping");
const { mapUrssafResult } = require("../lib/urssaf-mapping");

const RACINE = path.join(__dirname, "..", "..");
const { parseTextResponse } = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));
const FIXTURES = path.join(RACINE, "document-parsing", "mappings", "fixtures");
const PARTAGEES = path.join(RACINE, "document-parsing", "fixtures");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "cni.schema.json"));
const MRZ = require(path.join(PARTAGEES, "mrz.json"));
const NOM = require(path.join(PARTAGEES, "nom_docie.json"));
const CATALOGUE = require(path.join(RACINE, "document-parsing", "models", "catalogue.json"));
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "lib", "cni-mapping.js"), "utf8");

const FIXTURES_CNI = [
  "cni_extraction_sample.json",
  "cni_extraction_sample_edge_cases.json",
  "cni_extraction_sample_unreadable.json",
];
const MESSAGE_NUMERO = "Numéro de document « SPECIMEM1 » de la MRZ : chiffre de contrôle invalide (lu 3, calculé 0),"
  + " caractère probablement mal lu — valeur conservée, à vérifier sur le document";
const MESSAGE_COMPOSITE = "Chiffre de contrôle composite de la MRZ invalide (lu 6, calculé 3) : au moins un caractère"
  + " des lignes 1 et 2 est mal lu — valeur conservée, à vérifier sur le document";
const DOCIE_DOUTEUX = "DocIE n'a pas validé l'extraction (vérification manuelle recommandée).";
const NOM_NE_CORRESPOND_PAS = "La société du document ne correspond pas au sous-traitant saisi.";

const TYPES = new Set(["string", "date", "number", "money", "object", "list"]);
const NOM_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVES = new Set(["document_type", "extraction_notes"]);

// Les DIX champs retenus et leur type. Figés ici plutôt que déduits du fichier :
// un champ ajouté au schéma sans justification casse ce test.
const CHAMPS_JUSTIFIES = {
  surname: "string",
  given_names: "string",
  document_number: "string",
  nationality: "string",
  birth_date: "date",
  sex: "string",
  issue_date: "date",
  expiry_date: "date",
  mrz_line1: "string",
  mrz_line2: "string",
};

function enveloppe(nom) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, nom), "utf8"));
}
// Le `result` tel que le consommateur JS le reçoit réellement : déballé par le
// pont, pas reconstruit à la main.
function mapperFixture(nom, options = {}) {
  const { result, metadata } = parseTextResponse(enveloppe(nom), "cni");
  return mapCniResult(result, { validation: metadata.validation, ...options });
}
// Mesuré sur urssaf : le pont ne déballe un champ que s'il porte un marqueur
// DocIE (evidence_ids / confidence).
function champ(value) {
  return { value, evidence_ids: [], confidence: 0.9 };
}
function mapperValeurs(valeurs, options = {}) {
  const env = {
    schema_name: "cni",
    result: Object.fromEntries(Object.entries(valeurs).map(([k, v]) => [k, champ(v)])),
    validation: { valid: true, errors: [], warnings: [] },
  };
  const { result, metadata } = parseTextResponse(env, "cni");
  return mapCniResult(result, { validation: metadata.validation, ...options });
}

// ---------------------------------------------------------------------------
// Schéma
// ---------------------------------------------------------------------------
test("schéma cni : racine et document_type conformes à DynamicSchemaSpec", () => {
  assert.deepEqual(Object.keys(SCHEMA), ["document_type", "fields"]);
  assert.equal(SCHEMA.document_type, "cni");
  assert.match(SCHEMA.document_type, NOM_RE);
  assert.ok(SCHEMA.document_type.length <= 64);
  assert.ok(!RESERVES.has(SCHEMA.document_type));
});

test("schéma cni : noms, types, sous-champs, noms réservés", () => {
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
      assert.ok(c.description.trim().length > 0, libelle);
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

test("schéma cni : aucun champ inventé, aucun montant, chaque champ mappé et réciproquement", () => {
  assert.deepEqual(Object.fromEntries(SCHEMA.fields.map((f) => [f.name, f.type])), CHAMPS_JUSTIFIES);
  // Une pièce d'identité n'imprime ni montant ni quantité : les lignes
  // « money » et « number » de #170 ne valent pas pour cette pièce.
  assert.ok(!SCHEMA.fields.some((f) => f.type === "money" || f.type === "number"));
  assert.deepEqual(new Set(SCHEMA.fields.map((f) => f.name)), new Set([...Object.keys(MAPPED_FIELDS), "issue_date"]));
  for (const nom of FIXTURES_CNI) assert.deepEqual(enveloppe(nom).dynamic_schema, SCHEMA, nom);
});

test("schéma cni : deux lignes de MRZ et pas trois (TD1), format écrit et non sous-entendu", () => {
  // TD1 compte TROIS lignes de 30 ; seules les deux premières sont demandées,
  // parce qu'elles portent tous les chiffres de contrôle. La troisième ne porte
  // que les noms, déjà demandés en clair.
  assert.deepEqual(SCHEMA.fields.map((f) => f.name).filter((n) => n.startsWith("mrz_")), ["mrz_line1", "mrz_line2"]);
  assert.ok(MRZ._format.includes("TD1"));
});

test("la pièce, le libellé et le prérequis du catalogue sont ceux du dépôt", () => {
  const docanalyze = fs.readFileSync(path.join(__dirname, "..", "lib", "docanalyze.js"), "utf8");
  assert.ok(docanalyze.includes('type = "' + DOCUMENT_TYPE_LABEL + '"'));
  const checklist = fs.readFileSync(path.join(__dirname, "..", "lib", "checklist.js"), "utf8");
  const ligne = checklist.split("\n").find((l) => l.includes('id: "cni"'));
  // Pas de `dateField` : aucune validité n'est calculée à partir de la date de
  // délivrance, d'où l'absence du message « Date de délivrance non trouvée ».
  assert.ok(ligne && !ligne.includes("dateField"));
  assert.deepEqual(Object.keys(CATALOGUE.taches.cni.voies), ["agent"]);
  assert.ok(CATALOGUE.taches.cni.voies.agent.defaut.prerequis.includes("MRZ"));
});

// ---------------------------------------------------------------------------
// Importé, pas recopié
// ---------------------------------------------------------------------------
// Remplace des exports d'un module importé, recharge le mapping, et rend le
// mapper ainsi obtenu. Une copie RENOMMÉE, require laissé en place, passe la
// lecture du source ; elle ne rendrait pas le témoin.
function avecTemoin(cheminModule, remplacements, corps) {
  const cheminMapping = require.resolve("../lib/cni-mapping");
  const module = require(cheminModule);
  const originaux = Object.fromEntries(Object.keys(remplacements).map((k) => [k, module[k]]));
  delete require.cache[cheminMapping];
  try {
    Object.assign(module, remplacements);
    corps(require(cheminMapping).mapCniResult);
  } finally {
    Object.assign(module, originaux);
    delete require.cache[cheminMapping];
  }
}

test("importé, pas recopié : lecture du source", () => {
  for (const module of ["./kbis-mapping", "./mrz"]) {
    assert.ok(SOURCE.includes('require("' + module + '")'), "cni-mapping.js doit requérir " + module);
  }
  assert.ok(!/function\s+(normalizeDate|dateExiste|formeEcrite|controlerMrz|messagesMrz|chiffreControle|valeurCaractere|checkName|norm)\b|(const|let|var)\s+(normalizeDate|controlerMrz|messagesMrz|chiffreControle|valeurCaractere|checkName|POIDS|LONGUEUR_LIGNE|MOTIF_SEPARATEURS|ANNEE_MIN|ANNEE_MAX|JOURS_PAR_MOIS)\s*=/.test(SOURCE),
    "cni-mapping.js ne doit PAS redéfinir un contrôle ni un normaliseur partagé");
  const code = SOURCE.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/%\s*10\b/.test(code), "arithmétique du chiffre de contrôle recopiée");
  assert.ok(!/\b(1950|2100)\b/.test(code), "seconde fenêtre d'années écrite en dur");
  assert.ok(!/normalize\("NFD"\)/.test(code), "comparaison de nom recopiée");
  // La comparaison de nom n'est même pas requise (voir l'en-tête du module).
  assert.ok(!/require\("\.\/docanalyze"\)/.test(SOURCE), "cni-mapping.js ne compare aucun nom de société");
  // Déclaré exécutant du jeu d'essai qu'il traverse, jamais copie des règles
  // qu'il importe.
  assert.ok(MRZ._ports.includes("contrats/lib/cni-mapping.js (JS)"));
  assert.ok(!NOM._ports.some((p) => p.includes("cni")));
  for (const f of ["date_docie.json", "nombre_docie.json"]) {
    const ports = require(path.join(PARTAGEES, f))._ports;
    assert.equal(ports.length, 4, f);
    assert.ok(!ports.some((p) => p.includes("cni")), f);
  }
});

test("importé, pas recopié : témoin du contrôle de la MRZ", () => {
  const temoin = { ligne1: { valeur: "t", compact: null, statut: "temoin" } };
  const appels = [];
  avecTemoin(require.resolve("../lib/mrz"), {
    controlerMrz: (...args) => { appels.push(args); return temoin; },
    messagesMrz: (c) => (c === temoin ? [{ champ: "mrz_line2", message: "MRZ TÉMOIN" }] : []),
  }, (mapper) => {
    const { result } = parseTextResponse(enveloppe("cni_extraction_sample.json"), "cni");
    const { analysis, warnings } = mapper(result, {});
    assert.deepEqual(appels, [["IDFRASPECIMEN13<<<<<<<<<<<<<<<", "8001014M3501014FRA<<<<<<<<<<<6"]]);
    assert.equal(analysis.controleMrz, temoin);
    assert.ok(analysis.issues.includes("MRZ TÉMOIN"));
    assert.ok(warnings.includes("mrz_line2: MRZ TÉMOIN"));
  });
});

test("importé, pas recopié : témoin du normaliseur de date", () => {
  const appels = [];
  avecTemoin(require.resolve("../lib/kbis-mapping"), {
    normalizeDate: (brut, champKey) => { appels.push(champKey); return "1999-09-09"; },
  }, (mapper) => {
    const { result } = parseTextResponse(enveloppe("cni_extraction_sample.json"), "cni");
    const { analysis } = mapper(result, {});
    assert.equal(analysis.issuedDate, "1999-09-09");
    assert.equal(analysis.dateNaissance, "1999-09-09");
    assert.equal(analysis.dateExpiration, "1999-09-09");
    assert.deepEqual(appels.sort(), ["birth_date", "expiry_date", "issue_date"]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
test("cas nominal : valeurs, quatre chiffres de MRZ vérifiés, même forme que l'URSSAF", () => {
  const { analysis, warnings } = mapperFixture("cni_extraction_sample.json", { items: [{ id: "cni" }] });
  for (const k of DOCANALYZE_BASE_KEYS) assert.ok(Object.hasOwn(analysis, k), k);
  for (const k of ENRICHED_KEYS) assert.ok(Object.hasOwn(analysis, k) && !DOCANALYZE_BASE_KEYS.includes(k), k);
  assert.ok(!ENRICHED_KEYS.includes("controleMrz"));
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.equal(analysis.matchedId, "cni");
  assert.equal(analysis.isValid, true);
  assert.equal(analysis.issuedDate, "2025-01-02");
  assert.equal(analysis.nom, "SPECIMEN");
  assert.equal(analysis.prenoms, "JEAN PAUL");
  assert.equal(analysis.numeroDocument, "SPECIMEN1");
  assert.equal(analysis.nationalite, "FRA");
  assert.equal(analysis.dateNaissance, "1980-01-01");
  assert.equal(analysis.sexe, "M");
  assert.equal(analysis.dateExpiration, "2035-01-01"); // 01/01/2035 converti
  assert.equal(analysis.mrzLigne1, "IDFRASPECIMEN13<<<<<<<<<<<<<<<");
  assert.equal(analysis.mrzLigne2, "8001014M3501014FRA<<<<<<<<<<<6");
  assert.equal(analysis.summary, DOCUMENT_TYPE_LABEL + " — délivré le 2025-01-02");
  assert.deepEqual(analysis.issues, []);
  assert.deepEqual(warnings, []);
  for (const nom of ["ligne1", "ligne2", "numero_document", "date_naissance", "date_expiration", "composite"]) {
    assert.equal(analysis.controleMrz[nom].statut, "valide", nom);
  }
  // Même forme que l'URSSAF : mêmes clés de base, mêmes types.
  const u = parseTextResponse(JSON.parse(fs.readFileSync(path.join(FIXTURES, "urssaf_extraction_sample.json"), "utf8")), "urssaf");
  const urssaf = mapUrssafResult(u.result, { validation: u.metadata.validation }).analysis;
  for (const k of DOCANALYZE_BASE_KEYS) {
    assert.ok(Object.hasOwn(analysis, k), k);
    if (analysis[k] !== null && urssaf[k] !== null) assert.equal(typeof analysis[k], typeof urssaf[k], k);
  }
});

test("matchedId : port exact de detectType", () => {
  assert.equal(mapperFixture("cni_extraction_sample.json", { items: [{ id: "kbis" }] }).analysis.matchedId, null);
  assert.equal(mapperFixture("cni_extraction_sample.json", { items: [] }).analysis.matchedId, null);
  assert.equal(mapperFixture("cni_extraction_sample.json").analysis.matchedId, null);
});

test("aucune comparaison de nom : nameMatches reste null quel que soit expectedName", () => {
  // Écart VOULU avec les trois autres paires : `expectedName` vaut la
  // dénomination du SOUS-TRAITANT, alors qu'une carte porte le consultant.
  for (const attendu of [undefined, "", "SUND INDUSTRY SYSTEM", "SPECIMEN", "Autre Societe SARL"]) {
    const { analysis } = mapperFixture("cni_extraction_sample.json", { expectedName: attendu });
    assert.equal(analysis.nameMatches, null, String(attendu));
    assert.equal(analysis.companyName, null, String(attendu));
    assert.ok(!analysis.issues.includes(NOM_NE_CORRESPOND_PAS), String(attendu));
  }
  // Et aucun cas du jeu d'essai des noms ne fait apparaître le message.
  for (const cas of NOM.cas) {
    const { analysis } = mapperValeurs({ surname: cas.candidat, mrz_line1: null }, { expectedName: cas.nom_attendu });
    assert.equal(analysis.nameMatches, null);
    assert.ok(!analysis.issues.includes(NOM_NE_CORRESPOND_PAS));
  }
  // Le nom lu n'est pas perdu pour autant.
  assert.equal(mapperFixture("cni_extraction_sample.json").analysis.nom, "SPECIMEN");
});

test("cas limites : numéro de MRZ mal lu CONSERVÉ et signalé deux fois, date impossible nommée", () => {
  const { analysis, warnings } = mapperFixture("cni_extraction_sample_edge_cases.json");
  assert.equal(analysis.mrzLigne1, "IDFRASPECIMEM13<<<<<<<<<<<<<<<");
  assert.equal(analysis.controleMrz.numero_document.statut, "cle_invalide");
  assert.equal(analysis.controleMrz.composite.statut, "cle_invalide");
  assert.equal(analysis.controleMrz.date_naissance.statut, "valide");
  assert.deepEqual(analysis.issues, [DOCIE_DOUTEUX, MESSAGE_NUMERO, MESSAGE_COMPOSITE]);
  assert.ok(warnings.includes("mrz_line1: " + MESSAGE_NUMERO));
  assert.ok(warnings.includes("mrz_line2: " + MESSAGE_COMPOSITE));
  // Date d'expiration hors calendrier : vidée et nommée par le normaliseur
  // partagé ; date de délivrance écrite en toutes lettres : lue.
  assert.equal(analysis.dateExpiration, "");
  assert.ok(warnings.some((w) => w.includes("date impossible") && w.includes("expiry_date")), warnings.join(" | "));
  assert.equal(analysis.issuedDate, "2025-01-02");
  assert.ok(!warnings.some((w) => w.startsWith("issue_date:")));
  assert.equal(analysis.numeroDocument, "");  // champ absent de la réponse
  assert.equal(analysis.sexe, "");            // champ à null
  assert.equal(analysis.nationalite, "   ");  // chaîne rendue telle quelle
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL);
  assert.ok(warnings.some((w) => w.startsWith("DocIE extraction_notes:")));
  assert.ok(warnings.some((w) => w.startsWith("DocIE validation.errors:")));
  assert.ok(warnings.some((w) => w.startsWith("DocIE validation.warnings:")));
});

test("illisible : forme docanalyze.js, verdict présent, champ isolé gardé", () => {
  const { analysis } = mapperFixture("cni_extraction_sample_unreadable.json");
  assert.equal(analysis.documentType, "Document");
  assert.equal(analysis.isValid, false);
  assert.equal(analysis.issuedDate, "");
  assert.equal(analysis.companyName, null);
  assert.equal(analysis.nameMatches, null);
  assert.equal(analysis.summary, "Document illisible.");
  assert.deepEqual(analysis.issues, [ILLISIBLE]);
  assert.equal(analysis.nationalite, "FRA");
  assert.equal(analysis.controleMrz.ligne1.statut, "absent");
  assert.equal(analysis.controleMrz.composite.statut, "absent");
  // Chacun des quatre signaux identifiants suffit à lui seul.
  for (const champKey of ["surname", "document_number", "mrz_line1", "mrz_line2"]) {
    const { analysis: a } = mapperValeurs({ [champKey]: "X" });
    assert.equal(a.documentType, DOCUMENT_TYPE_LABEL, champKey);
  }
  // Le prénom, la nationalité ou le sexe seuls, non.
  for (const champKey of ["given_names", "nationality", "sex"]) {
    const { analysis: a } = mapperValeurs({ [champKey]: "X" });
    assert.deepEqual(a.issues, [ILLISIBLE], champKey);
  }
  // Une ligne lue mais fausse est une lecture, pas une absence (#179 B1).
  const malLue = mapperValeurs({ mrz_line1: "IDFRASPECIMEN13<<<<<<<<" }).analysis;
  assert.equal(malLue.documentType, DOCUMENT_TYPE_LABEL);
  assert.equal(malLue.mrzLigne1, "IDFRASPECIMEN13<<<<<<<<");
  assert.equal(malLue.controleMrz.ligne1.statut, "format_invalide");
  assert.equal(malLue.isValid, true);
});

test("garde-fou : un résultat non-objet lève une erreur explicite", () => {
  for (const mauvais of [null, undefined, [], "x", 3]) {
    assert.throws(() => mapCniResult(mauvais), /Résultat DocIE 'cni' invalide/);
  }
});

test("jeu d'essai mrz.json de bout en bout : statuts, messages dans issues, lignes conservées", () => {
  for (const cas of MRZ.cas) {
    const libelle = JSON.stringify([cas.ligne1, cas.ligne2]) + " (" + cas.preuve + ")";
    const { analysis, warnings } = mapperValeurs({ surname: "SPECIMEN", mrz_line1: cas.ligne1, mrz_line2: cas.ligne2 });
    for (const [nom, statut] of Object.entries(cas.statuts)) {
      assert.equal(analysis.controleMrz[nom].statut, statut, libelle + " " + nom);
    }
    assert.deepEqual(analysis.issues, cas.messages.map((m) => m.message), libelle);
    assert.deepEqual(warnings, cas.messages.map((m) => m.champ + ": " + m.message), libelle);
    assert.equal(analysis.mrzLigne1, cas.ligne1 === null ? "" : String(cas.ligne1), libelle);
    assert.equal(analysis.mrzLigne2, cas.ligne2 === null ? "" : String(cas.ligne2), libelle);
    assert.equal(analysis.documentType, DOCUMENT_TYPE_LABEL, libelle);
    assert.equal(analysis.isValid, true, libelle);
  }
});

// ---------------------------------------------------------------------------
// Exécution croisée des deux mappings
// ---------------------------------------------------------------------------
// Avertissements du normaliseur partagé (« date non reconnue », « date
// impossible ») : leur TEXTE diffère entre les deux portages — citation par
// repr() contre JSON.stringify, et accents absents côté Python. Écart
// PRÉEXISTANT dans kbis_to_contrats.py / kbis-mapping.js, que date_docie.json
// ne fige pas (règle `_avertissement`) : on compare donc le champ et la panne,
// pas le reste de la phrase.
function sansCitation(warnings) {
  return warnings.map((w) => w.replace(/^(\w+: date (?:non reconnue|impossible)) \(.*$/, "$1"));
}

test("cni : même sortie que le portage Python sur fixtures et jeu d'essai (exécution croisée)", (t) => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import cni_to_contrats as c",
    "fixtures, partagees = sys.argv[2], sys.argv[3]",
    "def charge(chemin): return json.load(open(chemin, encoding='utf-8'))",
    "def env(valeurs): return {'schema_name': 'cni', 'result': {k: {'value': v} for k, v in valeurs.items()},",
    "                          'validation': {'valid': True, 'errors': [], 'warnings': []}}",
    "def sortie(m): return {'analysis': m.analysis, 'warnings': m.warnings}",
    "out = {'fixtures': [], 'mrz': []}",
    "for nom in json.loads(sys.argv[4]):",
    "    out['fixtures'].append(sortie(c.map_docie_cni_to_analysis(charge(fixtures + '/' + nom), items=[{'id': 'cni'}])))",
    "for cas in charge(partagees + '/mrz.json')['cas']:",
    "    valeurs = {'surname': 'SPECIMEN', 'mrz_line1': cas['ligne1'], 'mrz_line2': cas['ligne2']}",
    "    out['mrz'].append(sortie(c.map_docie_cni_to_analysis(env(valeurs))))",
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
    "-c", script, path.join(RACINE, "document-parsing", "mappings"), FIXTURES, PARTAGEES, JSON.stringify(FIXTURES_CNI),
  ], { encoding: "utf-8" });
  assert.equal(python.status, 0, "le mapping Python a échoué : " + python.stderr);
  const py = JSON.parse(python.stdout);
  const comparer = (js, attendu, libelle, { sansLignes = false } = {}) => {
    const a = { ...js.analysis };
    const b = { ...attendu.analysis };
    // #179 A14 : une ligne rendue en NOMBRE reste "1234.0" côté Python et
    // devient "1234" côté JS dans le champ mappé. Préexistant et commun aux
    // autres paires ; le verdict du contrôle, lui, est comparé (mrz.py ramène
    // le flottant entier à l'entier).
    if (sansLignes) { delete a.mrzLigne1; delete a.mrzLigne2; delete b.mrzLigne1; delete b.mrzLigne2; }
    assert.deepEqual(a, b, libelle);
    assert.deepEqual(sansCitation(js.warnings), sansCitation(attendu.warnings), libelle);
  };
  assert.equal(py.fixtures.length, FIXTURES_CNI.length);
  FIXTURES_CNI.forEach((nom, i) => comparer(mapperFixture(nom, { items: [{ id: "cni" }] }), py.fixtures[i], nom));
  assert.equal(py.mrz.length, MRZ.cas.length);
  MRZ.cas.forEach((cas, i) => comparer(
    mapperValeurs({ surname: "SPECIMEN", mrz_line1: cas.ligne1, mrz_line2: cas.ligne2 }),
    py.mrz[i], JSON.stringify([cas.ligne1, cas.ligne2]), { sansLignes: true }
  ));
});
