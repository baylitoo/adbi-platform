"use strict";
// Référentiel de profils : validation d'une fiche et score explicable d'un profil face à une offre, sans modèle.

const COURT = 200;
const NOTES_MAX = 2000;
const COMPETENCES_MAX = 60;
const POIDS = Object.freeze({ competences: 60, intitule: 25, seniorite: 10, localisation: 5 });
const VIDES = new Set(["h", "f", "hf", "fh", "x", "de", "des", "du", "la", "le", "les", "et", "en", "pour", "un", "une", "a", "au", "aux", "cdi", "cdd", "stage", "alternance", "freelance", "mission", "poste", "job"]);

class ErreurProfil extends Error {}

const normaliser = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();

const mots = (t) => new Set(normaliser(t).split(" ").map((m) => m.replace(/^\.+|\.+$/g, "")).filter((m) => m.length > 1 && !VIDES.has(m)));

const court = (v, max = COURT) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

// Fiche reçue de l'interface -> fiche propre ; le nom est le seul champ obligatoire.
function validerProfil(b) {
  const c = b || {};
  const nom = court(c.nom);
  if (!nom) throw new ErreurProfil("Le nom du profil est obligatoire.");
  const brutes = Array.isArray(c.competences) ? c.competences : typeof c.competences === "string" ? c.competences.split(/[\n,;]/) : [];
  const vues = new Set();
  const competences = [];
  for (const s of brutes) {
    const v = court(String(s), 100);
    if (v && !vues.has(normaliser(v))) { vues.add(normaliser(v)); competences.push(v); }
    if (competences.length >= COMPETENCES_MAX) break;
  }
  let tjm = null;
  if (c.tjm !== undefined && c.tjm !== null && c.tjm !== "") {
    tjm = Number(c.tjm);
    if (!Number.isInteger(tjm) || tjm < 0 || tjm > 100000) throw new ErreurProfil("TJM invalide : un nombre entier d'euros.");
  }
  return {
    nom, intitule: court(c.intitule), competences, seniorite: court(c.seniorite, 60), localisation: court(c.localisation),
    disponibilite: court(c.disponibilite, 60), tjm, notes: court(c.notes, NOTES_MAX), cvtheque_id: court(c.cvtheque_id, 100),
  };
}

// Une compétence est couverte si elle figure dans les compétences de l'offre ou, à défaut, comme mots entiers dans son texte.
function contient(texteNormalise, competence) {
  const n = normaliser(competence);
  return n.length > 0 && ` ${texteNormalise} `.includes(` ${n} `);
}

function scorer(element, profil) {
  const champs = element.champs || {};
  const raisons = [];
  const texte = normaliser([champs.intitule, (champs.competences || []).join(" "), element.texte].join(" "));
  const demandees = (champs.competences || []).map(normaliser).filter(Boolean);
  const proposees = (profil.competences || []).filter(Boolean);
  const communes = proposees.filter((s) => demandees.includes(normaliser(s)) || contient(texte, s));
  let partCompetences = 0;
  if (demandees.length) {
    const couvre = (d, s) => { const n = normaliser(s); return n === d || contient(d, s) || contient(n, d); };
    const couverture = demandees.filter((d) => proposees.some((s) => couvre(d, s))).length / demandees.length;
    partCompetences = 0.7 * couverture + 0.3 * (proposees.length ? communes.length / proposees.length : 0);
  } else if (proposees.length) {
    partCompetences = communes.length / proposees.length;
  }
  if (communes.length) raisons.push(`Compétences : ${communes.slice(0, 8).join(", ")}` + (demandees.length ? ` (${demandees.length} demandée(s))` : ""));
  const motsOffre = mots(champs.intitule || "");
  const motsProfil = mots(profil.intitule);
  const communsTitre = [...motsProfil].filter((m) => motsOffre.has(m));
  const partIntitule = motsOffre.size && motsProfil.size ? communsTitre.length / Math.min(motsOffre.size, motsProfil.size) : 0;
  if (communsTitre.length) raisons.push(`Intitulé proche : ${communsTitre.join(", ")}`);
  const memeSeniorite = Boolean(profil.seniorite && champs.seniorite && normaliser(profil.seniorite) === normaliser(champs.seniorite));
  if (memeSeniorite) raisons.push(`Séniorité : ${profil.seniorite}`);
  const lieuProfil = mots(profil.localisation);
  const lieuOffre = mots(champs.localisation || "");
  const memeLieu = [...lieuProfil].some((m) => lieuOffre.has(m));
  if (memeLieu) raisons.push(`Zone : ${profil.localisation}`);
  const score = POIDS.competences * Math.min(1, partCompetences) + POIDS.intitule * Math.min(1, partIntitule)
    + (memeSeniorite ? POIDS.seniorite : 0) + (memeLieu ? POIDS.localisation : 0);
  return { score: Math.round(score), raisons };
}

function classer(element, profils, limite = 5) {
  return profils.map((p) => ({ profil: p, ...scorer(element, p) }))
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limite);
}

// Pour une carte de recherche, seul l'intitulé est connu : part de ses mots couverte par l'intitulé et les compétences du profil.
function pertinenceTitre(titre, profils) {
  const motsTitre = mots(titre);
  if (!motsTitre.size) return null;
  let meilleur = null;
  for (const p of profils) {
    const couverture = new Set([...mots(p.intitule), ...(p.competences || []).flatMap((s) => [...mots(s)])]);
    const communs = [...motsTitre].filter((m) => couverture.has(m));
    const score = Math.round((100 * communs.length) / motsTitre.size);
    if (communs.length && (!meilleur || score > meilleur.score)) meilleur = { profil_id: p.id, nom: p.nom, score, mots: communs };
  }
  return meilleur;
}

module.exports = { validerProfil, scorer, classer, pertinenceTitre, normaliser, ErreurProfil };
