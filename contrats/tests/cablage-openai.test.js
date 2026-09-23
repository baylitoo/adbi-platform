"use strict";
// Câblage des modèles HORS ADBI (#194, #217) côté contrats.
//
// #217 a livré le transport (document-parsing/bridge/openai-responses.js) et
// les entrées du catalogue, sans câblage : le sélecteur ne les proposait pas et
// `extraireTexteLu` appelait DocIE quoi qu'il arrive. Ce fichier fige ce que le
// câblage garantit :
//
//   1. sans OPENAI_API_KEY, RIEN ne change — mêmes offres, à l'octet près ;
//   2. avec la clé, les deux modes sont proposés, APRÈS les modèles DocIE, et
//      jamais comme défaut ;
//   3. un modèle externe choisi part chez le fournisseur, PAS chez DocIE, et
//      son mode de transport n'est jamais envoyé comme profil de modèle DocIE ;
//   4. le résultat est marqué « à relire en entier » (`sansPreuve`), parce que
//      le transport ne rend ni preuve ni confiance par champ ;
//   5. les variables du fournisseur atteignent réellement le conteneur.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const choix = require("../lib/choix-modele");
const { extractViaTexte, signauxPartielsPublics } = require("../lib/docie-extraction");

const RACINE = path.join(__dirname, "..", "..");
// Les trois modèles DocIE sont configurés : sans NUEXTRACT3, le `defaut` du
// contrat ne serait pas proposé du tout et l'ordre des offres ne dirait plus
// rien (mesuré : la première offre devient alors l'alternative).
const SANS_CLE = {
  DOCIE_MODELE_NUEXTRACT3: "store:nuextract3",
  DOCIE_MODELE_LFM25_2_6B: "store:lfm2.5-2.6b",
  DOCIE_MODELE_LFM25_350M: "store:lfm2.5-350m",
};
const AVEC_CLE = { ...SANS_CLE, DOCIE_EXTRACTION_ENABLED: "true", OPENAI_API_KEY: "sk-test-jamais-envoyee" };

function pdf(texte) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.fontSize(12).text(texte, 40, 40);
    doc.end();
  });
}

// Réponse du transport OpenAI, forme du bridge (schema_name/result/metadata).
// `sans_preuve: true` et `field_confidence: null` sont ce que rend réellement
// openai-responses.js — c'est d'eux que dépend le marquage « à relire ».
function reponseOpenAI(result) {
  return {
    schema_name: "urssaf",
    result,
    metadata: {
      request_id: "resp_1", fournisseur: "openai", mode: "rapide", model: "gpt-4.1-nano-2025",
      agent: null, sans_preuve: true, field_confidence: null, validation: null,
      partiel: [], blocs_texte: null, troncature_possible: false, schema_reported: false,
    },
  };
}

const RESULTAT_URSSAF = {
  company_name: "SUND INDUSTRY SYSTEM", siren: "941091316", issued_date: "2026-09-01",
};

// Les pièces à SÉLECTEUR DE MODÈLE dans ce service (lib/choix-modele.js::TACHES).
// `fiscale` n'en fait PAS partie, et c'est délibéré : depuis #215 elle est bien
// dans VOIES et PIECES_TEXTE de docie-extraction.js (voie texte), mais aucun
// sélecteur ne la propose — elle est lue par le profil DocIE par défaut. La
// lister ici ferait passer ce test pour une couverture qu'il n'a pas.
const PIECES = ["contract", "urssaf", "rib", "kbis"];

// La voie reste IMPLICITE : seule le Kbis déclare plusieurs voies admises
// (VOIES_PAR_TYPE) ; pour les autres, nommer « texte » est refusé.
test("sans clé : les offres sont exactement celles d'avant, sur les quatre pièces câblées", () => {
  for (const tache of PIECES) {
    const offres = choix.offresPubliques(tache, { env: SANS_CLE });
    assert.ok(!offres.some((o) => o.role === "externe"), tache + " : un externe est proposé sans clé");
    assert.ok(!JSON.stringify(offres).toLowerCase().includes("openai"), tache + " : OpenAI cité sans clé");
  }
});

