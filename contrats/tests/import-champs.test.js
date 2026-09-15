"use strict";
// Tests de public/import-champs.js — champs du modal « Importer un contrat
// existant ». Aucun appel réseau : l'extraction passe par le vrai
// lib/docie-contract-import.js avec un fetchImpl mocké, comme
// tests/docie-contract-import.test.js. Aucune base : server.js n'est jamais
// require() (il exige DATABASE_URL).
//
// Le défaut corrigé : DocIE extrait 19 champs, le modal n'en recopiait que 7,
// et seuls ceux-là atteignaient le payload stocké. Les 12 autres — lus par
// applyContractRef (avenant), GET /api/contracts (stSiren -> fiche
// entreprise) et le PDF régénéré — étaient perdus.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CHAMPS = require("../public/import-champs");
const { sousTraitance } = require("../lib/fields");
const { MAPPED_FIELDS, extractContractValues } = require("../lib/docie-contract-import");

const RAW_FIXTURE = require(path.join(
  __dirname, "..", "..", "document-parsing", "mappings", "fixtures", "contract_extraction_sample.json"
));
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Formulaire simulé : { id: valeur } -> lire(id).
function formulaire(saisie) {
  return (id) => (id in saisie ? saisie[id] : "");
}

// Forme EXACTE des `values` que construisait validerImport avant ce
// changement (recopiée de public/app.js sur master) : un import saisi à la
// main sans toucher la nouvelle section doit la reproduire à l'identique.
function valeursAvant(type, lire) {
  const avenant = type === "avenant";
  return {
    stNom: avenant ? "" : lire("impSt").trim(),
    avPartie2Nom: avenant ? lire("impSt").trim() : "",
    clientFinal: lire("impClient").trim(),
    consultantNom: lire("impConsultant").trim(),
    tjm: lire("impTjm").trim(),
    dateDebut: lire("impDebut"),
    dateFin: lire("impFin"),
    numeroContrat: avenant ? "" : lire("impNumero").trim(),
    numeroAvenant: avenant ? lire("impNumAvenant").trim() : "",
    numeroContratInitial: avenant ? lire("impInitial").trim() : "",
    contratType: avenant ? "sous-traitance" : "",
  };
}

const SAISIE_MANUELLE = {
  impNumero: " 02-09-2026 ", impSt: "ADCONSI", impClient: "THALES", impConsultant: "Amine OUKLI",
  impTjm: "500", impDebut: "2026-09-01", impFin: "2027-02-28",
  impNumAvenant: "1", impInitial: "01-06-2026",
};

async function extraire() {
  const env = {
    DOCIE_EXTRACTION_ENABLED: "true",
    DOCIE_BASE_URL: "https://docie.example.test",
    DOCIE_API_KEY: "test-secret",
    DOCIE_AGENT_CONTRACT: "contract-agent-test",
  };
  const fetchImpl = async () => new Response(JSON.stringify({
    id: "chatcmpl-test",
    model: "contract-agent-test",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(RAW_FIXTURE.result) } }],
  }), { status: 200 });
  const body = { dataBase64: Buffer.from("%PDF-1.4 fake").toString("base64"), mimeType: "application/pdf" };
  return extractContractValues(body, { env, fetchImpl });
}

// Ce que ferait le navigateur : pré-remplissage des inputs depuis la réponse
// de /extraire, puis lecture du formulaire par validerImport.
function saisieDepuisExtraction(values) {
  const saisie = {};
  for (const [id, valeur] of CHAMPS.preremplissage(values)) saisie[id] = valeur;
  return saisie;
}

test("garde-fou anti-dérive : les 12 champs reprennent libellé, type, groupe, placeholder et défaut de fields.js::sousTraitance", () => {
  const parCle = new Map(sousTraitance.map((f) => [f.key, f]));
  assert.equal(CHAMPS.CHAMPS_AUTRES.length, 12);
  for (const c of CHAMPS.CHAMPS_AUTRES) {
    const f = parCle.get(c.key);
    assert.ok(f, c.key + " n'existe pas dans fields.js::sousTraitance");
    assert.equal(c.label, f.label, c.key + " : libellé");
    assert.equal(c.group, f.group, c.key + " : groupe");
    assert.equal(c.type || "text", f.type || "text", c.key + " : type");
    assert.equal(!!c.textarea, !!f.textarea, c.key + " : textarea");
    assert.equal(!!c.full, !!f.full, c.key + " : pleine largeur");
    assert.equal(c.placeholder, f.placeholder, c.key + " : placeholder");
    assert.equal(c.defaut || "", f.default || "", c.key + " : défaut");
  }
});

