"use strict";

/**
 * Tests de lib/import-pipeline.js — le point de bascule DOCIE_EXTRACTION_ENABLED.
 *
 * AUCUN appel reseau reel : le transport HTTP du bridge (document-parsing/
 * bridge/docie-bridge.js) est remplace par un `fetchImpl` de test qui renvoie
 * un vrai objet Response (getReader/cancel fonctionnels), sans jamais ouvrir
 * de socket. Politique du depot : "Aucun appel distant DocIE par agent ADBI".
 *
 * server.js n'est jamais require() ici : il exige DATABASE_URL et se termine
 * sinon (voir server.js) — importerCv vit dans lib/import-pipeline.js
 * precisement pour rester testable sans PostgreSQL.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { importerCv, voieDocie } = require("../lib/import-pipeline");
const { estTexteBrut } = require("../lib/ingest");

const FIXTURES = path.join(__dirname, "..", "..", "document-parsing", "fixtures", "cv_samples");
const CV_PDF = fs.readFileSync(path.join(FIXTURES, "cv_simple.pdf"));
const CV_PDF_SCANNE = fs.readFileSync(path.join(FIXTURES, "cv_scanned.pdf"));
const CV_TXT = Buffer.from("Alice Dupont\nData Engineer\nalice.dupont@example.com\n", "utf8");

/** Schema partage envoye avec le texte — la meme source que lib/docie-extract. */
const SCHEMA_RESUME = require("../../document-parsing/schemas/adbi_resume.schema.json");

const ENV_BASE = {
  DOCIE_BASE_URL: "https://docie.test",
  DOCIE_API_KEY: "test-key",
  DOCIE_AGENT_RESUME: "adbi_agent_1",
};

function reponseSucces() {
  const body = {
    id: "chatcmpl-test",
    model: "spark-x2.5-1.7b",
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          document_type: "adbi_resume",
          name: "Alice Dupont",
          title: "Data Engineer",
          contact: { email: "alice.dupont@example.com", phone: "", linkedin: "", github: "", location: "Paris" },
          experience: [{
            company: "Decathlon", title: "Data Engineer",
            start_date: "2022-03", end_date: "present", location: "Lille",
            description: "Pilotage de la plateforme data.", env_technique: "Python, Databricks",
          }],
          education: [], skills: [], languages: [], certifications: [], interests: [],
        }),
      },
    }],
    docie_agent: { agent: "adbi_agent_1", validation: { valid: true, errors: [], warnings: [] } },
  };
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

function reponseEchec() {
  return async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
}

/**
 * Reponse de la VOIE TEXTE (POST /v1/extract/text).
 *
 * Elle est PLATE : ni `choices`, ni `finish_reason`, ni `docie_agent` — un
 * corps de la voie chat ferait echouer parseTextResponse et le test passerait
 * en croyant mesurer la voie texte alors qu'il mesurerait le repli local.
 * Forme reprise de document-parsing/bridge/tests/contract_text.json.
 */
function corpsTexte(result, extra = {}) {
  return {
    request_id: "req-text-1",
    schema_name: "adbi_resume",
    model_profile: "spark-x2.5-1.7b",
    result: { document_type: "adbi_resume", ...result },
    validation: { valid: true, errors: [], warnings: [] },
    latency_ms: 1200,
    ...extra,
  };
}

const RESULT_TEXTE = {
  name: "Alice Dupont",
  title: "Data Engineer",
  contact: { email: "alice.dupont@example.com", phone: "", linkedin: "", github: "", location: "Paris" },
  experience: [{
    company: "Decathlon", title: "Data Engineer",
    start_date: "2022-03", end_date: "present", location: "Lille",
    description: "Pilotage de la plateforme data.", env_technique: "Python, Databricks",
  }],
  education: [], skills: [], languages: [], certifications: [], interests: [],
};

/** fetch de test qui enregistre l'URL, les en-tetes et le corps envoyes. */
function espion(corps, status = 200) {
  const appels = [];
  const fetchImpl = async (url, init) => {
    appels.push({ url, headers: init.headers, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify(corps), { status });
  };
  return { appels, fetchImpl };
}

test("drapeau desactive (defaut) : voie locale historique, le bridge n'est jamais sollicite", async () => {
  let appele = 0;
  const fetchImpl = async () => { appele++; return new Response("{}", { status: 200 }); };

  const master = await importerCv(CV_TXT, "cv.txt", { env: { ...ENV_BASE }, fetchImpl });

  assert.equal(appele, 0, "fetchImpl ne doit jamais etre invoque quand le drapeau est desactive");
  assert.notEqual(master.source.extraction_method, "docie");
  assert.equal(master.source.extraction_method, "plain_text");
});

test("drapeau desactive explicitement (\"false\") : meme comportement que par defaut", async () => {
  let appele = 0;
  const fetchImpl = async () => { appele++; return new Response("{}", { status: 200 }); };
  await importerCv(CV_TXT, "cv.txt", { env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "false" }, fetchImpl });
  assert.equal(appele, 0);
});

