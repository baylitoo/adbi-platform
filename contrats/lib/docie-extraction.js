"use strict";
// Extraction DocIE (bridge partagé document-parsing/bridge/) pour les pièces
// Kbis et URSSAF de la checklist Sous-traitance — issues #153 et #170.
// Derrière DOCIE_EXTRACTION_ENABLED (défaut absent/false) :
// flag off => comportement inchangé, 100% lib/docanalyze.js local (pdf-parse
// + tesseract.js, RGPD, aucun envoi externe). Les mappings de champs contrat,
// la génération PDF/DOCX et la signature Yousign/Zoho ne sont pas touchés ici.
//
// DEUX pièces sont couvertes, par DEUX voies DocIE différentes — et ce n'est
// pas un détail d'implémentation, c'est ce qui décide si la pièce est
// couvrable du tout :
//
//   kbis   -> voie AGENT (extractDocument, POST /v1/agents/<agent>/chat/...)
//             Le document part en data URI et les backends OCR de DocIE le
//             lisent. L'agent résout son schéma PAR NOM, donc un schéma
//             enregistré au préalable dans le Studio DocIE.
//   urssaf -> voie TEXTE (extractText, POST /v1/extract/text)
//             La DÉFINITION du schéma voyage dans le corps de la requête
//             (`dynamic_schema`, document-parsing/schemas/urssaf.schema.json).
//             Rien n'a à être enregistré côté Studio.
//
// L'issue #170 tenait « créer le schéma dans le Studio » pour un préalable aux
// six pièces non-Kbis. Ce n'est vrai que du premier mécanisme. Le second
// n'exige aucune action côté DocIE ni aucun appel distant pour être mis en
// place ; cv-parser l'emploie en mode `inline` depuis toujours.
//
// Les cinq pièces restantes (rib, cni, fiscale, coordonnees, specifique)
// restent analysées localement, flag ou pas : elles n'ont ni schéma ni
// mapping. urssaf a été traitée en premier parce que c'est la seule dont une
// valeur extraite pilote une vraie logique métier — lib/checklist.js la
// déclare `dateField: true` / « À renouveler tous les 6 mois », et
// public/app.js::renderChecklistDocResult calcule PÉRIMÉ / bientôt périmé /
// valable à partir de `issuedDate`.
//
// Mapping des champs : lib/kbis-mapping.js et lib/urssaf-mapping.js, portages
// JS de document-parsing/mappings/{kbis,urssaf}_to_contrats.py.

const path = require("path");
const { PDFParse } = require("pdf-parse");
const { analyzeDocumentLocal } = require("./docanalyze");
const { mapKbisResult } = require("./kbis-mapping");
const { mapUrssafResult } = require("./urssaf-mapping");

// Conservé tel quel (exporté historiquement) : la pièce de la voie agent.
const ELIGIBLE_ITEM_ID = "kbis";
const DOCIE_KIND = "kbis";

// Quelle voie DocIE pour quelle pièce de la checklist. Une pièce absente de
// cette table n'est jamais envoyée, flag ou pas.
const VOIES = { kbis: "agent", urssaf: "texte" };

// Chemin relatif volontaire (et non un package npm local) : le bridge reste
// une source partagée dans document-parsing/bridge/ (cf. son README, « ne pas
// copier manuellement ces fichiers dans les modules »). En checkout monorepo,
// ../../document-parsing/bridge est le vrai dossier partagé. Dans l'image
// Docker de ce service, le Dockerfile copie ce même dossier à la racine du
// système de fichiers de l'image (/document-parsing/bridge) — même profondeur
// relative depuis contrats/lib, donc même chemin ici dans les deux cas.
const BRIDGE_PATH = path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js");

// Même raisonnement de chemin que BRIDGE_PATH : document-parsing/schemas/ est
// une source partagée hors de contrats/, copiée à la même profondeur relative
// dans l'image Docker (voir Dockerfile, contexte de build "schemas").
// Le schéma est chargé PARESSEUSEMENT, pour la même raison que le bridge : le
// flag désactivé ne doit jamais dépendre de la présence d'un fichier partagé.
const SCHEMA_URSSAF_PATH = path.join(__dirname, "..", "..", "document-parsing", "schemas", "urssaf.schema.json");

function isEnabled(env = process.env) {
  return String((env || {}).DOCIE_EXTRACTION_ENABLED || "").trim().toLowerCase() === "true";
}

// Port exact de detectType() : seul items[0] compte.
function pieceDemandee(items) {
  const item = (items || [])[0];
  return (item && item.id) ? String(item.id) : null;
}

function isEligible(items) {
  return Object.hasOwn(VOIES, pieceDemandee(items) || "");
}

function voiePour(items) {
  const id = pieceDemandee(items);
  return (id && Object.hasOwn(VOIES, id)) ? VOIES[id] : null;
}

// require() paresseux : le flag désactivé (comportement par défaut) ne doit
// jamais dépendre de la présence du module partagé sur le disque — packaging
// Docker distinct (voir Dockerfile), require résolu seulement à l'appel.
function loadBridge() {
  return require(BRIDGE_PATH);
}

