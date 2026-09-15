"use strict";
// Mapping structuré DocIE (schéma dynamique "rib") -> même forme que
// contrats/lib/docanalyze.js::analyzeDocumentLocal. Portage JS de
// document-parsing/mappings/rib_to_contrats.py (voir son en-tête : choix des
// quatre champs, pourquoi code banque / guichet / compte / clé RIB ne sont ni
// extraits ni dérivés).
//
// docieResult est le `result` DÉJÀ DÉBALLÉ par
// document-parsing/bridge/docie-bridge.js::unwrap(), comme pour kbis et urssaf.
//
// RÉUTILISATION : checkName vient de docanalyze.js, controlerIbanBic /
// messagesIbanBic de lib/iban-bic.js. Aucune copie ici — le test de
// rib-mapping.test.js vérifie l'identité des fonctions et l'absence de
// redéfinition dans ce fichier.
const { checkName } = require("./docanalyze");
const { controlerIbanBic, messagesIbanBic } = require("./iban-bic");

const DOCIE_SCHEMA_NAME = "rib";

// Libellé EXACT de docanalyze.js::detectType() pour cette pièce.
const DOCUMENT_TYPE_LABEL = "RIB";

const DOCANALYZE_BASE_KEYS = [
  "documentType", "matchedId", "isValid", "issuedDate",
  "companyName", "nameMatches", "issues", "summary",
];

// Champs DocIE "rib" -> clés camelCase NOUVELLES. account_holder alimente
// AUSSI companyName / nameMatches.
const MAPPED_FIELDS = {
  account_holder: "titulaireCompte",
  iban: "iban",
  bic: "bic",
  bank_name: "nomBanque",
};

const ENRICHED_KEYS = Object.values(MAPPED_FIELDS);

const IBAN_ABSENT = "IBAN non trouvé dans le document.";

function mapRibResult(docieResult, { expectedName, items, validation } = {}) {
  if (docieResult === null || typeof docieResult !== "object" || Array.isArray(docieResult)) {
    throw new Error("Résultat DocIE 'rib' invalide (objet attendu).");
  }
  const warnings = [];
  const enriched = {};
  for (const [docieKey, contratsKey] of Object.entries(MAPPED_FIELDS)) {
    const raw = docieResult[docieKey];
    enriched[contratsKey] = (raw === null || raw === undefined) ? "" : String(raw);
  }

  // IBAN mod-97 + format BIC (#194). Valeurs CONSERVÉES dans `iban` / `bic`.
  const controle = controlerIbanBic(docieResult.iban, docieResult.bic);
  const problemes = messagesIbanBic(controle);
  for (const probleme of problemes) warnings.push(probleme.champ + ": " + probleme.message);

  const rawHolder = docieResult.account_holder;
  const nameMatches = checkName(rawHolder, expectedName);
  let companyName = rawHolder ? String(rawHolder) : null;

  const item = (items || [])[0];
  const matchedId = (item && item.id === "rib") ? item.id : null;

  // Titulaire, IBAN et BIC tous absents : rien n'a été lu (#179 B1).
  const docieSaysInvalid = !!(validation && validation.valid === false);
  const nothingIdentifying = !rawHolder && !enriched.iban && !enriched.bic;
  const isValid = !(docieSaysInvalid || nothingIdentifying);

  let documentType, summary;
  let nameMatchesOut = nameMatches;
  const issues = [];
  if (nothingIdentifying) {
    documentType = "Document";
    companyName = null;
    nameMatchesOut = null;
    issues.push("Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.");
    summary = "Document illisible.";
  } else {
    documentType = DOCUMENT_TYPE_LABEL;
    if (docieSaysInvalid) issues.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
    if (nameMatches === false) issues.push("La société du document ne correspond pas au sous-traitant saisi.");
    // Dans `issues` : lib/docie-extraction.js ne garde que `analysis`. isValid
    // n'est pas touché, `controleIbanBic` porte le verdict par machine.
    if (!enriched.iban) issues.push(IBAN_ABSENT);
    for (const probleme of problemes) issues.push(probleme.message);
    // Pas de « Date de délivrance non trouvée » : un RIB n'en porte pas.
    summary = documentType;
  }

  for (const note of docieResult.extraction_notes || []) warnings.push("DocIE extraction_notes: " + note);
  if (validation) {
    for (const w of validation.warnings || []) warnings.push("DocIE validation.warnings: " + w);
    for (const e of validation.errors || []) warnings.push("DocIE validation.errors: " + e);
  }

  const analysis = {
    documentType, matchedId, isValid, issuedDate: "",
    companyName, nameMatches: nameMatchesOut, issues, summary,
  };
  Object.assign(analysis, enriched);
  // Verdict lisible par machine, HORS de ENRICHED_KEYS. Un consommateur
  // n'utilise `iban` / `bic` que si le statut vaut exactement "valide".
  analysis.controleIbanBic = controle;
  return { analysis, warnings };
}

module.exports = {
  DOCIE_SCHEMA_NAME,
  DOCUMENT_TYPE_LABEL,
  DOCANALYZE_BASE_KEYS,
  MAPPED_FIELDS,
  ENRICHED_KEYS,
  IBAN_ABSENT,
  mapRibResult,
  // Ré-exportés pour que les tests vérifient l'IDENTITÉ avec lib/iban-bic.js
  // et docanalyze.js (une copie identique aujourd'hui diverge demain).
  controlerIbanBic,
  messagesIbanBic,
  checkName,
};
