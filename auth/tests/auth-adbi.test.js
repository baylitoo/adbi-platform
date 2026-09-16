/*
 * Vérification des jetons ADBI côté Node — mesurée contre de VRAIS jetons.
 *
 * Les quatre jetons épinglés ci-dessous ont été produits par PyJWT 2.13.0, la
 * bibliothèque que cv-parser utilise réellement (core/auth.py), avec un secret
 * fixe. C'est le seul test qui compte vraiment : les deux implémentations
 * doivent lire les mêmes octets. Une vérification maison qui ne passe que ses
 * propres jetons ne prouve rien.
 *
 * Lancement : node --test auth/tests/
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const A = require("../auth-adbi.js");

// ── Jetons de parité, produits par PyJWT (voir l'en-tête) ────────────────────
const SECRET = "secret-de-parite-adbi-ne-pas-utiliser-en-production";

// sub=u-42, role=superuser, type=access, exp en 2036.
const VALIDE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTQyIiwiZW1haWwiOiJjYW1pbGxlQGFkYmkuZnIiLCJyb2xlIjoic3VwZXJ1c2VyIiwianRpIjoiZml4ZS0wMDAxIiwiaWF0IjoxNzg5NTY5MDczLCJleHAiOjIxMDQ5MjkwNzMsInR5cGUiOiJhY2Nlc3MifQ.RWtLiz3rJKHoTreikPbTLyJ51vsxT1HR-zYYCHF1GQs";
// type=access, mais exp dans le passé.
const EXPIRE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTQyIiwianRpIjoiZml4ZS0wMDAyIiwiaWF0IjoxNzg5NTU4MjczLCJleHAiOjE3ODk1NjE4NzMsInR5cGUiOiJhY2Nlc3MifQ.0UEeMjdVJ5rFpY2I4J1SAFcxdmzI2f-QqbXV-Pldasw";
// Signature valide, mais type=refresh : un refresh ne doit JAMAIS ouvrir un accès.
const TYPE_REFRESH =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTQyIiwianRpIjoiZml4ZS0wMDAzIiwiaWF0IjoxNzg5NTY5MDczLCJleHAiOjIxMDQ5MjkwNzMsInR5cGUiOiJyZWZyZXNoIn0.x0gVFhe0rhinBZLqLStqyHyi5Is6secPR-5QrgSvKXM";
// Bien formé, signé avec une autre clé.
const MAUVAISE_CLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTQyIiwianRpIjoiZml4ZS0wMDA0IiwiaWF0IjoxNzg5NTY5MDczLCJleHAiOjIxMDQ5MjkwNzMsInR5cGUiOiJhY2Nlc3MifQ.FfVn5MMExCcj34UwLDmZxbo1O8li3v1w2I3UzmsV0PA";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function forger(entete, payload, secret) {
  const e = b64(entete);
  const p = b64(payload);
  const sig = secret === null
    ? ""
    : crypto.createHmac("sha256", secret).update(`${e}.${p}`).digest("base64url");
  return `${e}.${p}.${sig}`;
}

const PAYLOAD_OK = { sub: "u-42", jti: "j", iat: 1, exp: 4102444800, type: "access" };

// ── Parité PyJWT ─────────────────────────────────────────────────────────────

test("un jeton produit par PyJWT est accepte, avec son payload intact", () => {
  const p = A.verifierJetonAcces(VALIDE, SECRET);
  assert.ok(p, "le jeton de reference doit passer — sinon les deux ports divergent");
  assert.equal(p.sub, "u-42");
  assert.equal(p.role, "superuser");
  assert.equal(p.email, "camille@adbi.fr");
  assert.equal(p.type, "access");
});

test("un jeton PyJWT expire est refuse", () => {
  assert.equal(A.verifierJetonAcces(EXPIRE, SECRET), null);
});

test("un refresh token ne vaut pas un acces, meme signe correctement", () => {
  assert.equal(A.verifierJetonAcces(TYPE_REFRESH, SECRET), null);
});

test("un jeton signe avec une autre cle est refuse", () => {
  assert.equal(A.verifierJetonAcces(MAUVAISE_CLE, SECRET), null);
});

test("le jeton de reference est refuse par une autre cle", () => {
  assert.equal(A.verifierJetonAcces(VALIDE, "une-cle-qui-n-est-pas-la-bonne"), null);
});

// ── Confusion d'algorithme ───────────────────────────────────────────────────

test("alg:none est refuse", () => {
  assert.equal(A.verifierJetonAcces(forger({ alg: "none", typ: "JWT" }, PAYLOAD_OK, null), SECRET), null);
});

test("alg:HS512 est refuse meme signe avec la bonne cle", () => {
  const e = b64({ alg: "HS512", typ: "JWT" });
  const p = b64(PAYLOAD_OK);
  const sig = crypto.createHmac("sha512", SECRET).update(`${e}.${p}`).digest("base64url");
  assert.equal(A.verifierJetonAcces(`${e}.${p}.${sig}`, SECRET), null);
});

test("un en-tete qui ANNONCE un autre algorithme est refuse, signature HS256 correcte ou non", () => {
  /*
   * Le cas qui REND OBSERVABLE le verrou `alg === "HS256"`.
   *
   * Les deux tests ci-dessus ne le prouvent pas, et la preuve de mutation l'a
   * montre : `alg:none` porte une signature vide (rejetee au decodage) et le
   * HS512 authentique echoue sur la signature, puisqu'on calcule toujours du
   * HMAC-SHA256. Retirer le verrou ne les faisait donc pas rougir — ils
   * mesuraient autre chose que ce qu'ils annoncaient.
   *
   * Ici la signature est calculee en HMAC-SHA256, donc VALIDE pour notre
   * verification : seul l'en-tete ment. Sans le verrou, ce jeton passerait.
   * C'est la confusion d'algorithme sous sa forme exacte.
   */
  const p = b64(PAYLOAD_OK);
  for (const alg of ["none", "HS512", "RS256", "", "hs256"]) {
    const e = b64({ alg, typ: "JWT" });
    const sig = crypto.createHmac("sha256", SECRET).update(`${e}.${p}`).digest("base64url");
    assert.equal(A.verifierJetonAcces(`${e}.${p}.${sig}`, SECRET), null, `alg annonce: ${alg}`);
  }
  // Temoin : le MEME payload avec l'en-tete honnete passe. Sans ce temoin, le
  // test ci-dessus pourrait rougir pour une raison etrangere a l'algorithme.
  const e = b64({ alg: "HS256", typ: "JWT" });
  const sig = crypto.createHmac("sha256", SECRET).update(`${e}.${p}`).digest("base64url");
  assert.ok(A.verifierJetonAcces(`${e}.${p}.${sig}`, SECRET));
});

