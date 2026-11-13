"use strict";

const path = require("path");

const CONTRATS_LIB = path.join(__dirname, "..", "..", "contrats", "lib");
const { controlerSirenSiret, messagesSirenSiret, VALIDE } = require(path.join(CONTRATS_LIB, "siren-siret"));
const { controlerIbanBic, messagesIbanBic } = require(path.join(CONTRATS_LIB, "iban-bic"));

const TOLERANCE = 0.02;

const OK = "ok";
const ATTENTION = "attention";
const ERREUR = "erreur";
const BLOQUANT = "bloquant";
const INDISPONIBLE = "indisponible";

const arrondi = (n) => Math.round(n * 100) / 100;
const estNombre = (n) => typeof n === "number" && Number.isFinite(n);
const euros = (n) => estNombre(n) ? n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

function normaliserNumero(numero) {
  return String(numero || "").toUpperCase().replace(/[\s  ]/g, "");
}

function ibanCompact(iban) {
  return String(iban || "").toUpperCase().replace(/[\s  -]/g, "");
}

// Colonnes indexées tirées des données relues : doublon, fraude, échéances, journal.
function colonnes(d) {
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);
  return {
    siren: String(d.siren || "").replace(/\D/g, ""),
    numero: normaliserNumero(d.numero),
    fournisseur: String(d.fournisseur || "").trim(),
    iban: ibanCompact(d.iban),
    date_facture: iso(d.date_facture),
    date_echeance: iso(d.date_echeance),
    total_ttc: estNombre(d.total_ttc) ? arrondi(d.total_ttc) : null,
  };
}

function controleDoublon(d, doublons) {
  if (!d.siren || !d.numero) {
    return { code: "doublon", titre: "Doublon", niveau: ATTENTION, message: "SIREN ou numéro de facture absent : doublon non vérifiable." };
  }
  if (!doublons.length) return { code: "doublon", titre: "Doublon", niveau: OK, message: "Aucune autre facture avec ce SIREN et ce numéro." };
  return {
    code: "doublon", titre: "Doublon", niveau: ERREUR,
    message: "Même SIREN et même numéro que " + doublons.map((x) => "la facture n° " + x.id).join(", ") + ".",
    details: { factures: doublons.map((x) => x.id) },
  };
}

function controleTotaux(d) {
  const resultats = [];
  const lignes = Array.isArray(d.lignes) ? d.lignes : [];
  const montants = lignes.map((l) => l.total_ht).filter(estNombre);
  if (!lignes.length) {
    resultats.push({ code: "lignes", titre: "Somme des lignes", niveau: ATTENTION, message: "Aucune ligne lue : le total HT n'est pas recoupé." });
  } else if (montants.length !== lignes.length || !estNombre(d.total_ht)) {
    resultats.push({ code: "lignes", titre: "Somme des lignes", niveau: ERREUR, message: "Montant HT manquant sur une ligne ou au total : recoupement impossible, à compléter." });
  } else {
    const somme = arrondi(montants.reduce((a, b) => a + b, 0));
    const ecart = arrondi(somme - d.total_ht);
    resultats.push(Math.abs(ecart) <= TOLERANCE
      ? { code: "lignes", titre: "Somme des lignes", niveau: OK, message: "Somme des lignes " + euros(somme) + " = total HT." }
      : { code: "lignes", titre: "Somme des lignes", niveau: ERREUR, message: "Somme des lignes " + euros(somme) + " ≠ total HT " + euros(d.total_ht) + " (écart " + euros(ecart) + ").", details: { somme, ecart } });
  }
  const fautives = lignes
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => estNombre(l.quantite) && estNombre(l.pu_ht) && estNombre(l.total_ht) && Math.abs(arrondi(l.quantite * l.pu_ht) - l.total_ht) > TOLERANCE)
    .map(({ i }) => i + 1);
  if (fautives.length) {
    resultats.push({ code: "lignes_detail", titre: "Quantité × prix", niveau: ATTENTION, message: "Quantité × prix unitaire ≠ montant HT sur la ligne " + fautives.join(", ") + ".", details: { lignes: fautives } });
  }
  if (![d.total_ht, d.total_tva, d.total_ttc].every(estNombre)) {
    resultats.push({ code: "equilibre", titre: "HT + TVA = TTC", niveau: BLOQUANT, message: "Total HT, TVA ou TTC manquant : l'écriture comptable ne peut pas être équilibrée." });
  } else {
    const ecart = arrondi(d.total_ht + d.total_tva - d.total_ttc);
    resultats.push(Math.abs(ecart) <= TOLERANCE
      ? { code: "equilibre", titre: "HT + TVA = TTC", niveau: OK, message: euros(d.total_ht) + " + " + euros(d.total_tva) + " = " + euros(d.total_ttc) + "." }
      : { code: "equilibre", titre: "HT + TVA = TTC", niveau: BLOQUANT, message: euros(d.total_ht) + " + " + euros(d.total_tva) + " ≠ " + euros(d.total_ttc) + " (écart " + euros(ecart) + ") : corrigez avant validation.", details: { ecart } });
  }
  return resultats;
}

