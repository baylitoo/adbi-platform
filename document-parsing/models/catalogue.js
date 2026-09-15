"use strict";

// Chargeur Node du catalogue des modèles (#194) — portage jumeau de catalogue.py.
//
// Répond à une seule question : pour une tâche (`contract`, `urssaf`…) et une
// voie DocIE (`texte`, `agent`, `chat`), quels modèles proposer, dans quel
// ordre (défaut d'abord), avec quel identifiant réel ?
//
// - Le catalogue (catalogue.json) porte rôles, libellés, étiquettes, limites.
// - L'environnement porte les identifiants réels (motifs sous `variables`) :
//   DOCIE_MODELE_<MODELE> pour la voie texte (une référence `store:<nom>`,
//   seule forme qui déclenche le chargement à la demande côté DocIE),
//   DOCIE_AGENT_<TACHE>_<MODELE> pour la voie agent (le modèle y est figé par
//   l'agent : choisir un modèle, c'est choisir un agent).
// - Un modèle sans identifiant configuré n'est pas proposé. Aucun identifiant
//   pour une tâche et une voie : liste vide, et le consommateur garde son
//   comportement d'avant (DOCIE_MODEL_PROFILE / DOCIE_AGENT_<TYPE>).
//
// Transport et politique restent séparés : ce module ne fait aucun appel
// réseau et ne choisit jamais un autre modèle que celui demandé (« échouer
// bruyamment ») — `choisirModele` lève une erreur nommée plutôt que de
// substituer le défaut.

const fs = require("fs");
const path = require("path");

const CHEMIN_CATALOGUE = path.join(__dirname, "catalogue.json");

class CatalogueError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CatalogueError";
    this.code = code;
    this.details = details;
  }
}

function geler(valeur) {
  if (valeur && typeof valeur === "object") {
    Object.values(valeur).forEach(geler);
    Object.freeze(valeur);
  }
  return valeur;
}

let enCache = null;
function chargerCatalogue() {
  if (!enCache) enCache = geler(JSON.parse(fs.readFileSync(CHEMIN_CATALOGUE, "utf8")));
  return enCache;
}

// ---------------------------------------------------------------------------
// Lignes non vides : la règle exacte de DocIE pour découper un texte en blocs
// (ocr/base.py::text_to_blocks, #190) — `sum(1 for l in t.splitlines() if l.strip())`.
// Au-delà de 800, un modèle à prompt générique ne lit que les 800 premières,
// en silence. Compter TROP PEU serait dangereux (faux « non tronqué ») :
//   - séparateurs de str.splitlines(), pas seulement \r et \n ;
//   - « vide » = uniquement des caractères de str.isspace(). Jamais trim() ni
//     \s : trim() retire le BOM (U+FEFF), que Python garde ; \s ignore
//     \x1c-\x1f et \x85, que Python retire.
// Les deux ensembles sont vérifiés contre CPython par tests/test_catalogue.py
// (fixture tests/lignes_non_vides.json, relue par les deux portages).
// ---------------------------------------------------------------------------
const SEPARATEURS_LIGNE = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;
const BLANCS_PYTHON = new Set(
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
  "\u2028\u2029\u202f\u205f\u3000"
);

