/**
 * Chaine d'import d'un CV : fichier -> cv_master, deux voies possibles.
 *
 * Voie historique (par defaut, toujours active) : lib/ingest -> lib/layout ->
 * lib/extract, heuristiques de mise en page sur du texte positionne.
 *
 * Voie DocIE (issues #152 et #180, derriere DOCIE_EXTRACTION_ENABLED) : le
 * document est envoye au bridge partage (document-parsing/bridge/docie-bridge.js,
 * issue #150) puis reprojete dans le meme cv_master par lib/docie-extract.js.
 *
 * DocIE expose DEUX surfaces, et on choisit celle qui correspond a ce que la
 * source EST reellement — regle d'aiguillage de leur equipe (#180), pas une
 * preference pour l'une des deux :
 *
 *   - un PDF part en fichier (/v1/agents/{agent}/chat/completions), qu'il
 *     porte une couche texte ou qu'il soit scanne : c'est la seule voie qui
 *     declenche l'OCR distant. On ne lui substitue jamais la voie texte, un
 *     scan n'ayant aucun texte a envoyer ;
 *   - un depot texte part en texte (/v1/extract/text), sans enveloppe data
 *     URI : il possede deja ce que l'autre voie devrait faire reconstruire ;
 *   - un .docx part aussi en texte : ses paragraphes sont du texte. Il est rendu
 *     par lib/ingest#texteDocx a partir du meme HTML mammoth que la voie
 *     historique, et non par `mammoth.extractRawText`, qui colle les lignes
 *     separees par un retour manuel et disperse les cellules de tableau —
 *     mesure et detail sur texteDocx (#180). Un .doc (binaire, illisible par
 *     mammoth) reste sur la voie historique.
 *
 * En cas d'echec DocIE (configuration, reseau, timeout, reponse invalide...),
 * on se replie sur la voie historique pour CETTE requete plutot que de
 * renvoyer une erreur : l'import ne doit jamais rester bloque a cause d'une
 * indisponibilite DocIE. Le repli est trace dans `source.extraction_method`
 * et `quality.warnings`, jamais silencieux.
 *
 * SAUF modele explicitement choisi (#194, lib/choix-modele.js) : un modele
 * choisi ne retombe ni sur un autre modele ni sur l'analyse locale. Le choix est
 * verifie sur le document reel (lignes non vides, pages), envoye pour CET appel
 * (`modelProfile` voie texte, `agent` voie fichier), et toute erreur — refus du
 * catalogue, erreur nommee du bridge — sort telle quelle : la tache echoue.
 */

const { ingest, isPdf, estTexteBrut, estDocx, texteDocx } = require("./ingest");
const { segment } = require("./layout");
const { extract } = require("./extract");
const { extraireViaDocie, extraireTexteViaDocie, extraireTexteViaOpenAI } = require("./docie-extract");

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

function docieActif(env) {
  return String((env || process.env).DOCIE_EXTRACTION_ENABLED || "").trim().toLowerCase() === "true";
}

async function extractionLocale(buffer, filename) {
  const doc = await ingest(buffer, filename);

  if (doc.scanned) {
    throw new ImportError(422,
      "Ce PDF ne contient pas de texte : il s'agit probablement d'un scan ou d'une image. " +
      "Exportez le CV en PDF texte ou en Word, puis réimportez-le.");
  }
  if (!doc.charCount) {
    throw new ImportError(422, "Aucun texte n'a pu être lu dans ce fichier.");
  }

  return extract(doc, segment(doc));
}

/**
 * Ce que le fichier EST pour DocIE : { voie: "agent" } pour un PDF,
 * { voie: "texte", texte() } pour un depot texte ou un .docx, null sinon.
 * `texte()` rend le texte envoye ; un DOCX illisible y leve son erreur.
 */
