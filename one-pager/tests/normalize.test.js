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

/**
 * « Mission en cours » sur la voie d'extraction par mise en page.
 *
 * lib/normalize.js portait un TROISIEME exemplaire independant de la liste des
 * synonymes de « en cours », apres cv-parser/periode_mission.py et
 * lib/docie-extract.js (#177, lignes 4 a 6). Il lui manquait « actuel », donc
 * une mission ouverte etait lue comme terminee sur cette voie — la seule que
 * personne n'avait mesuree.
 *
 * Deux roles distincts cohabitent dans parsePeriod, et c'est la subtilite :
 *   - EN_COURS CLASSE (« cette borne signifie-t-elle en cours ? ») et derive
 *     desormais directement du jeu d'essai partage ;
 *   - END/jusquAujourdhui TOKENISENT (« qu'est-ce qui peut tenir lieu de borne
 *     de fin ? ») et gardent leur propre liste, car « depuis » ouvre une periode
 *     au lieu de la fermer. Mais EN_COURS ne voit que ce que END a laisse
 *     passer : un synonyme absent de END est mort. D'ou le test de couverture.
 */
const MISSION = require("../../document-parsing/fixtures/mission_en_cours.json");

test("le motif « en cours » est exactement celui du jeu d'essai partage", () => {
  // Egalite stricte : ajouter un synonyme dans docie-extract.js ou
  // periode_mission.py sans toucher au jeu d'essai casse ce test, et
  // reciproquement. C'est ce qui empeche la liste de rediverger une 3e fois.
  assert.equal(N.MOTIF_MISSION_EN_COURS.source, new RegExp(MISSION.motif, "i").source);
});

test("parsePeriod classe le corpus partage comme les deux autres portages", () => {
  // On ne teste pas le motif isole mais parsePeriod de bout en bout : c'est la
  // voie reellement empruntee par lib/extract.js, et elle fait intervenir END
  // avant EN_COURS.
  for (const cas of MISSION.cas) {
    if (!cas.valeur.trim()) continue; // « fin vide » ne transite pas par parsePeriod
    const periode = N.parsePeriod(`Mars 2019 - ${cas.valeur}`);

    if (cas.en_cours) {
      assert.ok(periode, `periode non reconnue : « Mars 2019 - ${cas.valeur} »`);
      assert.equal(periode.current, true, `${cas.valeur} (${cas.preuve})`);
      assert.equal(periode.end, null, `une mission en cours n'a pas de fin : ${cas.valeur}`);
    } else {
      // Un garde-fou peut legitimement ne pas etre reconnu comme periode du
      // tout — « Présentation client » n'est pas une borne de fin, c'est une
      // ligne de CV quelconque. Non reconnu ou reconnu comme termine
      // satisfont tous deux « cette mission n'est pas en cours » ; ce qui est
      // interdit, c'est current=true.
      if (periode) assert.equal(periode.current, false, `${cas.valeur} (${cas.preuve})`);
    }
  }
});

test("« Poste actuel » : la mission en cours n'est plus lue comme terminee", () => {
  // Le cas mesure a 0 an cote cv-parser avant #177 ; ici il se manifestait
  // autrement — mission rendue comme finie, consultant en poste affiche libre.
  const actuel = N.parsePeriod("Mars 2019 - Poste actuel");
  assert.equal(actuel.current, true);
  assert.equal(actuel.end, null);

  // Temoin : une vraie date de fin reste une vraie date de fin.
  const finie = N.parsePeriod("Mars 2019 - Juin 2021");
  assert.equal(finie.current, false);
  assert.equal(finie.end, "2021-06");
});

test("une borne de fin accentuee est reconnue (le motif partage est sans accent)", () => {
  // « Présent » seul : la branche `alone` testait la chaine brute, alors que le
  // motif partage est ecrit sans accent.
  assert.equal(N.parsePeriod("Mars 2019 - Présent").current, true);
  assert.equal(N.parsePeriod("Du 02/2022 à ce jour").current, true);
});
