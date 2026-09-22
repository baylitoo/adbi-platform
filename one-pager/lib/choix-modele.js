"use strict";

/**
 * Choix du modele d'extraction d'un CV importe, par action (#194).
 *
 * Le catalogue partage (document-parsing/models/catalogue.json et son chargeur
 * catalogue.js, source unique) dit quels modeles proposer pour la tache
 * `resume`, sur quelle voie DocIE, avec quel identifiant reel
 * (DOCIE_MODELE_<MODELE> voie texte, DOCIE_AGENT_RESUME_<MODELE> voie agent).
 * Ce module ne fait que l'appliquer a one-pager :
 *
 * - la VOIE suit l'aiguillage existant de lib/import-pipeline (#180) : PDF ->
 *   voie agent (fichier), depot texte et .docx -> voie texte ;
 * - rien n'est propose tant que DOCIE_EXTRACTION_ENABLED n'est pas actif :
 *   proposer un modele que l'import ne peut pas appeler finirait en analyse
 *   locale, precisement ce que le choix interdit ;
 * - le selecteur (public/app.js) ne s'affiche qu'a partir de DEUX modeles ;
 * - un choix EXPLICITE = un champ `modele` non vide dans POST /api/import. Le
 *   selecteur, quand il est affiche, l'envoie toujours (defaut compris). Il est
 *   verifie sur le document REEL avant l'envoi (lignes non vides, pages) et
 *   n'est jamais remplace : refus nomme (CatalogueError `modele_non_propose`,
 *   `limite`, `configuration`), jamais de repli local.
 *
 * Le chargeur n'est `require` qu'a l'appel, comme le bridge : sans le fichier
 * (image sans la copie du Dockerfile), l'import sans choix fonctionne encore.
 */

const TACHE = "resume";

/*
 * Modeles HORS ADBI (#194) : le catalogue ne les propose que si le consommateur
 * les demande (option `externes`) ET que la cle du fournisseur est renseignee.
 * Voie TEXTE uniquement — le fournisseur ne declare que `texte`
 * (catalogue.json), et la voie agent enverrait le document LUI-MEME, pas son
 * texte, donc un scan entier plutot que ce que nous en avons lu.
 *
 * DONNEES PERSONNELLES : un CV est la donnee d'un CANDIDAT, pas un document
 * d'entreprise comme les cinq pieces de contrats. #194 avait ecarte le CV pour
 * cette raison (« en attente du proprietaire ») ; le proprietaire a tranche, a
 * la condition que l'utilisateur soit AVERTI, au moment du choix, que le texte
 * part chez un tiers — voir public/app.js. Jamais un defaut, jamais un repli.
 */
const EXTERNES = true;

function chargerCatalogue() {
  // eslint-disable-next-line global-require
  return require("../../document-parsing/models/catalogue");
}

function chargerPont() {
  // eslint-disable-next-line global-require
  return require("../../document-parsing/bridge/docie-bridge");
}

// Noms des modeles prets sur le store DocIE, dernier releve du pont ; pont absent : [].
function storePret() {
  try { return chargerPont().storeUtilisableConnu().map((m) => m.nom).filter(Boolean); } catch { return []; }
}

// Relit le store (cache 5 min du pont) avant un rendu de selecteur ou une verification.
async function rafraichirStore(env = process.env) {
  try { await chargerPont().storeUtilisable({ env }); } catch { /* releve precedent conserve */ }
}

function docieActif(env) {
  // eslint-disable-next-line global-require
  return require("./import-pipeline").docieActif(env);
}

/**
 * { texte: [ids], agent: [ids] } : modeles proposes par voie. Le navigateur
 * envoie `modele` pour un fichier des qu'au moins un modele est propose pour SA
 * voie (PDF -> agent, texte et .docx -> texte), selecteur affiche ou non — meme
 * regle que contrats (#210).
 */
