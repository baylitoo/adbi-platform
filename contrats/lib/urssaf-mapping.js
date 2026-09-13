"use strict";
// Mapping structuré DocIE (schéma dynamique "urssaf") -> même forme que
// contrats/lib/docanalyze.js::analyzeDocumentLocal, comme lib/kbis-mapping.js
// le fait déjà pour le schéma "kbis".
//
// Portage JS de document-parsing/mappings/urssaf_to_contrats.py (Python,
// testé — document-parsing/mappings/test_urssaf_to_contrats.py). Le schéma
// lui-même vit dans document-parsing/schemas/urssaf.schema.json et voyage
// dans le corps de la requête (`dynamic_schema` sur POST /v1/extract/text) :
// aucun enregistrement préalable dans le Studio DocIE n'est nécessaire —
// c'est précisément le point que l'issue #170 tenait pour un blocage.
//
// POURQUOI cette pièce et pas une autre des six non-Kbis : c'est la seule
// dont une valeur extraite pilote une vraie logique métier côté front.
// lib/checklist.js la déclare `dateField: true` / « À renouveler tous les
// 6 mois », et public/app.js::renderChecklistDocResult calcule PÉRIMÉ /
// bientôt périmé / valable à partir de `issuedDate`. Cette date venait
// jusqu'ici d'une devinette par regex sur du texte OCR local
// (docanalyze.js::extractIssuedDate, qui retient « la date la plus récente
// pas dans le futur » faute de mot-clé de délivrance à proximité).
//
// docieResult est le `result` DÉJÀ DÉBALLÉ par
// document-parsing/bridge/docie-bridge.js::unwrap() — même convention que
// lib/kbis-mapping.js (voir son en-tête) : un champ scalaire/date devient sa
// valeur nue (ou null si absent/non extrait) ; un champ "money"
// (declared_payroll) reste un objet {amount, currency, ...}.
//
// RÉUTILISATION DES NORMALISEURS PARTAGÉS : ce module n'écrit PAS sa propre
// copie de normalizeDate / normalizeNumber / checkName. Quatre copies
// indépendantes de ces règles ont déjà produit six divergences mesurées entre
// Python et JS (inventaire #179, lignes A2-A6 et B2-B3), corrigées en fixant
// la règle une seule fois dans document-parsing/fixtures/date_docie.json et
// nombre_docie.json. Une cinquième copie rouvrirait exactement cette porte.
// Elles sont donc IMPORTÉES de lib/kbis-mapping.js, qui les porte déjà pour
// le même couple de types (date de délivrance + montant) et vers la même
// forme de sortie.
//
// Leur place naturelle serait un module de normalisation dédié, requis par
// les cinq consommateurs. Ce déménagement n'est PAS fait ici : kbis-mapping.js
// et son miroir Python sont pris par un autre travail en vol (#182), et un
// module partagé se crée en touchant les fichiers d'où l'on déplace le code.
// Le require ci-dessous ne touche à aucun des deux.
const { checkName } = require("./docanalyze");
const { normalizeDate, normalizeNumber, MOTIF_NOMBRE, ANNEE_MIN, ANNEE_MAX } = require("./kbis-mapping");

const DOCIE_SCHEMA_NAME = "urssaf";

// Libellé EXACT de docanalyze.js::detectType() pour cette pièce (deux
// branches y mènent, toutes deux avec cette même chaîne) : l'origine de
// l'analyse ne doit pas changer le type affiché à l'utilisateur.
const DOCUMENT_TYPE_LABEL = "Attestation de vigilance URSSAF";

// Les 8 clés que docanalyze.js::analyzeDocumentLocal renvoie aujourd'hui.
// Ce module DOIT toujours les produire, avec la même sémantique.
const DOCANALYZE_BASE_KEYS = [
  "documentType", "matchedId", "isValid", "issuedDate",
  "companyName", "nameMatches", "issues", "summary",
];

// Champs DocIE "urssaf" mappés 1-pour-1 vers des clés camelCase NOUVELLES.
// company_name / issued_date / declared_payroll sont traités à part.
const MAPPED_FIELDS = {
  siren: ["siren", "string"],
  siret: ["siret", "string"],
  registered_address: ["adresseSiege", "string"],
  valid_until: ["dateValidite", "date"],
  security_code: ["codeSecurite", "string"],
  urssaf_agency: ["organismeUrssaf", "string"],
  employee_count: ["nombreSalaries", "number"],
};

const ENRICHED_KEYS = [
  ...Object.values(MAPPED_FIELDS).map(([contratsKey]) => contratsKey),
  "masseSalariale", "masseSalarialeDevise",
];

