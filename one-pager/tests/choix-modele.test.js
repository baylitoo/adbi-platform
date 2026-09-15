"use strict";

/**
 * Choix du modele d'extraction a l'import d'un CV (#194).
 *
 * AUCUN appel reseau : `fetchImpl` de test (vrais objets Response). Le catalogue
 * lu est le vrai (document-parsing/models/catalogue.json) ; les identifiants
 * viennent d'un environnement de test passe explicitement.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { importerCv } = require("../lib/import-pipeline");
const { modelesProposes } = require("../lib/choix-modele");
const { monterImport } = require("../lib/import-routes");
const { creerGestionnaire, mapperErreur } = require("../lib/import-taches");

const FIXTURES = path.join(__dirname, "..", "..", "document-parsing", "fixtures", "cv_samples");
const CV_PDF = fs.readFileSync(path.join(FIXTURES, "cv_simple.pdf"));
const CV_DOCX = fs.readFileSync(path.join(FIXTURES, "cv_docx_titres.docx"));

const BASE = { DOCIE_EXTRACTION_ENABLED: "true", DOCIE_BASE_URL: "https://docie.test", DOCIE_API_KEY: "test-key" };
const DEUX_TEXTE = { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b", DOCIE_MODELE_NUEXTRACT3: "store:nuextract3" };
const DEUX_AGENT = { ...BASE, DOCIE_AGENT_RESUME_LFM25_2_6B: "agent_lfm", DOCIE_AGENT_RESUME_NUEXTRACT3: "agent_nu" };

const RESULTAT = {
  document_type: "adbi_resume", name: "Alice Dupont", title: "Data Engineer",
  contact: { email: "alice.dupont@example.com", phone: "", linkedin: "", github: "", location: "Paris" },
  experience: [{ company: "Decathlon", title: "Data Engineer", start_date: "2022-03", end_date: "present",
    location: "Lille", description: "Pilotage de la plateforme data.", env_technique: "Python" }],
  education: [], skills: [], languages: [], certifications: [], interests: [],
};

/** fetch de test : repond selon la voie (texte ou agent), enregistre chaque appel. */
function docie({ status = 200, modelProfile = "store:nuextract3", avertissements = [] } = {}) {
  const appels = [];
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    appels.push({ url, payload });
    if (status !== 200) return new Response(JSON.stringify({ error: "boom" }), { status });
    const validation = { valid: true, errors: [], warnings: avertissements };
    const agent = /\/v1\/agents\/([^/]+)\//.exec(url);
    const corps = agent
      ? { id: "chatcmpl-1", model: "lfm2.5-2.6b",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(RESULTAT) } }],
          docie_agent: { agent: agent[1], validation } }
      : { request_id: "req-1", schema_name: "adbi_resume", model_profile: modelProfile, result: RESULTAT, validation };
    return new Response(JSON.stringify(corps), { status: 200 });
  };
  return { appels, fetchImpl };
}

