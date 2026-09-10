/**
 * Chaine d'import d'un CV : fichier -> cv_master, deux voies possibles.
 *
 * Voie historique (par defaut, toujours active) : lib/ingest -> lib/layout ->
 * lib/extract, heuristiques de mise en page sur du texte positionne.
 *
 * Voie DocIE (issue #152, derriere DOCIE_EXTRACTION_ENABLED) : le PDF est
 * envoye tel quel au bridge partage (document-parsing/bridge/docie-bridge.js,
 * issue #150) puis reprojete dans le meme cv_master par lib/docie-extract.js.
 * Reservee aux PDF : DOCX et texte brut n'ont pas de contrat DocIE (voir
 * document-parsing/bridge/README.md) et continuent de passer par la voie
 * historique meme drapeau actif.
 *
 * En cas d'echec DocIE (configuration, reseau, timeout, reponse invalide...),
 * on se replie sur la voie historique pour CETTE requete plutot que de
 * renvoyer une erreur : l'import ne doit jamais rester bloque a cause d'une
 * indisponibilite DocIE. Le repli est trace dans `source.extraction_method`
 * et `quality.warnings`, jamais silencieux.
 */

const { ingest, isPdf } = require("./ingest");
const { segment } = require("./layout");
const { extract } = require("./extract");
const { extraireViaDocie } = require("./docie-extract");

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
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{env?: object, fetchImpl?: Function}} [options]
 * @returns {Promise<object>} cv_master
 */
async function importerCv(buffer, filename, { env = process.env, fetchImpl } = {}) {
  if (docieActif(env) && isPdf(buffer)) {
    try {
      return await extraireViaDocie(buffer, filename, { env, fetchImpl });
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

module.exports = { importerCv, ImportError, docieActif };
