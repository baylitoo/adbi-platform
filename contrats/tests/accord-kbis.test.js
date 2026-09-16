"use strict";
// Accord des deux portages du mapping `kbis` — la DERNIÈRE paire sans exécution
// croisée entre les deux langages.
//
// Le Kbis est la pièce la plus exposée de la checklist : son verdict de nom
// déclenche le seul message BLOQUANT de l'écran (« ce n'est PAS le
// sous-traitant saisi »), et #179 ligne B1 y avait mesuré la divergence la plus
// coûteuse de tout l'inventaire — le portage Python jetait `companyName`,
// `issuedDate` et `nameMatches` sur la branche « illisible », c'est-à-dire
// exactement les trois valeurs que contrats/public/app.js lit.
//
// Chaque port reçoit ce qu'il reçoit en production : l'enveloppe brute côté
// Python, le résultat désenveloppé par le pont côté JS, plus `validation` à
// part (#179 A12 — asymétrie voulue, exercée et non unifiée).
//
// Mécanique reprise d'accord-contract.test.js : sous-processus Python, sonde
// d'interpréteur séparée, et on ne saute QUE si l'interpréteur manque — un
// script Python cassé doit FAIRE ÉCHOUER ce test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { mapKbisResult } = require("../lib/kbis-mapping");

