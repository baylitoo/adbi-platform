"use strict";
// Choix du modèle par action (#194), côté contrats : pré-remplissage de
// contrat, attestation URSSAF et RIB, tous trois sur la voie TEXTE.
//
// Le catalogue partagé (document-parsing/models/catalogue.js) dit quels modèles
// proposer ; ce module applique la règle du service :
//
//   - Aucun `modele` dans la requête : chemin d'avant, inchangé (contrat par
//     DOCIE_AGENT_CONTRACT ; URSSAF par DOCIE_MODEL_PROFILE, repli local
//     compris). C'est ce qu'envoie le navigateur quand rien n'est configuré.
//   - Un `modele` dans la requête = choix explicite. Le navigateur l'envoie dès
//     qu'au moins un modèle est proposé, même quand le sélecteur est masqué
//     (un seul modèle) : l'opérateur a configuré le catalogue, la ligne d'état
//     annonce « lu par <modèle> », et une lecture de repli contredirait cette
//     annonce. Conséquences : jamais de substitution par un autre modèle
//     (catalogue.choisirModele), jamais de repli sur l'analyse locale, et un
//     document sans couche texte est refusé en `scan`.
//
// Aucun identifiant réel (`store:<nom>`, nom d'agent) ne part au navigateur :
// offresPubliques ne garde que ce qu'un utilisateur lit.

const path = require("path");

// Même raisonnement de chemin que le bridge (lib/docie-extraction.js) : copié à
// la même profondeur relative dans l'image Docker (Dockerfile, étape 6).
const CHEMIN_CATALOGUE = path.join(__dirname, "..", "..", "document-parsing", "models", "catalogue.js");

// require() paresseux : un service sans DocIE ne dépend jamais du fichier.
function chargerCatalogue() {
  return require(CHEMIN_CATALOGUE);
}

// Tâches de ce service qui ont un sélecteur, et leur voie DocIE (#194 : le
// contrat en voie texte uniquement, l'URSSAF et le RIB aussi).
const TACHES = Object.freeze({ contract: "texte", urssaf: "texte", rib: "texte" });

// Messages constants : rien du texte amont ni de la valeur reçue n'en sort.
// Repris par lib/taches-extraction.js::MESSAGES_SERVICE pour les tâches.
const MESSAGES_CHOIX = Object.freeze({
  modele_non_propose: "Modèle non proposé pour cette action : rechargez la page et choisissez un modèle de la liste.",
  limite: "Document trop long pour le modèle choisi (plafond de lignes non vides dépassé) : choisissez-en un autre.",
  scan: "Document sans couche texte (scan ou image) : le modèle choisi ne peut pas le lire, saisie manuelle requise.",
  configuration: "Modèles d'extraction mal configurés côté serveur.",
});

class ErreurChoixModele extends Error {
  constructor(code) {
    super(MESSAGES_CHOIX[code]);
    this.name = "ErreurChoixModele";
    this.code = code;
  }
}

function voieDe(tache) {
  if (!Object.hasOwn(TACHES, String(tache))) throw new ErreurChoixModele("modele_non_propose");
  return TACHES[tache];
}

function traduire(e) {
  if (e && e.name === "CatalogueError") {
    return new ErreurChoixModele(e.code === "limite" || e.code === "configuration" ? e.code : "modele_non_propose");
  }
  return e;
}

/** Le `modele` demandé : null si absent (chemin d'avant), sinon la chaîne ; toute autre forme est refusée. */
function demandeModele(corps) {
  const valeur = corps ? corps.modele : undefined;
  if (valeur === undefined || valeur === null) return null;
  if (typeof valeur !== "string" || !valeur.trim()) throw new ErreurChoixModele("modele_non_propose");
  return valeur;
}

/** Offres lisibles par le navigateur, défaut d'abord. */
function offresPubliques(tache, { env = process.env } = {}) {
  try {
    return chargerCatalogue().modelesOfferts(tache, voieDe(tache), { env }).map((o) => ({
      id: o.id,
      libelle: o.libelle,
      description: o.description,
      role: o.role,
      lignesMax: typeof o.limites.lignes_non_vides_max === "number" ? o.limites.lignes_non_vides_max : null,
    }));
  } catch (e) {
    throw traduire(e);
  }
}

/** Vérification avant le document (route synchrone) : le modèle est-il configuré ? */
function verifierDemande(tache, modele, { env = process.env } = {}) {
  try {
    return chargerCatalogue().choisirModele(tache, voieDe(tache), { env, modele });
  } catch (e) {
    throw traduire(e);
  }
}

/** Le modèle demandé, vérifié sur le texte réellement envoyé (règle des 800 lignes non vides). */
function choisirPourTexte(tache, modele, texte, { env = process.env } = {}) {
  try {
    const catalogue = chargerCatalogue();
    return catalogue.choisirModele(tache, voieDe(tache), {
      env, modele, document: { lignesNonVides: catalogue.compterLignesNonVides(texte) },
    });
  } catch (e) {
    throw traduire(e);
  }
}

/**
 * Le modèle qui a RÉELLEMENT servi, d'après les métadonnées du bridge
 * (`metadata.model` sur la voie texte) : { id, libelle } ou null. Sans
 * correspondance dans le catalogue, `id` null et le nom rapporté par DocIE.
 */
function modeleServiPublic(tache, metadata, { env = process.env } = {}) {
  const servi = chargerCatalogue().modeleServi(tache, voieDe(tache), { env, metadata });
  return servi ? { id: servi.id, libelle: servi.libelle } : null;
}

/**
 * RIB (#194) : l'alternative du catalogue (LFM2.5 350M) n'est admise que
 * « derrière le contrôle IBAN modulo 97 et le format BIC » (prérequis de la
 * tâche `rib`). Vrai si le modèle DEMANDÉ ou le modèle SERVI est cette
 * alternative : le servi seul ne suffit pas (DocIE peut rapporter un nom que le
 * catalogue ne reconnaît pas, id null), le demandé seul non plus (DocIE peut en
 * servir un autre). Clé sur le rôle du catalogue, jamais sur un nom en dur.
 */
function exigeControleIbanBic(tache, choisi, servi, { env = process.env } = {}) {
  if (tache !== "rib") return false;
  const alternatives = offresPubliques(tache, { env }).filter((o) => o.role === "alternative").map((o) => o.id);
  return [choisi && choisi.id, servi && servi.id].some((id) => typeof id === "string" && alternatives.includes(id));
}

module.exports = {
  TACHES,
  MESSAGES_CHOIX,
  ErreurChoixModele,
  demandeModele,
  offresPubliques,
  verifierDemande,
  choisirPourTexte,
  modeleServiPublic,
  exigeControleIbanBic,
  CHEMIN_CATALOGUE,
};
