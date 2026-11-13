"use strict";

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
  if (!pretInit) pretInit = pilote().query(fs.readFileSync(SCHEMA_PATH, "utf8"));
  await pretInit;
  return pilote();
}

function avecTimeout(promesse, ms, etape) {
  return new Promise((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new Error(`Postgres ne répond pas (timeout ${etape})`)), ms);
    promesse.then((v) => { clearTimeout(minuteur); resolve(v); }, (e) => { clearTimeout(minuteur); reject(e); });
  });
}

// Même sonde que contrats/lib/db.pg.js : SELECT 1 borné, client jamais laissé emprunté.
async function verifierConnexion() {
  const connexion = pilote().connect();
  let client;
  try {
    client = await avecTimeout(connexion, TIMEOUT_VERIF_MS, "connexion");
  } catch (e) {
    connexion.then((c) => c.release(new Error("client arrivé après le timeout de connexion")), () => {});
    throw e;
  }
  try {
    await avecTimeout(client.query("SELECT 1"), TIMEOUT_VERIF_MS, "requête");
  } catch (e) {
    client.release(e);
    throw e;
  }
  client.release();
}

async function enTransaction(travail) {
  const client = await pilote().connect();
  try {
    await client.query("BEGIN");
    const resultat = await travail(client);
    await client.query("COMMIT");
    return resultat;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function auteur(utilisateur) {
  const u = utilisateur || {};
  return { sub: String(u.sub || ""), email: String(u.email || "") };
}

async function insererEvenement(executeur, factureId, type, utilisateur, { de = "", vers = "", details = {} } = {}) {
  const { sub, email } = auteur(utilisateur);
  if (!sub) throw new Error("Événement sans utilisateur identifié.");
  await executeur.query(
    `INSERT INTO fac_evenements (facture_id, type, de, vers, details, sub, email) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [factureId, type, de, vers, JSON.stringify(details || {}), sub, email]
  );
}

function ligneVersFacture(r) {
  if (!r) return null;
  return {
    id: r.id,
    statut: r.statut,
    fichier: { nom: r.fichier_nom, mime: r.fichier_mime, taille: r.fichier_taille, empreinte: r.empreinte },
    fichierChemin: r.fichier_chemin,
    extraction: { etat: r.extraction_etat, erreur: r.extraction_erreur, ...r.extraction },
    donnees: r.donnees || {},
    siren: r.siren,
    numero: r.numero,
    fournisseur: r.fournisseur,
    iban: r.iban,
    verifSociete: r.verif_societe || {},
    creeLe: r.cree_le,
    majLe: r.maj_le,
  };
}

const COLONNES_VIDES = { siren: "", numero: "", fournisseur: "", iban: "", date_facture: null, date_echeance: null, total_ttc: null };

async function creerFacture(fichier, utilisateur) {
  return enTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO fac_factures (fichier_nom, fichier_chemin, fichier_mime, fichier_taille, empreinte)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fichier.nom, fichier.chemin, fichier.mime, fichier.taille, fichier.empreinte]
    );
    const id = rows[0].id;
    await insererEvenement(client, id, "depot", utilisateur, { details: { fichier: fichier.nom } });
    return id;
  });
}

async function obtenirFacture(id) {
  const { rows } = await pilote().query("SELECT * FROM fac_factures WHERE id=$1", [id]);
  return ligneVersFacture(rows[0]);
}

async function listerFactures(limite = 500) {
  const { rows } = await pilote().query("SELECT * FROM fac_factures ORDER BY id DESC LIMIT $1", [limite]);
  return rows.map(ligneVersFacture);
}

async function memeFichier(empreinte, saufId) {
  const { rows } = await pilote().query(
    "SELECT id FROM fac_factures WHERE empreinte=$1 AND id<>$2 ORDER BY id LIMIT 5", [empreinte, saufId]
  );
  return rows.map((r) => r.id);
}

function valeursColonnes(c) {
  const v = { ...COLONNES_VIDES, ...(c || {}) };
  return [v.siren, v.numero, v.fournisseur, v.iban, v.date_facture || null, v.date_echeance || null, v.total_ttc];
}

async function enregistrerExtraction(id, { etat, erreur = "", extraction = {}, donnees = null, colonnes = null }, utilisateur) {
  return enTransaction(async (client) => {
    if (donnees) {
      await client.query(
        `UPDATE fac_factures SET extraction_etat=$2, extraction_erreur=$3, extraction=$4::jsonb, donnees=$5::jsonb,
           siren=$6, numero=$7, fournisseur=$8, iban=$9, date_facture=$10, date_echeance=$11, total_ttc=$12, maj_le=now()
         WHERE id=$1 AND statut='a_valider'`,
        [id, etat, erreur, JSON.stringify(extraction), JSON.stringify(donnees), ...valeursColonnes(colonnes)]
      );
    } else {
      await client.query(
        `UPDATE fac_factures SET extraction_etat=$2, extraction_erreur=$3, extraction=$4::jsonb, maj_le=now() WHERE id=$1`,
        [id, etat, erreur, JSON.stringify(extraction)]
      );
    }
    await insererEvenement(client, id, "extraction", utilisateur, { vers: etat, details: { voie: extraction.voie || null, modele: extraction.modele || null, erreur: erreur || null } });
  });
}

async function relancerExtraction(id, utilisateur) {
  return enTransaction(async (client) => {
    const { rowCount } = await client.query(
      "UPDATE fac_factures SET extraction_etat='en_cours', extraction_erreur='', maj_le=now() WHERE id=$1 AND statut='a_valider' AND extraction_etat<>'en_cours'", [id]
    );
    if (rowCount) await insererEvenement(client, id, "extraction", utilisateur, { vers: "en_cours", details: { relance: true } });
    return rowCount > 0;
  });
}

async function modifierDonnees(id, donnees, colonnes, utilisateur, champs) {
  return enTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE fac_factures SET donnees=$2::jsonb, siren=$3, numero=$4, fournisseur=$5, iban=$6, date_facture=$7,
         date_echeance=$8, total_ttc=$9, maj_le=now() WHERE id=$1 AND statut='a_valider'`,
      [id, JSON.stringify(donnees), ...valeursColonnes(colonnes)]
    );
    if (rowCount) await insererEvenement(client, id, "modification", utilisateur, { details: { champs } });
    return rowCount > 0;
  });
}

