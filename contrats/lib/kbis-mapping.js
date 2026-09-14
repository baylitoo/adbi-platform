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
const path = require("path");
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

// Bornes de date PARTAGÉES avec les trois autres portages du mapping, fixées
// dans document-parsing/fixtures/date_docie.json (champs `annee_min` /
// `annee_max`), que les tests des deux côtés comparent à ces deux constantes.
// 1950-2100 n'est pas un chiffre tiré au sort : c'est la fenêtre d'années
// déjà retenue ailleurs dans le dépôt pour la même question (#176), et en
// adopter une seconde ici créerait exactement le genre de divergence que
// recense #179. Le faux positif assumé — l'immatriculation d'une société
// antérieure à 1950 — sort en avertissement citant la valeur brute, jamais
// en valeur perdue ni fabriquée ; la fenêtre attrape en échange l'OCR à
// quatre chiffres du genre « 0202-05-14 », qu'un <input type="date"> accepte
// sans broncher en affichant l'an 202.
const ANNEE_MIN = 1950;
const ANNEE_MAX = 2100;

const JOURS_PAR_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function estBissextile(annee) {
  return annee % 4 === 0 && (annee % 100 !== 0 || annee % 400 === 0);
}

// Le triplet désigne-t-il une date réelle, dans la fenêtre d'années retenue ?
// Bornes écrites à la main plutôt que déléguées à `new Date()`, qui reporte
// silencieusement un 30 février au 2 mars — ce qui FABRIQUERAIT une date au
// lieu de la refuser — et dont les années 0-99 basculent en 1900+. La règle
// complète est écrite dans `_regle` côté fixture.
function dateExiste(annee, mois, jour) {
  if (annee < ANNEE_MIN || annee > ANNEE_MAX) return false;
  if (mois < 1 || mois > 12) return false;
  const dernier = mois === 2 && estBissextile(annee) ? 29 : JOURS_PAR_MOIS[mois - 1];
  return jour >= 1 && jour <= dernier;
}

// Table des noms de mois PARTAGÉE (#179 lignes A10/B10) : LUE dans
// document-parsing/fixtures/date_mission.json, jamais recopiée. Quatre copies
// indépendantes de ce normaliseur ont produit les divergences de #179 ; une
// table écrite à la main ici en serait une de plus. C'est la table déjà lue
// par one-pager/lib/normalize.js. Seule la TABLE est partagée, pas la règle
// de date_mission.json, qui rend un mois là où <input type="date"> exige un
// jour (voir `_ecart_assume_avec_date_mission` dans date_docie.json).
//
// Chargée PARESSEUSEMENT, et jamais au chargement du module : server.js
// remonte jusqu'ici par lib/docie-extraction.js, et l'image Docker de contrats
// n'embarque aujourd'hui que document-parsing/bridge et document-parsing/schemas
// — pas document-parsing/fixtures. Un require en tête de fichier empêcherait
// donc le service de démarrer. Table absente : la date écrite sort vide avec
// un avertissement qui NOMME la cause, plutôt qu'un « non reconnue » trompeur.
const TABLE_MOIS_CHEMIN = path.join(__dirname, "..", "..", "document-parsing", "fixtures", "date_mission.json");
let tableMoisCache; // undefined : pas encore cherchée ; null : introuvable
function tableMois() {
  if (tableMoisCache === undefined) {
    try {
      tableMoisCache = require(TABLE_MOIS_CHEMIN).mois;
    } catch (err) {
      if (!err || err.code !== "MODULE_NOT_FOUND") throw err;
      tableMoisCache = null;
    }
  }
  return tableMoisCache;
}

