"use strict";
// Stockage PostgreSQL des notes de frais : même pilote, même init et même sonde que contrats/lib/db.pg.js.

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
      // Les tâches vivent en mémoire : une extraction coupée par un redémarrage ne reviendra jamais.
      await pilote().query(
        "UPDATE ndf_notes SET statut = 'echec', tache = NULL, erreur = $1, modifie_le = now() WHERE statut = 'extraction'",
        [{ code: "interrompue", message: "Extraction interrompue par un redémarrage du service : relancez-la ou saisissez la note." }]
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

const COLONNES = `id, user_sub, user_email, user_nom, fichier_nom, fichier_chemin, fichier_mime, fichier_taille,
  statut, tache, erreur, voie, modele, to_char(date_depense, 'YYYY-MM-DD') AS date_depense, commercant,
  total_ht, tva, total_ttc, devise, moyen_paiement, categorie, extraction, cree_le, modifie_le, valide_le,
  to_char(COALESCE(date_depense, (cree_le AT TIME ZONE 'Europe/Paris')::date), 'YYYY-MM') AS mois`;

const nombre = (v) => (v === null || v === undefined ? null : Number(v));

function ligneVersNote(r) {
  if (!r) return null;
  return {
    id: r.id,
    utilisateur: { sub: r.user_sub, email: r.user_email, nom: r.user_nom },
    fichier: { nom: r.fichier_nom, chemin: r.fichier_chemin, mime: r.fichier_mime, taille: r.fichier_taille },
    statut: r.statut,
    tache: r.tache,
    erreur: r.erreur,
    voie: r.voie,
    modele: r.modele,
    date: r.date_depense || "",
    commercant: r.commercant,
    total_ht: nombre(r.total_ht),
    tva: Array.isArray(r.tva) ? r.tva : [],
    total_ttc: nombre(r.total_ttc),
    devise: r.devise,
    moyen_paiement: r.moyen_paiement,
    categorie: r.categorie,
    extraction: r.extraction || {},
    mois: r.mois,
    creeLe: r.cree_le,
    modifieLe: r.modifie_le,
    valideLe: r.valide_le,
  };
}

async function creerNote({ utilisateur, fichier }) {
  const { rows } = await (await init()).query(
    `INSERT INTO ndf_notes (user_sub, user_email, user_nom, fichier_nom, fichier_chemin, fichier_mime, fichier_taille)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLONNES}`,
    [utilisateur.sub, utilisateur.email || "", utilisateur.full_name || "", fichier.nom, fichier.chemin, fichier.mime, fichier.taille]
  );
  return ligneVersNote(rows[0]);
}

async function obtenirNote(id) {
  const { rows } = await (await init()).query(`SELECT ${COLONNES} FROM ndf_notes WHERE id = $1`, [id]);
  return ligneVersNote(rows[0]);
}

async function demarrerExtraction(id) {
  await (await init()).query(
    "UPDATE ndf_notes SET statut = 'extraction', tache = NULL, erreur = NULL, valide_le = NULL, modifie_le = now() WHERE id = $1",
    [id]
  );
}

// Posée après la mise en file : une tâche déjà finie ne repasse jamais en extraction.
async function attacherTache(id, tache) {
  await (await init()).query("UPDATE ndf_notes SET tache = $2 WHERE id = $1 AND statut = 'extraction'", [id, tache]);
}

async function enregistrerExtraction(id, { champs, voie, modele, extraction }) {
  const { rows } = await (await init()).query(
    `UPDATE ndf_notes SET statut = 'a_valider', tache = NULL, erreur = NULL, voie = $2, modele = $3, extraction = $4,
       date_depense = $5, commercant = $6, total_ht = $7, tva = $8, total_ttc = $9, devise = $10,
       moyen_paiement = $11, categorie = $12, modifie_le = now()
     WHERE id = $1 RETURNING ${COLONNES}`,
    [id, voie, modele || "", extraction, champs.date || null, champs.commercant, champs.total_ht, JSON.stringify(champs.tva),
      champs.total_ttc, champs.devise, champs.moyen_paiement, champs.categorie]
  );
  return ligneVersNote(rows[0]);
}

async function enregistrerEchec(id, erreur) {
  await (await init()).query(
    "UPDATE ndf_notes SET statut = 'echec', tache = NULL, erreur = $2, modifie_le = now() WHERE id = $1",
    [id, erreur]
  );
}

async function modifierNote(id, champs, valider) {
  const { rows } = await (await init()).query(
    `UPDATE ndf_notes SET date_depense = $2, commercant = $3, total_ht = $4, tva = $5, total_ttc = $6, devise = $7,
       moyen_paiement = $8, categorie = $9, modifie_le = now(),
       statut = CASE WHEN $10::boolean THEN 'validee' WHEN statut = 'validee' THEN 'a_valider' ELSE statut END,
       valide_le = CASE WHEN $10::boolean THEN now() ELSE NULL END
     WHERE id = $1 AND statut <> 'extraction' RETURNING ${COLONNES}`,
    [id, champs.date || null, champs.commercant, champs.total_ht, JSON.stringify(champs.tva), champs.total_ttc,
      champs.devise, champs.moyen_paiement, champs.categorie, Boolean(valider)]
  );
  return ligneVersNote(rows[0]);
}

async function supprimerNote(id) {
  const { rows } = await (await init()).query(`DELETE FROM ndf_notes WHERE id = $1 RETURNING ${COLONNES}`, [id]);
  return ligneVersNote(rows[0]);
}

// userSub null : toutes les notes (superutilisateur) ; mois "AAAA-MM" ou null.
async function listerNotes({ mois = null, userSub = null } = {}) {
  const { rows } = await (await init()).query(
    `SELECT * FROM (SELECT ${COLONNES} FROM ndf_notes WHERE ($1::text IS NULL OR user_sub = $1)) n
     WHERE ($2::text IS NULL OR n.mois = $2) ORDER BY n.user_nom, n.user_sub, n.date_depense NULLS LAST, n.id`,
    [userSub, mois]
  );
  return rows.map(ligneVersNote);
}

async function listerMois({ userSub = null } = {}) {
  const { rows } = await (await init()).query(
    `SELECT mois, count(*)::int AS n FROM (SELECT ${COLONNES} FROM ndf_notes WHERE ($1::text IS NULL OR user_sub = $1)) n
     GROUP BY mois ORDER BY mois DESC`,
    [userSub]
  );
  return rows;
}

module.exports = {
  init, verifierConnexion, creerNote, obtenirNote, demarrerExtraction, attacherTache, enregistrerExtraction, enregistrerEchec,
  modifierNote, supprimerNote, listerNotes, listerMois,
};
