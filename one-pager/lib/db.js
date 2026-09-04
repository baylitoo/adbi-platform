/**
 * Stockage local (SQLite via sql.js / WebAssembly, sans compilation native).
 *
 * DEPUIS LA BASCULE POSTGRESQL (issue #16, PR B) : server.js n'importe plus ce
 * module, seulement scripts/migrer-vers-postgres.js (lecture de l'ancien
 * cvs.sqlite pour la migration ponctuelle) — voir lib/db.pg.js pour le
 * stockage reellement utilise en production.
 *
 * On conserve DEUX choses par CV : le « cv_master » complet issu de
 * l'extraction, et les options de generation. Le one-pager, lui, n'est jamais
 * stocke : il est recalcule a la demande, ce qui permet de changer de gabarit
 * ou de cible sans re-parser le fichier source.
 */

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "cvs.sqlite");

let db = null;

async function init() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS cvs (
    id           TEXT PRIMARY KEY,
    nom          TEXT,
    titre        TEXT,
    fichier      TEXT,
    hash         TEXT,
    master       TEXT NOT NULL,
    options      TEXT,
    cree_le      TEXT,
    maj_le       TEXT
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cvs_hash ON cvs(hash);`);
  persist();
  return db;
}

/**
 * Ecriture de la base sur disque.
 *
 * sql.js reecrit le fichier ENTIER a chaque fois : une base corrompue ou
 * ecrasee par erreur est definitivement perdue. On conserve donc une rotation
 * de sauvegardes, et on refuse d'ecraser une base bien remplie par une base
 * quasi vide — le scenario exact d'une seconde instance qui repartirait de
 * rien. Le cout est negligeable devant la perte d'un vivier de CV.
 */
function persist() {
  const donnees = Buffer.from(db.export());
  const nb = compter();

  if (fs.existsSync(DB_PATH)) {
    const nbDisque = compterFichier(DB_PATH);
    // Chute brutale : on archive l'ancienne base sous un nom explicite plutot
    // que de l'ecraser silencieusement.
    if (nbDisque > 3 && nb < nbDisque / 2) {
      const secours = DB_PATH.replace(/\.sqlite$/, "") + ".avant-perte-" + horodatage() + ".sqlite";
      fs.copyFileSync(DB_PATH, secours);
      console.warn(`[base] passage de ${nbDisque} à ${nb} CV — copie de sécurité : ${path.basename(secours)}`);
    }
    tournerSauvegardes();
  }

  fs.writeFileSync(DB_PATH, donnees);
}

function compter() {
  try {
    const st = db.prepare("SELECT COUNT(*) AS n FROM cvs");
    st.step();
    const n = st.getAsObject().n;
    st.free();
    return n;
  } catch {
    return 0;
  }
}

/** Compte les enregistrements d'un fichier de base, sans toucher a la base ouverte. */
function compterFichier(chemin) {
  try {
    const autre = new SQL.Database(fs.readFileSync(chemin));
    const st = autre.prepare("SELECT COUNT(*) AS n FROM cvs");
    st.step();
    const n = st.getAsObject().n;
    st.free();
    autre.close();
    return n;
  } catch {
    return 0;
  }
}

/** Trois sauvegardes glissantes : .1 est la plus recente. */
function tournerSauvegardes() {
  const base = DB_PATH.replace(/\.sqlite$/, "");
  try {
    for (let i = 3; i > 1; i--) {
      const src = `${base}.sauvegarde${i - 1}.sqlite`;
      if (fs.existsSync(src)) fs.copyFileSync(src, `${base}.sauvegarde${i}.sqlite`);
    }
    fs.copyFileSync(DB_PATH, `${base}.sauvegarde1.sqlite`);
  } catch (e) {
    console.warn("[base] sauvegarde impossible :", e.message);
  }
}

function horodatage() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function rows(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

function save(record) {
  const now = new Date().toISOString();
  const existing = rows("SELECT id, cree_le FROM cvs WHERE id = ?", [record.id])[0];
  db.run(
    `INSERT OR REPLACE INTO cvs (id, nom, titre, fichier, hash, master, options, cree_le, maj_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.master.identity.full_name || "",
      record.master.identity.title || "",
      record.master.source.filename || "",
      record.hash || "",
      JSON.stringify(record.master),
      JSON.stringify(record.options || {}),
      existing ? existing.cree_le : now,
      now,
    ]
  );
  persist();
  return get(record.id);
}

function get(id) {
  const r = rows("SELECT * FROM cvs WHERE id = ?", [id])[0];
  if (!r) return null;
  return { ...r, master: JSON.parse(r.master), options: JSON.parse(r.options || "{}") };
}

function findByHash(hash) {
  const r = rows("SELECT id FROM cvs WHERE hash = ? ORDER BY maj_le DESC", [hash])[0];
  return r ? get(r.id) : null;
}

/**
 * Liste destinee a l'onglet Historique. On derive le trigramme et le nombre de
 * missions du contenu, sans exposer le cv_master entier : la liste reste
 * legere meme avec plusieurs centaines de CV.
 */
function list() {
  return rows(`SELECT id, nom, titre, fichier, cree_le, maj_le, master FROM cvs ORDER BY maj_le DESC`)
    .map(resume);
}

function resume(r) {
  const { master, ...reste } = r;
  let m = {};
  try { m = JSON.parse(master); } catch { /* enregistrement illisible : on degrade */ }
  return {
    ...reste,
    trigramme: (m.identity && m.identity.trigram) || "",
    missions: (m.experiences || []).length,
    anciennete: (m.identity && m.identity.seniority_years) || 0,
  };
}

function remove(id) {
  db.run("DELETE FROM cvs WHERE id = ?", [id]);
  persist();
}

/** Recherche plein texte simple sur le contenu structure (vivier de consultants). */
function search(q) {
  const needle = String(q || "").toLowerCase();
  if (!needle) return list();
  return rows(`SELECT id, nom, titre, fichier, cree_le, maj_le, master FROM cvs ORDER BY maj_le DESC`)
    .filter((r) => r.master.toLowerCase().includes(needle))
    .map(resume);
}

module.exports = { init, save, get, list, remove, search, findByHash };
