"use strict";
// Classement d'un élément derrière une seule interface : classer(texte) -> { type, probabilites, confiance, methode, a_verifier, raisons }.

const path = require("path");
const pont = require(path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js"));
const { profilDuCatalogue } = require("./modeles");
const SCHEMA_CLASSEMENT = require("./schemas/adbi_classement_post.schema.json");

const TYPES = Object.freeze(["offre_emploi", "post_opportunite", "bruit"]);
const LIBELLES_TYPES = Object.freeze({ offre_emploi: "Offre d'emploi", post_opportunite: "Opportunité", bruit: "Bruit" });
const MODES = Object.freeze(["generatif", "decision", "double"]);
const QUESTION = "type_element";
const INSTRUCTIONS = "Classe ce texte publié sur LinkedIn du point de vue d'une société de conseil qui place des consultants.";
const CRITERES_DECRITS = Object.freeze({
  offre_emploi: "Offre de poste publiée par un recruteur ou une entreprise (CDI, CDD, freelance).",
  post_opportunite: "Besoin, projet, appel d'offres ou mission d'une entreprise pour lequel une société de conseil peut placer un consultant.",
  bruit: "Tout le reste : actualité, opinion, promotion, événement, et un candidat qui cherche lui-même un poste.",
});

function normaliserType(brut) {
  const t = typeof brut === "string" ? brut.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return TYPES.includes(t) ? t : null;
}

// Lecture et contrôle de la configuration, appelée au démarrage : une valeur invalide arrête le service.
function configurationDepuisEnv(env = process.env) {
  const mode = String(env.SOURCING_CLASSEMENT || "").trim().toLowerCase() || "generatif";
  if (!MODES.includes(mode)) throw new Error(`SOURCING_CLASSEMENT doit valoir ${MODES.join(", ")} (reçu : ${JSON.stringify(mode)}).`);
  const deploiement = String(env.SOURCING_DECISION_DEPLOYMENT || "").trim();
  if (mode !== "generatif" && !deploiement) throw new Error("SOURCING_DECISION_DEPLOYMENT est requis quand SOURCING_CLASSEMENT vaut decision ou double.");
  const criteres = String(env.SOURCING_DECISION_CRITERES || "").trim().toLowerCase() || "decrits";
  if (!["decrits", "libelles"].includes(criteres)) throw new Error("SOURCING_DECISION_CRITERES doit valoir decrits ou libelles.");
  const nombre = (cle, defaut) => {
    const brut = String(env[cle] ?? "").trim();
    if (!brut) return defaut;
    const v = Number(brut);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${cle} doit être un nombre entre 0 et 1 (reçu : ${JSON.stringify(brut)}).`);
    return v;
  };
  return { mode, deploiement, criteres, seuil: nombre("SOURCING_DECISION_SEUIL", 0.5), ecart: nombre("SOURCING_DECISION_ECART", 0.15) };
}

// Implémentation A : voie texte DocIE, schéma à un champ ; aucune confiance auto-déclarée, `confiance` reste null.
async function classerGeneratif(texte, { env = process.env, fetchImpl } = {}) {
  const modelProfile = profilDuCatalogue("classement_post", env);
  const options = { kind: "classement_post", dynamicSchema: SCHEMA_CLASSEMENT, env, modelProfile };
  if (fetchImpl) options.fetchImpl = fetchImpl;
  const lu = await pont.extractText(texte, options);
  const brut = lu.result && typeof lu.result.type === "string" ? lu.result.type : null;
  const type = normaliserType(brut);
  return {
    type, probabilites: null, confiance: null, methode: "generatif",
    a_verifier: type === null, raisons: type === null ? ["type_inconnu"] : [],
    details: { valeur_brute: brut, modele: lu.metadata.model || null },
  };
}

function questions(config) {
  const criteres = Object.fromEntries(TYPES.map((t) => [t, config.criteres === "libelles" ? null : CRITERES_DECRITS[t]]));
  return { [QUESTION]: { type: "choice", instructions: INSTRUCTIONS, criteria: criteres } };
}

// Implémentation B : modèle de décision DocIE (POST /v1/systemone, PR #660) ; probabilités stockées brutes, non calibrées.
async function classerDecision(texte, config, { env = process.env, fetchImpl } = {}) {
  const options = { deployment: config.deploiement, env };
  if (fetchImpl) options.fetchImpl = fetchImpl;
  const r = await pont.decide(texte, questions(config), options);
  const a = r.answers[QUESTION];
  const tries = Object.values(a.probabilities).sort((x, y) => y - x);
  const raisons = [];
  if (a.confidence < config.seuil) raisons.push("confiance_faible");
  if (tries.length > 1 && tries[0] - tries[1] < config.ecart) raisons.push("probabilites_proches");
  return {
    type: a.choice, probabilites: a.probabilities, confiance: a.confidence, methode: "decision",
    a_verifier: raisons.length > 0, raisons,
    details: { modele: r.model, criteres: config.criteres },
  };
}

// 404 (déploiement inconnu) et 501 (pas un modèle de décision) : repli sur la voie générative, raison consignée.
function repliPossible(e) {
  return e && e.name === "DocIEBridgeError" && (e.status === 404 || e.status === 501);
}

function creerClasseur(config, deps = {}) {
  async function classer(texte) {
    if (config.mode === "generatif") return classerGeneratif(texte, deps);
    let decision;
    try {
      decision = await classerDecision(texte, config, deps);
    } catch (e) {
      if (!repliPossible(e)) throw e;
      const g = await classerGeneratif(texte, deps);
      return { ...g, repli: { depuis: "decision", statut_http: e.status } };
    }
    if (config.mode === "decision") return decision;
    const g = await classerGeneratif(texte, deps);
    const desaccord = g.type !== decision.type;
    const raisons = [...decision.raisons, ...g.raisons, ...(desaccord ? ["methodes_en_desaccord"] : [])];
    return {
      ...decision, a_verifier: raisons.length > 0, raisons,
      details: { ...decision.details, generatif: { type: g.type, valeur_brute: g.details.valeur_brute } },
    };
  }
  return { classer, config };
}

module.exports = { creerClasseur, configurationDepuisEnv, normaliserType, questions, TYPES, LIBELLES_TYPES, MODES, CRITERES_DECRITS };
