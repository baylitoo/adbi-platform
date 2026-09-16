"use strict";
// Accord des deux portages du mapping `contract` (#179 section A).
//
// La paire partage déjà les règles de nombre, de date et de nom
// (nombre_docie.json, date_docie.json, nom_docie.json) — mais celles-ci ne
// couvrent que les AIDES. Rien ne comparait la COUCHE DE MAPPING elle-même :
// choix des champs, émission des avertissements, miroir des contrôles
// bloquants, place du contrôle SIREN/SIRET. C'est exactement là que #179 a
// mesuré de vraies divergences — A1 (le portage JS jetait les avertissements
// de validation de DocIE) et A2-A6 (règle de nombre) — donc une régression y
// est attestée, pas hypothétique.
//
// Les deux ports reçoivent CE QU'ILS REÇOIVENT EN PRODUCTION : l'enveloppe
// brute côté Python (son `_extract_scalar` lit `wrapper["value"]`), la même
// enveloppe passée par le VRAI pont côté JS (#179 A12 — asymétrie voulue, à ne
// surtout pas unifier).
//
// Mécanique reprise d'urssaf-mapping.test.js / siren-siret.test.js :
// sous-processus Python, sonde d'interpréteur séparée, et on ne saute QUE si
// l'interpréteur manque — un script Python cassé doit FAIRE ÉCHOUER ce test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { mapContractResult } = require("../lib/docie-contract-import");

const RACINE = path.join(__dirname, "..", "..");
const MAPPINGS = path.join(RACINE, "document-parsing", "mappings");
const FIXTURES = path.join(MAPPINGS, "fixtures");
const CHEMIN_ACCORD = path.join(RACINE, "document-parsing", "fixtures", "accord_contract.json");
const ACCORD = require(CHEMIN_ACCORD);
const pont = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));

// Règle de surcharge, appliquée à L'IDENTIQUE par les deux ports (voir
// `_surcharge` dans la fixture) : fusion de surface sur `result`, remplacement
// entier de `validation`. Rien d'autre.
function enveloppeDuCas(cas) {
  const enveloppe = JSON.parse(fs.readFileSync(path.join(FIXTURES, cas.base), "utf8"));
  const surcharge = cas.surcharge || {};
  for (const [cle, valeur] of Object.entries(surcharge.result || {})) enveloppe.result[cle] = valeur;
  if (surcharge.validation !== undefined) enveloppe.validation = surcharge.validation;
  return enveloppe;
}

function coteJs(cas) {
  const enveloppe = enveloppeDuCas(cas);
  const { result, metadata } = pont.parseTextResponse(enveloppe, enveloppe.schema_name || "contract");
  const mappe = mapContractResult(result, { validation: metadata.validation });
  return {
    values: mappe.values, warnings: mappe.warnings, errors: mappe.errors, ok: mappe.ok,
    controle: Object.fromEntries(Object.entries(mappe.controleSirenSiret || {}).map(([k, v]) => [k, v.statut])),
  };
}

// Le script Python rend le MÊME objet que coteJs, cas par cas, dans l'ordre de
// la fixture. Il écrit en UTF-8 explicite : sans cela, la console Windows
// mutilerait les accents et la comparaison échouerait pour une raison qui n'a
// rien à voir avec le mapping.
const SCRIPT_PY = [
  "import json, os, sys",
  "sys.path.insert(0, sys.argv[1])",
  "from contract_to_contrats import map_docie_contract_to_sous_traitance",
  "accord = json.load(open(sys.argv[3], encoding='utf-8'))",
  "sorties = []",
  "for cas in accord['cas']:",
  "    with open(os.path.join(sys.argv[2], cas['base']), encoding='utf-8') as fh:",
  "        enveloppe = json.load(fh)",
  "    surcharge = cas.get('surcharge') or {}",
  "    for cle, valeur in (surcharge.get('result') or {}).items():",
  "        enveloppe['result'][cle] = valeur",
  "    if 'validation' in surcharge:",
  "        enveloppe['validation'] = surcharge['validation']",
  "    m = map_docie_contract_to_sous_traitance(enveloppe)",
  "    sorties.append({'values': m.values, 'warnings': m.warnings, 'errors': m.errors, 'ok': m.ok,",
  "                    'controle': {k: v.get('statut') for k, v in (m.controle_siren_siret or {}).items()}})",
  "sys.stdout.buffer.write(json.dumps(sorties, ensure_ascii=False).encode('utf-8'))",
].join("\n");

