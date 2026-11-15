"use strict";
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./lib/db.pg");
const { creerClasseur, configurationDepuisEnv, TYPES, LIBELLES_TYPES } = require("./lib/classement");
const { rapprocheurDepuisEnv } = require("./lib/rapprocheur");
const { normaliserChamps, TYPES_CONTRAT } = require("./lib/extraction");
const { creerTraitement } = require("./lib/traitement");
// Bibliothèques partagées : ../auth et ../contrats/lib en checkout, /auth et /contrats/lib dans l'image.
const auth = require("../auth/auth-adbi");
const taches = require("../contrats/lib/taches-extraction");

const PORT = Number(process.env.PORT) || 4700;
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
const FACTORY_URL = process.env.ADBI_FACTORY_URL || "";
const ID_MODULE = "sourcing";
const TEXTE_MIN = 200;
const TEXTE_MAX = 3000;
const ORIGINES = Object.freeze(["collage", "navigateur", "email", "api"]);
const STATUTS = Object.freeze(["en_attente", "en_cours", "a_verifier", "a_valider", "valide", "ecarte", "echec"]);
const OCCUPES = Object.freeze(["en_attente", "en_cours"]);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante — voir .env.example.");
  process.exit(1);
}
let MAX_SIMULTANEES, CONFIG_CLASSEMENT, rapprocheur;
try {
  MAX_SIMULTANEES = taches.maxSimultaneesDepuisEnv();
  CONFIG_CLASSEMENT = configurationDepuisEnv();
  rapprocheur = rapprocheurDepuisEnv();
} catch (e) {
  console.error(e.message + " Voir .env.example.");
  process.exit(1);
}
console.log(`[taches] ${MAX_SIMULTANEES} traitement(s) simultané(s) (ADBI_EXTRACTION_MAX_CONCURRENT)`);
console.log(`[sourcing] classement : ${CONFIG_CLASSEMENT.mode} ; rapprochement : ${rapprocheur.nom}`);
const gestionnaire = taches.creerGestionnaire({ maxSimultanees: MAX_SIMULTANEES });
const classeur = creerClasseur(CONFIG_CLASSEMENT);
const traitement = creerTraitement({ db, classeur, rapprocheur });

process.on("uncaughtException", (e) => console.error("[erreur non gérée]", e && e.message ? e.message : e));
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e && e.message ? e.message : e));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

function cheminPublic(chemin) {
  return chemin === "/api/sante" || chemin === "/adbi-theme.css" || chemin === "/adbi-theme.js" || chemin.startsWith("/fonts/");
}

function gardeAcces(req, res, next) {
  if (cheminPublic(req.path)) return next();
  const decision = auth.garde(req, process.env);
  if (decision.autorise) {
    req.utilisateur = decision.utilisateur;
    return next();
  }
  if (decision.api) return res.status(401).json({ error: "Non authentifié" });
  if (!FACTORY_URL) {
    return res.status(401).type("text/html; charset=utf-8").send(auth.pageMessage("Session expirée", "Rouvrez la plateforme ADBI pour vous reconnecter."));
  }
  return res.status(401).type("text/html; charset=utf-8").send(auth.pageReconnexion(FACTORY_URL, ID_MODULE));
}

app.use(gardeAcces);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/sante", async (req, res) => {
  try {
    await db.verifierConnexion();
    res.json({ etat: "pret", base: "ok" });
  } catch (e) {
    console.error("[sante] base injoignable :", e.message);
    res.status(503).json({ etat: "indisponible", base: "ko" });
  }
});

// Isolation stricte : tout se lit et s'écrit sous le `sub` du jeton vérifié, superutilisateur compris.
const proprietaire = (req) => req.utilisateur.sub;

function vueElement(e) {
  if (!e) return null;
  const vue = { ...e };
  if (e.tache) {
    const t = gestionnaire.obtenir(e.tache);
    vue.suivi = t ? { etat: t.etat, etape: t.etape || null, position: t.position || null } : null;
  }
  delete vue.tache;
  return vue;
}

function lireId(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== req.params.id) { res.status(400).json({ error: "Identifiant invalide." }); return null; }
  return id;
}

async function elementAutorise(req, res) {
  const id = lireId(req, res);
  if (id === null) return null;
  const e = await db.obtenir(proprietaire(req), id);
  if (!e) { res.status(404).json({ error: "Élément introuvable." }); return null; }
  return e;
}

