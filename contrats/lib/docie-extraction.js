"use strict";
// Extraction DocIE (bridge partagé document-parsing/bridge/) pour les pièces
// Kbis, URSSAF, RIB et attestation de régularité fiscale de la checklist
// Sous-traitance — issues #153, #170 et #215.
// Derrière DOCIE_EXTRACTION_ENABLED (défaut absent/false) :
// flag off => comportement inchangé, 100% lib/docanalyze.js local (pdf-parse
// + tesseract.js, RGPD, aucun envoi externe). Les mappings de champs contrat,
// la génération PDF/DOCX et la signature Yousign/Zoho ne sont pas touchés ici.
//
// QUATRE pièces sont couvertes, par DEUX voies DocIE différentes — et ce n'est
// pas un détail d'implémentation, c'est ce qui décide si la pièce est
// couvrable du tout :
//
//   kbis   -> voie AGENT (extractDocument, POST /v1/agents/<agent>/chat/...)
//             Le document part en data URI et les backends OCR de DocIE le
//             lisent. L'agent résout son schéma PAR NOM, donc un schéma
//             enregistré au préalable dans le Studio DocIE.
//             Kbis « choisi par type d'entrée » (#194, PIECES_PAR_TYPE) : dès
//             qu'un modèle du catalogue est en jeu, un PDF à couche texte
//             complète part sur la voie TEXTE (kbis.schema.json), une photo ou
//             un scan sur la voie agent. Rien de configuré : agent d'avant.
//   urssaf  -> voie TEXTE (extractText, POST /v1/extract/text)
//   rib        La DÉFINITION du schéma voyage dans le corps de la requête
//   fiscale    (`dynamic_schema`, document-parsing/schemas/<pièce>.schema.json).
//              Rien n'a à être enregistré côté Studio.
//
// L'issue #170 tenait « créer le schéma dans le Studio » pour un préalable aux
// six pièces non-Kbis. Ce n'est vrai que du premier mécanisme. Le second
// n'exige aucune action côté DocIE ni aucun appel distant pour être mis en
// place ; cv-parser l'emploie en mode `inline` depuis toujours.
//
// Les trois pièces restantes (cni, coordonnees, specifique) restent analysées
// localement, flag ou pas — mais PAS toutes pour la même raison, et l'ancienne
// formule « elles n'ont ni schéma ni mapping » était fausse :
//   - coordonnees, specifique : ni schéma ni mapping, en effet. Ce sont des
//     champs de saisie de la checklist, pas des documents à lire.
//   - cni : le schéma (cni.schema.json) et la paire de mapping
//     (lib/cni-mapping.js, document-parsing/mappings/cni_to_contrats.py)
//     EXISTENT. La pièce n'est pas routée ici parce que le catalogue
//     (document-parsing/models/catalogue.json, tâche "cni") la donne par la
//     voie VISION, avec pour prérequis le contrôle des chiffres de la MRZ —
//     lib/mrz.js, qui est le consommateur actuel de ce mapping.
//
// urssaf a été traitée en premier parce que c'est la seule dont une valeur
// extraite pilote une vraie logique métier — lib/checklist.js la déclare
// `dateField: true` / « À renouveler tous les 6 mois », et
// public/app.js::renderChecklistDocResult calcule PÉRIMÉ / bientôt périmé /
// valable à partir de `issuedDate`. rib a suivi (#194) : son IBAN et son BIC
// sont contrôlés (lib/iban-bic.js), condition posée pour y admettre un petit
// modèle — un IBAN mal lu d'un caractère ressemble exactement à un IBAN juste.
//
// fiscale ferme la voie texte (#215) : son schéma et sa paire de mapping
// étaient écrits, testés des deux côtés et pourtant INATTEIGNABLES, le câblage
// ayant été différé le temps que la PR #214 (depuis fusionnée) quitte ce
// fichier. Aucun sélecteur de modèle ne lui est ajouté : elle reste hors de
// lib/choix-modele.js::TACHES, donc lue par le profil DocIE par défaut.
//
// RÉSERVE à connaître : la checklist n'offre pas encore de bouton pour cette
// pièce. Le bouton « Analyser le document (OCR) » est posé sous `dateField`
// (public/app.js), or fiscale n'a pas de `dateField` — ce n'est pas un
// document à renouveler tous les 6 mois. Elle n'est donc atteignable que par
// POST /api/document/analyze, comme le RIB avant son propre bouton
// (ajouterAnalyseRib).
//
// Mapping des champs : lib/kbis-mapping.js, lib/urssaf-mapping.js,
// lib/rib-mapping.js et lib/fiscale-mapping.js, portages JS de
// document-parsing/mappings/{kbis,urssaf,rib,fiscale}_to_contrats.py.

