"use strict";
// Stockage PostgreSQL des éléments : même pilote, même init et même sonde que contrats/lib/db.pg.js.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const TIMEOUT_VERIF_MS = 3000;
const JSONB = new Set(["classement", "extraction", "champs", "preuves", "confiances", "rapprochement", "erreur", "source_meta"]);
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
  preuves, confiances, rapprochement, erreur, tache, source_meta, cree_le, modifie_le`;

async function creer(e) {
  const p = await init();
  const r = await p.query(
    `INSERT INTO src_elements (proprietaire, texte, empreinte, url_source, origine, capture_le, auteur, source_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (proprietaire, empreinte) DO NOTHING RETURNING ${COLONNES}`,
    [e.proprietaire, e.texte, e.empreinte, e.url_source, e.origine, e.capture_le, e.auteur, e.source_meta ? JSON.stringify(e.source_meta) : null]
  );
  if (r.rows[0]) return { element: r.rows[0], doublon: false };
  const existant = await p.query(`SELECT ${COLONNES} FROM src_elements WHERE proprietaire = $1 AND empreinte = $2`, [e.proprietaire, e.empreinte]);
  return { element: existant.rows[0] || null, doublon: true };
}

async function obtenir(proprietaire, id) {
  const r = await (await init()).query(`SELECT ${COLONNES} FROM src_elements WHERE proprietaire = $1 AND id = $2`, [proprietaire, id]);
  return r.rows[0] || null;
}

async function obtenirParSource(proprietaire, url) {
  const r = await (await init()).query(`SELECT ${COLONNES} FROM src_elements WHERE proprietaire = $1 AND url_source = $2 ORDER BY id LIMIT 1`, [proprietaire, url]);
  return r.rows[0] || null;
}

async function idsParSources(proprietaire, urls) {
  if (!urls.length) return new Map();
  const r = await (await init()).query("SELECT url_source, min(id) AS id FROM src_elements WHERE proprietaire = $1 AND url_source = ANY($2) GROUP BY url_source", [proprietaire, urls]);
  return new Map(r.rows.map((l) => [l.url_source, l.id]));
}

async function lister(proprietaire, { type = null, statut = null, origine = null, employeur = null, contrat = null } = {}) {
  const conditions = ["proprietaire = $1"];
  const valeurs = [proprietaire];
  const filtres = [["type", type], ["statut", statut], ["origine", origine], ["source_meta->>'employeur'", employeur], ["champs->>'type_contrat'", contrat]];
  for (const [colonne, valeur] of filtres) {
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

const COLONNES_PROFIL = "id, nom, intitule, competences, seniorite, localisation, disponibilite, tjm, notes, cvtheque_id, cree_par, modifie_par, cree_le, modifie_le";
const CHAMPS_PROFIL = ["nom", "intitule", "competences", "seniorite", "localisation", "disponibilite", "tjm", "notes", "cvtheque_id"];
const valeurProfil = (cle, v) => (cle === "competences" ? JSON.stringify(v) : v);

// Le référentiel est commun à toute l'instance : aucun filtre par utilisateur, l'auteur est seulement consigné.
async function listerProfils() {
  const r = await (await init()).query(`SELECT ${COLONNES_PROFIL} FROM src_profils ORDER BY lower(nom), id LIMIT 2000`);
  return r.rows;
}

async function obtenirProfil(id) {
  const r = await (await init()).query(`SELECT ${COLONNES_PROFIL} FROM src_profils WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function creerProfil(auteur, p) {
  const params = [auteur, auteur, ...CHAMPS_PROFIL.map((c) => valeurProfil(c, p[c]))];
  const r = await (await init()).query(
    `INSERT INTO src_profils (cree_par, modifie_par, ${CHAMPS_PROFIL.join(", ")}) VALUES (${params.map((_, i) => "$" + (i + 1)).join(", ")}) RETURNING ${COLONNES_PROFIL}`, params
  );
  return r.rows[0];
}

async function modifierProfil(auteur, id, p) {
  const params = [auteur, id, ...CHAMPS_PROFIL.map((c) => valeurProfil(c, p[c]))];
  const r = await (await init()).query(
    `UPDATE src_profils SET ${CHAMPS_PROFIL.map((c, i) => `${c} = $${i + 3}`).join(", ")}, modifie_par = $1, modifie_le = now() WHERE id = $2 RETURNING ${COLONNES_PROFIL}`, params
  );
  return r.rows[0] || null;
}

async function supprimerProfil(id) {
  const r = await (await init()).query("DELETE FROM src_profils WHERE id = $1", [id]);
  return r.rowCount > 0;
}

async function profilsAffectes(proprietaire, elementId) {
  const r = await (await init()).query(
    `SELECT ${COLONNES_PROFIL.split(", ").map((c) => "p." + c).join(", ")}, a.cree_le AS affecte_le FROM src_affectations a JOIN src_profils p ON p.id = a.profil_id
     WHERE a.proprietaire = $1 AND a.element_id = $2 ORDER BY a.cree_le`, [proprietaire, elementId]
  );
  return r.rows;
}

async function affecter(proprietaire, elementId, profilId) {
  await (await init()).query("INSERT INTO src_affectations (proprietaire, element_id, profil_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [proprietaire, elementId, profilId]);
}

async function desaffecter(proprietaire, elementId, profilId) {
  await (await init()).query("DELETE FROM src_affectations WHERE proprietaire = $1 AND element_id = $2 AND profil_id = $3", [proprietaire, elementId, profilId]);
}

async function nombreAffectations(proprietaire) {
  const r = await (await init()).query("SELECT element_id, count(*)::int AS n FROM src_affectations WHERE proprietaire = $1 GROUP BY element_id", [proprietaire]);
  return new Map(r.rows.map((l) => [l.element_id, l.n]));
}

module.exports = {
  init, verifierConnexion, creer, obtenir, obtenirParSource, idsParSources, lister, modifier,
  listerProfils, obtenirProfil, creerProfil, modifierProfil, supprimerProfil, profilsAffectes, affecter, desaffecter, nombreAffectations,
};
