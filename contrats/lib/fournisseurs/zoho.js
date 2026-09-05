/* Connecteur de signature ZOHO SIGN (API v1) — même interface que yousign.js.
 *
 * Particularités Zoho :
 * - Authentification OAuth2 : client_id + client_secret + REFRESH TOKEN
 *   (l'access token, valable 1 h, est obtenu/rafraîchi automatiquement ici).
 *   L'échange initial du « code self-client » est intégré aux Paramètres
 *   (route /api/zoho/echanger-code) : coller le code suffit.
 * - Centres de données régionaux : Europe (sign.zoho.eu — défaut ADBI, RGPD),
 *   International (.com), Inde (.in). Comptes et API suivent la même région.
 * - Flux d'enveloppe en trois temps : créer le brouillon (PDF + destinataires),
 *   poser les champs de signature (PUT), puis soumettre (les e-mails partent).
 * - Rappels automatiques (email_reminders) et expiration en JOURS.
 * - Le « certificat de complétion » Zoho tient lieu de dossier de preuve.
 */

const fs = require("fs");
const path = require("path");
const { DELAI_HTTP_MS, DELAI_UPLOAD_MS, delaiSignal, messageDelai } = require("../httpDelai");

const SECRETS_PATH = path.join(__dirname, "..", "..", "data", "secrets.json");

const DOMAINES = {
  eu: { comptes: "https://accounts.zoho.eu", api: "https://sign.zoho.eu/api/v1" },
  com: { comptes: "https://accounts.zoho.com", api: "https://sign.zoho.com/api/v1" },
  in: { comptes: "https://accounts.zoho.in", api: "https://sign.zoho.in/api/v1" },
};

function lireSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")); } catch (e) { return {}; }
}

// Priorité : variable d'environnement, puis secrets.json.
function config() {
  const s = lireSecrets();
  const clientId = process.env.ZOHO_CLIENT_ID || s.zohoClientId;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || s.zohoClientSecret;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN || s.zohoRefreshToken;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const regionDemandee = process.env.ZOHO_REGION || s.zohoRegion;
  const region = DOMAINES[regionDemandee] ? regionDemandee : "eu";
  return { clientId, clientSecret, refreshToken, region, ...DOMAINES[region] };
}

// Cache de l'access token (1 h chez Zoho) — rafraîchi 5 min avant l'échéance.
let jetonCache = { valeur: null, expire: 0 };

async function jetonAcces(force) {
  const c = config();
  if (!c) throw new Error("Zoho Sign non configuré (client ID, secret et refresh token requis — Paramètres → Signature électronique).");
  if (!force && jetonCache.valeur && Date.now() < jetonCache.expire) return jetonCache.valeur;
  let r;
  try {
    r = await fetch(c.comptes + "/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
      }),
      signal: delaiSignal(DELAI_HTTP_MS),
    });
  } catch (e) {
    throw messageDelai("Zoho OAuth", DELAI_HTTP_MS, e);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("Zoho OAuth : " + (j.error || "HTTP " + r.status) + " — vérifie client ID/secret/refresh token (région " + c.region + ").");
  }
  jetonCache = { valeur: j.access_token, expire: Date.now() + ((j.expires_in || 3600) - 300) * 1000 };
  return jetonCache.valeur;
}

