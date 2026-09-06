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
    // Sans ce filet, une erreur sur un client IDLE du pool (connexion
    // coupee pendant que rien ne l'utilise — Postgres injoignable puis
    // relance pendant que le pool garde des clients au repos) remonte comme
    // un evenement 'error' non gere sur le pool et fait planter tout le
    // process Node (voir doc node-postgres, section Pool). Le pool retire
    // lui-meme le client fautif ; logger suffit.
    pool.on("error", (err) => {
      console.error("[db.pg] erreur sur une connexion inactive du pool :", err.message);
    });
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

// Timeout applique a la connexion et a la requete de verification — evite
// qu'un Postgres joignable au TCP mais qui ne repond jamais (ex. conteneur
// en pause) ne fasse pendre le HEALTHCHECK Docker au-dela de son propre
// --timeout (voir Dockerfile).
const TIMEOUT_VERIF_MS = 3000;

function avecTimeout(promesse, ms, etape) {
  return new Promise((resolve, reject) => {
    const minuteur = setTimeout(
      () => reject(new Error(`Postgres ne repond pas (timeout ${etape})`)),
      ms
    );
    promesse.then(
      (v) => { clearTimeout(minuteur); resolve(v); },
      (e) => { clearTimeout(minuteur); reject(e); }
    );
  });
}

/**
 * Verifie que PostgreSQL repond reellement — pas seulement que le process
 * Node est vivant. Utilisee par la route /api/sante que le HEALTHCHECK
 * Docker interroge (voir server.js et Dockerfile) : sans elle, un Postgres
 * injoignable (partition reseau, conteneur OOM-killed puis en redemarrage)
 * laissait le HEALTHCHECK toujours vert tant que le process Express restait
 * vivant, alors que chaque requete touchant la base echouait deja.
 *
 * Client emprunte au pool applicatif (pas de pool separe) mais toujours
 * rendu ou detruit avant de retourner — jamais laisse en circulation.
 * Sur echec de la requete, le client est detruit via release(err) plutot
 * que rendu au pool (une requete encore en vol ne doit jamais y revenir).
 * Sur timeout de la CONNEXION elle-meme, la promesse de connexion sous-
 * jacente reste vivante (rien ne peut interrompre pg au milieu d'un
 * connect()) : si elle finit par aboutir apres coup (Postgres qui revient
 * pendant la fenetre de timeout), le client obtenu est immediatement
 * detruit au lieu de rester emprunte au pool pour toujours — sinon, une
 * panne Postgres assez longue epuise `pool.max` clients un par cycle de
 * HEALTHCHECK (30s) et /api/sante reste indisponible meme apres le retour
 * de Postgres.
 */
