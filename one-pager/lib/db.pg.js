/**
 * Stockage PostgreSQL — même API que lib/db.js (sql.js), mais asynchrone :
 * chaque fonction retourne une Promise. Tant que server.js n'a pas été
 * basculé dessus (voir issue #16, PR de bascule), ce module n'est pas
 * importé — lib/db.js reste la base réellement utilisée.
 *
 * master/options : voir lib/schema.sql, gardés en JSONB tels quels.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");

let pool = null;
let pretInit = null;

function pilote() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL manquante — requise pour lib/db.pg.js");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function init() {
  if (!pretInit) {
    pretInit = (async () => {
      const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
      await pilote().query(schema);
    })();
  }
  await pretInit;
  return pilote();
}

function versEnregistrement(r) {
  if (!r) return null;
  return { ...r, master: r.master, options: r.options || {} };
}

async function save(record) {
  const now = new Date().toISOString();
  const existant = await get(record.id);
  const { rows } = await pilote().query(
    `INSERT INTO cvs (id, nom, titre, fichier, hash, master, options, cree_le, maj_le)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       nom = EXCLUDED.nom, titre = EXCLUDED.titre, fichier = EXCLUDED.fichier,
       hash = EXCLUDED.hash, master = EXCLUDED.master, options = EXCLUDED.options,
       maj_le = EXCLUDED.maj_le
     RETURNING *`,
    [
      record.id,
      (record.master.identity && record.master.identity.full_name) || "",
      (record.master.identity && record.master.identity.title) || "",
      (record.master.source && record.master.source.filename) || "",
      record.hash || "",
      JSON.stringify(record.master),
      JSON.stringify(record.options || {}),
      existant ? existant.cree_le : now,
      now,
    ]
  );
  return versEnregistrement(rows[0]);
}

async function get(id) {
  const { rows } = await pilote().query("SELECT * FROM cvs WHERE id = $1", [id]);
  return versEnregistrement(rows[0]);
}

async function findByHash(hash) {
  const { rows } = await pilote().query(
    "SELECT id FROM cvs WHERE hash = $1 ORDER BY maj_le DESC LIMIT 1",
    [hash]
  );
  return rows[0] ? get(rows[0].id) : null;
}

function resume(r) {
  const { master, ...reste } = r;
  const m = master || {};
  return {
    ...reste,
    trigramme: (m.identity && m.identity.trigram) || "",
    missions: (m.experiences || []).length,
    anciennete: (m.identity && m.identity.seniority_years) || 0,
  };
}

async function list() {
  const { rows } = await pilote().query(
    "SELECT id, nom, titre, fichier, cree_le, maj_le, master FROM cvs ORDER BY maj_le DESC"
  );
  return rows.map(resume);
}

async function remove(id) {
  await pilote().query("DELETE FROM cvs WHERE id = $1", [id]);
}

/** Recherche plein texte simple sur le contenu structuré (même comportement que lib/db.js). */
async function search(q) {
  const needle = String(q || "").trim();
  if (!needle) return list();
  const { rows } = await pilote().query(
    `SELECT id, nom, titre, fichier, cree_le, maj_le, master FROM cvs
     WHERE LOWER(master::text) LIKE '%' || LOWER($1) || '%'
     ORDER BY maj_le DESC`,
    [needle]
  );
  return rows.map(resume);
}

module.exports = { init, save, get, list, remove, search, findByHash };
