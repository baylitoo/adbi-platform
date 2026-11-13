"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./lib/db.pg");
const { extraireRecu, typeReel, MIMES_ACCEPTES } = require("./lib/recu-extraction");
const { normaliserChamps, CATEGORIES } = require("./lib/recu-mapping");
const { controler } = require("./lib/controles");
const { exporterCsv } = require("./lib/export-csv");
// Bibliothèques partagées : ../auth et ../contrats/lib en checkout, /auth et /contrats/lib dans l'image.
const auth = require("../auth/auth-adbi");
const taches = require("../contrats/lib/taches-extraction");

const PORT = Number(process.env.PORT) || 4400;
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
const FACTORY_URL = process.env.ADBI_FACTORY_URL || "";
const ID_MODULE = "notes-frais";
const DOSSIER_RECUS = path.join(__dirname, "data", "recus");
const TAILLE_MAX = 15 * 1024 * 1024;
const EXTENSIONS = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg" };

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante — voir .env.example.");
  process.exit(1);
}
let MAX_SIMULTANEES;
try {
  MAX_SIMULTANEES = taches.maxSimultaneesDepuisEnv();
} catch (e) {
  console.error(e.message + " Voir .env.example.");
  process.exit(1);
}
console.log(`[taches] ${MAX_SIMULTANEES} extraction(s) simultanée(s) (ADBI_EXTRACTION_MAX_CONCURRENT)`);
const gestionnaire = taches.creerGestionnaire({ maxSimultanees: MAX_SIMULTANEES });

process.on("uncaughtException", (e) => console.error("[erreur non gérée]", e && e.message ? e.message : e));
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e && e.message ? e.message : e));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));

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

// Seul le superutilisateur voit les notes de tout le monde ; chacun voit les siennes.
function toutVoir(req) {
  return req.utilisateur && req.utilisateur.role === "superuser";
}

function portee(req) {
  if (!toutVoir(req)) return req.utilisateur.sub;
  const demande = typeof req.query.utilisateur === "string" ? req.query.utilisateur.trim() : "";
  return demande || null;
}

function moisDemande(req) {
  const m = typeof req.query.mois === "string" ? req.query.mois.trim() : "";
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : null;
}

async function noteAutorisee(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Identifiant invalide." }); return null; }
  const note = await db.obtenirNote(id);
  if (!note || (!toutVoir(req) && note.utilisateur.sub !== req.utilisateur.sub)) {
    res.status(404).json({ error: "Note introuvable." });
    return null;
  }
  return note;
}

// Met l'extraction en file ; la note porte le résultat ou l'erreur, la tâche sert au suivi de l'attente.
async function lancerExtraction(note, buffer) {
  let tache;
  try {
    tache = gestionnaire.creer(async () => {
      try {
        const lu = await extraireRecu(buffer, note.fichier.mime);
        await db.enregistrerExtraction(note.id, lu);
        return { note: note.id };
      } catch (e) {
        await db.enregistrerEchec(note.id, taches.mapperErreur(e)).catch((err) => console.error("[extraction]", err.message));
        throw e;
      }
    });
  } catch (e) {
    if (!(e instanceof taches.FileTachesPleineError)) throw e;
    await db.enregistrerEchec(note.id, { code: "file_pleine", message: e.message });
    return null;
  }
  await db.attacherTache(note.id, tache);
  return tache;
}

app.get("/api/moi", (req, res) => {
  const u = req.utilisateur;
  res.json({ utilisateur: { sub: u.sub, email: u.email || "", full_name: u.full_name || "" }, toutVoir: toutVoir(req), categories: CATEGORIES });
});