function sourceDocie(buffer, filename) {
  if (isPdf(buffer)) return { voie: "agent" };
  if (estTexteBrut(buffer, filename)) {
    // Meme decodage que lib/ingest#readTxt, pour que les deux voies lisent le
    // meme document. La marque d'ordre des octets est retiree : elle n'est pas
    // du contenu, et DocIE recevrait un premier caractere invisible.
    return {
      voie: "texte",
      texte: async () => {
        const brut = buffer.toString("utf8");
        return brut.charCodeAt(0) === 0xfeff ? brut.slice(1) : brut;
      },
    };
  }
  // Le rendu se fait a l'appel de texte() : un DOCX que mammoth ne sait pas lire
  // tombe dans le meme `catch` que les erreurs DocIE, et la voie historique le
  // refuse ensuite exactement comme drapeau baisse.
  if (estDocx(buffer, filename)) return { voie: "texte", texte: () => texteDocx(buffer) };
  return null;
}

/**
 * Choisit la surface DocIE qui correspond a ce que le fichier EST, ou null
 * quand aucune ne convient (le fichier reste alors sur la voie historique).
 *
 * Renvoie une fonction plutot qu'un identifiant de voie : le repli en cas
 * d'echec doit rester UN SEUL bloc `catch`, identique pour les deux surfaces.
 * Deux copies de la regle de repli, c'est deux conventions qui divergent.
 */
function voieDocie(buffer, filename) {
  const source = sourceDocie(buffer, filename);
  if (!source) return null;
  if (source.voie === "agent") return (options) => extraireViaDocie(buffer, filename, options);
  return async (options) => extraireTexteViaDocie(await source.texte(), filename, options);
}

/** Modele qui a reellement servi, range dans la source du cv_master (#194). */
function noterModele(master, voie, demande, env) {
  // eslint-disable-next-line global-require
  const { modeleServi } = require("./choix-modele");
  master.source.modele = { voie, demande, servi: modeleServi(voie, master.source.docie, env) };
  return master;
}

/**
 * Import avec un modele explicitement choisi (#194) : aucun `catch`, aucun
 * repli. Refus du catalogue (CatalogueError : modele_non_propose, limite,
 * configuration), format sans voie DocIE (ImportError) et erreurs du bridge
 * sortent tels quels.
 */
async function importerAvecModele(buffer, filename, { env, fetchImpl, modele }) {
  // eslint-disable-next-line global-require
  const choix = require("./choix-modele");
  if (!docieActif(env)) {
    throw new (choix.chargerCatalogue().CatalogueError)("configuration",
      "Choix du modèle impossible : l'extraction DocIE est désactivée sur ce service.");
  }
  const source = sourceDocie(buffer, filename);
  if (!source) {
    throw new ImportError(422, "Le modèle choisi lit les PDF, les documents Word (.docx) et le texte : " +
      "convertissez ce fichier, ou importez-le sans choisir de modèle.");
  }

  // Resultat partiel rapporte par le bridge (#203) : avertissement nomme par
  // champ et marque de relecture poses par mapperAdbiResume, sur toutes les
  // voies DocIE, choix ou non — rien a ajouter ici.
  const options = { env, fetchImpl };
  let master;
  if (source.voie === "agent") {
    const offre = choix.choisir("agent", modele, { pages: await choix.compterPages(buffer) }, env);
    master = await extraireViaDocie(buffer, filename, { ...options, agent: offre.identifiant });
  } else {
    const texte = await source.texte();
    const offre = choix.choisir("texte", modele, { lignesNonVides: choix.compterLignesNonVides(texte) }, env);
    // Modele EXTERNE (#194) : le texte part chez le fournisseur, pas chez
    // DocIE. `offre.identifiant` est alors le MODE du transport
    // (`rapide` / `raisonnement`) et non un profil DocIE — le passer a
    // extraireTexteViaDocie demanderait a DocIE un modele nomme « rapide ».
    // Aucun repli ici non plus : cette fonction n'a deja aucun catch.
    master = choix.estExterne(offre)
      ? await extraireTexteViaOpenAI(texte, filename, { ...options, mode: offre.mode })
      : await extraireTexteViaDocie(texte, filename, { ...options, modelProfile: offre.identifiant });
  }
  return noterModele(master, source.voie, modele, env);
}