function controleIdentifiants(d) {
  const c = controlerSirenSiret(d.siren || null, d.siret || null);
  const messages = messagesSirenSiret(c).map((m) => m.message);
  if (!d.siren) messages.unshift("SIREN absent.");
  const niveau = messages.length ? ERREUR : OK;
  return {
    code: "siren_siret", titre: "SIREN / SIRET", niveau,
    message: messages.length ? messages.join(" ") : "Clés de contrôle valides" + (d.siret ? ", SIRET cohérent avec le SIREN." : " (SIRET absent)."),
    details: { siren: c.siren.statut, siret: c.siret.statut },
  };
}

function controleBanque(d) {
  const c = controlerIbanBic(d.iban || null, d.bic || null);
  const messages = messagesIbanBic(c).map((m) => m.message);
  if (!d.iban) messages.unshift("IBAN absent.");
  return {
    code: "iban_bic", titre: "IBAN / BIC", niveau: messages.length ? ERREUR : OK,
    message: messages.length ? messages.join(" ") : "IBAN valide (modulo 97)" + (d.bic ? ", BIC bien formé." : ", BIC absent."),
    details: { iban: c.iban.statut, bic: c.bic.statut },
  };
}

function controleSociete(verif) {
  const v = verif || {};
  const titre = "Société";
  if (!v.etat) return { code: "societe", titre, niveau: INDISPONIBLE, message: "Vérification non encore faite." };
  if (v.etat === "indisponible") return { code: "societe", titre, niveau: INDISPONIBLE, message: "Vérification indisponible : " + (v.message || "service de recherche injoignable") + "." };
  if (v.etat === "non_verifiable") return { code: "societe", titre, niveau: ATTENTION, message: v.message || "SIREN invalide : société non recherchée." };
  if (v.etat === "introuvable") return { code: "societe", titre, niveau: ERREUR, message: "Aucune société trouvée pour ce SIREN." };
  const morceaux = ["« " + v.nom + " »" + (v.source ? " (" + v.source + ")" : "")];
  let niveau = OK;
  if (v.etatAdministratif === "cessée") { niveau = ERREUR; morceaux.push("société cessée"); }
  if (v.correspondanceNom === false) { niveau = niveau === OK ? ATTENTION : niveau; morceaux.push("nom différent du fournisseur lu sur la facture"); }
  return { code: "societe", titre, niveau, message: morceaux.join(" — ") + ".", details: v };
}

// Alerte fraude : IBAN différent de la dernière facture validée du fournisseur ; bloque tant qu'elle n'est pas confirmée.
function controleFraude(d, reference, confirmations) {
  const titre = "Changement d'IBAN";
  const iban = ibanCompact(d.iban);
  if (!reference) return { code: "fraude_iban", titre, niveau: OK, message: "Aucune facture validée antérieure pour ce fournisseur : IBAN de référence absent." };
  if (!reference.iban || !iban) return { code: "fraude_iban", titre, niveau: ATTENTION, message: "IBAN absent ici ou sur la facture de référence n° " + reference.id + " : comparaison impossible." };
  if (reference.iban === iban) return { code: "fraude_iban", titre, niveau: OK, message: "IBAN identique à la dernière facture validée (n° " + reference.id + ")." };
  const confirmation = (confirmations || []).find((c) => c.details && c.details.iban === iban && c.details.ibanReference === reference.iban);
  const details = { ibanReference: reference.iban, factureReference: reference.id, iban };
  if (confirmation) {
    return {
      code: "fraude_iban", titre, niveau: ATTENTION, details: { ...details, confirmePar: confirmation.email || confirmation.sub, confirmeLe: confirmation.le },
      message: "IBAN différent de la facture n° " + reference.id + ", changement confirmé par " + (confirmation.email || confirmation.sub) + " le " + new Date(confirmation.le).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) + ".",
    };
  }
  return {
    code: "fraude_iban", titre: "ALERTE FRAUDE — changement d'IBAN", niveau: BLOQUANT, details, confirmable: true,
    message: "L'IBAN diffère de celui de la dernière facture validée de ce fournisseur (n° " + reference.id + "). Vérifiez le changement auprès du fournisseur par un canal connu avant de confirmer : la validation est bloquée jusque-là.",
  };
}

function evaluer(facture, { doublons = [], reference = null, confirmations = [] } = {}) {
  const d = facture.donnees || {};
  const c = colonnes(d);
  const liste = [
    controleFraude(d, reference, confirmations),
    controleDoublon(c, doublons),
    ...controleTotaux(d),
    controleIdentifiants(d),
    controleSociete(facture.verifSociete),
    controleBanque(d),
  ];
  return { liste, bloquants: liste.filter((x) => x.niveau === BLOQUANT) };
}

module.exports = {
  evaluer, colonnes, normaliserNumero, ibanCompact, TOLERANCE,
  OK, ATTENTION, ERREUR, BLOQUANT, INDISPONIBLE, VALIDE_SIREN: VALIDE,
};
