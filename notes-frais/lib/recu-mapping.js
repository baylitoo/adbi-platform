"use strict";
// Normalisation côté ADBI d'un reçu lu par DocIE (schéma adbi_recu) ou saisi dans le tableau.

const CATEGORIES = Object.freeze(["repas", "transport", "hebergement", "carburant", "fournitures", "autre"]);

const SYNONYMES_CATEGORIE = [
  [/restau|repas|dejeuner|diner|brasserie|cafe|boulangerie|traiteur|snack/, "repas"],
  [/hotel|hebergement|nuitee|logement|airbnb/, "hebergement"],
  [/carburant|essence|gazole|diesel|gasoil|sp95|sp98|station/, "carburant"],
  [/transport|taxi|vtc|train|sncf|avion|vol|metro|bus|peage|parking|location/, "transport"],
  [/fourniture|papeterie|bureau|materiel/, "fournitures"],
];

function sansAccents(texte) {
  return String(texte).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function categorie(brut) {
  const t = sansAccents(brut ?? "");
  if (CATEGORIES.includes(t)) return t;
  for (const [motif, cat] of SYNONYMES_CATEGORIE) if (motif.test(t)) return cat;
  return "autre";
}

// Montant lu ou saisi -> nombre arrondi au centime, ou null ; accepte « 1 234,50 € ».
function montant(brut) {
  if (brut === null || brut === undefined || brut === "") return null;
  if (typeof brut === "number") return Number.isFinite(brut) ? Math.round(brut * 100) / 100 : null;
  let t = String(brut).replace(/[\s  €$£]|EUR/gi, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else t = t.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 100;
}

// Taux en pourcentage ; « 20 % », « 0.2 » (fraction) et « 5,5 » sont acceptés.
function taux(brut) {
  const n = montant(typeof brut === "string" ? brut.replace("%", "") : brut);
  if (n === null) return null;
  const pourcent = n > 0 && n < 1 ? n * 100 : n;
  return Math.round(pourcent * 100) / 100;
}

function dateValide(a, m, j) {
  if (a < 1950 || a > 2100 || m < 1 || m > 12 || j < 1) return false;
  return j <= new Date(Date.UTC(a, m, 0)).getUTCDate();
}

// Date libre -> AAAA-MM-JJ ou "" ; ISO, JJ/MM/AAAA, JJ-MM-AA, JJ.MM.AAAA ; jamais de date réparée.
function dateIso(brut) {
  const t = String(brut ?? "").trim();
  if (!t) return "";
  let a, m, j;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (r) [a, m, j] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})\b/.exec(t))) {
    [j, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (r[3].length === 2) a += 2000;
  } else return "";
  if (!dateValide(a, m, j)) return "";
  return String(a).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-" + String(j).padStart(2, "0");
}

function devise(brut) {
  const t = String(brut ?? "").trim().toUpperCase();
  if (!t || t === "€" || t === "EURO" || t === "EUROS") return "EUR";
  if (t === "$") return "USD";
  if (t === "£") return "GBP";
  return /^[A-Z]{3}$/.test(t) ? t : "EUR";
}

function texte(brut, max = 200) {
  return String(brut ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function lignesTva(brut) {
  if (!Array.isArray(brut)) return [];
  return brut
    .filter((l) => l && typeof l === "object" && !Array.isArray(l))
    .map((l) => ({ taux: taux(l.taux), base: montant(l.base), montant: montant(l.montant) }))
    .filter((l) => l.taux !== null || l.base !== null || l.montant !== null)
    .slice(0, 10);
}

// Résultat DocIE ou corps de requête -> champs stockables, mêmes clés que la table.
function normaliserChamps(source) {
  const s = source && typeof source === "object" ? source : {};
  return {
    date: dateIso(s.date),
    commercant: texte(s.commercant),
    total_ht: montant(s.total_ht),
    tva: lignesTva(s.tva),
    total_ttc: montant(s.total_ttc),
    devise: devise(s.devise),
    moyen_paiement: texte(s.moyen_paiement, 60),
    categorie: categorie(s.categorie),
  };
}

module.exports = { CATEGORIES, normaliserChamps, categorie, montant, taux, dateIso, devise, lignesTva };
