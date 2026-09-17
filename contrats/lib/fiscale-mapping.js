"use strict";
// Mapping structuré DocIE (schéma dynamique "fiscale", attestation de
// régularité fiscale) -> même forme que contrats/lib/docanalyze.js::
// analyzeDocumentLocal, et même forme que lib/urssaf-mapping.js : la checklist
// pourra consommer cette analyse sans cas particulier.
//
// Portage JS de document-parsing/mappings/fiscale_to_contrats.py (voir son
// en-tête : choix des sept champs, réserve « aucune attestation réelle lue »,
// GAP_NOTES). Voie texte (#194 : LFM2.5-2.6B par défaut, LFM2.5-350M derrière
// les contrôles de plausibilité de date). Le câblage dans
// lib/docie-extraction.js est fait depuis #215 (VOIES + PIECES_TEXTE) ; il
// avait été différé le temps que la PR #214 quitte ce fichier.
//
// docieResult est le `result` DÉJÀ DÉBALLÉ par
// document-parsing/bridge/docie-bridge.js::unwrap(), comme pour kbis, urssaf
// et rib. Aucun champ money.
//
// RÉUTILISATION — rien n'est recopié ici, tout est IMPORTÉ (tests/
// fiscale-mapping.test.js le vérifie par lecture du source et par témoin) :
// checkName (règle nom_docie.json) de docanalyze.js ; normalizeDate et
// DOCANALYZE_BASE_KEYS de kbis-mapping.js ; le validateur SIREN/SIRET de
// siren-siret.js ; le contrôle de dates de date-plausible.js.
const { checkName } = require("./docanalyze");
const { normalizeDate, DOCANALYZE_BASE_KEYS } = require("./kbis-mapping");
const { controlerSirenSiret, messagesSirenSiret } = require("./siren-siret");
const { controlerDates, messagesDates, ABSENT } = require("./date-plausible");

const DOCIE_SCHEMA_NAME = "fiscale";

// Nom de champ DocIE sous lequel chaque numéro est lu (avertissements).
const CHAMPS_SIREN_SIRET = { siren: "siren", siret: "siret" };

// Libellé EXACT de docanalyze.js::detectType() pour cette pièce.
const DOCUMENT_TYPE_LABEL = "Attestation de régularité fiscale";

// Champs DocIE "fiscale" -> clés camelCase NOUVELLES. company_name /
// issued_date sont traités à part (companyName / issuedDate).
const MAPPED_FIELDS = {
  siren: ["siren", "string"],
  siret: ["siret", "string"],
  tax_office: ["serviceImpots", "string"],
  situation_date: ["dateSituation", "date"],
  regularity_statement: ["mentionRegularite", "string"],
};

const ENRICHED_KEYS = Object.values(MAPPED_FIELDS).map(([contratsKey]) => contratsKey);

// Contrôle de plausibilité des dates (#194) : ordre d'affichage, libellés en
// minuscules, et la situation attestée ne peut pas suivre la délivrance.
// Aucune des deux dates ne peut être dans le futur. Mêmes valeurs que
// `libelles` / `ordre` / `futur_admis` de date_plausible.json.
const LIBELLES_DATES = { issued_date: "date de délivrance", situation_date: "date de situation" };
const ORDRE_DATES = [["situation_date", "issued_date"]];

const DATE_ABSENTE = "Date de délivrance non trouvée dans le document.";
const ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.";