// Appel API générique ; sur 401 le jeton est rafraîchi une fois puis l'appel rejoué.
async function appel(chemin, options = {}, deuxieme) {
  const c = config();
  if (!c) throw new Error("Zoho Sign non configuré (client ID, secret et refresh token requis — Paramètres → Signature électronique).");
  // Envoi/mise à jour de document (multipart) : delai plus large, le PDF peut peser plusieurs Mo.
  const delaiMs = options.document ? DELAI_UPLOAD_MS : DELAI_HTTP_MS;
  // Le signal couvre aussi la LECTURE du corps (r.json()/arrayBuffer()) : un
  // fournisseur qui répond vite en-têtes mais dont le corps se bloque doit
  // être rattrapé ici aussi, pas seulement un fetch() qui ne répond jamais.
  try {
    const r = await fetch(c.api + chemin, {
      ...options,
      headers: { Authorization: "Zoho-oauthtoken " + (await jetonAcces(deuxieme)), ...(options.headers || {}) },
      signal: delaiSignal(delaiMs),
    });
    if (r.status === 401 && !deuxieme) return await appel(chemin, options, true);
    const type = r.headers.get("content-type") || "";
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j.message || j.error_description || ""; } catch (e) {}
      throw new Error("Zoho Sign HTTP " + r.status + (detail ? " — " + detail : ""));
    }
    if (type.includes("json")) {
      const j = await r.json();
      // Zoho renvoie parfois 200 avec {status:"failure"} : on le traite en erreur.
      if (j && j.status === "failure") throw new Error("Zoho Sign — " + (j.message || "échec"));
      return j;
    }
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    throw messageDelai("Zoho Sign", delaiMs, e);
  }
}

// Bouton « Tester » : liste une demande — valide OAuth + région + portée.
async function verifier() {
  if (!config()) return { ok: false, message: "Zoho non configuré : client ID, secret et refresh token requis (bouton « Échanger le code »)." };
  try {
    await appel("/requests?page_from=1&page_size=1");
    return { ok: true, message: "Connexion Zoho Sign réussie (région " + config().region + ")." };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// Échange du code « self client » (10 min) contre le refresh token, stocké
// directement dans data/secrets.json — appelé par POST /api/zoho/echanger-code.
async function echangerCode(code) {
  const s = lireSecrets();
  if (!s.zohoClientId || !s.zohoClientSecret) {
    throw new Error("Renseigne et enregistre d'abord le client ID et le client secret Zoho.");
  }
  const region = DOMAINES[s.zohoRegion] ? s.zohoRegion : "eu";
  let r;
  try {
    r = await fetch(DOMAINES[region].comptes + "/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: s.zohoClientId,
        client_secret: s.zohoClientSecret,
        code: String(code || "").trim(),
      }),
      signal: delaiSignal(DELAI_HTTP_MS),
    });
  } catch (e) {
    throw messageDelai("Zoho OAuth", DELAI_HTTP_MS, e);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) {
    throw new Error("Échange refusé : " + (j.error || "HTTP " + r.status) +
      " — le code expire en 10 minutes, régénère-le (API console Zoho, portée ZohoSign.documents.ALL) et vérifie la région (" + region + ").");
  }
  s.zohoRefreshToken = j.refresh_token;
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2));
  jetonCache = { valeur: j.access_token || null, expire: j.access_token ? Date.now() + 3300 * 1000 : 0 };
  return { ok: true, message: "Refresh token Zoho enregistré — connecteur prêt (région " + region + ")." };
}

/** Crée l'enveloppe complète : brouillon (PDF + destinataires, ordre séquentiel,
 * rappels), champs de signature posés aux positions réelles du document, envoi. */
