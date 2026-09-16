"use strict";
// Tests de lib/docie-contract-import.js. Aucun appel réseau réel : le bridge
// est soit stubbé directement (deps.extractDocument), soit exercé pour de
// vrai avec fetchImpl mocké — même politique que tests/docie-extraction.test.js
// ("aucun appel distant DocIE par agent ADBI").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  extractContractValues, mapContractResult, MAPPED_FIELDS,
  CONSTANT_FIELDS_NOT_FROM_DOCIE, GAP_FIELDS_NO_DOCIE_EQUIVALENT, ALL_ACCOUNTED_KEYS,
  MOTIF_NOMBRE, normalizeNumber, ANNEE_MIN, ANNEE_MAX, normalizeDate,
  MOTIF_DATE_ECRITE, tableMois,
} = require("../lib/docie-contract-import");

// Script exécuté dans un processus Node séparé : charge `module` en faisant
// échouer la résolution de date_mission.json comme dans l'image Docker de
// contrats, qui n'embarque pas document-parsing/fixtures. Prouve que le module
// se charge quand même, et ce que rend alors une date écrite.
function scriptSansTableMois(module) {
  return `
const Module = require("module");
const resoudre = Module._resolveFilename;
Module._resolveFilename = function (demande, ...reste) {
  if (String(demande).endsWith("date_mission.json")) {
    const err = new Error("Cannot find module " + demande);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  return resoudre.call(this, demande, ...reste);
};
const m = require(${JSON.stringify(module)});
const warnings = [];
const iso = m.normalizeDate("2019-03-12", "date_debut", []);
const ecrite = m.normalizeDate("le 12 mars 2019", "date_debut", warnings);
m.normalizeDate("le 5 courant", "date_debut", warnings);
console.log("\\n" + JSON.stringify({ iso, ecrite, warnings }));
`;
}
const { sousTraitance } = require("../lib/fields");
// Fixture RAW (enveloppe {value,confidence,evidence_ids} non déballée),
// générée depuis les vrais modèles pydantic de DocIE — voir
// document-parsing/mappings/fixtures/generate_sample.py. Utilisée ci-dessous
// pour prouver le déballage bridge -> mapping de bout en bout (voir le test
// d'intégration), pas seulement le mapping sur une forme déjà déballée.
const RAW_FIXTURE = require(path.join(
  __dirname, "..", "..", "document-parsing", "mappings", "fixtures", "contract_extraction_sample.json"
));
// Jeu d'essai PARTAGÉ avec les trois autres portages du même normaliseur
// (contract_to_contrats.py, kbis_to_contrats.py, lib/kbis-mapping.js) : c'est
// lui qui empêche la divergence de #179 (lignes A2 à A6) de revenir.
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

test("garde-fou anti-dérive : ALL_ACCOUNTED_KEYS == exactement les clés de fields.js::sousTraitance", () => {
  const fieldsKeys = new Set(sousTraitance.map((f) => f.key));
  assert.equal(ALL_ACCOUNTED_KEYS.size, fieldsKeys.size);
  for (const key of fieldsKeys) {
    assert.ok(
      ALL_ACCOUNTED_KEYS.has(key),
      key + " est dans fields.js::sousTraitance mais pas mappé/répertorié dans docie-contract-import.js"
    );
  }
  for (const key of ALL_ACCOUNTED_KEYS) {
    assert.ok(fieldsKeys.has(key), key + " est répertorié ici mais n'existe plus dans fields.js::sousTraitance");
  }
  // Les 3 catégories ne se recouvrent pas.
  const mappedKeys = Object.values(MAPPED_FIELDS).map(([k]) => k);
  for (const k of mappedKeys) {
    assert.ok(!CONSTANT_FIELDS_NOT_FROM_DOCIE.has(k), k + " est à la fois mappé et constant");
    assert.ok(!(k in GAP_FIELDS_NO_DOCIE_EQUIVALENT), k + " est à la fois mappé et gap");
  }
  for (const k of CONSTANT_FIELDS_NOT_FROM_DOCIE) {
    assert.ok(!(k in GAP_FIELDS_NO_DOCIE_EQUIVALENT), k + " est à la fois constant et gap");
  }
});