test("un payload altere invalide la signature", () => {
  const [e, , s] = VALIDE.split(".");
  const altere = b64({ ...PAYLOAD_OK, sub: "u-999", role: "superuser" });
  assert.equal(A.verifierJetonAcces(`${e}.${altere}.${s}`, SECRET), null);
});

test("formes degenerees : rien ne leve, tout est refuse", () => {
  for (const cas of ["", "a.b", "a.b.c.d", "....", "pas-un-jeton",
                     "!!!.???.$$$", null, undefined, 42, {}]) {
    assert.equal(A.verifierJetonAcces(cas, SECRET), null, `cas: ${String(cas)}`);
  }
});

test("un secret vide ou absent refuse tout", () => {
  assert.equal(A.verifierJetonAcces(VALIDE, ""), null);
  assert.equal(A.verifierJetonAcces(VALIDE, null), null);
});

test("l'expiration est comparee a l'instant fourni", () => {
  const jeton = forger({ alg: "HS256", typ: "JWT" },
                       { ...PAYLOAD_OK, exp: 1000 }, SECRET);
  assert.ok(A.verifierJetonAcces(jeton, SECRET, { maintenant: 999 }));
  assert.equal(A.verifierJetonAcces(jeton, SECRET, { maintenant: 1000 }), null,
               "exp == maintenant : deja expire");
  assert.equal(A.verifierJetonAcces(jeton, SECRET, { maintenant: 1001 }), null);
});

// ── Extraction du jeton (miroir de _get_token) ───────────────────────────────

test("le cookie adbi_access est lu", () => {
  assert.equal(A.jetonDeRequete({ headers: { cookie: "adbi_access=abc" } }), "abc");
});

test("le cookie est trouve parmi d'autres, avec espaces", () => {
  assert.equal(
    A.jetonDeRequete({ headers: { cookie: "theme=sombre; adbi_access=abc ; autre=1" } }),
    "abc");
});