function offresParVoie(env = process.env) {
  if (!docieActif(env)) return { texte: [], agent: [] };
  const catalogue = chargerCatalogue();
  const store = storePret();
  const offres = {};
  for (const voie of ["texte", "agent"]) {
    offres[voie] = catalogue.modelesOfferts(TACHE, voie, { env, externes: voie === "texte" && EXTERNES, store }).map((o) => o.id);
  }
  return offres;
}

/** Modeles du selecteur, defaut d'abord : [{ id, libelle, description, role, experimental }]. */
function modelesProposes(env = process.env) {
  if (!docieActif(env)) return [];
  const catalogue = chargerCatalogue();
  const store = storePret();
  const vus = new Map();
  // Voies des formats acceptes, reunies : le format du prochain fichier n'est
  // pas connu ; un modele configure sur une seule voie est verifie a l'envoi.
  for (const voie of ["texte", "agent"]) {
    for (const o of catalogue.modelesOfferts(TACHE, voie, { env, externes: voie === "texte" && EXTERNES, store })) {
      if (!vus.has(o.id)) {
        vus.set(o.id, { id: o.id, libelle: o.libelle, description: o.description, role: o.role, experimental: o.experimental === true });
      }
    }
  }
  return [...vus.values()].sort((a, b) => (a.role === "defaut" ? 0 : 1) - (b.role === "defaut" ? 0 : 1));
}

/**
 * Le modele `modele` pour `voie`, verifie sur `document`
 * ({ lignesNonVides } voie texte, { pages } voie agent, pages null = illisible).
 * Leve CatalogueError ; ne rend jamais un autre modele que celui demande.
 */
function choisir(voie, modele, document, env = process.env) {
  const catalogue = chargerCatalogue();
  const illisible = voie === "agent" && document.pages == null;
  const offre = catalogue.choisirModele(TACHE, voie, {
    env, modele, document: illisible ? null : document, externes: voie === "texte" && EXTERNES, store: storePret(),
  });
  if (illisible && typeof offre.limites.pages_max === "number") {
    // Une limite non verifiable n'est pas une limite respectee.
    throw new catalogue.CatalogueError("limite",
      `${offre.libelle} : nombre de pages du document illisible, limite de ${offre.limites.pages_max} pages non vérifiable.`);
  }
  return offre;
}

function compterLignesNonVides(texte) {
  return chargerCatalogue().compterLignesNonVides(texte);
}

/** Pages d'un PDF (meme lecteur que lib/ingest), ou null s'il est illisible. */
async function compterPages(buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }).promise;
    const pages = doc.numPages;
    await doc.destroy();
    return pages;
  } catch {
    return null;
  }
}

/**
 * Modele qui a REELLEMENT servi, lu dans les metadonnees DocIE (`model` voie
 * texte, `agent` voie agent) : { id, libelle } ou null — meme forme que contrats
 * (#210), sans l'identifiant configure. Sans correspondance, le nom brut rapporte
 * par DocIE, jamais le modele demande. Catalogue illisible : le nom brut, jamais
 * une exception.
 */
function modeleServi(voie, metadata, env = process.env) {
  let servi;
  try {
    servi = chargerCatalogue().modeleServi(TACHE, voie, { env, metadata, store: storePret() });
  } catch {
    const brut = voie === "agent" ? (metadata || {}).agent : (metadata || {}).model;
    servi = typeof brut === "string" && brut.trim() ? { id: null, libelle: brut } : null;
  }
  return servi ? { id: servi.id, libelle: servi.libelle } : null;
}

/**
 * Le modele choisi est-il servi par un fournisseur HORS ADBI ?
 *
 * Quand c'est vrai, `offre.identifiant` est le MODE du transport
 * (`rapide` / `raisonnement`) et non un profil DocIE : l'envoyer a
 * extraireTexteViaDocie demanderait a DocIE un modele nomme « rapide ».
 */
function estExterne(offre) {
  return Boolean(offre && typeof offre.fournisseur === "string" && offre.fournisseur);
}

module.exports = { modelesProposes, offresParVoie, choisir, estExterne, compterLignesNonVides, compterPages, modeleServi, chargerCatalogue, rafraichirStore, storePret, TACHE };
