"use strict";
// Fiche d'entrée (champs de la DPAE) : pré-remplie depuis les pièces, corrigée à la main, exportée en CSV.

const CHAMPS = [
  ["nom", "Nom de naissance"], ["nomUsage", "Nom d'usage"], ["prenoms", "Prénoms"], ["sexe", "Sexe"],
  ["dateNaissance", "Date de naissance"], ["lieuNaissance", "Lieu de naissance"], ["nir", "N° de sécurité sociale"],
  ["adresse", "Adresse"], ["dateEmbauche", "Date d'embauche"], ["heureEmbauche", "Heure d'embauche"],
  ["typeContrat", "Type de contrat"],
];
const CLES = CHAMPS.map(([cle]) => cle);

function derniere(pieces, type) {
  return [...pieces].reverse().find((p) => p.typePiece === type && Object.values(p.valeurs || {}).some(Boolean));
}

function sexeDpae(brut) {
  const s = String(brut || "").trim().toUpperCase();
  return s.startsWith("F") ? "F" : s.startsWith("M") || s.startsWith("H") ? "M" : s;
}

/** Valeurs pré-remplies avec leur source ; une saisie manuelle non vide l'emporte. */
function construire(dossier, pieces) {
  const cni = (derniere(pieces, "cni") || {}).valeurs || {};
  const vitale = (derniere(pieces, "carte_vitale") || {}).valeurs || {};
  const domicile = (derniere(pieces, "justificatif_domicile") || {}).valeurs || {};
  const proposes = {
    nom: [cni.nom, "Pièce d'identité"], nomUsage: [cni.nomUsage, "Pièce d'identité"],
    prenoms: [cni.prenoms || vitale.prenoms, cni.prenoms ? "Pièce d'identité" : "Carte Vitale"],
    sexe: [sexeDpae(cni.sexe), "Pièce d'identité"], dateNaissance: [cni.dateNaissance, "Pièce d'identité"],
    lieuNaissance: [cni.lieuNaissance, "Pièce d'identité"], nir: [String(vitale.nir || "").replace(/\s+/g, ""), "Carte Vitale"],
    adresse: [domicile.adresse, "Justificatif de domicile"], dateEmbauche: [dossier.dateEmbauche, "Dossier"],
    heureEmbauche: ["", ""], typeContrat: [dossier.typeContrat, "Dossier"],
  };
  if (!proposes.nom[0]) proposes.nom = [dossier.nom, "Dossier"];
  if (!proposes.prenoms[0]) proposes.prenoms = [dossier.prenoms, "Dossier"];
  const saisie = dossier.fiche || {};
  return CHAMPS.map(([cle, libelle]) => {
    const manuel = String(saisie[cle] || "").trim();
    const [valeur, source] = proposes[cle];
    return manuel ? { cle, libelle, valeur: manuel, source: "Saisie" } : { cle, libelle, valeur: valeur || "", source: valeur ? source : "" };
  });
}

function nettoyerSaisie(brute) {
  const sortie = {};
  for (const cle of CLES) {
    const v = String((brute || {})[cle] ?? "").trim().slice(0, 300);
    if (v) sortie[cle] = v;
  }
  return sortie;
}

function dateFr(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? m[3] + "/" + m[2] + "/" + m[1] : v;
}

function celluleCsv(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV « ; » avec BOM, pour un tableur réglé en français. */
function versCsv(champs) {
  const entete = champs.map((c) => celluleCsv(c.libelle)).join(";");
  const ligne = champs.map((c) => celluleCsv(c.cle.startsWith("date") ? dateFr(c.valeur) : c.valeur)).join(";");
  return "﻿" + entete + "\r\n" + ligne + "\r\n";
}

module.exports = { CHAMPS, construire, nettoyerSaisie, versCsv };
