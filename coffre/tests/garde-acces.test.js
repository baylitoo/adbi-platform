"use strict";

/*
 * Controle d'acces du coffre (#245) — premier jeu d'essai de ce service.
 *
 * coffre n'avait AUCUN test : ce fichier est le harnais, sur le modele de
 * factory/tests (node:test, aucune dependance npm, aucun serveur demarre).
 *
 * `server.js` n'est JAMAIS require() ici. Le charger appellerait
 * http.createServer(...).listen(...) et laisserait un serveur en ecoute -- et
 * le port n'est meme pas negociable : `Number(process.env.ADBI_COFFRE_PORT) ||
 * 4300` vaut 4300 pour "0", parce que Number("0") est 0 et que 0 est falsy.
 * Impossible donc de demander un port ephemere ; une collision ferait
 * process.exit(1) et laisserait un processus orphelin.
 *
 * On teste donc les DECISIONS (auth-adbi.js, appelee directement) et les
 * REGLES telles que server.js les ecrit, lues dans la source — pas le
 * transport.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const auth = require("../../auth/auth-adbi");

const SERVEUR = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const SECRET = "secret-de-test-du-coffre";
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

// ── Position du garde dans le dispatcher ─────────────────────────────────────

/*
 * ANCRES : la forme complete, jamais le nom nu.
 *
 * `chemin === "/api/sante"` apparait DEUX fois (dans cheminPublic() et dans la
 * route) et `refuserSiNonAuthentifie(req, rep, chemin)` apparait deux fois
 * aussi (definition et site d'appel). Un indexOf sur l'une de ces formes
 * courtes mesurerait la mauvaise occurrence — la definition precede tout le
 * dispatcher, donc l'ordre serait satisfait quoi qu'il arrive. Ce piege a
 * reellement laisse trois assertions vides chez factory (#256) : les egalites
 * d'unicite ci-dessous font echouer le test si une ancre cesse d'etre unique,
 * au lieu de le laisser mesurer n'importe quoi.
 */
const ROUTE_SANTE = 'if (chemin === "/api/sante" && req.method === "GET")';
const APPEL_GARDE = "if (refuserSiNonAuthentifie(req, rep, chemin)) return;";

test("les ancres de mesure sont uniques dans la source", () => {
  assert.equal(SERVEUR.split(ROUTE_SANTE).length - 1, 1, "ancre ROUTE_SANTE non unique");
  assert.equal(SERVEUR.split(APPEL_GARDE).length - 1, 1, "ancre APPEL_GARDE non unique");
});

test("la sonde /api/sante est traitee AVANT le garde", () => {
  /*
   * C'est la condition du garde, pas un detail. coffre/Dockerfile sonde
   * /api/sante et traite toute reponse non-`ok` comme un echec : si le garde
   * repondait 401 a la sonde, Coolify redemarrerait le coffre en boucle.
   */
  const iSante = SERVEUR.indexOf(ROUTE_SANTE);
  const iGarde = SERVEUR.indexOf(APPEL_GARDE);
  assert.ok(iSante > 0, "route /api/sante absente");
  assert.ok(iGarde > 0, "appel au garde absent");
  assert.ok(iSante < iGarde, "/api/sante doit etre servie avant le garde");
});

test("le dispatcher APPELLE le garde avant TOUTE route sensible", () => {
  /*
   * Le test qui manquait chez factory, et dont l'absence etait grave : tous
   * les tests de decision ci-dessous appellent auth.garde() par la
   * bibliotheque, aucun ne verifiait que server.js s'en sert. Retirer l'appel
   * du dispatcher laissait la suite entierement verte.
   *
   * Ici on epingle le site d'appel ET sa position devant chaque route qui
   * manipule un document ou une reference.
   */
  assert.ok(SERVEUR.includes(APPEL_GARDE), "le dispatcher n'appelle pas le garde");
  const iGarde = SERVEUR.indexOf(APPEL_GARDE);

  const routes = {
    "/api/chiffrer": 'if (chemin === "/api/chiffrer" && req.method === "POST")',
    "/api/dechiffrer": 'if (chemin === "/api/dechiffrer" && req.method === "POST")',
    "/api/docx/analyser": 'if (chemin === "/api/docx/analyser" && req.method === "POST")',
    "/api/docx/proteger": 'if (chemin === "/api/docx/proteger" && req.method === "POST")',
    "/api/references": 'if (chemin === "/api/references" && req.method === "GET")',
    "/api/references/attribuer": 'if (chemin === "/api/references/attribuer" && req.method === "POST")',
    "/api/archiver": 'if (chemin === "/api/archiver" && req.method === "POST")',
    "/api/references/<ref>/document": "const routeDoc = chemin.match(",
    "fichiers statiques": "// ── Fichiers statiques ──",
  };

  for (const [nom, ancre] of Object.entries(routes)) {
    const i = SERVEUR.indexOf(ancre);
    assert.ok(i > 0, `repere absent pour ${nom}`);
    assert.ok(iGarde < i, `${nom} doit passer APRES le garde`);
  }
});