test("garde-fou anti-dérive : 7 principaux + 12 autres == exactement les 19 clés de MAPPED_FIELDS", () => {
  const mappees = Object.values(MAPPED_FIELDS).map(([k]) => k).sort();
  const modal = [...CHAMPS.CHAMPS_PRINCIPAUX.map(([k]) => k), ...CHAMPS.CHAMPS_AUTRES.map((c) => c.key)].sort();
  assert.equal(mappees.length, 19);
  assert.deepEqual(modal, mappees);
  const ids = [...CHAMPS.CHAMPS_PRINCIPAUX.map(([, id]) => id), ...CHAMPS.CHAMPS_AUTRES.map((c) => c.id)];
  assert.equal(new Set(ids).size, ids.length, "ids d'inputs en double");
});

test("index.html : section, liste d'avertissements, ids principaux présents ; import-champs.js chargé AVANT app.js", () => {
  for (const id of ["impAutres", "impAutresGrille", "impAvertissements"]) {
    assert.ok(INDEX_HTML.includes('id="' + id + '"'), id + " absent de index.html");
  }
  for (const [, id] of CHAMPS.CHAMPS_PRINCIPAUX) {
    assert.ok(INDEX_HTML.includes('id="' + id + '"'), id + " absent de index.html");
  }
  // Les 12 sont générés par app.js : aucun id statique concurrent.
  for (const c of CHAMPS.CHAMPS_AUTRES) {
    assert.ok(!INDEX_HTML.includes('id="' + c.id + '"'), c.id + " ne doit pas être dupliqué en statique");
  }
  const iChamps = INDEX_HTML.indexOf('<script src="/import-champs.js">');
  const iApp = INDEX_HTML.indexOf('<script src="/app.js">');
  assert.ok(iChamps !== -1 && iChamps < iApp);
  // Plus aucune troncature des avertissements dans le pré-remplissage.
  assert.ok(!/warnings \|\| \[\]\)\.slice\(0, 3\)/.test(APP_JS));
});

test("garde-fou anti-dérive : messages SIREN/SIRET identiques à public/kbis-champs.js, statuts de lib/siren-siret.js ; marque .invalid stylée dans le modal", () => {
  const K = require("../public/kbis-champs");
  const { STATUTS } = require("../lib/siren-siret");
  assert.deepEqual(CHAMPS.MESSAGES_STATUT, K.MESSAGES_STATUT);
  assert.equal(CHAMPS.MESSAGE_STATUT_INCONNU, K.MESSAGE_STATUT_INCONNU);
  for (const s of Object.keys(CHAMPS.MESSAGES_STATUT)) assert.ok(STATUTS.includes(s), s);
  assert.deepEqual([...STATUTS].sort(), ["absent", "valide", ...Object.keys(CHAMPS.MESSAGES_STATUT)].sort(), "chaque statut non valide/absent a son message");
  assert.deepEqual(CHAMPS.IDS_SIREN_SIRET, ["impStSiren", "impStSiret"]);
  // La classe « invalid » n'était stylée que sous .field : sans cette règle,
  // la marque posée par app.js::marquerChampImport ne se verrait pas.
  const CSS = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const regle = CSS.split(/\r?\n/).find((l) => l.startsWith(".field input.invalid"));
  assert.ok(regle && regle.split("{")[0].split(",").includes(".import-grille input.invalid"), regle);
});