function compterLignesNonVides(texte) {
  let n = 0;
  for (const ligne of String(texte).split(SEPARATEURS_LIGNE)) {
    for (const c of ligne) {
      if (!BLANCS_PYTHON.has(c)) { n++; break; }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Identifiants réels : même FORME que ce que le bridge accepte par appel
// (document-parsing/bridge/docie-bridge.js, perCallAgent/perCallModelProfile).
// Une valeur mal formée est une erreur de configuration NOMMÉE (variable citée,
// valeur jamais recopiée) : la faire disparaître en silence du sélecteur
// masquerait une faute de déploiement.
// ---------------------------------------------------------------------------
const NOM_AGENT = /^[A-Za-z0-9_-]{1,128}$/;

function identifiantValide(voie, valeur) {
  if (voie === "agent") return NOM_AGENT.test(valeur);
  return !/[\u0000-\u001f\u007f]/.test(valeur) && Buffer.byteLength(valeur, "utf8") <= 128;
}

function nomVariable(voie, tache, modele, { catalogue = chargerCatalogue() } = {}) {
  const motif = catalogue.variables[voie];
  if (typeof motif !== "string") throw new CatalogueError("voie", "Voie inconnue du catalogue.");
  return motif.replace("{TACHE}", String(tache).toUpperCase()).replace("{MODELE}", String(modele).toUpperCase());
}

function tacheDuCatalogue(catalogue, tache) {
  if (!Object.hasOwn(catalogue.taches, String(tache))) {
    throw new CatalogueError("tache", "Tâche inconnue du catalogue.");
  }
  return catalogue.taches[tache];
}

/**
 * Modèles configurés pour (tache, voie), défaut d'abord, SANS regarder le
 * document. Chaque entrée : { id, libelle, description, etiquettes, role,
 * voie, variable, identifiant, limites, condition, prerequis, experimental }.
 * `experimental` : vrai seulement si l'entrée de la tâche le déclare (le même
 * modèle peut être éprouvé sur une tâche et expérimental sur une autre).
 */
function modelesConfigures(tache, voie, { env = process.env, catalogue = chargerCatalogue(), externes = false } = {}) {
  const t = tacheDuCatalogue(catalogue, tache);
  const v = Object.hasOwn(t.voies, String(voie)) ? t.voies[voie] : null;
  if (!v) return [];
  const offres = [];
  for (const role of ["defaut", "alternative"]) {
    const entree = v[role];
    if (!entree) continue;
    const modele = catalogue.modeles[entree.modele];
    // Un modèle d'extraction n'est jamais proposé pour une tâche chat, et
    // inversement (décision du 2026-09-14). Un modèle externe (`fournisseur`)
    // n'est jamais un défaut ni l'alternative DocIE, même mal placé.
    if (!modele || !modele.etiquettes.includes(t.usage) || modele.fournisseur) continue;
    const variable = nomVariable(voie, tache, entree.modele, { catalogue });
    const brut = String((env || {})[variable] ?? "").trim();
    if (!brut) continue;
    if (!identifiantValide(voie, brut)) {
      throw new CatalogueError("configuration", `Identifiant mal formé dans ${variable}.`, { variable });
    }
    offres.push({
      id: entree.modele,
      libelle: modele.libelle,
      description: modele.description,
      etiquettes: [...modele.etiquettes],
      role,
      voie,
      variable,
      identifiant: brut,
      limites: { ...((modele.limites || {})[voie] || {}) },
      condition: entree.condition || null,
      prerequis: entree.prerequis || null,
      experimental: entree.experimental === true,
    });
  }
  // Modèles HORS ADBI (#194), toujours après le défaut et l'alternative DocIE,
  // seulement si le consommateur les demande (`externes`) : un consommateur qui
  // ne sait pas les appeler enverrait leur identifiant à DocIE.
  if (externes && Array.isArray(v.externes)) {
    for (const entree of v.externes) {
      const offre = offreExterne(catalogue, t, entree, voie, env || {});
      if (offre) offres.push(offre);
    }
  }
  return offres;
}

/**
 * Offre d'un modèle externe, ou null. Offerte si et seulement si la variable du
 * fournisseur (OPENAI_API_KEY) est non vide. `identifiant` = le mode de
 * transport, jamais la clé ; `variable` = le NOM de la variable seulement.
 */
function offreExterne(catalogue, t, entree, voie, env) {
  const modele = entree && Object.hasOwn(catalogue.modeles, String(entree.modele)) ? catalogue.modeles[entree.modele] : null;
  if (!modele || !modele.etiquettes.includes(t.usage) || !modele.fournisseur) return null;
  const fournisseurs = catalogue.fournisseurs || {};
  const fournisseur = Object.hasOwn(fournisseurs, modele.fournisseur) ? fournisseurs[modele.fournisseur] : null;
  if (!fournisseur || !fournisseur.voies.includes(voie)) return null;
  if (!String(env[fournisseur.variable] ?? "").trim()) return null;
  return {
    id: entree.modele,
    libelle: modele.libelle,
    description: modele.description,
    etiquettes: [...modele.etiquettes],
    role: "externe",
    voie,
    variable: fournisseur.variable,
    identifiant: modele.mode,
    limites: { ...((modele.limites || {})[voie] || {}) },
    condition: entree.condition || null,
    prerequis: entree.prerequis || null,
    experimental: entree.experimental === true,
    fournisseur: modele.fournisseur,
    mode: modele.mode,
  };
}

/**
 * Limite du modèle dépassée par CE document, ou null. `document` :
 * { lignesNonVides?, pages? } ; un fait absent n'est pas évalué (sélecteur
 * affiché avant le dépôt du fichier) — le consommateur DOIT rappeler
 * choisirModele avec le document réel avant l'envoi.
 */
function refusParLimite(modeleId, voie, document, { catalogue = chargerCatalogue() } = {}) {
  const modele = catalogue.modeles[modeleId];
  const limites = (modele && modele.limites && modele.limites[voie]) || {};
  const doc = document || {};
  if (typeof limites.lignes_non_vides_max === "number" && typeof doc.lignesNonVides === "number"
      && doc.lignesNonVides > limites.lignes_non_vides_max) {
    return {
      code: "limite_lignes", valeur: doc.lignesNonVides, max: limites.lignes_non_vides_max,
      message: `${modele.libelle} n'est pas proposé au-delà de ${limites.lignes_non_vides_max} lignes non vides (document : ${doc.lignesNonVides}).`,
    };
  }
  if (typeof limites.pages_max === "number" && typeof doc.pages === "number" && doc.pages > limites.pages_max) {
    return {
      code: "limite_pages", valeur: doc.pages, max: limites.pages_max,
      message: `${modele.libelle} n'est pas proposé au-delà de ${limites.pages_max} pages (document : ${doc.pages}).`,
    };
  }
  return null;
}

/** Modèles proposés pour (tache, voie) et, s'il est connu, ce document. Défaut d'abord. */
function modelesOfferts(tache, voie, { env = process.env, document = null, catalogue = chargerCatalogue(), externes = false } = {}) {
  return modelesConfigures(tache, voie, { env, catalogue, externes })
    .filter((o) => !refusParLimite(o.id, voie, document, { catalogue }));
}

/**
 * Le modèle `modele` demandé pour (tache, voie), vérifié sur le document réel.
 * Jamais de substitution : non configuré ou inconnu -> `modele_non_propose` ;
 * limite dépassée -> `limite` (message nommant la limite).
 */
function choisirModele(tache, voie, { env = process.env, document = null, modele, catalogue = chargerCatalogue(), externes = false } = {}) {
  const t = tacheDuCatalogue(catalogue, tache);
  const offre = modelesConfigures(tache, voie, { env, catalogue, externes }).find((o) => o.id === modele);
  if (!offre) {
    // L'identifiant demandé vient du navigateur : recopié seulement s'il est
    // un identifiant du catalogue.
    // Un modèle externe refusé n'est pas nommé : sans clé, le message reste
    // celui d'avant (#194, sortie inchangée sans OPENAI_API_KEY).
    const nom = Object.hasOwn(catalogue.modeles, String(modele)) && !catalogue.modeles[modele].fournisseur
      ? catalogue.modeles[modele].libelle : "demandé";
    throw new CatalogueError("modele_non_propose", `Modèle ${nom} non proposé pour : ${t.libelle}.`);
  }
  const refus = refusParLimite(offre.id, voie, document, { catalogue });
  if (refus) throw new CatalogueError("limite", refus.message, refus);
  return offre;
}

/**
 * Le modèle qui a RÉELLEMENT servi, lu dans les métadonnées du bridge :
 * `metadata.model` (voie texte : `model_profile` de la réponse) ou
 * `metadata.agent` (voie agent). Rapproché des identifiants configurés, avec
 * ou sans préfixe `store:` ; sans correspondance, le nom brut — jamais le
 * libellé du modèle demandé à la place de ce que DocIE a répondu.
 * -> { id, libelle, identifiant } ou null si rien n'est rapporté.
 */
function modeleServi(tache, voie, { env = process.env, metadata = {}, catalogue = chargerCatalogue() } = {}) {
  const brut = voie === "agent" ? (metadata || {}).agent : (metadata || {}).model;
  if (typeof brut !== "string" || !brut.trim()) return null;
  if ((metadata || {}).fournisseur != null) {
    // Modèle externe : rapproché par fournisseur + mode, jamais par le nom servi
    // (gpt-5-nano-2025-08-07 ne ressemble à aucun identifiant du catalogue).
    for (const o of modelesConfigures(tache, voie, { env, catalogue, externes: true })) {
      if (o.role === "externe" && o.fournisseur === metadata.fournisseur && o.mode === metadata.mode) {
        return { id: o.id, libelle: o.libelle, identifiant: brut };
      }
    }
    return { id: null, libelle: brut, identifiant: brut };
  }
  const nu = (s) => s.trim().replace(/^store:/, "");
  for (const o of modelesConfigures(tache, voie, { env, catalogue })) {
    if (nu(o.identifiant) === nu(brut)) return { id: o.id, libelle: o.libelle, identifiant: brut };
  }
  return { id: null, libelle: brut, identifiant: brut };
}

module.exports = {
  chargerCatalogue,
  modelesConfigures,
  modelesOfferts,
  choisirModele,
  refusParLimite,
  modeleServi,
  compterLignesNonVides,
  nomVariable,
  CatalogueError,
  CHEMIN_CATALOGUE,
};
