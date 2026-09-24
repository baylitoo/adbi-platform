"use strict";

/*
 * Controle d'acces du service contrats (#245) — 5/5 de la serie.
 *
 * `server.js` n'est jamais require() ici : le charger ouvrirait une connexion
 * PostgreSQL et lierait un port. On teste les DECISIONS (auth-adbi.js, appelee
 * directement) et les REGLES telles que server.js et les fichiers de
 * deploiement les ecrivent, lues dans la source.
 *
 * Ce service differe des quatre autres sur deux points, et les tests avec :
 *
 * 1. C'est de l'Express. Le garde est un middleware `app.use(gardeAcces)`, pas
 *    un `if (...) return;` dans un aiguillage ecrit a la main. L'invariant
 *    d'ordre est donc INVERSE de celui du coffre : /api/sante y etait servie
 *    AVANT le garde, ici elle est exemptee par PREDICAT et passe APRES lui.
 *    Copier l'assertion du coffre ici mesurerait une propriete fausse.
 *
 * 2. Il avait deja un controle d'acces, plus etroit : exigerCodeParametres,
 *    sur les routes d'administration. Il reste. Un test verifie qu'il n'a pas
 *    ete remplace au passage.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const auth = require("../../auth/auth-adbi");

const RACINE = path.join(__dirname, "..", "..");
const SERVEUR = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const SECRET = "secret-de-test-des-contrats";
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
  // ci-dessous ne veut plus rien dire. Trois assertions vides sont deja passees
  // par ce trou chez factory (#256).
  for (const [nom, ancre] of Object.entries({ MONTAGE, STATIQUE, JSON_BODY })) {
    assert.equal(SERVEUR.split(ancre).length - 1, 1, `ancre ${nom} non unique`);
  }
});

test("le garde est monte APRES express.json et AVANT express.static", () => {
  /*
   * Avant le statique : sinon index.html et tout public/ partent sans session,
   * et le garde ne protege que les routes API — c'est-a-dire presque rien de ce
   * qu'un visiteur voit.
   *
   * Apres express.json : pour que le corps soit consomme avant le refus. Un
   * envoi de 30 Mo non authentifie recoit alors un 401 propre que le front sait
   * lire, au lieu d'une connexion coupee en plein transfert.
   */
  const iJson = SERVEUR.indexOf(JSON_BODY);
  const iGarde = SERVEUR.indexOf(MONTAGE);
  const iStatique = SERVEUR.indexOf(STATIQUE);
  assert.ok(iJson > 0 && iGarde > 0 && iStatique > 0, "reperes absents");
  assert.ok(iJson < iGarde, "le garde doit etre monte APRES express.json");
  assert.ok(iGarde < iStatique, "le garde doit etre monte AVANT express.static");
});

test("aucune route n'est enregistree avant le garde", () => {
  // Une seule route montee au-dessus du middleware serait publique sans que
  // rien ne le signale.
  const iGarde = SERVEUR.indexOf(MONTAGE);
  const premiereRoute = SERVEUR.search(/\napp\.(get|post|put|delete)\(/);
  assert.ok(premiereRoute > 0, "aucune route trouvee");
  assert.ok(iGarde < premiereRoute, "une route est enregistree avant le garde");
});

// ── Surface publique ─────────────────────────────────────────────────────────

test("cheminPublic expose deux chemins, plus la charte de la page de reconnexion", () => {
  assert.match(
    SERVEUR,
    /function cheminPublic\(chemin\) \{\s*return chemin === "\/api\/sante" \|\| chemin === "\/webhooks\/signature"\s*\|\| chemin === "\/adbi-theme\.css" \|\| chemin === "\/adbi-theme\.js" \|\| chemin\.startsWith\("\/fonts\/"\);\s*\}/,
    "la liste d'exemption n'est pas exactement { /api/sante, /webhooks/signature }"
  );
});

test("/api/sante reste joignable sans session", () => {
  // Le Dockerfile sonde /api/sante (SELECT 1 reel). Un 401 y serait lu comme un
  // echec : Coolify redemarrerait le conteneur en boucle.
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/sante/, "la sonde ne vise pas /api/sante");
  assert.ok(SERVEUR.includes('chemin === "/api/sante"'), "sante non exemptee");
});