test("drapeau actif + PDF + reponse DocIE valide : extraction mappee via le bridge, downstream inchange", async () => {
  const master = await importerCv(CV_PDF, "cv.pdf", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl: reponseSucces(),
  });

  assert.equal(master.source.extraction_method, "docie");
  assert.equal(master.identity.full_name, "Alice DUPONT");
  assert.equal(master.experiences[0].company, "Decathlon");

  // Edition/export en aval : build() ne doit jamais planter sur une fiche DocIE.
  const { build } = require("../lib/onepager");
  const onePager = build(master, { template: "adbi_16_9" });
  assert.ok(onePager.header.title);
});

test("drapeau actif + PDF + echec DocIE (HTTP 500) : repli sur l'extraction locale, trace dans quality.warnings", async () => {
  const master = await importerCv(CV_PDF, "cv.pdf", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl: reponseEchec(),
  });

  assert.ok(master.source.extraction_method.startsWith("local_fallback:"), master.source.extraction_method);
  assert.ok(
    master.quality.warnings.some((w) => w.startsWith("docie_indisponible_repli_local:")),
    "l'avertissement de repli doit etre trace, jamais silencieux"
  );
  // La fiche reste exploitable malgre l'echec DocIE : c'est le meme extracteur
  // local que la voie par defaut, donc au moins une experience est trouvee
  // sur un CV texte normal.
  assert.ok(Array.isArray(master.experiences));
});

test("drapeau actif + texte brut (.txt) : part sur POST /v1/extract/text, corps sans enveloppe data URI", async () => {
  const { appels, fetchImpl } = espion(corpsTexte(RESULT_TEXTE));
  const master = await importerCv(CV_TXT, "cv.txt", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl,
  });

  assert.equal(appels.length, 1);
  const { url, headers, payload } = appels[0];
  assert.equal(url, "https://docie.test/v1/extract/text");
  assert.equal(headers["x-api-key"], "test-key");
  assert.equal(headers.Authorization, undefined, "pas de Bearer : ce n'est pas la voie agent/chat");
  // Le texte part tel quel, exactement comme lib/ingest#readTxt le decoderait.
  assert.equal(payload.text, CV_TXT.toString("utf8"));
  assert.equal(payload.schema_name, "adbi_resume");
  assert.equal(payload.schema_mode, "dynamic");
  // « adbi_resume » est un schema PERSONNALISE : sans sa definition, DocIE ne
  // le resout pas (document-parsing/scripts/register_and_test.py ligne 26).
  assert.deepEqual(payload.dynamic_schema, SCHEMA_RESUME);
  for (const absent of ["messages", "model", "max_tokens", "parallel_extraction", "ocr_blocks"]) {
    assert.equal(Object.hasOwn(payload, absent), false, absent);
  }

  // Meme cv_master en aval que la voie fichier, a la seule difference honnete
  // que l'endpoint impose : il n'y a pas d'agent sur cette voie.
  assert.equal(master.source.extraction_method, "docie");
  assert.equal(master.source.docie.agent, null);
  assert.equal(master.source.docie.request_id, "req-text-1");
  assert.equal(master.identity.full_name, "Alice DUPONT");
  assert.equal(master.experiences[0].company, "Decathlon");
  assert.equal(master.experiences[0].is_current, true);

  // Meme forme de cv_master que la voie fichier : mot pour mot les memes cles
  // de premier niveau, dans le meme ordre.
  const viaFichier = await importerCv(CV_PDF, "cv.pdf", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl: reponseSucces(),
  });
  assert.deepEqual(Object.keys(master), Object.keys(viaFichier));
  assert.deepEqual(Object.keys(master.source), Object.keys(viaFichier.source));
  assert.deepEqual(Object.keys(master.quality), Object.keys(viaFichier.quality));

  // Edition/export en aval : identiques a la voie fichier.
  const { build } = require("../lib/onepager");
  assert.ok(build(master, { template: "adbi_16_9" }).header.title);
});

