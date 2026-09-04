/**
 * Priorisation : attribue un score aux missions et aux realisations.
 *
 * Ces scores pilotent la reduction one-page (lib/onepager). Ils sont exposes
 * dans l'interface pour que l'utilisateur comprenne POURQUOI un element a ete
 * ecarte, et puisse le remettre d'un clic.
 */

const N = require("./normalize");
const taxo = require("./taxonomy");

// Grands comptes et institutions : un nom connu vaut un argument commercial.
const PRESTIGE = /\b(ap-?hp|assistance publique|soci[ée]t[ée] g[ée]n[ée]rale|bnp|paribas|cr[ée]dit agricole|bpce|banque populaire|caisse d.?[ée]pargne|axa|allianz|mma|generali|aviva|abeille|macif|maif|matmut|harmonie|malakoff|ag2r|klesia|orange|sfr|bouygues|free|edf|engie|total|airbus|safran|thales|dassault|renault|stellantis|psa|michelin|carrefour|auchan|leclerc|decathlon|loreal|l.?or[ée]al|danone|lvmh|sanofi|servier|urssaf|cnam|cpam|pole emploi|france travail|minist[èe]re|ars|chu|inserm|insee|sncf|ratp|la poste|adp|saint-?gobain|vinci|bouygues|capgemini|accenture|sopra|atos|cgi|deloitte|kpmg|ey|pwc|ibm|microsoft|google|amazon|aws|oracle|sap|salesforce|opco)\b/i;

const VERBES_ACTION = /^(pilot|dirig|conduit|men|livr|d[ée]ploy|con[çc]|construit|cr[éе]|mis|mise|r[ée]alis|d[ée]velopp|industrialis|migr|refond|optimis|r[ée]duit|augment|am[ée]lior|automatis|structur|cadr|arbitr|coordonn|anim|form|accompagn|g[ée]r|superv|encadr|manag|n[ée]goci|s[ée]curis|fiabilis|garanti|instaur|d[ée]fini|sp[ée]cifi|architectur)/i;

const GENERIQUE = /^(participation|participer|aide|assistance ponctuelle|suivi des r[ée]unions|r[ée]daction de comptes rendus|veille|divers|autres t[âa]ches|support utilisateur simple)\b/i;

/** Decroissance de la pertinence avec l'anciennete : ~0,2 a 10 ans. */
function recency(exp, nowIso) {
  if (exp.is_current) return 1;
  const end = exp.end_date || exp.start_date;
  if (!end) return 0.3;
  const years = (monthIdx(nowIso) - monthIdx(end)) / 12;
  if (years <= 0) return 1;
  return Math.max(0.05, Math.exp(-years / 6));
}

function monthIdx(iso) {
  const [y, m] = String(iso).split("-").map(Number);
  return y * 12 + (m || 6);
}

/** Une mission de moins de 4 mois pese peu ; au-dela de 3 ans le gain sature. */
function durationScore(months) {
  if (!months) return 0.4;
  if (months < 4) return 0.25;
  return Math.min(1, 0.35 + Math.log10(months) * 0.55);
}

/**
 * Adequation au poste vise : recouvrement entre les technologies/mots-cles de
 * la mission et ceux de l'offre. Sans offre fournie, on retombe sur le titre
 * du candidat, ce qui favorise la coherence du parcours.
 */
function jobFit(exp, target) {
  if (!target || !target.terms.size) return 0.5;
  const hay = [exp.role, exp.mission, exp.context, exp.tech_stack.join(" "), exp.highlights.map((h) => h.text).join(" ")]
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const t of target.terms) if (hay.includes(t)) hits++;
  return Math.min(1, hits / Math.max(4, target.terms.size * 0.35));
}

function metricDensity(exp) {
  if (!exp.highlights.length) return exp.context && /\d/.test(exp.context) ? 0.4 : 0.15;
  return exp.highlights.filter((h) => h.has_metric).length / exp.highlights.length;
}

