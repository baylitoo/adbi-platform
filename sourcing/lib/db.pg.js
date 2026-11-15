"use strict";
// Stockage PostgreSQL des éléments : même pilote, même init et même sonde que contrats/lib/db.pg.js.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const TIMEOUT_VERIF_MS = 3000;
const JSONB = new Set(["classement", "extraction", "champs", "preuves", "confiances", "rapprochement", "erreur"]);
const MODIFIABLES = new Set(["statut", "type", "tache", ...JSONB]);

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
      // Les tâches vivent en mémoire : un traitement coupé par un redémarrage ne reviendra jamais.
      await pilote().query(
        "UPDATE src_elements SET statut = CASE WHEN statut IN ('en_attente', 'en_cours') THEN 'echec' ELSE statut END, erreur = CASE WHEN statut IN ('en_attente', 'en_cours') THEN $1 ELSE erreur END, tache = NULL, modifie_le = now() WHERE tache IS NOT NULL OR statut IN ('en_attente', 'en_cours')",
        [{ code: "interrompu", message: "Traitement interrompu par un redémarrage du service : relancez le classement." }]
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

const COLONNES = `id, texte, url_source, origine, capture_le, auteur, statut, type, classement, extraction, champs,
  preuves, confiances, rapprochement, erreur, tache, cree_le, modifie_le`;

async function creer(e) {
  const p = await init();
  const r = await p.query(
    `INSERT INTO src_elements (proprietaire, texte, empreinte, url_source, origine, capture_le, auteur)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (proprietaire, empreinte) DO NOTHING RETURNING ${COLONNES}`,
    [e.proprietaire, e.texte, e.empreinte, e.url_source, e.origine, e.capture_le, e.auteur]
  );
  if (r.rows[0]) return { element: r.rows[0], doublon: false };
  const existant = await p.query(`SELECT ${COLONNES} FROM src_elements WHERE proprietaire = $1 AND empreinte = $2`, [e.proprietaire, e.empreinte]);
  return { element: existant.rows[0] || null, doublon: true };
}

async function obtenir(proprietaire, id) {
  const r = await (await init()).query(`SELECT ${COLONNES} FROM src_elements WHERE proprietaire = $1 AND id = $2`, [proprietaire, id]);
  return r.rows[0] || null;
}

async function lister(proprietaire, { type = null, statut = null, origine = null } = {}) {
  const conditions = ["proprietaire = $1"];
  const valeurs = [proprietaire];
  for (const [colonne, valeur] of [["type", type], ["statut", statut], ["origine", origine]]) {
    if (valeur) { valeurs.push(valeur); conditions.push(`${colonne} = $${valeurs.length}`); }
  }
  const r = await (await init()).query(
    `SELECT ${COLONNES} FROM src_elements WHERE ${conditions.join(" AND ")} ORDER BY cree_le DESC, id DESC LIMIT 500`, valeurs
  );
  return r.rows;
}

// Mise à jour partielle, toujours bornée au propriétaire ; `saufStatuts` refuse l'écriture si l'élément est dans l'un de ces statuts.
async function modifier(proprietaire, id, valeurs, { saufStatuts = null } = {}) {
  const sets = [];
  const params = [proprietaire, id];
  for (const [colonne, valeur] of Object.entries(valeurs)) {
    if (!MODIFIABLES.has(colonne)) throw new Error("Colonne non modifiable : " + colonne);
    params.push(JSONB.has(colonne) && valeur !== null ? JSON.stringify(valeur) : valeur);
    sets.push(`${colonne} = $${params.length}`);
  }
  let condition = "";
  if (saufStatuts) { params.push(saufStatuts); condition = ` AND NOT (statut = ANY($${params.length}))`; }
  const r = await (await init()).query(
    `UPDATE src_elements SET ${sets.join(", ")}, modifie_le = now() WHERE proprietaire = $1 AND id = $2${condition} RETURNING ${COLONNES}`, params
  );
  return r.rows[0] || null;
}

module.exports = { init, verifierConnexion, creer, obtenir, lister, modifier };