let cachePython = null;
function sortiesPython(t) {
  if (cachePython) return cachePython;
  const interpreteur = process.platform === "win32" ? "python" : "python3";
  const sonde = spawnSync(interpreteur, ["-c", "pass"], { encoding: "utf-8" });
  if (sonde.error || sonde.status !== 0) {
    t.skip("Python indisponible : " + (sonde.error ? sonde.error.message : sonde.stderr));
    return null;
  }
  const python = spawnSync(interpreteur, ["-c", SCRIPT_PY, MAPPINGS, FIXTURES, CHEMIN_ACCORD], { encoding: "utf-8" });
  assert.equal(python.status, 0, "le mapping Python a échoué sur la fixture : " + python.stderr);
  cachePython = JSON.parse(python.stdout);
  assert.equal(cachePython.length, ACCORD.cas.length, "un cas de la fixture n'a pas été mappé côté Python");
  return cachePython;
}

const sansAccents = (texte) => String(texte === null || texte === undefined ? "" : texte)
  .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const champ = (avertissement) => String(avertissement).split(":")[0].trim().toLowerCase();

test("accord contract : les " + ACCORD.cas.length + " cas du jeu d'essai partagé (#179 section A)", (t) => {
  const python = sortiesPython(t);
  if (!python) return;
  ACCORD.cas.forEach((cas, index) => {
    const js = coteJs(cas);
    const py = python[index];
    const libelle = cas.nom + " — " + cas.preuve;
    // `values` : égalité STRICTE. Les deux ports alimentent le même
    // consommateur (POST /api/contracts/importer, colonnes de
    // fields.js::sousTraitance) : une différence serait un dossier différent
    // selon le service qui a importé le contrat.
    assert.deepEqual(js.values, py.values, libelle);
    assert.equal(js.ok, py.ok, libelle + " — ok");
    // Erreurs bloquantes : mêmes contrôles, écriture accentuée d'un seul côté.
    assert.deepEqual(js.errors.map(sansAccents), py.errors.map(sansAccents), libelle + " — errors");
    // Avertissements : même nombre, même ordre, mêmes champs. La PROSE est une
    // différence déclarée (voir le test suivant), le CHAMP ne l'est pas.
    assert.equal(js.warnings.length, py.warnings.length, libelle + " — nombre d'avertissements");
    assert.deepEqual(js.warnings.map(champ), py.warnings.map(champ), libelle + " — champs avertis");
    assert.deepEqual(js.controle, py.controle, libelle + " — contrôle SIREN/SIRET");
  });
});

test("accord contract : les différences de prose déclarées existent toujours (#179 A13)", (t) => {
  const python = sortiesPython(t);
  if (!python) return;
  const index = ACCORD.cas.findIndex((cas) => cas.nom === "cas_limites");
  assert.ok(index >= 0, "le cas limite a disparu de la fixture");
  const js = coteJs(ACCORD.cas[index]).warnings;
  const py = python[index].warnings;
  // Mesuré : 4 des 6 avertissements sont identiques mot pour mot — les
  // messages SIREN/SIRET, `extraction_notes` et `validation.warnings`. La
  // différence de prose ne concerne QUE les messages fabriqués par les
  // normaliseurs de date et de montant. L'affirmer plus largement serait faux,
  // et ce test échouerait si quelqu'un « corrigeait » la fixture en ce sens.
  const differents = js.filter((avertissement, i) => avertissement !== py[i]);
  assert.deepEqual(differents.map(champ), ["date_redaction", "tjm"],
    "les deux seules proses divergentes attendues sont celles de la date et du montant");
  const identiques = js.filter((avertissement, i) => avertissement === py[i]);
  assert.equal(identiques.length, js.length - 2, "les autres avertissements doivent rester identiques mot pour mot");
  // Et le champ, lui, reste commun même sur les deux messages divergents :
  // c'est ce qui rend la comparaison par champ légitime dans le test ci-dessus.
  for (const avertissement of differents) {
    assert.ok(py.some((autre) => champ(autre) === champ(avertissement)),
      "un message divergent a aussi changé de champ : la comparaison par champ ne tient plus");
  }
});

test("accord contract : la fixture décrit bien les deux portages réellement exécutés", () => {
  assert.equal(ACCORD._ports.length, 2);
  assert.ok(ACCORD.cas.length >= 4, "deux fixtures du dépôt plus au moins deux cas synthétiques");
  for (const cas of ACCORD.cas) {
    assert.ok(fs.existsSync(path.join(FIXTURES, cas.base)), "base introuvable : " + cas.base);
    assert.ok(cas.preuve && cas.preuve.length > 30, "chaque cas porte sa preuve : " + cas.nom);
  }
});
