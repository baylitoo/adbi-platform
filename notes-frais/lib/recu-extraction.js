"use strict";
// Extraction d'un reçu par le pont DocIE partagé : PDF à couche texte -> voie texte, photo ou scan -> voie agent.

const path = require("path");
const { PDFParse } = require("pdf-parse");
const { normaliserChamps } = require("./recu-mapping");

const RACINE_PARTAGEE = path.join(__dirname, "..", "..", "document-parsing");
const CHEMIN_PONT = path.join(RACINE_PARTAGEE, "bridge", "docie-bridge.js");
const CHEMIN_CATALOGUE = path.join(RACINE_PARTAGEE, "models", "catalogue.js");
const CHEMIN_SCHEMA = path.join(RACINE_PARTAGEE, "schemas", "recu.schema.json");
const TACHE = "recu";

const MIMES_ACCEPTES = Object.freeze(["application/pdf", "image/png", "image/jpeg"]);

// Type réel d'après les premiers octets : un téléphone annonce souvent un type faux ou vide.
function typeReel(buffer) {
  if (buffer.slice(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const marque = buffer.slice(4, 12).toString("latin1");
  if (/^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(marque)) return "image/heic";
  if (buffer.slice(0, 4).toString("latin1") === "RIFF" && buffer.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

async function lireCoucheTexte(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const r = await parser.getText();
    const pages = Array.isArray(r.pages) ? r.pages : [];
    const muette = !pages.length || pages.some((p) => !String(p.text || "").trim());
    return { texte: String(r.text || ""), pages: pages.length || null, complete: !muette && Boolean(String(r.text || "").trim()) };
  } catch {
    return { texte: "", pages: null, complete: false };
  } finally {
    try { await parser.destroy(); } catch { /* rien à libérer */ }
  }
}

// Voie et document décrits pour le catalogue : une seule page muette envoie le PDF en vision.
async function choisirVoie(buffer, mime) {
  if (mime !== "application/pdf") return { voie: "agent", document: { pages: 1 } };
  const lecture = await lireCoucheTexte(buffer);
  if (lecture.complete) {
    const { compterLignesNonVides } = require(CHEMIN_CATALOGUE);
    return { voie: "texte", texte: lecture.texte, document: { pages: lecture.pages, lignesNonVides: compterLignesNonVides(lecture.texte) } };
  }
  return { voie: "agent", document: { pages: lecture.pages } };
}

// Premier modèle offert par le catalogue pour cette voie ; aucun : le pont garde son défaut d'environnement.
function modeleConfigure(voie, document, env) {
  const offres = require(CHEMIN_CATALOGUE).modelesOfferts(TACHE, voie, { env, document });
  return offres.length ? offres[0].identifiant : null;
}

function libelleServi(voie, metadata, env) {
  try {
    const servi = require(CHEMIN_CATALOGUE).modeleServi(TACHE, voie, { env, metadata });
    return servi ? servi.libelle : "";
  } catch { return ""; }
}

async function extraireRecu(buffer, mime, { env = process.env } = {}) {
  const pont = require(CHEMIN_PONT);
  const choix = await choisirVoie(buffer, mime);
  const identifiant = modeleConfigure(choix.voie, choix.document, env);
  let reponse;
  if (choix.voie === "texte") {
    const dynamicSchema = require(CHEMIN_SCHEMA);
    reponse = await pont.extractText(choix.texte, { kind: TACHE, dynamicSchema, modelProfile: identifiant, langue: "fr", env });
  } else {
    reponse = await pont.extractDocument(buffer, mime, { kind: TACHE, agent: identifiant, env });
  }
  const metadata = reponse.metadata || {};
  return {
    voie: choix.voie,
    modele: libelleServi(choix.voie, metadata, env),
    champs: normaliserChamps(reponse.result),
    extraction: {
      brut: reponse.result,
      confiance: metadata.field_confidence || {},
      partiel: Array.isArray(metadata.partiel) ? metadata.partiel : [],
      pages: choix.document.pages ?? null,
    },
  };
}

module.exports = { extraireRecu, typeReel, MIMES_ACCEPTES };
