"use strict";

/*
 * Controle d'acces du hub (#245) — premier jeu d'essai de ce service.
 *
 * factory n'avait AUCUN test : ce fichier est le harnais, sur le modele de
 * one-pager/tests (node:test, aucune dependance npm, aucun serveur demarre).
 *
 * `server.js` n'est jamais require() ici : le charger appelle
 * http.createServer(...).listen(...) et laisse un serveur en ecoute. On teste
 * donc les DECISIONS (auth-adbi.js) et les regles d'exemption telles que
 * server.js les ecrit, extraites par lecture de source -- pas le transport.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const auth = require("../../auth/auth-adbi");

const SERVEUR = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const SECRET = "secret-de-test-du-hub";
const ENV_OUVERT = {};                                        // ADBI_AUTH absent
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

// ── Exemptions : ce qui doit rester servi SANS session ───────────────────────

test("la sonde /api/sante est traitee AVANT le garde", () => {
  /*
   * C'est la condition du garde, pas un detail. factory/Dockerfile sonde
   * /api/sante et traite toute reponse non-`ok` comme un echec : si le garde
   * repondait 401 a la sonde, Coolify redemarrerait le hub en boucle.
   *
   * Mesure sur la source : la route sante apparait avant l'appel au garde.
   */
  /*
   * ANCRE : la forme ROUTE, pas la comparaison nue.
   *
   * Premiere version : `indexOf('chemin === "/api/sante"')`. Vacuous, prouve
   * par mutation -- cette chaine apparait DEUX fois (dans `cheminPublic()`,
   * defini plus haut, et dans la route). Supprimer la route laissait
   * l'occurrence de `cheminPublic` satisfaire l'assertion, donc le test
   * restait vert alors que la sonde etait passee derriere le garde.
   * La forme ci-dessous n'existe que dans le dispatcher.
   */
  const ROUTE_SANTE = 'if (chemin === "/api/sante" && req.method === "GET")';
  const APPEL_GARDE = "if (refuserSiNonAuthentifie(req, rep, chemin)) return;";
  // Les DEUX ancres doivent etre uniques. La premiere version de ce test les
  // ratait toutes les deux : `chemin === "/api/sante"` existe aussi dans
  // cheminPublic(), et le nom nu `refuserSiNonAuthentifie(req, rep, chemin)`
  // existe aussi dans la DEFINITION de la fonction (ligne ~489), qui precede
  // tout le dispatcher -- l'ordre mesure etait donc faux dans un sens comme
  // dans l'autre. Ces deux egalites font echouer le test si une ancre cesse
  // d'etre unique, au lieu de le laisser mesurer la mauvaise occurrence.
  assert.equal(SERVEUR.split(ROUTE_SANTE).length - 1, 1, "ancre ROUTE_SANTE non unique");
  assert.equal(SERVEUR.split(APPEL_GARDE).length - 1, 1, "ancre APPEL_GARDE non unique");

  const iSante = SERVEUR.indexOf(ROUTE_SANTE);
  const iGarde = SERVEUR.indexOf(APPEL_GARDE);
  assert.ok(iSante > 0, "route /api/sante absente");
  assert.ok(iGarde > 0, "appel au garde absent");
  assert.ok(iSante < iGarde, "/api/sante doit etre servie avant le garde");
});

test("le dispatcher APPELLE reellement le garde, avant toute route", () => {
  /*
   * Le test qui manquait, et son absence etait grave.
   *
   * Tous les tests de decision ci-dessous appellent `auth.garde(...)` par la
   * bibliotheque. Aucun ne verifiait que server.js s'en sert : preuve de
   * mutation a l'appui, retirer l'appel du dispatcher laissait la suite
   * ENTIEREMENT VERTE. On pouvait donc supprimer le controle d'acces sans
   * qu'un seul test rougisse -- exactement la decoration que cette serie
   * cherche a eliminer ailleurs.
   *
   * Ces assertions epinglent le site d'appel lui-meme, et sa position : avant
   * la premiere route API, sinon /api/modules repondrait avant le garde.
   */
  /*
   * ANCRE : la forme APPEL, pas le nom nu.
   *
   * `refuserSiNonAuthentifie(req, rep, chemin)` apparait DEUX fois -- dans la
   * definition de la fonction, et au site d'appel. Un `indexOf` sur le nom nu
   * trouve la DEFINITION, qui precede tout : l'ordre mesure serait toujours
   * satisfait, quelle que soit la position reelle de l'appel. Meme piege que
   * pour /api/sante, trouve ici par audit plutot que par mutation.
   */
  const APPEL_GARDE = "if (refuserSiNonAuthentifie(req, rep, chemin)) return;";
  assert.equal(SERVEUR.split(APPEL_GARDE).length - 1, 1,
    "l'ancre doit etre unique, sinon l'ordre ne mesure rien");
  assert.ok(SERVEUR.includes(APPEL_GARDE), "le dispatcher n'appelle pas le garde");

  const iGarde = SERVEUR.indexOf(APPEL_GARDE);
  const iModules = SERVEUR.indexOf('chemin === "/api/modules"');
  const iStatique = SERVEUR.indexOf("// ── Fichiers statiques ──");
  assert.ok(iGarde > 0 && iModules > 0 && iStatique > 0, "reperes absents");
  assert.ok(iGarde < iModules, "le garde doit preceder /api/modules");
  assert.ok(iGarde < iStatique, "le garde doit preceder les fichiers statiques");
});