test("avec clé : les quatre pièces câblées gagnent les deux modes, toujours en dernier", () => {
  for (const tache of PIECES) {
    const offres = choix.offresPubliques(tache, { env: AVEC_CLE });
    assert.deepEqual(offres.filter((o) => o.role === "externe").map((o) => o.id),
      ["openai_rapide", "openai_raisonnement", "openai_moyen", "openai_eleve"], tache);
    // Ce qui protège réellement l'utilisateur : le navigateur présélectionne
    // `modeles[0]` (app.js::remplirSelecteurModeles), donc un externe ne doit
    // JAMAIS être premier — sinon le texte partirait hors ADBI sans choix.
    assert.notEqual(offres[0].role, "externe", tache + " : un externe est présélectionné");
    assert.deepEqual(offres.slice(-4).map((o) => o.role), ["externe", "externe", "externe", "externe"], tache + " : externes pas en dernier");
  }
});

// Le module de transport est chargé par un chemin relatif (loadOpenAI), résolu
// au même endroit en dépôt et dans l'image Docker. Aucun test n'exerçant ce
// require (ils injectent tous `deps.extraireViaOpenAI`), un chemin faux
// partirait en production sans bruit — exactement le défaut de #164.
test("le transport externe est résolvable depuis lib/, et expose les deux modes", () => {
  const transport = require(path.join(RACINE, "document-parsing", "bridge", "openai-responses.js"));
  assert.equal(typeof transport.extraireViaOpenAI, "function");
  assert.deepEqual(Object.keys(transport.MODES).sort(), ["eleve", "moyen", "raisonnement", "rapide"]);
  // Les modes du catalogue sont ceux du transport : c'est ce qui rend
  // `choisi.mode` directement utilisable, sans table de correspondance.
  const modes = choix.offresPubliques("urssaf", { env: AVEC_CLE }).filter((o) => o.role === "externe").map((o) => o.id);
  for (const id of modes) assert.ok(Object.hasOwn(transport.MODES, id.replace(/^openai_/, "")), id);
});

test("avec clé : les deux modes sont proposés, après les modèles DocIE, jamais en défaut", () => {
  const offres = choix.offresPubliques("urssaf", { env: AVEC_CLE, voie: "texte" });
  const externes = offres.filter((o) => o.role === "externe");
  assert.deepEqual(externes.map((o) => o.id), ["openai_rapide", "openai_raisonnement", "openai_moyen", "openai_eleve"]);
  // Toujours après le défaut et l'alternative : le navigateur présélectionne
  // modeles[0], donc un externe ne peut pas devenir le choix par défaut.
  assert.equal(offres[0].role, "defaut");
  assert.ok(offres.indexOf(externes[0]) > offres.findIndex((o) => o.role === "alternative"));
  // Marqués expérimentaux, et le libellé du catalogue dit déjà « externe ».
  assert.ok(externes.every((o) => o.experimental === true));
  assert.ok(externes.every((o) => /externe/i.test(o.libelle)));
  // Aucun identifiant réel ni clé ne fuit vers le navigateur.
  const rendu = JSON.stringify(offres);
  assert.ok(!rendu.includes("sk-test-jamais-envoyee") && !rendu.includes("store:"));
});

test("le défaut d'une pièce n'est jamais un modèle externe, même avec la clé", () => {
  for (const tache of ["contract", "urssaf", "rib"]) {
    const defaut = choix.defautSansChoix(tache, "texte", null, { env: AVEC_CLE });
    assert.ok(!defaut || !defaut.fournisseur, tache + " : défaut externe");
  }
});

test("choisirPourTexte : accepté avec la clé (identifiant = mode), refusé sans", () => {
  const choisi = choix.choisirPourTexte("urssaf", "openai_rapide", "ligne", { env: AVEC_CLE });
  assert.equal(choisi.id, "openai_rapide");
  assert.equal(choisi.fournisseur, "openai");
  // `identifiant` est le MODE du transport, pas un profil DocIE : c'est ce qui
  // rend l'aiguillage de extraireTexteLu obligatoire.
  assert.equal(choisi.identifiant, "rapide");
  assert.equal(choix.estExterne(choisi), true);
  assert.throws(() => choix.choisirPourTexte("urssaf", "openai_rapide", "ligne", { env: SANS_CLE }),
    (e) => e.name === "ErreurChoixModele" && e.code === "modele_non_propose");
});

