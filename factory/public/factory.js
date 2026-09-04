/* ADBI Factory — construction du hub et rafraîchissement de l'état des modules.
   Les fonctions icone / echapper / chargerModules viennent de rail.js. */

const LIBELLES_ETAT = {
  pret: "En marche",
  demarrage: "Démarrage…",
  arrete: "Arrêté",
  statique: "Prêt",
  indisponible: "Introuvable",
  erreur: "Erreur",
  bientot: "Bientôt",
};

// Teinte de bordure par tuile, à la manière des cartes « Mon espace » de
// CYNOV : la couleur tourne, stable pour un module donné (ordre du fichier).
const TEINTES_TUILES = ["bleu", "orange", "ciel", "nuit"];
let _rangTuile = 0;

function construireTuile(m) {
  const dispo = m.type !== "bientot";
  const el = document.createElement(dispo ? "button" : "div");
  el.className = "tuile" + (dispo ? "" : " bientot");
  el.dataset.id = m.id;
  el.dataset.teinte = TEINTES_TUILES[_rangTuile++ % TEINTES_TUILES.length];
  if (dispo) el.type = "button";

  el.innerHTML =
    '<div class="icone">' + icone(m.icone) + "</div>" +
    "<h2>" + echapper(m.nom) + "</h2>" +
    '<div class="accroche">' + echapper(m.accroche) + "</div>" +
    '<p class="detail">' + echapper(m.detail) + "</p>" +
    '<div class="tags">' +
      (m.tags || []).map((t) => '<span class="tag">' + echapper(t) + "</span>").join("") +
    "</div>" +
    '<div class="pied">' +
      '<span class="etat ' + m.etat + '"><span class="point"></span>' +
      (LIBELLES_ETAT[m.etat] || m.etat) +
      "</span>" +
      (dispo ? '<span class="ouvrir">+ Ouvrir</span>' : "") +
    "</div>";

  if (dispo) {
    el.addEventListener("click", () => {
      window.location.href = "/module.html?m=" + encodeURIComponent(m.id);
    });
  }
  return el;
}

/** Met à jour uniquement la pastille d'état si la tuile existe déjà (évite le clignotement). */
function majEtat(m) {
  const pastille = document.querySelector('.tuile[data-id="' + m.id + '"] .etat');
  if (!pastille) return;
  pastille.className = "etat " + m.etat;
  pastille.innerHTML = '<span class="point"></span>' + (LIBELLES_ETAT[m.etat] || m.etat);
}

async function rafraichir(premier) {
  let modules;
  try {
    modules = await chargerModules(!premier);
  } catch (err) {
    return;
  }

  if (premier) {
    const actifs = document.getElementById("grille-actifs");
    const bientot = document.getElementById("grille-bientot");
    for (const m of modules) {
      (m.type === "bientot" ? bientot : actifs).appendChild(construireTuile(m));
    }
    document.getElementById("titre-bientot").hidden = bientot.children.length === 0;
  } else {
    for (const m of modules) majEtat(m);
  }
}

construireRail(null);
rafraichir(true);
setInterval(() => rafraichir(false), 5000);
