/**
 * Stockage PostgreSQL — memes operations que celles que server.js executait
 * jusqu'a la PR B (issue #14) en ligne, en synchrone, via sql.js, mais
 * asynchrone : chaque fonction retourne une Promise. Depuis la PR B,
 * server.js est bascule dessus : c'est la base reellement utilisee (sql.js /
 * data/contrats.sqlite est retire).
 *
 * payload/donnees : voir lib/schema.sql, gardes en JSONB tels quels.
 *
 * Piege historique (corrige a la source dans la PR B, voir
 * lib/signatures.js::nouvelleDemande) : le champ `payload` d'une demande de
 * signature etait double-encode — JSON.stringify applique une fois dans
 * nouvelleDemande() PUIS une seconde fois quand l'objet demande entier est
 * serialise pour la colonne `donnees`. nouvelleDemande() ne stringifie plus
 * `payload` ; sauverDemande() ci-dessous garde neanmoins normaliserJson() en
 * garde-fou (ceinture-bretelles) pour les lignes de corbeille/demandes
 * anciennes deja doublement encodees (migrees depuis sql.js) qui pourraient
 * encore transiter par ici.
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

// Parse une valeur si elle est encore une chaine JSON (piege du double-encodage
// — voir en-tete du fichier) ; la laisse telle quelle si c'est deja un objet,
// et journalise sans jeter si la chaine n'est pas du JSON valide (pour ne pas
// perdre la donnee — elle est alors stockee telle quelle, sous forme de chaine).
function normaliserJson(valeur, contexte) {
  if (typeof valeur !== "string") return valeur == null ? {} : valeur;
  try {
    return JSON.parse(valeur);
  } catch (e) {
    console.error("[db.pg] valeur non-JSON inattendue (" + contexte + ") :", e.message);
    return valeur;
  }
}

function ligneVersContrat(r) {
  if (!r) return null;
  return {
    id: r.id,
    numero: r.numero,
    type: r.type,
    sousTraitant: r.sous_traitant,
    clientFinal: r.client_final,
    payload: r.payload,
    creeLe: r.cree_le,
    statut: r.statut || "",
    signe: r.signe || "",
  };
}

// ---------- Contrats ----------

async function sauverContrat({ numero, type, sousTraitant, clientFinal, payload }) {
  const { rows } = await pilote().query(
    `INSERT INTO contrats (numero, type, sous_traitant, client_final, payload, cree_le)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     RETURNING id`,
    [numero || "", type || "", sousTraitant || "", clientFinal || "", JSON.stringify(normaliserJson(payload, "contrats.payload"))]
  );
  return { id: rows[0].id };
}

async function mettreAJourContrat(id, { numero, type, sousTraitant, clientFinal, payload }) {
  const { rowCount } = await pilote().query(
    `UPDATE contrats SET numero=$1, type=$2, sous_traitant=$3, client_final=$4, payload=$5::jsonb WHERE id=$6`,
    [numero || "", type || "", sousTraitant || "", clientFinal || "", JSON.stringify(normaliserJson(payload, "contrats.payload")), id]
  );
  return rowCount > 0;
}

// Utilise par la creation de demande de signature pour savoir si le contrat
// courant a deja une ligne d'historique (meme logique qu'aujourd'hui : numero
// + sous-traitant identiques => deja enregistre).
async function contratExiste(numero, sousTraitant) {
  const { rows } = await pilote().query(
    "SELECT 1 FROM contrats WHERE numero=$1 AND sous_traitant=$2 LIMIT 1",
    [numero, sousTraitant]
  );
  return rows.length > 0;
}

async function listerContrats(limite = 200) {
  const { rows } = await pilote().query(
    `SELECT id, numero, type, sous_traitant, client_final, payload, cree_le, statut, signe
     FROM contrats ORDER BY id DESC LIMIT $1`,
    [limite]
  );
  return rows.map(ligneVersContrat);
}

async function obtenirContrat(id) {
  const { rows } = await pilote().query("SELECT * FROM contrats WHERE id=$1", [id]);
  return ligneVersContrat(rows[0]);
}

async function marquerSigne(id, date) {
  const { rowCount } = await pilote().query("UPDATE contrats SET signe=$1 WHERE id=$2", [date, id]);
  return rowCount > 0;
}

async function retirerSigne(id) {
  await pilote().query("UPDATE contrats SET signe='' WHERE id=$1", [id]);
}

async function definirStatutContrat(id, statut) {
  await pilote().query("UPDATE contrats SET statut=$1 WHERE id=$2", [statut === "clos" ? "clos" : "", id]);
}

async function importerContrat({ numero, type, sousTraitant, clientFinal, payload, signe }) {
  const { rows } = await pilote().query(
    `INSERT INTO contrats (numero, type, sous_traitant, client_final, payload, cree_le, statut, signe)
     VALUES ($1, $2, $3, $4, $5::jsonb, now(), '', $6)
     RETURNING id`,
    [numero || "", type || "", sousTraitant || "", clientFinal || "", JSON.stringify(normaliserJson(payload, "contrats.payload")), signe || ""]
  );
  return { id: rows[0].id };
}

// Suppression groupee : bascule chaque ligne dans la corbeille (type "contrat")
// AVANT de la supprimer, dans une transaction (tout ou rien, comme le
// comportement synchrone actuel qui suit un seul export()/persist()).
async function supprimerContrats(ids) {
  const client = await pilote().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT numero, type, sous_traitant, client_final, payload, cree_le, statut, signe
       FROM contrats WHERE id = ANY($1::int[])`,
      [ids]
    );
    for (const r of rows) {
      await client.query(
        `INSERT INTO corbeille (type, donnees, supprime_le) VALUES ('contrat', $1::jsonb, now())`,
        [JSON.stringify({
          numero: r.numero, type: r.type, sous_traitant: r.sous_traitant, client_final: r.client_final,
          payload: r.payload, cree_le: r.cree_le, statut: r.statut || "", signe: r.signe || "",
        })]
      );
    }
    await client.query("DELETE FROM contrats WHERE id = ANY($1::int[])", [ids]);
    await client.query("COMMIT");
    return { supprimes: rows.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Signatures ----------

function ligneVersDemande(r) {
  if (!r) return null;
  const d = r.donnees || {};
  d.id = r.id;
  return d;
}

async function chargerDemande(id) {
  const { rows } = await pilote().query("SELECT id, donnees FROM signatures WHERE id=$1", [id]);
  return ligneVersDemande(rows[0]);
}

// `limite` : comme listerContrats() ci-dessus — sans borne, cette requête
// ramène le JSONB complet de CHAQUE demande de signature jamais créée à
// chaque appel (issue #146 : mesuré 8000 demandes ≈ 23 Mo / ~600 ms par
// appel, contre ~0,5 Mo / ~30 ms avec LIMIT 200). GET /api/signatures — appelé à
// CHAQUE chargement de page (public/app.js::init) — passe cette limite ; le
// webhook (recherche par externe.id sur tout l'historique) reste sans borne
// pour ne pas perdre une demande ancienne encore en cours de signature.
// Dans les deux cas, `payload` (valeurs/options du contrat, jamais relu ici)
// est retiré du JSONB transféré : il représente ~la moitié du volume par
// ligne et aucun des deux appelants ne s'en sert (chargerDemande(id) le
// renvoie toujours en entier pour la régénération de PDF/certificat).
async function chargerDemandes(limite) {
  const { rows } = await pilote().query(
    limite
      ? "SELECT id, donnees - 'payload' AS donnees FROM signatures ORDER BY id DESC LIMIT $1"
      : "SELECT id, donnees - 'payload' AS donnees FROM signatures ORDER BY id DESC",
    limite ? [limite] : []
  );
  return rows.map(ligneVersDemande);
}

// ATTENTION : un objet renvoye par chargerDemandes() (ci-dessus) n'a plus de
// `payload` (retire cote requete) — ne jamais le repasser tel quel a
// sauverDemande(), qui l'ecrirait comme absent/undefined et effacerait le
// payload du contrat en base. Les deux appelants actuels de chargerDemandes()
// sont en lecture seule ; releger via chargerDemande(id) (singulier, complet)
// avant toute ecriture.
async function sauverDemande(d) {
  // Garde-fou (voir en-tete du fichier) : payload doit etre un objet avant
  // d'ecrire en JSONB, jamais une chaine de JSON. nouvelleDemande() ne
  // stringifie plus payload depuis la PR B ; normaliserJson() couvre encore
  // les objets deja doublement encodes qui viendraient d'ailleurs (donnee
  // restauree depuis la corbeille, ligne migree depuis sql.js).
  const donnees = Object.assign({}, d, {
    id: undefined,
    payload: normaliserJson(d.payload, "signatures.donnees.payload"),
  });
  if (d.id) {
    await pilote().query("UPDATE signatures SET donnees=$1::jsonb WHERE id=$2", [JSON.stringify(donnees), d.id]);
    return d;
  }
  const { rows } = await pilote().query(
    "INSERT INTO signatures (donnees) VALUES ($1::jsonb) RETURNING id",
    [JSON.stringify(donnees)]
  );
  d.id = rows[0].id;
  // Recopie l'id dans le JSON (reference SIG-<id> stable dans le certificat).
  await pilote().query("UPDATE signatures SET donnees=$1::jsonb WHERE id=$2",
    [JSON.stringify(Object.assign({}, donnees, { id: undefined })), d.id]);
  return d;
}

// Retire une demande du suivi et la depose en corbeille (type "signature"),
// dans une transaction — meme comportement que la route DELETE actuelle.
async function supprimerDemande(id) {
  const client = await pilote().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT donnees FROM signatures WHERE id=$1", [id]);
    if (rows[0]) {
      const donnees = Object.assign({}, rows[0].donnees, { id: undefined });
      await client.query(
        "INSERT INTO corbeille (type, donnees, supprime_le) VALUES ('signature', $1::jsonb, now())",
        [JSON.stringify(donnees)]
      );
    }
    await client.query("DELETE FROM signatures WHERE id=$1", [id]);
    await client.query("COMMIT");
    return { ok: true, trouve: !!rows[0] };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Corbeille ----------

async function listerCorbeille() {
  const { rows } = await pilote().query(
    "SELECT id, type, donnees, supprime_le FROM corbeille ORDER BY id DESC"
  );
  return rows.map((r) => ({ id: r.id, type: r.type, donnees: r.donnees, supprimeLe: r.supprime_le }));
}

// Restaure la selection : chaque element retrouve sa table d'origine, dans
// une transaction (tout ou rien).
async function restaurerCorbeille(ids) {
  const client = await pilote().connect();
  try {
    await client.query("BEGIN");
    let restaures = 0;
    for (const id of ids) {
      const { rows } = await client.query("SELECT type, donnees FROM corbeille WHERE id=$1", [id]);
      if (!rows[0]) continue;
      const { type, donnees: d } = rows[0];
      if (type === "contrat") {
        await client.query(
          `INSERT INTO contrats (numero, type, sous_traitant, client_final, payload, cree_le, statut, signe)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [d.numero, d.type, d.sous_traitant, d.client_final, JSON.stringify(d.payload || {}), d.cree_le, d.statut || "", d.signe || ""]
        );
      } else if (type === "signature") {
        await client.query(
          "INSERT INTO signatures (donnees) VALUES ($1::jsonb)",
          [JSON.stringify(Object.assign({}, d, { id: undefined }))]
        );
      }
      await client.query("DELETE FROM corbeille WHERE id=$1", [id]);
      restaures++;
    }
    await client.query("COMMIT");
    return { restaures };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function purgerCorbeille(ids) {
  const { rowCount } = await pilote().query("DELETE FROM corbeille WHERE id = ANY($1::int[])", [ids]);
  return { purges: rowCount };
}

// ---------- Personnalisation des modeles (templates-perso) ----------
// Remplace l'ancien data/templates-perso.json (etat mutable propre a
// l'instance — contrairement a data/referentiels.json, qui reste un fichier
// suivi par git et NE migre PAS ici, voir issue #14). Depuis la PR B,
// lib/templates-perso.js met ces lignes en cache memoire au demarrage (voir
// templatesPerso.init()) : effectifs() reste synchrone, seuls sauver()/
// reinitialiser() (rares, actions admin) passent par ici.

async function chargerTemplatesPerso() {
  const { rows } = await pilote().query("SELECT type, donnees FROM templates_perso");
  const out = {};
  rows.forEach((r) => { out[r.type] = r.donnees; });
  return out;
}

async function sauverTemplatesPerso(type, entree) {
  const vide = !entree || (!Object.keys(entree.meta || {}).length && !(entree.blocs || []).length);
  if (vide) {
    await pilote().query("DELETE FROM templates_perso WHERE type=$1", [type]);
    return;
  }
  await pilote().query(
    `INSERT INTO templates_perso (type, donnees) VALUES ($1, $2::jsonb)
     ON CONFLICT (type) DO UPDATE SET donnees = EXCLUDED.donnees`,
    [type, JSON.stringify(entree)]
  );
}

async function reinitialiserTemplatesPerso(type) {
  await pilote().query("DELETE FROM templates_perso WHERE type=$1", [type]);
}

module.exports = {
  init,
  verifierConnexion,
  // contrats
  sauverContrat, mettreAJourContrat, contratExiste, listerContrats, obtenirContrat,
  marquerSigne, retirerSigne, definirStatutContrat, importerContrat, supprimerContrats,
  // signatures
  chargerDemande, chargerDemandes, sauverDemande, supprimerDemande,
  // corbeille
  listerCorbeille, restaurerCorbeille, purgerCorbeille,
  // templates-perso
  chargerTemplatesPerso, sauverTemplatesPerso, reinitialiserTemplatesPerso,
};
