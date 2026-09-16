"use strict";

/**
 * Resultat partiel (#203) dit sur TOUTES les voies DocIE de l'import, choix de
 * modele ou non (#194) : avertissement nomme `docie_resultat_partiel:<champ>:<raison>`
 * et marque `quality.needs_review` du champ traduit, libelle francais a l'ecran.
 *
 * AUCUN appel reseau : `fetchImpl` de test a la frontiere HTTP du VRAI bridge,
 * qui reconnait lui-meme les chaines DocIE (document-parsing/fixtures/avertissements_docie.json).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { importerCv } = require("../lib/import-pipeline");
const { mapperAdbiResume } = require("../lib/docie-extract");

const FIXTURES = path.join(__dirname, "..", "..", "document-parsing", "fixtures", "cv_samples");
const CV_PDF = fs.readFileSync(path.join(FIXTURES, "cv_simple.pdf"));
const CV_DOCX = fs.readFileSync(path.join(FIXTURES, "cv_docx_titres.docx"));

const BASE = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.test", DOCIE_API_KEY: "test-key",
  DOCIE_AGENT_RESUME: "agent_env" };
const DEUX_TEXTE = { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b", DOCIE_MODELE_NUEXTRACT3: "store:nuextract3" };
const DEUX_AGENT = { ...BASE, DOCIE_AGENT_RESUME_LFM25_2_6B: "agent_lfm", DOCIE_AGENT_RESUME_NUEXTRACT3: "agent_nu" };

// DocIE rend la mission la plus ancienne d'abord ; le cv_master les trie (exp_1 = la plus recente).
const RESULTAT = {
  document_type: "adbi_resume", name: "Alice Dupont", title: "Data Engineer",
  contact: { email: "alice.dupont@example.com", phone: "", linkedin: "", github: "", location: "Paris" },
  experience: [
    { company: "Capgemini", title: "Consultant", start_date: "2019-09", end_date: "", location: "Paris", description: "ETL.", env_technique: "SQL" },
    { company: "Decathlon", title: "Data Engineer", start_date: "2022-03", end_date: "present", location: "Lille", description: "Data.", env_technique: "Python" },
  ],
  education: [], skills: [{ category: "Data", items: ["SQL"] }], languages: [], certifications: [],
  interests: Array.from({ length: 100 }, (_, i) => `centre ${i}`),
};

// Chaines DocIE reelles (formes figees par la fixture partagee du bridge).
const AVERTISSEMENTS = [
  "skills: model output repeated itself (Python, SQL); list truncated at the loop start, remaining items dropped; confidence capped to 0.5 as a review flag",
  "years_experience: douze is not a number; value dropped",
  "experience[0].end_date: the model wrote {'x': 1} in a shape this field cannot hold; nothing was kept",
  "contact.phone: value is not a valid phone number; dropped",
];

const CODES = [
  "docie_resultat_partiel:skills:boucle",
  "docie_resultat_partiel:years_experience:valeur_abandonnee",
  "docie_resultat_partiel:experience[0].end_date:forme_invalide",
  "docie_resultat_partiel:contact.phone:feuille_abandonnee",
  "docie_resultat_partiel:interests:liste_plafonnee_possible",
];

/** fetch de test : repond selon la voie (texte ou agent). */
function docie({ avertissements = AVERTISSEMENTS, resultat = RESULTAT } = {}) {
  const appels = [];
  const fetchImpl = async (url, init) => {
    appels.push({ url, payload: JSON.parse(init.body) });
    const validation = { valid: true, errors: [], warnings: avertissements };
    const agent = /\/v1\/agents\/([^/]+)\//.exec(url);
    const corps = agent
      ? { id: "chatcmpl-1", model: "nuextract3", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(resultat) } }],
          docie_agent: { agent: agent[1], validation } }
      : { request_id: "req-1", schema_name: "adbi_resume", model_profile: "store:nuextract3", result: resultat, validation };
    return new Response(JSON.stringify(corps), { status: 200 });
  };
  return { appels, fetchImpl };
}

const texte = (lignes) => Buffer.from(Array.from({ length: lignes }, (_, i) => `Ligne ${i}`).join("\n"), "utf8");
const partiels = (m) => m.quality.warnings.filter((w) => w.startsWith("docie_resultat_partiel:") || w === "docie_troncature_possible");

const VOIES = [
  ["fichier (PDF, agent)", CV_PDF, "cv.pdf", DEUX_AGENT, "nuextract3"],
  ["texte (.txt)", texte(20), "cv.txt", DEUX_TEXTE, "nuextract3"],
  ["texte (.docx)", CV_DOCX, "cv.docx", DEUX_TEXTE, "nuextract3"],
];

for (const [nom, contenu, fichier, env, modele] of VOIES) {
  test(`voie ${nom} sans choix : chaque raison dite et le champ traduit marque, donnees intactes`, async () => {
    const master = await importerCv(contenu, fichier, { env, fetchImpl: docie().fetchImpl });
    assert.equal(master.source.extraction_method, "docie", "pas de repli local");
    assert.deepEqual(partiels(master), CODES);
    // experience[0] (Capgemini, la plus ancienne) = exp_2 apres tri ; contact.phone VIDE marque quand meme.
    assert.equal(master.experiences[1].company, "Capgemini");
    assert.ok(master.quality.needs_review.includes("exp_2.end_date"), master.quality.needs_review.join(" | "));
    assert.ok(!master.quality.needs_review.includes("exp_1.end_date"), "jamais la mauvaise mission");
    assert.ok(master.quality.needs_review.includes("contact.phone_display"));
    assert.equal(master.quality.needs_review.filter((c) => c.startsWith("skills") || c.startsWith("interests")).length, 0,
      "un champ sans chemin adressable n'a que son avertissement");

    // Non bloquant : seules les listes de relecture different d'une reponse sans avertissement.
    const propre = await importerCv(contenu, fichier, { env, fetchImpl: docie({ avertissements: [] }).fetchImpl });
    const sansRelecture = (m) => JSON.stringify({ ...m, quality: { completeness: m.quality.completeness }, source: { ...m.source, parsed_at: null } });
    assert.equal(sansRelecture(master), sansRelecture(propre));
  });

  test(`voie ${nom} avec choix explicite : memes codes qu'en #211, une seule fois chacun`, async () => {
    const master = await importerCv(contenu, fichier, { env, fetchImpl: docie().fetchImpl, modele });
    assert.deepEqual(partiels(master), CODES, "ni perte ni doublon");
    assert.equal(master.source.modele.demande, modele);
    assert.ok(master.quality.needs_review.includes("exp_2.end_date"));
  });
}

