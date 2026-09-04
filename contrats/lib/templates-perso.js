// Personnalisation des modèles de contrat (écran Paramètres → « Modèles de contrat »).
//
// Le modèle de base reste la source de vérité dans lib/template.js ; les retouches
// de l'utilisateur (texte des articles, titres, en-tête, pied) vivent dans
// data/templates-perso.json et sont appliquées PAR-DESSUS à chaque requête.
// Garde-fou : une retouche de bloc n'est appliquée que si le texte d'ORIGINE
// correspond encore — si template.js évolue (blocs déplacés/réécrits), la
// retouche périmée est ignorée plutôt que posée au mauvais endroit.

const fs = require("fs");
const path = require("path");
const { TEMPLATES } = require("./template");

const FILE = path.join(__dirname, "..", "data", "templates-perso.json");

// Métadonnées texte éditables d'un modèle (le « défaut » documente le repli
// codé dans les rendus quand la valeur de base est vide).
const META_DEFS = [
  { cle: "titre", libelle: "Titre du modèle (couverture + menu)", defaut: "" },
  { cle: "headerTitle", libelle: "Titre de l'en-tête répété", defaut: "CONVENTION DE SOUS-TRAITANCE D'ASSISTANCE TECHNIQUE" },
  { cle: "headerNum", libelle: "Ligne n° de contrat (en-tête)", defaut: "N° de contrat : {{numeroContrat}}" },
  { cle: "footerText", libelle: "Pied de page", defaut: "Convention de sous-traitance — Contrat n° {{numeroContrat}}" },
];

function charger() {
  try {
    if (fs.existsSync(FILE)) {
      const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (d && typeof d === "object") return d;
    }
  } catch (e) { /* fichier corrompu : on repart sans personnalisation */ }
  return {};
}

function sauverFichier(d) {
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

// Templates EFFECTIFS : base + retouches. C'est CETTE vue que le serveur sert
// partout (aperçu, exports PDF/Word/ZIP, PDF des demandes de signature).
function effectifs() {
  const perso = charger();
  const out = {};
  for (const [type, tpl] of Object.entries(TEMPLATES)) {
    const p = perso[type];
    if (!p) { out[type] = tpl; continue; }
    const copie = JSON.parse(JSON.stringify(tpl));
    META_DEFS.forEach(({ cle }) => {
      if (typeof (p.meta || {})[cle] === "string") copie[cle] = p.meta[cle];
    });
    (p.blocs || []).forEach((b) => {
      const cible = copie.blocks[b.i];
      if (cible && cible.x === b.original) cible.x = b.texte;
    });
    out[type] = copie;
  }
  return out;
}

// Enregistre l'état voulu pour un type : seuls les écarts avec la base sont retenus.
function sauver(type, donnees) {
  const base = TEMPLATES[type];
  if (!base) throw new Error("Type de contrat inconnu.");
  const perso = charger();
  const entree = { meta: {}, blocs: [] };
  META_DEFS.forEach(({ cle }) => {
    const v = (donnees.meta || {})[cle];
    if (typeof v === "string" && v.trim() !== String(base[cle] || "").trim()) entree.meta[cle] = v.trim();
  });
  (donnees.blocs || []).forEach((b) => {
    const i = parseInt(b.i, 10);
    const cible = Number.isInteger(i) ? base.blocks[i] : null;
    if (!cible || typeof cible.x !== "string") return;
    if (cible.x !== b.original) return;                 // retouche périmée / incohérente
    if (typeof b.texte !== "string" || b.texte === cible.x) return; // pas de changement
    entree.blocs.push({ i, original: b.original, texte: b.texte });
  });
  if (!Object.keys(entree.meta).length && !entree.blocs.length) delete perso[type];
  else perso[type] = entree;
  sauverFichier(perso);
  return { ok: true, blocsModifies: entree.blocs.length, metaModifiees: Object.keys(entree.meta).length };
}

// Retour complet au modèle d'origine pour un type.
function reinitialiser(type) {
  const perso = charger();
  delete perso[type];
  sauverFichier(perso);
}

module.exports = { effectifs, sauver, reinitialiser, META_DEFS };
