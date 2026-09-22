"use strict";

/**
 * Tests de lib/taches-extraction.js — gestionnaire de taches d'extraction (#196).
 *
 * Aucun HTTP, aucun DocIE, aucune attente reelle : les travaux sont des
 * promesses dont le test tient les resolveurs, et l'horloge est injectee.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  creerGestionnaire, mapperErreur, FileTachesPleineError,
  MESSAGES_BRIDGE, MESSAGES_SERVICE, MESSAGE_INTERNE, maxSimultaneesDepuisEnv,
  MAX_SIMULTANEES_DEFAUT, MAX_EN_ATTENTE, TTL_MS,
} = require("../lib/taches-extraction");
const { extractContractValues } = require("../lib/docie-contract-import");

const BRIDGE_JS = path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js");
const { DocIEBridgeError } = require(BRIDGE_JS);

/** Promesse dont le test decide l'issue. */
function differe() {
  let resoudre, rejeter;
  const promesse = new Promise((ok, ko) => { resoudre = ok; rejeter = ko; });
  return { promesse, resoudre, rejeter };
}

/** Laisse s'ecouler les microtaches et un tour de boucle. */
const vider = () => new Promise((ok) => setImmediate(ok));

/** Vraie DocIEBridgeError (classe du bridge), sans appel reseau. */
const erreurBridge = (code, message, eta = null) => new DocIEBridgeError(code, message, null, eta);

// Codes releves dans le bridge lui-meme : fail("…") et la table des statuts HTTP.
function codesDuBridge() {
  const source = fs.readFileSync(BRIDGE_JS, "utf8");
  const codes = new Set();
  for (const m of source.matchAll(/fail\("([a-z_]+)"/g)) codes.add(m[1]);
  for (const m of source.matchAll(/\b\d{3}: "([a-z_]+)"/g)) codes.add(m[1]);
  return [...codes].sort();
}

const silencieux = { journal: () => {} };
// Les tests d'ordonnancement ci-dessous raisonnent sur deux creneaux, plafond
// explicite : le defaut du module (1, NuExtract3) est teste a part.
const deuxCreneaux = { ...silencieux, maxSimultanees: 2 };

test("valeurs par defaut annoncees : 1 simultanee (NuExtract3, n_parallel 1), 20 en attente, 30 min", () => {
  assert.equal(MAX_SIMULTANEES_DEFAUT, 1);
  assert.equal(MAX_EN_ATTENTE, 20);
  assert.equal(TTL_MS, 30 * 60 * 1000);
});

// ── Plafond configurable : ADBI_EXTRACTION_MAX_CONCURRENT ─────────────────

const VAR = "ADBI_EXTRACTION_MAX_CONCURRENT";

test("plafond depuis l'env : absente, vide ou blanche -> 1 (NuExtract3, n_parallel 1)", () => {
  assert.equal(maxSimultaneesDepuisEnv({}), 1);
  assert.equal(maxSimultaneesDepuisEnv({ [VAR]: "" }), 1);
  assert.equal(maxSimultaneesDepuisEnv({ [VAR]: "   " }), 1);
});

test("plafond depuis l'env : un entier entre 1 et 16 est repris tel quel", () => {
  assert.equal(maxSimultaneesDepuisEnv({ [VAR]: "2" }), 2);
  assert.equal(maxSimultaneesDepuisEnv({ [VAR]: " 3 " }), 3);
  assert.equal(maxSimultaneesDepuisEnv({ [VAR]: "16" }), 16);
});

test("plafond depuis l'env : toute autre valeur leve une erreur nommant la variable et la valeur", () => {
  for (const mauvais of ["0", "-1", "deux", "2.5", "1e1", "0x2", "+3", "17", "20"]) {
    assert.throws(() => maxSimultaneesDepuisEnv({ [VAR]: mauvais }),
      (e) => e.message.includes(VAR) && e.message.includes(JSON.stringify(mauvais)), mauvais);
  }
});

/** 5 taches sur un gestionnaire plafonne a n : jamais plus de n actives. */
async function verifierPlafond(options, n) {
  const g = creerGestionnaire({ ...silencieux, ...options });
  const differes = [];
  let actives = 0, pic = 0;
  for (let i = 0; i < 5; i++) {
    const d = differe();
    differes.push(d);
    g.creer(async () => {
      actives++; pic = Math.max(pic, actives);
      try { return await d.promesse; } finally { actives--; }
    });
  }
  await vider();
  assert.equal(actives, n);
  assert.deepEqual(g.statistiques(), { enCours: n, enAttente: 5 - n, conservees: 5 });
  for (const d of differes) {
    d.resoudre("ok");
    await vider();
    assert.ok(actives <= n, `actives=${actives}`);
  }
  await vider();
  assert.equal(pic, n);
  assert.equal(g.statistiques().enCours, 0);
}

test("sans plafond explicite, le gestionnaire n'extrait qu'un contrat a la fois", async () => {
  await verifierPlafond({}, 1);
});

test("le plafond lu dans l'env est celui que le gestionnaire applique (2, puis 3)", async () => {
  await verifierPlafond({ maxSimultanees: maxSimultaneesDepuisEnv({ [VAR]: "2" }) }, 2);
  await verifierPlafond({ maxSimultanees: maxSimultaneesDepuisEnv({ [VAR]: "3" }) }, 3);
});

/**
 * Lance server.js avec un environnement donne et rend { code, sortie } : a la
 * fin du processus, ou des que `attendu` apparait (le processus est alors tue).
 * La base pointe sur un port ferme de la boucle locale : aucun reseau.
 */
function lancerServeur(env, attendu) {
  return new Promise((ok, ko) => {
    const enfant = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x",
        DOCIE_EXTRACTION_ENABLED: "false",
        PORT: "0",
        ...env,
      },
    });
    let sortie = "";
    const minuteur = setTimeout(() => { enfant.kill(); ko(new Error("delai depasse :\n" + sortie)); }, 20000);
    const lire = (morceau) => {
      sortie += morceau;
      if (attendu && sortie.includes(attendu)) enfant.kill();
    };
    enfant.stdout.on("data", lire);
    enfant.stderr.on("data", lire);
    enfant.on("exit", (code) => { clearTimeout(minuteur); ok({ code, sortie }); });
  });
}