/*
 * Codes d'echec qu'un repli externe ne doit JAMAIS rejouer — meme liste que
 * cv-parser (docie_client._CODES_SANS_REPLI), pour les memes raisons :
 *   - `timeout` : DocIE peut encore etre en train de traiter le document ET de
 *     le facturer. Relancer ailleurs paie deux fois le meme travail, ce que le
 *     README du pont interdit explicitement ;
 *   - `input` : le document lui-meme est inutilisable ; le fournisseur externe
 *     le refuserait pour la meme raison, au prix d'un aller-retour de plus.
 */
const CODES_SANS_REPLI = new Set(["timeout", "input"]);

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{env?: object, fetchImpl?: Function, modele?: string, repliExterne?: boolean}} [options]
 *   `modele` : identifiant du catalogue explicitement choisi (#194).
 *   `repliExterne` : case cochee au depot — si DocIE echoue, reessayer chez le
 *   fournisseur HORS ADBI plutot que de retomber sur l'analyse locale.
 * @returns {Promise<object>} cv_master
 */
async function importerCv(buffer, filename, { env = process.env, fetchImpl, modele = null, repliExterne = false } = {}) {
  if (modele) return importerAvecModele(buffer, filename, { env, fetchImpl, modele });
  const source = docieActif(env) ? sourceDocie(buffer, filename) : null;
  const voie = source ? voieDocie(buffer, filename) : null;
  if (voie) {
    let master;
    try {
      master = await voie({ env, fetchImpl });
    } catch (e) {
      const code = (e && e.code) || "error";
      console.warn(`[docie:repli_local] ${code} — ${(e && e.message) || e}`);
      // Repli EXTERNE, coche au depot : le consentement a ete donne AVANT
      // l'envoi, pour ce depot-la, car le texte du CV — donnee personnelle d'un
      // candidat — va quitter ADBI. Deux conditions, non negociables :
      //   - voie TEXTE : sur un scan (voie agent) il n'y a AUCUN texte a
      //     envoyer. Le repli y est sans objet, et on garde l'analyse locale en
      //     le disant, plutot que de transformer en echec un import qui marche ;
      //   - cause rejouable : voir CODES_SANS_REPLI.
      if (repliExterne && source.voie === "texte" && !CODES_SANS_REPLI.has(code)) {
        const texte = await source.texte();
        // Si CE second essai echoue, son erreur sort telle quelle : pas de
        // troisieme chemin, pas d'analyse locale en silence.
        const externe = await extraireTexteViaOpenAI(texte, filename, { env, fetchImpl, mode: "rapide" });
        externe.source.extraction_method = `repli_externe:${code}`;
        externe.quality.warnings.push(`docie_indisponible_repli_externe:${code}`);
        return externe;
      }
      const local = await extractionLocale(buffer, filename);
      local.source.extraction_method = `local_fallback:${code}`;
      local.quality.warnings.push(`docie_indisponible_repli_local:${code}`);
      // Case cochee mais repli impossible : le DIRE. Sans cela, l'utilisateur
      // croit que son CV est parti chez le fournisseur alors qu'il n'en est
      // rien — ou l'inverse, ce qui serait pire.
      if (repliExterne) {
        local.quality.warnings.push(source.voie === "texte"
          ? `repli_externe_impossible:${code}`
          : "repli_externe_impossible:sans_texte");
      }
      return local;
    }
    return noterModele(master, source.voie, null, env);
  }
  return extractionLocale(buffer, filename);
}

module.exports = { importerCv, ImportError, docieActif, voieDocie, sourceDocie };
