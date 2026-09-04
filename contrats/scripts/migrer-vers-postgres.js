#!/usr/bin/env node
/**
 * Migration ponctuelle data/contrats.sqlite (+ data/templates-perso.json)
 * -> PostgreSQL (issue #14, PR A).
 *
 * Ne touche PAS aux fichiers source (lecture seule) : peut etre relance sans
 * risque — chaque ligne est ecrite avec son id d'origine et un
 * `ON CONFLICT (id) DO UPDATE`, ce qui rend le script idempotent (on ne
 * duplique jamais une ligne deja migree). Les sequences SERIAL sont
 * resynchronisees a la fin pour que les prochains INSERT (sans id explicite,
 * via lib/db.pg.js) repartent au-dessus du dernier id migre.
 *
 * NE MIGRE PAS data/referentiels.json : c'est une donnee de reference suivie
 * par git (distribuee par commit, pas par instance) — voir issue #14, tranche
 * explicitement dans la PR. NE MIGRE PAS secrets.json / code-parametres.txt :
 * deja remplaces par des variables d'environnement (milestone 1).
 *
 * Piege connu : signatures.donnees.payload (et corbeille.donnees.payload pour
 * les entrees "contrat"/"signature") sont doublement encodes en JSON dans
 * sql.js — voir lib/db.pg.js pour le detail. Ce script corrige l'encodage au
 * passage (un seul JSON.parse de la couche interne) et journalise toute ligne
 * ou ce parse echoue au lieu de perdre silencieusement la donnee.
 *
 * Usage :
 *   DATABASE_URL=postgresql://... node scripts/migrer-vers-postgres.js
 *
 * Variables d'environnement de test (ne changent PAS le comportement en
 * production, defaut = vrais chemins data/) :
 *   CONTRATS_SQLITE_PATH   chemin alternatif vers le .sqlite source
 *   TEMPLATES_PERSO_PATH   chemin alternatif vers templates-perso.json
 */

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const { Pool } = require("pg");
const pg = require("../lib/db.pg.js");

const SQLITE_PATH = process.env.CONTRATS_SQLITE_PATH || path.join(__dirname, "..", "data", "contrats.sqlite");
const TEMPLATES_PERSO_PATH = process.env.TEMPLATES_PERSO_PATH || path.join(__dirname, "..", "data", "templates-perso.json");

let anomalies = 0;

// Parse une valeur si c'est encore une chaine JSON (double-encodage) ; la
// laisse telle quelle si c'est deja un objet/array/scalaire ; journalise et
// conserve la chaine brute (sans jeter) si le parse echoue.
function normaliserJson(valeur, contexte) {
  if (typeof valeur !== "string") return valeur == null ? {} : valeur;
  try {
    return JSON.parse(valeur);
  } catch (e) {
    anomalies++;
    console.error(`[migration] ANOMALIE — ${contexte} n'est pas du JSON valide (conserve tel quel) : ${e.message}`);
    return valeur;
  }
}

function ouvrirSqlite(SQL) {
  if (!fs.existsSync(SQLITE_PATH)) return null;
  return new SQL.Database(fs.readFileSync(SQLITE_PATH));
}

function toutesLesLignes(db, sql) {
  const out = [];
  const r = db.exec(sql);
  if (!r[0]) return out;
  const cols = r[0].columns;
  r[0].values.forEach((row) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    out.push(o);
  });
  return out;
}

async function migrerContrats(client, db) {
  let lignes = [];
  try {
    lignes = toutesLesLignes(db, "SELECT id,numero,type,sous_traitant,client_final,payload,cree_le,statut,signe FROM contrats");
  } catch (e) {
    console.log("[migration] table contrats absente de la source (rien a migrer).");
    return 0;
  }
  for (const r of lignes) {
    const payload = normaliserJson(r.payload, `contrats.payload (id=${r.id})`);
    if (!r.cree_le) {
      anomalies++;
      console.error(`[migration] ANOMALIE — contrats.cree_le vide (id=${r.id}), horodatage de migration utilise a la place.`);
    }
    await client.query(
      `INSERT INTO contrats (id, numero, type, sous_traitant, client_final, payload, cree_le, statut, signe)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         numero=EXCLUDED.numero, type=EXCLUDED.type, sous_traitant=EXCLUDED.sous_traitant,
         client_final=EXCLUDED.client_final, payload=EXCLUDED.payload, cree_le=EXCLUDED.cree_le,
         statut=EXCLUDED.statut, signe=EXCLUDED.signe`,
      [r.id, r.numero, r.type, r.sous_traitant, r.client_final, JSON.stringify(payload),
       r.cree_le || new Date().toISOString(), r.statut || "", r.signe || ""]
    );
  }
  return lignes.length;
}

async function migrerSignatures(client, db) {
  let lignes = [];
  try {
    lignes = toutesLesLignes(db, "SELECT id,donnees FROM signatures");
  } catch (e) {
    console.log("[migration] table signatures absente de la source (rien a migrer).");
    return 0;
  }
  for (const r of lignes) {
    const d = normaliserJson(r.donnees, `signatures.donnees (id=${r.id})`);
    if (d && typeof d === "object") {
      // Piege du double-encodage : payload a ete JSON.stringify une 2e fois
      // par lib/signatures.js (nouvelleDemande) avant meme d'atteindre ici.
      d.payload = normaliserJson(d.payload, `signatures.donnees.payload (id=${r.id})`);
    }
    await client.query(
      `INSERT INTO signatures (id, donnees) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET donnees=EXCLUDED.donnees`,
      [r.id, JSON.stringify(d)]
    );
  }
  return lignes.length;
}