// ── Surface publique ─────────────────────────────────────────────────────────

test("cheminPublic n'expose QUE /api/sante", () => {
  /*
   * factory exempte aussi /adbi-theme.* et /fonts/ parce que la page vers
   * laquelle il redirige doit pouvoir s'afficher. Le coffre n'en a pas besoin :
   * la page rendue a un visiteur non authentifie vient de
   * auth.pageReconnexion(), entierement autonome (styles en ligne). Exempter
   * des ressources statiques ici ouvrirait des chemins pour rien.
   */
  assert.match(
    SERVEUR,
    /function cheminPublic\(chemin\) \{\s*return chemin === "\/api\/sante";\s*\}/,
    "cheminPublic doit n'exempter que /api/sante"
  );
  assert.ok(!SERVEUR.includes('"/adbi-theme.css"'), "exemption de charte inattendue");
  assert.ok(!SERVEUR.includes('"/fonts/"'), "exemption de polices inattendue");
});

test("la fonction de refus existe et couvre les deux formes de reponse", () => {
  assert.match(SERVEUR, /function refuserSiNonAuthentifie\(req, rep, chemin\)/,
    "fonction de refus absente");
  assert.match(SERVEUR, /if \(cheminPublic\(chemin\)\) return false;/,
    "les chemins publics ne sont pas exemptes");
  assert.match(SERVEUR, /auth\.garde\(req, process\.env\)/,
    "le refus ne consulte pas la bibliotheque partagee");
});

test("une API refusee repond 401 JSON, jamais du HTML", () => {
  // Le front appelle tout par fetch() : du HTML la ou il attend du JSON
  // casserait l'affichage au lieu de signaler la session expiree.
  assert.match(SERVEUR, /repondreJson\(rep, 401, \{ erreur: "Non authentifie" \}\)/);
});

test("une page refusee renvoie le NIVEAU SUPERIEUR vers le hub", () => {
  /*
   * Le coffre est un module affiche en <iframe> par le hub
   * (modules.docker.json). Une redirection 302 sur place ferait un cadre mort
   * a l'expiration du jeton (1 h) : pageReconnexion() renvoie window.top vers
   * le hub, qui sait renouveler la session.
   */
  assert.match(SERVEUR, /auth\.pageReconnexion\(FACTORY_URL, "coffre"\)/,
    "la page de reconnexion n'est pas rendue, ou pas pour le module coffre");
  assert.doesNotMatch(SERVEUR, /rep\.writeHead\(302/,
    "un module en iframe ne doit pas rediriger sur place");
});

test("sans URL de hub, le refus reste un refus", () => {
  // Une variable manquante ne doit jamais devenir un passage libre, ni une
  // redirection vers une page qui n'existe pas sur ce service.
  assert.match(SERVEUR, /if \(!FACTORY_URL\) \{/, "cas FACTORY_URL vide non traite");
  assert.match(SERVEUR, /rep\.end\("Non authentifie"\);/, "pas de refus en clair");
});

// ── Image et sonde ───────────────────────────────────────────────────────────

test("le HEALTHCHECK sonde /api/sante", () => {
  // Gater tout sans laisser la sonde passer = boucle de redemarrage. Le coffre
  // sondait deja /api/sante (factory, lui, sondait "/" et a du etre corrige).
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/sante/, "la sonde ne vise pas /api/sante");
});

test("l'image embarque la bibliotheque partagee", () => {
  /*
   * require("../auth/auth-adbi") resout en checkout monorepo, donc TOUS les
   * tests passent sans cette copie -- et le conteneur plante au demarrage.
   * C'est exactement le genre de panne que la suite doit attraper.
   */
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /COPY --from=auth --chown=node:node \. \/auth/,
    "le Dockerfile ne copie pas auth/ : require(\"../auth/auth-adbi\") plantera dans l'image");
});

