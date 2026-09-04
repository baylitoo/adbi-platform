/* Abstraction « FournisseurSignature » — pour changer de fournisseur sans
 * toucher au reste de l'application.
 *
 * INTERFACE (chaque fournisseur externe l'implémente) :
 *   verifier()                  → { ok, message }
 *   creerEnveloppe(params)      → { idExterne, signataires:[{email, url}] }
 *   statutEnveloppe(idExterne)  → { statut, statutBrut, signataires }
 *   telechargerSigne(idExterne) → Buffer PDF signé
 *   telechargerPreuve(idExterne)→ Buffer PDF (dossier de preuve) ou null
 *
 * FOURNISSEURS (l'application signe EXCLUSIVEMENT via ces connecteurs — le
 * flux local historique a été retiré en septembre 2026) :
 * - "yousign" : tiers de confiance eIDAS français (lib/fournisseurs/yousign.js) —
 *               OTP e-mail, page de signature hébergée, relances automatiques,
 *               dossier de preuve, horodatage qualifié. Défaut.
 * - "zoho"    : Zoho Sign (lib/fournisseurs/zoho.js) — OAuth2 (refresh token),
 *               région UE possible (sign.zoho.eu), rappels automatiques,
 *               certificat de complétion en guise de dossier de preuve.
 * - Ajouter un connecteur (DocuSign, SignWell…) = un fichier qui exporte la
 *   même interface, déclaré dans EXTERNES ci-dessous + une option dans les
 *   Paramètres. Rien d'autre à toucher.
 */

const fs = require("fs");
const path = require("path");

const SECRETS_PATH = path.join(__dirname, "..", "..", "data", "secrets.json");

const EXTERNES = {
  yousign: require("./yousign"),
  zoho: require("./zoho"),
};

// Le connecteur choisi dans Paramètres ("yousign" par défaut — un ancien
// réglage "local" est ignoré depuis le retrait du flux local).
function fournisseurActif() {
  try {
    const s = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
    if (s.fournisseurSignature && EXTERNES[s.fournisseurSignature]) return s.fournisseurSignature;
  } catch (e) {}
  return "yousign";
}

function externe(nom) {
  return EXTERNES[nom] || null;
}

module.exports = { fournisseurActif, externe, EXTERNES };