async function migrerCorbeille(client, db) {
  let lignes = [];
  try {
    lignes = toutesLesLignes(db, "SELECT id,type,donnees,supprime_le FROM corbeille");
  } catch (e) {
    console.log("[migration] table corbeille absente de la source (rien a migrer).");
    return 0;
  }
  for (const r of lignes) {
    const d = normaliserJson(r.donnees, `corbeille.donnees (id=${r.id})`);
    // Les deux types deposent un `payload` imbrique en chaine JSON (repris
    // tel quel de contrats.payload / signatures.donnees.payload) — meme
    // correctif que ci-dessus, pour ne pas perpetuer le double-encodage.
    if (d && typeof d === "object" && "payload" in d) {
      d.payload = normaliserJson(d.payload, `corbeille.donnees.payload (id=${r.id}, type=${r.type})`);
    }
    if (!r.supprime_le) {
      anomalies++;
      console.error(`[migration] ANOMALIE — corbeille.supprime_le vide (id=${r.id}), horodatage de migration utilise a la place.`);
    }
    await client.query(
      `INSERT INTO corbeille (id, type, donnees, supprime_le) VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, donnees=EXCLUDED.donnees, supprime_le=EXCLUDED.supprime_le`,
      [r.id, r.type, JSON.stringify(d), r.supprime_le || new Date().toISOString()]
    );
  }
  return lignes.length;
}

async function migrerTemplatesPerso(client) {
  if (!fs.existsSync(TEMPLATES_PERSO_PATH)) {
    console.log("[migration] templates-perso.json absent (rien a migrer — aucune personnalisation enregistree).");
    return 0;
  }
  let perso;
  try {
    perso = JSON.parse(fs.readFileSync(TEMPLATES_PERSO_PATH, "utf8"));
  } catch (e) {
    console.error(`[migration] ANOMALIE — templates-perso.json illisible, ignore : ${e.message}`);
    anomalies++;
    return 0;
  }
  const types = Object.keys(perso || {});
  for (const type of types) {
    await client.query(
      `INSERT INTO templates_perso (type, donnees) VALUES ($1, $2::jsonb)
       ON CONFLICT (type) DO UPDATE SET donnees=EXCLUDED.donnees`,
      [type, JSON.stringify(perso[type])]
    );
  }
  return types.length;
}

// Resynchronise une sequence SERIAL sur MAX(id) apres des INSERT a id explicite
// (is_called=false quand la table est vide, pour que le tout premier INSERT
// sans id explicite reparte bien a 1, pas a 2).
async function resynchroniserSequence(client, table) {
  await client.query(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS(SELECT 1 FROM ${table}))`
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL manquante — voir .env.example");
    process.exit(1);
  }

  console.log("[migration] contrats/referentiels.json NON migre (donnee de reference suivie par git — voir issue #14).");
  console.log("[migration] secrets.json / code-parametres.txt NON migres (deja remplaces par des variables d'environnement).");

  const SQL = await initSqlJs();
  const sqliteDb = ouvrirSqlite(SQL);
  if (!sqliteDb) {
    console.log(`[migration] ${SQLITE_PATH} introuvable — instance vierge (greenfield), rien a migrer depuis sql.js.`);
  }

  await pg.init(); // applique lib/schema.sql (CREATE TABLE IF NOT EXISTS)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nContrats = sqliteDb ? await migrerContrats(client, sqliteDb) : 0;
    const nSignatures = sqliteDb ? await migrerSignatures(client, sqliteDb) : 0;
    const nCorbeille = sqliteDb ? await migrerCorbeille(client, sqliteDb) : 0;
    const nTemplatesPerso = await migrerTemplatesPerso(client);
    await resynchroniserSequence(client, "contrats");
    await resynchroniserSequence(client, "signatures");
    await resynchroniserSequence(client, "corbeille");
    await client.query("COMMIT");

    console.log(`[migration] contrats : ${nContrats} ligne(s) migree(s)`);
    console.log(`[migration] signatures : ${nSignatures} ligne(s) migree(s)`);
    console.log(`[migration] corbeille : ${nCorbeille} ligne(s) migree(s)`);
    console.log(`[migration] templates_perso : ${nTemplatesPerso} type(s) migre(s)`);

    // Verification : le compte cote PostgreSQL doit correspondre a la source
    // (>= car ON CONFLICT DO UPDATE peut cohabiter avec des lignes deja
    // presentes d'un run precedent — un re-run n'en ajoute jamais).
    const compte = async (table) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
    const [cContrats, cSignatures, cCorbeille, cTemplatesPerso] = await Promise.all([
      compte("contrats"), compte("signatures"), compte("corbeille"), compte("templates_perso"),
    ]);
    console.log(`[migration] verification — contrats en base : ${cContrats}, signatures : ${cSignatures}, corbeille : ${cCorbeille}, templates_perso : ${cTemplatesPerso}`);

    if (cContrats < nContrats || cSignatures < nSignatures || cCorbeille < nCorbeille || cTemplatesPerso < nTemplatesPerso) {
      console.error("[migration] ECART : moins de lignes en base que de lignes source migrees — ne pas basculer server.js dessus.");
      process.exit(1);
    }

    if (anomalies > 0) {
      console.warn(`[migration] TERMINE avec ${anomalies} anomalie(s) journalisee(s) ci-dessus (donnees conservees telles quelles, a verifier manuellement).`);
    } else {
      console.log("[migration] OK — aucune anomalie de parsing JSON detectee.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[migration] echec :", e);
  process.exit(1);
});
