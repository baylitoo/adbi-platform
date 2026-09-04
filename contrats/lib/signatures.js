// Signature électronique des contrats — logique métier des DEMANDES.
//
// Une « demande de signature » fige le contrat (payload + PDF de base archivé)
// puis est confiée à un CONNECTEUR API (lib/fournisseurs/ — Yousign…) qui gère
// invitations, page de signature, relances et dossier de preuve ; ici vivent le
// modèle de la demande, son journal d'événements et les utilitaires d'affichage.
//
// L'ancien flux de signature LOCAL (jetons, images apposées, certificat maison)
// a été retiré en septembre 2026 ; signaturesPourPdf/certificatDe sont conservés
// UNIQUEMENT pour relire les demandes locales signées avant la bascule.
//
// Les données vivent dans la table `signatures` (PostgreSQL, colonne JSONB
// `donnees`, voir lib/db.pg.js), lue/écrite par server.js ; ce module ne
// manipule que des objets JS purs, sans accès base ni HTTP.

function horodatageFr(d) {
  return (d || new Date()).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// Initiales par défaut d'un nom : « Oukli Amine » → « OA » (civilités ignorées).
function initialesDe(nom) {
  const mots = String(nom || "").replace(/\b(monsieur|madame|m\.|mme|mr)\b/gi, "").trim().split(/[\s-]+/).filter(Boolean);
  return mots.slice(0, 3).map((m) => m[0].toUpperCase()).join("") || "??";
}

// Crée l'objet demande (avant insertion en base).
// signataires : [{role, cote: "left"|"right", nom, email}] — DANS L'ORDRE DE SIGNATURE
// (rang 1 signe d'abord ; le suivant est bloqué tant que le précédent n'a pas signé).
function nouvelleDemande({ base, numero, titre, type, payload, empreinte, signataires, echeance }) {
  return {
    base, numero, titre, type,
    // `payload` reste un objet JS ordinaire — PAS de JSON.stringify ici (voir
    // issue #14, PR B) : la demande entière est déjà sérialisée une seule fois
    // par lib/db.pg.js::sauverDemande() au moment de l'écriture en JSONB. La
    // stringifier ici en plus produisait un double-encodage (une chaîne de
    // JSON stockée DANS le JSON), ce que corrige cette PR à la source.
    payload,
    empreinte,
    echeance: echeance || null,  // "AAAA-MM-JJ" : date limite de signature (prolongeable)
    signataires: signataires.map((s, i) => ({
      role: s.role, cote: s.cote, nom: s.nom, email: s.email,
      rang: i + 1,
      statut: "attente",           // attente | signe (synchronisé depuis le fournisseur)
      signeLe: null,               // horodatage FR affichable
    })),
    statut: "envoyee",             // envoyee | complete | annulee
    fournisseur: null,             // connecteur qui porte l'enveloppe (posé à la création : "yousign"…)
    externe: null,                 // { id, signataires:[{email,url}] } — références chez le fournisseur
    // Journal des événements — VALEUR PROBANTE : chaque étape est horodatée
    // (création, invitations, signatures avec IP, prolongations, complétion)
    // et reproduite sur le certificat de signature.
    journal: [{ quand: new Date().toISOString(), evenement: "Création de la demande" }],
    creeLe: new Date().toISOString(),
    completeLe: null,
  };
}

// Ajoute une entrée horodatée au journal de la demande.
function journaliser(demande, evenement) {
  if (!Array.isArray(demande.journal)) demande.journal = [];
  demande.journal.push({ quand: new Date().toISOString(), evenement });
}

// Le signataire dont c'est le tour : premier non signé dans l'ordre de la liste.
function tourDe(demande) {
  return (demande.signataires || []).find((s) => s.statut !== "signe") || null;
}

// Délai dépassé ? (l'échéance reste signable jusqu'à la fin de sa journée)
function estExpiree(demande) {
  if (!demande.echeance || demande.statut !== "envoyee") return false;
  return new Date(demande.echeance + "T23:59:59") < new Date();
}

function echeanceFr(demande) {
  if (!demande.echeance) return "";
  const [a, m, j] = demande.echeance.split("-");
  return j + "/" + m + "/" + a;
}

// Construit le paramètre `signatures` de buildPdf à partir de la demande :
// images (Buffers) des signatures déjà apposées + certificat si demandé.
function signaturesPourPdf(demande) {
  const out = {};
  (demande.signataires || []).forEach((s) => {
    if (s.statut !== "signe" || !s.image) return;
    out[s.cote] = {
      png: Buffer.from(s.image.split(",")[1], "base64"),
      nom: s.nom,
      quand: s.signeLe,
      cachet: s.cachet ? Buffer.from(s.cachet.split(",")[1], "base64") : null,
    };
  });
  // Paraphes : initiales des signataires ayant signé, apposées en bas de chaque page.
  const paraphes = (demande.signataires || [])
    .filter((s) => s.statut === "signe")
    .map((s) => s.initiales)
    .filter(Boolean);
  if (paraphes.length) out.paraphes = paraphes;
  return out;
}

// Données du certificat — rendu dans un DOCUMENT SÉPARÉ (buildCertificatPdf).
function certificatDe(demande) {
  return {
    reference: "SIG-" + (demande.id || "?"),
    document: demande.titre,
    numero: demande.numero,
    empreinte: demande.empreinte,
    creeLe: horodatageFr(new Date(demande.creeLe)),
    echeance: echeanceFr(demande),
    fichier: demande.base + "__SIGNE.pdf",
    signataires: (demande.signataires || []).map((s) => ({
      role: s.role, nom: s.nom, email: s.email, quand: s.signeLe,
      ip: s.ip || "", agent: s.agent || "",
    })),
    // Journal complet (horodatages ISO convertis en français à l'affichage).
    journal: (demande.journal || []).map((j) => ({
      quand: horodatageFr(new Date(j.quand)), evenement: j.evenement,
    })),
  };
}

module.exports = { nouvelleDemande, tourDe, signaturesPourPdf, certificatDe, horodatageFr, initialesDe, estExpiree, echeanceFr, journaliser };
