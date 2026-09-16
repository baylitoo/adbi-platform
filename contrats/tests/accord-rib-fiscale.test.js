"use strict";
// Accord des deux portages des mappings `rib` et `fiscale`.
//
// Avant ce fichier, seules cinq choses avaient une exécution croisée réelle
// entre les deux langages : urssaf, siren-siret, iban-bic, le catalogue, puis
// `contract` (accord-contract.test.js). `rib` et `fiscale` n'en avaient
// aucune. Leurs fixtures partagées (date, nombre, nom) ne couvrent que les
// AIDES : rien ne comparait la couche de mapping elle-même — choix des champs,
// avertissements, place des verdicts de contrôle.
//
// `fiscale` est la plus exposée : c'est le mapping le plus RÉCENT (arrivé avec
// #215), donc le moins exercé.
//
// Chaque port reçoit ce qu'il reçoit en production : l'enveloppe brute côté
// Python (il vérifie lui-même `schema_name` et lit `wrapper["value"]`), le
// résultat déjà désenveloppé par le pont côté JS, plus `validation` à part.
// Asymétrie voulue — voir #179 ligne A12.
//
// Mécanique reprise d'urssaf-mapping.test.js et d'accord-contract.test.js :
// sous-processus Python, sonde d'interpréteur séparée, et on ne saute QUE si
// l'interpréteur manque — un script Python cassé doit FAIRE ÉCHOUER ce test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { mapRibResult } = require("../lib/rib-mapping");
const { mapFiscaleResult } = require("../lib/fiscale-mapping");

const RACINE = path.join(__dirname, "..", "..");
const MAPPINGS = path.join(RACINE, "document-parsing", "mappings");
const FIXTURES = path.join(MAPPINGS, "fixtures");
const CHEMIN_ACCORD = path.join(RACINE, "document-parsing", "fixtures", "accord_rib_fiscale.json");
const ACCORD = require(CHEMIN_ACCORD);
const pont = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));

// Le mapping fiscale contrôle « date dans le futur » : sa sortie dépend du
// JOUR, et les deux ports retombent sur la date LOCALE quand on ne la leur
// donne pas. Sans ce figeage, ce test comparerait deux horloges et deviendrait
// instable à la première exécution un autre jour.
const JOUR = ACCORD.jour_fige;

function coteJs(cas) {
  const enveloppe = JSON.parse(fs.readFileSync(path.join(FIXTURES, cas.fichier), "utf8"));
  const { result, metadata } = pont.parseTextResponse(enveloppe, enveloppe.schema_name);
  // Le nom attendu est celui que porte le document lui-même, pour que la
  // comparaison de nom soit réellement exercée. La fixture « illisible » n'en
  // porte aucun : on passe alors null, et « question non posée » doit être la
  // réponse des deux côtés (voir nom_docie.json).
  const brut = result[cas.cle_nom];
  const attendu = brut === undefined || brut === null ? null : brut;
  const options = { expectedName: attendu, items: [{ id: cas.piece }], validation: metadata.validation };
  const mappe = cas.piece === "rib"
    ? mapRibResult(result, options)
    : mapFiscaleResult(result, Object.assign({ aujourdhui: JOUR }, options));
  return { analysis: mappe.analysis, warnings: mappe.warnings };
}

// Rend le MÊME objet que coteJs, cas par cas, dans l'ordre de la fixture.
// Écrit en UTF-8 explicite : sinon la console Windows mutilerait les accents et
// la comparaison échouerait pour une raison étrangère au mapping.
const SCRIPT_PY = [
  "import json, os, sys",
  "sys.path.insert(0, sys.argv[1])",
  "from rib_to_contrats import map_docie_rib_to_analysis",
  "from fiscale_to_contrats import map_docie_fiscale_to_analysis",
  "accord = json.load(open(sys.argv[3], encoding='utf-8'))",
  "jour = accord['jour_fige']",
  "sorties = []",
  "for cas in accord['cas']:",
  "    with open(os.path.join(sys.argv[2], cas['fichier']), encoding='utf-8') as fh:",
  "        enveloppe = json.load(fh)",
  "    brut = (enveloppe.get('result') or {}).get(cas['cle_nom'])",
  "    attendu = brut.get('value') if isinstance(brut, dict) else brut",
  "    items = [{'id': cas['piece']}]",
  "    if cas['piece'] == 'rib':",
  "        m = map_docie_rib_to_analysis(enveloppe, expected_name=attendu, items=items)",
  "    else:",
  "        m = map_docie_fiscale_to_analysis(enveloppe, expected_name=attendu, items=items, aujourdhui=jour)",
  "    sorties.append({'analysis': m.analysis, 'warnings': m.warnings})",
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
  assert.equal(python.status, 0, "un mapping Python a échoué sur la fixture : " + python.stderr);
  cachePython = JSON.parse(python.stdout);
  assert.equal(cachePython.length, ACCORD.cas.length, "un cas de la fixture n'a pas été mappé côté Python");
  return cachePython;
}

test("accord rib/fiscale : les " + ACCORD.cas.length + " cas du jeu d'essai partagé", (t) => {
  const python = sortiesPython(t);
  if (!python) return;
  ACCORD.cas.forEach((cas, index) => {
    const js = coteJs(cas);
    const py = python[index];
    const libelle = cas.piece + " / " + cas.fichier + " — " + cas.preuve;
    // `analysis` : égalité STRICTE, verdicts imbriqués compris
    // (controleIbanBic pour le RIB, controleSirenSiret et controleDates pour
    // la fiscale). Les deux ports produisent la même réponse pour le même
    // consommateur : POST /api/document/analyze.
    assert.deepEqual(js.analysis, py.analysis, libelle);
    // Avertissements : texte complet compris. MESURÉ : ils sont identiques mot
    // pour mot sur ces six fixtures, contrairement à la paire `contract`, où
    // deux messages diffèrent par leur prose (accord_contract.json). Déclarer
    // ici une différence « par symétrie » inscrirait une contre-vérité.
    assert.deepEqual(js.warnings, py.warnings, libelle + " — avertissements");
  });
});

test("accord rib/fiscale : le jour est figé, sinon le contrôle de date compare deux horloges", () => {
  assert.match(JOUR, /^\d{4}-\d{2}-\d{2}$/, "jour_fige doit être une date AAAA-MM-JJ");
  // Le figeage doit atteindre les DEUX ports : côté JS par l'argument
  // `aujourdhui` ci-dessus, côté Python par le même champ lu dans la fixture.
  assert.ok(SCRIPT_PY.includes("aujourdhui=jour"), "le script Python n'utilise plus le jour figé");
  assert.ok(ACCORD._aujourdhui && ACCORD._aujourdhui.length > 30, "la fixture doit expliquer pourquoi le jour est figé");
});

test("accord rib/fiscale : la fixture décrit bien les deux paires réellement exécutées", () => {
  assert.equal(ACCORD._ports.length, 2);
  const pieces = new Set(ACCORD.cas.map((cas) => cas.piece));
  assert.deepEqual([...pieces].sort(), ["fiscale", "rib"]);
  for (const cas of ACCORD.cas) {
    assert.ok(fs.existsSync(path.join(FIXTURES, cas.fichier)), "fixture introuvable : " + cas.fichier);
    assert.ok(cas.preuve && cas.preuve.length > 30, "chaque cas porte sa preuve : " + cas.fichier);
    assert.ok(cas.cle_nom, "chaque cas nomme le champ qui porte le nom attendu : " + cas.fichier);
  }
});