// Fixture nominale, forme POST-unwrap (document-parsing/bridge/docie-bridge.js
// ::unwrap) — PAS l'enveloppe brute {value,confidence,evidence_ids} de
// document-parsing/mappings/fixtures/contract_extraction_sample.json (celle-ci
// lit le JSON DocIE avant déballage bridge, un contexte différent : voir le
// commentaire d'en-tête de lib/docie-contract-import.js).
const NOMINAL_RESULT = {
  document_type: "contract",
  extraction_notes: ["low confidence on lieu_execution"],
  numero_contrat: "01-06-2026",
  date_redaction: "2026-01-05",
  lieu_redaction: "Paris",
  st_nom: "SUND INDUSTRY SYSTEM",
  st_adresse: "60 rue Francois 1er, 75008 Paris",
  st_siren: "941091316",
  st_siret: "94109131600013",
  st_representant: "Monsieur Corentin CALVO",
  st_forme_juridique: "SAS au capital de 1 000 EUR",
  st_qualite: "President",
  consultant_nom: "Corentin Calvo",
  consultant_fonction: "Developpeur Full Stack",
  client_final: "Groupe Accor",
  nature_travaux: "Developpement full stack de la plateforme de reservation",
  lieu_execution: "82 rue Henry Farman, 92130 Issy-les-Moulineaux",
  date_debut: "01/02/2026",
  date_fin: "2026-12-31",
  tjm: { amount: "450", currency: "EUR", evidence_ids: [], confidence: 0.9 },
  delai_paiement: "45",
};

test("mapContractResult: cas nominal — dates ISO/FR normalisées, montant EUR, notes reportées", () => {
  const mapped = mapContractResult(NOMINAL_RESULT);
  assert.equal(mapped.ok, true);
  assert.deepEqual(mapped.errors, []);
  assert.equal(mapped.values.numeroContrat, "01-06-2026");
  assert.equal(mapped.values.dateRedaction, "2026-01-05");
  assert.equal(mapped.values.lieuRedaction, "Paris");
  assert.equal(mapped.values.stNom, "SUND INDUSTRY SYSTEM");
  assert.equal(mapped.values.stSiren, "941091316");
  // date_debut est en DD/MM/YYYY côté DocIE -> converti en ISO.
  assert.equal(mapped.values.dateDebut, "2026-02-01");
  assert.equal(mapped.values.dateFin, "2026-12-31");
  assert.equal(mapped.values.tjm, "450");
  assert.equal(mapped.values.delaiPaiement, "45");
  assert.ok(mapped.warnings.some((w) => /extraction_notes/.test(w) && /lieu_execution/.test(w)));
  // Champs sans équivalent DocIE : vides, jamais inventés.
  assert.equal(mapped.values.stEmail, undefined); // non émis du tout (voir GAP)
});

test("mapContractResult: cas limite — null/absent, date non reconnue, devise non-EUR, numéro manquant", () => {
  const edge = {
    document_type: "contract",
    extraction_notes: ["numero_contrat absent du document source", "date_redaction ambigue, verifier manuellement"],
    numero_contrat: null,
    date_redaction: "le 5 courant",
    lieu_redaction: null,
    st_nom: "ACME FREELANCE",
    st_adresse: null,
    st_siren: "123456789",
    st_siret: null,
    st_representant: "Jane DOE",
    st_forme_juridique: "EI",
    st_qualite: "",
    consultant_nom: "Jane Doe",
    consultant_fonction: null,
    client_final: "Client Test SAS",
    nature_travaux: null,
    lieu_execution: null,
    date_debut: "2026-03-01",
    date_fin: "31/08/2026",
    tjm: { amount: "500", currency: "USD", evidence_ids: [], confidence: 0.6 },
    delai_paiement: "30.0",
  };
  const mapped = mapContractResult(edge);
  assert.equal(mapped.ok, false);
  assert.ok(mapped.errors.some((e) => /numéro du contrat/.test(e)));
  assert.equal(mapped.values.numeroContrat, "");
  assert.equal(mapped.values.lieuRedaction, "");
  assert.equal(mapped.values.stAdresse, "");
  assert.equal(mapped.values.stSiret, "");
  assert.equal(mapped.values.stQualite, "");
  assert.equal(mapped.values.consultantFonction, "");
  assert.equal(mapped.values.natureTravaux, "");
  assert.equal(mapped.values.lieuExecution, "");
  assert.equal(mapped.values.dateDebut, "2026-03-01");
  assert.equal(mapped.values.dateFin, "2026-08-31");
  // Date non reconnue ("le 5 courant") -> vide + avertissement, jamais inventée.
  assert.equal(mapped.values.dateRedaction, "");
  assert.ok(mapped.warnings.some((w) => /date_redaction/.test(w) && /non reconnue/.test(w)));
  // Devise non-EUR -> montant reporté tel quel + avertissement.
  assert.equal(mapped.values.tjm, "500");
  assert.ok(mapped.warnings.some((w) => /tjm/.test(w) && /USD/.test(w)));
  // Nombre décimal -> "30" (entier).
  assert.equal(mapped.values.delaiPaiement, "30");
});