test("troncature_possible : voie texte au-dela de 800 lignes, sans choix ; jamais sur la voie fichier", async () => {
  const sans = { avertissements: [], resultat: { ...RESULTAT, interests: [] } };
  const long = await importerCv(texte(801), "cv.txt", { env: DEUX_TEXTE, fetchImpl: docie(sans).fetchImpl });
  assert.deepEqual(partiels(long), ["docie_troncature_possible"]);
  const court = await importerCv(texte(800), "cv.txt", { env: DEUX_TEXTE, fetchImpl: docie(sans).fetchImpl });
  assert.deepEqual(partiels(court), []);
  const needsLong = long.quality.needs_review.slice().sort();
  assert.deepEqual(needsLong, court.quality.needs_review.slice().sort(), "avertissement de fiche, aucune marque de champ");

  const nu = await importerCv(texte(1500), "cv.txt", { env: DEUX_TEXTE, fetchImpl: docie(sans).fetchImpl, modele: "nuextract3" });
  assert.deepEqual(partiels(nu), ["docie_troncature_possible"], "choix explicite : une seule fois");

  const pdf = await importerCv(CV_PDF, "cv.pdf", { env: DEUX_AGENT, fetchImpl: docie(sans).fetchImpl });
  assert.deepEqual(partiels(pdf), []);
});

test("metadonnees absentes, anciennes ou bancales : aucune exception, relecture d'avant", () => {
  const base = mapperAdbiResume(RESULTAT, { validation: { valid: true } }, { filename: "cv.pdf" });
  for (const metadata of [null, undefined, {}, { validation: { valid: true }, partiel: null },
    { validation: { valid: true }, partiel: "skills" }, { validation: { valid: true }, troncature_possible: "true" },
    { validation: { valid: true }, partiel: [null, 3, { raison: "boucle" }, { champ: "" }], troncature_possible: null }]) {
    const master = mapperAdbiResume(RESULTAT, metadata, { filename: "cv.pdf" });
    assert.deepEqual(partiels(master), []);
    if (metadata && metadata.validation) assert.deepEqual(master.quality, base.quality);
  }
});

test("raison inconnue gardee, jamais ignoree ; chemin hors liste sans fausse mission", () => {
  const master = mapperAdbiResume(RESULTAT, { validation: { valid: true }, partiel: [
    { champ: "title", raison: "nouvelle_raison" }, { champ: "experience[7].title", raison: "forme_invalide" }] }, { filename: "cv.pdf" });
  assert.deepEqual(partiels(master), ["docie_resultat_partiel:title:nouvelle_raison", "docie_resultat_partiel:experience[7].title:forme_invalide"]);
  assert.deepEqual(master.quality.needs_review, ["identity.title"]);
});

test("DocIE desactive (analyse locale) : aucun signal de resultat partiel", async () => {
  const { appels, fetchImpl } = docie();
  const master = await importerCv(texte(20), "cv.txt", { env: { ...DEUX_TEXTE, DOCIE_EXTRACTION_ENABLED: "false" }, fetchImpl });
  assert.equal(appels.length, 0);
  assert.deepEqual(partiels(master), []);
});

test("interface : bandeau de validation en francais, une ligne par raison et la troncature", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(source, /q\.warnings\.map\(\(w\) => `<span class="puce-avert">\$\{echapper\(libelleAvertissement\(w\)\)\}<\/span>`\)/);
  const table = /const LIBELLES_PARTIEL = \{[\s\S]*?\n\};/.exec(source)[0];
  const fonction = /function libelleAvertissement\(w\) \{[\s\S]*?\n\}/.exec(source)[0];
  const libelle = (w) => vm.runInNewContext(`${table}; ${fonction}; libelleAvertissement(${JSON.stringify(w)})`);
  assert.deepEqual(CODES.map(libelle), [
    "Résultat partiel — skills : la sortie du modèle se répétait, la liste a été coupée et la suite abandonnée",
    "Résultat partiel — years_experience : valeur illisible (ni nombre ni montant), abandonnée",
    "Résultat partiel — experience[0].end_date : valeur écrite sous une forme que ce champ ne peut pas contenir, rien n'a été gardé",
    "Résultat partiel — contact.phone : valeur invalide abandonnée",
    "Résultat partiel — interests : liste d'exactement 100 éléments, peut-être plafonnée",
  ]);
  assert.equal(libelle("docie_troncature_possible"), "CV peut-être tronqué : plus de 800 lignes");
  assert.equal(libelle("docie_resultat_partiel:title:nouvelle_raison"), "Résultat partiel — title : nouvelle_raison");
  assert.equal(libelle("docie_validation_negative"), "docie validation negative", "autres avertissements inchanges");
});
