/* ADBI Factory — éléments partagés par le hub et le conteneur de module :
   jeu d'icônes, chargement des modules et rail de navigation latéral. */

const ICONES = {
  accueil:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/>' +
    '<rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  document:
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 12h6M9 16h4"/>',
  contrat:
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 8V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7"/><path d="M3 15h7"/><path d="M7 12l3 3-3 3"/>',
  calcul:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
  pilotage:
    '<path d="M4 19h16"/><rect x="5" y="11" width="3.5" height="6" rx="1"/><rect x="10.25" y="7" width="3.5" height="10" rx="1"/><rect x="15.5" y="13" width="3.5" height="4" rx="1"/>',
  parser:
    '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 13l2 2 4-4"/>',
  coffre:
    '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
  signature:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  lune:
    '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8z"/>',
  soleil:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

function icone(nom) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    (ICONES[nom] || ICONES.document) +
    "</svg>"
  );
}

function echapper(texte) {
  const d = document.createElement("div");
  d.textContent = texte == null ? "" : String(texte);
  return d.innerHTML;
}

/** Un seul appel a l'API par page : le hub et le rail partagent la reponse. */
let promesseModules = null;
function chargerModules(force) {
  if (!promesseModules || force) {
    promesseModules = fetch("/api/modules")
      .then((r) => r.json())
      .then((d) => d.modules);
  }
  return promesseModules;
}

/** Construit le rail : accueil, puis un raccourci par module utilisable. */
async function construireRail(idActif) {
  const rail = document.getElementById("rail");
  if (!rail) return;

  const modules = await chargerModules();

  // La marque fait aussi office de bouton « accueil » : une seule icône grille.
  rail.innerHTML =
    '<a class="marque' + (idActif ? "" : " actif") + '" href="/" data-titre="Tous les modules">' +
    icone("accueil") +
    "</a>";

  for (const m of modules) {
    if (m.type === "bientot") continue;
    const lien = document.createElement("a");
    lien.className = "rail-bouton" + (m.id === idActif ? " actif" : "");
    lien.href = "/module.html?m=" + encodeURIComponent(m.id);
    lien.dataset.titre = m.nom;
    lien.innerHTML = icone(m.icone);
    rail.appendChild(lien);
  }

  const bascule = construireBasculeTheme();
  if (bascule) rail.appendChild(bascule);
}

/**
 * adbi-theme.js est-il bien chargé ?
 *
 * Il est servi par une route ajoutée au serveur : une Factory restée sur une
 * version antérieure renvoie 404, et tout ce qui appelle ADBI_THEME sans
 * vérifier casse la page. On dégrade donc proprement — pas de bascule, thème
 * par défaut — au lieu de faire échouer le rail ou l'ouverture d'un module.
 */
function themeDisponible() {
  return !!(window.ADBI_THEME && typeof window.ADBI_THEME.lire === "function");
}

/** Thème courant, ou le thème par défaut (clair) si la charte n'est pas chargée. */
function themeCourant() {
  return themeDisponible() ? window.ADBI_THEME.lire() : "clair";
}

/**
 * Bouton sombre / clair, en pied de rail. Il pilote la Factory et pousse le
 * thème au module affiché en cadre (chaque application a sa propre origine,
 * elle ne voit donc pas la préférence enregistrée par la Factory).
 * Renvoie null si la bascule n'est pas disponible.
 */
function construireBasculeTheme() {
  if (!themeDisponible()) return null;

  const bouton = document.createElement("button");
  bouton.type = "button";
  bouton.className = "rail-bouton espace";

  const peindre = () => {
    const clair = window.ADBI_THEME.lire() === window.ADBI_THEME.CLAIR;
    // On montre la destination, pas l'état courant : en clair, la lune propose
    // de passer en sombre.
    bouton.innerHTML = icone(clair ? "lune" : "soleil");
    bouton.dataset.titre = clair ? "Passer en sombre" : "Passer en clair";
    bouton.setAttribute("aria-label", bouton.dataset.titre);
  };

  bouton.addEventListener("click", () => {
    window.ADBI_THEME.basculer();
    peindre();
  });

  peindre();
  return bouton;
}
