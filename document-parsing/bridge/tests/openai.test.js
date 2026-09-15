"use strict";
// Transport OpenAI (#194) : aucun appel réseau, fetchImpl simulé.
// Lancement : node --test document-parsing/bridge/tests/openai.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const oa = require("../openai-responses");

const DOSSIER_SCHEMAS = path.join(__dirname, "..", "..", "schemas");
const SCHEMAS = fs.readdirSync(DOSSIER_SCHEMAS).filter((f) => f.endsWith(".schema.json")).sort()
  .map((f) => [f, JSON.parse(fs.readFileSync(path.join(DOSSIER_SCHEMAS, f), "utf8"))]);

// Vérifie récursivement les règles strictes de Structured Outputs sur un nœud converti.
function verifierStrict(noeud, chemin) {
  if (noeud.type === "object") {
    assert.equal(noeud.additionalProperties, false, chemin);
    assert.deepEqual([...noeud.required].sort(), Object.keys(noeud.properties).sort(), chemin);
    for (const [cle, sous] of Object.entries(noeud.properties)) verifierStrict(sous, chemin + "." + cle);
  } else if (noeud.type === "array") {
    verifierStrict(noeud.items, chemin + "[]");
  } else if (Array.isArray(noeud.type)) {
    assert.deepEqual(noeud.type, ["string", "null"], chemin);
  } else {
    assert.equal(noeud.type, "string", chemin);
  }
}

// Même structure que le schéma DocIE : chaque champ, à chaque niveau, avec la forme attendue.
function verifierCorrespondance(champs, noeud, chemin) {
  assert.deepEqual(Object.keys(noeud.properties), champs.map((c) => c.name), chemin);
  for (const champ of champs) {
    const sous = noeud.properties[champ.name];
    const ici = chemin + "." + champ.name;
    if (["string", "date", "number"].includes(champ.type)) assert.deepEqual(sous.type, ["string", "null"], ici);
    if (champ.type === "date") assert.ok(sous.description.includes("AAAA-MM-JJ"), ici);
    if (champ.type === "money") assert.deepEqual(Object.keys(sous.properties), ["amount", "currency"], ici);
    if (champ.type === "object") verifierCorrespondance(champ.fields, sous, ici);
    if (champ.type === "list") {
      assert.equal(sous.type, "array", ici);
      if (champ.fields.length) verifierCorrespondance(champ.fields, sous.items, ici + "[]");
      else assert.deepEqual(sous.items, { type: "string" }, ici);
    }
    assert.ok(!("format" in sous), ici + " : pas de `format` non confirmé");
  }
}

test("conversion : chaque schéma de document-parsing/schemas (CV compris) donne un JSON Schema strict fidèle", () => {
  assert.deepEqual(SCHEMAS.map(([f]) => f),
    ["adbi_resume.schema.json", "contract.schema.json", "rib.schema.json", "urssaf.schema.json"]);
  for (const [fichier, dynamique] of SCHEMAS) {
    const { name, schema } = oa.schemaOpenAI(dynamique);
    assert.equal(name, "adbi_" + dynamique.document_type, fichier);
    assert.equal(schema.type, "object", fichier);
    verifierStrict(schema, fichier);
    verifierCorrespondance(dynamique.fields, schema, fichier);
  }
});

test("conversion : money -> {amount, currency} nullables, date sans motif, list imbriquée, description conservée", () => {
  const contrat = oa.schemaOpenAI(Object.fromEntries(SCHEMAS)["contract.schema.json"]).schema;
  assert.deepEqual(contrat.properties.tjm, {
    type: "object",
    description: "TJM en euros HT / jour",
    properties: {
      amount: { type: ["string", "null"], description: oa.CONSIGNE_MONTANT },
      currency: { type: ["string", "null"], description: oa.CONSIGNE_DEVISE },
    },
    required: ["amount", "currency"],
    additionalProperties: false,
  });
  assert.deepEqual(contrat.properties.date_debut, { type: ["string", "null"], description: oa.CONSIGNE_DATE });
  assert.ok(!("pattern" in contrat.properties.date_debut));
  assert.deepEqual(contrat.properties.delai_paiement, { type: ["string", "null"], description: "Delai de paiement en jours — " + oa.CONSIGNE_NOMBRE });
  assert.deepEqual(contrat.properties.numero_contrat, { type: ["string", "null"] });
  const cv = oa.schemaOpenAI(Object.fromEntries(SCHEMAS)["adbi_resume.schema.json"]).schema;
  assert.deepEqual(cv.properties.skills.items.properties.items.items.properties.item, { type: ["string", "null"] });
  assert.deepEqual(oa.schemaOpenAI({ document_type: "x", fields: [{ name: "tags", type: "list", fields: [] }] }).schema.properties.tags.items, { type: "string" });
});

test("conversion : schéma invalide refusé (type inconnu, nom invalide, doublon, objet vide, document_type)", () => {
  const cas = [
    null, {}, { document_type: "Contrat!", fields: [{ name: "a", type: "string" }] },
    { document_type: "x", fields: [] },
    { document_type: "x", fields: [{ name: "a", type: "boolean" }] },
    { document_type: "x", fields: [{ name: "a b", type: "string" }] },
    { document_type: "x", fields: [{ name: "a", type: "string" }, { name: "a", type: "date" }] },
    { document_type: "x", fields: [{ name: "o", type: "object", fields: [] }] },
  ];
  for (const c of cas) assert.throws(() => oa.schemaOpenAI(c), oa.ErreurSchema, JSON.stringify(c));
});
