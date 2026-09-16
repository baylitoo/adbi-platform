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
const path = require("path");
const { isEnabled, loadBridge, sniffMime, coucheTexteUtilisable, signauxPartielsPublics } = require("./docie-extraction");
const choixModele = require("./choix-modele");

// Définition du schéma "contract" pour la voie TEXTE (#194). Sur
// /v1/extract/text, `schema_name` seul ne résout que le petit registre intégré
// de DocIE (document-parsing/scripts/register_and_test.py) : la définition doit
// voyager dans la requête, comme pour l'URSSAF. Mêmes 19 champs que ceux
// enregistrés côté Studio pour l'agent. Chargée paresseusement, seulement quand
// un modèle est choisi.
const SCHEMA_CONTRAT_PATH = path.join(__dirname, "..", "..", "document-parsing", "schemas", "contract.schema.json");
// Contrôle de clé du SIREN / SIRET (#194), écrit une seule fois pour les deux
// mappings JS (portage de document-parsing/mappings/siren_siret.py).
const { controlerSirenSiret, messagesSirenSiret } = require("./siren-siret");

const DOCIE_KIND = "contract";

// Nom de champ DocIE sous lequel chaque numéro est lu (avertissements).
const CHAMPS_SIREN_SIRET = { siren: "st_siren", siret: "st_siret" };

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

// Champ DocIE de premier niveau -> clé contrats : rattache un signal de résultat
// partiel (#203, `tjm.amount` -> `tjm`) au champ du modal à marquer.
const CLES_CONTRATS = Object.fromEntries(Object.entries(MAPPED_FIELDS).map(([docie, [cle]]) => [docie, cle]));

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
// requiert ce fichier au démarrage, et l'image Docker de contrats n'embarque
// aujourd'hui que document-parsing/bridge et document-parsing/schemas — pas
// document-parsing/fixtures. Un require en tête de fichier empêcherait donc le
// service de démarrer. Table absente : la date écrite sort vide avec un
// avertissement qui NOMME la cause, plutôt qu'un « non reconnue » trompeur.
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

// Le DateField de DocIE ne garantit pas l'ISO ("ISO-8601 quand possible")
// alors que contrats/lib/fields.js attend un <input type="date">
// (YYYY-MM-DD). ISO transparent ; DD/MM/YYYY converti ; date écrite en toutes
// lettres (« le 12 mars 2019 ») lue via la table de mois partagée ; tout le
// reste -> vide + avertissement (jamais de valeur injectée dans un champ date
// que le navigateur ne saura pas afficher).
//
// Règle partagée : document-parsing/fixtures/date_docie.json. Les deux motifs
// ne comptent que des chiffres, jamais leurs bornes : « 01/13/2026 »
// ressortait en « 2026-13-01 » et « 45/02/2026 » en « 2026-02-45 », ici comme
// dans les trois autres portages, sans un seul avertissement (inventaire de
// divergence #179, lignes A8 et A9 — le rare cas où Python et JS sont
// d'accord ET tous les deux faux). Le navigateur refuse silencieusement une
// telle valeur dans <input type="date"> : le champ s'affiche VIDE et la date
// est perdue sans erreur, si bien que la panne ressemble à « DocIE n'a rien
// trouvé ». Une date hors calendrier ou hors fenêtre est désormais refusée
// explicitement, avec un avertissement DISTINCT de « date non reconnue » :
// les deux pannes ne se corrigent pas de la même façon. Elle n'est jamais
// réparée ni tronquée — pas de 2026-02-28 pour un 30 février.
function normalizeDate(raw, fieldKey, warnings) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  // Un champ réduit à des espaces est un champ vide : « champ vu, rien
  // trouvé », même règle que normalizeNumber. Avertir ici noierait les vrais
  // avertissements sous un « date non reconnue ("") ».
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
      // Troisième voie (#179 A10) : le mot doit être une clé de la table
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
// caractère au littéral Python (document-parsing/mappings/
// contract_to_contrats.py::MOTIF_NOMBRE) et au champ `motif` de
// document-parsing/fixtures/nombre_docie.json, que les tests des deux côtés
// comparent à ce littéral : ajouter une forme d'un seul côté casse le test de
// l'autre service. [0-9] et non \d parce que \d reconnaît aussi les chiffres
// arabes-indiens en Python et pas en JS ; l'exponentielle est refusée parce
// que son rendu diverge entre les deux langages.
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

