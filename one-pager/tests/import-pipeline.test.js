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

const { importerCv } = require("../lib/import-pipeline");

const CV_PDF = fs.readFileSync(
  path.join(__dirname, "..", "..", "document-parsing", "fixtures", "cv_samples", "cv_simple.pdf")
);
const CV_TXT = Buffer.from("Alice Dupont\nData Engineer\nalice.dupont@example.com\n", "utf8");

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

test("drapeau actif + fichier non-PDF (txt) : reste sur la voie locale, DocIE non sollicite (pas de contrat DOCX/texte au bridge)", async () => {
  let appele = 0;
  const fetchImpl = async () => { appele++; return new Response("{}", { status: 200 }); };
  const master = await importerCv(CV_TXT, "cv.txt", { env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" }, fetchImpl });
  assert.equal(appele, 0);
  assert.notEqual(master.source.extraction_method, "docie");
});

test("drapeau actif + reseau DocIE injoignable (fetch rejette) : repli local egalement", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED (simule)"); };
  const master = await importerCv(CV_PDF, "cv.pdf", { env: { ...ENV_BASE, DOCIE_EXTRACTION_ENABLED: "true" }, fetchImpl });
  assert.ok(master.source.extraction_method.startsWith("local_fallback:network"));
});
