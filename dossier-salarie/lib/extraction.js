"use strict";
// Lecture d'une pièce par le pont DocIE partagé : PDF à couche texte -> voie texte, photo ou scan -> voie agent.

const path = require("path");

const RACINE = path.join(__dirname, "..", "..");
const { lireDocument, sniffMime } = require(path.join(RACINE, "contrats", "lib", "docie-extraction"));
const catalogue = require(path.join(RACINE, "document-parsing", "models", "catalogue"));
const pieces = require("./pieces");

const CHEMIN_PONT = path.join(RACINE, "document-parsing", "bridge", "docie-bridge.js");
const SCHEMA_CLASSEMENT = path.join(RACINE, "document-parsing", "schemas", "type_piece.schema.json");
const MIMES = new Set(["application/pdf", "image/png", "image/jpeg"]);
const LANGUE = "fr";

function pont() {
  return require(CHEMIN_PONT);
}

function active(env = process.env) {
  return String(env.DOCIE_EXTRACTION_ENABLED || "").trim().toLowerCase() === "true";
}

/** Premier modèle configuré du catalogue pour la tâche et la voie, sinon null (le pont prend alors son défaut d'environnement). */
function modeleCatalogue(tache, voie, env, document = null) {
  try {
    const offre = catalogue.modelesOfferts(tache, voie, { env, document })[0];
    return offre ? offre.identifiant : null;
  } catch (e) {
    if (e && e.code === "tache") return null;
    throw e;
  }
}

/** Couche texte complète d'un PDF, ou null (image, scan, page muette). */
async function lireTexte(buffer, mime) {
  const lecture = await lireDocument(buffer, mime);
  return lecture.ok ? lecture.texte : null;
}

async function appeler(tache, buffer, mime, texte, dynamicSchema, env, deps) {
  const bridge = deps.bridge || pont();
  const options = { kind: tache, env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  if (texte) {
    const lignesNonVides = catalogue.compterLignesNonVides(texte);
    const profil = modeleCatalogue(tache, "texte", env, { lignesNonVides });
    const reponse = await bridge.extractText(texte, { ...options, dynamicSchema, langue: LANGUE, ...(profil ? { modelProfile: profil } : {}) });
    return { reponse, voie: "texte" };
  }
  const agent = modeleCatalogue(tache, "agent", env);
  const reponse = await bridge.extractDocument(buffer, mime, { ...options, ...(agent ? { agent } : {}) });
  return { reponse, voie: "agent" };
}

/** Valeur brute du champ type_piece, ou null quand aucune voie de classement n'est configurée. */
async function classerParDocie({ buffer, mime, texte }, { env = process.env, ...deps } = {}) {
  if (!active(env)) return null;
  if (!texte && !String(env.DOCIE_AGENT_TYPE_PIECE || "").trim() && !modeleCatalogue("type_piece", "agent", env)) return null;
  const { reponse } = await appeler("type_piece", buffer, mime, texte, require(SCHEMA_CLASSEMENT), env, deps);
  const brute = reponse && reponse.result ? reponse.result.type_piece : null;
  return brute == null ? "" : String(brute);
}

async function extraire(type, { buffer, mime, texte }, { env = process.env, ...deps } = {}) {
  const { reponse, voie } = await appeler(type, buffer, mime, texte, pieces.chargerSchema(type), env, deps);
  const { valeurs, analyse } = pieces.versValeurs(type, reponse);
  const meta = reponse.metadata || {};
  analyse.modele = (voie === "agent" ? meta.agent : meta.model) || null;
  if (meta.troncature_possible === true) analyse.constats.push("Document long : extraction possiblement tronquée.");
  return { valeurs, analyse, voie };
}

module.exports = { MIMES, active, lireTexte, sniffMime, classerParDocie, extraire, modeleCatalogue };