async function changerStatut(id, de, vers, utilisateur, details = {}) {
  return enTransaction(async (client) => {
    const { rowCount } = await client.query(
      "UPDATE fac_factures SET statut=$3, maj_le=now() WHERE id=$1 AND statut=$2", [id, de, vers]
    );
    if (rowCount) await insererEvenement(client, id, "statut", utilisateur, { de, vers, details });
    return rowCount > 0;
  });
}

async function ajouterEvenement(id, type, utilisateur, options) {
  await insererEvenement(pilote(), id, type, utilisateur, options);
}

async function evenements(id) {
  const { rows } = await pilote().query(
    "SELECT id, type, de, vers, details, sub, email, le FROM fac_evenements WHERE facture_id=$1 ORDER BY le, id", [id]
  );
  return rows;
}

async function confirmationsIban(id) {
  const { rows } = await pilote().query(
    "SELECT details, sub, email, le FROM fac_evenements WHERE facture_id=$1 AND type='confirmation_iban' ORDER BY le DESC, id DESC", [id]
  );
  return rows;
}

async function doublons(id, siren, numero) {
  if (!siren || !numero) return [];
  const { rows } = await pilote().query(
    "SELECT id, statut, cree_le FROM fac_factures WHERE siren=$1 AND numero=$2 AND id<>$3 ORDER BY id", [siren, numero, id]
  );
  return rows;
}

// Dernière facture validée du même fournisseur, ordonnée par la date de sa validation.
async function derniereValidee(siren, saufId) {
  if (!siren) return null;
  const { rows } = await pilote().query(
    `SELECT f.id, f.numero, f.iban, v.le AS validee_le
       FROM fac_factures f
       JOIN LATERAL (SELECT max(e.le) AS le FROM fac_evenements e
                      WHERE e.facture_id=f.id AND e.type='statut' AND e.vers='validee') v ON true
      WHERE f.siren=$1 AND f.id<>$2 AND f.statut IN ('validee', 'payee')
      ORDER BY v.le DESC NULLS LAST, f.id DESC LIMIT 1`,
    [siren, saufId]
  );
  return rows[0] || null;
}

async function enregistrerVerifSociete(id, verif) {
  await pilote().query("UPDATE fac_factures SET verif_societe=$2::jsonb WHERE id=$1", [id, JSON.stringify(verif || {})]);
}

async function marquerExtractionsInterrompues() {
  const { rowCount } = await pilote().query(
    "UPDATE fac_factures SET extraction_etat='echec', extraction_erreur=$1, maj_le=now() WHERE extraction_etat='en_cours'",
    ["Extraction interrompue par un redémarrage du service : relancez-la."]
  );
  return rowCount;
}

async function facturesPourJournal({ du = null, au = null } = {}) {
  const { rows } = await pilote().query(
    `SELECT * FROM fac_factures WHERE statut IN ('validee', 'payee')
       AND ($1::date IS NULL OR date_facture >= $1::date) AND ($2::date IS NULL OR date_facture <= $2::date)
     ORDER BY date_facture NULLS LAST, id`,
    [du, au]
  );
  return rows.map(ligneVersFacture);
}

async function facturesAPayer() {
  const { rows } = await pilote().query(
    "SELECT * FROM fac_factures WHERE statut<>'payee' AND date_echeance IS NOT NULL ORDER BY date_echeance, id"
  );
  return rows.map(ligneVersFacture);
}

module.exports = {
  init, verifierConnexion,
  creerFacture, obtenirFacture, listerFactures, memeFichier,
  enregistrerExtraction, relancerExtraction, modifierDonnees, changerStatut,
  ajouterEvenement, evenements, confirmationsIban,
  doublons, derniereValidee, enregistrerVerifSociete, marquerExtractionsInterrompues,
  facturesPourJournal, facturesAPayer,
};