test("la fonction de refus existe et couvre les deux formes de reponse", () => {
  assert.match(SERVEUR, /function refuserSiNonAuthentifie\(req, rep, chemin\)/,
    "fonction de refus absente");
  assert.match(SERVEUR, /if \(cheminPublic\(chemin\)\) return false;/,
    "les chemins publics ne sont pas exemptes");
  assert.match(SERVEUR, /auth\.garde\(req, process\.env\)/,
    "le refus ne consulte pas la bibliotheque partagee");
});

test("la charte et ses polices restent publiques", () => {
  // La page de connexion vers laquelle on redirige doit pouvoir s'afficher :
  // gater la charte rendrait l'ecran illisible.
  for (const p of ["/adbi-theme.css", "/adbi-theme.js", "/fonts/inter.woff2"]) {
    assert.match(SERVEUR, /function cheminPublic\(chemin\)/, "cheminPublic absent");
    assert.ok(
      SERVEUR.includes('"/adbi-theme.css"') &&
      SERVEUR.includes('"/adbi-theme.js"') &&
      SERVEUR.includes('"/fonts/"'),
      "exemption manquante pour " + p);
  }
});

test("LES DEUX composes exposent le contexte auth au hub", () => {
  /*
   * Le test du Dockerfile ci-dessous ne peut PAS voir ce trou, et il l'a laisse
   * passer : le Dockerfile portait bien `COPY --from=auth`, mais seul le
   * compose racine declarait le contexte. `docker compose -f
   * docker-compose.local.yml up --build` echouait donc — BuildKit cherchant une
   * image « auth » sur Docker Hub — sans qu'un seul test rougisse. Trouve en
   * portant le meme garde sur contrats (#259), bati par trois composes.
   *
   * factory est bati par deux fichiers ; il n'a pas de compose propre.
   */
  const racine = path.join(__dirname, "..", "..");
  const composes = [
    path.join(racine, "docker-compose.yml"),
    path.join(racine, "docker-compose.local.yml"),
  ];

  for (const fichier of composes) {
    const lignes = fs.readFileSync(fichier, "utf8").split(/\r?\n/);
    const iService = lignes.findIndex((l) => l.trimEnd() === "  factory:");
    assert.ok(iService >= 0, `service factory introuvable dans ${path.basename(fichier)}`);

    // Fin du bloc : le prochain service (indente de 2) OU une cle de premier
    // niveau en colonne 0 (`volumes:`, en fin de fichier). Sans cette seconde
    // condition, le bloc d'un service place en DERNIER avalerait la cle qui
    // suit -- mesure sur cv-parser dans docker-compose.local.yml : l'ancien
    // parcours s'arretait une ligne trop loin. Juste sur les fichiers
    // d'aujourd'hui, faux en general.
    let fin = lignes.length;
    for (let i = iService + 1; i < lignes.length; i++) {
      if (/^ {2}\S/.test(lignes[i]) || /^\S/.test(lignes[i])) { fin = i; break; }
    }
    const bloc = lignes.slice(iService, fin);

    const iContextes = bloc.findIndex((l) => l.trim() === "additional_contexts:");
    assert.ok(iContextes >= 0,
      `${path.basename(fichier)} : factory n'a pas d'additional_contexts ` +
      `(forme courte "build: ./factory" ? le build echouera sur COPY --from=auth)`);

    const aAuth = bloc.slice(iContextes + 1).some((l) => l.trim() === "auth: ./auth");
    assert.ok(aAuth,
      `${path.basename(fichier)} : contexte "auth: ./auth" absent pour factory`);
  }
});

test("le HEALTHCHECK sonde /api/sante et non /", () => {
  // Gater `/` sans repointer la sonde = boucle de redemarrage. Les quatre
  // autres services sondaient deja /api/sante ; factory etait l'exception.
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/sante/, "la sonde ne vise pas /api/sante");
  assert.doesNotMatch(df, /fetch\('http:\/\/127\.0\.0\.1:'\+\(process\.env\.ADBI_PORT\|\|4000\)\+'\/'\)/,
    "la sonde vise encore la racine");
});