test("demarrage : server.js s'arrete (code 1) sur une valeur invalide, avant la base", async () => {
  const { code, sortie } = await lancerServeur({ [VAR]: "0" });
  assert.equal(code, 1);
  assert.match(sortie, /ADBI_EXTRACTION_MAX_CONCURRENT doit être un entier entre 1 et 16 \(reçu : "0"\)/);
  assert.doesNotMatch(sortie, /Erreur init DB/);
});

test("demarrage : server.js lit la valeur de l'env (2) et, absente, annonce le defaut (1)", async () => {
  const avec = await lancerServeur({ [VAR]: "2" }, "simultanée(s)");
  assert.match(avec.sortie, /\[taches\] 2 extraction\(s\) simultanée\(s\)/);
  const sans = await lancerServeur({ [VAR]: "" }, "simultanée(s)");
  assert.match(sans.sortie, /\[taches\] 1 extraction\(s\) simultanée\(s\)/);
});

test("5 taches simultanees : jamais plus de 2 extractions a la fois, les autres attendent avec leur position", async () => {
  const g = creerGestionnaire(deuxCreneaux);
  const differes = [];
  let actives = 0, pic = 0;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const d = differe();
    differes.push(d);
    ids.push(g.creer(async () => {
      actives++; pic = Math.max(pic, actives);
      try { return await d.promesse; } finally { actives--; }
    }));
  }
  await vider();
  assert.equal(actives, 2);
  assert.deepEqual(g.statistiques(), { enCours: 2, enAttente: 3, conservees: 5 });
  assert.equal(g.obtenir(ids[0]).etape, "extraction");
  assert.equal(g.obtenir(ids[1]).etape, "extraction");
  for (const [k, id] of ids.slice(2).entries()) {
    const vue = g.obtenir(id);
    assert.equal(vue.etat, "en_cours");
    assert.equal(vue.etape, "en_attente");
    assert.equal(vue.position, k + 1);
  }

  // On termine tout, dans le desordre : le pic ne depasse jamais 2.
  for (const i of [1, 0, 3, 2, 4]) {
    differes[i].resoudre({ n: i });
    await vider();
    assert.ok(actives <= 2, `actives=${actives}`);
  }
  await vider();
  assert.equal(pic, 2);
  for (const [i, id] of ids.entries()) assert.deepEqual(g.obtenir(id).resultat, { n: i });
  assert.equal(g.statistiques().enCours, 0);
});