test("mapContractResult: montant absent -> tjm vide, sans avertissement de devise", () => {
  const mapped = mapContractResult(Object.assign({}, NOMINAL_RESULT, { tjm: null, numero_contrat: "X", st_nom: "Y" }));
  assert.equal(mapped.values.tjm, "");
  assert.ok(!mapped.warnings.some((w) => /devise/.test(w)));
});

test("extractContractValues: flag off -> erreur explicite (code=disabled), bridge jamais appelé", async () => {
  const extractDocument = async () => { throw new Error("le bridge ne doit pas être appelé (flag off)"); };
  await assert.rejects(
    () => extractContractValues({ dataBase64: "AA==", mimeType: "application/pdf" }, { env: {}, extractDocument }),
    (err) => { assert.equal(err.code, "disabled"); return true; }
  );
});

test("extractContractValues: aucun fichier reçu -> erreur input", async () => {
  await assert.rejects(
    () => extractContractValues({}, { env: { DOCIE_EXTRACTION_ENABLED: "true" } }),
    (err) => { assert.equal(err.code, "input"); return true; }
  );
});

test("extractContractValues: flag on + succès DocIE -> values mappées, kind='contract' transmis au bridge", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  let seenKind = null;
  const extractDocument = async (buffer, mime, opts) => {
    seenKind = opts.kind;
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(mime, "application/pdf");
    return { schema_name: "contract", result: NOMINAL_RESULT, metadata: { request_id: "req-42" } };
  };
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  const result = await extractContractValues(body, { env, extractDocument });
  assert.equal(seenKind, "contract");
  assert.equal(result.requestId, "req-42");
  assert.equal(result.ok, true);
  assert.equal(result.values.stNom, "SUND INDUSTRY SYSTEM");
});

test("extractContractValues: échec DocIE (ex. config manquante) -> exception propagée avec un code, pas de crash", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const err = new Error("Configure the document kind's DocIE agent name.");
  err.code = "configuration";
  const extractDocument = async () => { throw err; };
  await assert.rejects(
    () => extractContractValues({ dataBase64: "AA==", mimeType: "application/pdf" }, { env, extractDocument }),
    (e) => { assert.equal(e.code, "configuration"); return true; }
  );
});

