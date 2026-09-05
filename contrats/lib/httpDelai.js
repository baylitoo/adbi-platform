// Delais des appels HTTP sortants vers les fournisseurs externes (Yousign,
// Zoho Sign, recherche societe gouv.fr/Pappers/INSEE).
//
// AUCUN de ces appels n'avait de timeout : un fournisseur qui accepte la
// connexion TCP sans jamais repondre (panne partielle, pare-feu qui droppe
// les paquets de reponse, etc.) bloquait la requete Express indefiniment
// (le client HTTP de Node n'a pas de timeout par defaut sur fetch()).
//
// Deux delais distincts : les appels API classiques (JSON, quelques Ko)
// et les envois de document (PDF du contrat, jusqu'a quelques Mo, sur un
// lien parfois plus lent). Personnalisables via variables d'environnement
// (prefixe ADBI_, comme ADBI_HOTE) si un fournisseur donne s'avere trop lent.
const DELAI_HTTP_MS = Number(process.env.ADBI_DELAI_HTTP_MS) || 15000;
const DELAI_UPLOAD_MS = Number(process.env.ADBI_DELAI_UPLOAD_MS) || 60000;

function delaiSignal(ms) {
  return AbortSignal.timeout(ms);
}

// Transforme l'erreur d'abandon (DOMException TimeoutError/AbortError) en
// message clair pour l'utilisateur, sans avaler les autres erreurs.
function messageDelai(fournisseur, ms, e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return new Error(fournisseur + " n'a pas répondu dans le délai imparti (" + Math.round(ms / 1000) + " s).");
  }
  return e;
}

module.exports = { DELAI_HTTP_MS, DELAI_UPLOAD_MS, delaiSignal, messageDelai };