test("modèle externe choisi : le texte part chez le fournisseur, jamais chez DocIE", async () => {
  const dataBase64 = (await pdf("ATTESTATION DE VIGILANCE\nSUND INDUSTRY SYSTEM")).toString("base64");
  const appels = [];
  const deps = {
    env: AVEC_CLE,
    dynamicSchema: { document_type: "urssaf", fields: [{ name: "company_name", type: "string" }] },
    extractText: async () => { throw new Error("DocIE ne doit pas être appelé pour un modèle externe"); },
    extraireViaOpenAI: async (texte, options) => {
      appels.push({ texte, mode: options.mode, aProfil: Object.hasOwn(options, "modelProfile") });
      return reponseOpenAI(RESULTAT_URSSAF);
    },
  };
  const { analysis, raisonRepli } = await extractViaTexte("urssaf",
    { dataBase64, mimeType: "application/pdf", items: [{ id: "urssaf" }], expectedName: "SUND INDUSTRY SYSTEM", modele: "openai_rapide" }, deps);
  assert.equal(raisonRepli, null);
  assert.equal(appels.length, 1);
  assert.equal(appels[0].mode, "rapide");
  // Le mode du transport n'est JAMAIS passé comme profil de modèle DocIE.
  assert.equal(appels[0].aProfil, false);
  assert.match(appels[0].texte, /ATTESTATION DE VIGILANCE/);
  // Le mapping est le même que pour DocIE : la pièce reste reconnue.
  assert.equal(analysis.companyName, "SUND INDUSTRY SYSTEM");
  assert.equal(analysis.nameMatches, true);
  // Et le modèle servi est nommé au navigateur.
  assert.equal(analysis.modele.id, "openai_rapide");
});

test("résultat d'un modèle externe : marqué à relire en entier", async () => {
  const dataBase64 = (await pdf("ATTESTATION DE VIGILANCE\nSUND INDUSTRY SYSTEM")).toString("base64");
  const deps = {
    env: AVEC_CLE,
    dynamicSchema: { document_type: "urssaf", fields: [{ name: "company_name", type: "string" }] },
    extractText: async () => { throw new Error("DocIE ne doit pas être appelé"); },
    extraireViaOpenAI: async () => reponseOpenAI(RESULTAT_URSSAF),
  };
  const { analysis } = await extractViaTexte("urssaf",
    { dataBase64, mimeType: "application/pdf", items: [{ id: "urssaf" }], modele: "openai_rapide" }, deps);
  assert.equal(analysis.sansPreuve, true);
  // Le signal vient bien des métadonnées du transport, pas d'une invention du
  // consommateur — et il n'apparaît QUE pour un résultat sans preuve.
  assert.deepEqual(signauxPartielsPublics({ sans_preuve: true }), { sansPreuve: true });
  assert.deepEqual(signauxPartielsPublics({ partiel: [], troncature_possible: false }), {});
});

// ---------------------------------------------------------------------------
// Déploiement : les variables du fournisseur atteignent le conteneur
// ---------------------------------------------------------------------------

// Même mécanique que contrats/tests/kbis-modele.test.js (#164) : une variable
// documentée dans .env.example mais absente du compose n'atteint jamais le
// conteneur, et la fonctionnalité est morte en production sans rien dire.
function blocService(texte, service) {
  const lignes = texte.split(/\r?\n/);
  const debut = lignes.findIndex((l) => l === "  " + service + ":");
  assert.ok(debut !== -1, "service " + service + " introuvable");
  const fin = lignes.findIndex((l, i) => i > debut && /^ {0,2}\S/.test(l));
  return lignes.slice(debut, fin === -1 ? undefined : fin).join("\n");
}

test("compose et .env.example : chaque variable OpenAI est transmise au conteneur contrats et documentée", () => {
  const noms = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODELE_RAPIDE", "OPENAI_MODELE_RAISONNEMENT", "OPENAI_TIMEOUT_SECONDS"];
  for (const [fichier, service] of [["docker-compose.yml", "contrats"], ["docker-compose.local.yml", "contrats"], [path.join("contrats", "docker-compose.yml"), "adbi-contrats"]]) {
    const bloc = blocService(fs.readFileSync(path.join(RACINE, fichier), "utf8"), service);
    for (const nom of noms) assert.ok(bloc.includes("      " + nom + ": ${" + nom + ":-}"), fichier + " : " + nom);
  }
  for (const fichier of [".env.example", path.join("contrats", ".env.example")]) {
    const texte = fs.readFileSync(path.join(RACINE, fichier), "utf8");
    for (const nom of noms) assert.match(texte, new RegExp("^" + nom + "=", "m"), fichier + " : " + nom);
  }
});
