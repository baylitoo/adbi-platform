/* Fournisseur de signature YOUSIGN (API v3) — tiers de confiance eIDAS français.
 *
 * Implémente l'interface « FournisseurSignature » (voir lib/fournisseurs/index.js) :
 *   verifier()                        → { ok, message }         (bouton Tester)
 *   creerEnveloppe(params)            → { idExterne, signataires:[{email, url}] }
 *   statutEnveloppe(idExterne)        → { statut, signataires:[{email, statut, signeLe}] }
 *   telechargerSigne(idExterne)       → Buffer (PDF signé, valeur probante Yousign)
 *   telechargerPreuve(idExterne)      → Buffer (dossier de preuve / audit trail) ou null
 *
 * Choix d'implémentation :
 * - Clé API lue dans data/secrets.json (jamais côté navigateur) ; deux modes,
 *   « sandbox » (défaut — gratuit, aucune valeur légale, parfait pour tester)
 *   et « production », avec leurs URL respectives.
 * - delivery_mode "email" : Yousign envoie lui-même les invitations et les
 *   relances aux signataires (plus fiable que notre SMTP pour l'externe).
 * - ordered_signers: true : ordre séquentiel, comme le flux ADBI Sign local.
 * - Les champs de signature sont posés aux COORDONNÉES RÉELLES du cadre
 *   « Signature : » du PDF généré (capturées par render-pdf, sortiePositions).
 */

const fs = require("fs");
const path = require("path");

const SECRETS_PATH = path.join(__dirname, "..", "..", "data", "secrets.json");

function config() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")); } catch (e) {}
  if (!s.yousignCleApi) return null;
  const mode = s.yousignMode === "production" ? "production" : "sandbox";
  return {
    cle: s.yousignCleApi,
    mode,
    base: mode === "production" ? "https://api.yousign.app/v3" : "https://api-sandbox.yousign.app/v3",
    webhookSecret: s.yousignWebhookSecret || "",
  };
}