/** PDF minimal valide de `n` pages blanches (offsets xref exacts). */
function pdfPages(n) {
  const objets = ["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${n} >>`,
    ...Array.from({ length: n }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>")];
  let corps = "%PDF-1.4\n";
  const offsets = objets.map((o, i) => {
    const debut = Buffer.byteLength(corps, "latin1");
    corps += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return debut;
  });
  const xref = Buffer.byteLength(corps, "latin1");
  corps += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(corps, "latin1");
}

const texte = (lignes) => Buffer.from(Array.from({ length: lignes }, (_, i) => `Ligne ${i}`).join("\n"), "utf8");

async function rejet(promesse) {
  try { await promesse; } catch (e) { return e; }
  assert.fail("l'import devait echouer");
}

// ── Quels modeles proposer ─────────────────────────────────────────────────

test("offre : rien de configure ou DocIE inactif -> aucun modele ; un seul -> un ; deux -> defaut d'abord", () => {
  assert.deepEqual(modelesProposes(BASE), []);
  assert.deepEqual(modelesProposes({ ...DEUX_TEXTE, DOCIE_EXTRACTION_ENABLED: "false" }), [],
    "un modele que l'import ne peut pas appeler n'est pas propose");
  assert.deepEqual(modelesProposes({ ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" }).map((m) => m.id), ["lfm25_2_6b"]);
  assert.deepEqual(modelesProposes(DEUX_TEXTE).map((m) => [m.id, m.role]),
    [["lfm25_2_6b", "defaut"], ["nuextract3", "alternative"]]);
  assert.deepEqual(modelesProposes({ ...BASE, DOCIE_AGENT_RESUME_NUEXTRACT3: "agent_nu" }).map((m) => m.id), ["nuextract3"]);
  assert.deepEqual(Object.keys(modelesProposes(DEUX_AGENT)[0]), ["id", "libelle", "description", "role"],
    "l'identifiant reel ne part jamais vers le navigateur");
});

test("interface : le selecteur n'est rempli qu'a partir de deux modeles", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(source, /if \(modeles\.length > 1\) \{/);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<div class="note" id="choix-modele-bloc" hidden>/);
});

// ── Voie texte : lignes non vides ──────────────────────────────────────────

test("voie texte : 800 lignes -> modele choisi envoye pour cet appel ; 801 -> refus `limite` sans appel", async () => {
  const { appels, fetchImpl } = docie({ modelProfile: "store:lfm2.5-2.6b" });
  const master = await importerCv(texte(800), "cv.txt", { env: DEUX_TEXTE, fetchImpl, modele: "lfm25_2_6b" });
  assert.equal(appels.length, 1);
  assert.match(appels[0].url, /\/v1\/extract\/text$/);
  assert.equal(appels[0].payload.model_profile, "store:lfm2.5-2.6b");
  assert.deepEqual(master.source.modele, {
    voie: "texte", demande: "lfm25_2_6b",
    servi: { id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", identifiant: "store:lfm2.5-2.6b" },
  });

  const refus = docie();
  const e = await rejet(importerCv(texte(801), "cv.txt", { env: DEUX_TEXTE, fetchImpl: refus.fetchImpl, modele: "lfm25_2_6b" }));
  assert.equal(e.code, "limite");
  assert.equal(refus.appels.length, 0);
  assert.deepEqual(mapperErreur(e), { code: "limite", message: e.message });
  assert.match(e.message, /800 lignes non vides \(document : 801\)/);

  // NuExtract3 n'a pas de limite de lignes sur la voie texte.
  const nu = docie();
  await importerCv(texte(1500), "cv.txt", { env: DEUX_TEXTE, fetchImpl: nu.fetchImpl, modele: "nuextract3" });
  assert.equal(nu.appels[0].payload.model_profile, "store:nuextract3");
});

test("voie texte : un .docx part avec le modele choisi ; le modele servi est celui de la reponse", async () => {
  const { appels, fetchImpl } = docie({ modelProfile: "store:lfm2.5-2.6b" });
  const master = await importerCv(CV_DOCX, "cv.docx", { env: DEUX_TEXTE, fetchImpl, modele: "nuextract3" });
  assert.equal(appels[0].payload.model_profile, "store:nuextract3");
  assert.equal(master.source.modele.demande, "nuextract3");
  assert.equal(master.source.modele.servi.libelle, "LFM2.5 2.6B", "jamais le libelle demande a la place de la reponse");
});

// ── Voie fichier : pages ───────────────────────────────────────────────────

test("voie fichier : 8 pages -> agent du modele choisi ; 9 pages ou illisible -> refus `limite` sans appel", async () => {
  const { appels, fetchImpl } = docie();
  const master = await importerCv(pdfPages(8), "cv.pdf", { env: DEUX_AGENT, fetchImpl, modele: "nuextract3" });
  assert.match(appels[0].url, /\/v1\/agents\/agent_nu\/chat\/completions$/);
  assert.deepEqual(master.source.modele.servi, { id: "nuextract3", libelle: "NuExtract3", identifiant: "agent_nu" });

  for (const contenu of [pdfPages(9), Buffer.from("%PDF-1.4 illisible")]) {
    const refus = docie();
    const e = await rejet(importerCv(contenu, "cv.pdf", { env: DEUX_AGENT, fetchImpl: refus.fetchImpl, modele: "nuextract3" }));
    assert.equal(e.code, "limite");
    assert.equal(refus.appels.length, 0);
  }

  // L'agent OCR (LFM2.5) n'a pas de limite de pages.
  const lfm = docie();
  await importerCv(CV_PDF, "cv.pdf", { env: DEUX_AGENT, fetchImpl: lfm.fetchImpl, modele: "lfm25_2_6b" });
  assert.match(lfm.appels[0].url, /\/v1\/agents\/agent_lfm\//);
});

// ── Echouer bruyamment ─────────────────────────────────────────────────────

test("echec DocIE : modele choisi -> erreur nommee du bridge ; sans choix -> repli local inchange", async () => {
  const choisi = docie({ status: 500 });
  const e = await rejet(importerCv(CV_PDF, "cv.pdf", { env: DEUX_AGENT, fetchImpl: choisi.fetchImpl, modele: "lfm25_2_6b" }));
  assert.equal(e.code, "upstream");
  assert.equal(choisi.appels.length, 1, "un seul appel, aucun autre modele essaye");
  assert.deepEqual(mapperErreur(e), { code: "upstream", message: "Le service d'extraction a répondu en erreur." });

  const sans = docie({ status: 500 });
  const master = await importerCv(CV_PDF, "cv.pdf", { env: { ...DEUX_AGENT, DOCIE_AGENT_RESUME: "agent_env" }, fetchImpl: sans.fetchImpl });
  assert.equal(master.source.extraction_method, "local_fallback:upstream");
  assert.match(sans.appels[0].url, /\/v1\/agents\/agent_env\//, "sans choix : l'agent de DOCIE_AGENT_RESUME, comme avant");
});

test("refus nommes : modele non configure, DocIE inactif, format sans voie DocIE — jamais l'analyse locale", async () => {
  const { appels, fetchImpl } = docie();
  const nonConfigure = await rejet(importerCv(texte(10), "cv.txt",
    { env: { ...BASE, DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b" }, fetchImpl, modele: "nuextract3" }));
  assert.deepEqual(mapperErreur(nonConfigure), { code: "modele_non_propose", message: "Modèle NuExtract3 non proposé pour : CV." });

  const inactif = await rejet(importerCv(texte(10), "cv.txt",
    { env: { ...DEUX_TEXTE, DOCIE_EXTRACTION_ENABLED: "false" }, fetchImpl, modele: "lfm25_2_6b" }));
  assert.equal(mapperErreur(inactif).code, "configuration");

  const doc = await rejet(importerCv(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), "cv.doc", { env: DEUX_TEXTE, fetchImpl, modele: "lfm25_2_6b" }));
  assert.equal(mapperErreur(doc).code, "input");
  assert.equal(appels.length, 0);
});

test("resultat partiel (#203) : signale par champ pour un modele choisi ; sans choix, avertissements inchanges", async () => {
  const boucle = "skills: model output repeated itself (Python, Python); list truncated at the loop start, " +
    "remaining items dropped; confidence capped to 0.5 as a review flag";
  const choisi = await importerCv(texte(20), "cv.txt",
    { env: DEUX_TEXTE, fetchImpl: docie({ avertissements: [boucle] }).fetchImpl, modele: "nuextract3" });
  assert.ok(choisi.quality.warnings.includes("docie_resultat_partiel:skills:boucle"), choisi.quality.warnings.join(" | "));

  const sans = await importerCv(texte(20), "cv.txt", { env: DEUX_TEXTE, fetchImpl: docie({ avertissements: [boucle] }).fetchImpl });
  assert.ok(!sans.quality.warnings.some((w) => w.startsWith("docie_resultat_partiel")));
  assert.equal(sans.source.modele.demande, null);
  assert.equal(sans.source.modele.servi.libelle, "NuExtract3", "modele servi enregistre, choix ou non");
});

// ── Routes ─────────────────────────────────────────────────────────────────

async function demarrer(deps) {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  const gestionnaire = creerGestionnaire({ journal: () => {} });
  monterImport(app, { db: { findByHash: async () => null }, gestionnaire, ...deps });
  const serveur = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return {
    base,
    fermer: () => new Promise((ok) => serveur.close(ok)),
    post: (corps) => fetch(base + "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) }),
    attendre: async (id) => {
      for (let i = 0; i < 300; i++) {
        const vue = await (await fetch(base + "/api/taches/" + id)).json();
        if (vue.etat !== "en_cours") return vue;
        await new Promise((ok) => setTimeout(ok, 10));
      }
      throw new Error("tache jamais terminee");
    },
  };
}

test("routes : GET /api/modeles ; `modele` transmis seulement s'il est choisi ; modele invalide -> 400", async () => {
  const appels = [];
  const srv = await demarrer({
    importerCv: async (...args) => { appels.push(args); return { identity: {} }; },
    modelesProposes: () => [{ id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "defaut" }],
  });
  const panne = await demarrer({ importerCv: async () => ({}), modelesProposes: () => { throw new Error("DOCIE_MODELE_X"); } });
  try {
    assert.deepEqual(await (await fetch(srv.base + "/api/modeles")).json(),
      { modeles: [{ id: "lfm25_2_6b", libelle: "LFM2.5 2.6B", description: "Rapide", role: "defaut" }] });
    const erreur = await (await fetch(panne.base + "/api/modeles")).json();
    assert.deepEqual(erreur.modeles, []);
    assert.match(erreur.erreur, /mal configuré/);

    const contenu = Buffer.from("Alice").toString("base64");
    await srv.attendre((await (await srv.post({ filename: "a.txt", contentBase64: contenu })).json()).tache);
    await srv.attendre((await (await srv.post({ filename: "b.txt", contentBase64: contenu, modele: "" })).json()).tache);
    await srv.attendre((await (await srv.post({ filename: "c.txt", contentBase64: contenu, modele: " nuextract3 " })).json()).tache);
    assert.deepEqual(appels.map((a) => a.length), [2, 2, 3], "sans choix : appel identique a avant");
    assert.deepEqual(appels[2][2], { modele: "nuextract3" });
    assert.equal((await srv.post({ filename: "d.txt", contentBase64: contenu, modele: 42 })).status, 400);
  } finally {
    await srv.fermer();
    await panne.fermer();
  }
});

test("bout en bout : modele choisi + DocIE en echec -> tache `echec` au code nomme, pas de repli local", async () => {
  const { fetchImpl } = docie({ status: 500 });
  const srv = await demarrer({ importerCv: (buffer, filename, options) => importerCv(buffer, filename, { ...options, env: DEUX_TEXTE, fetchImpl }) });
  try {
    const { tache } = await (await srv.post({ filename: "cv.txt", contentBase64: texte(30).toString("base64"), modele: "nuextract3" })).json();
    const vue = await srv.attendre(tache);
    assert.equal(vue.etat, "echec");
    assert.deepEqual(vue.erreur, { code: "upstream", message: "Le service d'extraction a répondu en erreur." });
  } finally {
    await srv.fermer();
  }
});
