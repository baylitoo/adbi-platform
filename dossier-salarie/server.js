"use strict";
// ADBI Dossier salarié : dossier d'entrée d'un nouvel embauché, pièces, complétude et fiche DPAE.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const db = require("./lib/db.pg");
const pieces = require("./lib/pieces");
const extraction = require("./lib/extraction");
const { classer } = require("./lib/classement");
const { completude } = require("./lib/controles");
const fiche = require("./lib/fiche");
const { creerGestionnaire, maxSimultaneesDepuisEnv, mapperErreur, FileTachesPleineError } = require("../contrats/lib/taches-extraction");
const auth = require("../auth/auth-adbi");

const PORT = Number(process.env.PORT) || 4600;
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
const FACTORY_URL = (process.env.ADBI_FACTORY_URL || "").replace(/\/+$/, "");
const DOSSIER_PIECES = path.join(process.env.DSAL_DATA_DIR || path.join(__dirname, "data"), "pieces");
const TAILLE_MAX = 19 * 1024 * 1024;
const TYPES_CONTRAT = ["CDI", "CDD", "Intérim", "Apprentissage", "Professionnalisation", "Stage", "Autre"];

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante — PostgreSQL est requis.");
  process.exit(1);
}
let MAX_SIMULTANEES;
try {
  MAX_SIMULTANEES = maxSimultaneesDepuisEnv();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

process.on("uncaughtException", (e) => console.error("[erreur non gérée]", e && e.message ? e.message : e));
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e && e.message ? e.message : e));

const taches = creerGestionnaire({ maxSimultanees: MAX_SIMULTANEES });
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));

// ---------- Contrôle d'accès (même garde que contrats) ----------

function cheminPublic(chemin) {
  return chemin === "/api/sante" || chemin === "/adbi-theme.css" || chemin === "/adbi-theme.js" || chemin.startsWith("/fonts/");
}

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (cheminPublic(req.path)) return next();
  const decision = auth.garde(req, process.env);
  if (decision.autorise) {
    req.utilisateur = { sub: String(decision.utilisateur.sub || ""), email: String(decision.utilisateur.email || "") };
    return next();
  }
  if (decision.api) return res.status(401).json({ erreur: "Non authentifié" });
  if (!FACTORY_URL) {
    return res.status(401).type("text/html; charset=utf-8").send(auth.pageMessage("Session expirée", "Rouvrez la plateforme ADBI pour vous reconnecter."));
  }
  return res.status(401).type("text/html; charset=utf-8").send(auth.pageReconnexion(FACTORY_URL, "dossier-salarie"));
});
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

// ---------- Utilitaires ----------

function erreur(res, statut, message) {
  return res.status(statut).json({ erreur: message });
}

function idDe(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dateOuVide(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

function attendusValides(liste) {
  if (!Array.isArray(liste)) return null;
  return [...new Set(liste.filter(pieces.estType))];
}

function cheminPiece(dossierId, fichier) {
  return path.join(DOSSIER_PIECES, String(dossierId), fichier);
}

const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[api]", req.method, req.route && req.route.path, e && e.message);
  auth.repondreErreur(res, e);
});

async function chargerDossier(req, res) {
  const id = idDe(req.params.id);
  const dossier = id && await db.obtenirDossier(id);
  if (!dossier) { erreur(res, 404, "Dossier introuvable."); return null; }
  return dossier;
}

function vuePiece(p) {
  const { fichier, ...reste } = p;
  return reste;
}

async function vueDossier(dossier) {
  const liste = await db.listerPieces(dossier.id);
  return {
    dossier,
    pieces: liste.map(vuePiece),
    completude: completude(dossier, liste),
    fiche: fiche.construire(dossier, liste),
  };
}

// ---------- Extraction asynchrone ----------

function travailPiece(pieceId, dossierId) {
  return async () => {
    const piece = await db.obtenirPiece(dossierId, pieceId);
    if (!piece) return { piece: pieceId, etat: "supprimee" };
    await db.majPiece(pieceId, { statut: "extraction" });
    try {
      const buffer = await fsp.readFile(cheminPiece(dossierId, piece.fichier));
      const texte = await extraction.lireTexte(buffer, piece.mime);
      let type = piece.typePiece;
      if (!type) {
        const verdict = await classer({ texte, nomFichier: piece.nomOrigine }, {
          docie: (t) => extraction.classerParDocie({ buffer, mime: piece.mime, texte: t }),
        });
        type = verdict.type;
        await db.majPiece(pieceId, { typePiece: type, classement: verdict.methode });
        if (!type) {
          await db.majPiece(pieceId, { statut: "a_classer", tache: null });
          return { piece: pieceId, etat: "a_classer" };
        }
      }
      if (!extraction.active()) {
        await db.majPiece(pieceId, { statut: "a_saisir", tache: null, voie: "" });
        return { piece: pieceId, etat: "a_saisir" };
      }
      const { valeurs, analyse, voie } = await extraction.extraire(type, { buffer, mime: piece.mime, texte });
      await db.majPiece(pieceId, { statut: "extrait", tache: null, voie, valeurs, analyse, erreur: null, extraitLe: new Date() });
      return { piece: pieceId, etat: "extrait" };
    } catch (e) {
      await db.majPiece(pieceId, { statut: "echec", tache: null, erreur: mapperErreur(e) }).catch(() => {});
      throw e;
    }
  };
}