const path = require("path");
const { PDFParse } = require("pdf-parse");
const { analyzeDocumentLocal } = require("./docanalyze");
const { mapKbisResult } = require("./kbis-mapping");
const { mapUrssafResult } = require("./urssaf-mapping");
const { mapRibResult } = require("./rib-mapping");
const { mapFiscaleResult } = require("./fiscale-mapping");
const choixModele = require("./choix-modele");
const { mapperErreur } = require("./taches-extraction");

// Conservé tel quel (exporté historiquement) : la pièce de la voie agent.
const ELIGIBLE_ITEM_ID = "kbis";
const DOCIE_KIND = "kbis";

// Quelle voie DocIE pour quelle pièce de la checklist. Une pièce absente de
// cette table n'est jamais envoyée, flag ou pas.
const VOIES = { kbis: "agent", urssaf: "texte", rib: "texte", fiscale: "texte" };

// Chemin relatif volontaire (et non un package npm local) : le bridge reste
// une source partagée dans document-parsing/bridge/ (cf. son README, « ne pas
// copier manuellement ces fichiers dans les modules »). En checkout monorepo,
// ../../document-parsing/bridge est le vrai dossier partagé. Dans l'image
// Docker de ce service, le Dockerfile copie ce même dossier à la racine du
// système de fichiers de l'image (/document-parsing/bridge) — même profondeur
// relative depuis contrats/lib, donc même chemin ici dans les deux cas.
const BRIDGE_PATH = path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js");

// Transport des modèles HORS ADBI (#194, #217), voisin du bridge dans le même
// dossier partagé — donc déjà dans l'image (contrats/Dockerfile copie le
// dossier ENTIER, `COPY --from=bridge .`). Même chemin relatif, même require
// paresseux : sans clé OpenAI, aucun modèle externe n'est proposé et ce module
// n'est jamais chargé.
const OPENAI_PATH = path.join(__dirname, "..", "..", "document-parsing", "bridge", "openai-responses.js");

// Même raisonnement de chemin que BRIDGE_PATH : document-parsing/schemas/ est
// une source partagée hors de contrats/, copiée à la même profondeur relative
// dans l'image Docker (voir Dockerfile, contexte de build "schemas" : le
// dossier ENTIER, donc rib.schema.json aussi).
// Le schéma est chargé PARESSEUSEMENT, pour la même raison que le bridge : le
// flag désactivé ne doit jamais dépendre de la présence d'un fichier partagé.
const SCHEMAS_DIR = path.join(__dirname, "..", "..", "document-parsing", "schemas");
const SCHEMA_URSSAF_PATH = path.join(SCHEMAS_DIR, "urssaf.schema.json");
const SCHEMA_RIB_PATH = path.join(SCHEMAS_DIR, "rib.schema.json");
const SCHEMA_FISCALE_PATH = path.join(SCHEMAS_DIR, "fiscale.schema.json");
// Mêmes 11 champs, même ordre, mêmes descriptions que le schéma `kbis` enregistré
// pour l'agent (document-parsing/scripts/register_and_test.py::SCHEMAS["kbis"]) :
// les deux voies lisent la même définition, donc le même mapping s'applique.
const SCHEMA_KBIS_PATH = path.join(SCHEMAS_DIR, "kbis.schema.json");