// `validation` est docieResponse.metadata.validation (le bridge la place là).
// `aujourdhui` : date du jour AAAA-MM-JJ du contrôle « date dans le futur »,
// date locale si absent ; les tests la figent.
function mapFiscaleResult(docieResult, { expectedName, items, validation, aujourdhui } = {}) {
  if (docieResult === null || typeof docieResult !== "object" || Array.isArray(docieResult)) {
    throw new Error("Résultat DocIE 'fiscale' invalide (objet attendu).");
  }
  const warnings = [];
  const enriched = {};

  for (const [docieKey, [contratsKey, kind]] of Object.entries(MAPPED_FIELDS)) {
    const raw = docieResult[docieKey];
    if (kind === "date") enriched[contratsKey] = normalizeDate(raw, docieKey, warnings);
    else enriched[contratsKey] = (raw === null || raw === undefined) ? "" : String(raw);
  }

  // Clé de Luhn du SIREN / SIRET (#194), même intégration que urssaf / kbis.
  const controleSirenSiret = controlerSirenSiret(docieResult.siren, docieResult.siret);
  const problemesSiren = messagesSirenSiret(controleSirenSiret);
  for (const probleme of problemesSiren) warnings.push(CHAMPS_SIREN_SIRET[probleme.champ] + ": " + probleme.message);

  const rawCompanyName = docieResult.company_name;
  const nameMatches = checkName(rawCompanyName, expectedName);
  let companyName = rawCompanyName ? String(rawCompanyName) : null;

  const issuedDate = normalizeDate(docieResult.issued_date, "issued_date", warnings);

  // Plausibilité des dates (#194). Une date future ou incohérente est
  // CONSERVÉE dans issuedDate / dateSituation : `controleDates` dit si un
  // consommateur peut s'en servir (statut exactement "plausible").
  const valeursDates = {};
  for (const champ of Object.keys(LIBELLES_DATES)) valeursDates[champ] = docieResult[champ] ?? null;
  const controleDates = controlerDates(valeursDates, { ordre: ORDRE_DATES, aujourdhui });
  const problemesDates = messagesDates(controleDates, LIBELLES_DATES, { ordre: ORDRE_DATES });
  for (const probleme of problemesDates) warnings.push(probleme.champ + ": " + probleme.message);

  const item = (items || [])[0];
  const matchedId = (item && item.id === "fiscale") ? item.id : null;

  // Même arbitrage que urssaf / kbis (#179 B1).
  const docieSaysInvalid = !!(validation && validation.valid === false);
  const nothingIdentifying = !rawCompanyName && !enriched.siren && !enriched.siret;
  const isValid = !(docieSaysInvalid || nothingIdentifying);

  let documentType, summary;
  let nameMatchesOut = nameMatches;
  let issuedDateOut = issuedDate;
  const issues = [];
  if (nothingIdentifying) {
    documentType = "Document";
    companyName = null;
    nameMatchesOut = null;
    issuedDateOut = "";
    issues.push(ILLISIBLE);
    summary = "Document illisible.";
  } else {
    documentType = DOCUMENT_TYPE_LABEL;
    if (docieSaysInvalid) issues.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
    if (nameMatches === false) issues.push("La société du document ne correspond pas au sous-traitant saisi.");
    // Dans `issues` : lib/docie-extraction.js ne garde que `analysis`.
    for (const probleme of problemesSiren) issues.push(probleme.message);
    for (const probleme of problemesDates) issues.push(probleme.message);
    // Seule l'ABSENCE garde le message de docanalyze.js : une date lue mais
    // illisible, impossible ou future a déjà son message nommé.
    if (controleDates.issued_date.statut === ABSENT) issues.push(DATE_ABSENTE);
    summary = documentType + (issuedDate ? " — délivré le " + issuedDate : "");
  }

  for (const note of docieResult.extraction_notes || []) warnings.push("DocIE extraction_notes: " + note);
  if (validation) {
    for (const w of validation.warnings || []) warnings.push("DocIE validation.warnings: " + w);
    for (const e of validation.errors || []) warnings.push("DocIE validation.errors: " + e);
  }

  const analysis = {
    documentType, matchedId, isValid, issuedDate: issuedDateOut,
    companyName, nameMatches: nameMatchesOut, issues, summary,
  };
  Object.assign(analysis, enriched);
  // Verdicts LISIBLES PAR MACHINE, présents dans les deux branches, HORS de
  // ENRICHED_KEYS (ce ne sont pas des champs lus sur l'attestation).
  analysis.controleSirenSiret = controleSirenSiret;
  analysis.controleDates = controleDates;

  return { analysis, warnings };
}

module.exports = {
  DOCIE_SCHEMA_NAME,
  DOCUMENT_TYPE_LABEL,
  DOCANALYZE_BASE_KEYS,
  MAPPED_FIELDS,
  ENRICHED_KEYS,
  LIBELLES_DATES,
  ORDRE_DATES,
  mapFiscaleResult,
};
