"use strict";
/**
 * Synonymes de competences partages — #177 lignes G et H.
 *
 * Jumeau de cv-parser/tests/test_competences_synonymes.py : les deux services
 * lisent a l'execution document-parsing/fixtures/competences_synonymes.json et
 * rejouent ici ses cas. Dans UNE categorie, « Kubernetes » / « k8s » et
 * « Modélisation » / « Modelisation » donnaient une competence dans le dossier
 * one-page et deux dans la CVtheque.
 *
 * Ce que one-pager fixe : la meme fiche que cv-parser sur chaque cas (nom
 * compris), la table fusionnee dans TECHNOLOGIES et nulle part recopiee, et les
 * ecarts connus (familles de la taxonomie) epingles.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { mapperAdbiResume } = require("../lib/docie-extract");
const taxo = require("../lib/taxonomy");

const DEPOT = path.join(__dirname, "..", "..");
const JEU = JSON.parse(
  fs.readFileSync(path.join(DEPOT, "document-parsing", "fixtures", "competences_synonymes.json"), "utf8")
);

const groupes = (skills) => mapperAdbiResume({ skills }, {}, { filename: "cv.pdf" }).skills.map((g) => [g.label, g.items]);

test("chaque cas partage : la meme fiche que cv-parser, nom stocke compris", () => {
  assert.ok(JEU.cas.length >= 12);
  for (const cas of JEU.cas) {
    assert.ok(cas.preuve, cas.id);
    assert.deepEqual(groupes(cas.skills), cas.attendu, cas.id);
  }
});

test("ecarts connus (familles de la taxonomie) : epingles cote one-pager", () => {
  for (const cas of JEU.ecarts_connus.cas) {
    assert.ok(cas.preuve, cas.id);
    assert.deepEqual(groupes(cas.skills), cas.one_pager, cas.id);
    assert.notDeepEqual(cas.one_pager, cas.cv_parser, cas.id);
  }
});

test("chaque cle de la table est resolue vers son nom par la taxonomie", () => {
  for (const [nom, variantes] of Object.entries(JEU.synonymes)) {
    for (const cle of [nom, ...variantes]) {
      for (const forme of [cle, cle.toUpperCase(), `  ${cle} `]) {
        const hit = taxo.lookup(forme);
        assert.ok(hit, `« ${forme} » inconnu`);
        assert.equal(hit.name, nom, `« ${forme} »`);
      }
    }
  }
});

test("une seule source : aucune variante partagee n'est recopiee dans TECHNOLOGIES", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "taxonomy.js"), "utf8");
  const litteral = source.slice(source.indexOf("const TECHNOLOGIES = {"), source.indexOf("\n};", source.indexOf("const TECHNOLOGIES = {")));
  assert.ok(litteral.length > 1000);
  for (const variantes of Object.values(JEU.synonymes)) {
    for (const v of variantes) assert.ok(!litteral.includes(`"${v}"`), `« ${v} » recopie dans taxonomy.js`);
  }
});

test("un nom de la table inconnu de la taxonomie fait echouer le chargement", () => {
  assert.throws(() => taxo.fusionnerSynonymes({ Docker: { aliases: [] } }, { Inconnu: ["x"] }), /Inconnu/);
  const t = { Kubernetes: { aliases: ["kubernetes"] } };
  taxo.fusionnerSynonymes(t, { Kubernetes: ["k8s", "kubernetes"] });
  assert.deepEqual(t.Kubernetes.aliases, ["kubernetes", "k8s"]);
});

test("le jumeau Python lit le meme fichier, et l'image Docker l'embarque", () => {
  const py = fs.readFileSync(path.join(DEPOT, "cv-parser", "tests", "test_competences_synonymes.py"), "utf8");
  assert.ok(py.includes('"competences_synonymes.json"') || py.includes("competences_synonymes.json\""));
  const dockerfile = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("document-parsing/fixtures/competences_synonymes.json"));
});