async function verifierConnexion() {
  const connexion = pilote().connect();
  let client;
  try {
    client = await avecTimeout(connexion, TIMEOUT_VERIF_MS, "connexion");
  } catch (e) {
    connexion.then(
      (c) => c.release(new Error("client arrive apres le timeout de connexion")),
      () => {}
    );
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

// Le resume affiche par l'historique (trigramme/missions/anciennete) ne
// depend que de 3 valeurs scalaires de `master`, jamais du cv_master entier —
// ces valeurs sont donc extraites ICI, en SQL, plutot que de faire remonter
// la colonne `master` (JSONB, jusqu'a CV_MAX_EXPERIENCES * CV_MAX_HIGHLIGHTS_
// PAR_EXPERIENCE de contenu, voir issue #96) jusqu'a Node pour n'en garder que
// ces 3 champs. Sans ca, list()/search() (route GET /api/cvs, appelee a
// CHAQUE frappe dans la recherche de l'historique, cote client — voir
// public/app.js#chargerHistorique, debounce 250 ms) transferaient et
// deserialisaient le cv_master COMPLET de CHAQUE fiche de la CVtheque, a
// chaque appel : mesure, avec 2000 fiches a une taille realiste (~50 Ko de
// master chacune, cf. cap #96), ce SELECT * passe de ~90 ms (100 fiches) a
// 2,2-3,7 s (2000 fiches) — un cout qui grandit avec le NOMBRE de CV, pas
// leur taille individuelle (deja plafonnee), et qui degrade la recherche
// pour tout le monde a mesure que la CVtheque grandit.
const RESUME_SELECT = `
  id, nom, titre, fichier, cree_le, maj_le,
  COALESCE(master #>> '{identity,trigram}', '') AS trigramme,
  CASE WHEN jsonb_typeof(master->'experiences') = 'array'
       THEN jsonb_array_length(master->'experiences') ELSE 0 END AS missions,
  COALESCE(NULLIF(master #> '{identity,seniority_years}', 'null'::jsonb), '0'::jsonb) AS anciennete
`;

async function list() {
  const { rows } = await pilote().query(`SELECT ${RESUME_SELECT} FROM cvs ORDER BY maj_le DESC`);
  return rows;
}

async function remove(id) {
  await pilote().query("DELETE FROM cvs WHERE id = $1", [id]);
}

/**
 * Recherche plein texte simple sur le contenu structuré (même comportement
 * que lib/db.js) : substring arbitraire sur tout le cv_master (nom, techno,
 * client — voir placeholder du champ de recherche cote client dans
 * public/index.html), pas seulement nom/titre.
 *
 * Le LIKE '%...%' ne peut pas utiliser un index B-tree classique. Sans
 * index dedie, cette requete castait le JSONB entier de chaque fiche en
 * texte a chaque appel — scan sequentiel complet, ~2-3 s sur 2000 fiches
 * quel que soit le terme (voir issue #106), appele a CHAQUE frappe cote
 * client (debounce 250 ms, public/app.js#chargerHistorique).
 *
 * lib/schema.sql cree un index GIN trigram (pg_trgm) sur LOWER(master::text)
 * pour cette requete precise : l'expression ci-dessous doit rester
 * IDENTIQUE a celle de l'index (LOWER(master::text)) pour que le
 * planificateur Postgres puisse s'en servir — ne pas "simplifier" en ILIKE
 * ou changer la casse sans mettre a jour schema.sql en meme temps.
 */
async function search(q) {
  const needle = String(q || "").trim();
  if (!needle) return list();
  // Sous la barre des 3 caracteres, le pattern LIKE '%x%' ou '%xy%' ne
  // contient aucun trigramme complet : l'index GIN ci-dessus (base sur des
  // trigrammes de 3 caracteres) ne peut pas le discriminer et Postgres doit
  // rechecker la quasi-totalite des lignes candidates malgre l'index (voir
  // issue #106, mesure : ~2.9 s a 2000 fiches, identique a avant l'index).
  // Une lettre ou paire de lettres courante dans du texte francais (nom,
  // titre, mission) matche de toute facon une grande partie de la CVtheque
  // meme sans ce garde-fou — seules les combinaisons rares changent de
  // resultat ici (liste complete au lieu du sous-ensemble filtre), et le
  // trigram ne les aurait de toute facon pas rendues rapides. Changement de
  // semantique assume : voir le corps de la PR (issue #106) pour la
  // discussion et comment le retirer si ce compromis n'est pas souhaite.
  if (needle.length < 3) return list();
  // Le planificateur Postgres estime le cout de LOWER(master::text) LIKE ...
  // comme un operateur quasi gratuit (cpu_operator_cost par defaut), sans
  // tenir compte du cout reel d'un detoast + cast + comparaison sur un JSONB
  // de plusieurs dizaines de Ko par ligne (voir issue #106). Meme avec
  // l'index GIN trigram cree par lib/schema.sql, il continue donc de choisir
  // un Seq Scan par defaut — mesure (EXPLAIN ANALYZE, 2000 fiches) : Seq
  // Scan ~2.5-3.1 s contre Bitmap Heap Scan (via l'index) ~0.4 s pour un
  // terme selectif et ~1 ms pour un terme absent. PostgreSQL n'offrant pas
  // de hint de requete, la facon usuelle de corriger une sous-estimation de
  // cout connue et locale a une requete est de desactiver le plan fautif —
  // ici uniquement pour la duree de cette transaction (SET LOCAL), donc sans
  // effet sur les autres requetes qui partagent le pool de connexions.
  const client = await pilote().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const { rows } = await client.query(
      `SELECT ${RESUME_SELECT} FROM cvs
       WHERE LOWER(master::text) LIKE '%' || LOWER($1) || '%'
       ORDER BY maj_le DESC`,
      [needle]
    );
    await client.query("COMMIT");
    return rows;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { init, verifierConnexion, save, get, list, remove, search, findByHash };