async function creerEnveloppe(params) {
  // Expiration : Zoho compte en JOURS entiers à partir d'aujourd'hui.
  let expiration = 15;
  if (params.echeance) {
    const jours = Math.ceil((new Date(params.echeance + "T23:59:59") - Date.now()) / 86400000);
    expiration = Math.min(Math.max(jours, 1), 90);
  }
  const tries = [...params.signataires].sort((a, b) => (a.rang || 0) - (b.rang || 0));

  // 1. Brouillon : PDF + destinataires (l'ordre signing_order = rang).
  const creation = new FormData();
  creation.append("file", new Blob([params.pdf], { type: "application/pdf" }), params.nomFichier || "contrat.pdf");
  creation.append("data", JSON.stringify({
    requests: {
      request_name: (params.titre + " — " + params.numero).slice(0, 100),
      expiration_days: expiration,
      is_sequential: true,
      email_reminders: true,
      reminder_period: 2,
      actions: tries.map((s) => ({
        action_type: "SIGN",
        recipient_name: s.nom || s.email,
        recipient_email: s.email,
        signing_order: s.rang,
        verify_recipient: false,
      })),
    },
  }));
  const brouillon = await appel("/requests", { method: "POST", body: creation, document: true });
  const demande = brouillon.requests || {};
  const idExterne = String(demande.request_id || "");
  if (!idExterne) throw new Error("Zoho Sign n'a pas renvoyé d'identifiant de demande.");
  const documentId = ((demande.document_ids || [])[0] || {}).document_id;

  // 2. Champs de signature : un par signataire, posé sur le cadre réel du PDF
  //    (page_no Zoho est en base 0 ; x/y en points depuis le haut-gauche).
  const pos = params.positions || {};
  const cotes = [pos.droite, pos.gauche]; // rang 1 = co-contractant (droite), rang 2 = ADBI (gauche)
  const actions = (demande.actions || []).map((a) => {
    const rang = tries.findIndex((s) => s.email === a.recipient_email) ;
    const c = cotes[rang >= 0 ? rang : 0];
    const surPage = c && pos.page ? { page_no: pos.page - 1, x_coord: Math.round(c.x), y_coord: Math.round(c.y) }
                                  : { page_no: 0, x_coord: 60, y_coord: 700 }; // repli : 1re page
    return {
      action_id: a.action_id,
      action_type: "SIGN",
      recipient_name: a.recipient_name,
      recipient_email: a.recipient_email,
      signing_order: a.signing_order,
      verify_recipient: false,
      fields: [{
        field_name: "Signature-" + ((rang >= 0 ? rang : 0) + 1),
        field_label: "Signature",
        field_type_name: "Signature",
        document_id: documentId,
        action_id: a.action_id,
        is_mandatory: true,
        abs_width: 180,
        abs_height: 70,
        ...surPage,
      }],
    };
  });
  const maj = new FormData();
  maj.append("data", JSON.stringify({ requests: { actions } }));
  await appel("/requests/" + idExterne, { method: "PUT", body: maj });

  // 3. Envoi : Zoho expédie l'invitation au 1er signataire (puis aux suivants).
  await appel("/requests/" + idExterne + "/submit", { method: "POST" });

  return {
    idExterne,
    // Zoho n'expose pas de lien direct par signataire dans ce flux : chacun
    // passe par son e-mail d'invitation (rappels automatiques inclus).
    signataires: tries.map((s) => ({ email: s.email, url: "" })),
  };
}

// Correspondance des statuts Zoho → statuts internes.
const STATUTS = { completed: "complete", declined: "annulee", recalled: "annulee", expired: "annulee" };

async function statutEnveloppe(idExterne) {
  const j = await appel("/requests/" + idExterne);
  const d = j.requests || {};
  return {
    statut: STATUTS[d.request_status] || "envoyee",
    statutBrut: d.request_status || "",
    signataires: (d.actions || []).map((a) => ({
      email: a.recipient_email || "",
      statut: a.action_status === "SIGNED" ? "signe" : "attente",
      signeLe: a.signed_time ? new Date(Number(a.signed_time)).toISOString() : "",
    })),
  };
}

async function telechargerSigne(idExterne) {
  return appel("/requests/" + idExterne + "/pdf", { document: true });
}

// Certificat de complétion Zoho = dossier de preuve (horodatages, IP, e-mails).
async function telechargerPreuve(idExterne) {
  try {
    return await appel("/requests/" + idExterne + "/completioncertificate", { document: true });
  } catch (e) {
    return null;
  }
}

module.exports = { config, verifier, echangerCode, creerEnveloppe, statutEnveloppe, telechargerSigne, telechargerPreuve };
