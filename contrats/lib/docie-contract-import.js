"use strict";
// Pré-remplissage du formulaire d'import de contrat (contrats/lib/fields.js
// ::sousTraitance) depuis un document PDF/image existant, via le bridge
// DocIE partagé (document-parsing/bridge/), schéma "contract".
//
// Le schéma "contract" est déjà enregistré et vérifié côté DocIE (exécution
// réelle du 2026-09-04, document-parsing/scripts/register_and_test.py) et
// la conversion snake_case -> camelCase était déjà écrite et testée côté
// Python (document-parsing/mappings/contract_to_contrats.py) — mais RIEN ne
// l'appelait depuis ce service Node avant ce module : le schéma existait,
// mais n'était câblé nulle part côté contrats. Ce fichier est le portage JS
// de ce mapping (contrats est Node, pas Python) + son branchement réel sur
// POST /api/contracts/importer/extraire (server.js).
//
// Portée volontairement UN CRAN EN DESSOUS d'un import automatique : ce
// module ne fait QUE proposer des `values` pour relecture humaine dans le
// formulaire d'import existant (POST /api/contracts/importer) — jamais
// d'écriture en base directe. Comme lib/docie-extraction.js (issue #153),
// même prérequis serveur : DOCIE_EXTRACTION_ENABLED=true ET
// DOCIE_AGENT_CONTRACT configuré côté déploiement (le bridge échoue
// proprement sinon — voir configuration() dans
// document-parsing/bridge/docie-bridge.js). Contrairement au Kbis de la
// checklist, il n'existe AUCUNE analyse locale équivalente à 19 champs
// structurés (pdf-parse/tesseract.js ne fait que de l'OCR brut, aucun
// mapping de champs) : flag OFF ou config DocIE absente désactivent
// simplement cette fonctionnalité (repli = ressaisie manuelle du
// formulaire, le comportement d'aujourd'hui) — il n'y a pas de « repli
// local » à appeler ici, contrairement à analyzeDocument().
//
// Forme des champs consommés ici : le `result` DÉJÀ déballé par
// document-parsing/bridge/docie-bridge.js::unwrap(), PAS l'enveloppe brute
// {value, confidence, evidence_ids} que lit le module Python miroir
// (contract_to_contrats.py, qui lit l'enveloppe AVANT déballage bridge —
// ce module-là opère en amont du bridge, dans un contexte différent). Après
// unwrap() : un champ scalaire (string/date/number) devient sa valeur nue
// ou null ; un champ "money" (tjm) reste un objet {amount, currency, ...}
// (pas de clé "value" à son niveau racine, donc jamais déballé par unwrap
// — seuls ses sous-champs le sont, ce qui ne change rien pour des
// chaînes/nombres). Porter ce module en relisant seulement le fichier
// Python sans tenir compte de unwrap() produirait 19 champs vides,
// silencieusement (piège vérifié avant d'écrire ce fichier).
const { isEnabled, loadBridge, sniffMime } = require("./docie-extraction");

const DOCIE_KIND = "contract";

// Les 19 champs réellement extraits du document par le schéma DocIE
// "contract" (document-parsing/scripts/register_and_test.py, table
// SCHEMAS["contract"]), mappés 1-pour-1 vers
// contrats/lib/fields.js::sousTraitance. Clé = nom de champ snake_case
// DocIE (contournement du rejet HTTP 422 sur le camelCase, confirmé en
// conditions réelles par register_and_test.py) ; valeur = [clé camelCase
// contrats, type DocIE à désencapsuler].
const MAPPED_FIELDS = {
  numero_contrat: ["numeroContrat", "string"],
  date_redaction: ["dateRedaction", "date"],
  lieu_redaction: ["lieuRedaction", "string"],
  st_nom: ["stNom", "string"],
  st_adresse: ["stAdresse", "string"],
  st_siren: ["stSiren", "string"],
  st_siret: ["stSiret", "string"],
  st_representant: ["stRepresentant", "string"],
  st_forme_juridique: ["stFormeJuridique", "string"],
  st_qualite: ["stQualite", "string"],
  consultant_nom: ["consultantNom", "string"],
  consultant_fonction: ["consultantFonction", "string"],
  client_final: ["clientFinal", "string"],
  nature_travaux: ["natureTravaux", "string"],
  lieu_execution: ["lieuExecution", "string"],
  date_debut: ["dateDebut", "date"],
  date_fin: ["dateFin", "date"],
  tjm: ["tjm", "money"],
  delai_paiement: ["delaiPaiement", "number"],
};

