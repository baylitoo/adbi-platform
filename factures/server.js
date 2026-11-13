"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// contrats/lib (hors de /app) doit trouver pdf-parse dans nos node_modules : NODE_PATH, relu par _initPaths.
process.env.NODE_PATH = [path.join(__dirname, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require("module").Module._initPaths();

const db =require("./lib/db.pg");
const { extraireFacture, normaliserResultat, sniffMime } = require("./lib/extraction");
const controles = require("./lib/controles");
const { verifierSociete } = require("./lib/societe");
const { journalCsv, compteCharge, COMPTE_CHARGE_DEFAUT } = require("./lib/journal");
const { creerGestionnaire, maxSimultaneesDepuisEnv, mapperErreur, FileTachesPleineError } = require("../contrats/lib/taches-extraction");
const auth = require("../auth/auth-adbi");

const PORT = Number(process.env.PORT) || 4500;
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
const FACTORY_URL = process.env.ADBI_FACTORY_URL || "";
const DOSSIER_FICHIERS = path.join(__dirname, "data", "fichiers");
const TAILLE_MAX = 19 * 1024 * 1024;
const MIMES = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg" };
const TRANSITIONS = { a_valider: ["validee"], validee: ["payee"], payee: [] };

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante — PostgreSQL est requis (voir .env.example).");
  process.exit(1);
}
let MAX_SIMULTANEES;
try {
  MAX_SIMULTANEES = maxSimultaneesDepuisEnv();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const gestionnaire = creerGestionnaire({ maxSimultanees: MAX_SIMULTANEES });

process.on("uncaughtException", (e) => console.error("[erreur non gérée]", e && e.message ? e.message : e));
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e && e.message ? e.message : e));

const app = express();
app.use(express.json({ limit: "30mb" }));

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
  if (decision.api) return res.status(401).json({ erreur: "Non authentifié" });
  if (!FACTORY_URL) {
    return res.status(401).type("text/html; charset=utf-8").send(auth.pageMessage("Session expirée", "Rouvrez la plateforme ADBI pour vous reconnecter."));
  }
  return res.status(401).type("text/html; charset=utf-8").send(auth.pageReconnexion(FACTORY_URL, "factures"));
}

app.use(gardeAcces);
app.use(express.static(path.join(__dirname, "public")));

const asynchrone = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch((e) => auth.repondreErreur(res, e));

