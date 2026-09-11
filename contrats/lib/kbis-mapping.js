"use strict";
// Mapping structuré DocIE (schéma "kbis") -> même forme que
// contrats/lib/docanalyze.js::analyzeDocumentLocal, comme
// lib/docie-contract-import.js le fait déjà pour le schéma "contract".
//
// Portage JS de document-parsing/mappings/kbis_to_contrats.py (Python,
// testé — document-parsing/mappings/test_kbis_to_contrats.py) : ce module
// Python confirme le contrat de champs réel de l'agent DocIE "kbis" (11
// champs, document-parsing/scripts/register_and_test.py, PR #46, commit de
// référence 6e30bc6 — vérifié contre docie_bench/schemas/{common,dynamic}.py
// dans le checkout local small-doc-ie-bench) et le mappe déjà vers cette
// même forme de sortie, avec des fixtures générées depuis les vrais modèles
// pydantic DocIE (document-parsing/mappings/fixtures/generate_kbis_sample.py).
//
// Remplace l'ancienne stratégie de lib/docie-extraction.js (mapDocieResult
// v1, issue #153) : « aplatir le JSON DocIE en texte et repasser les regex
// locales dessus », documentée à l'époque comme provisoire faute d'un
// contrat de champs kbis documenté et testé. Ce contrat existe désormais
// (ce module) — l'aplatissement perdait purement et simplement SIREN,
// SIRET, forme juridique, capital social, RCS, adresse du siège,
// représentant légal et date d'immatriculation ; ce module les restitue.
//
// docieResult est le `result` DÉJÀ DÉBALLÉ par
// document-parsing/bridge/docie-bridge.js::unwrap() (même convention que
// lib/docie-contract-import.js, voir son en-tête pour le détail) : un champ
// scalaire/date devient sa valeur nue (ou null si absent/non extrait) ; un
// champ "money" (share_capital) reste un objet {amount, currency, ...} (pas
// de clé "value" à son niveau racine, donc jamais déballé par unwrap()).
//
// Gaps réels non couverts par le schéma DocIE "kbis" (qualité du
// représentant non isolée de son nom, libellé de l'objet social, greffe non
// isolé du numéro RCS, établissements secondaires, durée de la personne
// morale) : voir kbis_to_contrats.py::GAP_NOTES pour le détail — non
// dupliqué ici, ce module se contente de ne PAS inventer ces champs.
const { checkName } = require("./docanalyze");

// ---------------------------------------------------------------------------
// Les 8 clés que contrats/lib/docanalyze.js::analyzeDocumentLocal renvoie
// aujourd'hui (les deux branches de retour utilisent le même jeu de clés).
// Ce module DOIT toujours les produire, avec la même sémantique, pour rester
// un sur-ensemble valide côté /api/document/analyze (server.js).
// ---------------------------------------------------------------------------
const DOCANALYZE_BASE_KEYS = [
  "documentType", "matchedId", "isValid", "issuedDate",
  "companyName", "nameMatches", "issues", "summary",
];

// ---------------------------------------------------------------------------
// Champs DocIE "kbis" réellement extraits du document, mappés 1-pour-1 vers
// des clés camelCase NOUVELLES (absentes de docanalyze.js — l'enrichissement
// visé). company_name / issued_date / share_capital sont traités à part
// (voir mapKbisResult) : les deux premiers alimentent directement
// companyName/issuedDate (clés docanalyze.js), le troisième produit 2 clés
// (capitalSocial + capitalSocialDevise).
// ---------------------------------------------------------------------------
const MAPPED_FIELDS = {
  siren: ["siren", "string"],
  siret_siege: ["siret", "string"],
  legal_form: ["formeJuridique", "string"],
  registration_date: ["dateImmatriculation", "date"],
  rcs_number: ["rcsNumber", "string"],
  registered_address: ["adresseSiege", "string"],
  activity_code: ["codeActivite", "string"],
  legal_representative: ["representantLegal", "string"],
};

const ENRICHED_KEYS = [
  ...Object.values(MAPPED_FIELDS).map(([contratsKey]) => contratsKey),
  "capitalSocial", "capitalSocialDevise",
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FR_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Même politique que lib/docie-contract-import.js::normalizeDate (et son
// origine Python, kbis_to_contrats.py::_normalize_date) : ISO transparent,
// DD/MM/YYYY converti, sinon vide + avertissement — jamais de valeur brute
// injectée dans un champ date.
function normalizeDate(raw, fieldKey, warnings) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  if (ISO_DATE_RE.test(s)) return s;
  const m = FR_DATE_RE.exec(s);
  if (m) {
    const [, d, mo, y] = m;
    return y + "-" + mo.padStart(2, "0") + "-" + d.padStart(2, "0");
  }
  warnings.push(fieldKey + ": date non reconnue (" + JSON.stringify(s) + "), laissée vide — à corriger manuellement");
  return "";
}

function normalizeNumber(raw, fieldKey, warnings) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  const asFloat = Number(s);
  if (!Number.isFinite(asFloat)) {
    warnings.push(fieldKey + ": nombre non reconnu (" + JSON.stringify(s) + "), reporté tel quel");
    return s;
  }
  // Number(...) normalise déjà "5000.00" -> 5000 et String(5000) -> "5000"
  // (pas de zéros ou décimale superflus) : un seul chemin de retour suffit
  // (contrairement à kbis_to_contrats.py, où raw_s garde sa forme d'origine
  // tant que int(as_float) n'est pas explicitement reformé en chaîne).
  return String(asFloat);
}

