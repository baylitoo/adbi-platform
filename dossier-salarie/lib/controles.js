"use strict";
// Contrôles des pièces et complétude d'un dossier : reçu, manquant, expiré, invalide, à vérifier.

const path = require("path");
const CONTRATS_LIB = path.join(__dirname, "..", "..", "contrats", "lib");
const { controlerIbanBic, messagesIbanBic } = require(path.join(CONTRATS_LIB, "iban-bic"));
const { controlerMrz, messagesMrz } = require(path.join(CONTRATS_LIB, "mrz"));
const { TYPES } = require("./pieces");

const MOIS_JUSTIFICATIF = 3;

/** NIR : 13 caractères (2A/2B pour la Corse) puis une clé = 97 − (n mod 97). */
function controlerNir(brut) {
  const compact = String(brut || "").replace(/[\s.\- ]/g, "").toUpperCase();
  if (!compact) return { statut: "absent" };
  const m = /^([1-478]\d{4}(?:\d{2}|2A|2B)\d{6})(\d{2})$/.exec(compact);
  if (!m) return { statut: "format_invalide", valeur: compact };
  const corps = m[1].slice(0, 5) + m[1].slice(5, 7).replace("2A", "19").replace("2B", "18") + m[1].slice(7);
  const cleCalculee = 97 - Number(BigInt(corps) % 97n);
  const cleLue = Number(m[2]);
  return { statut: cleLue === cleCalculee ? "valide" : "cle_invalide", valeur: compact, cleLue, cleCalculee };
}

function jetons(texte) {
  return String(texte || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[^A-Z]+/g, " ").trim().split(" ").filter((t) => t.length >= 2);
}

/** Vrai si tous les mots d'un des noms de référence figurent dans le nom lu (accents et casse ignorés). */
function nomConcorde(lu, references) {
  const motsLus = new Set(jetons(lu));
  if (!motsLus.size) return null;
  const refs = references.map(jetons).filter((r) => r.length);
  if (!refs.length) return null;
  return refs.some((r) => r.every((mot) => motsLus.has(mot)));
}

function dateIso(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

function ilYaMois(aujourdhui, mois) {
  const d = new Date(aujourdhui + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - mois);
  return d.toISOString().slice(0, 10);
}

const NOM_LU = {
  cni: (v) => v.nom, rib: (v) => v.titulaire, carte_vitale: (v) => v.nom,
  justificatif_domicile: (v) => v.titulaire, diplome: (v) => v.titulaire,
};

/** Constats d'une pièce typée, depuis ses valeurs (extraites ou saisies). */
function controlerPiece(piece, { references, aujourdhui }) {
  const v = piece.valeurs || {};
  const problemes = [];
  const ajouter = (gravite, message) => problemes.push({ gravite, message });
  switch (piece.typePiece) {
    case "cni": {
      const exp = dateIso(v.dateExpiration);
      if (!exp) ajouter("a_verifier", "Date d'expiration non lue.");
      else if (exp < aujourdhui) ajouter("expire", "Pièce d'identité expirée le " + exp + ".");
      if (v.mrzLigne1 || v.mrzLigne2) for (const p of messagesMrz(controlerMrz(v.mrzLigne1, v.mrzLigne2))) ajouter("a_verifier", p.message);
      break;
    }
    case "rib": {
      const c = controlerIbanBic(v.iban || null, v.bic || null);
      if (c.iban.statut === "absent") ajouter("a_verifier", "IBAN non lu.");
      else if (c.iban.statut !== "valide") ajouter("invalide", messagesIbanBic({ iban: c.iban, bic: { statut: "absent" } })[0].message);
      for (const p of messagesIbanBic({ iban: { statut: "absent" }, bic: c.bic })) ajouter("a_verifier", p.message);
      break;
    }
    case "carte_vitale": {
      const c = controlerNir(v.nir);
      if (c.statut === "absent") ajouter("a_verifier", "NIR non lu.");
      else if (c.statut === "format_invalide") ajouter("invalide", "NIR « " + c.valeur + " » : 15 caractères attendus (13 + clé).");
      else if (c.statut === "cle_invalide") ajouter("invalide", "NIR : clé de contrôle invalide (lue " + c.cleLue + ", calculée " + c.cleCalculee + ").");
      break;
    }
    case "justificatif_domicile": {
      const d = dateIso(v.dateDocument);
      if (!d) ajouter("a_verifier", "Date du document non lue.");
      else if (d < ilYaMois(aujourdhui, MOIS_JUSTIFICATIF)) ajouter("expire", "Justificatif daté du " + d + " : plus de 3 mois.");
      break;
    }
    default:
      break;
  }
  const lu = NOM_LU[piece.typePiece] ? NOM_LU[piece.typePiece](v) : "";
  if (nomConcorde(lu, references) === false) ajouter("invalide", "Le nom « " + lu + " » ne correspond pas au salarié.");
  return problemes;
}

const ORDRE = ["invalide", "expire", "a_verifier", "recu"];

function statutPiece(piece, problemes) {
  if (["en_attente", "extraction"].includes(piece.statut)) return "en_cours";
  if (["echec", "a_classer"].includes(piece.statut)) return "a_verifier";
  for (const g of ORDRE) if (problemes.some((p) => p.gravite === g)) return g;
  return "recu";
}

const MEILLEUR = ["recu", "a_verifier", "en_cours", "expire", "invalide"];

/** Vue de complétude : une ligne par type attendu, plus les constats par pièce. */
function completude(dossier, pieces, { aujourdhui = new Date().toISOString().slice(0, 10) } = {}) {
  const cni = [...pieces].reverse().find((p) => p.typePiece === "cni" && (p.valeurs || {}).nom);
  const saisis = [dossier.nom, (dossier.fiche || {}).nomUsage].filter(Boolean);
  const references = [...saisis, cni && cni.valeurs.nom, cni && cni.valeurs.nomUsage].filter(Boolean);
  const parPiece = {};
  for (const p of pieces) {
    const refs = p.typePiece === "cni" ? [...saisis, (p.valeurs || {}).nomUsage].filter(Boolean) : references;
    const problemes = p.typePiece ? controlerPiece(p, { references: refs, aujourdhui }) : [];
    parPiece[p.id] = { statut: statutPiece(p, problemes), problemes };
  }
  const lignes = (dossier.attendus || []).filter((t) => Object.hasOwn(TYPES, t)).map((type) => {
    const ids = pieces.filter((p) => p.typePiece === type).map((p) => p.id);
    if (!ids.length) return { type, libelle: TYPES[type].libelle, statut: "manquant", pieces: [] };
    const statut = MEILLEUR.find((s) => ids.some((id) => parPiece[id].statut === s));
    return { type, libelle: TYPES[type].libelle, statut, pieces: ids };
  });
  const complet = lignes.length > 0 && lignes.every((l) => l.statut === "recu");
  return { lignes, parPiece, complet, aujourdhui };
}

module.exports = { controlerNir, nomConcorde, jetons, controlerPiece, completude, MOIS_JUSTIFICATIF };
