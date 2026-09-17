"use strict";

/*
 * Controle d'acces du service one-pager (#245).
 *
 * Quatrieme et dernier service Node de la serie : #256 factory, #258 coffre,
 * #259 contrats, celui-ci. Il etait reste entierement public.
 *
 * `server.js` n'est jamais require() ici : le charger exigerait DATABASE_URL et
 * lierait un port. On teste les DECISIONS (auth-adbi.js, appelee directement)
 * et les REGLES telles que server.js et les fichiers d'image les ecrivent,
 * lues dans la source.
 *
 * Deux specificites de ce service, et les tests avec :
 *
 * 1. Son contexte de build EST la racine du depot (one-pager/Dockerfile,
 *    `context: .`). Il n'a donc AUCUN `additional_contexts`, contrairement aux
 *    trois autres : auth/ est atteignable directement. Un test qui exigerait
 *    ici un contexte nomme mesurerait une propriete qui ne doit pas exister.
 *
 * 2. Ce contexte est filtre par une LISTE BLANCHE
 *    (one-pager/Dockerfile.dockerignore : `*` puis des reintegrations). Le
 *    `COPY auth/ /auth` ne suffit donc pas : sans `!auth` dans cette liste, le
 *    build echoue sur « not found ». Deux pannes invisibles aux tests
 *    empilees l'une sur l'autre -- les deux sont epinglees ci-dessous.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const auth = require("../../auth/auth-adbi");

const SERVEUR = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const SECRET = "secret-de-test-du-one-pager";
const ENV_OUVERT = {}; // ADBI_AUTH absent
const ENV_FERME = { ADBI_AUTH: "on", ADBI_JWT_SECRET: SECRET };

const requete = (url, cookie) => ({ url, headers: cookie ? { cookie } : {} });

/** Jeton d'acces valide, signe comme cv-parser le signe (HS256). */
function jetonValide(secret = SECRET, surcharge = {}) {
  const crypto = require("node:crypto");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const entete = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub: "u-1", email: "membre@adbi.fr", role: "user", jti: "j1",
    iat: 1, exp: 4102444800, type: "access", ...surcharge,
  });
  const sig = crypto.createHmac("sha256", secret).update(`${entete}.${payload}`).digest("base64url");
  return `${entete}.${payload}.${sig}`;
}

// ── Position du middleware ───────────────────────────────────────────────────

const MONTAGE = "app.use(gardeAcces);";
const STATIQUE = "app.use(express.static(";
const JSON_BODY = "app.use(express.json(";

test("les ancres de mesure sont uniques dans la source", () => {
  // Sans unicite, un indexOf mesure la mauvaise occurrence et l'ordre teste
  // ci-dessous ne veut plus rien dire.
  for (const [nom, ancre] of Object.entries({ MONTAGE, STATIQUE, JSON_BODY })) {
    assert.equal(SERVEUR.split(ancre).length - 1, 1, `ancre ${nom} non unique`);
  }
});

test("le garde est monte APRES express.json et AVANT express.static", () => {
  /*
   * Avant le statique : sinon index.html et tout public/ partent sans session.
   * Apres express.json : le corps est consomme avant le refus, donc un envoi de
   * 25 Mo non authentifie recoit un 401 propre au lieu d'une connexion coupee.
   */
  const iJson = SERVEUR.indexOf(JSON_BODY);
  const iGarde = SERVEUR.indexOf(MONTAGE);
  const iStatique = SERVEUR.indexOf(STATIQUE);
  assert.ok(iJson > 0 && iGarde > 0 && iStatique > 0, "reperes absents");
  assert.ok(iJson < iGarde, "le garde doit etre monte APRES express.json");
  assert.ok(iGarde < iStatique, "le garde doit etre monte AVANT express.static");
});

