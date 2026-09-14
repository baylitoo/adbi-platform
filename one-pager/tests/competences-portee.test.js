"use strict";
/**
 * Portee du dedoublonnage des competences — #177 ligne 13.
 *
 * Jumeau de cv-parser/tests/test_competences_portee.py : les deux services
 * rejouent le meme jeu d'essai, document-parsing/fixtures/competences_portee.json.
 * cv-parser dedoublonnait a travers toutes les categories, one-pager dans le
 * groupe seulement ; le jeu d'essai fixe la regle (dans le groupe, jamais a
 * travers), donc une divergence de portee redevient un echec de test des deux
 * cotes.
 *
 * Seule la PORTEE est comparee, pas la cle : one-pager canonicalise par sa
 * taxonomie et desaccentue, cv-parser ne compare que la casse. Chaque terme du
 * jeu d'essai doit donc etre laisse intact par la taxonomie, a la casse pres —
 * verifie ici avant toute comparaison, sinon le cas mesurerait la
 * canonicalisation au lieu de la portee.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { mapperAdbiResume } = require("../lib/docie-extract");
const taxo = require("../lib/taxonomy");

const JEU = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "document-parsing", "fixtures", "competences_portee.json"),
    "utf8"
  )
);

const minuscules = (groupes) => groupes.map(([libelle, items]) => [libelle.toLowerCase(), items.map((i) => i.toLowerCase())]);

test("le jeu d'essai partage n'utilise que des termes neutres pour la taxonomie", () => {
  for (const cas of JEU.cas) {
    for (const groupe of cas.skills) {
      for (const { item } of groupe.items) {
        assert.equal(taxo.canonical(item).toLowerCase(), item.toLowerCase(), `${cas.id} : « ${item} »`);
      }
    }
  }
});

test("dedoublonnage des competences : dans le groupe, jamais a travers (jeu d'essai partage)", () => {
  assert.ok(JEU.cas.length >= 6);
  for (const cas of JEU.cas) {
    const master = mapperAdbiResume({ skills: cas.skills }, {}, { filename: "cv.pdf" });
    assert.deepEqual(
      minuscules(master.skills.map((g) => [g.label, g.items])),
      minuscules(cas.attendu),
      cas.id
    );
  }
});
