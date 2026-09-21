/*
 * auth/auth-adbi.js — vérification des jetons ADBI pour les services Node.
 *
 * cv-parser est le SEUL émetteur d'identité de la plateforme : il porte les
 * comptes (PostgreSQL), la connexion, la rotation et la révocation des refresh
 * tokens. Les quatre services Node (factory, contrats, coffre, one-pager) ne
 * font que VÉRIFIER — aucun n'a de base d'utilisateurs, aucun n'émet de jeton.
 * Ajouter un cinquième annuaire aurait été la mauvaise réponse à « ces services
 * n'ont pas d'authentification ».
 *
 * Miroir exact de cv-parser/core/auth.py. Toute divergence ici est un bug :
 *   _get_token()  -> jetonDeRequete()   cookie `adbi_access`, sinon `Bearer`
 *   _is_api()     -> estApi()           chemin commençant par `/api/`
 *   AUTH_ACTIVE   -> authActive()       ADBI_AUTH ∈ (on, 1, true, oui)
 *   UTILISATEUR_LOCAL -> UTILISATEUR_LOCAL
 * Des jetons produits par PyJWT sont épinglés dans tests/ : c'est la seule
 * preuve qui compte, les deux implémentations devant lire les MÊMES octets.
 *
 * AUCUNE dépendance npm : `factory` et `coffre` n'en ont aucune, par choix
 * délibéré (rien à auditer, pas de mise à jour piégée). Cette bibliothèque ne
 * doit pas leur en imposer une — d'où HMAC-SHA256 à la main sur `node:crypto`.
 */
"use strict";

const crypto = require("crypto");

/** Identité endossée quand ADBI_AUTH n'est pas posé (poste local, hors ligne).
 *  Forme identique au payload JWT : mêmes clés que cv-parser/core/auth.py. */
const UTILISATEUR_LOCAL = Object.freeze({
  sub: "local",
  email: "",
  role: "superuser",
  full_name: "Poste local",
  jti: "local",
  type: "access",
});

/** ADBI_AUTH ∈ (on, 1, true, oui) — mêmes valeurs que core/auth.py:153. */
function authActive(env) {
  const brut = ((env && env.ADBI_AUTH) || "off").trim().toLowerCase();
  return brut === "on" || brut === "1" || brut === "true" || brut === "oui";
}

/**
 * Ligne d'alerte quand le service démarre SANS contrôle d'accès, ou null.
 *
 * Même libellé que cv-parser/app.py:129 — un seul texte pour la plateforme,
 * pas une deuxième formulation par service.
 *
 * RENDUE plutôt qu'affichée : une fonction pure se teste sans démarrer de
 * serveur. Les tests de ce dépôt ne `require()` jamais un server.js, qui
 * écoute dès le chargement (voir l'en-tête de factory/tests/garde-acces.test.js) ;
 * c'est l'appelant qui journalise, dans son propre rappel `listen`.
 *
 * Pourquoi elle existe : `ADBI_AUTH` absent vaut « off », et les quatre
 * services Node démarraient alors en annonçant « prêt » sans dire qu'ils
 * étaient ouverts. Un déploiement qui oublie la variable ne doit pas être
 * silencieux — c'est exactement ce que #245 a trouvé sur coffre.
 */
function avertissementAcces(env) {
  if (authActive(env)) return null;
  return "  [AUTH] ⚠ Authentification DÉSACTIVÉE (ADBI_AUTH != on) — "
    + "à réserver au poste local, jamais à un déploiement exposé.";
}

/** `/api/...` -> réponse JSON ; tout le reste -> réponse HTML (core/auth.py:142). */
function estApi(chemin) {
  return typeof chemin === "string" && chemin.startsWith("/api/");
}

function decoderBase64Url(segment) {
  if (typeof segment !== "string" || segment === "") return null;
  // base64url : '-' et '_' remplacent '+' et '/', le padding est retiré.
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    return Buffer.from(segment, "base64url");
  } catch {
    return null;
  }
}

function jsonDeSegment(segment) {
  const octets = decoderBase64Url(segment);
  if (!octets) return null;
  try {
    const valeur = JSON.parse(octets.toString("utf8"));
    return valeur && typeof valeur === "object" && !Array.isArray(valeur) ? valeur : null;
  } catch {
    return null;
  }
}

/**
 * Vérifie un jeton d'ACCÈS ADBI. Rend le payload, ou null.
 *
 * Refusé sans exception : signature invalide, jeton expiré, `type` autre que
 * "access", et tout algorithme autre que HS256. Ce dernier point n'est pas de
 * la prudence décorative — accepter `alg: "none"` rendrait n'importe quel
 * jeton valide, et accepter un HS512 signé avec la même clé changerait la
 * signature attendue. L'algorithme est donc imposé, jamais lu pour être suivi.
 */