// Pièces de la voie TEXTE : schéma envoyé dans le corps, mapping du résultat.
// Le Kbis y figure pour sa voie texte : la réponse plate de /v1/extract/text,
// déballée par le bridge, a la même forme que le `result` de l'agent, et passe
// par le même mapKbisResult (controleSirenSiret, issues, clés enrichies).
const PIECES_TEXTE = {
  urssaf: { schemaPath: SCHEMA_URSSAF_PATH, mapper: mapUrssafResult },
  rib: { schemaPath: SCHEMA_RIB_PATH, mapper: mapRibResult },
  fiscale: { schemaPath: SCHEMA_FISCALE_PATH, mapper: mapFiscaleResult },
  kbis: { schemaPath: SCHEMA_KBIS_PATH, mapper: mapKbisResult },
};

// Pièces dont la voie se décide sur le fichier reçu (#194, Kbis : PDF à couche
// texte -> LFM2.5 2.6B en voie texte ; photo ou scan -> NuExtract3 en vision).
// VOIES garde pour elles la voie d'avant le catalogue ("agent"), celle qui
// s'applique tant qu'aucun modèle de la voie texte n'est configuré.
const PIECES_PAR_TYPE = Object.freeze({ kbis: true });

function isEnabled(env = process.env) {
  return String((env || {}).DOCIE_EXTRACTION_ENABLED || "").trim().toLowerCase() === "true";
}

// Port exact de detectType() : seul items[0] compte.
function pieceDemandee(items) {
  const item = (items || [])[0];
  return (item && item.id) ? String(item.id) : null;
}

function isEligible(items) {
  return Object.hasOwn(VOIES, pieceDemandee(items) || "");
}

function voiePour(items) {
  const id = pieceDemandee(items);
  return (id && Object.hasOwn(VOIES, id)) ? VOIES[id] : null;
}

// require() paresseux : le flag désactivé (comportement par défaut) ne doit
// jamais dépendre de la présence du module partagé sur le disque — packaging
// Docker distinct (voir Dockerfile), require résolu seulement à l'appel.
function loadBridge() {
  return require(BRIDGE_PATH);
}