test("ordre d'arrivee : les taches en attente demarrent dans l'ordre de creation", async () => {
  const g = creerGestionnaire(deuxCreneaux);
  const demarrees = [];
  const differes = [];
  for (let i = 0; i < 5; i++) {
    const d = differe();
    differes.push(d);
    g.creer(async () => { demarrees.push(i); return d.promesse; });
  }
  await vider();
  assert.deepEqual(demarrees, [0, 1]);
  differes[1].resoudre();
  await vider();
  assert.deepEqual(demarrees, [0, 1, 2]);
  differes[0].resoudre();
  await vider();
  assert.deepEqual(demarrees, [0, 1, 2, 3]);
  differes[3].resoudre();
  await vider();
  assert.deepEqual(demarrees, [0, 1, 2, 3, 4]);
  differes[2].resoudre(); differes[4].resoudre();
  await vider();
});

test("un echec libere son creneau comme un succes : la file ne se bloque pas, aucune relance", async () => {
  const g = creerGestionnaire(deuxCreneaux);
  const a = differe(), b = differe();
  let appelsA = 0;
  const ida = g.creer(() => { appelsA++; return a.promesse; });
  g.creer(() => b.promesse);
  let troisiemeDemarree = false;
  g.creer(async () => { troisiemeDemarree = true; return "ok"; });
  await vider();
  assert.equal(troisiemeDemarree, false);
  a.rejeter(erreurBridge("timeout", "DocIE timeout"));
  await vider();
  assert.equal(troisiemeDemarree, true);
  assert.equal(g.obtenir(ida).etat, "echec");
  assert.equal(appelsA, 1, "echouer bruyamment : le travail n'est jamais relance");
  b.resoudre();
  await vider();
});

test("un travail qui leve de maniere synchrone devient un echec, pas une exception du gestionnaire", async () => {
  const g = creerGestionnaire(silencieux);
  const id = g.creer(() => { throw new Error("synchrone"); });
  await vider();
  assert.equal(g.obtenir(id).etat, "echec");
  assert.equal(g.statistiques().enCours, 0);
});

test("forme de la vue : en_cours -> terminee, debut/fin en ISO, champs absents quand sans objet", async () => {
  let t = Date.parse("2026-09-15T10:00:00.000Z");
  const g = creerGestionnaire({ ...silencieux, maintenant: () => t });
  const d = differe();
  const id = g.creer(() => d.promesse);
  await vider();
  assert.deepEqual(g.obtenir(id), { etat: "en_cours", etape: "extraction", debut: "2026-09-15T10:00:00.000Z" });
  t += 4000;
  const resultat = { requestId: null, values: { numeroContrat: "X" }, warnings: [], errors: [], ok: true };
  d.resoudre(resultat);
  await vider();
  assert.deepEqual(g.obtenir(id), {
    etat: "terminee", resultat,
    debut: "2026-09-15T10:00:00.000Z", fin: "2026-09-15T10:00:04.000Z",
  });
});

test("identifiants : UUID v4 aleatoires, distincts ; id inconnu ou non textuel -> null", async () => {
  const g = creerGestionnaire({ ...silencieux, maxEnAttente: 100 });
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(g.creer(async () => i));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(g.obtenir("00000000-0000-4000-8000-000000000000"), null);
  assert.equal(g.obtenir(undefined), null);
  assert.equal(g.obtenir({}), null);
  await vider();
});