test("/webhooks/signature reste joignable : c'est un rappel entrant", () => {
  /*
   * Yousign et Zoho appellent cette route depuis l'exterieur. Elle ne porte
   * aucune session ADBI et n'en portera jamais : elle s'authentifie par HMAC
   * sur ses propres octets, avec le secret du fournisseur. La gater ne casse
   * rien bruyamment — la synchronisation des signatures s'arreterait en
   * silence, ce qui est pire qu'une panne visible.
   */
  assert.ok(SERVEUR.includes('chemin === "/webhooks/signature"'), "webhook non exempte");
  assert.match(SERVEUR, /createHmac\("sha256", cfg\.webhookSecret\)/,
    "le webhook ne verifie plus sa propre signature : l'exempter deviendrait un trou");
});

// ── Forme du refus ───────────────────────────────────────────────────────────

test("une API refusee repond 401 JSON", () => {
  assert.match(SERVEUR, /return res\.status\(401\)\.json\(\{ erreur: "Non authentifié" \}\);/);
});

test("une page refusee renvoie le NIVEAU SUPERIEUR vers le hub", () => {
  // contrats est un module affiche en <iframe> (modules.docker.json). Une
  // redirection 302 sur place ferait un cadre mort a l'expiration du jeton, et
  // #254 rejetterait de toute facon un `next` d'une autre origine.
  assert.match(SERVEUR, /auth\.pageReconnexion\(FACTORY_URL, "contrats"\)/,
    "page de reconnexion absente, ou pas pour le module contrats");
  assert.doesNotMatch(SERVEUR, /res\.redirect\(|writeHead\(302/,
    "un module en iframe ne doit pas rediriger sur place");
});

test("sans URL de hub, le refus reste un refus", () => {
  assert.match(SERVEUR, /if \(!FACTORY_URL\)/, "cas FACTORY_URL vide non traite");
  assert.match(SERVEUR, /\.send\(auth\.pageMessage\("Session expirée"/, "pas de refus en clair");
});

// ── Le verrou existant n'a pas ete remplace ──────────────────────────────────

test("exigerCodeParametres survit : deux verrous, deux questions", () => {
  /*
   * Le garde demande « qui es-tu » (session ADBI). exigerCodeParametres demande
   * « as-tu le code de cet ecran ». Remplacer le second par le premier
   * ouvrirait les Parametres a tout porteur de session.
   */
  assert.match(SERVEUR, /function exigerCodeParametres\(req, res, next\)/,
    "le verrou de l'ecran Parametres a disparu");
  const routesAdmin = SERVEUR.match(/exigerCodeParametres,/g) || [];
  assert.ok(routesAdmin.length >= 5,
    `routes d'administration encore protegees : ${routesAdmin.length}, attendu >= 5`);
});

// ── Image et fichiers de deploiement ─────────────────────────────────────────

test("l'image embarque la bibliotheque partagee", () => {
  // require("../auth/auth-adbi") resout en checkout monorepo : sans cette
  // copie, TOUS les tests passent et le conteneur plante au demarrage.
  const df = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(df, /COPY --from=auth --chown=node:node \. \/auth/,
    "le Dockerfile ne copie pas auth/");
});

test("LES TROIS composes exposent le contexte auth a contrats", () => {
  /*
   * `COPY --from=auth` echoue pour CHAQUE compose qui ne declare pas le
   * contexte : BuildKit cherche alors une image « auth » sur Docker Hub. Le
   * test du Dockerfile ci-dessus ne peut pas voir ce trou — il faut lire les
   * fichiers de deploiement eux-memes. Trois fichiers, trois chemins relatifs
   * differents.
   */
  const composes = [
    { fichier: path.join(RACINE, "docker-compose.yml"), service: "contrats", attendu: "./auth" },
    { fichier: path.join(RACINE, "docker-compose.local.yml"), service: "contrats", attendu: "./auth" },
    { fichier: path.join(__dirname, "..", "docker-compose.yml"), service: "adbi-contrats", attendu: "../auth" },
  ];

  for (const { fichier, service, attendu } of composes) {
    const lignes = fs.readFileSync(fichier, "utf8").split(/\r?\n/);
    const iService = lignes.findIndex((l) => l.trimEnd() === `  ${service}:`);
    assert.ok(iService >= 0, `service ${service} introuvable dans ${path.basename(fichier)}`);

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
      `${path.basename(fichier)} : ${service} n'a pas d'additional_contexts`);

    const contextes = bloc.slice(iContextes + 1).filter((l) => /^\s*[a-z_]+:\s*\.\.?\//.test(l));
    const aAuth = contextes.some((l) => l.trim() === `auth: ${attendu}`);
    assert.ok(aAuth,
      `${path.basename(fichier)} : contexte "auth: ${attendu}" absent pour ${service} ` +
      `(le build echouera sur COPY --from=auth)`);
  }
});

// ── Decisions du garde ───────────────────────────────────────────────────────

test("ADBI_AUTH absent : contrats reste ouvert, comportement d'avant", () => {
  for (const p of ["/", "/api/contracts", "/api/settings"]) {
    const d = auth.garde(requete(p), ENV_OUVERT);
    assert.equal(d.autorise, true, p);
    assert.equal(d.utilisateur.sub, "local", p);
  }
});

test("ADBI_AUTH=on sans jeton : refus", () => {
  for (const p of ["/", "/api/contracts", "/api/signatures"]) {
    assert.equal(auth.garde(requete(p), ENV_FERME).autorise, false, p);
  }
});

test("ADBI_AUTH=on avec un jeton cv-parser valide : passage", () => {
  const d = auth.garde(requete("/api/contracts", "adbi_access=" + jetonValide()), ENV_FERME);
  assert.equal(d.autorise, true);
  assert.equal(d.utilisateur.sub, "u-1");
});

test("un jeton signe d'une AUTRE cle est refuse", () => {
  const d = auth.garde(requete("/", "adbi_access=" + jetonValide("pas-la-bonne-cle")), ENV_FERME);
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "jeton_invalide");
});

test("un refresh token n'ouvre pas contrats", () => {
  const jeton = jetonValide(SECRET, { type: "refresh" });
  assert.equal(auth.garde(requete("/", "adbi_access=" + jeton), ENV_FERME).autorise, false);
});

test("ADBI_AUTH=on sans ADBI_JWT_SECRET : REFUS, jamais passage", () => {
  const d = auth.garde(requete("/"), { ADBI_AUTH: "on" });
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "secret_absent");
});

test("la branche api/page suit le chemin", () => {
  assert.equal(auth.garde(requete("/api/contracts"), ENV_FERME).api, true);
  assert.equal(auth.garde(requete("/"), ENV_FERME).api, false);
  assert.equal(auth.garde(requete("/index.html"), ENV_FERME).api, false);
});

// ── Ce que contrats n'est pas ────────────────────────────────────────────────

test("contrats VERIFIE les jetons, il n'en emet aucun", () => {
  // cv-parser reste le seul emetteur d'identite. On ne teste pas l'absence de
  // createHmac : contrats s'en sert legitimement pour les webhooks de
  // signature. L'invariant juste est plus etroit — le secret de session ne doit
  // jamais etre lu ici.
  assert.doesNotMatch(SERVEUR, /ADBI_JWT_SECRET/,
    "contrats ne doit pas lire le secret lui-meme : c'est le role de auth-adbi");
  assert.match(SERVEUR, /require\("\.\.\/auth\/auth-adbi"\)/,
    "contrats doit passer par la bibliotheque partagee");
});

test("contrats dit au demarrage qu'il tourne sans controle d'acces", () => {
  // #245 : un service qui demarre OUVERT ne doit pas etre silencieux. Le
  // libelle vit dans auth-adbi.js (un seul texte pour la plateforme) ; ce qui
  // est verifie ici, c'est que CE service le demande et le journalise.
  assert.match(SERVEUR, /avertissementAcces\(process\.env\)/,
    "le service doit demander la ligne d'alerte a la bibliotheque partagee");
  assert.match(SERVEUR, /console\.log\(avertissement\)/,
    "et la journaliser au demarrage");
});
