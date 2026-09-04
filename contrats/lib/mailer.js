// Envoi AUTOMATIQUE des e-mails de signature (nodemailer + SMTP des Paramètres).
//
// Flux façon Zoho Sign : à la création d'une demande, le 1er signataire reçoit
// directement son invitation ; dès qu'il signe, le suivant est invité à son tour ;
// à la fin, chaque partie reçoit le contrat signé + le certificat en pièces jointes.
// Sans SMTP configuré, rien ne part : l'app retombe sur les liens/mailto manuels.

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const SECRETS_PATH = path.join(__dirname, "..", "data", "secrets.json");
const LOGO = path.join(__dirname, "..", "public", "logo-adbi.png");

// Charte CYNOV (e-mails : styles inline, compatibles clients mail).
const BLEU = "#1665c1";
const NUIT = "#0d3a8c";
const ENCRE = "#1b2559";

// Priorité : variable d'environnement, puis secrets.json (même convention
// que lib/integrations.js) — un déploiement Coolify n'a jamais besoin
// d'écrire dans data/secrets.json.
function configSmtp() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")); } catch (e) {}
  const hote = process.env.SMTP_HOST || s.smtpHote;
  const utilisateur = process.env.SMTP_USER || s.smtpUtilisateur;
  const mdp = process.env.SMTP_PASS || s.smtpMdp;
  if (!hote || !utilisateur || !mdp) return null;
  const port = parseInt(process.env.SMTP_PORT || s.smtpPort, 10) || 587;
  return {
    host: hote,
    port,
    secure: port === 465,                 // 465 = SSL direct ; 587/25 = STARTTLS
    auth: { user: utilisateur, pass: mdp },
    expediteur: process.env.SMTP_FROM || s.smtpExpediteur || utilisateur,
  };
}

function transporteur(c) {
  return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.auth });
}

// Test de connexion (bouton « Tester » des Paramètres).
async function verifier() {
  const c = configSmtp();
  if (!c) return { ok: false, message: "SMTP non configuré (hôte, utilisateur et mot de passe requis)." };
  try {
    await transporteur(c).verify();
    return { ok: true, message: "Connexion SMTP réussie (" + c.host + ":" + c.port + ")." };
  } catch (e) {
    return { ok: false, message: "Échec SMTP : " + e.message };
  }
}

// Envoi générique : renvoie { envoye, raison? } — ne lève jamais (les routes
// continuent leur travail même si le mail échoue).
async function envoyer({ a, sujet, texte, html, pieces }) {
  const c = configSmtp();
  if (!c) return { envoye: false, raison: "SMTP non configuré (Paramètres → Envoi des e-mails)." };
  try {
    const attachments = [{ filename: "logo-adbi.png", path: LOGO, cid: "logoadbi" }];
    (pieces || []).forEach((p) => attachments.push(p));
    await transporteur(c).sendMail({
      from: "ADBI Contrats <" + c.expediteur + ">",
      to: a,
      subject: sujet,
      text: texte,
      html,
      attachments,
    });
    return { envoye: true };
  } catch (e) {
    return { envoye: false, raison: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Gabarits HTML — bandeau bleu ADBI + logo + carte + bouton d'action  */
/* ------------------------------------------------------------------ */

function gabarit({ titrePrincipal, corps, bouton }) {
  return (
    '<div style="margin:0;padding:24px 12px;background:#eef2fa;font-family:Segoe UI,Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">' +
    // Bandeau bleu + logo
    '<tr><td style="background:' + NUIT + ';background-image:linear-gradient(120deg,' + NUIT + "," + BLEU + ');border-radius:14px 14px 0 0;padding:22px 28px;" align="left">' +
    '<img src="cid:logoadbi" alt="ADBI" height="40" style="display:block;height:40px;background:#ffffff;border-radius:8px;padding:4px 10px;" />' +
    "</td></tr>" +
    // Carte blanche
    '<tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:28px;border:1px solid #dde4f2;border-top:0;">' +
    '<h1 style="margin:0 0 14px;font-size:19px;color:' + ENCRE + ';">' + titrePrincipal + "</h1>" +
    corps +
    (bouton
      ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr>' +
        '<td style="background:' + BLEU + ';border-radius:999px;">' +
        '<a href="' + bouton.url + '" style="display:inline-block;padding:12px 30px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;">' + bouton.libelle + "</a>" +
        "</td></tr></table>" +
        '<p style="margin:8px 0 0;font-size:11px;color:#8a93ad;">Si le bouton ne fonctionne pas, copiez ce lien : <br/><a href="' + bouton.url + '" style="color:' + BLEU + ';word-break:break-all;">' + bouton.url + "</a></p>"
      : "") +
    "</td></tr>" +
    // Pied
    '<tr><td style="padding:16px 10px;text-align:center;font-size:11px;color:#8a93ad;">' +
    "A.D.B.I — 5 rue du Banquier, 75013 Paris · E-mail automatique du générateur de contrats ADBI, merci de ne pas transférer ce lien personnel." +
    "</td></tr>" +
    "</table></td></tr></table></div>"
  );
}

const p = (t) => '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#333a4f;">' + t + "</p>";
const enc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Invitation à signer (1er signataire à la création ; suivant après chaque signature).
function mailInvitationHtml({ nom, titre, numero, url, echeanceFr, relance, precedentNom }) {
  const corps =
    p("Bonjour <b>" + enc(nom) + "</b>,") +
    (relance
      ? p("<b>" + enc(precedentNom || "L'autre partie") + "</b> vient de signer : c'est maintenant <b>à votre tour</b> de signer électroniquement le document suivant :")
      : p("<b>ADBI</b> vous invite à signer électroniquement le document suivant :")) +
    p("« <b>" + enc(titre) + "</b> » — contrat n° <b>" + enc(numero) + "</b>." +
      (echeanceFr ? "<br/>⏰ Merci de signer avant le <b>" + echeanceFr + "</b>." : "")) +
    p("Le lien ouvre une page où vous pourrez relire le document puis signer (dessin, nom manuscrit ou image), avec paraphe et cachet.");
  return gabarit({
    titrePrincipal: relance ? "À votre tour de signer ✍" : "Invitation à signer un document",
    corps,
    bouton: { url, libelle: "Consulter et signer le document" },
  });
}

// Document complètement signé : envoyé à chaque partie avec les 2 PDF joints.
function mailCompletHtml({ nom, titre, numero }) {
  const corps =
    p("Bonjour <b>" + enc(nom) + "</b>,") +
    p("Toutes les parties ont signé « <b>" + enc(titre) + "</b> » (contrat n° <b>" + enc(numero) + "</b>).") +
    p("Vous trouverez en pièces jointes :<br/>📄 le <b>contrat signé</b> (signatures, paraphes et cachets apposés) ;<br/>🧾 le <b>certificat de signature électronique</b> (horodatages et empreinte du document).") +
    p("Merci de conserver ces deux fichiers ensemble.");
  return gabarit({ titrePrincipal: "Document signé par toutes les parties ✔", corps, bouton: null });
}

module.exports = { envoyer, verifier, configSmtp, mailInvitationHtml, mailCompletHtml };