// Constantes ADBI déjà portées par leur `default` dans fields.js —
// contrats/server.js::resolveBody les réapplique à CHAQUE rendu PDF/DOCX
// (Object.assign(defaults(type), values)) : les omettre ici est sans risque
// pour le rendu. Mais /api/contracts/importer, lui, stocke `values` TEL
// QUEL sans fusion des défauts à l'import — ce module ne les émet donc
// jamais, pour ne pas figer dans l'historique une valeur qui doit rester
// "vivante" (ex. si l'adresse ADBI change un jour dans fields.js).
const CONSTANT_FIELDS_NOT_FROM_DOCIE = new Set([
  "adbiNom", "adbiAdresse", "adbiCapital", "adbiRcs", "adbiRepresentant",
  "comptaContact", "comptaTel", "comptaEmail",
  "dureeNonSollicitation", "dureeExclusivite", "tribunal",
  "version",
]);

// GAP RÉEL : champs sousTraitance pour lesquels le schéma DocIE "contract"
// (tel qu'enregistré par register_and_test.py) n'a AUCUN champ
// correspondant. Signalé explicitement — jamais masqué derrière une valeur
// vide silencieuse. Laissés "" ; à compléter à la main tant que le schéma
// DocIE n'est pas étendu (travail côté DocIE, hors périmètre de ce module).
const GAP_FIELDS_NO_DOCIE_EQUIVALENT = {
  stEmail: "email du sous-traitant pour l'envoi en signature — absent du schéma DocIE 'contract'",
  stSignataireNom: "signataire réel si différent du représentant légal — distinction non capturée par le schéma",
  stSignataireQualite: "qualité du signataire réel — même lacune que stSignataireNom",
  consultantTel: "téléphone de l'intervenant — absent du schéma DocIE 'contract'",
  craValidePar: "responsable de validation des CRA côté client final — suivi ADBI, pas une info du contrat source",
  bmNom: "business manager ADBI en charge du suivi — info interne ADBI, jamais dans le document source",
  bmEmail: "email du business manager ADBI — idem",
  bmTel: "téléphone du business manager ADBI — idem",
};

// Union des trois catégories : doit correspondre EXACTEMENT aux 39 clés de
// contrats/lib/fields.js::sousTraitance (vérifié par
// tests/docie-contract-import.test.js en relisant fields.js en direct —
// garde-fou anti-dérive si fields.js change).
const ALL_ACCOUNTED_KEYS = new Set([
  ...Object.values(MAPPED_FIELDS).map(([contratsKey]) => contratsKey),
  ...CONSTANT_FIELDS_NOT_FROM_DOCIE,
  ...Object.keys(GAP_FIELDS_NO_DOCIE_EQUIVALENT),
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FR_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Le DateField de DocIE ne garantit pas l'ISO ("ISO-8601 quand possible")
// alors que contrats/lib/fields.js attend un <input type="date">
// (YYYY-MM-DD). ISO transparent ; DD/MM/YYYY converti ; tout le reste ->
// vide + avertissement (jamais de valeur injectée dans un champ date que le
// navigateur ne saura pas afficher).
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

// fields.js type "number" attend une chaîne numérique simple (ex: "420",
// "45"). Entier -> sans décimales ; sinon valeur telle quelle. Accepte un
// nombre JS natif ou une chaîne (l'agent DocIE, via l'API chat, ne
// sérialise pas forcément un Decimal en chaîne comme le ferait pydantic
// v2 côté studio — ne pas supposer une seule forme).
function normalizeNumber(raw, fieldKey, warnings) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  const asFloat = Number(s);
  if (!Number.isFinite(asFloat)) {
    warnings.push(fieldKey + ": nombre non reconnu (" + JSON.stringify(s) + "), reporté tel quel");
    return s;
  }
  return Number.isInteger(asFloat) ? String(asFloat) : String(asFloat);
}

function extractMoney(result, docieKey, warnings) {
  const wrapper = result[docieKey];
  if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper)) return "";
  const amount = wrapper.amount;
  const currency = wrapper.currency;
  if (amount === null || amount === undefined || amount === "") return "";
  if (currency && String(currency).toUpperCase() !== "EUR") {
    // contrats/lib/fields.js "tjm" est libellé "€ HT / jour" : pas de
    // colonne devise séparée dans le formulaire. On ne convertit pas (pas
    // de taux de change fiable à ce niveau) — on garde le montant brut et
    // on remonte l'écart pour vérification humaine.
    warnings.push(docieKey + ": devise " + JSON.stringify(currency) + " != EUR — fields.js suppose des euros, montant reporté tel quel sans conversion");
  }
  return normalizeNumber(amount, docieKey, warnings);
}