// fields.js type "number" attend une chaîne numérique simple (ex: "420",
// "45"). Accepte un nombre JS natif ou une chaîne (l'agent DocIE, via l'API
// chat, ne sérialise pas forcément un Decimal en chaîne comme le ferait
// pydantic v2 côté studio — ne pas supposer une seule forme).
//
// Règle partagée : document-parsing/fixtures/nombre_docie.json. Ce module
// s'en remettait à Number(), qui accepte des textes que float() côté Python
// refuse — et inversement — d'où six des neuf écarts mesurés de l'inventaire
// #179. Number("") vaut 0 et 0 est fini : un champ réduit à des espaces
// ressortait en « 0 » (un délai de paiement de 0 jour, un TJM de 0 €,
// fabriqués de toutes pièces) ; Number("0x1e") rendait « 30 ».
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
// contract_to_contrats.py. `validation` est docieResponse.metadata.validation,
// que le pont range là (et PAS dans `result`, contrairement à l'enveloppe
// brute que lit le module Python) : même convention d'appel que
// lib/kbis-mapping.js::mapKbisResult.
function mapContractResult(docieResult, { validation } = {}) {
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

  // Clé de Luhn du SIREN / SIRET (#194, règle « échouer bruyamment ») : un
  // seul chiffre mal lu passait jusqu'ici le seul contrôle existant, de
  // format. La valeur lue reste dans `values` (un relecteur la corrige d'un
  // chiffre) ; l'échec part en avertissement nommé et dans
  // `controleSirenSiret`. Avertissements placés AVANT les notes DocIE : le
  // front n'affiche que les premiers.
  const controleSirenSiret = controlerSirenSiret(docieResult.st_siren, docieResult.st_siret);
  for (const probleme of messagesSirenSiret(controleSirenSiret)) {
    warnings.push(CHAMPS_SIREN_SIRET[probleme.champ] + ": " + probleme.message);
  }

  for (const note of docieResult.extraction_notes || []) {
    warnings.push("DocIE extraction_notes: " + note);
  }
  // Ce que DocIE dit lui-même de son extraction. Le front affiche les trois
  // premiers `warnings` sous le formulaire pré-rempli (public/app.js) : s'en
  // priver, c'est cacher au relecteur le seul signal que le service a émis
  // sur sa propre confiance. Le module Python miroir les reporte depuis
  // toujours ; ce portage les jetait (inventaire de divergence #179, A1).
  if (validation) {
    for (const w of validation.warnings || []) warnings.push("DocIE validation.warnings: " + w);
    for (const e of validation.errors || []) warnings.push("DocIE validation.errors: " + e);
  }

  const errors = [];
  // Miroir exact des contrôles de contrats/server.js::POST /api/contracts/importer
  // (colonnesContrat + les deux `if` juste après) : autant échouer ici, avant
  // que l'utilisateur ne tente l'import avec un formulaire incomplet.
  if (!values.numeroContrat) errors.push("Le numéro du contrat est requis.");
  if (!values.stNom) errors.push("Le nom du sous-traitant / co-contractant est requis.");

  // `controleSirenSiret` vit à côté de `values`, jamais dedans : `values` doit
  // rester exactement les champs de fields.js::sousTraitance, que
  // /api/contracts/importer stocke tels quels. Il traverse
  // extractContractValues (Object.assign) jusqu'à la réponse HTTP. Un numéro
  // invalide n'est PAS une erreur bloquante : `errors` reste le miroir des
  // contrôles de l'import. Un consommateur n'utilise stSiren / stSiret que si
  // le statut vaut exactement "valide".
  return { values, warnings, errors, ok: errors.length === 0, controleSirenSiret };
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
  // Modèle choisi (#194) : voie texte avec CE modèle, sinon échec nommé. Sans
  // `modele`, la suite est le chemin d'avant, inchangé (agent DOCIE_AGENT_CONTRACT).
  const modele = choixModele.demandeModele(body);
  if (modele !== null) return extraireParModele(buffer, mime, modele, env, deps);
  const { extractDocument } = deps.extractDocument ? deps : loadBridge();
  const options = { kind: DOCIE_KIND, env };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const response = await extractDocument(buffer, mime, options);
  const metadata = response.metadata || {};
  const mapped = mapContractResult(response.result, { validation: metadata.validation });
  // Résultat partiel (#203, #194), sur les deux voies : `partiel` (avec la clé
  // contrats du champ) et `troncaturePossible`, seulement s'ils sont présents.
  return Object.assign({ requestId: metadata.request_id || null }, mapped, signauxPartielsPublics(metadata, { cles: CLES_CONTRATS }));
}