function verifierJetonAcces(jeton, secret, options) {
  const maintenant = (options && options.maintenant) || Math.floor(Date.now() / 1000);
  if (typeof jeton !== "string" || typeof secret !== "string" || secret === "") return null;

  const parties = jeton.split(".");
  if (parties.length !== 3) return null;
  const [enteteB64, payloadB64, signatureB64] = parties;

  const entete = jsonDeSegment(enteteB64);
  if (!entete || entete.alg !== "HS256") return null;

  const attendue = crypto
    .createHmac("sha256", secret)
    .update(`${enteteB64}.${payloadB64}`)
    .digest();
  const fournie = decoderBase64Url(signatureB64);
  // Longueurs comparées d'abord : timingSafeEqual LÈVE si elles diffèrent.
  if (!fournie || fournie.length !== attendue.length) return null;
  if (!crypto.timingSafeEqual(fournie, attendue)) return null;

  const payload = jsonDeSegment(payloadB64);
  if (!payload) return null;
  if (payload.type !== "access") return null;
  if (typeof payload.exp !== "number" || !(payload.exp > maintenant)) return null;
  if (typeof payload.sub !== "string" || payload.sub === "") return null;

  return payload;
}

/** Cookie `adbi_access`, sinon en-tête `Authorization: Bearer` (core/auth.py:132). */
function jetonDeRequete(req) {
  const entetes = (req && req.headers) || {};
  const brut = entetes.cookie || entetes.Cookie || "";
  for (const morceau of String(brut).split(";")) {
    const separateur = morceau.indexOf("=");
    if (separateur === -1) continue;
    if (morceau.slice(0, separateur).trim() !== "adbi_access") continue;
    const valeur = morceau.slice(separateur + 1).trim();
    if (valeur) return decodeURIComponent(valeur);
  }
  const autorisation = entetes.authorization || entetes.Authorization || "";
  if (typeof autorisation === "string" && autorisation.startsWith("Bearer ")) {
    return autorisation.slice(7) || null;
  }
  return null;
}

/**
 * Décision d'accès pour une requête. Ne répond RIEN elle-même : chaque service
 * a sa propre façon d'écrire une réponse (http natif pour factory et coffre,
 * express pour contrats et one-pager).
 *
 * Rend { autorise, utilisateur, api, raison }.
 */
function garde(req, env, options) {
  const chemin = ((req && req.url) || "/").split("?")[0];
  const api = estApi(chemin);

  if (!authActive(env)) {
    return { autorise: true, utilisateur: UTILISATEUR_LOCAL, api, raison: "auth_desactivee" };
  }
  const secret = (env && env.ADBI_JWT_SECRET) || "";
  if (!secret) {
    // Auth demandée mais pas de clé : on REFUSE. Laisser passer ferait d'une
    // variable oubliée une ouverture silencieuse — la panne exacte que cette
    // série de correctifs cherche à supprimer.
    return { autorise: false, utilisateur: null, api, raison: "secret_absent" };
  }
  const jeton = jetonDeRequete(req);
  if (!jeton) return { autorise: false, utilisateur: null, api, raison: "jeton_absent" };

  const payload = verifierJetonAcces(jeton, secret, options);
  if (!payload) return { autorise: false, utilisateur: null, api, raison: "jeton_invalide" };

  return { autorise: true, utilisateur: payload, api, raison: "ok" };
}

/**
 * Page rendue à un module NON authentifié demandé en HTML.
 *
 * Pourquoi une page et non une redirection : le hub affiche les modules dans
 * une <iframe> (factory/public/module.html). Le jeton d'accès vit 1 heure
 * (ACCESS_TOKEN_EXPIRE_MINUTES = 60) et le module ne peut pas le renouveler
 * lui-même — `adbi_refresh` est limité à `path=/api/auth/refresh` sur le
 * domaine de cv-parser. Sans ça, l'iframe deviendrait un cadre mort au bout
 * d'une heure, sans rien dire. On renvoie donc le NIVEAU SUPÉRIEUR vers le
 * hub, qui sait renouveler la session.
 */
function pageReconnexion(urlFactory, idModule) {
  const cible =
    String(urlFactory || "").replace(/\/+$/, "") +
    "/module.html?m=" +
    encodeURIComponent(String(idModule || ""));
  // JSON.stringify échappe guillemets, barres obliques inverses et U+2028/9 :
  // `cible` vient d'une variable d'environnement et d'un identifiant de module,
  // jamais d'un champ utilisateur, mais l'échappement ne se discute pas.
  const cibleJs = JSON.stringify(cible);
  return `<!doctype html>
<html lang="fr"><meta charset="utf-8">
<title>Session expiree</title>
<body style="font:14px system-ui;padding:2rem">
<p>Session expiree. Reconnexion en cours...</p>
<script>
  var cible = ${cibleJs};
  try { if (window.top !== window.self) { window.top.location = cible; } else { window.location = cible; } }
  catch (e) { window.location = cible; }
</script>
<noscript><a href="${cible.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Se reconnecter</a></noscript>
</body></html>`;
}

module.exports = {
  UTILISATEUR_LOCAL,
  authActive,
  avertissementAcces,
  estApi,
  verifierJetonAcces,
  jetonDeRequete,
  garde,
  pageReconnexion,
};