test("aucune route n'est enregistree avant le garde", () => {
  const iGarde = SERVEUR.indexOf(MONTAGE);
  const premiereRoute = SERVEUR.search(/\napp\.(get|post|put|delete)\(/);
  assert.ok(premiereRoute > 0, "aucune route trouvee");
  assert.ok(iGarde < premiereRoute, "une route est enregistree avant le garde");
});

// ── Surface publique ─────────────────────────────────────────────────────────

test("cheminPublic n'expose QUE /api/sante", () => {
  /*
   * contrats exempte aussi /webhooks/signature (rappel entrant Yousign/Zoho).
   * one-pager n'a pas d'equivalent : toutes ses routes sont sous /api/. Une
   * exemption de plus ici ouvrirait un chemin pour rien.
   */
  assert.match(
    SERVEUR,
    /function cheminPublic\(chemin\) \{\s*return chemin === "\/api\/sante";\s*\}/,
    "cheminPublic doit n'exempter que /api/sante"
  );
});

test("la sonde reste joignable sans session", () => {
  // Le Dockerfile sonde /api/sante (SELECT 1 reel). Un 401 y serait lu comme un
  // echec : Coolify redemarrerait le conteneur en boucle.
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/sante/, "la sonde ne vise pas /api/sante");
});

// ── Forme du refus ───────────────────────────────────────────────────────────

test("une API refusee repond 401 JSON", () => {
  assert.match(SERVEUR, /return res\.status\(401\)\.json\(\{ erreur: "Non authentifie" \}\);/);
});

