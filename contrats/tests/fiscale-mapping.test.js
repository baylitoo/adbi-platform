"use strict";
// Tests du schéma dynamique "fiscale" (attestation de régularité fiscale,
// #170 / #194) — pendant JS de document-parsing/mappings/test_fiscale_to_contrats.py.
//
// Conformité à DynamicSchemaSpec vérifiée HORS LIGNE, comme #209 l'a fait pour
// rib.schema.json : motif des noms ^[a-z][a-z0-9_]{0,63}$ (HTTP 422 sinon,
// mesuré dans register_and_test.py), types autorisés, sous-champs obligatoires
// pour object/list et interdits pour un scalaire, noms réservés.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const RACINE = path.join(__dirname, "..", "..");
const SCHEMA = require(path.join(RACINE, "document-parsing", "schemas", "fiscale.schema.json"));

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
    for (const champ of champs) {
      const libelle = chemin + champ.name;
      assert.deepEqual(Object.keys(champ), ["name", "type", "description", "fields"], libelle);
      assert.match(champ.name, NOM_RE, libelle);
      assert.ok(!RESERVES.has(champ.name), "nom réservé par DocIE : " + libelle);
      assert.ok(!noms.has(champ.name), "nom de champ dupliqué : " + libelle);
      noms.add(champ.name);
      assert.ok(TYPES.has(champ.type), libelle);
      if (champ.type === "object" || champ.type === "list") {
        assert.ok(champ.fields.length > 0, "un object/list DOIT déclarer des sous-champs : " + libelle);
        verifier(champ.fields, libelle + ".");
      } else {
        assert.deepEqual(champ.fields, [], "un scalaire ne déclare PAS de sous-champs : " + libelle);
      }
    }
  }
  verifier(SCHEMA.fields, "");
});

test("schéma fiscale : aucun champ inventé, aucun montant", () => {
  assert.deepEqual(
    Object.fromEntries(SCHEMA.fields.map((f) => [f.name, f.type])),
    CHAMPS_JUSTIFIES
  );
  // L'attestation n'imprime pas de montant : la ligne « money » de #170 ne
  // vaut pas pour cette pièce.
  assert.ok(!SCHEMA.fields.some((f) => f.type === "money"));
});