test("LES DEUX composes exposent le contexte auth au coffre", () => {
  /*
   * Le test ci-dessus ne peut PAS voir ce trou, et il l'a laisse passer : le
   * Dockerfile portait bien `COPY --from=auth`, mais seul le compose racine
   * declarait le contexte. `docker compose -f docker-compose.local.yml up
   * --build` echouait donc — BuildKit cherchant une image « auth » sur Docker
   * Hub — sans qu'un seul test rougisse. Trouve en portant le meme garde sur
   * contrats (#259), qui est bati par trois composes.
   *
   * Le coffre est bati par deux fichiers ; il n'a pas de compose propre.
   */
  const racine = path.join(__dirname, "..", "..");
  const composes = [
    path.join(racine, "docker-compose.yml"),
    path.join(racine, "docker-compose.local.yml"),
  ];

  for (const fichier of composes) {
    const lignes = fs.readFileSync(fichier, "utf8").split(/\r?\n/);
    const iService = lignes.findIndex((l) => l.trimEnd() === "  coffre:");
    assert.ok(iService >= 0, `service coffre introuvable dans ${path.basename(fichier)}`);

    // Bloc du service : jusqu'au prochain service de meme niveau (2 espaces).
    let fin = lignes.length;
    for (let i = iService + 1; i < lignes.length; i++) {
      if (/^ {2}\S/.test(lignes[i])) { fin = i; break; }
    }
    const bloc = lignes.slice(iService, fin);

    const iContextes = bloc.findIndex((l) => l.trim() === "additional_contexts:");
    assert.ok(iContextes >= 0,
      `${path.basename(fichier)} : coffre n'a pas d'additional_contexts ` +
      `(forme courte "build: ./coffre" ? le build echouera sur COPY --from=auth)`);

    const aAuth = bloc.slice(iContextes + 1).some((l) => l.trim() === "auth: ./auth");
    assert.ok(aAuth,
      `${path.basename(fichier)} : contexte "auth: ./auth" absent pour coffre`);
  }
});

// ── Decisions du garde ───────────────────────────────────────────────────────

test("ADBI_AUTH absent : le coffre reste ouvert, comportement d'avant", () => {
  for (const p of ["/", "/api/chiffrer", "/api/references"]) {
    const d = auth.garde(requete(p), ENV_OUVERT);
    assert.equal(d.autorise, true, p);
    assert.equal(d.utilisateur.sub, "local", p);
  }
});

test("ADBI_AUTH=on sans jeton : refus sur tout sauf la sonde", () => {
  for (const p of ["/", "/api/chiffrer", "/api/dechiffrer", "/api/references"]) {
    assert.equal(auth.garde(requete(p), ENV_FERME).autorise, false, p);
  }
});

test("ADBI_AUTH=on avec un jeton cv-parser valide : passage", () => {
  const d = auth.garde(requete("/api/chiffrer", "adbi_access=" + jetonValide()), ENV_FERME);
  assert.equal(d.autorise, true);
  assert.equal(d.utilisateur.sub, "u-1");
});

test("un jeton signe d'une AUTRE cle est refuse", () => {
  const d = auth.garde(requete("/", "adbi_access=" + jetonValide("pas-la-bonne-cle")), ENV_FERME);
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "jeton_invalide");
});

test("un refresh token n'ouvre pas le coffre", () => {
  const jeton = jetonValide(SECRET, { type: "refresh" });
  assert.equal(auth.garde(requete("/", "adbi_access=" + jeton), ENV_FERME).autorise, false);
});

test("ADBI_AUTH=on sans ADBI_JWT_SECRET : REFUS, jamais passage", () => {
  // Une variable oubliee ne doit pas devenir une ouverture silencieuse.
  const d = auth.garde(requete("/"), { ADBI_AUTH: "on" });
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "secret_absent");
});

test("la branche api/page suit le chemin", () => {
  assert.equal(auth.garde(requete("/api/chiffrer"), ENV_FERME).api, true);
  assert.equal(auth.garde(requete("/"), ENV_FERME).api, false);
  assert.equal(auth.garde(requete("/index.html"), ENV_FERME).api, false);
});

// ── Ce que le coffre n'est pas ───────────────────────────────────────────────

test("le coffre VERIFIE les jetons, il n'en emet aucun", () => {
  /*
   * cv-parser reste le seul emetteur d'identite. On ne teste pas l'absence de
   * createHmac -- le coffre est un service de chiffrement, node:crypto y est
   * partout et legitimement. L'invariant juste est plus etroit : le secret de
   * signature ne doit JAMAIS etre lu ici. Sa verification appartient a la
   * bibliotheque partagee.
   */
  assert.doesNotMatch(SERVEUR, /ADBI_JWT_SECRET/,
    "le coffre ne doit pas lire le secret lui-meme : c'est le role de auth-adbi");
  assert.match(SERVEUR, /require\("\.\.\/auth\/auth-adbi"\)/,
    "le coffre doit passer par la bibliotheque partagee");
});
