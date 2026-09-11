"use strict";

/**
 * Tests de lib/normalize.js#languageLevel — la deduction du niveau CECRL.
 *
 * Cette fonction est le seul endroit ou le niveau de langue est normalise :
 * lib/extract.js (analyse de mise en page) et lib/docie-extract.js (reponse
 * DocIE) l'appellent tous les deux. Un libelle non reconnu ne degrade donc pas
 * une seule origine, il laisse la fiche sans niveau quelle que soit l'origine.
 *
 * Le cas « natif » est pris sur la reponse DocIE reelle enregistree dans le
 * depot (document-parsing/fixtures/cv_samples/results/simple_docie.json) :
 * aucun appel reseau ici non plus.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const N = require("../lib/normalize");

const DOCIE_SIMPLE = path.join(
  __dirname, "..", "..", "document-parsing", "fixtures", "cv_samples", "results", "simple_docie.json"
);

test("« natif » vaut C2, comme « langue maternelle » et « native »", () => {
  for (const libelle of ["natif", "native", "Natif", "langue maternelle", "bilingue", "C2"]) {
    assert.equal(N.languageLevel(libelle), "C2", libelle);
  }
});

test("le niveau annonce par DocIE sur le CV d'exemple du depot est reconnu", () => {
  // La reponse est enregistree avec ses enveloppes {value, confidence,
  // evidence_ids} : on lit la feuille comme le bridge la deballe.
  const reponse = JSON.parse(fs.readFileSync(DOCIE_SIMPLE, "utf8"));
  const langues = reponse.result.languages.map((l) => ({
    langue: l.language.value ?? l.language,
    niveau: l.level.value ?? l.level,
  }));

  assert.deepEqual(langues.map((l) => l.niveau), ["natif", "courant"]);
  assert.deepEqual(langues.map((l) => N.languageLevel(l.niveau)), ["C2", "C1"]);
});

test("les niveaux inferieurs et les scores de test restent inchanges", () => {
  assert.equal(N.languageLevel("courant"), "C1");
  assert.equal(N.languageLevel("professionnel"), "B2");
  assert.equal(N.languageLevel("intermediaire"), "B1");
  assert.equal(N.languageLevel("scolaire"), "A2");
  assert.equal(N.languageLevel("notions"), "A1");
  // Le bareme du test ne doit pas deprecier un libelle plus favorable.
  assert.equal(N.languageLevel("courant - TOEIC 880"), "C1");
  assert.equal(N.languageLevel(""), null);
});

test("« nativement » n'est pas un niveau de langue", () => {
  // Le motif est ancre sur des frontieres de mot : un adverbe qui commence par
  // les memes lettres ne doit pas faire passer une langue en C2.
  assert.equal(N.languageLevel("parle nativement le klingon"), null);
});
