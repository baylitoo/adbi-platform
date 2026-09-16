"use strict";
// Mapping structuré DocIE (schéma dynamique "cni", pièce d'identité) -> même
// forme que contrats/lib/docanalyze.js::analyzeDocumentLocal, et même forme
// que lib/kbis-mapping.js, lib/urssaf-mapping.js et lib/rib-mapping.js : un
// consommateur pourra lire cette analyse sans cas particulier.
//
// Portage JS de document-parsing/mappings/cni_to_contrats.py (voir son
// en-tête : choix des dix champs, réserve « aucune carte réelle lue »,
// GAP_NOTES).
//
// POURQUOI la voie vision, et où c'est écrit : document-parsing/models/
// catalogue.json, tâche "cni" (clé `taches`), ne déclare qu'une voie, `agent`, avec
// NuExtract3 (« Vision. ») et pour `prerequis` « Contrôle des chiffres de la
// MRZ. » — une carte arrive en photo, sans couche texte. Le contrôle exigé est
// lib/mrz.js, requis ci-dessous.
//
// AUCUN CÂBLAGE ici : lib/docie-extraction.js ne route pas la pièce "cni" et
// ce module ne le change pas ; il n'en dépend pas non plus.
//
// docieResult est le `result` DÉJÀ DÉBALLÉ par
// document-parsing/bridge/docie-bridge.js::unwrap(), comme pour kbis, urssaf
// et rib. Aucun champ money.
//
// PAS DE COMPARAISON DE NOM, écart VOULU avec les trois autres paires : une
// carte d'identité porte une personne physique (le consultant), jamais la
// société sous-traitante, alors que `expectedName` vaut state.values.stNom.
// Comparer les deux rendrait false sur une carte parfaitement valable, donc le
// message bloquant « La société du document ne correspond pas au sous-traitant
// saisi. » sur une pièce juste. `companyName` et `nameMatches` restent null, et
// checkName n'est même pas requis. Le nom lu sort dans `nom` et `prenoms`.
//
// RÉUTILISATION — rien n'est recopié ici, tout est IMPORTÉ (tests/
// cni-mapping.test.js le vérifie par lecture du source et par témoin) :
// normalizeDate et DOCANALYZE_BASE_KEYS de kbis-mapping.js ; le contrôle des
// chiffres de la MRZ de mrz.js.
const { normalizeDate, DOCANALYZE_BASE_KEYS } = require("./kbis-mapping");
const { controlerMrz, messagesMrz } = require("./mrz");

const DOCIE_SCHEMA_NAME = "cni";

// Libellé EXACT de docanalyze.js::detectType() pour cette pièce (branche
// « CARTE NATIONALE D IDENTITE | PIECE D IDENTITE | PASSEPORT | TITRE DE
// SEJOUR ») : l'origine de l'analyse ne change pas le type affiché.
const DOCUMENT_TYPE_LABEL = "Pièce d'identité";

// Champs DocIE "cni" -> clés camelCase NOUVELLES. issue_date est traité à part
// (issuedDate).
const MAPPED_FIELDS = {
  surname: ["nom", "string"],
  given_names: ["prenoms", "string"],
  document_number: ["numeroDocument", "string"],
  nationality: ["nationalite", "string"],
  birth_date: ["dateNaissance", "date"],
  sex: ["sexe", "string"],
  expiry_date: ["dateExpiration", "date"],
  mrz_line1: ["mrzLigne1", "string"],
  mrz_line2: ["mrzLigne2", "string"],
};

const ENRICHED_KEYS = Object.values(MAPPED_FIELDS).map(([contratsKey]) => contratsKey);

const ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette.";