function prestige(exp) {
  const s = `${exp.company} ${exp.end_client} ${exp.context}`;
  return PRESTIGE.test(s) ? 1 : 0.35;
}

/** Prepare les mots-cles du poste cible (offre collee, ou titre du candidat). */
function buildTarget(text) {
  const terms = new Set();
  if (text) {
    for (const t of taxo.detect(text)) terms.add(t.name.toLowerCase());
    const mots = N.deaccent(text)
      .toLowerCase()
      .match(/\b[a-z]{5,}\b/g) || [];
    const STOP = new Set(["notre", "votre", "poste", "mission", "missions", "profil", "equipe", "client", "clients", "entreprise", "societe", "candidat", "experience", "annees", "recherche", "recherchons", "competences", "travail", "cadre", "seront", "serez", "aurez", "pourrez"]);
    for (const m of mots) if (!STOP.has(m)) terms.add(m);
  }
  return { terms, raw: text || "" };
}

const POIDS = { recency: 0.35, duration: 0.2, fit: 0.2, metrics: 0.15, prestige: 0.1 };

function scoreExperience(exp, target, nowIso) {
  const parts = {
    recency: recency(exp, nowIso),
    duration: durationScore(exp.duration_months),
    fit: jobFit(exp, target),
    metrics: metricDensity(exp),
    prestige: prestige(exp),
  };
  const total = Object.entries(POIDS).reduce((s, [k, w]) => s + parts[k] * w, 0);
  return { score: Math.round(total * 1000) / 1000, parts };
}

/**
 * Score d'une realisation. Un chiffre vaut plus que tout : c'est ce qui
 * distingue une phrase de CV d'une preuve.
 */
function scoreHighlight(text, target) {
  let s = 3;
  const t = String(text || "");
  if (/\d/.test(t)) s += 1;
  if (/\d+\s*(%|k€|m€|€|millions?|k\b|m\b)/i.test(t)) s += 3;
  if (VERBES_ACTION.test(N.deaccent(t))) s += 2;
  if (/\b(\d+)\s*(personnes?|collaborateurs?|[ée]quipes?|fournisseurs?|sites?|pays|h[ôo]pitaux|[ée]tablissements?)\b/i.test(t)) s += 1.5;
  if (target && target.terms.size) {
    const low = t.toLowerCase();
    let hits = 0;
    for (const term of target.terms) if (term.length > 3 && low.includes(term)) hits++;
    s += Math.min(3, hits * 0.7);
  }
  if (GENERIQUE.test(N.deaccent(t))) s -= 3;
  if (t.length < 25) s -= 1.5;
  if (t.length > 190) s -= 1;
  return Math.round(s * 100) / 100;
}

/** Deux realisations qui disent la meme chose : on ne garde que la mieux notee. */
function dedupeHighlights(highlights) {
  const kept = [];
  for (const h of [...highlights].sort((a, b) => b.score - a.score)) {
    const sig = signature(h.text);
    const twin = kept.find((k) => similarity(sig, k.sig) > 0.62);
    if (twin) continue;
    kept.push({ ...h, sig });
  }
  return kept.map(({ sig, ...h }) => h);
}

function signature(text) {
  const words = N.deaccent(String(text).toLowerCase()).match(/\b[a-z]{4,}\b/g) || [];
  return new Set(words);
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** Applique les scores a tout le CV (mutation volontaire : objet de travail). */
function scoreAll(cv, targetText) {
  const target = buildTarget(targetText || cv.identity.title);
  const now = N.isoNow();

  for (const exp of cv.experiences) {
    const { score, parts } = scoreExperience(exp, target, now);
    exp.relevance_score = score;
    exp.score_parts = parts;
    exp.highlights = dedupeHighlights(
      exp.highlights.map((h) => ({ ...h, score: scoreHighlight(h.text, target) }))
    ).sort((a, b) => b.score - a.score);
  }
  return cv;
}

module.exports = { scoreAll, scoreExperience, scoreHighlight, buildTarget, dedupeHighlights, PRESTIGE };