test("aVerifierSirenSiret : signalé SSI statut ni valide ni absent ; drapeau absent -> [] ; statut inconnu -> signalé", () => {
  const c = (s1, s2) => ({ siren: { valeur: "x", chiffres: null, statut: s1 }, siret: { valeur: "y", chiffres: null, statut: s2 } });
  for (const d of [undefined, null, "valide", 0]) assert.deepEqual(CHAMPS.aVerifierSirenSiret(d), []);
  assert.deepEqual(CHAMPS.aVerifierSirenSiret(c("valide", "absent")), []);
  assert.deepEqual(CHAMPS.aVerifierSirenSiret(c("cle_invalide", "valide")), [
    { key: "stSiren", id: "impStSiren", libelle: "SIREN", statut: "cle_invalide", message: "clé de contrôle invalide — vérifier sur le document" },
  ]);
  const deux = CHAMPS.aVerifierSirenSiret(c("discordant", "discordant"));
  assert.deepEqual(deux.map((a) => [a.id, a.message]), [["impStSiren", CHAMPS.MESSAGES_STATUT.discordant], ["impStSiret", CHAMPS.MESSAGES_STATUT.discordant]]);
  assert.equal(CHAMPS.resumeSirenSiret(deux), "SIREN : " + CHAMPS.MESSAGES_STATUT.discordant + " ; SIRET : " + CHAMPS.MESSAGES_STATUT.discordant);
  assert.deepEqual(CHAMPS.aVerifierSirenSiret(c("absent", "format_invalide")).map((a) => a.id), ["impStSiret"]);
  // Échec fermé : statut futur, statut non textuel, entrée manquante.
  assert.deepEqual(CHAMPS.aVerifierSirenSiret({ siren: { statut: "statut_futur" }, siret: { statut: 3 } }).map((a) => [a.statut, a.message]),
    [["statut_futur", CHAMPS.MESSAGE_STATUT_INCONNU], [null, CHAMPS.MESSAGE_STATUT_INCONNU]]);
  assert.equal(CHAMPS.aVerifierSirenSiret({ siren: { statut: "valide" } }).length, 1);
  assert.equal(CHAMPS.resumeSirenSiret([]), "");
});

test("import manuel sans toucher la section : payload identique à avant, pour chaque type", () => {
  for (const type of ["sous-traitance", "cds", "cdi", "cdd", "avenant"]) {
    const lire = formulaire(SAISIE_MANUELLE);
    assert.deepEqual(CHAMPS.valeursImport(type, lire), valeursAvant(type, lire), type);
  }
});

test("champ vide ou blanc : clé ABSENTE (jamais \"\"), pour ne pas écraser le défaut de fields.js", () => {
  const values = CHAMPS.valeursImport("sous-traitance", formulaire(Object.assign({}, SAISIE_MANUELLE, {
    impDelaiPaiement: "", impLieuRedaction: "   ", impStSiren: "941091316",
  })));
  assert.ok(!("delaiPaiement" in values));
  assert.ok(!("lieuRedaction" in values));
  assert.equal(values.stSiren, "941091316");
  // Pourquoi c'est important : server.js::resolveBody et app.js::loadType font
  // Object.assign(défauts, values). Mesuré ici avec les vrais défauts.
  const defauts = {};
  sousTraitance.forEach((f) => { defauts[f.key] = f.default || ""; });
  assert.equal(Object.assign({}, defauts, values).delaiPaiement, "45");
  assert.equal(Object.assign({}, defauts, values).lieuRedaction, "Paris");
  assert.equal(Object.assign({}, defauts, { delaiPaiement: "" }).delaiPaiement, "", "un \"\" aurait effacé le défaut 45");
});

test("avenant : les 12 champs sont ignorés même remplis, avPartie2Nom inchangé", () => {
  const saisie = Object.assign({}, SAISIE_MANUELLE);
  for (const c of CHAMPS.CHAMPS_AUTRES) saisie[c.id] = "rempli";
  const values = CHAMPS.valeursImport("avenant", formulaire(saisie));
  for (const c of CHAMPS.CHAMPS_AUTRES) assert.ok(!(c.key in values), c.key + " ne doit pas partir pour un avenant");
  assert.equal(values.avPartie2Nom, "ADCONSI");
  assert.equal(values.stNom, "");
  assert.equal(CHAMPS.afficherAutresChamps("avenant"), false);
  assert.equal(CHAMPS.afficherAutresChamps("sous-traitance"), true);
});