// Contrairement à lib/docie-contract-import.js::extractMoney (qui doit
// aplatir vers le champ "number" unique `tjm`), capitalSocial n'a pas de
// contrainte de forme préexistante — montant ET devise sont donc conservés
// comme 2 clés séparées plutôt que la devise silencieusement abandonnée.
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
// docieResponse.metadata.validation (déjà extraite côté appelant — le
// bridge la place là, pas dans `result`, contrairement à l'enveloppe brute
// que lit kbis_to_contrats.py côté Python).
function mapKbisResult(docieResult, { expectedName, items, validation } = {}) {
  if (docieResult === null || typeof docieResult !== "object" || Array.isArray(docieResult)) {
    throw new Error("Résultat DocIE 'kbis' invalide (objet attendu).");
  }
  const warnings = [];
  const enriched = {};

  for (const [docieKey, [contratsKey, kind]] of Object.entries(MAPPED_FIELDS)) {
    const raw = docieResult[docieKey];
    enriched[contratsKey] = kind === "date"
      ? normalizeDate(raw, docieKey, warnings)
      : (raw === null || raw === undefined ? "" : String(raw));
  }

  const [capitalSocial, capitalSocialDevise] = extractMoneyPair(docieResult, "share_capital", warnings);

  const rawCompanyName = docieResult.company_name;
  const nameMatches = checkName(rawCompanyName, expectedName);
  let companyName = rawCompanyName ? String(rawCompanyName) : null;

  const issuedDate = normalizeDate(docieResult.issued_date, "issued_date", warnings);

  // matchedId : port exact de detectType() — seul items[0] compte, et
  // uniquement si son id vaut "kbis".
  const item = (items || [])[0];
  const matchedId = (item && item.id === "kbis") ? item.id : null;

  // Les 3 champs les plus identifiants (nom, SIREN, SIRET) tous absents ->
  // mime le "Document illisible" de docanalyze.js (DocIE n'a structurellement
  // rien pu lire d'exploitable, au même titre qu'un OCR local qui ne renvoie
  // presque pas de texte).
  //
  // DIVERGENCE ASSUMÉE avec kbis_to_contrats.py (qui, lui, vise la parité
  // stricte avec docanalyze.js et traite aussi validation.valid===false
  // comme "illisible") : docanalyze.js n'a AUCUNE notion de validation DocIE
  // à imiter, donc cette analogie n'a pas de justification de parité ici.
  // Un validation.valid=false avec des champs identifiants bel et bien
  // extraits (ex: nom + SIREN présents, mais DocIE signale une incohérence
  // ailleurs) ne doit pas jeter ces champs au visage de l'utilisateur avec
  // un message "PDF scanné sans texte" trompeur — comportement du module JS
  // AVANT ce portage (issue #153), conservé ici : les champs restent, mais
  // isValid=false + avertissement explicite.
  const docieSaysInvalid = !!(validation && validation.valid === false);
  const nothingIdentifying = !rawCompanyName && !enriched.siren && !enriched.siret;
  const isValid = !(docieSaysInvalid || nothingIdentifying);

  let documentType, summary;
  let nameMatchesOut = nameMatches;
  let issuedDateOut = issuedDate;
  const issues = [];
  if (nothingIdentifying) {
    // Miroir exact de la branche "Aucun texte lisible" de
    // analyzeDocumentLocal (mêmes clés, mêmes valeurs par défaut).
    documentType = "Document";
    companyName = null;
    nameMatchesOut = null;
    issuedDateOut = "";
    issues.push("Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.");
    summary = "Document illisible.";
  } else {
    documentType = "Extrait Kbis";
    if (docieSaysInvalid) issues.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
    if (nameMatches === false) issues.push("La société du document ne correspond pas au sous-traitant saisi.");
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
  // Les clés enrichies restent présentes MÊME dans la branche "illisible" :
  // DocIE peut avoir extrait des champs isolés (ex: legal_form) alors même
  // qu'aucun des 3 signaux identifiants n'a été lu — les jeter perdrait une
  // information réelle sans bénéfice de parité (ces clés n'existent de
  // toute façon pas côté docanalyze.js).
  Object.assign(analysis, enriched);
  analysis.capitalSocial = capitalSocial;
  analysis.capitalSocialDevise = capitalSocialDevise;

  return { analysis, warnings };
}

module.exports = {
  DOCANALYZE_BASE_KEYS,
  MAPPED_FIELDS,
  ENRICHED_KEYS,
  mapKbisResult,
};