// Même politique que kbis-mapping.js::extractMoneyPair : montant ET devise
// conservés en 2 clés séparées plutôt que la devise silencieusement perdue.
function extractMoneyPair(result, docieKey, warnings) {
  const wrapper = result[docieKey];
  if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper)) return ["", ""];
  const amount = wrapper.amount;
  const currency = wrapper.currency;
  const amountOut = (amount === null || amount === undefined || amount === "") ? "" : normalizeNumber(amount, docieKey, warnings);
  const currencyOut = currency ? String(currency).toUpperCase() : "";
  if (currencyOut && currencyOut !== "EUR") {
    warnings.push(docieKey + ": devise " + JSON.stringify(currencyOut) + " != EUR — montant reporté tel quel sans conversion");
  }
  return [amountOut, currencyOut];
}

// docieResult est le `result` déjà déballé (voir en-tête). `validation` est
// docieResponse.metadata.validation (le bridge la place là, pas dans `result`).
function mapUrssafResult(docieResult, { expectedName, items, validation } = {}) {
  if (docieResult === null || typeof docieResult !== "object" || Array.isArray(docieResult)) {
    throw new Error("Résultat DocIE 'urssaf' invalide (objet attendu).");
  }
  const warnings = [];
  const enriched = {};

  for (const [docieKey, [contratsKey, kind]] of Object.entries(MAPPED_FIELDS)) {
    const raw = docieResult[docieKey];
    if (kind === "date") enriched[contratsKey] = normalizeDate(raw, docieKey, warnings);
    else if (kind === "number") enriched[contratsKey] = normalizeNumber(raw, docieKey, warnings);
    else enriched[contratsKey] = (raw === null || raw === undefined) ? "" : String(raw);
  }

  const [masseSalariale, masseSalarialeDevise] = extractMoneyPair(docieResult, "declared_payroll", warnings);

  const rawCompanyName = docieResult.company_name;
  const nameMatches = checkName(rawCompanyName, expectedName);
  let companyName = rawCompanyName ? String(rawCompanyName) : null;

  const issuedDate = normalizeDate(docieResult.issued_date, "issued_date", warnings);

  // matchedId : port exact de detectType() — seul items[0] compte, et
  // uniquement si son id vaut "urssaf".
  const item = (items || [])[0];
  const matchedId = (item && item.id === "urssaf") ? item.id : null;

  // Même arbitrage que kbis-mapping.js (inventaire de divergence #179, ligne
  // B1) : « extraction douteuse » et « document illisible » sont deux pannes
  // différentes. Les 3 champs identifiants d'une attestation de vigilance sont
  // le nom du cotisant, son SIREN et son SIRET — tous les trois absents, il
  // n'y a pas eu de lecture. Un validation.valid=false avec des champs bel et
  // bien lus rend l'extraction douteuse, pas illisible : les champs restent.
  const docieSaysInvalid = !!(validation && validation.valid === false);
  const nothingIdentifying = !rawCompanyName && !enriched.siren && !enriched.siret;
  const isValid = !(docieSaysInvalid || nothingIdentifying);

  let documentType, summary;
  let nameMatchesOut = nameMatches;
  let issuedDateOut = issuedDate;
  const issues = [];
  if (nothingIdentifying) {
    // Miroir exact de la branche "Aucun texte lisible" de analyzeDocumentLocal.
    documentType = "Document";
    companyName = null;
    nameMatchesOut = null;
    issuedDateOut = "";
    issues.push("Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.");
    summary = "Document illisible.";
  } else {
    documentType = DOCUMENT_TYPE_LABEL;
    if (docieSaysInvalid) issues.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
    if (nameMatches === false) issues.push("La société du document ne correspond pas au sous-traitant saisi.");
    // Message identique à celui de docanalyze.js : même panne vue par
    // l'utilisateur, avec ici une conséquence précise — sans date de
    // délivrance, la validité 6 mois ne se calcule pas.
    if (!issuedDate) issues.push("Date de délivrance non trouvée dans le document.");
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
  // Les clés enrichies restent présentes MÊME dans la branche illisible :
  // même raison que kbis-mapping.js.
  Object.assign(analysis, enriched);
  analysis.masseSalariale = masseSalariale;
  analysis.masseSalarialeDevise = masseSalarialeDevise;

  return { analysis, warnings };
}

module.exports = {
  DOCIE_SCHEMA_NAME,
  DOCUMENT_TYPE_LABEL,
  DOCANALYZE_BASE_KEYS,
  MAPPED_FIELDS,
  ENRICHED_KEYS,
  mapUrssafResult,
  // Ré-exportés pour que les tests de ce portage puissent vérifier qu'ils
  // pointent bien sur les mêmes règles partagées que les quatre autres.
  MOTIF_NOMBRE,
  ANNEE_MIN,
  ANNEE_MAX,
};