// Intégration réelle du bridge partagé (document-parsing/bridge/docie-bridge.js),
// fetchImpl mocké — prouve le câblage réel (kind="contract", endpoint, payload)
// ET le déballage réel bridge::unwrap() -> mapping, pas seulement le mapping
// sur une forme déjà déballée à la main : le "agent" mocké renvoie la
// fixture RAW (enveloppes {value,confidence,evidence_ids} non déballées,
// montant {amount,currency,...}), exactement comme
// document-parsing/mappings/test_contract_to_contrats.py la consomme côté
// Python — AVANT le bridge. C'est le test qui aurait échoué si unwrap()
// changeait de comportement (ex. se mettait à déballer aussi les montants)
// ou si NOMINAL_RESULT ci-dessus avait été mal dérivé à la main. Sans réseau.
test("intégration réelle du bridge partagé, fixture RAW non déballée (fetchImpl mocké, aucun réseau)", async () => {
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true",
    DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret",
    DOCIE_AGENT_CONTRACT: "contract-agent-test",
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    // La fixture RAW elle-même (result.*, chaque champ encore enveloppé) —
    // pas de reconstruction manuelle ici.
    const content = JSON.stringify(RAW_FIXTURE.result);
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      model: "contract-agent-test",
      choices: [{ finish_reason: "stop", message: { content } }],
    }), { status: 200 });
  };
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  const result = await extractContractValues(body, { env, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://docie.example.test/v1/agents/contract-agent-test/chat/completions");
  assert.equal(calls[0].body.model, "contract-agent-test");
  // Voie agent : aucune langue dans le corps, et ce n'est PAS un oubli. DocIE
  // lit la langue de la SPEC de l'agent (agents/runtime.py:550), jamais de la
  // requête : l'ajouter ici serait accepté puis ignoré en silence. La voie
  // texte, elle, l'envoie (tests/choix-modele.test.js). Asymétrie voulue.
  assert.equal(Object.hasOwn(calls[0].body, "language"), false);
  // Mêmes valeurs attendues que le cas nominal ci-dessus (NOMINAL_RESULT EST
  // la forme déballée de cette même fixture) — preuve que unwrap() produit
  // bien la forme que ce module suppose.
  assert.equal(result.values.stNom, "SUND INDUSTRY SYSTEM");
  assert.equal(result.values.numeroContrat, "01-06-2026");
  assert.equal(result.values.dateDebut, "2026-02-01"); // 01/02/2026 -> ISO
  assert.equal(result.values.tjm, "450"); // {amount:"450",currency:"EUR"} déballé -> "450"
  assert.equal(result.values.delaiPaiement, "45");
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Inventaire de divergence #179, ligne A1 : les avertissements et erreurs que
// DocIE émet SUR SA PROPRE EXTRACTION (`validation`) étaient reportés par le
// module Python miroir et jetés par ce portage — alors que le pont les range
// bel et bien dans `metadata.validation` (mesuré) et que public/app.js
// affiche les trois premiers `warnings` sous le formulaire pré-rempli.
// ---------------------------------------------------------------------------
test("mapContractResult: validation DocIE -> avertissements reportés (parité avec contract_to_contrats.py, #179 A1)", () => {
  const validation = { valid: false, errors: ["tjm hors bornes plausibles"], warnings: ["low overall confidence"] };
  const mapped = mapContractResult(NOMINAL_RESULT, { validation });
  assert.ok(mapped.warnings.includes("DocIE validation.warnings: low overall confidence"));
  assert.ok(mapped.warnings.includes("DocIE validation.errors: tjm hors bornes plausibles"));
  // `validation` absente (agent qui n'en émet pas) : aucun avertissement
  // fabriqué, et surtout aucun plantage.
  assert.ok(!mapContractResult(NOMINAL_RESULT).warnings.some((w) => /validation/.test(w)));
  assert.ok(!mapContractResult(NOMINAL_RESULT, { validation: { valid: true, errors: [], warnings: [] } })
    .warnings.some((w) => /validation/.test(w)));
});

// ---------------------------------------------------------------------------
// Inventaire de divergence #179, lignes A2 à A6 : ce module s'en remettait à
// Number(), le module Python miroir à float(), et les deux n'acceptent pas les
// mêmes textes — dans les DEUX sens (« 0x1e » -> 30 ici, « 1_000 » -> 1000
// là-bas, « nan » faisant carrément remonter une exception côté Python).
// La règle est désormais écrite une seule fois, dans la fixture partagée, et
// les quatre portages comparent leur motif ET leur sortie à ce fichier :
// ajouter une forme d'un seul côté casse le test de l'autre service.
// ---------------------------------------------------------------------------
test("nombre : le motif de ce portage est celui de la fixture partagée (#179 A2-A6)", () => {
  assert.equal(new RegExp(MOTIF_NOMBRE).source, NOMBRE.motif);
  assert.ok(NOMBRE._ports.includes("contrats/lib/docie-contract-import.js (JS)"));
});

test("nombre : les " + NOMBRE.cas.length + " cas du jeu d'essai partagé (#179 A2-A6)", () => {
  for (const cas of NOMBRE.cas) {
    const warnings = [];
    const sortie = normalizeNumber(cas.valeur, "champ", warnings);
    assert.equal(sortie, cas.sortie, cas.valeur + " -> " + JSON.stringify(sortie) + " (" + cas.preuve + ")");
    assert.equal(warnings.length > 0, cas.avertit, "avertissement attendu=" + cas.avertit + " pour " + JSON.stringify(cas.valeur));
  }
});

test("nombre : null/absent -> vide, nombre JS natif accepté", () => {
  const warnings = [];
  assert.equal(normalizeNumber(null, "champ", warnings), "");
  assert.equal(normalizeNumber(undefined, "champ", warnings), "");
  // L'agent DocIE peut sérialiser un Decimal en nombre JSON natif plutôt
  // qu'en chaîne : String(450) puis la règle lexicale rendent la même sortie.
  assert.equal(normalizeNumber(450, "champ", warnings), "450");
  assert.equal(normalizeNumber(450.5, "champ", warnings), "450.5");
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// #179 lignes A8/A9 : les deux motifs de date ne comptaient que des chiffres,
// jamais leurs bornes. Mesuré avant correction, sur ce module ET sur son
// miroir Python : « 01/13/2026 » -> « 2026-13-01 » et « 45/02/2026 » ->
// « 2026-02-45 », des deux côtés, sans un seul avertissement. Le navigateur
// vide alors le <input type="date"> déclaré par fields.js : la date extraite
// disparaît en silence, et la panne ressemble à « DocIE n'a rien trouvé ».
// La règle est désormais écrite une seule fois, dans la fixture partagée.
// ---------------------------------------------------------------------------
test("date : les bornes de ce portage sont celles de la fixture partagée (#179 A8/A9)", () => {
  assert.equal(ANNEE_MIN, DATE.annee_min);
  assert.equal(ANNEE_MAX, DATE.annee_max);
  assert.ok(DATE._ports.includes("contrats/lib/docie-contract-import.js (JS)"));
});

test("date : les " + DATE.cas.length + " cas du jeu d'essai partagé (#179 A8/A9)", () => {
  for (const cas of DATE.cas) {
    const warnings = [];
    const sortie = normalizeDate(cas.valeur, "champ", warnings);
    assert.equal(sortie, cas.sortie, cas.valeur + " -> " + JSON.stringify(sortie) + " (" + cas.preuve + ")");
    assert.equal(warnings.length > 0, cas.avertit, "avertissement attendu=" + cas.avertit + " pour " + JSON.stringify(cas.valeur));
    // La NATURE de la panne, pas seulement sa présence : une date écrite au
    // jour impossible ne doit pas glisser vers « non reconnue », ni l'inverse.
    if (cas.avertit) {
      assert.ok(warnings[0].includes(cas.avertissement),
        JSON.stringify(cas.valeur) + " : attendu « " + cas.avertissement + " », reçu " + warnings[0]);
    }
  }
});

// ---------------------------------------------------------------------------
// #179 ligne A10 : « le 12 mars 2019 » sortait vide + « date non reconnue »
// ici comme côté Python. La table de mois existe déjà (date_mission.json) :
// elle est LUE, jamais recopiée, et les tests le vérifient.
// ---------------------------------------------------------------------------
test("date écrite : motif identique à la fixture, table de mois LUE dans date_mission.json (#179 A10)", () => {
  assert.equal(MOTIF_DATE_ECRITE, DATE.motif_date_ecrite);
  // Même objet que le cache de require : une table recopiée à la main, même
  // identique clé pour clé, échoue ici.
  assert.equal(tableMois(), require(path.join(__dirname, "..", "..", DATE.table_mois)).mois);
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "docie-contract-import.js"), "utf8");
  assert.ok(!/["']janvier["']/.test(source), "docie-contract-import.js ne doit pas porter de table de mois littérale");
});

test("date écrite : table de mois absente (image sans document-parsing/fixtures) -> démarrage intact, cause nommée", () => {
  const r = spawnSync(process.execPath, ["-e", scriptSansTableMois(path.join(__dirname, "..", "lib", "docie-contract-import.js"))],
    { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { iso, ecrite, warnings } = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(iso, "2019-03-12");
  assert.equal(ecrite, "");
  assert.equal(warnings.length, 2, warnings.join(" | "));
  assert.match(warnings[0], /le 12 mars 2019/);
  assert.match(warnings[0], /table des mois introuvable/);
  assert.ok(!/date non reconnue|date impossible/.test(warnings[0]));
  // Une forme qui n'est pas une date écrite ne dépend pas de la table.
  assert.match(warnings[1], /date non reconnue/);
});

test("date : une date impossible s'avertit AUTREMENT qu'une date illisible, et cite le champ", () => {
  // Deux pannes qui ne se corrigent pas de la même façon : « DocIE a lu une
  // date fausse » n'est pas « DocIE n'a rien su lire ». Le relecteur doit
  // pouvoir les distinguer, et retrouver la valeur brute dans le message —
  // c'est là qu'elle survit, puisque le champ, lui, reste vide.
  const impossible = [];
  assert.equal(normalizeDate("01/13/2026", "date_debut", impossible), "");
  assert.match(impossible[0], /date_debut/);
  assert.match(impossible[0], /date impossible/);
  assert.match(impossible[0], /01\/13\/2026/);

  const illisible = [];
  assert.equal(normalizeDate("le 5 courant", "date_redaction", illisible), "");
  assert.match(illisible[0], /date non reconnue/);
  assert.ok(!/date impossible/.test(illisible[0]));
});

test("date : mapContractResult refuse un mois 13 sur date_debut, sans toucher aux autres champs (#179 A8)", () => {
  const mapped = mapContractResult({
    numero_contrat: "C-2026-001", st_nom: "ACME", date_debut: "01/13/2026", date_fin: "2026-12-31",
  });
  assert.equal(mapped.values.dateDebut, "");
  assert.equal(mapped.values.dateFin, "2026-12-31");
  assert.ok(mapped.warnings.some((w) => /date_debut/.test(w) && /date impossible/.test(w)));
  // Refusée, jamais réparée : surtout pas un 2026-01-13 (jour et mois
  // échangés) ni un 2026-12-01 rabattu sur la borne du mois.
  assert.ok(!mapped.warnings.some((w) => /date_fin/.test(w)));
});

test("extractContractValues: la validation du pont traverse jusqu'aux avertissements rendus (#179 A1)", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const extractDocument = async () => ({
    schema_name: "contract",
    result: NOMINAL_RESULT,
    metadata: { request_id: "req-43", validation: { valid: true, errors: [], warnings: ["low overall confidence"] } },
  });
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  const result = await extractContractValues(body, { env, extractDocument });
  assert.equal(result.requestId, "req-43");
  assert.ok(result.warnings.includes("DocIE validation.warnings: low overall confidence"));
});

// #194 (liste retenue, « échouer bruyamment ») : chaque cas du jeu d'essai
// PARTAGÉ avec document-parsing/mappings/test_contract_to_contrats.py traverse
// mapContractResult de bout en bout.
const SIREN_SIRET = require(path.join(
  __dirname, "..", "..", "document-parsing", "fixtures", "siren_siret.json"
));
const CHAMPS_CONTRAT = { siren: "st_siren", siret: "st_siret" };

test("siren/siret : chaque cas du jeu d'essai traverse mapContractResult (#194)", () => {
  assert.ok(SIREN_SIRET._ports.includes("contrats/lib/docie-contract-import.js (JS)"));
  const clesMappees = Object.values(MAPPED_FIELDS).map(([k]) => k).sort();
  for (const cas of SIREN_SIRET.cas) {
    const libelle = JSON.stringify([cas.siren, cas.siret]) + " (" + cas.preuve + ")";
    const mapped = mapContractResult({
      numero_contrat: "C-2026-001", st_nom: "ACME", st_siren: cas.siren, st_siret: cas.siret,
    });
    // Valeur lue CONSERVÉE, jamais vidée.
    assert.equal(mapped.values.stSiren, cas.siren === null ? "" : String(cas.siren), libelle);
    assert.equal(mapped.values.stSiret, cas.siret === null ? "" : String(cas.siret), libelle);
    assert.equal(mapped.controleSirenSiret.siren.statut, cas.statut_siren, libelle);
    assert.equal(mapped.controleSirenSiret.siret.statut, cas.statut_siret, libelle);
    assert.deepEqual(
      mapped.warnings.filter((w) => w.startsWith("st_siren: ") || w.startsWith("st_siret: ")),
      cas.messages.map((m) => CHAMPS_CONTRAT[m.champ] + ": " + m.message),
      libelle
    );
    // Jamais bloquant, jamais dans `values`.
    assert.deepEqual(mapped.errors, [], libelle);
    assert.equal(mapped.ok, true, libelle);
    assert.deepEqual(Object.keys(mapped.values).sort(), clesMappees, libelle);
  }
});

test("siren/siret : le verdict traverse extractContractValues jusqu'à la réponse (#194)", async () => {
  const env = { DOCIE_EXTRACTION_ENABLED: "true" };
  const extractDocument = async () => ({
    schema_name: "contract",
    result: Object.assign({}, NOMINAL_RESULT, { st_siren: "941091317" }),
    metadata: { request_id: "req-194", validation: null },
  });
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  const result = await extractContractValues(body, { env, extractDocument });
  assert.equal(result.values.stSiren, "941091317");
  assert.equal(result.controleSirenSiret.siren.statut, "cle_invalide");
  assert.equal(result.controleSirenSiret.siret.statut, "valide");
  assert.ok(result.warnings[0].startsWith("st_siren: SIREN « 941091317 » : clé de contrôle invalide"));
});
