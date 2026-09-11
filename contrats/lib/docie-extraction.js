"use strict";
// Extraction DocIE (bridge partagé document-parsing/bridge/) pour les pièces
// Kbis de la checklist Sous-traitance — issue #153 (« migrer OCR/extraction
// vers le bridge »). Derrière DOCIE_EXTRACTION_ENABLED (défaut absent/false) :
// flag off => comportement inchangé, 100% lib/docanalyze.js local (pdf-parse
// + tesseract.js, RGPD, aucun envoi externe). Les mappings de champs contrat,
// la génération PDF/DOCX et la signature Yousign/Zoho ne sont pas touchés ici.
//
// Portée volontairement limitée à item.id === "kbis" : SCHEMAS dans
// document-parsing/bridge/docie-bridge.js n'a pas d'agent configuré pour les
// autres pièces de la checklist (urssaf, rib, cni, fiscale, coordonnees,
// specifique). Pour elles, DOCIE_EXTRACTION_ENABLED n'a aucun effet — analyse
// locale toujours, flag ou pas. Inventer un schéma DocIE pour ces pièces est
// hors périmètre de ce ticket (travail côté DocIE, pas côté consommateur).
//
// Mapping des champs : lib/kbis-mapping.js, portage JS de
// document-parsing/mappings/kbis_to_contrats.py — le contrat de champs réel
// de l'agent "kbis" (11 champs, confirmé contre les vrais modèles pydantic
// DocIE par document-parsing/scripts/register_and_test.py, PR #46) est
// désormais documenté et testé des deux côtés (Python et JS). Remplace
// l'ancienne stratégie « aplatir en texte + regex locales », qui perdait
// SIREN/SIRET/forme juridique/capital social/RCS/adresse/représentant légal
// faute, à l'époque, d'un contrat de champs connu.

const path = require("path");
const { analyzeDocumentLocal } = require("./docanalyze");
const { mapKbisResult } = require("./kbis-mapping");

const ELIGIBLE_ITEM_ID = "kbis";
const DOCIE_KIND = "kbis";

// Chemin relatif volontaire (et non un package npm local) : le bridge reste
// une source partagée dans document-parsing/bridge/ (cf. son README, « ne pas
// copier manuellement ces fichiers dans les modules »). En checkout monorepo,
// ../../document-parsing/bridge est le vrai dossier partagé. Dans l'image
// Docker de ce service, le Dockerfile copie ce même dossier à la racine du
// système de fichiers de l'image (/document-parsing/bridge) — même profondeur
// relative depuis contrats/lib, donc même chemin ici dans les deux cas.
const BRIDGE_PATH = path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js");

function isEnabled(env = process.env) {
  return String((env || {}).DOCIE_EXTRACTION_ENABLED || "").trim().toLowerCase() === "true";
}

function isEligible(items) {
  const item = (items || [])[0];
  return !!(item && item.id === ELIGIBLE_ITEM_ID);
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

// Point d'entrée unique appelé par server.js : bascule flag + repli. En cas
// d'échec DocIE (config manquante, timeout, erreur upstream/réseau...), repli
// automatique sur l'analyse locale (jamais d'endpoint silencieusement cassé),
// avec une trace serveur (code d'erreur seulement, jamais de secret — le
// bridge redacte déjà la clé de tout corps de réponse) et un avertissement
// ajouté à la réponse pour transparence.
async function analyzeDocument(body = {}, deps = {}) {
  const analyzeLocal = deps.analyzeLocal || analyzeDocumentLocal;
  const env = deps.env || process.env;
  if (isEnabled(env) && isEligible(body.items)) {
    try {
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
  return analyzeLocal(body);
}

module.exports = {
  analyzeDocument,
  extractViaDocie,
  mapDocieResult,
  isEnabled,
  isEligible,
  ELIGIBLE_ITEM_ID,
};