// Date écrite en toutes lettres (« le 12 mars 2019 ») — motif PARTAGÉ,
// identique caractère pour caractère au champ `motif_date_ecrite` de
// date_docie.json et aux trois autres portages. [0-9]/[a-z] et séparateurs
// énumérés plutôt que \d/\s, que Python et JS ne définissent pas pareil.
const MOTIF_DATE_ECRITE = "^(?:le[ \\t\\n\\r\\u00a0]+)?([0-9]{1,2})[ \\t\\n\\r\\u00a0]+([a-z]{3,10})\\.?[ \\t\\n\\r\\u00a0]+([0-9]{4})$";
const DATE_ECRITE_RE = new RegExp(MOTIF_DATE_ECRITE);

// Minuscules, NFD, marques U+0300–U+036F retirées : la forme sous laquelle le
// mot du mois est cherché dans la table (clés désaccentuées). Même bloc que
// le portage Python, qui ne retire volontairement pas davantage (#179 B11).
function formeEcrite(texte) {
  return texte.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Même politique que lib/docie-contract-import.js::normalizeDate (et son
// origine Python, kbis_to_contrats.py::_normalize_date) : ISO transparent,
// DD/MM/YYYY converti, date écrite en toutes lettres lue via la table de mois
// partagée, sinon vide + avertissement — jamais de valeur brute injectée dans
// un champ date.
//
// Règle partagée : document-parsing/fixtures/date_docie.json. Les deux motifs
// ne comptent que des chiffres, jamais leurs bornes : « 01/13/2026 »
// ressortait en « 2026-13-01 » et « 45/02/2026 » en « 2026-02-45 », ici comme
// dans les trois autres portages, sans un seul avertissement (inventaire de
// divergence #179, lignes A8 et A9 — le rare cas où Python et JS sont
// d'accord ET tous les deux faux). Un navigateur refuse silencieusement une
// telle valeur dans <input type="date"> : le champ de la checklist s'affiche
// VIDE et la date de délivrance est perdue sans erreur, si bien que la panne
// ressemble à « DocIE n'a rien trouvé ». Une date hors calendrier ou hors
// fenêtre est désormais refusée explicitement, avec un avertissement DISTINCT
// de « date non reconnue ». Elle n'est jamais réparée ni tronquée — pas de
// 2026-02-28 pour un 30 février.
function normalizeDate(raw, fieldKey, warnings) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  // Un champ réduit à des espaces est un champ vide : « champ vu, rien
  // trouvé », même règle que normalizeNumber.
  if (s === "") return "";
  let annee = null;
  let mois = null;
  let jour = null;
  if (ISO_DATE_RE.test(s)) {
    annee = Number(s.slice(0, 4));
    mois = Number(s.slice(5, 7));
    jour = Number(s.slice(8, 10));
  } else {
    const m = FR_DATE_RE.exec(s);
    if (m) {
      annee = Number(m[3]);
      mois = Number(m[2]);
      jour = Number(m[1]);
    } else {
      // Troisième voie (#179 B10) : le mot doit être une clé de la table
      // partagée, sinon rien n'est lu et la date reste « non reconnue ». Un
      // jour ou une année hors bornes est en revanche LU, et tombe donc dans
      // « date impossible » ci-dessous, comme par les deux autres voies.
      const e = DATE_ECRITE_RE.exec(formeEcrite(s));
      if (e) {
        const table = tableMois();
        if (table === null) {
          warnings.push(fieldKey + ": date en toutes lettres (" + JSON.stringify(s) + ") laissée vide — table des mois introuvable ("
            + TABLE_MOIS_CHEMIN + ") ; à corriger manuellement");
          return "";
        }
        if (Object.hasOwn(table, e[2])) {
          annee = Number(e[3]);
          mois = table[e[2]];
          jour = Number(e[1]);
        }
      }
    }
  }
  if (annee === null) {
    warnings.push(fieldKey + ": date non reconnue (" + JSON.stringify(s) + "), laissée vide — à corriger manuellement");
    return "";
  }
  if (!dateExiste(annee, mois, jour)) {
    warnings.push(
      fieldKey + ": date impossible (" + JSON.stringify(s) + "), laissée vide — jour/mois hors calendrier ou année hors "
      + ANNEE_MIN + "-" + ANNEE_MAX + " ; à corriger manuellement"
    );
    return "";
  }
  return String(annee).padStart(4, "0") + "-" + String(mois).padStart(2, "0") + "-" + String(jour).padStart(2, "0");
}

// « Ce texte est-il un nombre ? » — motif PARTAGÉ, identique caractère pour
// caractère au littéral de lib/docie-contract-import.js, à celui des deux
// modules Python miroirs, et au champ `motif` de
// document-parsing/fixtures/nombre_docie.json, que les tests des quatre
// portages comparent à ce littéral : ajouter une forme d'un seul côté casse
// le test des autres. [0-9] et non \d parce que \d reconnaît aussi les
// chiffres arabes-indiens en Python et pas en JS ; l'exponentielle est
// refusée parce que son rendu diverge entre les deux langages.
const MOTIF_NOMBRE = "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$";
const NOMBRE_RE = new RegExp(MOTIF_NOMBRE);

// Mise en forme PUREMENT LEXICALE d'un texte déjà reconnu par NOMBRE_RE :
// jamais d'aller-retour par le nombre du langage, dont le rendu diffère
// (String(1e16) rend "10000000000000000", str(1e16) rend "1e+16" côté
// Python). Voir `_regle_forme` dans la fixture partagée.
function formeNombre(texte) {
  const negatif = texte.startsWith("-");
  const corps = (texte.startsWith("+") || negatif) ? texte.slice(1) : texte;
  const point = corps.indexOf(".");
  const entier = (point === -1 ? corps : corps.slice(0, point)).replace(/^0+/, "") || "0";
  const frac = (point === -1 ? "" : corps.slice(point + 1)).replace(/0+$/, "");
  const sortie = entier + (frac ? "." + frac : "");
  return negatif && sortie !== "0" ? "-" + sortie : sortie;
}

// Règle partagée : document-parsing/fixtures/nombre_docie.json. Ce module
// s'en remettait à Number(), le module Python miroir à float(), et les deux
// n'acceptent pas les mêmes textes — inventaire de divergence #179, lignes
// B2/B3. Number("") vaut 0 et 0 est fini : un montant réduit à des espaces
// ressortait en « 0 » (un capital social de 0 € fabriqué de toutes pièces).
function normalizeNumber(raw, fieldKey, warnings) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  // Un champ réduit à des espaces est un champ vide : « champ vu, rien
  // trouvé », même traitement que {"value": null}.
  if (s === "") return "";
  if (!NOMBRE_RE.test(s)) {
    warnings.push(fieldKey + ": nombre non reconnu (" + JSON.stringify(s) + "), reporté tel quel");
    return s;
  }
  return formeNombre(s);
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
  // Un validation.valid=false avec des champs identifiants bel et bien
  // extraits (ex: nom + SIREN présents, mais DocIE signale une incohérence
  // ailleurs) ne doit PAS jeter ces champs au visage de l'utilisateur avec
  // un message "PDF scanné sans texte" trompeur : l'extraction est douteuse,
  // pas illisible. Comportement du module JS avant ce portage (issue #153),
  // conservé ici : les champs restent, mais isValid=false + avertissement
  // explicite. kbis_to_contrats.py, qui confondait les deux signaux, s'est
  // aligné sur cette règle (inventaire de divergence #179, ligne B1) — les
  // deux portages ne divergent plus.
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
  MOTIF_NOMBRE,
  normalizeNumber,
  ANNEE_MIN,
  ANNEE_MAX,
  normalizeDate,
  MOTIF_DATE_ECRITE,
  tableMois,
  // Exporté pour lib/urssaf-mapping.js, qui l'importe au lieu d'en porter une
  // copie (même discipline que urssaf_to_contrats.py côté Python).
  extractMoneyPair,
};
