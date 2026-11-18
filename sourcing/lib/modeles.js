"use strict";
// Profil DocIE d'une tâche : le défaut du catalogue partagé s'il est configuré, sinon null (le pont lit DOCIE_MODEL_PROFILE).

const path = require("path");
const CHEMIN_CATALOGUE = path.join(__dirname, "..", "..", "document-parsing", "models", "catalogue.js");

function profilDuCatalogue(tache, env = process.env) {
  const offres = require(CHEMIN_CATALOGUE).modelesOfferts(tache, "texte", { env });
  return offres.length ? offres[0].identifiant : null;
}

module.exports = { profilDuCatalogue };