// Même raisonnement que loadBridge() : chargé seulement quand un modèle externe
// a été explicitement choisi.
function loadOpenAI() {
  return require(OPENAI_PATH);
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

// Résultat partiel (#203, #194) : faits de l'extraction relevés par le bridge,
// rendus lisibles au navigateur sur TOUTES les voies DocIE, choix de modèle ou
// non. `metadata.partiel = [{champ, raison}]` -> `partiel` ; `metadata.
// troncature_possible === true` -> `troncaturePossible: true`. Clés ajoutées
// seulement s'il y a quelque chose à dire : sans signal (ou métadonnées
// absentes : analyse locale, réponse d'avant #203), la sortie est inchangée.
// Raison gardée même inconnue : un libellé ajouté côté bridge doit s'afficher,
// pas disparaître. `cles` (contrat) : champ DocIE de premier niveau -> clé
// contrats, pour marquer le bon champ du modal.
function signauxPartielsPublics(metadata, { cles = null } = {}) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  const sortie = {};
  const partiel = (Array.isArray(m.partiel) ? m.partiel : [])
    .filter((p) => p && typeof p === "object" && typeof p.champ === "string" && p.champ && typeof p.raison === "string" && p.raison)
    .map((p) => {
      const entree = { champ: p.champ, raison: p.raison };
      const racine = p.champ.split(/[.[]/)[0];
      if (cles && Object.hasOwn(cles, racine)) entree.cle = cles[racine];
      return entree;
    });
  if (partiel.length) sortie.partiel = partiel;
  if (m.troncature_possible === true) sortie.troncaturePossible = true;
  // `sans_preuve` (#194, modèles externes) : le transport OpenAI ne rend NI
  // `evidence_ids` NI confiance par champ (document-parsing/bridge/
  // openai-responses.js). Aucun champ n'est donc « vérifié » par l'extraction :
  // c'est tout le résultat qui est à relire, pas tel ou tel champ. Sans cette
  // clé, la sortie d'un modèle externe ressemblerait EXACTEMENT à celle d'un
  // modèle DocIE ancré — `partiel` y est vide et `troncature_possible` faux,
  // donc rien d'autre ne s'afficherait.
  if (m.sans_preuve === true) sortie.sansPreuve = true;
  return sortie;
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
  // Voie agent : `partiel` lu par le bridge ; `troncature_possible` y vaut null
  // (non mesurable), donc jamais de ligne de troncature pour le Kbis.
  return Object.assign(analysis, signauxPartielsPublics(docieResponse && docieResponse.metadata));
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

// ---------------------------------------------------------------------------
// Voie TEXTE (urssaf, rib, fiscale — et le Kbis quand il est « choisi par type
// d'entrée », #194). Le choix de la voie se fait À L'EXÉCUTION sur le document
// réellement reçu, JAMAIS en dur sur le type de pièce.
//
// « Une attestation URSSAF (ou un RIB) est un PDF avec couche texte » est une
// attente, pas une mesure : aucun document réel n'était disponible. Câbler
// « urssaf => voie texte » enverrait donc, le jour où un utilisateur dépose un
// scan, une chaîne vide ou trois caractères d'en-tête à DocIE — qui répondrait
// quelque chose, et ce quelque chose alimenterait la validité 6 mois (ou un
// IBAN). Le départage est donc structurel : la couche texte existe-t-elle,
// ici, sur ce fichier-ci.
//
// Garde repris de cv-parser/docie_client.py, qui refuse explicitement un PDF
// dont UNE page est sans texte (« PDF contenant une page sans texte : OCR
// requis ») : une page muette signale un scan (ou une page image), et un texte
// amputé produirait une extraction confiante et fausse — le pire cas possible
// pour une date de délivrance, qu'aucune relecture humaine ne rattrape
// (contrairement à un montant aberrant).
//
// Une image (PNG/JPEG/WebP) n'a par construction pas de couche texte : elle
// part directement en analyse locale, SANS OCR de routage. Faire tourner
// tesseract.js juste pour décider coûterait plusieurs secondes et, à la
// première utilisation, un téléchargement de modèle — pour une réponse déjà
// connue.
// ---------------------------------------------------------------------------

// Lit la couche texte d'un PDF, localement, sans OCR. Renvoie le texte joint
// et la liste des pages muettes.
async function lireCoucheTexte(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const r = await parser.getText();
    const pages = Array.isArray(r.pages) ? r.pages : [];
    return { texte: String(r.text || ""), pages };
  } finally {
    try { await parser.destroy(); } catch (e) {}
  }
}

const MIMES_IMAGE = new Set(["image/png", "image/jpeg", "image/webp"]);

// Même verdict que coucheTexteUtilisable, plus le nombre de pages quand il est
// connu (`pages` : 1 pour une image, celui du PDF lu, null sinon) — la limite de
// la vision (8 pages, catalogue) se vérifie sur ce nombre, sans seconde lecture.
async function lireDocument(buffer, mime) {
  if (mime !== "application/pdf") {
    return { ok: false, raison: "le document n'est pas un PDF (image : pas de couche texte)", pages: MIMES_IMAGE.has(mime) ? 1 : null };
  }
  let lecture;
  try {
    lecture = await lireCoucheTexte(buffer);
  } catch (e) {
    return { ok: false, raison: "PDF illisible ou protégé", pages: null };
  }
  const pages = lecture.pages.length;
  if (!pages) return { ok: false, raison: "PDF sans page lisible", pages: null };
  const muettes = lecture.pages.filter((p) => !String(p.text || "").trim());
  if (muettes.length) {
    return {
      ok: false,
      raison: "PDF contenant une page sans texte (page " + (muettes[0].num ?? "?") + ") : scan, OCR requis",
      pages,
    };
  }
  if (!lecture.texte.trim()) return { ok: false, raison: "PDF sans texte exploitable : scan, OCR requis", pages };
  return { ok: true, texte: lecture.texte, pages };
}

// Le document reçu peut-il alimenter la voie texte ? Renvoie {ok, texte} ou
// {ok:false, raison} — la raison est reprise telle quelle dans l'avertissement
// rendu à l'utilisateur, pour que le repli soit diagnosticable.
async function coucheTexteUtilisable(buffer, mime) {
  const { pages, ...verdict } = await lireDocument(buffer, mime);
  return verdict;
}

function chargerSchema(kind) {
  return require(PIECES_TEXTE[kind].schemaPath);
}

function chargerSchemaUrssaf() {
  return chargerSchema("urssaf");
}

// Même forme de sortie que analyzeDocumentLocal, enrichie — voir
// lib/urssaf-mapping.js et lib/rib-mapping.js. Marqueur « (DocIE) » identique
// à celui du Kbis.
function mapTexteDocieResult(kind, docieResponse, { items, expectedName } = {}) {
  const validation = docieResponse && docieResponse.metadata && docieResponse.metadata.validation;
  const { analysis } = PIECES_TEXTE[kind].mapper(docieResponse && docieResponse.result, { expectedName, items, validation });
  if (analysis.documentType !== "Document" && analysis.summary) {
    analysis.summary += " (DocIE)";
  }
  // Voie texte : `partiel` et `troncature_possible` (blocs comptés par
  // extractText sur le texte envoyé), choix de modèle ou non.
  return Object.assign(analysis, signauxPartielsPublics(docieResponse && docieResponse.metadata));
}

function mapUrssafDocieResult(docieResponse, options) {
  return mapTexteDocieResult("urssaf", docieResponse, options);
}

// Renvoie l'analyse DocIE, ou null si le document n'a pas de couche texte
// exploitable — dans ce cas l'appelant retombe sur l'analyse locale en
// nommant `raisonRepli`. Ne renvoie JAMAIS une extraction sur un texte vide.
async function extractViaTexte(kind, { dataBase64, mimeType, items, expectedName, modele = null } = {}, deps = {}) {
  if (!Object.hasOwn(PIECES_TEXTE, kind || "")) throw new Error("Pièce sans voie texte : " + kind);
  if (!dataBase64) throw new Error("Aucun fichier reçu.");
  const env = deps.env || process.env;
  const buffer = Buffer.from(dataBase64, "base64");
  const mime = sniffMime(mimeType, buffer);
  const verdict = await coucheTexteUtilisable(buffer, mime);
  if (!verdict.ok) return { analysis: null, raisonRepli: verdict.raison };
  const analysis = await extraireTexteLu(kind, verdict.texte, { items, expectedName, modele }, deps);
  return { analysis, raisonRepli: null };
}

// Extraction d'un texte DÉJÀ lu et jugé complet (voir coucheTexteUtilisable).
// `profilSansChoix` : identifiant du modèle par défaut quand aucun modèle n'a
// été choisi (Kbis, #194) ; aucune clé `modele` n'est alors ajoutée — la réponse
// garde la forme « sans choix », repli local compris.
async function extraireTexteLu(kind, texte, { items, expectedName, modele = null, profilSansChoix = null } = {}, deps = {}) {
  const env = deps.env || process.env;
  const options = { kind, dynamicSchema: (deps.dynamicSchema || chargerSchema(kind)), env };
  // Modèle choisi (#194) : vérifié sur le texte lu, envoyé tel quel, jamais
  // remplacé. Seules les pièces à sélecteur (lib/choix-modele.js::TACHES) en
  // acceptent un ; pour les autres, un `modele` reçu est refusé, nommé.
  const choisi = modele !== null ? choixModele.choisirPourTexte(kind, modele, texte, { env }) : null;
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  // Modèle EXTERNE explicitement choisi (#194, #217) : le texte part chez le
  // fournisseur, pas chez DocIE. `choisi.identifiant` est alors le MODE du
  // transport (`rapide` / `raisonnement`), jamais un profil DocIE — l'envoyer à
  // `extractText` demanderait à DocIE un modèle nommé « rapide ».
  // Aucun repli : un échec remonte nommé (voir analyzeDocument).
  let response;
  if (choixModele.estExterne(choisi)) {
    const { extraireViaOpenAI } = deps.extraireViaOpenAI ? deps : loadOpenAI();
    response = await extraireViaOpenAI(texte, {
      mode: choisi.mode, dynamicSchema: options.dynamicSchema, env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } else {
    const { extractText } = deps.extractText ? deps : loadBridge();
    if (choisi) options.modelProfile = choisi.identifiant;
    else if (profilSansChoix) options.modelProfile = profilSansChoix;
    response = await extractText(texte, options);
  }
  const analysis = mapTexteDocieResult(kind, response, { items, expectedName });
  if (choisi) {
    analysis.modele = choixModele.modeleServiPublic(kind, response.metadata, { env, voie: "texte" });
    // RIB lu par l'alternative du catalogue (LFM2.5 350M) : admise seulement
    // derrière le contrôle IBAN/BIC. Le drapeau dit au navigateur qu'un IBAN ou
    // un BIC non « valide » fait de cette lecture un échec (⛔), pas une alerte.
    // Absent sinon : la réponse du modèle par défaut reste celle de #209.
    if (choixModele.exigeControleIbanBic(kind, choisi, analysis.modele, { env })) analysis.controleIbanBicExige = true;
  }
  return analysis;
}

// ---------------------------------------------------------------------------
// Kbis « choisi par type d'entrée » (#194). La voie se décide ICI, sur le
// fichier reçu, avec la règle de la voie texte (coucheTexteUtilisable) — jamais
// sur ce que le navigateur suppose :
//
//   fichier                           | sans `modele`                         | `modele` choisi
//   ----------------------------------|---------------------------------------|---------------------------------
//   aucun modèle texte par défaut     | agent DOCIE_AGENT_KBIS, sans même     | (voir lignes suivantes)
//   configuré (DOCIE_MODELE_LFM25_2_6B)| lire la couche texte : comme avant    |
//   PDF à couche texte complète       | voie texte, modèle par défaut du      | voie texte, CE modèle (800 lignes
//                                     | catalogue (au-delà de sa limite :     | au plus pour LFM2.5), sinon
//                                     | agent d'avant)                        | `modele_non_propose` / `limite`
//   photo, scan, page muette,         | agent DOCIE_AGENT_KBIS, comme avant   | vision DOCIE_AGENT_KBIS_<MODELE>
//   PDF illisible                     |                                       | (8 pages au plus -> `limite`) ;
//                                     |                                       | modèle de la seule voie texte -> `scan`
//
// Échec : sans `modele`, repli local d'avant (analyzeDocument) ; avec, erreur
// nommée, jamais d'autre modèle ni d'analyse locale.
// ---------------------------------------------------------------------------
async function extractParType(kind, body = {}, modele = null, deps = {}) {
  const { dataBase64, mimeType, items, expectedName } = body;
  if (!dataBase64) throw new Error("Aucun fichier reçu.");
  const env = deps.env || process.env;
  // Rien de configuré pour la voie texte et aucun choix : chemin d'avant, octet
  // pour octet (pas de lecture de la couche texte, agent DOCIE_AGENT_KBIS).
  if (modele === null && !choixModele.defautSansChoix(kind, "texte", null, { env })) {
    return extractViaDocie(body, deps);
  }
  const buffer = Buffer.from(dataBase64, "base64");
  const mime = sniffMime(mimeType, buffer);
  const lecture = await lireDocument(buffer, mime);
  if (lecture.ok) {
    if (modele !== null) return extraireTexteLu(kind, lecture.texte, { items, expectedName, modele }, deps);
    const defaut = choixModele.defautSansChoix(kind, "texte", { lignesNonVides: choixModele.compterLignesNonVides(lecture.texte) }, { env });
    if (defaut) return extraireTexteLu(kind, lecture.texte, { items, expectedName, profilSansChoix: defaut.identifiant }, deps);
    return extractViaDocie(body, deps);
  }
  if (modele === null) return extractViaDocie(body, deps);
  const choisi = choixModele.choisirPourAgent(kind, modele, { pages: lecture.pages }, { env });
  const { extractDocument } = deps.extractDocument ? deps : loadBridge();
  const options = { kind, agent: choisi.identifiant, env };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const response = await extractDocument(buffer, mime, options);
  const analysis = mapDocieResult(response, { items, expectedName });
  analysis.modele = choixModele.modeleServiPublic(kind, response.metadata, { env, voie: "agent" });
  return analysis;
}

function extractUrssafViaTexte(body, deps) {
  return extractViaTexte("urssaf", body, deps);
}

// Erreur présentable d'un modèle choisi (#194) : code nommé et message français
// constant (table des tâches de pré-remplissage), jamais le texte amont. Une
// ErreurChoixModele garde le sien : constant, ou bâti sur les libellés du
// catalogue (scan du Kbis qui nomme la lecture d'image, lib/choix-modele.js).
function erreurModeleChoisi(error) {
  const { code, message } = mapperErreur(error);
  const texte = code === "context" ? "Document trop long pour le modèle d'extraction."
    : code === "interne" ? "Analyse impossible : erreur interne."
    : error && error.name === "ErreurChoixModele" && typeof error.message === "string" ? error.message
    : message;
  const err = new Error(texte);
  err.code = code;
  return err;
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
  const voie = isEnabled(env) ? voiePour(body.items) : null;
  if (!voie) return analyzeLocal(body);
  const piece = pieceDemandee(body.items);
  const parType = Object.hasOwn(PIECES_PAR_TYPE, piece);
  // Modèle choisi (#194, champ `modele`, voie texte et Kbis) : un échec
  // remonte nommé, sans analyse locale en repli. Sans `modele` : inchangé.
  const modele = (voie === "texte" || parType) ? choixModele.demandeModele(body) : null;
  try {
    if (parType) return await extractParType(piece, body, modele, deps);
    if (voie === "texte") {
      const { analysis, raisonRepli } = await extractViaTexte(pieceDemandee(body.items), { ...body, modele }, deps);
      if (analysis) return analysis;
      if (modele !== null) throw new choixModele.ErreurChoixModele("scan");
      // Pas d'échec DocIE ici : DocIE n'a tout simplement pas été sollicité,
      // faute de couche texte. Avertissement DISTINCT de celui d'un échec
      // d'extraction, parce que les deux ne se corrigent pas pareil — celui-ci
      // se corrige en fournissant un PDF texte, l'autre côté DocIE.
      const local = await analyzeLocal(body);
      local.issues = (local.issues || []).concat(
        "DocIE non sollicité (" + raisonRepli + ") — analyse locale utilisée."
      );
      return local;
    }
    return await extractViaDocie(body, deps);
  } catch (error) {
    if (modele !== null) {
      console.error("[docie-extraction] Modèle choisi en échec, sans repli (code=" + ((error && error.code) || "erreur") + "):", error && error.message);
      throw erreurModeleChoisi(error);
    }
    const code = (error && error.code) || "erreur";
    console.error("[docie-extraction] Extraction DocIE en échec, repli sur l'analyse locale (code=" + code + "):", error && error.message);
    const local = await analyzeLocal(body);
    local.issues = (local.issues || []).concat(
      "Extraction DocIE indisponible (" + code + ") — analyse locale utilisée en repli."
    );
    return local;
  }
}

module.exports = {
  analyzeDocument,
  extractViaDocie,
  extractViaTexte,
  extractUrssafViaTexte,
  extractParType,
  PIECES_PAR_TYPE,
  coucheTexteUtilisable,
  lireDocument,
  mapDocieResult,
  mapTexteDocieResult,
  mapUrssafDocieResult,
  signauxPartielsPublics,
  chargerSchema,
  chargerSchemaUrssaf,
  isEnabled,
  isEligible,
  voiePour,
  VOIES,
  PIECES_TEXTE,
  ELIGIBLE_ITEM_ID,
  // Exportés pour réutilisation par d'autres consommateurs du bridge côté
  // contrats (ex. lib/docie-contract-import.js) : même flag DOCIE_EXTRACTION_ENABLED,
  // même chemin vers le module partagé, même détection MIME — pas de raison
  // de dupliquer ce câblage par kind de document.
  loadBridge,
  sniffMime,
};
