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
// Gap de schéma documenté : le contrat de champs réel de l'agent "kbis" n'est
// ni documenté ni testé nulle part dans ce dépôt (document-parsing/bridge/
// tests/contract.json ne couvre que le schéma "adbi_resume" ; le README du
// bridge indique l'agent kbis "à configurer côté DocIE"). Plutôt que
// d'inventer une correspondance de champs qui pourrait être fausse, le
// résultat structuré DocIE est aplati en texte et repassé dans les mêmes
// règles regex que l'analyse locale (extractCompanyName / extractIssuedDate /
// checkName, importées de lib/docanalyze.js) : mapping best-effort et
// provisoire, à resserrer dès qu'un schéma kbis documenté existera côté DocIE.

const path = require("path");
const { analyzeDocumentLocal, checkName, extractCompanyName, extractIssuedDate, norm } = require("./docanalyze");

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

function humanizeKey(key) {
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
}

// Aplatit le JSON structuré retourné par DocIE en lignes "clé: valeur" — sans
// supposer de noms de champs précis (cf. gap de schéma ci-dessus). Les clés
// snake_case/camelCase sont "humanisées" en mots séparés par des espaces :
// une clé plausible comme "date_delivrance" redevient "date delivrance", ce
// qui reste détectable par les regex de proximité de mot-clé de
// extractIssuedDate (ex. "DATE DE D[ÉE]LIVRANCE").
function flattenResult(value, prefix, out) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenResult(item, prefix, out));
    return out;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flattenResult(item, prefix ? prefix + " " + humanizeKey(key) : humanizeKey(key), out);
    }
    return out;
  }
  const text = String(value).trim();
  if (!text) return out;
  out.push(prefix ? prefix + ": " + text : text);
  return out;
}

function resultToText(result) {
  return flattenResult(result, "", []).join("\n");
}

// Repli date ISO (YYYY-MM-DD) : extractIssuedDate (analyse locale, inchangée)
// ne reconnaît que DD/MM/YYYY et "DD mois YYYY" — un agent d'extraction
// structuré renverra vraisemblablement de l'ISO. Ajouté uniquement ici (côté
// DocIE) ; le front consomme déjà issuedDate via new Date(...), compatible ISO.
//
// Un Kbis peut porter plusieurs dates ISO (immatriculation/création ET
// délivrance) : ne pas prendre "la première trouvée" (dépendrait de l'ordre
// des clés du JSON DocIE, arbitraire). Mêmes 3 paliers que extractIssuedDate
// (mot-clé de délivrance à proximité, sinon la plus récente non future, sinon
// la plus ancienne) pour ne pas confondre date de création et de délivrance.
function extractIsoDate(text) {
  const now = new Date();
  const minY = 2000, maxY = now.getFullYear() + 1;
  const pad2 = (n) => String(n).padStart(2, "0");
  const todayIso = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  const dates = [];
  const re = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  let m;
  const source = String(text || "");
  while ((m = re.exec(source))) {
    const yy = +m[1], mm = +m[2], dd = +m[3];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yy >= minY && yy <= maxY) {
      dates.push({ iso: m[1] + "-" + m[2] + "-" + m[3], idx: m.index });
    }
  }
  if (!dates.length) return "";
  const kw = /(D[ÉE]LIVR|[ÀA] JOUR AU|[ÉE]DIT[ÉE]? LE|[ÉE]TABLI LE|[ÉE]MISE? LE|FAIT [ÀA]? ?[A-Z ]*LE|EN DATE DU|DATE DE D[ÉE]LIVRANCE|EXTRAIT)/;
  const near = dates.filter((d) => kw.test(norm(source.slice(Math.max(0, d.idx - 55), d.idx))));
  if (near.length) return near.map((d) => d.iso).sort().reverse()[0];
  const past = dates.filter((d) => d.iso <= todayIso).map((d) => d.iso).sort();
  if (past.length) return past[past.length - 1];
  return dates.map((d) => d.iso).sort()[0];
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
// selon l'origine locale ou DocIE.
function mapDocieResult(docieResponse, { items, expectedName } = {}) {
  const text = resultToText(docieResponse && docieResponse.result);
  const item = (items || [])[0];
  const nameMatches = checkName(text, expectedName);
  const companyName = extractCompanyName(text) || (nameMatches ? expectedName : null);
  const issuedDate = extractIssuedDate(text) || extractIsoDate(text);
  const validation = docieResponse && docieResponse.metadata && docieResponse.metadata.validation;
  const validationFailed = !!(validation && validation.valid === false);
  const issues = [];
  if (validationFailed) issues.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
  if (nameMatches === false) issues.push("La société du document ne correspond pas au sous-traitant saisi.");
  if (!issuedDate) issues.push("Date de délivrance non trouvée dans le document.");
  return {
    documentType: "Extrait Kbis",
    matchedId: item ? item.id : null,
    isValid: !validationFailed,
    issuedDate,
    companyName,
    nameMatches,
    issues,
    summary: "Extrait Kbis" + (issuedDate ? " — délivré le " + issuedDate : "") + " (DocIE)",
  };
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
  resultToText,
  isEnabled,
  isEligible,
  ELIGIBLE_ITEM_ID,
  // Exportés pour réutilisation par d'autres consommateurs du bridge côté
  // contrats (ex. lib/docie-contract-import.js) : même flag DOCIE_EXTRACTION_ENABLED,
  // même chemin vers le module partagé, même détection MIME — pas de raison
  // de dupliquer ce câblage par kind de document.
  loadBridge,
  sniffMime,
};