test("expiration : une tache finie est oubliee 30 min apres sa fin (a la milliseconde), une tache en cours jamais", async () => {
  let t = 1_000_000;
  const g = creerGestionnaire({ ...deuxCreneaux, maintenant: () => t });
  const longue = differe();
  const idLongue = g.creer(() => longue.promesse);
  const idCourte = g.creer(async () => "fini");
  await vider();
  assert.equal(g.obtenir(idCourte).etat, "terminee");

  t += TTL_MS - 1;
  assert.equal(g.obtenir(idCourte).etat, "terminee", "encore lisible juste avant le TTL");
  t += 1;
  assert.equal(g.obtenir(idCourte), null, "oubliee au TTL");
  assert.equal(g.statistiques().conservees, 1, "la memoire est bien rendue, pas seulement masquee");

  // En cours depuis plus longtemps que le TTL : toujours la.
  t += 10 * TTL_MS;
  assert.equal(g.obtenir(idLongue).etat, "en_cours");
  longue.resoudre("tard");
  await vider();
  t += TTL_MS - 1;
  assert.equal(g.obtenir(idLongue).resultat, "tard");
  t += 1;
  assert.equal(g.obtenir(idLongue), null);
  assert.equal(g.statistiques().conservees, 0);
});

test("expiration d'une tache en echec : meme TTL", async () => {
  let t = 0;
  const g = creerGestionnaire({ ...silencieux, maintenant: () => t });
  const id = g.creer(async () => { throw erreurBridge("upstream", "x"); });
  await vider();
  t += TTL_MS - 1;
  assert.equal(g.obtenir(id).etat, "echec");
  t += 1;
  assert.equal(g.obtenir(id), null);
});

test("la purge a aussi lieu a la creation (sans aucune lecture)", async () => {
  let t = 0;
  const g = creerGestionnaire({ ...silencieux, maintenant: () => t });
  for (let i = 0; i < 5; i++) g.creer(async () => i);
  await vider();
  assert.equal(g.statistiques().conservees, 5);
  t += TTL_MS;
  g.creer(async () => "neuve");
  assert.equal(g.statistiques().conservees, 1);
  await vider();
});

test("file bornee (plafond par defaut) : 1 en cours + 20 en attente acceptees, la suivante est refusee sans rien perdre", async () => {
  const g = creerGestionnaire(silencieux);
  const bloque = differe();
  for (let i = 0; i < MAX_SIMULTANEES_DEFAUT + MAX_EN_ATTENTE; i++) g.creer(() => bloque.promesse);
  await vider();
  assert.deepEqual(g.statistiques(), { enCours: 1, enAttente: 20, conservees: 21 });
  assert.throws(() => g.creer(async () => "de trop"), FileTachesPleineError);
  assert.deepEqual(g.statistiques(), { enCours: 1, enAttente: 20, conservees: 21 });
  bloque.resoudre();
  await vider(); await vider();
  assert.equal(g.statistiques().enAttente, 0);
});

// ── Correspondance des erreurs ─────────────────────────────────────────────

test("la table couvre exactement les codes que le bridge peut lever (relus dans docie-bridge.js)", () => {
  const codes = codesDuBridge();
  assert.ok(codes.length >= 13, codes.join(","));
  assert.deepEqual(Object.keys(MESSAGES_BRIDGE).sort(), codes);
});

test("loading + eta_seconds : « réessayez dans ~N s », eta arrondi a la seconde superieure ; sans eta, pas de nombre invente", () => {
  assert.deepEqual(mapperErreur(erreurBridge("loading", "x", 42)), {
    code: "loading", message: "Modèle en cours de chargement, réessayez dans ~42 s.", eta_seconds: 42,
  });
  assert.deepEqual(mapperErreur(erreurBridge("loading", "x", 12.2)), {
    code: "loading", message: "Modèle en cours de chargement, réessayez dans ~13 s.", eta_seconds: 13,
  });
  assert.equal(mapperErreur(erreurBridge("loading", "x", 0)).eta_seconds, 0);
  for (const eta of [null, undefined, -1, NaN, Infinity, "30"]) {
    const m = mapperErreur(erreurBridge("loading", "x", eta));
    assert.equal(m.code, "loading");
    assert.equal(Object.hasOwn(m, "eta_seconds"), false, String(eta));
    assert.equal(m.message, "Modèle en cours de chargement, réessayez dans quelques instants.");
  }
});

