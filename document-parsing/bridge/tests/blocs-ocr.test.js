"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
// Jeu d'essai partagé avec test_blocs_ocr.py, lu par les TESTS seulement.
const paquets = require("../../fixtures/paquets_blocs_ocr.json");
const { blocsDepuisPages, blocsDepuisLignes } = require("../blocs-ocr");
const { validerBlocsOcr, DOCIE_BLOCS_TEXTE_MAX } = require("../docie-bridge");

// La règle d'identifiant, recalculée ici : le jeu d'essai ne fige aucune
// empreinte, donc une divergence de portage casse un test au lieu de se figer.
function identifiantAttendu(page, index, texte) {
  return "b" + page + "_" + index + "_" + createHash("sha256").update(page + ":" + index + ":" + texte, "utf8").digest("hex").slice(0, 12);
}

const lignesDe = pages => pages.flatMap(p => p.lignes);

test("packing: shared fixture, each expected block and each refusal", () => {
  for (const c of paquets.cas) {
    const libelle = c.nom + " — " + c.preuve;
    if (c.erreur) {
      assert.throws(() => blocsDepuisPages(c.pages, { max: c.max }), error => error.code === "input", libelle);
      continue;
    }
    const { blocs, resume } = blocsDepuisPages(c.pages, { max: c.max });
    assert.equal(resume.groupees, c.groupees, libelle);
    if (c.blocs_attendus) {
      assert.deepEqual(blocs.map(b => ({ page: b.page, text: b.text })),
        c.blocs_attendus.map(b => ({ page: b.page, text: b.text })), libelle);
      for (const [rang, attendu] of c.blocs_attendus.entries()) {
        assert.equal(blocs[rang].id, identifiantAttendu(attendu.page, attendu.index, attendu.text), libelle);
      }
    }
    if (c.blocs_max_attendus != null) assert.ok(blocs.length <= c.blocs_max_attendus, libelle + " — " + blocs.length + " blocs");
    if (c.texte_concatene != null) {
      // L'ordre de lecture est conservé mot pour mot : regrouper ne réécrit rien.
      assert.equal(blocs.map(b => b.text).join("\n"), c.texte_concatene, libelle);
    }
    // Aucun bloc ne mélange deux pages, et chaque bloc est accepté par le
    // transport — ce module n'a pas le droit de produire ce que le pont refuse.
    for (const bloc of blocs) assert.equal(typeof bloc.page, "number", libelle);
    assert.doesNotThrow(() => validerBlocsOcr(blocs), libelle);
  }
});

test("packing: volume cases — grouping only kicks in past the cap, pages keep their own blocks", () => {
  for (const c of paquets.cas_volume) {
    const libelle = c.nom + " — " + c.preuve;
    const parPage = Math.ceil(c.lignes / c.pages);
    const pages = Array.from({ length: c.pages }, (_, p) => ({
      page: p + 1,
      lignes: Array.from({ length: p === c.pages - 1 ? c.lignes - parPage * (c.pages - 1) : parPage },
        (_, i) => "ligne " + (p * parPage + i) + " du document"),
    }));
    const { blocs, resume } = blocsDepuisPages(pages, { max: c.max });
    assert.equal(resume.lignes, c.lignes, libelle);
    assert.equal(resume.groupees, c.groupees, libelle);
    assert.ok(blocs.length <= c.max, libelle + " — " + blocs.length + " blocs pour un plafond de " + c.max);
    // Un bloc ne porte qu'une page, et les pages restent dans l'ordre.
    const pagesVues = blocs.map(b => b.page);
    assert.deepEqual(pagesVues, [...pagesVues].sort((a, b) => a - b), libelle);
    // Rien n'est perdu : toutes les lignes sont dans les blocs, dans l'ordre.
    assert.equal(blocs.map(b => b.text).join("\n"), lignesDe(pages).join("\n"), libelle);
  }
});

test("packing: no pagination — every block lands on the page the caller named", () => {
  const lignes = ["Alice Dupont", "Développeuse Python", "Paris"];
  const { blocs, resume } = blocsDepuisLignes(lignes);
  assert.deepEqual(blocs.map(b => b.text), lignes);
  assert.deepEqual([...new Set(blocs.map(b => b.page))], [1]);
  assert.equal(resume.groupees, false);
  // Un appelant qui sait sur quelle page il est peut le dire.
  const { blocs: page7 } = blocsDepuisLignes(lignes, { page: 7 });
  assert.deepEqual([...new Set(page7.map(b => b.page))], [7]);
  // Les identifiants suivent la page : deux pages ne peuvent pas se collisionner.
  assert.notEqual(blocs[0].id, page7[0].id);
});

test("packing: identifiers are deterministic, per page, and refuse an out-of-range cap", () => {
  const pages = [{ page: 1, lignes: ["a", "b"] }, { page: 2, lignes: ["a"] }];
  const premier = blocsDepuisPages(pages).blocs;
  const second = blocsDepuisPages(pages).blocs;
  // Le même document réimporté donne les mêmes ids : une preuve enregistrée
  // dans notre base reste rattachable après une réimportation.
  assert.deepEqual(premier.map(b => b.id), second.map(b => b.id));
  // Même texte, même index, page différente : id différent.
  assert.notEqual(premier[0].id, premier[2].id);
  for (const max of [0, -1, 1.5, DOCIE_BLOCS_TEXTE_MAX + 1, "800"]) {
    assert.throws(() => blocsDepuisPages(pages, { max }), error => error.code === "input", String(max));
  }
});

test("packing: a single line longer than DocIE's per-block cap is refused, never split", () => {
  // La découper inventerait une frontière que le document n'a pas ; le refus
  // vient du validateur du transport, pas d'une règle recopiée ici.
  const enorme = "x".repeat(20001);
  assert.throws(() => blocsDepuisLignes([enorme]), error => error.code === "input");
});