test("un cookie dont le NOM contient adbi_access ne compte pas", () => {
  assert.equal(A.jetonDeRequete({ headers: { cookie: "xadbi_access=abc" } }), null);
});

test("a defaut de cookie, l'en-tete Bearer est lu", () => {
  assert.equal(A.jetonDeRequete({ headers: { authorization: "Bearer xyz" } }), "xyz");
});

test("le cookie a la priorite sur Bearer, comme en Python", () => {
  assert.equal(
    A.jetonDeRequete({ headers: { cookie: "adbi_access=du-cookie", authorization: "Bearer du-bearer" } }),
    "du-cookie");
});

test("ni cookie ni Bearer : null, jamais d'exception", () => {
  for (const req of [{}, { headers: {} }, { headers: { cookie: "" } },
                     { headers: { authorization: "Basic abc" } }]) {
    assert.equal(A.jetonDeRequete(req), null);
  }
});

// ── estApi / authActive (miroirs exacts) ─────────────────────────────────────

test("estApi : seul le prefixe /api/ compte", () => {
  assert.equal(A.estApi("/api/sante"), true);
  assert.equal(A.estApi("/api/"), true);
  assert.equal(A.estApi("/api"), false, "sans barre finale, c'est une page");
  assert.equal(A.estApi("/"), false);
  assert.equal(A.estApi("/public/api/x"), false);
});

test("authActive : memes valeurs acceptees que core/auth.py", () => {
  for (const v of ["on", "1", "true", "oui", "ON", " True ", "OUI"]) {
    assert.equal(A.authActive({ ADBI_AUTH: v }), true, `valeur: ${v}`);
  }
  for (const v of ["off", "", "non", "0", "false", undefined]) {
    assert.equal(A.authActive({ ADBI_AUTH: v }), false, `valeur: ${String(v)}`);
  }
  assert.equal(A.authActive({}), false, "absente = desactivee, comme en Python");
  assert.equal(A.authActive(undefined), false);
});

// ── garde ────────────────────────────────────────────────────────────────────

test("ADBI_AUTH absent : passage libre sous l'identite locale", () => {
  const d = A.garde({ url: "/api/x", headers: {} }, {});
  assert.equal(d.autorise, true);
  assert.equal(d.utilisateur.sub, "local");
  assert.equal(d.raison, "auth_desactivee");
});

test("auth demandee mais ADBI_JWT_SECRET absent : REFUS, pas passage", () => {
  const d = A.garde({ url: "/", headers: {} }, { ADBI_AUTH: "on" });
  assert.equal(d.autorise, false);
  assert.equal(d.raison, "secret_absent");
});

test("jeton valide : autorise, avec le payload", () => {
  const d = A.garde({ url: "/", headers: { cookie: `adbi_access=${VALIDE}` } },
                    { ADBI_AUTH: "on", ADBI_JWT_SECRET: SECRET });
  assert.equal(d.autorise, true);
  assert.equal(d.utilisateur.sub, "u-42");
});

test("la branche api/html suit le chemin, hors query string", () => {
  const env = { ADBI_AUTH: "on", ADBI_JWT_SECRET: SECRET };
  assert.equal(A.garde({ url: "/api/x?y=1", headers: {} }, env).api, true);
  assert.equal(A.garde({ url: "/module?m=api", headers: {} }, env).api, false);
});

test("jeton expire : refus, raison distincte d'une absence", () => {
  const env = { ADBI_AUTH: "on", ADBI_JWT_SECRET: SECRET };
  assert.equal(A.garde({ url: "/", headers: { cookie: `adbi_access=${EXPIRE}` } }, env).raison,
               "jeton_invalide");
  assert.equal(A.garde({ url: "/", headers: {} }, env).raison, "jeton_absent");
});

// ── pageReconnexion ──────────────────────────────────────────────────────────

test("la page de reconnexion vise le hub et sort de l'iframe", () => {
  const html = A.pageReconnexion("https://hub.exemple.fr/", "contrats");
  assert.match(html, /window\.top\.location/);
  assert.match(html, /https:\/\/hub\.exemple\.fr\/module\.html\?m=contrats/);
  assert.doesNotMatch(html, /hub\.exemple\.fr\/\/module/, "barre finale non doublee");
});

test("l'identifiant de module est echappe, pas interpole brut", () => {
  const html = A.pageReconnexion("https://hub.exemple.fr", '"><script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /%3C|%22/, "l'identifiant est encode dans l'URL");
});