async function appel(chemin, options = {}) {
  const c = config();
  if (!c) throw new Error("Yousign non configuré (clé API absente — Paramètres → Signature électronique).");
  const r = await fetch(c.base + chemin, {
    ...options,
    headers: {
      Authorization: "Bearer " + c.cle,
      ...(options.corps ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.corps ? JSON.stringify(options.corps) : options.body,
  });
  if (!r.ok) {
    let detail = "";
    try { const j = await r.json(); detail = j.detail || (j.errors && JSON.stringify(j.errors)) || j.title || ""; } catch (e) {}
    if (r.status === 401) throw new Error("Clé API Yousign invalide (mode " + c.mode + ").");
    throw new Error("Yousign HTTP " + r.status + (detail ? " — " + detail : ""));
  }
  const type = r.headers.get("content-type") || "";
  if (type.includes("json")) return r.json();
  return Buffer.from(await r.arrayBuffer());
}

// Bouton « Tester » : un appel authentifié léger suffit à valider clé + mode.
async function verifier() {
  const c = config();
  if (!c) return { ok: false, message: "Clé API Yousign non renseignée." };
  try {
    await appel("/signature_requests?limit=1");
    return { ok: true, message: "Connexion Yousign réussie (mode " + c.mode + ")." };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// « Monsieur Karim BEN SALEM » → { first_name: "Karim", last_name: "BEN SALEM" }
// (Yousign exige prénom ET nom ; les civilités sont écartées, repli sur « — »).
function decouperNom(nom) {
  const mots = String(nom || "").replace(/\b(monsieur|madame|m\.|mme|mr)\b/gi, "").trim().split(/\s+/).filter(Boolean);
  if (!mots.length) return { first_name: "Signataire", last_name: "ADBI" };
  if (mots.length === 1) return { first_name: mots[0], last_name: "—" };
  return { first_name: mots[0], last_name: mots.slice(1).join(" ") };
}

/**
 * Crée l'enveloppe complète : demande + document + signataires (ordre
 * séquentiel) + activation. Renvoie l'identifiant Yousign et, si disponibles,
 * les liens de signature (utiles en mode delivery "none" ou pour affichage).
 *
 * params : { pdf (Buffer), nomFichier, titre, numero, echeance ("AAAA-MM-JJ"),
 *            signataires: [{ nom, email, rang }],  // rang 1 signe d'abord
 *            positions: { page, gauche:{x,y}, droite:{x,y} } }  // cadre Signature du PDF
 */
async function creerEnveloppe(params) {
  // 1. La demande (ordre séquentiel + invitations/relances gérées par Yousign).
  const sr = await appel("/signature_requests", {
    method: "POST",
    corps: {
      name: (params.titre + " — " + params.numero).slice(0, 128),
      delivery_mode: "email",
      ordered_signers: true,
      timezone: "Europe/Paris",
      ...(params.echeance ? { expiration_date: params.echeance } : {}),
    },
  });

  // 2. Le PDF du contrat (multipart — FormData natif de Node 18+).
  const forme = new FormData();
  forme.append("file", new Blob([params.pdf], { type: "application/pdf" }), params.nomFichier || "contrat.pdf");
  forme.append("nature", "signable_document");
  const doc = await appel("/signature_requests/" + sr.id + "/documents", { method: "POST", body: forme });

  // 3. Les signataires, DANS L'ORDRE (rang 1 = co-contractant d'abord),
  //    chacun avec son champ de signature posé sur le cadre du PDF.
  const pos = params.positions || {};
  const cotes = [pos.droite, pos.gauche]; // rang 1 = colonne droite (co-contractant), rang 2 = gauche (ADBI)
  const tries = [...params.signataires].sort((a, b) => (a.rang || 0) - (b.rang || 0));
  for (let i = 0; i < tries.length; i++) {
    const s = tries[i];
    const champ = cotes[i] && pos.page
      ? [{ document_id: doc.id, type: "signature", page: pos.page, x: Math.round(cotes[i].x), y: Math.round(cotes[i].y), width: 180, height: 70 }]
      : [{ document_id: doc.id, type: "signature", page: 1, x: 60, y: 700, width: 180, height: 70 }]; // repli : 1re page
    await appel("/signature_requests/" + sr.id + "/signers", {
      method: "POST",
      corps: {
        info: { ...decouperNom(s.nom), email: s.email, locale: "fr" },
        signature_level: "electronic_signature",
        signature_authentication_mode: "otp_email", // code à usage unique par e-mail (valeur probante)
        fields: champ,
      },
    });
  }

  // 4. Activation : Yousign envoie l'invitation au 1er signataire.
  const active = await appel("/signature_requests/" + sr.id + "/activate", { method: "POST" });
  const liens = (active.signers || []).map((s) => ({
    email: (s.info && s.info.email) || "",
    url: s.signature_link || "",
  }));
  return { idExterne: sr.id, signataires: liens };
}

// Correspondance des statuts Yousign → statuts internes de l'application.
const STATUTS = { done: "complete", canceled: "annulee", declined: "annulee", rejected: "annulee" };

async function statutEnveloppe(idExterne) {
  const sr = await appel("/signature_requests/" + idExterne);
  let signataires = [];
  try {
    const liste = await appel("/signature_requests/" + idExterne + "/signers");
    signataires = (Array.isArray(liste) ? liste : liste.data || []).map((s) => ({
      email: (s.info && s.info.email) || "",
      statut: s.status === "signed" ? "signe" : "attente",
      signeLe: s.signed_at || "",
    }));
  } catch (e) { /* le détail des signataires est optionnel */ }
  return { statut: STATUTS[sr.status] || "envoyee", statutBrut: sr.status, signataires };
}

async function telechargerSigne(idExterne) {
  return appel("/signature_requests/" + idExterne + "/documents/download");
}

// Dossier de preuve (audit trail) : LA pièce à conserver avec le PDF signé.
async function telechargerPreuve(idExterne) {
  try {
    return await appel("/signature_requests/" + idExterne + "/audit_trails/download");
  } catch (e) {
    return null; // selon l'offre, la preuve se télécharge par signataire — non bloquant
  }
}

module.exports = { config, verifier, creerEnveloppe, statutEnveloppe, telechargerSigne, telechargerPreuve };
