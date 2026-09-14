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
 */

const { ingest, isPdf, estTexteBrut, estDocx, texteDocx } = require("./ingest");
const { segment } = require("./layout");
const { extract } = require("./extract");
const { extraireViaDocie, extraireTexteViaDocie } = require("./docie-extract");

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
 * Choisit la surface DocIE qui correspond a ce que le fichier EST, ou null
 * quand aucune ne convient (le fichier reste alors sur la voie historique).
 *
 * Renvoie une fonction plutot qu'un identifiant de voie : le repli en cas
 * d'echec doit rester UN SEUL bloc `catch`, identique pour les deux surfaces.
 * Deux copies de la regle de repli, c'est deux conventions qui divergent.
 */
function voieDocie(buffer, filename) {
  if (isPdf(buffer)) {
    return (options) => extraireViaDocie(buffer, filename, options);
  }
  if (estTexteBrut(buffer, filename)) {
    // Meme decodage que lib/ingest#readTxt, pour que les deux voies lisent le
    // meme document. La marque d'ordre des octets est retiree : elle n'est pas
    // du contenu, et DocIE recevrait un premier caractere invisible.
    const brut = buffer.toString("utf8");
    const contenu = brut.charCodeAt(0) === 0xfeff ? brut.slice(1) : brut;
    return (options) => extraireTexteViaDocie(contenu, filename, options);
  }
  if (estDocx(buffer, filename)) {
    // Le rendu se fait DANS la fonction renvoyee : un DOCX que mammoth ne sait
    // pas lire tombe dans le meme `catch` que les erreurs DocIE, et la voie
    // historique le refuse ensuite exactement comme drapeau baisse.
    return async (options) => extraireTexteViaDocie(await texteDocx(buffer), filename, options);
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{env?: object, fetchImpl?: Function}} [options]
 * @returns {Promise<object>} cv_master
 */
async function importerCv(buffer, filename, { env = process.env, fetchImpl } = {}) {
  const voie = docieActif(env) ? voieDocie(buffer, filename) : null;
  if (voie) {
    try {
      return await voie({ env, fetchImpl });
    } catch (e) {
      const code = (e && e.code) || "error";
      console.warn(`[docie:repli_local] ${code} — ${(e && e.message) || e}`);
      const master = await extractionLocale(buffer, filename);
      master.source.extraction_method = `local_fallback:${code}`;
      master.quality.warnings.push(`docie_indisponible_repli_local:${code}`);
      return master;
    }
  }
  return extractionLocale(buffer, filename);
}

module.exports = { importerCv, ImportError, docieActif, voieDocie };