const RACINE = path.join(__dirname, "..", "..");
const MAPPINGS = path.join(RACINE, "document-parsing", "mappings");
const FIXTURES = path.join(MAPPINGS, "fixtures");
const CHEMIN_ACCORD = path.join(RACINE, "document-parsing", "fixtures", "accord_kbis.json");
const ACCORD = require(CHEMIN_ACCORD);
const pont = require(path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js"));

const NOM_REFERENCE = "SUND INDUSTRY SYSTEM";

function coteJs(cas) {
  const enveloppe = JSON.parse(fs.readFileSync(path.join(FIXTURES, cas.fichier), "utf8"));
  const { result, metadata } = pont.parseTextResponse(enveloppe, enveloppe.schema_name || "kbis");
  // Nom attendu : celui du document, pour exercer réellement la comparaison.
  // Absent (fixture illisible) : le nom de référence, identique des deux côtés.
  const brut = result.company_name;
  const attendu = brut === undefined || brut === null ? NOM_REFERENCE : brut;
  const mappe = mapKbisResult(result, { expectedName: attendu, items: [{ id: "kbis" }], validation: metadata.validation });
  return { analysis: mappe.analysis, warnings: mappe.warnings };
}

// Rend le MÊME objet que coteJs, cas par cas, dans l'ordre de la fixture.
// UTF-8 explicite : sinon la console Windows mutilerait les accents et la
// comparaison échouerait pour une raison étrangère au mapping.
const SCRIPT_PY = [
  "import json, os, sys",
  "sys.path.insert(0, sys.argv[1])",
  "from kbis_to_contrats import map_docie_kbis_to_analysis",
  "accord = json.load(open(sys.argv[3], encoding='utf-8'))",
  "reference = sys.argv[4]",
  "sorties = []",
  "for cas in accord['cas']:",
  "    with open(os.path.join(sys.argv[2], cas['fichier']), encoding='utf-8') as fh:",
  "        enveloppe = json.load(fh)",
  "    brut = (enveloppe.get('result') or {}).get('company_name')",
  "    attendu = brut.get('value') if isinstance(brut, dict) else brut",
  "    m = map_docie_kbis_to_analysis(enveloppe, expected_name=attendu or reference, items=[{'id': 'kbis'}])",
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
  const python = spawnSync(interpreteur, ["-c", SCRIPT_PY, MAPPINGS, FIXTURES, CHEMIN_ACCORD, NOM_REFERENCE], { encoding: "utf-8" });
  assert.equal(python.status, 0, "le mapping Python a échoué sur la fixture : " + python.stderr);
  cachePython = JSON.parse(python.stdout);
  assert.equal(cachePython.length, ACCORD.cas.length, "un cas de la fixture n'a pas été mappé côté Python");
  return cachePython;
}

const champ = (avertissement) => String(avertissement).split(":")[0].trim().toLowerCase();

test("accord kbis : les " + ACCORD.cas.length + " cas du jeu d'essai partagé", (t) => {
  const python = sortiesPython(t);
  if (!python) return;
  ACCORD.cas.forEach((cas, index) => {
    const js = coteJs(cas);
    const py = python[index];
    const libelle = cas.fichier + " — " + cas.preuve;
    // `analysis` : égalité STRICTE, `controleSirenSiret` imbriqué compris. Les
    // deux ports répondent au même consommateur, POST /api/document/analyze.
    assert.deepEqual(js.analysis, py.analysis, libelle);
    assert.equal(js.warnings.length, py.warnings.length, libelle + " — nombre d'avertissements");
    assert.deepEqual(js.warnings.map(champ), py.warnings.map(champ), libelle + " — champs avertis");
    // Texte complet, SAUF le champ dont la prose est déclarée divergente.
    js.warnings.forEach((avertissement, rang) => {
      if (ACCORD.prose_divergente.includes(champ(avertissement))) return;
      assert.equal(avertissement, py.warnings[rang], libelle + " — prose de « " + champ(avertissement) + " »");
    });
  });
});

test("accord kbis : la seule prose divergente déclarée existe toujours (#179 A13)", (t) => {
  const python = sortiesPython(t);
  if (!python) return;
  const index = ACCORD.cas.findIndex((cas) => /edge/.test(cas.fichier));
  assert.ok(index >= 0, "le cas limite a disparu de la fixture");
  const js = coteJs(ACCORD.cas[index]).warnings;
  const py = python[index].warnings;
  const divergents = js.filter((avertissement, i) => avertissement !== py[i]).map(champ);
  // Mesuré : exactement un message diffère, celui de la devise. Si un portage
  // se met à reformuler un AUTRE message, ce test le signale ; si la
  // divergence déclarée disparaît, il le signale aussi — la fixture ne peut
  // pas vieillir en affirmant un écart que le code n'a plus.
  assert.deepEqual(divergents, ACCORD.prose_divergente);
  // Et le champ reste commun : c'est ce qui rend la comparaison par champ
  // légitime dans le test ci-dessus.
  for (const avertissement of js.filter((a, i) => a !== py[i])) {
    assert.ok(py.some((autre) => champ(autre) === champ(avertissement)),
      "le message divergent a aussi changé de champ : la comparaison par champ ne tient plus");
  }
});

// Ce que ce test garantit exactement : sur la branche « illisible », les DEUX
// portages EXPOSENT les trois clés que l'écran lit, et s'accordent dessus.
// MESURÉ : sur cette fixture elles valent `null`, `""` et `null` des deux
// côtés — le test ne prétend donc PAS qu'elles portent une valeur, il interdit
// qu'un portage les fasse disparaître ou en invente une que l'autre n'a pas.
// C'est précisément la régression de #179 B1, où le portage Python basculait
// dans une branche qui JETAIT `companyName`, `issuedDate` et `nameMatches`
// alors que le JS les conservait — et contrats/public/app.js::
// analyzeChecklistDoc ne lit QUE ces trois valeurs.
//
// Vérifié par mutation : supprimer l'une des trois clés, ou faire diverger
// l'une des trois valeurs, fait échouer ce test. (Les remplacer par `null` des
// deux côtés ne prouve rien — c'est déjà leur valeur ici.)
test("accord kbis : branche « illisible », les trois clés que l'écran lit sont exposées et concordantes (#179 B1)", (t) => {
  const python = sortiesPython(t);
  if (!python) return;
  const index = ACCORD.cas.findIndex((cas) => /unreadable/.test(cas.fichier));
  assert.ok(index >= 0, "le cas illisible a disparu de la fixture");
  const js = coteJs(ACCORD.cas[index]).analysis;
  const py = python[index].analysis;
  for (const cle of ["companyName", "issuedDate", "nameMatches"]) {
    assert.ok(Object.hasOwn(js, cle), "clé absente du portage JS : " + cle);
    assert.ok(Object.hasOwn(py, cle), "clé absente du portage Python : " + cle);
    assert.deepEqual(js[cle], py[cle], "branche illisible : " + cle);
  }
  // Le document reste marqué illisible des deux côtés : sans cela, « les trois
  // clés concordent » pourrait passer sur une analyse qui n'est plus la même.
  assert.equal(js.documentType, py.documentType);
  assert.equal(js.isValid, py.isValid);
});

test("accord kbis : la fixture décrit bien les deux portages réellement exécutés", () => {
  assert.equal(ACCORD._ports.length, 2);
  assert.equal(ACCORD.cas.length, 3, "nominal, cas limites, illisible");
  for (const cas of ACCORD.cas) {
    assert.ok(fs.existsSync(path.join(FIXTURES, cas.fichier)), "fixture introuvable : " + cas.fichier);
    assert.ok(cas.preuve && cas.preuve.length > 30, "chaque cas porte sa preuve : " + cas.fichier);
  }
  assert.ok(Array.isArray(ACCORD.prose_divergente) && ACCORD.prose_divergente.length === 1,
    "une seule prose divergente est déclarée, et elle est nommée");
});
