"use strict";
// Stockage PostgreSQL du dossier salarié, sur le modèle de contrats/lib/db.pg.js.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const TIMEOUT_VERIF_MS = 3000;

let pool = null;
let pretInit = null;

function pilote() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquante — requise pour lib/db.pg.js");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => console.error("[db.pg] erreur sur une connexion inactive du pool :", err.message));
  }
  return pool;
}

async function init() {
  if (!pretInit) {
    pretInit = (async () => {
      await pilote().query(fs.readFileSync(SCHEMA_PATH, "utf8"));
      // Une extraction en cours au redémarrage ne reviendra jamais : la tâche vivait en mémoire.
      await pilote().query(
        `UPDATE dsal_pieces SET statut='echec', tache=NULL,
           erreur='{"code":"interrompue","message":"Extraction interrompue par un redémarrage du service : relancez-la."}'::jsonb
         WHERE statut IN ('en_attente','extraction')`
      );
    })();
  }
  await pretInit;
  return pilote();
}

function avecTimeout(promesse, ms, etape) {
  return new Promise((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new Error(`Postgres ne repond pas (timeout ${etape})`)), ms);
    promesse.then((v) => { clearTimeout(minuteur); resolve(v); }, (e) => { clearTimeout(minuteur); reject(e); });
  });
}

async function verifierConnexion() {
  const connexion = pilote().connect();
  let client;
  try {
    client = await avecTimeout(connexion, TIMEOUT_VERIF_MS, "connexion");
  } catch (e) {
    connexion.then((c) => c.release(new Error("client arrive apres le timeout de connexion")), () => {});
    throw e;
  }
  try {
    await avecTimeout(client.query("SELECT 1"), TIMEOUT_VERIF_MS, "requete");
  } catch (e) {
    client.release(e);
    throw e;
  }
  client.release();
}

