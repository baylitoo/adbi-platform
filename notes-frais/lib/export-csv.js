"use strict";
// Export comptable des notes validées : séparateur « ; », virgule décimale, UTF-8 avec BOM, fins de ligne CRLF.

const { TAUX_CONNUS } = require("./controles");

const BOM = "\uFEFF";

function cellule(valeur) {
  const t = valeur === null || valeur === undefined ? "" : String(valeur);
  return /[;"\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// Texte saisi ou lu : neutralisé s'il pourrait passer pour une formule dans un tableur.
function texteSur(valeur) {
  const t = String(valeur ?? "");
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
}

function decimal(n) {
  return n === null || n === undefined ? "" : n.toFixed(2).replace(".", ",");
}

function libelleTaux(t) {
  return String(t).replace(".", ",") + " %";
}

const ENTETES = [
  "Mois", "Collaborateur", "Email", "Date", "Commerçant", "Catégorie", "Moyen de paiement", "Devise", "Total HT",
  ...TAUX_CONNUS.flatMap((t) => ["Base TVA " + libelleTaux(t), "TVA " + libelleTaux(t)]),
  "TVA autres taux", "Total TVA", "Total TTC", "Justificatif", "Validée le",
];

function ligne(n) {
  const parTaux = TAUX_CONNUS.map((t) => n.tva.filter((l) => l.taux !== null && Math.abs(l.taux - t) < 0.001));
  const somme = (lignes, cle) => (lignes.some((l) => l[cle] !== null) ? lignes.reduce((s, l) => s + (l[cle] ?? 0), 0) : null);
  const autres = n.tva.filter((l) => !parTaux.some((g) => g.includes(l)));
  const totalTva = somme(n.tva, "montant");
  return [
    n.mois, texteSur(n.utilisateur.nom || n.utilisateur.sub), texteSur(n.utilisateur.email), n.date, texteSur(n.commercant), n.categorie,
    texteSur(n.moyen_paiement),
    n.devise, decimal(n.total_ht),
    ...parTaux.flatMap((g) => [decimal(somme(g, "base")), decimal(somme(g, "montant"))]),
    decimal(somme(autres, "montant")), decimal(totalTva), decimal(n.total_ttc), texteSur(n.fichier.nom),
    n.valideLe ? new Date(n.valideLe).toISOString().slice(0, 10) : "",
  ].map((v) => cellule(v)).join(";");
}

function exporterCsv(notes) {
  return BOM + [ENTETES.map(cellule).join(";"), ...notes.map(ligne)].join("\r\n") + "\r\n";
}

module.exports = { exporterCsv, ENTETES };
