"use strict";
// Types de pièces du dossier salarié : libellés, champs saisissables et passage du résultat DocIE aux valeurs.

const path = require("path");

const CONTRATS_LIB = path.join(__dirname, "..", "..", "contrats", "lib");
const { mapCniResult } = require(path.join(CONTRATS_LIB, "cni-mapping"));
const { mapRibResult, IBAN_ABSENT } = require(path.join(CONTRATS_LIB, "rib-mapping"));
const { normalizeDate } = require(path.join(CONTRATS_LIB, "kbis-mapping"));

const SCHEMAS_DIR = path.join(__dirname, "..", "..", "document-parsing", "schemas");

const TYPES = {
  cni: {
    libelle: "Pièce d'identité (CNI ou passeport)",
    schema: "cni.schema.json",
    champs: [
      ["nom", "Nom de naissance"], ["nomUsage", "Nom d'usage"], ["prenoms", "Prénoms"], ["sexe", "Sexe"],
      ["dateNaissance", "Date de naissance", "date"], ["lieuNaissance", "Lieu de naissance"],
      ["nationalite", "Nationalité"], ["numeroDocument", "Numéro du titre"],
      ["dateExpiration", "Date d'expiration", "date"], ["mrzLigne1", "MRZ ligne 1"], ["mrzLigne2", "MRZ ligne 2"],
    ],
  },
  rib: {
    libelle: "RIB",
    schema: "rib.schema.json",
    champs: [["titulaire", "Titulaire du compte"], ["iban", "IBAN"], ["bic", "BIC"], ["banque", "Banque"]],
  },
  carte_vitale: {
    libelle: "Carte Vitale",
    schema: "carte_vitale.schema.json",
    champs: [["nir", "N° de sécurité sociale (NIR)"], ["nom", "Nom"], ["prenoms", "Prénoms"]],
  },
  justificatif_domicile: {
    libelle: "Justificatif de domicile (< 3 mois)",
    schema: "justificatif_domicile.schema.json",
    champs: [["emetteur", "Émetteur"], ["titulaire", "Titulaire"], ["adresse", "Adresse"], ["dateDocument", "Date du document", "date"]],
  },
  diplome: {
    libelle: "Diplôme(s)",
    schema: "diplome.schema.json",
    champs: [["intitule", "Intitulé"], ["titulaire", "Titulaire"], ["etablissement", "Établissement"], ["dateObtention", "Date d'obtention", "date"]],
  },
};

const ATTENDUS_DEFAUT = ["cni", "rib", "carte_vitale", "justificatif_domicile", "diplome"];

function estType(type) {
  return typeof type === "string" && Object.hasOwn(TYPES, type);
}

function chargerSchema(type) {
  return require(path.join(SCHEMAS_DIR, TYPES[type].schema));
}

function chaine(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

// Champs DocIE (noms du schéma) -> clés de valeurs, pour les trois nouveaux types.
const CHAMPS_NOUVEAUX = {
  carte_vitale: { nir: "nir", nom: "nom", prenoms: "prenoms" },
  justificatif_domicile: { emetteur: "emetteur", titulaire: "titulaire", adresse: "adresse", date_document: "dateDocument" },
  diplome: { intitule: "intitule", titulaire: "titulaire", etablissement: "etablissement", date_obtention: "dateObtention" },
};

function mapperNouveau(type, result) {
  const avertissements = [];
  const valeurs = {};
  for (const [cleDocie, cle] of Object.entries(CHAMPS_NOUVEAUX[type])) {
    valeurs[cle] = cle.startsWith("date") ? normalizeDate(result[cleDocie], cleDocie, avertissements) : chaine(result[cleDocie]);
  }
  return { valeurs, avertissements };
}

/** Résultat déballé du pont -> { valeurs, analyse } ; `analyse` ne garde que les constats lisibles. */
function versValeurs(type, reponse) {
  const result = reponse && reponse.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("Résultat DocIE invalide.");
  const validation = reponse.metadata && reponse.metadata.validation;
  if (type === "cni") {
    const { analysis, warnings } = mapCniResult(result, { items: [{ id: "cni" }], validation });
    const valeurs = {};
    for (const [cle] of TYPES.cni.champs) valeurs[cle] = chaine(analysis[cle]);
    return { valeurs, analyse: { constats: (analysis.issues || []).filter((m) => !/MRZ/.test(m)), avertissements: warnings } };
  }
  if (type === "rib") {
    const { analysis, warnings } = mapRibResult(result, { items: [{ id: "rib" }], validation });
    const valeurs = { titulaire: chaine(analysis.titulaireCompte), iban: chaine(analysis.iban), bic: chaine(analysis.bic), banque: chaine(analysis.nomBanque) };
    return { valeurs, analyse: { constats: (analysis.issues || []).filter((m) => m !== IBAN_ABSENT && !/^(IBAN|BIC) /.test(m)), avertissements: warnings } };
  }
  const { valeurs, avertissements } = mapperNouveau(type, result);
  const constats = [];
  if (validation && validation.valid === false) constats.push("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).");
  return { valeurs, analyse: { constats, avertissements } };
}

/** Garde seulement les champs connus du type, en chaînes. */
function nettoyerValeurs(type, brutes) {
  const sortie = {};
  for (const [cle] of TYPES[type].champs) sortie[cle] = chaine((brutes || {})[cle]).slice(0, 500);
  return sortie;
}

function descriptionPublique() {
  return Object.fromEntries(Object.entries(TYPES).map(([id, t]) => [id, {
    libelle: t.libelle, champs: t.champs.map(([cle, libelle, nature]) => ({ cle, libelle, nature: nature || "texte" })),
  }]));
}

module.exports = { TYPES, ATTENDUS_DEFAUT, estType, chargerSchema, versValeurs, nettoyerValeurs, descriptionPublique };