// ── Decisions du garde ───────────────────────────────────────────────────────

test("ADBI_AUTH absent : le hub reste ouvert, comportement d'avant", () => {
  for (const p of ["/", "/api/modules", "/module.html"]) {
    const d = auth.garde(requete(p), ENV_OUVERT);
    assert.equal(d.autorise, true, p);
    assert.equal(d.utilisateur.sub, "local", p);
  }
});

test("ADBI_AUTH=on sans jeton : refus", () => {
  for (const p of ["/", "/api/modules", "/module.html"]) {
    assert.equal(auth.garde(requete(p), ENV_FERME).autorise, false, p);
  }
});

test("ADBI_AUTH=on avec un jeton cv-parser valide : passage", () => {
  const d = auth.garde(requete("/", "adbi_access=" + jetonValide()), ENV_FERME);
  assert.equal(d.autorise, true);
  assert.equal(d.utilisateur.sub, "u-1");
});

test("un jeton signe d'une AUTRE cle est refuse", () => {
  const d = auth.garde(requete("/", "adbi_access=" + jetonValide("pas-la-bonne-cle")), ENV_FERME);
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "jeton_invalide");
});

test("un refresh token n'ouvre pas le hub", () => {
  const jeton = jetonValide(SECRET, { type: "refresh" });
  assert.equal(auth.garde(requete("/", "adbi_access=" + jeton), ENV_FERME).autorise, false);
});

test("ADBI_AUTH=on sans ADBI_JWT_SECRET : REFUS, jamais passage", () => {
  // Une variable oubliee ne doit pas devenir une ouverture silencieuse.
  const d = auth.garde(requete("/"), { ADBI_AUTH: "on" });
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "secret_absent");
});

// ── Forme de la reponse : JSON pour les API, redirection pour les pages ──────

test("la branche api/page suit le chemin", () => {
  assert.equal(auth.garde(requete("/api/modules"), ENV_FERME).api, true);
  assert.equal(auth.garde(requete("/"), ENV_FERME).api, false);
  assert.equal(auth.garde(requete("/module.html?m=contrats"), ENV_FERME).api, false);
});

test("une page refusee redirige vers la connexion de cv-parser, avec next", () => {
  assert.match(SERVEUR, /PARSER_URL \+ "\/login" \+ retour/, "cible de redirection absente");
  assert.match(SERVEUR, /encodeURIComponent\(origine \+ req\.url\)/, "`next` non encode");
  assert.match(SERVEUR, /rep\.writeHead\(302/, "pas de redirection 302");
});

test("une API refusee repond 401 JSON, pas du HTML de connexion", () => {
  assert.match(SERVEUR, /repondreJson\(rep, 401, \{ erreur: "Non authentifie" \}\)/);
});

test("le voyant IA n'est plus une route publique", () => {
  /*
   * /api/llm/tester relaie vers la passerelle d'inference. Il etait public par
   * conception ; sur un service qui exige desormais une session, laisser un
   * relai non authentifie ouvert contredirait tout le correctif.
   */
  const iGarde = SERVEUR.indexOf("refuserSiNonAuthentifie(req, rep, chemin)");
  const iLlm = SERVEUR.indexOf('chemin === "/api/llm/tester"');
  assert.ok(iLlm > 0, "route /api/llm/tester absente");
  assert.ok(iGarde < iLlm, "/api/llm/tester doit passer APRES le garde");
  assert.equal(auth.garde(requete("/api/llm/tester"), ENV_FERME).autorise, false);
});

// ── Ce que le hub n'est pas ──────────────────────────────────────────────────

test("le hub ne signe aucun jeton : il ne fait que verifier", () => {
  // cv-parser reste le seul emetteur d'identite de la plateforme.
  assert.doesNotMatch(SERVEUR, /createHmac|jwt\.sign|signer/i,
    "le hub ne doit jamais fabriquer de jeton");
  assert.match(SERVEUR, /require\("\.\.\/auth\/auth-adbi"\)/,
    "le hub doit passer par la bibliotheque partagee");
});

test("le hub dit au demarrage qu'il tourne sans controle d'acces", () => {
  // #245 : un service qui demarre OUVERT ne doit pas etre silencieux. Le
  // libelle vit dans auth-adbi.js (un seul texte pour la plateforme) ; ce qui
  // est verifie ici, c'est que CE service le demande et le journalise.
  assert.match(SERVEUR, /avertissementAcces\(process\.env\)/,
    "le service doit demander la ligne d'alerte a la bibliotheque partagee");
  assert.match(SERVEUR, /console\.log\(avertissement\)/,
    "et la journaliser au demarrage");
});
