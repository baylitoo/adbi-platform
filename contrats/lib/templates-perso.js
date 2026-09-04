// Personnalisation des modèles de contrat (écran Paramètres → « Modèles de contrat »).
//
// Le modèle de base reste la source de vérité dans lib/template.js ; les retouches
// de l'utilisateur (texte des articles, titres, en-tête, pied) vivent dans la
// table PostgreSQL `templates_perso` (lib/db.pg.js) et sont appliquées PAR-DESSUS
// à chaque requête.
// Garde-fou : une retouche de bloc n'est appliquée que si le texte d'ORIGINE
// correspond encore — si template.js évolue (blocs déplacés/réécrits), la
// retouche périmée est ignorée plutôt que posée au mauvais endroit.
//
// Décision de conception (issue #14, PR B) : effectifs() est appelée de façon
// SYNCHRONE par ~10 endroits de server.js (resolveBody, /api/types,
// /api/template/:type, /api/templates-perso/:type…). La rendre asynchrone
// aurait forcé ces ~10 call sites à devenir async pour une donnée qui change
// quasiment jamais (une action admin dans Paramètres). On choisit donc de
// mettre les lignes de `templates_perso` en cache mémoire au démarrage
// (init(), appelée une fois après db.init() dans server.js) : effectifs()
// reste synchrone et lit ce cache ; seules sauver() et reinitialiser()
// (rares, déclenchées par une action admin) sont asynchrones et rafraîchissent
// le cache après écriture en base.

const db = require("./db.pg");
const { TEMPLATES } = require("./template");

// Métadonnées texte éditables d'un modèle (le « défaut » documente le repli
// codé dans les rendus quand la valeur de base est vide).
const META_DEFS = [
  { cle: "titre", libelle: "Titre du modèle (couverture + menu)", defaut: "" },
  { cle: "headerTitle", libelle: "Titre de l'en-tête répété", defaut: "CONVENTION DE SOUS-TRAITANCE D'ASSISTANCE TECHNIQUE" },
  { cle: "headerNum", libelle: "Ligne n° de contrat (en-tête)", defaut: "N° de contrat : {{numeroContrat}}" },
  { cle: "footerText", libelle: "Pied de page", defaut: "Convention de sous-traitance — Contrat n° {{numeroContrat}}" },
];

// Cache mémoire : { [type]: { meta, blocs } }, reflet de la table Postgres.
// Vide (objet {}) tant que init() n'a pas été appelée — utilisé alors comme
// "aucune personnalisation", exactement comme un fichier absent avant.
let cache = {};

// À appeler une fois au démarrage du serveur, APRÈS db.init() (la table doit
// exister). Idempotent : peut être rappelée (ex. tests) pour recharger le cache.
async function init() {
  cache = await db.chargerTemplatesPerso();
}

// Templates EFFECTIFS : base + retouches. C'est CETTE vue que le serveur sert
// partout (aperçu, exports PDF/Word/ZIP, PDF des demandes de signature).
function effectifs() {
  const out = {};
  for (const [type, tpl] of Object.entries(TEMPLATES)) {
    const p = cache[type];
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
async function sauver(type, donnees) {
  const base = TEMPLATES[type];
  if (!base) throw new Error("Type de contrat inconnu.");
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
  if (!Object.keys(entree.meta).length && !entree.blocs.length) {
    delete cache[type];
  } else {
    cache[type] = entree;
  }
  await db.sauverTemplatesPerso(type, entree);
  return { ok: true, blocsModifies: entree.blocs.length, metaModifiees: Object.keys(entree.meta).length };
}

// Retour complet au modèle d'origine pour un type.
async function reinitialiser(type) {
  delete cache[type];
  await db.reinitialiserTemplatesPerso(type);
}

module.exports = { init, effectifs, sauver, reinitialiser, META_DEFS };
