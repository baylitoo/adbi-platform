"use strict";

const path = require("path");

const CONTRATS_LIB = path.join(__dirname, "..", "..", "contrats", "lib");

const CACHE_MS = 10 * 60 * 1000;
const FENETRE_MS = 60 * 1000;
const PLAFOND = 30;

const cache = new Map();
const enVol = new Map();
const horodatages = [];

let integrations = null;
let checkName = null;
let raisonIndisponible = "";
try {
  integrations = require(path.join(CONTRATS_LIB, "integrations"));
  ({ checkName } = require(path.join(CONTRATS_LIB, "docanalyze")));
} catch (e) {
  raisonIndisponible = "module de recherche société absent de l'image";
  console.error("[societe] vérification indisponible :", e.message);
}

function correspondance(nomOfficiel, fournisseur) {
  if (!nomOfficiel || !fournisseur || !checkName) return null;
  return Boolean(checkName(nomOfficiel, fournisseur) || checkName(fournisseur, nomOfficiel));
}

function plafondAtteint() {
  const maintenant = Date.now();
  while (horodatages.length && maintenant - horodatages[0] > FENETRE_MS) horodatages.shift();
  if (horodatages.length >= PLAFOND) return true;
  horodatages.push(maintenant);
  return false;
}

async function rechercher(siren) {
  const entree = cache.get(siren);
  if (entree && entree.expire > Date.now()) return entree.valeur;
  if (enVol.has(siren)) return enVol.get(siren);
  if (plafondAtteint()) return { etat: "indisponible", message: "trop de vérifications en une minute, réessayez plus tard" };
  const promesse = integrations.getCompany(siren)
    .then((s) => ({ etat: "trouvee", societe: s }))
    .catch((e) => {
      if (e && e.status === 400) return { etat: "non_verifiable", message: e.message };
      if (e && /aucune (entreprise|société|soci)/i.test(String(e.message))) return { etat: "introuvable" };
      console.error("[societe] recherche en échec :", e && e.message);
      return { etat: "indisponible", message: "service de recherche d'entreprises injoignable" };
    })
    .then((valeur) => {
      if (valeur.etat !== "indisponible") cache.set(siren, { valeur, expire: Date.now() + CACHE_MS });
      return valeur;
    })
    .finally(() => enVol.delete(siren));
  enVol.set(siren, promesse);
  return promesse;
}

// Existence et nom de la société par la recherche publique sans clé ; jamais bloquant.
async function verifierSociete(siren, fournisseur) {
  const le = new Date().toISOString();
  if (!integrations) return { etat: "indisponible", message: raisonIndisponible, le };
  const chiffres = String(siren || "").replace(/\D/g, "");
  if (chiffres.length !== 9) return { etat: "non_verifiable", message: "SIREN absent ou incomplet : société non recherchée.", le };
  const r = await rechercher(chiffres);
  if (r.etat !== "trouvee") return { ...r, le };
  const s = r.societe;
  return {
    etat: "trouvee",
    nom: s.stNom || "",
    etatAdministratif: s.etat || "",
    adresse: s.stAdresse || "",
    source: s._source || "",
    correspondanceNom: correspondance(s.stNom, fournisseur),
    le,
  };
}

module.exports = { verifierSociete };
