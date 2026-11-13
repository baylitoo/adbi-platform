"use strict";
// Contrôles affichés en badges sur chaque ligne : doublon, écart HT + TVA / TTC, taux inconnu, date invraisemblable.

const TAUX_CONNUS = Object.freeze([20, 10, 5.5, 2.1]);
const TOLERANCE = 0.02;

function jourIso(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function cleCommercant(nom) {
  return String(nom || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleDoublon(n) {
  if (!n.date || n.total_ttc === null || !cleCommercant(n.commercant)) return null;
  return [n.utilisateur.sub, n.date, n.total_ttc.toFixed(2), cleCommercant(n.commercant)].join("|");
}

function controlesDe(note, { doublons, aujourdhui }) {
  const badges = [];
  const cle = cleDoublon(note);
  if (cle && doublons.get(cle) > 1) {
    badges.push({ code: "doublon", niveau: "attention", libelle: "Doublon possible", detail: "Même date, même commerçant et même TTC qu'une autre note." });
  }
  const sommeTva = note.tva.reduce((s, l) => s + (l.montant ?? 0), 0);
  if (note.total_ht !== null && note.total_ttc !== null) {
    const ecart = Math.round((note.total_ht + sommeTva - note.total_ttc) * 100) / 100;
    if (Math.abs(ecart) > TOLERANCE) {
      badges.push({ code: "ecart_ttc", niveau: "erreur", libelle: "HT + TVA ≠ TTC",
        detail: "Écart de " + ecart.toFixed(2).replace(".", ",") + " " + note.devise + " : vérifiez les totaux lus." });
    }
  }
  const inconnus = note.tva.filter((l) => l.taux !== null && !TAUX_CONNUS.some((t) => Math.abs(t - l.taux) < 0.001));
  if (inconnus.length) {
    badges.push({ code: "taux_inconnu", niveau: "attention", libelle: "Taux de TVA inconnu",
      detail: "Taux lus : " + inconnus.map((l) => String(l.taux).replace(".", ",") + " %").join(", ") + " ; taux français : 20, 10, 5,5, 2,1 %." });
  }
  if (note.date) {
    const ilYaUnAn = new Date(aujourdhui.getFullYear() - 1, aujourdhui.getMonth(), aujourdhui.getDate());
    if (note.date > jourIso(aujourdhui)) {
      badges.push({ code: "date_future", niveau: "erreur", libelle: "Date dans le futur", detail: "La date lue est postérieure à aujourd'hui." });
    } else if (note.date < jourIso(ilYaUnAn)) {
      badges.push({ code: "date_ancienne", niveau: "attention", libelle: "Date de plus d'un an", detail: "La dépense date de plus d'un an." });
    }
  }
  return badges;
}

// Ajoute `controles` à chaque note ; les doublons se cherchent dans l'ensemble reçu.
function controler(notes, { aujourdhui = new Date() } = {}) {
  const doublons = new Map();
  for (const n of notes) {
    const cle = cleDoublon(n);
    if (cle) doublons.set(cle, (doublons.get(cle) || 0) + 1);
  }
  return notes.map((n) => ({ ...n, controles: controlesDe(n, { doublons, aujourdhui }) }));
}

module.exports = { controler, TAUX_CONNUS, TOLERANCE };