// Contrat lu par un modèle choisi dans le catalogue (#194).
//
// Voie TEXTE uniquement : NuExtract3 en vision échoue en 400 à la 9e page, et
// un contrat en fait souvent plus. La couche texte est lue localement avec le
// même garde que l'URSSAF (lib/docie-extraction.js::coucheTexteUtilisable) :
// une page sans texte signale un scan, et un texte amputé donnerait une
// extraction confiante et fausse (clauses de fin, dates de signature). Contrat
// scanné -> échec `scan` : aucune voie propre, saisie manuelle — jamais l'agent
// en repli, qui serait un autre modèle que celui annoncé.
//
// Ordre : modèle configuré (sans lire le PDF), couche texte, puis règle des 800
// lignes non vides sur le texte réellement envoyé. `modele` du résultat : le
// modèle que DocIE dit avoir servi (metadata.model), pas celui demandé.
async function extraireParModele(buffer, mime, modele, env, deps) {
  choixModele.verifierDemande(DOCIE_KIND, modele, { env });
  const lecture = await (deps.coucheTexteUtilisable || coucheTexteUtilisable)(buffer, mime);
  if (!lecture.ok) throw new choixModele.ErreurChoixModele("scan");
  const choisi = choixModele.choisirPourTexte(DOCIE_KIND, modele, lecture.texte, { env });
  const { extractText } = deps.extractText ? deps : loadBridge();
  const options = {
    kind: DOCIE_KIND,
    dynamicSchema: deps.dynamicSchema || require(SCHEMA_CONTRAT_PATH),
    modelProfile: choisi.identifiant,
    // Langue du document (voir docie-bridge.js::extractText). Le pont n'a pas
    // de défaut : « ce document est en français » est une connaissance métier,
    // et c'est ICI qu'elle est vraie — un contrat de sous-traitance ADBI est
    // rédigé en français. Sans ce champ, le prompt de DocIE lit « Language:
    // unknown ».
    //
    // À ne PAS généraliser aux CV : leur langue n'est pas connue avant lecture,
    // et annoncer « fr » sur un CV anglais serait une affirmation fausse au
    // modèle là où « unknown » est vraie. cv-parser et one-pager s'abstiennent
    // donc volontairement.
    langue: "fr",
    env,
  };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const response = await extractText(lecture.texte, options);
  const metadata = response.metadata || {};
  const mapped = mapContractResult(response.result, { validation: metadata.validation });
  return Object.assign({ requestId: metadata.request_id || null }, mapped, {
    modele: choixModele.modeleServiPublic(DOCIE_KIND, metadata, { env }),
  }, signauxPartielsPublics(metadata, { cles: CLES_CONTRATS }));
}

module.exports = {
  extractContractValues,
  SCHEMA_CONTRAT_PATH,
  mapContractResult,
  MAPPED_FIELDS,
  CONSTANT_FIELDS_NOT_FROM_DOCIE,
  GAP_FIELDS_NO_DOCIE_EQUIVALENT,
  ALL_ACCOUNTED_KEYS,
  DOCIE_KIND,
  MOTIF_NOMBRE,
  normalizeNumber,
  ANNEE_MIN,
  ANNEE_MAX,
  normalizeDate,
  MOTIF_DATE_ECRITE,
  tableMois,
};