app.post("/api/notes", async (req, res) => {
  try {
    const f = req.body && req.body.fichier;
    if (!f || typeof f.contenu !== "string" || !f.contenu) return res.status(400).json({ error: "Aucun fichier reçu." });
    const buffer = Buffer.from(f.contenu, "base64");
    if (!buffer.length) return res.status(400).json({ error: "Fichier vide." });
    if (buffer.length > TAILLE_MAX) return res.status(413).json({ error: "Fichier trop volumineux (15 Mo maximum)." });
    const mime = typeReel(buffer);
    if (mime === "image/heic") {
      return res.status(415).json({ error: "Photo HEIC non prise en charge : réglez l'appareil sur « Le plus compatible » (JPEG) ou exportez la photo en JPEG." });
    }
    if (!MIMES_ACCEPTES.includes(mime)) return res.status(415).json({ error: "Format non pris en charge : PDF, JPEG ou PNG uniquement." });
    const nomFichier = crypto.randomUUID() + EXTENSIONS[mime];
    fs.mkdirSync(DOSSIER_RECUS, { recursive: true });
    fs.writeFileSync(path.join(DOSSIER_RECUS, nomFichier), buffer);
    const nomOrigine = String(f.nom || "recu").replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 160);
    const note = await db.creerNote({
      utilisateur: req.utilisateur,
      fichier: { nom: nomOrigine, chemin: nomFichier, mime, taille: buffer.length },
    });
    const tache = await lancerExtraction(note, buffer);
    res.status(202).json({ note: note.id, tache });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.post("/api/notes/:id/relancer", async (req, res) => {
  try {
    const note = await noteAutorisee(req, res);
    if (!note) return;
    if (note.statut === "extraction") return res.status(409).json({ error: "Extraction déjà en cours." });
    const buffer = fs.readFileSync(path.join(DOSSIER_RECUS, path.basename(note.fichier.chemin)));
    await db.demarrerExtraction(note.id);
    const tache = await lancerExtraction(note, buffer);
    res.status(202).json({ note: note.id, tache });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.get("/api/taches/:id", (req, res) => {
  const vue = gestionnaire.obtenir(req.params.id);
  if (!vue) return res.status(404).json({ error: "Tâche inconnue ou expirée." });
  res.json(vue);
});

app.get("/api/mois", async (req, res) => {
  try {
    res.json({ mois: await db.listerMois({ userSub: portee(req) }) });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.get("/api/notes", async (req, res) => {
  try {
    const notes = controler(await db.listerNotes({ mois: moisDemande(req), userSub: portee(req) }));
    res.json({ notes: notes.map(({ extraction, ...n }) => ({ ...n, partiel: extraction.partiel || [] })) });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.patch("/api/notes/:id", async (req, res) => {
  try {
    const note = await noteAutorisee(req, res);
    if (!note) return;
    if (note.statut === "extraction") return res.status(409).json({ error: "Extraction en cours : attendez son résultat." });
    const champs = normaliserChamps(req.body);
    const valider = req.body && req.body.valider === true;
    if (valider && (!champs.date || champs.total_ttc === null || !champs.commercant)) {
      return res.status(400).json({ error: "Date, commerçant et total TTC sont requis pour valider." });
    }
    const maj = await db.modifierNote(note.id, champs, valider);
    if (!maj) return res.status(409).json({ error: "Note modifiée entre-temps : rechargez la page." });
    res.json({ ok: true, statut: maj.statut });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.delete("/api/notes/:id", async (req, res) => {
  try {
    const note = await noteAutorisee(req, res);
    if (!note) return;
    if (note.statut === "extraction") return res.status(409).json({ error: "Extraction en cours : attendez son résultat." });
    await db.supprimerNote(note.id);
    fs.rm(path.join(DOSSIER_RECUS, path.basename(note.fichier.chemin)), { force: true }, () => {});
    res.json({ ok: true });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.get("/api/notes/:id/fichier", async (req, res) => {
  try {
    const note = await noteAutorisee(req, res);
    if (!note) return;
    res.set("X-Content-Type-Options", "nosniff");
    res.type(note.fichier.mime);
    res.sendFile(path.join(DOSSIER_RECUS, path.basename(note.fichier.chemin)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Justificatif introuvable." });
    });
  } catch (e) { auth.repondreErreur(res, e); }
});

app.get("/api/export.csv", async (req, res) => {
  try {
    const mois = moisDemande(req);
    const notes = (await db.listerNotes({ mois, userSub: portee(req) })).filter((n) => n.statut === "validee");
    res.set("Content-Disposition", `attachment; filename="notes-frais-${mois || "toutes"}.csv"`);
    res.type("text/csv; charset=utf-8").send(exporterCsv(notes));
  } catch (e) { auth.repondreErreur(res, e); }
});

app.use((req, res) => {
  if (auth.estApi(req.path)) return res.status(404).json({ error: "Ressource introuvable." });
  res.status(404).type("text/html; charset=utf-8").send(auth.pageMessage("Page introuvable", "Cette page n'existe pas ou a été déplacée."));
});
app.use((err, req, res, next) => {
  console.error("[erreur]", req.method, req.path, err && err.stack || err);
  if (res.headersSent) return next(err);
  const statut = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (auth.estApi(req.path)) return res.status(statut).json({ error: statut === 413 ? "Fichier trop volumineux (15 Mo maximum)." : statut === 500 ? "Erreur interne du serveur." : "Requête invalide." });
  res.status(statut).type("text/html; charset=utf-8").send(auth.pageMessage("Une erreur est survenue", "Réessayez dans quelques instants."));
});

db.init()
  .then(() => {
    app.listen(PORT, HOTE, () => {
      console.log("\n  ADBI - Notes de frais");
      console.log("  -> http://" + HOTE + ":" + PORT + "\n");
      const avertissement = auth.avertissementAcces(process.env);
      if (avertissement) console.log(avertissement);
    });
  })
  .catch((e) => { console.error("Erreur init DB:", e); process.exit(1); });