function isoDate(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function ligneVersDossier(r) {
  if (!r) return null;
  return {
    id: r.id, nom: r.nom, prenoms: r.prenoms, dateEmbauche: isoDate(r.date_embauche),
    typeContrat: r.type_contrat, attendus: r.attendus || [], fiche: r.fiche || {},
    creePar: { sub: r.cree_par_sub, email: r.cree_par_email }, creeLe: r.cree_le, modifieLe: r.modifie_le,
    ...(r.nb_pieces !== undefined ? { nbPieces: Number(r.nb_pieces) } : {}),
  };
}

function ligneVersPiece(r) {
  if (!r) return null;
  return {
    id: r.id, dossierId: r.dossier_id, fichier: r.fichier, nomOrigine: r.nom_origine, mime: r.mime, taille: r.taille,
    typePiece: r.type_piece, classement: r.classement, statut: r.statut, tache: r.tache, voie: r.voie,
    valeurs: r.valeurs || {}, analyse: r.constats || {}, erreur: r.erreur || null,
    deposeLe: r.depose_le, extraitLe: r.extrait_le,
  };
}

// ---------- Dossiers ----------

async function creerDossier({ nom, prenoms, dateEmbauche, typeContrat, attendus, creePar }) {
  const { rows } = await pilote().query(
    `INSERT INTO dsal_dossiers (nom, prenoms, date_embauche, type_contrat, attendus, cree_par_sub, cree_par_email)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
    [nom, prenoms || "", dateEmbauche || null, typeContrat || "", JSON.stringify(attendus), creePar.sub, creePar.email || ""]
  );
  return ligneVersDossier(rows[0]);
}

async function listerDossiers(limite = 500) {
  const { rows } = await pilote().query(
    `SELECT d.*, (SELECT count(*) FROM dsal_pieces p WHERE p.dossier_id = d.id) AS nb_pieces
     FROM dsal_dossiers d ORDER BY d.id DESC LIMIT $1`,
    [limite]
  );
  return rows.map(ligneVersDossier);
}

async function obtenirDossier(id) {
  const { rows } = await pilote().query("SELECT * FROM dsal_dossiers WHERE id=$1", [id]);
  return ligneVersDossier(rows[0]);
}

async function modifierDossier(id, { nom, prenoms, dateEmbauche, typeContrat, attendus, fiche }) {
  const { rows } = await pilote().query(
    `UPDATE dsal_dossiers SET
       nom = COALESCE($2, nom), prenoms = COALESCE($3, prenoms),
       date_embauche = CASE WHEN $4::text IS NULL THEN date_embauche ELSE NULLIF($4::text, '')::date END,
       type_contrat = COALESCE($5, type_contrat),
       attendus = COALESCE($6::jsonb, attendus), fiche = COALESCE($7::jsonb, fiche), modifie_le = now()
     WHERE id=$1 RETURNING *`,
    [id, nom ?? null, prenoms ?? null, dateEmbauche ?? null, typeContrat ?? null,
      attendus ? JSON.stringify(attendus) : null, fiche ? JSON.stringify(fiche) : null]
  );
  return ligneVersDossier(rows[0]);
}

async function supprimerDossier(id) {
  const { rowCount } = await pilote().query("DELETE FROM dsal_dossiers WHERE id=$1", [id]);
  return rowCount > 0;
}

// ---------- Pièces ----------

async function creerPiece({ dossierId, fichier, nomOrigine, mime, taille, typePiece, classement, deposePar }) {
  const { rows } = await pilote().query(
    `INSERT INTO dsal_pieces (dossier_id, fichier, nom_origine, mime, taille, type_piece, classement, depose_par_sub)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [dossierId, fichier, nomOrigine || "", mime, taille, typePiece || null, classement || "", deposePar.sub]
  );
  return ligneVersPiece(rows[0]);
}

async function listerPieces(dossierId) {
  const { rows } = await pilote().query("SELECT * FROM dsal_pieces WHERE dossier_id=$1 ORDER BY id", [dossierId]);
  return rows.map(ligneVersPiece);
}

async function obtenirPiece(dossierId, id) {
  const { rows } = await pilote().query("SELECT * FROM dsal_pieces WHERE dossier_id=$1 AND id=$2", [dossierId, id]);
  return ligneVersPiece(rows[0]);
}

const COLONNES_PIECE = {
  typePiece: "type_piece", classement: "classement", statut: "statut", tache: "tache", voie: "voie",
  valeurs: "valeurs", analyse: "constats", erreur: "erreur", extraitLe: "extrait_le",
};
const COLONNES_JSON = new Set(["valeurs", "analyse", "erreur"]);

async function majPiece(id, champs) {
  const ensembles = [];
  const valeurs = [id];
  for (const [cle, colonne] of Object.entries(COLONNES_PIECE)) {
    if (!Object.hasOwn(champs, cle)) continue;
    const v = champs[cle];
    valeurs.push(COLONNES_JSON.has(cle) && v !== null ? JSON.stringify(v) : v);
    ensembles.push(colonne + "=$" + valeurs.length + (COLONNES_JSON.has(cle) ? "::jsonb" : ""));
  }
  if (!ensembles.length) return null;
  const { rows } = await pilote().query(`UPDATE dsal_pieces SET ${ensembles.join(", ")} WHERE id=$1 RETURNING *`, valeurs);
  return ligneVersPiece(rows[0]);
}

// Conditionnel : une tâche déjà finie a remis `tache` à NULL et ne doit pas être réécrite.
async function attacherTache(id, tache) {
  await pilote().query("UPDATE dsal_pieces SET tache=$2 WHERE id=$1 AND statut IN ('en_attente','extraction')", [id, tache]);
}

async function supprimerPiece(dossierId, id) {
  const { rows } = await pilote().query("DELETE FROM dsal_pieces WHERE dossier_id=$1 AND id=$2 RETURNING fichier", [dossierId, id]);
  return rows[0] ? rows[0].fichier : null;
}

module.exports = {
  init, verifierConnexion,
  creerDossier, listerDossiers, obtenirDossier, modifierDossier, supprimerDossier,
  creerPiece, listerPieces, obtenirPiece, majPiece, attacherTache, supprimerPiece,
};
