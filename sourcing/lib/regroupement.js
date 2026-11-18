"use strict";
// Même mission publiée par plusieurs entreprises : signal qu'un client consulte plusieurs fournisseurs. Calcul déterministe, sans modèle.

const { normaliser } = require("./referentiel");

const SEUIL = 0.6;
const FENETRE_JOURS = 30;
const VIDES = new Set(["h", "f", "hf", "fh", "x", "de", "des", "du", "la", "le", "les", "et", "en", "pour", "un", "une", "a", "au", "aux", "nous", "recrutons", "recherchons", "cdi", "cdd", "mission", "poste", "freelance"]);

const mots = (t) => new Set(normaliser(t).split(" ").filter((m) => m.length > 1 && !VIDES.has(m)));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

// Pour une offre LinkedIn pas encore extraite, la première ligne du texte est l'intitulé et l'auteur l'entreprise.
function signature(e) {
  const c = e.champs || {};
  const intitule = c.intitule || (e.origine === "linkedin_public" ? String(e.texte).split("\n")[0] : "");
  const entreprise = normaliser(c.entreprise || e.auteur || "");
  if (!intitule || !entreprise) return null;
  return {
    id: e.id, entreprise, nomEntreprise: c.entreprise || e.auteur, intitule,
    titre: mots(intitule), competences: new Set((c.competences || []).map(normaliser).filter(Boolean)),
    lieu: mots(c.localisation || ""), date: new Date(e.capture_le || e.cree_le).getTime(),
  };
}

function similarite(a, b) {
  const titre = jaccard(a.titre, b.titre);
  if (titre < 0.34) return 0;
  const avecCompetences = a.competences.size && b.competences.size;
  const lieu = a.lieu.size && b.lieu.size ? ([...a.lieu].some((m) => b.lieu.has(m)) ? 1 : 0) : 0.5;
  return avecCompetences ? 0.5 * titre + 0.35 * jaccard(a.competences, b.competences) + 0.15 * lieu : 0.85 * titre + 0.15 * lieu;
}

// { id -> [{id, entreprise, intitule}] } : pour chaque offre, les offres proches publiées par d'autres entreprises.
function regrouper(elements) {
  const sigs = elements.filter((e) => e.type !== "bruit").map(signature).filter(Boolean);
  const voisins = new Map();
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      const a = sigs[i];
      const b = sigs[j];
      if (a.entreprise === b.entreprise || Math.abs(a.date - b.date) > FENETRE_JOURS * 86400000) continue;
      if (similarite(a, b) < SEUIL) continue;
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!voisins.has(x.id)) voisins.set(x.id, []);
        voisins.get(x.id).push({ id: y.id, entreprise: y.nomEntreprise, intitule: y.intitule });
      }
    }
  }
  return voisins;
}

module.exports = { regrouper, similarite, signature, SEUIL };