test("chaque code du bridge garde son nom et recoit un message francais propre et distinct, sans eta hors loading", () => {
  const messages = new Set();
  for (const code of codesDuBridge()) {
    const m = mapperErreur(erreurBridge(code, "DocIE request failed (HTTP 500).", 99));
    assert.equal(m.code, code);
    assert.equal(m.message, code === "loading" ? "Modèle en cours de chargement, réessayez dans ~99 s." : MESSAGES_BRIDGE[code]);
    assert.ok(!m.message.includes("DocIE request failed"), code);
    if (code !== "loading") assert.equal(Object.hasOwn(m, "eta_seconds"), false, code);
    messages.add(m.message);
  }
  assert.equal(messages.size, codesDuBridge().length, "un message distinct par code");
  assert.equal(mapperErreur(erreurBridge("context", "x")).message, "Document trop long pour le modèle d'extraction.");
});

test("erreurs metier d'extractContractValues : disabled et input gardent leur code et leur message, identique au texte reellement leve", async () => {
  const desactive = await extractContractValues({ dataBase64: "AA==" }, { env: {} }).catch((e) => e);
  const sansFichier = await extractContractValues({}, { env: { DOCIE_EXTRACTION_ENABLED: "true" } }).catch((e) => e);
  assert.equal(desactive.code, "disabled");
  assert.equal(sansFichier.code, "input");
  assert.deepEqual(mapperErreur(desactive), { code: "disabled", message: desactive.message });
  assert.deepEqual(mapperErreur(sansFichier), { code: "input", message: sansFichier.message });
  assert.equal(MESSAGES_SERVICE.disabled, desactive.message);
  assert.equal(MESSAGES_SERVICE.input, sansFichier.message);
});

test("input : meme code, deux origines — le texte anglais du bridge ne sort pas, celui du service est remplace par sa constante", () => {
  const bridge = mapperErreur(erreurBridge("input", "Unsupported document MIME type; use PDF, PNG or JPEG."));
  assert.deepEqual(bridge, { code: "input", message: MESSAGES_BRIDGE.input });
  const service = mapperErreur(Object.assign(new Error("texte arbitraire SECRET"), { code: "input" }));
  assert.deepEqual(service, { code: "input", message: "Aucun fichier reçu." });
});

test("tout le reste -> interne : code inconnu, code de bridge sans DocIEBridgeError, erreurs systeme, non-erreurs", () => {
  for (const e of [
    new Error("x"),
    Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("x"), { code: "timeout" }),          // pas une DocIEBridgeError
    Object.assign(new Error("x"), { code: "erreur" }),
    erreurBridge("inconnu_du_bridge", "x"),
    Object.assign(new Error("x"), { name: "DocIEBridgeError", code: "disabled" }),
    null, undefined, "chaine", 42,
  ]) {
    assert.deepEqual(mapperErreur(e), { code: "interne", message: MESSAGE_INTERNE });
  }
});

test("aucun texte amont ni secret dans la vue, quel que soit le code ; l'erreur brute part au journal serveur", async () => {
  const SECRET = "sk-docie-SECRET-4242 upstream said: /etc/passwd";
  const journal = [];
  const g = creerGestionnaire({ journal: (e) => journal.push(e), maxEnAttente: 100 });
  const erreurs = [
    ...codesDuBridge().map((code) => erreurBridge(code, SECRET, 5)),
    Object.assign(new Error(SECRET), { code: "disabled" }),
    Object.assign(new Error(SECRET), { code: "input" }),
    new Error(SECRET),
    Object.assign(new Error(SECRET), { code: "ECONNRESET" }),
    Object.assign(new Error(SECRET), { code: SECRET }),
    new TypeError(SECRET),
  ];
  const ids = erreurs.map((e) => g.creer(async () => { throw e; }));
  for (let i = 0; i < erreurs.length; i++) await vider();
  for (const id of ids) {
    const vue = g.obtenir(id);
    assert.equal(vue.etat, "echec");
    assert.ok(!JSON.stringify(vue).includes("SECRET"), JSON.stringify(vue));
    assert.ok(!JSON.stringify(vue).includes("passwd"), JSON.stringify(vue));
  }
  assert.equal(journal.length, erreurs.length, "l'erreur brute reste consultable cote serveur");
});