test("voie texte : le signal de relecture (#173) survit a l'identique", async () => {
  // Champs ancres par DocIE, exactement comme sur la voie fichier : le service
  // decoupe le texte lui-meme, donc chaque feuille revient enveloppee.
  const result = {
    ...RESULT_TEXTE,
    contact: { ...RESULT_TEXTE.contact, email: { value: "alice.dupont@example.com", confidence: 0.4, evidence_ids: ["b1"] } },
    experience: [{
      ...RESULT_TEXTE.experience[0],
      title: { value: "Data Engineer", confidence: 0.5, evidence_ids: ["b7"] },
    }],
  };
  const corps = corpsTexte(result, {
    validation: { valid: false, errors: [], warnings: ["liste tronquee apres 20 entrees"] },
  });
  const { fetchImpl } = espion(corps);
  const master = await importerCv(CV_TXT, "cv.txt", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl,
  });

  assert.equal(master.source.extraction_method, "docie");
  // field_confidence -> needs_review, chemins cv_master et non chemins DocIE.
  assert.ok(master.quality.needs_review.includes("contact.email"), master.quality.needs_review.join(","));
  assert.ok(master.quality.needs_review.includes("exp_1.role"), master.quality.needs_review.join(","));
  // validation -> quality.warnings, prose verbatim.
  assert.ok(master.quality.warnings.includes("docie_validation_negative"));
  assert.ok(master.quality.warnings.includes("docie_avertissement:liste tronquee apres 20 entrees"));
  // Les enveloppes sont bien deballees : jamais « [object Object] » en aval.
  assert.equal(master.contact.email, "alice.dupont@example.com");
  assert.equal(master.experiences[0].role, "Data Engineer");
});

test("voie texte : un schema non rapporte est signale, pas presume verifie", async () => {
  const corps = corpsTexte(RESULT_TEXTE);
  delete corps.schema_name;
  delete corps.result.document_type;
  const { fetchImpl } = espion(corps);
  const master = await importerCv(CV_TXT, "cv.txt", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl,
  });
  assert.ok(master.quality.warnings.includes("docie_schema_non_verifie"));
});

test("voie texte + echec DocIE (HTTP 500) : repli local, meme convention que la voie fichier", async () => {
  const { appels, fetchImpl } = espion({ error: "boom" }, 500);
  const master = await importerCv(CV_TXT, "cv.txt", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl,
  });

  assert.equal(appels.length, 1, "un seul POST, jamais de retry");
  assert.equal(master.source.extraction_method, "local_fallback:upstream");
  assert.ok(master.quality.warnings.includes("docie_indisponible_repli_local:upstream"));
  // L'import n'est pas casse pour autant : c'est le meme extracteur local.
  assert.equal(master.identity.full_name, "Alice DUPONT");
});

test("aiguillage : on suit ce que la source EST, jamais une preference pour le texte", async () => {
  // Un PDF SCANNE n'a aucun texte lisible par machine : il reste sur la voie
  // fichier, la seule qui declenche l'OCR distant (#180).
  const { appels, fetchImpl } = espion(JSON.parse(JSON.stringify({
    id: "chatcmpl-scan", model: "spark",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ document_type: "adbi_resume", name: "Alice Dupont", experience: [] }) } }],
    docie_agent: { agent: "adbi_agent_1", validation: { valid: true, errors: [], warnings: [] } },
  })));
  await importerCv(CV_PDF_SCANNE, "cv_scanne.pdf", {
    env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" },
    fetchImpl,
  });
  assert.equal(appels[0].url, "https://docie.test/v1/agents/adbi_agent_1/chat/completions");
  assert.ok(Object.hasOwn(appels[0].payload, "messages"), "voie fichier : enveloppe data URI conservee");

  // Un PDF texte suit la meme voie : on ne lui substitue pas /v1/extract/text.
  assert.equal(estTexteBrut(CV_PDF, "cv.pdf"), false);
  assert.equal(estTexteBrut(CV_PDF, "cv.txt"), false, "l'entete %PDF- prime sur l'extension");

  // DOCX hors perimetre (#180) : aucune voie DocIE, donc voie historique.
  const faux_docx = Buffer.from("PK  contenu", "latin1");
  assert.equal(voieDocie(faux_docx, "cv.docx"), null);
  assert.equal(estTexteBrut(Buffer.from("Alice"), "cv.doc"), false);
  // Un binaire renomme en .txt n'est pas du texte : il echouerait a distance.
  assert.equal(estTexteBrut(faux_docx, "cv.txt"), false);
  // Un depot vide non plus : la voie locale sait deja le refuser (422).
  assert.equal(estTexteBrut(Buffer.from("   \n"), "cv.txt"), false);
  assert.equal(estTexteBrut(CV_TXT, "cv.txt"), true);
  // Sans extension connue, ingest() lit du texte : l'aiguillage fait pareil.
  assert.equal(estTexteBrut(CV_TXT, "cv"), true);
});

test("le schema partage est celui de cv-parser, octet a octet", () => {
  const cvParser = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "cv-parser", "adbi_resume.schema.json"), "utf8"
  ));
  // Deux copies du meme schema metier, comme mission_en_cours.json pour le
  // motif partage : si l'une evolue seule, ce test tombe avant le deploiement.
  assert.deepEqual(SCHEMA_RESUME, cvParser);
});

test("drapeau actif + reseau DocIE injoignable (fetch rejette) : repli local egalement", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED (simule)"); };
  const master = await importerCv(CV_PDF, "cv.pdf", { env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" }, fetchImpl });
  assert.ok(master.source.extraction_method.startsWith("local_fallback:network"));
});