async function lancer(pieceId, dossierId) {
  await db.majPiece(pieceId, { statut: "en_attente", tache: null, erreur: null });
  const tache = taches.creer(travailPiece(pieceId, dossierId));
  await db.attacherTache(pieceId, tache);
  return tache;
}

// ---------- Routes ----------

app.get("/api/config", (req, res) => {
  res.json({
    utilisateur: { email: req.utilisateur.email },
    types: pieces.descriptionPublique(),
    attendusDefaut: pieces.ATTENDUS_DEFAUT,
    typesContrat: TYPES_CONTRAT,
    champsFiche: fiche.CHAMPS.map(([cle, libelle]) => ({ cle, libelle })),
    extraction: extraction.active(),
    coffreUrl: FACTORY_URL ? FACTORY_URL + "/module.html?m=coffre" : null,
    tailleMax: TAILLE_MAX,
  });
});

app.get("/api/dossiers", route(async (req, res) => {
  res.json({ dossiers: await db.listerDossiers() });
}));

app.post("/api/dossiers", route(async (req, res) => {
  const b = req.body || {};
  const nom = String(b.nom || "").trim().slice(0, 120);
  const prenoms = String(b.prenoms || "").trim().slice(0, 160);
  const dateEmbauche = dateOuVide(b.dateEmbauche);
  const typeContrat = String(b.typeContrat || "").trim().slice(0, 60);
  if (!nom) return erreur(res, 400, "Le nom est obligatoire.");
  if (dateEmbauche === null) return erreur(res, 400, "Date d'embauche invalide.");
  const attendus = attendusValides(b.attendus) || pieces.ATTENDUS_DEFAUT;
  const dossier = await db.creerDossier({ nom, prenoms, dateEmbauche, typeContrat, attendus, creePar: req.utilisateur });
  res.status(201).json({ dossier });
}));

app.get("/api/dossiers/:id", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (dossier) res.json(await vueDossier(dossier));
}));

app.put("/api/dossiers/:id", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const b = req.body || {};
  const maj = {};
  if (b.nom !== undefined) {
    maj.nom = String(b.nom).trim().slice(0, 120);
    if (!maj.nom) return erreur(res, 400, "Le nom est obligatoire.");
  }
  if (b.prenoms !== undefined) maj.prenoms = String(b.prenoms).trim().slice(0, 160);
  if (b.typeContrat !== undefined) maj.typeContrat = String(b.typeContrat).trim().slice(0, 60);
  if (b.dateEmbauche !== undefined) {
    maj.dateEmbauche = dateOuVide(b.dateEmbauche);
    if (maj.dateEmbauche === null) return erreur(res, 400, "Date d'embauche invalide.");
  }
  if (b.attendus !== undefined) maj.attendus = attendusValides(b.attendus) || dossier.attendus;
  if (b.fiche !== undefined) maj.fiche = fiche.nettoyerSaisie(b.fiche);
  res.json(await vueDossier(await db.modifierDossier(dossier.id, maj)));
}));

app.delete("/api/dossiers/:id", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  await db.supprimerDossier(dossier.id);
  await fsp.rm(path.join(DOSSIER_PIECES, String(dossier.id)), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.post("/api/dossiers/:id/pieces", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const b = req.body || {};
  if (!b.dataBase64 || typeof b.dataBase64 !== "string") return erreur(res, 400, "Aucun fichier reçu.");
  const buffer = Buffer.from(b.dataBase64, "base64");
  if (!buffer.length || buffer.length > TAILLE_MAX) return erreur(res, 413, "Fichier vide ou trop volumineux (19 Mo au plus).");
  const mime = extraction.sniffMime(b.mime, buffer);
  if (!extraction.MIMES.has(mime)) return erreur(res, 415, "Format non pris en charge : PDF, PNG ou JPEG.");
  const typePiece = b.typePiece && pieces.estType(b.typePiece) ? b.typePiece : null;
  const fichier = crypto.randomUUID();
  await fsp.mkdir(path.join(DOSSIER_PIECES, String(dossier.id)), { recursive: true });
  await fsp.writeFile(cheminPiece(dossier.id, fichier), buffer, { mode: 0o600 });
  let piece;
  try {
    piece = await db.creerPiece({
      dossierId: dossier.id, fichier, nomOrigine: String(b.nom || "").slice(0, 200), mime, taille: buffer.length,
      typePiece, classement: typePiece ? "manuel" : "", deposePar: req.utilisateur,
    });
  } catch (e) {
    await fsp.rm(cheminPiece(dossier.id, fichier), { force: true });
    throw e;
  }
  try {
    const tache = await lancer(piece.id, dossier.id);
    res.status(202).json({ piece: piece.id, tache });
  } catch (e) {
    if (!(e instanceof FileTachesPleineError)) throw e;
    await db.majPiece(piece.id, { statut: "echec", erreur: { code: "file_pleine", message: e.message } });
    res.status(503).json({ erreur: e.message, piece: piece.id });
  }
}));

