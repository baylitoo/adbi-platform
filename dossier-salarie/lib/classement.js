"use strict";
// Classement d'une pièce : indices locaux d'abord, puis schéma DocIE « type_piece », sinon « autre » (choix manuel).

const path = require("path");
const { controlerIbanBic } = require(path.join(__dirname, "..", "..", "contrats", "lib", "iban-bic"));
const { estType } = require("./pieces");

const AUTRE = "autre";
const VALEURS_DOCIE = ["cni", "rib", "carte_vitale", "justificatif_domicile", "diplome", AUTRE];

function sansAccents(texte) {
  return String(texte || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const MRZ_RE = /^(?:I[A-Z<]FRA|ID[A-Z<]{3}|P<[A-Z<]{3})[A-Z0-9<]{20,}$/m;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?:[  ]?[A-Z0-9]{4}){2,7}(?:[  ]?[A-Z0-9]{1,4})?)\b/g;

function parTexte(texte) {
  if (!texte) return null;
  const compact = texte.split(/\r?\n/).map((l) => l.replace(/\s+/g, "")).join("\n");
  if (MRZ_RE.test(compact)) return "cni";
  const t = sansAccents(texte);
  if (/releve d'identite bancaire/.test(t)) return "rib";
  if (/carte vitale|assurance maladie.*\bn[o°]? ?(de )?securite sociale/s.test(t)) return "carte_vitale";
  // Avant l'IBAN : une facture porte souvent l'IBAN du prélèvement.
  if (/\bfacture\b|quittance de loyer|avis d'(imposition|echeance)|attestation d'hebergement|justificatif de domicile/.test(t)) return "justificatif_domicile";
  if (/\bdiplome\b|baccalaureat|\blicence\b.*\buniversite|\bmaster\b|titre (professionnel|d'ingenieur)/s.test(t)) return "diplome";
  for (const m of texte.matchAll(IBAN_RE)) {
    if (controlerIbanBic(m[1], null).iban.statut === "valide") return "rib";
  }
  return null;
}

const INDICES_NOM = [
  [/\b(cni|identite|passeport|passport)\b/, "cni"],
  [/\brib\b|\biban\b|\bbancaire\b/, "rib"],
  [/\bvitale\b|\bsecu\b|\bsecurite[ _-]?sociale\b|\bameli\b/, "carte_vitale"],
  [/\bdomicile\b|\bfacture\b|\bquittance\b|\bloyer\b|\bedf\b|\bjustif/, "justificatif_domicile"],
  [/\bdiplome\b|\bmaster\b|\blicence\b|\bbac\b|\bbts\b|\bdut\b/, "diplome"],
];

function parNomFichier(nom) {
  const t = sansAccents(path.basename(String(nom || ""))).replace(/[_.\-]+/g, " ");
  for (const [motif, type] of INDICES_NOM) if (motif.test(t)) return type;
  return null;
}

/** Valeur DocIE brute -> type connu, ou null (réponse hors liste = non classée). */
function valeurDocie(brute) {
  const v = sansAccents(brute).trim().replace(/[\s-]+/g, "_");
  return VALEURS_DOCIE.includes(v) && v !== AUTRE ? v : null;
}

// Point d'entrée unique et remplaçable du classement.
async function classer({ texte, nomFichier }, { docie = null } = {}) {
  const local = parTexte(texte);
  if (local) return { type: local, methode: "indices" };
  const parNom = parNomFichier(nomFichier);
  if (parNom) return { type: parNom, methode: "nom_fichier" };
  if (docie) {
    const brute = await docie(texte || null);
    const type = brute == null ? null : valeurDocie(brute);
    if (type && estType(type)) return { type, methode: "docie" };
    if (brute != null) return { type: null, methode: "docie" };
  }
  return { type: null, methode: "aucune" };
}

module.exports = { classer, parTexte, parNomFichier, valeurDocie, VALEURS_DOCIE, AUTRE };