test("une page refusee renvoie le NIVEAU SUPERIEUR vers le hub", () => {
  assert.match(SERVEUR, /auth\.pageReconnexion\(FACTORY_URL, "one-pager"\)/,
    "page de reconnexion absente, ou pas pour le module one-pager");
  assert.doesNotMatch(SERVEUR, /res\.redirect\(|writeHead\(302/,
    "un module en iframe ne doit pas rediriger sur place");
});

test("sans URL de hub, le refus reste un refus", () => {
  assert.match(SERVEUR, /if \(!FACTORY_URL\)/, "cas FACTORY_URL vide non traite");
  assert.match(SERVEUR, /\.send\("Non authentifie"\)/, "pas de refus en clair");
});

// ── Image : DEUX pannes invisibles, empilees ─────────────────────────────────

test("le Dockerfile copie la bibliotheque partagee", () => {
  // require("../auth/auth-adbi") resout en checkout monorepo : sans cette
  // copie, TOUS les tests passent et le conteneur plante au demarrage.
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /COPY --chown=node:node auth\/ \/auth/,
    "le Dockerfile ne copie pas auth/");
});

test("la LISTE BLANCHE du contexte reintegre auth/", () => {
  /*
   * Le test ci-dessus ne suffit pas. Le contexte de build est filtre par
   * Dockerfile.dockerignore, une liste blanche (`*` puis reintegrations lues
   * par BuildKit a la place d'un .dockerignore racine). Sans `!auth`, le COPY
   * echoue sur « not found » -- et la suite reste entierement verte, puisqu'
   * elle tourne sur le checkout ou auth/ existe pour de vrai.
   */
  const di = fs.readFileSync(path.join(__dirname, "..", "Dockerfile.dockerignore"), "utf8");
  const lignes = di.split(/\r?\n/).map((l) => l.trim());
  assert.ok(lignes.includes("!auth"),
    "Dockerfile.dockerignore ne reintegre pas auth/ : le build echouera sur « not found »");
});

test("one-pager n'a PAS d'additional_contexts, et ne doit pas en avoir", () => {
  /*
   * L'inverse du test ecrit pour factory, coffre et contrats. Le contexte de
   * build de ce service est deja la racine du depot (`context: .` +
   * `dockerfile: one-pager/Dockerfile`), donc auth/ y est directement. Ajouter
   * un contexte nomme ici serait du bruit, et le COPY correspondant
   * (`--from=auth`) serait faux.
   */
  const racine = path.join(__dirname, "..", "..");
  for (const nom of ["docker-compose.yml", "docker-compose.local.yml"]) {
    const lignes = fs.readFileSync(path.join(racine, nom), "utf8").split(/\r?\n/);
    const iService = lignes.findIndex((l) => l.trimEnd() === "  one-pager:");
    assert.ok(iService >= 0, `service one-pager introuvable dans ${nom}`);

    let fin = lignes.length;
    for (let i = iService + 1; i < lignes.length; i++) {
      if (/^ {2}\S/.test(lignes[i])) { fin = i; break; }
    }
    const bloc = lignes.slice(iService, fin);
    assert.ok(bloc.some((l) => l.trim() === "context: ."),
      `${nom} : one-pager doit batir depuis la racine du depot`);
    assert.ok(!bloc.some((l) => l.trim() === "additional_contexts:"),
      `${nom} : one-pager n'a pas besoin d'additional_contexts (contexte = racine)`);
  }
});

test("les deux composes transmettent les variables d'auth", () => {
  // Meme piege que #164 : une variable documentee mais absente du compose
  // n'atteint jamais le conteneur, et le garde ne pourrait pas etre active.
  const racine = path.join(__dirname, "..", "..");
  for (const nom of ["docker-compose.yml", "docker-compose.local.yml"]) {
    const lignes = fs.readFileSync(path.join(racine, nom), "utf8").split(/\r?\n/);
    const iService = lignes.findIndex((l) => l.trimEnd() === "  one-pager:");
    let fin = lignes.length;
    for (let i = iService + 1; i < lignes.length; i++) {
      if (/^ {2}\S/.test(lignes[i])) { fin = i; break; }
    }
    const bloc = lignes.slice(iService, fin).join("\n");
    for (const v of ["ADBI_AUTH:", "ADBI_JWT_SECRET:", "ADBI_FACTORY_URL:"]) {
      assert.ok(bloc.includes(v), `${nom} : ${v} absent du bloc one-pager`);
    }
  }
});

// ── Decisions du garde ───────────────────────────────────────────────────────

test("ADBI_AUTH absent : one-pager reste ouvert, comportement d'avant", () => {
  for (const p of ["/", "/api/cvs", "/api/templates"]) {
    const d = auth.garde(requete(p), ENV_OUVERT);
    assert.equal(d.autorise, true, p);
    assert.equal(d.utilisateur.sub, "local", p);
  }
});

test("ADBI_AUTH=on sans jeton : refus", () => {
  for (const p of ["/", "/api/cvs", "/api/export/pptx"]) {
    assert.equal(auth.garde(requete(p), ENV_FERME).autorise, false, p);
  }
});

test("ADBI_AUTH=on avec un jeton cv-parser valide : passage", () => {
  const d = auth.garde(requete("/api/cvs", "adbi_access=" + jetonValide()), ENV_FERME);
  assert.equal(d.autorise, true);
  assert.equal(d.utilisateur.sub, "u-1");
});

test("un jeton signe d'une AUTRE cle est refuse", () => {
  const d = auth.garde(requete("/", "adbi_access=" + jetonValide("pas-la-bonne-cle")), ENV_FERME);
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "jeton_invalide");
});

test("un refresh token n'ouvre pas one-pager", () => {
  const jeton = jetonValide(SECRET, { type: "refresh" });
  assert.equal(auth.garde(requete("/", "adbi_access=" + jeton), ENV_FERME).autorise, false);
});

test("ADBI_AUTH=on sans ADBI_JWT_SECRET : REFUS, jamais passage", () => {
  const d = auth.garde(requete("/"), { ADBI_AUTH: "on" });
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "secret_absent");
});

test("la branche api/page suit le chemin", () => {
  assert.equal(auth.garde(requete("/api/cvs"), ENV_FERME).api, true);
  assert.equal(auth.garde(requete("/"), ENV_FERME).api, false);
  assert.equal(auth.garde(requete("/index.html"), ENV_FERME).api, false);
});

// ── Ce que one-pager n'est pas ───────────────────────────────────────────────

test("one-pager VERIFIE les jetons, il n'en emet aucun", () => {
  assert.doesNotMatch(SERVEUR, /ADBI_JWT_SECRET/,
    "one-pager ne doit pas lire le secret lui-meme : c'est le role de auth-adbi");
  assert.match(SERVEUR, /require\("\.\.\/auth\/auth-adbi"\)/,
    "one-pager doit passer par la bibliotheque partagee");
});
