"use strict";

const CODE_JOURNAL = "ACH";
const COMPTE_TVA = "44566";
const COMPTE_CHARGE_DEFAUT = "607";
const COMPTE_CHARGE_RE = /^6\d{2,7}$/;

function compteCharge(valeur, env = process.env) {
  const brut = String(valeur || env.FACTURES_COMPTE_CHARGE || COMPTE_CHARGE_DEFAUT).trim();
  if (!COMPTE_CHARGE_RE.test(brut)) {
    const e = new Error("Compte de charge invalide : classe 6 attendue, 3 à 8 chiffres (ex. 607, 6226).");
    e.status = 400;
    throw e;
  }
  return brut;
}

// Compte fournisseur auxiliaire : 401 suivi du SIREN, stable et unique par fournisseur.
function compteFournisseur(siren) {
  const chiffres = String(siren || "").replace(/\D/g, "");
  return "401" + (chiffres.length === 9 ? chiffres : "000000000");
}

function dateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
}

function montant(n) {
  return typeof n === "number" && Number.isFinite(n) && n !== 0 ? (Math.round(n * 100) / 100).toFixed(2).replace(".", ",") : "";
}

function cellule(v) {
  const s = String(v == null ? "" : v).replace(/[\r\n]+/g, " ");
  return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Une écriture par facture : charge et TVA au débit, fournisseur au crédit.
function ecritures(facture, compte) {
  const d = facture.donnees || {};
  const date = dateFr(d.date_facture);
  const libelle = ["Fact.", d.numero, d.fournisseur].filter(Boolean).join(" ");
  const lignes = [[date, CODE_JOURNAL, compte, libelle, montant(d.total_ht), ""]];
  // TVA = TTC − HT : l'écart d'arrondi toléré à la validation reste en TVA et l'écriture est toujours équilibrée.
  const tva = Math.round((d.total_ttc - d.total_ht) * 100) / 100;
  if (montant(tva)) lignes.push([date, CODE_JOURNAL, COMPTE_TVA, libelle, montant(tva), ""]);
  lignes.push([date, CODE_JOURNAL, compteFournisseur(d.siren), libelle, "", montant(d.total_ttc)]);
  return lignes;
}

function journalCsv(factures, { compte = COMPTE_CHARGE_DEFAUT } = {}) {
  const lignes = [["date", "journal", "compte", "libellé", "débit", "crédit"]];
  for (const f of factures) lignes.push(...ecritures(f, compte));
  return "﻿" + lignes.map((l) => l.map(cellule).join(";")).join("\r\n") + "\r\n";
}

module.exports = { journalCsv, compteCharge, compteFournisseur, CODE_JOURNAL, COMPTE_TVA, COMPTE_CHARGE_DEFAUT };
