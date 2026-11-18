"use strict";
// Extraction d'une opportunité : voie texte DocIE, une ligne par bloc pour que chaque preuve désigne une ligne du texte d'origine.

const path = require("path");
const pont = require(path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js"));
const { profilDuCatalogue } = require("./modeles");
const SCHEMA_OPPORTUNITE = require("./schemas/adbi_opportunite.schema.json");

const CHAMPS = Object.freeze(SCHEMA_OPPORTUNITE.fields.map((f) => f.name));
const TYPES_CONTRAT = Object.freeze(["cdi", "cdd", "freelance", "mission", "appel_offres", "inconnu"]);
const MOIS = Object.freeze({
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
});
const ID_LIGNE = /^l(\d+)$/;

function lignes(texte) {
  return String(texte).split(/\r\n|\n|\r/);
}

// Un bloc par ligne non blanche, au sens de DocIE (le pont refuse un bloc blanc) ; id = numéro de ligne.
function blocsParLigne(texte) {
  return lignes(texte).flatMap((ligne, i) => (pont.compterBlocsTexte(ligne) > 0 ? [{ id: "l" + i, text: ligne, page: 1, source: "manual" }] : []));
}

const sansAccents = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "");
const texte = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function dateValide(a, m, j) {
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

const iso = (a, m, j) => `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;

// Date ISO (AAAA-MM-JJ, ou AAAA-MM quand seul le mois est écrit) ; null si la valeur n'est pas une date lisible.
function normaliserDate(brut) {
  const t = sansAccents(texte(brut).toLowerCase()).replace(/\s+/g, " ");
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return dateValide(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const a = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return dateValide(a, +m[2], +m[1]) ? iso(a, +m[2], +m[1]) : null;
  }
  m = t.match(/(?:^|\s)(\d{1,2})(?:er)? ([a-z]+) (\d{4})$/);
  if (m && MOIS[m[2]] && dateValide(+m[3], MOIS[m[2]], +m[1])) return iso(+m[3], MOIS[m[2]], +m[1]);
  m = t.match(/(?:^|\s)([a-z]+) (\d{4})$/);
  if (m && MOIS[m[1]]) return `${m[2]}-${String(MOIS[m[1]]).padStart(2, "0")}`;
  m = t.match(/^(\d{4})-(\d{2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return t;
  return null;
}

function normaliserTypeContrat(brut) {
  const t = sansAccents(texte(brut).toLowerCase()).replace(/[\s'’-]+/g, "_").replace(/_d_/g, "_");
  if (TYPES_CONTRAT.includes(t)) return t;
  if (t === "appel_offre" || t === "ao") return "appel_offres";
  if (t === "free_lance" || t === "independant") return "freelance";
  return "inconnu";
}

function normaliserDevise(brut) {
  const t = texte(brut);
  if (!t) return "";
  if (/^(€|eur|euros?)$/i.test(t)) return "EUR";
  if (/^[a-z]{3}$/i.test(t)) return t.toUpperCase();
  return t.slice(0, 20);
}

function normaliserCompetences(brut) {
  if (!Array.isArray(brut)) return [];
  const vus = new Set();
  const sortie = [];
  for (const entree of brut) {
    const v = texte(entree && typeof entree === "object" ? entree.item : entree);
    if (v && !vus.has(v.toLowerCase())) { vus.add(v.toLowerCase()); sortie.push(v.slice(0, 100)); }
  }
  return sortie;
}

// Champs éditables, dans l'ordre du schéma ; les valeurs brutes restent dans `extraction`.
function normaliserChamps(r) {
  const res = r && typeof r === "object" ? r : {};
  return {
    entreprise: texte(res.entreprise).slice(0, 300),
    client_final: texte(res.client_final).slice(0, 300),
    intitule: texte(res.intitule).slice(0, 300),
    competences: normaliserCompetences(res.competences),
    localisation: texte(res.localisation).slice(0, 300),
    type_contrat: normaliserTypeContrat(res.type_contrat),
    seniorite: texte(res.seniorite).slice(0, 300),
    date_debut: normaliserDate(res.date_debut),
    contact_mentionne: texte(res.contact_mentionne).slice(0, 300),
    devise: normaliserDevise(res.devise),
  };
}

const champRacine = (chemin) => chemin.split(/[.[]/)[0];

// { champ: [numéros de ligne] } depuis metadata.evidence ; un identifiant qui n'est pas l'un de nos blocs est ignoré.
function preuvesParChamp(evidence) {
  const sortie = {};
  for (const [chemin, ids] of Object.entries(evidence || {})) {
    const champ = champRacine(chemin);
    if (!CHAMPS.includes(champ)) continue;
    for (const id of ids) {
      const m = ID_LIGNE.exec(id);
      if (!m) continue;
      sortie[champ] = sortie[champ] || [];
      if (!sortie[champ].includes(+m[1])) sortie[champ].push(+m[1]);
    }
  }
  for (const l of Object.values(sortie)) l.sort((a, b) => a - b);
  return sortie;
}

// Confiance d'ancrage DocIE (correspondance floue valeur/texte, 0-1) ; pour une liste, la plus faible de ses entrées.
function confiancesParChamp(confiances) {
  const sortie = {};
  for (const [chemin, v] of Object.entries(confiances || {})) {
    const champ = champRacine(chemin);
    if (!CHAMPS.includes(champ) || typeof v !== "number") continue;
    sortie[champ] = champ in sortie ? Math.min(sortie[champ], v) : v;
  }
  return sortie;
}

async function extraireOpportunite(texteSource, { env = process.env, fetchImpl } = {}) {
  const options = {
    kind: "opportunite", dynamicSchema: SCHEMA_OPPORTUNITE, ocrBlocks: blocsParLigne(texteSource),
    modelProfile: profilDuCatalogue("opportunite", env), env,
  };
  if (fetchImpl) options.fetchImpl = fetchImpl;
  const lu = await pont.extractText(texteSource, options);
  return {
    champs: normaliserChamps(lu.result),
    extraction: { brut: lu.result, modele: lu.metadata.model || null, partiel: lu.metadata.partiel || [], request_id: lu.metadata.request_id || null },
    preuves: preuvesParChamp(lu.metadata.evidence),
    confiances: confiancesParChamp(lu.metadata.field_confidence),
  };
}

module.exports = {
  extraireOpportunite, normaliserChamps, normaliserDate, normaliserTypeContrat, normaliserDevise, normaliserCompetences,
  blocsParLigne, preuvesParChamp, confiancesParChamp, lignes, CHAMPS, TYPES_CONTRAT,
};