// `validation` est docieResponse.metadata.validation (le bridge la place là).
// `expectedName` est accepté pour garder la MÊME signature que les trois autres
// paires, et VOLONTAIREMENT ignoré (voir l'en-tête).
function mapCniResult(docieResult, { expectedName, items, validation } = {}) {
  if (docieResult === null || typeof docieResult !== "object" || Array.isArray(docieResult)) {
    throw new Error("Résultat DocIE 'cni' invalide (objet attendu).");
  }
  const warnings = [];
  const enriched = {};

  for (const [docieKey, [contratsKey, kind]] of Object.entries(MAPPED_FIELDS)) {
    const raw = docieResult[docieKey];
    if (kind === "date") enriched[contratsKey] = normalizeDate(raw, docieKey, warnings);
    else enriched[contratsKey] = (raw === null || raw === undefined) ? "" : String(raw);
  }

  // Chiffres de contrôle de la MRZ (prérequis du catalogue pour cette pièce).
  // Les lignes lues restent dans `mrzLigne1` / `mrzLigne2` : les vider ferait
  // basculer une carte lisible dans la branche « illisible » (#179 B1).
  const controleMrz = controlerMrz(docieResult.mrz_line1, docieResult.mrz_line2);
  const problemes = messagesMrz(controleMrz);
  // `champ` est déjà le nom DocIE de la ligne en cause (mrz_line1/2).
  for (const probleme of problemes) warnings.push(probleme.champ + ": " + probleme.message);

  const issuedDate = normalizeDate(docieResult.issue_date, "issue_date", warnings);

  // matchedId : port exact de detectType() — seul items[0] compte, et
  // uniquement si son id vaut "cni" (contrats/lib/checklist.js).
  const item = (items || [])[0];
  const matchedId = (item && item.id === "cni") ? item.id : null;

  // Même arbitrage que les trois autres paires (#179 B1). Les signaux
  // identifiants d'une pièce d'identité sont le nom du titulaire, le numéro du
  // titre et les deux lignes de MRZ — tous absents, il n'y a pas eu de lecture.
  // Le prénom seul, la nationalité seule ou le sexe seul n'identifient aucun
  // titre. Un validation.valid=false avec des champs bel et bien lus rend
  // l'extraction douteuse, pas illisible.
  const rawSurname = docieResult.surname;
  const docieSaysInvalid = !!(validation && validation.valid === false);
  const nothingIdentifying = !(rawSurname || enriched.numeroDocument || enriched.mrzLigne1 || enriched.mrzLigne2);
  const isValid = !(docieSaysInvalid || nothingIdentifying);

  let documentType, summary;
  let issuedDateOut = issuedDate;
  const issues = [];
  if (nothingIdentifying) {
    documentType = "Document";
    issuedDateOut = "";
    issues.push(ILLISIBLE);
    summary = "Document illisible.";
  } else {
    documentType = DOCUMENT_TYPE_LABEL;
    if (docieSaysInvalid) issues.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
    // Dans `issues` : lib/docie-extraction.js ne garde que `analysis`. isValid
    // n'est PAS touché, `controleMrz` porte le verdict par machine.
    for (const probleme of problemes) issues.push(probleme.message);
    // Pas de « Date de délivrance non trouvée » : lib/checklist.js ne déclare
    // PAS `dateField` pour la ligne "cni" — aucune validité n'est calculée à
    // partir de cette date.
    summary = documentType + (issuedDate ? " — délivré le " + issuedDate : "");
  }

  for (const note of docieResult.extraction_notes || []) warnings.push("DocIE extraction_notes: " + note);
  if (validation) {
    for (const w of validation.warnings || []) warnings.push("DocIE validation.warnings: " + w);
    for (const e of validation.errors || []) warnings.push("DocIE validation.errors: " + e);
  }

  const analysis = {
    documentType, matchedId, isValid, issuedDate: issuedDateOut,
    // Une carte d'identité ne porte pas de société : ces deux clés existent
    // pour rester un sur-ensemble de docanalyze.js, et valent toujours null.
    companyName: null, nameMatches: null, issues, summary,
  };
  // Les clés enrichies restent présentes MÊME dans la branche illisible : DocIE
  // peut avoir lu un champ isolé (la nationalité) sans avoir lu aucun signal
  // identifiant.
  Object.assign(analysis, enriched);
  // Verdict LISIBLE PAR MACHINE, présent dans les deux branches, HORS de
  // ENRICHED_KEYS (ce n'est pas un champ lu sur la carte). Un consommateur
  // n'utilise une valeur de la MRZ que si son statut vaut exactement "valide".
  analysis.controleMrz = controleMrz;

  return { analysis, warnings };
}

module.exports = {
  DOCIE_SCHEMA_NAME,
  DOCUMENT_TYPE_LABEL,
  DOCANALYZE_BASE_KEYS,
  MAPPED_FIELDS,
  ENRICHED_KEYS,
  ILLISIBLE,
  mapCniResult,
};