// docieResult est le `result` DÉJÀ déballé par docie-bridge.js::unwrap()
// (voir le commentaire d'en-tête) — pas l'enveloppe brute que lit
// contract_to_contrats.py.
function mapContractResult(docieResult) {
  if (docieResult === null || typeof docieResult !== "object" || Array.isArray(docieResult)) {
    throw new Error("Résultat DocIE 'contract' invalide (objet attendu).");
  }
  const warnings = [];
  const values = {};

  for (const [docieKey, [contratsKey, kind]] of Object.entries(MAPPED_FIELDS)) {
    if (kind === "money") {
      values[contratsKey] = extractMoney(docieResult, docieKey, warnings);
    } else if (kind === "date") {
      values[contratsKey] = normalizeDate(docieResult[docieKey], docieKey, warnings);
    } else if (kind === "number") {
      const raw = docieResult[docieKey];
      values[contratsKey] = raw === null || raw === undefined || raw === "" ? "" : normalizeNumber(raw, docieKey, warnings);
    } else {
      const raw = docieResult[docieKey];
      values[contratsKey] = raw === null || raw === undefined ? "" : String(raw);
    }
  }

  for (const note of docieResult.extraction_notes || []) {
    warnings.push("DocIE extraction_notes: " + note);
  }

  const errors = [];
  // Miroir exact des contrôles de contrats/server.js::POST /api/contracts/importer
  // (colonnesContrat + les deux `if` juste après) : autant échouer ici, avant
  // que l'utilisateur ne tente l'import avec un formulaire incomplet.
  if (!values.numeroContrat) errors.push("Le numéro du contrat est requis.");
  if (!values.stNom) errors.push("Le nom du sous-traitant / co-contractant est requis.");

  return { values, warnings, errors, ok: errors.length === 0 };
}

// Point d'entrée serveur (POST /api/contracts/importer/extraire). PAS de
// repli local (voir en-tête) : flag off ou config DocIE absente renvoient
// une erreur explicite avec un `code` stable, à charge du front de laisser
// le formulaire d'import vide (comportement actuel, rien de dégradé).
// Jamais d'appel à db.importerContrat ici — seulement des `values`
// proposées pour relecture humaine.
async function extractContractValues(body = {}, deps = {}) {
  const env = deps.env || process.env;
  if (!isEnabled(env)) {
    const err = new Error("Extraction DocIE désactivée (DOCIE_EXTRACTION_ENABLED=false) — saisie manuelle requise.");
    err.code = "disabled";
    throw err;
  }
  if (!body.dataBase64) {
    const err = new Error("Aucun fichier reçu.");
    err.code = "input";
    throw err;
  }
  const buffer = Buffer.from(body.dataBase64, "base64");
  const mime = sniffMime(body.mimeType, buffer);
  const { extractDocument } = deps.extractDocument ? deps : loadBridge();
  const options = { kind: DOCIE_KIND, env };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const response = await extractDocument(buffer, mime, options);
  const mapped = mapContractResult(response.result);
  return Object.assign({ requestId: (response.metadata && response.metadata.request_id) || null }, mapped);
}

module.exports = {
  extractContractValues,
  mapContractResult,
  MAPPED_FIELDS,
  CONSTANT_FIELDS_NOT_FROM_DOCIE,
  GAP_FIELDS_NO_DOCIE_EQUIVALENT,
  ALL_ACCOUNTED_KEYS,
  DOCIE_KIND,
};