const occupe = (e) => OCCUPES.includes(e.statut) || Boolean(e.tache);

// Le jeton vit dans la seule fermeture de la tâche, jamais en base ni au journal ; le travail attend que la ligne porte sa tâche.
async function mettreEnFile(req, element, travail, valeurs) {
  const sub = proprietaire(req);
  const jeton = auth.jetonDeRequete(req);
  let liberer;
  const pret = new Promise((r) => { liberer = r; });
  let tache;
  try {
    tache = gestionnaire.creer(async () => { await pret; return travail(sub, element.id, jeton); });
  } catch (e) {
    if (!(e instanceof taches.FileTachesPleineError)) throw e;
    return null;
  }
  try {
    return await db.modifier(sub, element.id, { ...valeurs, tache });
  } finally {
    liberer();
  }
}

function texteEnEntree(brut) {
  if (typeof brut !== "string") return { erreur: "Le texte est obligatoire." };
  const texte = brut.replace(/\u0000/g, "").trim();
  const n = [...texte].length;
  if (n < TEXTE_MIN || n > TEXTE_MAX) return { erreur: `Le texte doit faire entre ${TEXTE_MIN} et ${TEXTE_MAX} caractères (reçu : ${n}).` };
  return { texte };
}

function urlEnEntree(brut) {
  if (brut === undefined || brut === null || brut === "") return { url: "" };
  if (typeof brut !== "string" || brut.length > 2048) return { erreur: "Lien source invalide." };
  let u;
  try { u = new URL(brut.trim()); } catch { return { erreur: "Lien source invalide." }; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return { erreur: "Le lien source doit être une adresse http(s) sans identifiants." };
  return { url: u.href };
}

function dateEnEntree(brut) {
  if (brut === undefined || brut === null || brut === "") return { date: null };
  const d = typeof brut === "string" ? new Date(brut) : null;
  if (!d || Number.isNaN(d.getTime())) return { erreur: "Date de capture invalide (ISO 8601 attendu)." };
  return { date: d.toISOString() };
}

const empreinte = (texte) => crypto.createHash("sha256").update(texte.replace(/\s+/g, " ").toLowerCase()).digest("hex");

app.get("/api/moi", (req, res) => {
  const u = req.utilisateur;
  res.json({ utilisateur: { email: u.email || "", full_name: u.full_name || "" } });
});

app.get("/api/config", (req, res) => {
  res.json({
    types: TYPES, libelles_types: LIBELLES_TYPES, statuts: STATUTS, origines: ORIGINES, types_contrat: TYPES_CONTRAT,
    texte: { min: TEXTE_MIN, max: TEXTE_MAX }, classement: CONFIG_CLASSEMENT.mode, rapprocheur: rapprocheur.nom,
  });
});

app.post("/api/elements", async (req, res) => {
  try {
    const b = req.body || {};
    const t = texteEnEntree(b.texte);
    if (t.erreur) return res.status(400).json({ error: t.erreur });
    const u = urlEnEntree(b.url_source);
    if (u.erreur) return res.status(400).json({ error: u.erreur });
    const origine = b.origine === undefined || b.origine === null || b.origine === "" ? "api" : b.origine;
    if (!ORIGINES.includes(origine)) return res.status(400).json({ error: `Origine inconnue (attendu : ${ORIGINES.join(", ")}).` });
    const d = dateEnEntree(b.capture_le);
    if (d.erreur) return res.status(400).json({ error: d.erreur });
    if (b.auteur !== undefined && b.auteur !== null && typeof b.auteur !== "string") return res.status(400).json({ error: "Auteur invalide." });
    const { element, doublon } = await db.creer({
      proprietaire: proprietaire(req), texte: t.texte, empreinte: empreinte(t.texte), url_source: u.url,
      origine, capture_le: d.date, auteur: String(b.auteur || "").trim().slice(0, 200),
    });
    if (doublon) return res.status(200).json({ element: vueElement(element), doublon: true });
    const maj = await mettreEnFile(req, element, traitement.complet, {})
      || await db.modifier(proprietaire(req), element.id, { statut: "echec", erreur: { code: "file_pleine", message: "Trop de traitements en attente : relancez le classement dans un instant." } });
    res.status(202).json({ element: vueElement(maj), doublon: false });
  } catch (e) {
    auth.repondreErreur(res, e);
  }
});

app.get("/api/elements", async (req, res) => {
  try {
    const q = req.query;
    const filtre = (v, liste) => (typeof v === "string" && liste.includes(v) ? v : null);
    const elements = await db.lister(proprietaire(req), {
      type: filtre(q.type, TYPES), statut: filtre(q.statut, STATUTS), origine: filtre(q.origine, ORIGINES),
    });
    res.json({ elements: elements.map(vueElement) });
  } catch (e) {
    auth.repondreErreur(res, e);
  }
});

app.get("/api/elements/:id", async (req, res) => {
  try {
    const e = await elementAutorise(req, res);
    if (e) res.json({ element: vueElement(e) });
  } catch (e) {
    auth.repondreErreur(res, e);
  }
});

app.patch("/api/elements/:id", async (req, res) => {
  try {
    const e = await elementAutorise(req, res);
    if (!e) return;
    if (occupe(e)) return res.status(409).json({ error: "Traitement en cours : attendez sa fin pour modifier l'élément." });
    const b = req.body || {};
    const valeurs = {};
    if (b.champs !== undefined) {
      if (!b.champs || typeof b.champs !== "object" || Array.isArray(b.champs)) return res.status(400).json({ error: "Champs invalides." });
      valeurs.champs = normaliserChamps(b.champs);
    }
    if (b.type !== undefined) {
      if (!TYPES.includes(b.type)) return res.status(400).json({ error: "Type inconnu." });
      valeurs.type = b.type;
    }
    if (!Object.keys(valeurs).length) return res.status(400).json({ error: "Rien à modifier." });
    const maj = await db.modifier(proprietaire(req), e.id, valeurs, { saufStatuts: OCCUPES });
    if (!maj) return res.status(409).json({ error: "Traitement en cours : attendez sa fin pour modifier l'élément." });
    res.json({ element: vueElement(maj) });
  } catch (e) {
    auth.repondreErreur(res, e);
  }
});

async function relancer(req, res, travail, valeurs) {
  try {
    const e = await elementAutorise(req, res);
    if (!e) return;
    if (occupe(e)) return res.status(409).json({ error: "Un traitement est déjà en cours pour cet élément." });
    const maj = await mettreEnFile(req, e, travail, valeurs);
    if (!maj) return res.status(503).json({ error: "Trop de traitements en attente : réessayez dans un instant." });
    res.status(202).json({ element: vueElement(maj) });
  } catch (e) {
    auth.repondreErreur(res, e);
  }
}

app.post("/api/elements/:id/reclasser", (req, res) => relancer(req, res, traitement.complet, { statut: "en_attente", erreur: null }));

app.post("/api/elements/:id/rapprocher", async (req, res) => {
  const e = await elementAutorise(req, res).catch((err) => { auth.repondreErreur(res, err); return null; });
  if (!e) return;
  if (!e.champs || e.type === "bruit") return res.status(409).json({ error: "Aucune opportunité extraite à rapprocher." });
  return relancer(req, res, traitement.rapprochementSeul, {});
});

async function revue(req, res, valeurs) {
  try {
    const e = await elementAutorise(req, res);
    if (!e) return;
    if (occupe(e)) return res.status(409).json({ error: "Traitement en cours : attendez sa fin." });
    const maj = await db.modifier(proprietaire(req), e.id, typeof valeurs === "function" ? valeurs(e) : valeurs, { saufStatuts: OCCUPES });
    if (!maj) return res.status(409).json({ error: "Traitement en cours : attendez sa fin." });
    res.json({ element: vueElement(maj) });
  } catch (err) {
    auth.repondreErreur(res, err);
  }
}

app.post("/api/elements/:id/bruit", (req, res) => revue(req, res, (e) => ({
  type: "bruit", statut: "ecarte",
  classement: { ...(e.classement || {}), correction: { type: "bruit", precedent: e.type, le: new Date().toISOString() } },
})));

app.post("/api/elements/:id/valider", async (req, res) => {
  const e = await elementAutorise(req, res).catch((err) => { auth.repondreErreur(res, err); return null; });
  if (!e) return;
  if (!e.type) return res.status(409).json({ error: "Type inconnu : choisissez un type avant de valider." });
  return revue(req, res, { statut: "valide" });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Route inconnue." }));

db.init()
  .then(() => {
    app.listen(PORT, HOTE, () => {
      const alerte = auth.avertissementAcces(process.env);
      if (alerte) console.warn(alerte);
      console.log(`ADBI Sourcing prêt sur http://${HOTE}:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Initialisation de la base impossible :", e.message);
    process.exit(1);
  });