function erreur(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function idDe(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw erreur("Identifiant invalide.");
  return id;
}

async function factureOu404(id) {
  const f = await db.obtenirFacture(id);
  if (!f) throw erreur("Facture introuvable.", 404);
  return f;
}

async function evaluer(facture) {
  const c = controles.colonnes(facture.donnees || {});
  const [doublons, reference, confirmations] = await Promise.all([
    db.doublons(facture.id, c.siren, c.numero),
    db.derniereValidee(c.siren, facture.id),
    db.confirmationsIban(facture.id),
  ]);
  return controles.evaluer(facture, { doublons, reference, confirmations });
}

function vuePublique(f) {
  const { fichierChemin, ...reste } = f;
  return reste;
}

async function rafraichirSociete(id) {
  const f = await db.obtenirFacture(id);
  if (!f) return;
  const verif = await verifierSociete(f.donnees.siren, f.donnees.fournisseur);
  await db.enregistrerVerifSociete(id, verif);
}

function lancerExtraction(id, chemin, mime, utilisateur) {
  return gestionnaire.creer(async () => {
    try {
      const buffer = await fs.promises.readFile(chemin);
      const { donnees, extraction } = await extraireFacture(buffer, mime);
      await db.enregistrerExtraction(id, { etat: "terminee", extraction, donnees, colonnes: controles.colonnes(donnees) }, utilisateur);
      await rafraichirSociete(id).catch((e) => console.error("[societe]", e && e.message));
      return { id };
    } catch (e) {
      const { code, message } = mapperErreur(e);
      await db.enregistrerExtraction(id, { etat: "echec", erreur: message, extraction: { code } }, utilisateur)
        .catch((e2) => console.error("[extraction] échec non enregistré :", e2 && e2.message));
      throw e;
    }
  });
}

function aujourdhuiParis() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

function plusJours(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- Santé ----------
app.get("/api/sante", async (req, res) => {
  try {
    await db.verifierConnexion();
    res.json({ etat: "pret", base: "ok" });
  } catch (e) {
    console.error("[sante] base injoignable :", e.message);
    res.status(503).json({ etat: "indisponible", base: "ko" });
  }
});

app.get("/api/moi", (req, res) => {
  const u = req.utilisateur || {};
  res.json({ sub: u.sub, email: u.email || "", nom: u.full_name || "", compteCharge: process.env.FACTURES_COMPTE_CHARGE || COMPTE_CHARGE_DEFAUT });
});

// ---------- Dépôt et extraction ----------
app.post("/api/factures", asynchrone(async (req, res) => {
  const { nom, mimeType, dataBase64 } = req.body || {};
  if (!dataBase64 || typeof dataBase64 !== "string") throw erreur("Aucun fichier reçu.");
  const buffer = Buffer.from(dataBase64, "base64");
  if (!buffer.length || buffer.length > TAILLE_MAX) throw erreur("Fichier vide ou trop volumineux (19 Mo au plus).");
  const mime = sniffMime(mimeType, buffer);
  if (!Object.hasOwn(MIMES, mime)) throw erreur("Format non pris en charge : PDF, PNG ou JPEG attendu.");
  const empreinte = crypto.createHash("sha256").update(buffer).digest("hex");
  await fs.promises.mkdir(DOSSIER_FICHIERS, { recursive: true });
  const chemin = path.join(DOSSIER_FICHIERS, empreinte + MIMES[mime]);
  if (!fs.existsSync(chemin)) await fs.promises.writeFile(chemin, buffer);
  const nomFichier = String(nom || "facture" + MIMES[mime]).slice(0, 200);
  const id = await db.creerFacture({ nom: nomFichier, chemin, mime, taille: buffer.length, empreinte }, req.utilisateur);
  const memeFichier = await db.memeFichier(empreinte, id);
  let tache = null;
  try {
    tache = lancerExtraction(id, chemin, mime, req.utilisateur);
  } catch (e) {
    const message = e instanceof FileTachesPleineError ? e.message : "Extraction non lancée.";
    await db.enregistrerExtraction(id, { etat: "echec", erreur: message }, req.utilisateur);
  }
  res.status(202).json({ id, tache, memeFichier });
}));

app.post("/api/factures/:id/extraire", asynchrone(async (req, res) => {
  const id = idDe(req);
  const f = await factureOu404(id);
  if (!(await db.relancerExtraction(id, req.utilisateur))) throw erreur("Extraction déjà en cours, ou facture déjà validée.", 409);
  let tache;
  try {
    tache = lancerExtraction(id, f.fichierChemin, f.fichier.mime, req.utilisateur);
  } catch (e) {
    await db.enregistrerExtraction(id, { etat: "echec", erreur: e.message }, req.utilisateur);
    throw e instanceof FileTachesPleineError ? erreur(e.message, 503) : e;
  }
  res.status(202).json({ id, tache });
}));

app.get("/api/taches/:id", (req, res) => {
  const vue = gestionnaire.obtenir(req.params.id);
  if (!vue) return res.status(404).json({ error: "Tâche inconnue ou expirée." });
  res.json(vue);
});

// ---------- Consultation ----------
app.get("/api/factures", asynchrone(async (req, res) => {
  const factures = await db.listerFactures();
  const sortie = await Promise.all(factures.map(async (f) => {
    const vue = vuePublique(f);
    if (f.statut === "a_valider" && f.extraction.etat === "terminee") {
      const { liste, bloquants } = await evaluer(f);
      vue.resume = {
        fraude: liste.some((c) => c.code === "fraude_iban" && c.niveau === controles.BLOQUANT),
        bloquants: bloquants.length,
        erreurs: liste.filter((c) => c.niveau === controles.ERREUR).length,
      };
    }
    return vue;
  }));
  res.json({ factures: sortie });
}));

app.get("/api/factures/:id", asynchrone(async (req, res) => {
  const f = await factureOu404(idDe(req));
  const [ctrl, historique] = await Promise.all([evaluer(f), db.evenements(f.id)]);
  res.json({ facture: vuePublique(f), controles: ctrl.liste, bloquants: ctrl.bloquants.map((c) => c.code), historique });
}));

app.get("/api/factures/:id/fichier", asynchrone(async (req, res) => {
  const f = await factureOu404(idDe(req));
  const chemin = path.resolve(f.fichierChemin);
  if (!chemin.startsWith(path.resolve(DOSSIER_FICHIERS) + path.sep) || !fs.existsSync(chemin)) throw erreur("Fichier introuvable.", 404);
  res.type(f.fichier.mime);
  res.setHeader("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(f.fichier.nom));
  res.sendFile(chemin);
}));

// ---------- Relecture ----------
app.put("/api/factures/:id", asynchrone(async (req, res) => {
  const id = idDe(req);
  const avant = await factureOu404(id);
  if (avant.statut !== "a_valider") throw erreur("Seule une facture à valider peut être modifiée.", 409);
  const { donnees } = normaliserResultat((req.body || {}).donnees);
  const champs = Object.keys(donnees).filter((k) => JSON.stringify(donnees[k]) !== JSON.stringify(avant.donnees[k]));
  if (!champs.length) return res.json({ ok: true, champs });
  if (!(await db.modifierDonnees(id, donnees, controles.colonnes(donnees), req.utilisateur, champs))) {
    throw erreur("Facture déjà validée entre-temps : rechargez-la.", 409);
  }
  if (champs.includes("siren") || champs.includes("fournisseur")) await rafraichirSociete(id);
  res.json({ ok: true, champs });
}));

app.post("/api/factures/:id/verifier-societe", asynchrone(async (req, res) => {
  const id = idDe(req);
  await factureOu404(id);
  await rafraichirSociete(id);
  res.json({ ok: true });
}));

// Confirmation explicite d'un changement d'IBAN : journalisée avec l'utilisateur et la date.
app.post("/api/factures/:id/confirmer-iban", asynchrone(async (req, res) => {
  const id = idDe(req);
  if (!req.body || req.body.confirme !== true) throw erreur("Confirmation explicite requise.");
  const f = await factureOu404(id);
  if (f.statut !== "a_valider") throw erreur("Facture déjà validée.", 409);
  const alerte = (await evaluer(f)).liste.find((c) => c.code === "fraude_iban");
  if (!alerte || !alerte.confirmable) throw erreur("Aucun changement d'IBAN à confirmer.", 409);
  await db.ajouterEvenement(id, "confirmation_iban", req.utilisateur, {
    vers: "confirme",
    details: { iban: alerte.details.iban, ibanReference: alerte.details.ibanReference, factureReference: alerte.details.factureReference },
  });
  res.json({ ok: true });
}));

app.post("/api/factures/:id/statut", asynchrone(async (req, res) => {
  const id = idDe(req);
  const vers = String((req.body || {}).statut || "");
  const f = await factureOu404(id);
  if (!(TRANSITIONS[f.statut] || []).includes(vers)) throw erreur("Changement de statut non permis : " + f.statut + " → " + (vers || "?") + ".");
  const details = {};
  if (vers === "validee") {
    if (f.extraction.etat === "en_cours") throw erreur("Extraction en cours : attendez la fin avant de valider.", 409);
    const { bloquants } = await evaluer(f);
    if (bloquants.length) {
      return res.status(409).json({ error: "Validation bloquée : " + bloquants.map((c) => c.titre).join(", ") + ".", bloquants: bloquants.map((c) => c.code) });
    }
    details.iban = controles.ibanCompact(f.donnees.iban);
  }
  if (!(await db.changerStatut(id, f.statut, vers, req.utilisateur, details))) throw erreur("Statut modifié entre-temps : rechargez la facture.", 409);
  res.json({ ok: true, statut: vers });
}));

// ---------- Échéances ----------
app.get("/api/echeances", asynchrone(async (req, res) => {
  const jour = aujourdhuiParis();
  const limite = plusJours(jour, 7);
  const enRetard = [], sousSeptJours = [];
  for (const f of await db.facturesAPayer()) {
    const e = f.donnees.date_echeance;
    if (!e) continue;
    if (e < jour) enRetard.push(vuePublique(f));
    else if (e <= limite) sousSeptJours.push(vuePublique(f));
  }
  res.json({ jour, enRetard, sousSeptJours });
}));

// ---------- Journal des achats ----------
app.get("/api/journal.csv", asynchrone(async (req, res) => {
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);
  const compte = compteCharge(req.query.compte);
  const factures = await db.facturesPourJournal({ du: iso(req.query.du), au: iso(req.query.au) });
  res.type("text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="journal-achats-' + aujourdhuiParis() + '.csv"');
  res.send(journalCsv(factures, { compte }));
}));

app.use((req, res) => {
  if (auth.estApi(req.path)) return res.status(404).json({ error: "Ressource introuvable." });
  res.status(404).type("text/html; charset=utf-8").send(auth.pageMessage("Page introuvable", "Cette page n'existe pas ou a été déplacée."));
});
app.use((err, req, res, next) => {
  console.error("[erreur]", req.method, req.path, err && err.stack || err);
  if (res.headersSent) return next(err);
  const statut = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (auth.estApi(req.path)) return res.status(statut).json({ error: statut === 500 ? "Erreur interne du serveur." : "Requête invalide." });
  res.status(statut).type("text/html; charset=utf-8").send(auth.pageMessage("Une erreur est survenue", "Réessayez dans quelques instants."));
});

db.init()
  .then(() => db.marquerExtractionsInterrompues())
  .then((interrompues) => {
    if (interrompues) console.log(`[taches] ${interrompues} extraction(s) interrompue(s) par l'arrêt précédent`);
    app.listen(PORT, HOTE, () => {
      console.log("\n  ADBI - Factures fournisseurs");
      console.log("  -> http://" + HOTE + ":" + PORT + "\n");
      console.log(`[taches] ${MAX_SIMULTANEES} extraction(s) simultanée(s) (ADBI_EXTRACTION_MAX_CONCURRENT)`);
      const avertissement = auth.avertissementAcces(process.env);
      if (avertissement) console.log(avertissement);
    });
  })
  .catch((e) => { console.error("Erreur init DB:", e); process.exit(1); });