app.put("/api/dossiers/:id/pieces/:pid", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const piece = await db.obtenirPiece(dossier.id, idDe(req.params.pid));
  if (!piece) return erreur(res, 404, "Pièce introuvable.");
  if (["en_attente", "extraction"].includes(piece.statut)) return erreur(res, 409, "Extraction en cours : attendez la fin.");
  const b = req.body || {};
  if (b.typePiece !== undefined && b.typePiece !== piece.typePiece) {
    if (!pieces.estType(b.typePiece)) return erreur(res, 400, "Type de pièce inconnu.");
    await db.majPiece(piece.id, { typePiece: b.typePiece, classement: "manuel", valeurs: {}, analyse: {}, erreur: null });
    const tache = await lancer(piece.id, dossier.id);
    return res.status(202).json({ piece: piece.id, tache });
  }
  if (b.valeurs !== undefined) {
    if (!piece.typePiece) return erreur(res, 400, "Choisissez d'abord le type de la pièce.");
    const valeurs = pieces.nettoyerValeurs(piece.typePiece, b.valeurs);
    await db.majPiece(piece.id, { valeurs, statut: piece.statut === "a_classer" ? "a_saisir" : piece.statut });
  }
  res.json(await vueDossier(dossier));
}));

app.post("/api/dossiers/:id/pieces/:pid/relancer", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const piece = await db.obtenirPiece(dossier.id, idDe(req.params.pid));
  if (!piece) return erreur(res, 404, "Pièce introuvable.");
  if (["en_attente", "extraction"].includes(piece.statut)) return erreur(res, 409, "Extraction déjà en cours.");
  try {
    res.status(202).json({ piece: piece.id, tache: await lancer(piece.id, dossier.id) });
  } catch (e) {
    if (e instanceof FileTachesPleineError) return erreur(res, 503, e.message);
    throw e;
  }
}));

app.get("/api/dossiers/:id/pieces/:pid/fichier", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const piece = await db.obtenirPiece(dossier.id, idDe(req.params.pid));
  if (!piece) return erreur(res, 404, "Pièce introuvable.");
  const chemin = cheminPiece(dossier.id, piece.fichier);
  if (!fs.existsSync(chemin)) return erreur(res, 404, "Fichier introuvable.");
  const ext = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg" }[piece.mime] || "";
  res.type(piece.mime);
  res.attachment((piece.typePiece || "piece") + "-" + piece.id + ext);
  res.sendFile(chemin);
}));

app.delete("/api/dossiers/:id/pieces/:pid", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const fichier = await db.supprimerPiece(dossier.id, idDe(req.params.pid));
  if (!fichier) return erreur(res, 404, "Pièce introuvable.");
  await fsp.rm(cheminPiece(dossier.id, fichier), { force: true });
  res.json(await vueDossier(dossier));
}));

app.get("/api/dossiers/:id/fiche.csv", route(async (req, res) => {
  const dossier = await chargerDossier(req, res);
  if (!dossier) return;
  const champs = fiche.construire(dossier, await db.listerPieces(dossier.id));
  res.type("text/csv; charset=utf-8");
  res.attachment("fiche-entree-" + dossier.id + ".csv");
  res.send(fiche.versCsv(champs));
}));

app.get("/api/taches/:id", (req, res) => {
  const vue = taches.obtenir(req.params.id);
  if (!vue) return erreur(res, 404, "Tâche inconnue ou expirée.");
  res.json(vue);
});

app.use("/api", (req, res) => erreur(res, 404, "Route inconnue."));

db.init()
  .then(() => {
    app.listen(PORT, HOTE, () => {
      console.log(`ADBI Dossier salarié prêt sur http://${HOTE}:${PORT} (${MAX_SIMULTANEES} extraction(s) simultanée(s))`);
      const alerte = auth.avertissementAcces(process.env);
      if (alerte) console.warn(alerte);
    });
  })
  .catch((e) => {
    console.error("Initialisation de la base impossible :", e.message);
    process.exit(1);
  });