test("preremplissage : non vides seulement, jamais d'écrasement d'une saisie par un champ absent", () => {
  const liste = CHAMPS.preremplissage({ numeroContrat: "X", stNom: "", dateRedaction: "2026-01-05", stQualite: null, stSiren: "  " });
  assert.deepEqual(liste, [["impNumero", "X"], ["impDateRedaction", "2026-01-05"]]);
  assert.equal(CHAMPS.nbAutresPreremplis({ dateRedaction: "2026-01-05", stSiren: "" }), 1);
  assert.deepEqual(CHAMPS.preremplissage(undefined), []);
  assert.equal(CHAMPS.placeholder(CHAMPS.CHAMPS_AUTRES.find((c) => c.key === "delaiPaiement")), "par défaut : 45");
});

test("bout en bout sans base : DocIE (mocké) -> /extraire -> pré-remplissage -> validerImport : les 19 valeurs arrivent dans `values`", async () => {
  const extraction = await extraire();
  assert.equal(extraction.ok, true);
  const values = CHAMPS.valeursImport("sous-traitance", formulaire(saisieDepuisExtraction(extraction.values)));
  for (const [k, v] of Object.entries(extraction.values)) {
    if (v) assert.equal(values[k], v, k);
  }
  // Exactement les clés lues par les consommateurs du payload stocké.
  assert.equal(values.dateRedaction, "2026-01-05");
  assert.equal(values.stRepresentant, "Monsieur Corentin CALVO");
  assert.equal(values.stQualite, "President");
  assert.equal(values.stSiren, "941091316");
  assert.equal(values.delaiPaiement, "45");
});

// applyContractRef et infosParent sont extraites TELLES QUELLES du vrai
// public/app.js et exécutées dans un bac à sable (vm) avec des bouchons pour
// ce qui touche au DOM : on teste le consommateur réel, pas une copie.
function extraireFonction(nom) {
  const debut = APP_JS.indexOf("function " + nom + "(");
  assert.ok(debut !== -1, nom + " introuvable dans app.js");
  // Fin de la fonction : première accolade fermante en début de ligne
  // (fins de ligne LF ou CRLF selon le poste qui a extrait le dépôt).
  const reste = APP_JS.slice(debut);
  const m = /\r?\n\}\r?\n/.exec(reste);
  assert.ok(m, "fin de " + nom + " introuvable dans app.js");
  return reste.slice(0, m.index + m[0].length);
}

function reprendreCommeAvenant(payload) {
  const ctx = {
    state: { values: {}, avenantParent: null },
    prochainNumeroAvenant: () => "1",
    buildForm: () => {},
    renderPreview: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(extraireFonction("infosParent") + "\n" + extraireFonction("applyContractRef") + "\napplyContractRef(payload);",
    Object.assign(ctx, { payload }));
  return ctx.state;
}

test("applyContractRef (code réel d'app.js) sur le payload importé : date du contrat initial, représentant et qualité renseignés", async () => {
  const extraction = await extraire();
  const saisie = saisieDepuisExtraction(extraction.values);
  // Payload tel que le stocke POST /api/contracts/importer.
  const apres = { type: "sous-traitance", values: CHAMPS.valeursImport("sous-traitance", formulaire(saisie)), importe: true };
  const etat = reprendreCommeAvenant(JSON.parse(JSON.stringify(apres)));
  assert.equal(etat.values.dateContratInitial, "2026-01-05");
  assert.equal(etat.values.avPartie2Repr, "Monsieur Corentin CALVO");
  assert.equal(etat.values.avPartie2Qualite, "President");
  assert.equal(etat.avenantParent.stRepresentant, "Monsieur Corentin CALVO");

  // Contraste : le payload qu'aurait stocké la version précédente (7 clés).
  const avant = { type: "sous-traitance", values: valeursAvant("sous-traitance", formulaire(saisie)), importe: true };
  const etatAvant = reprendreCommeAvenant(avant);
  assert.equal(etatAvant.values.dateContratInitial, undefined);
  assert.equal(etatAvant.values.avPartie2Repr, "");
  assert.equal(etatAvant.values.avPartie2Qualite, "");
});