function sniffMime(mimeType, buffer) {
  const m = String(mimeType || "").toLowerCase();
  if (["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(m)) return m;
  if (buffer.slice(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.slice(0, 4).toString("latin1") === "RIFF" && buffer.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return m;
}

// Même forme de sortie que analyzeDocumentLocal (lib/docanalyze.js) : les
// consommateurs (route Express, front) ne voient aucune différence de forme
// selon l'origine locale ou DocIE — avec, en plus, les champs structurés
// enrichis (SIREN, SIRET, forme juridique, capital social, RCS, adresse du
// siège, représentant légal, date d'immatriculation) que l'analyse locale
// n'a jamais su produire. Voir lib/kbis-mapping.js pour le détail du mapping.
function mapDocieResult(docieResponse, { items, expectedName } = {}) {
  const validation = docieResponse && docieResponse.metadata && docieResponse.metadata.validation;
  const { analysis } = mapKbisResult(docieResponse && docieResponse.result, { expectedName, items, validation });
  // Marqueur de transparence historique de ce module (comportement d'avant
  // ce portage, issue #153) : signale au front que l'analyse vient de DocIE,
  // pas de l'OCR local. N'existe pas côté kbis_to_contrats.py/kbis-mapping.js
  // (qui visent la parité stricte avec docanalyze.js, lequel n'a aucune
  // notion d'origine à signaler) — ajouté ici uniquement, sur la branche
  // "lisible" (jamais sur "Document illisible.", qui reste identique quelle
  // que soit l'origine de l'analyse).
  if (analysis.documentType !== "Document" && analysis.summary) {
    analysis.summary += " (DocIE)";
  }
  return analysis;
}

// deps injectables (extractDocument, fetchImpl, env) : tests unitaires sans
// aucun appel réseau réel (cf. politique dépôt « aucun appel distant DocIE
// par agent ADBI »).
async function extractViaDocie({ dataBase64, mimeType, items, expectedName } = {}, deps = {}) {
  if (!dataBase64) throw new Error("Aucun fichier reçu.");
  const env = deps.env || process.env;
  const buffer = Buffer.from(dataBase64, "base64");
  const mime = sniffMime(mimeType, buffer);
  const { extractDocument } = deps.extractDocument ? deps : loadBridge();
  const options = { kind: DOCIE_KIND, env };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const response = await extractDocument(buffer, mime, options);
  return mapDocieResult(response, { items, expectedName });
}

// ---------------------------------------------------------------------------
// Voie TEXTE (urssaf). Le choix de la voie se fait À L'EXÉCUTION sur le
// document réellement reçu, JAMAIS en dur sur le type de pièce.
//
// « Une attestation URSSAF est un PDF avec couche texte » est une attente, pas
// une mesure : aucune attestation réelle n'était disponible. Câbler « urssaf
// => voie texte » enverrait donc, le jour où un utilisateur dépose un scan,
// une chaîne vide ou trois caractères d'en-tête à DocIE — qui répondrait
// quelque chose, et ce quelque chose alimenterait la validité 6 mois. Le
// départage est donc structurel : la couche texte existe-t-elle, ici, sur ce
// fichier-ci.
//
// Garde repris de cv-parser/docie_client.py, qui refuse explicitement un PDF
// dont UNE page est sans texte (« PDF contenant une page sans texte : OCR
// requis ») : une page muette signale un scan (ou une page image), et un texte
// amputé produirait une extraction confiante et fausse — le pire cas possible
// pour une date de délivrance, qu'aucune relecture humaine ne rattrape
// (contrairement à un montant aberrant).
//
// Une image (PNG/JPEG/WebP) n'a par construction pas de couche texte : elle
// part directement en analyse locale, SANS OCR de routage. Faire tourner
// tesseract.js juste pour décider coûterait plusieurs secondes et, à la
// première utilisation, un téléchargement de modèle — pour une réponse déjà
// connue.
// ---------------------------------------------------------------------------

// Lit la couche texte d'un PDF, localement, sans OCR. Renvoie le texte joint
// et la liste des pages muettes.
async function lireCoucheTexte(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const r = await parser.getText();
    const pages = Array.isArray(r.pages) ? r.pages : [];
    return { texte: String(r.text || ""), pages };
  } finally {
    try { await parser.destroy(); } catch (e) {}
  }
}

// Le document reçu peut-il alimenter la voie texte ? Renvoie {ok, texte} ou
// {ok:false, raison} — la raison est reprise telle quelle dans l'avertissement
// rendu à l'utilisateur, pour que le repli soit diagnosticable.
async function coucheTexteUtilisable(buffer, mime) {
  if (mime !== "application/pdf") {
    return { ok: false, raison: "le document n'est pas un PDF (image : pas de couche texte)" };
  }
  let lecture;
  try {
    lecture = await lireCoucheTexte(buffer);
  } catch (e) {
    return { ok: false, raison: "PDF illisible ou protégé" };
  }
  if (!lecture.pages.length) return { ok: false, raison: "PDF sans page lisible" };
  const muettes = lecture.pages.filter((p) => !String(p.text || "").trim());
  if (muettes.length) {
    return {
      ok: false,
      raison: "PDF contenant une page sans texte (page " + (muettes[0].num ?? "?") + ") : scan, OCR requis",
    };
  }
  if (!lecture.texte.trim()) return { ok: false, raison: "PDF sans texte exploitable : scan, OCR requis" };
  return { ok: true, texte: lecture.texte };
}

function chargerSchemaUrssaf() {
  return require(SCHEMA_URSSAF_PATH);
}

// Même forme de sortie que analyzeDocumentLocal, enrichie — voir
// lib/urssaf-mapping.js. Marqueur « (DocIE) » identique à celui du Kbis.
function mapUrssafDocieResult(docieResponse, { items, expectedName } = {}) {
  const validation = docieResponse && docieResponse.metadata && docieResponse.metadata.validation;
  const { analysis } = mapUrssafResult(docieResponse && docieResponse.result, { expectedName, items, validation });
  if (analysis.documentType !== "Document" && analysis.summary) {
    analysis.summary += " (DocIE)";
  }
  return analysis;
}

// Renvoie l'analyse DocIE, ou null si le document n'a pas de couche texte
// exploitable — dans ce cas l'appelant retombe sur l'analyse locale en
// nommant `raisonRepli`. Ne renvoie JAMAIS une extraction sur un texte vide.
async function extractUrssafViaTexte({ dataBase64, mimeType, items, expectedName } = {}, deps = {}) {
  if (!dataBase64) throw new Error("Aucun fichier reçu.");
  const env = deps.env || process.env;
  const buffer = Buffer.from(dataBase64, "base64");
  const mime = sniffMime(mimeType, buffer);
  const verdict = await coucheTexteUtilisable(buffer, mime);
  if (!verdict.ok) return { analysis: null, raisonRepli: verdict.raison };
  const { extractText } = deps.extractText ? deps : loadBridge();
  const options = { kind: "urssaf", dynamicSchema: (deps.dynamicSchema || chargerSchemaUrssaf()), env };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const response = await extractText(verdict.texte, options);
  return { analysis: mapUrssafDocieResult(response, { items, expectedName }), raisonRepli: null };
}

// Point d'entrée unique appelé par server.js : bascule flag + repli. En cas
// d'échec DocIE (config manquante, timeout, erreur upstream/réseau...), repli
// automatique sur l'analyse locale (jamais d'endpoint silencieusement cassé),
// avec une trace serveur (code d'erreur seulement, jamais de secret — le
// bridge redacte déjà la clé de tout corps de réponse) et un avertissement
// ajouté à la réponse pour transparence.
async function analyzeDocument(body = {}, deps = {}) {
  const analyzeLocal = deps.analyzeLocal || analyzeDocumentLocal;
  const env = deps.env || process.env;
  const voie = isEnabled(env) ? voiePour(body.items) : null;
  if (!voie) return analyzeLocal(body);
  try {
    if (voie === "texte") {
      const { analysis, raisonRepli } = await extractUrssafViaTexte(body, deps);
      if (analysis) return analysis;
      // Pas d'échec DocIE ici : DocIE n'a tout simplement pas été sollicité,
      // faute de couche texte. Avertissement DISTINCT de celui d'un échec
      // d'extraction, parce que les deux ne se corrigent pas pareil — celui-ci
      // se corrige en fournissant un PDF texte, l'autre côté DocIE.
      const local = await analyzeLocal(body);
      local.issues = (local.issues || []).concat(
        "DocIE non sollicité (" + raisonRepli + ") — analyse locale utilisée."
      );
      return local;
    }
    return await extractViaDocie(body, deps);
  } catch (error) {
    const code = (error && error.code) || "erreur";
    console.error("[docie-extraction] Extraction DocIE en échec, repli sur l'analyse locale (code=" + code + "):", error && error.message);
    const local = await analyzeLocal(body);
    local.issues = (local.issues || []).concat(
      "Extraction DocIE indisponible (" + code + ") — analyse locale utilisée en repli."
    );
    return local;
  }
}

module.exports = {
  analyzeDocument,
  extractViaDocie,
  extractUrssafViaTexte,
  coucheTexteUtilisable,
  mapDocieResult,
  mapUrssafDocieResult,
  chargerSchemaUrssaf,
  isEnabled,
  isEligible,
  voiePour,
  VOIES,
  ELIGIBLE_ITEM_ID,
  // Exportés pour réutilisation par d'autres consommateurs du bridge côté
  // contrats (ex. lib/docie-contract-import.js) : même flag DOCIE_EXTRACTION_ENABLED,
  // même chemin vers le module partagé, même détection MIME — pas de raison
  // de dupliquer ce câblage par kind de document.
  loadBridge,
  sniffMime,
};
