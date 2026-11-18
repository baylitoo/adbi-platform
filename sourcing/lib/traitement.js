"use strict";
// Chaîne d'un élément : classer, extraire si ce n'est pas du bruit, puis rapprocher ; chaque étape écrit son résultat sur la ligne.

const path = require("path");
const pont = require(path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js"));
const { extraireOpportunite } = require("./extraction");
const { ErreurRapprochement } = require("./rapprocheur");

const MESSAGE_INTERNE = "Traitement impossible : erreur interne.";

function erreurPublique(e) {
  if (e && e.name === "DocIEBridgeError") {
    const m = pont.messageErreur(e);
    if (m) return m;
  }
  return { code: "interne", message: MESSAGE_INTERNE };
}

function statutRevue(classement) {
  return classement.a_verifier ? "a_verifier" : "a_valider";
}

function creerTraitement({ db, classeur, rapprocheur, extraire = extraireOpportunite, journal = console.error }) {
  async function rapprocher(element, champs, jeton) {
    const precedent = element.rapprochement || {};
    const session = { jeton, texte: element.texte, besoin_id: precedent.adaptateur === rapprocheur.nom ? precedent.besoin_id || null : null };
    try {
      const resultats = await rapprocheur.rapprocher(champs, session);
      return { adaptateur: rapprocheur.nom, etat: "ok", besoin_id: session.besoin_id || null, resultats, le: new Date().toISOString() };
    } catch (e) {
      if (!(e instanceof ErreurRapprochement)) journal("[rapprochement]", e && e.message);
      const message = e instanceof ErreurRapprochement ? e.message : "Rapprochement impossible : erreur interne.";
      const etat = e instanceof ErreurRapprochement && ["session", "occupe", "delai"].includes(e.code) ? "a_relancer" : "erreur";
      return { adaptateur: rapprocheur.nom, etat, message, besoin_id: session.besoin_id || precedent.besoin_id || null, resultats: [], le: new Date().toISOString() };
    }
  }

  async function complet(proprietaire, id, jeton) {
    let element = await db.modifier(proprietaire, id, { statut: "en_cours", erreur: null });
    if (!element) return { element: id };
    try {
      const classement = await classeur.classer(element.texte);
      element = await db.modifier(proprietaire, id, { type: classement.type, classement });
      if (classement.type === "bruit") {
        await db.modifier(proprietaire, id, { statut: statutRevue(classement), tache: null, champs: null, extraction: null, preuves: {}, confiances: {} });
        return { element: id };
      }
      const lu = await extraire(element.texte);
      element = await db.modifier(proprietaire, id, { champs: lu.champs, extraction: lu.extraction, preuves: lu.preuves, confiances: lu.confiances });
      const rapprochement = await rapprocher(element, lu.champs, jeton);
      await db.modifier(proprietaire, id, { rapprochement, statut: statutRevue(classement), tache: null });
      return { element: id };
    } catch (e) {
      journal("[traitement]", e && e.code, e && e.message);
      await db.modifier(proprietaire, id, { statut: "echec", tache: null, erreur: erreurPublique(e) }).catch((err) => journal("[traitement]", err.message));
      throw e;
    }
  }

  // Rapprochement seul, sur les champs tels que l'utilisateur les a corrigés ; le statut de revue ne change pas.
  async function rapprochementSeul(proprietaire, id, jeton) {
    const element = await db.obtenir(proprietaire, id);
    if (!element) return { element: id };
    try {
      await db.modifier(proprietaire, id, { rapprochement: await rapprocher(element, element.champs || {}, jeton) });
    } finally {
      await db.modifier(proprietaire, id, { tache: null }).catch((err) => journal("[rapprochement]", err.message));
    }
    return { element: id };
  }

  return { complet, rapprochementSeul };
}

module.exports = { creerTraitement, erreurPublique, MESSAGE_INTERNE };
