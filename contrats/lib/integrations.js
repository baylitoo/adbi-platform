// Intégrations externes : recherche société uniquement.
// Source par défaut : « Recherche d'entreprises » (gouv.fr, gratuit, sans clé) ;
// Pappers ou INSEE Sirene en option (clé requise). Les clés sont lues depuis les
// variables d'environnement OU depuis data/secrets.json (écran Paramètres).
//
// Node 18+ fournit fetch() nativement : aucune dépendance npm supplémentaire.
// NB : toute la partie IA/LLM a été retirée. La vérification des pièces
// justificatives se fait LOCALEMENT via lib/docanalyze.js (pdf-parse + tesseract.js).

const fs = require("fs");
const path = require("path");
const { DELAI_HTTP_MS, delaiSignal, messageDelai } = require("./httpDelai");

const SECRETS_PATH = path.join(__dirname, "..", "data", "secrets.json");

function loadSecrets() {
  try {
    if (fs.existsSync(SECRETS_PATH)) return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
  } catch (e) { /* fichier absent ou corrompu : on repart d'un objet vide */ }
  return {};
}

// Priorité : variable d'environnement, puis secrets.json.
function key(secretName, envName) {
  return (process.env[envName] || loadSecrets()[secretName] || "").trim();
}

// N'écrase une clé que si une nouvelle valeur non vide est fournie.
function saveSettings(body) {
  const cur = loadSecrets();
  [["pappersApiKey"], ["inseeApiKey"]].forEach(([k]) => {
    if (typeof body[k] === "string" && body[k].trim()) cur[k] = body[k].trim();
  });
  if (["gouv", "pappers", "insee"].includes(body.source)) cur.source = body.source;
  // SMTP (envoi automatique des invitations de signature) : champs effaçables —
  // une valeur vide supprime le réglage (contrairement aux clés API ci-dessus).
  ["smtpHote", "smtpPort", "smtpUtilisateur", "smtpMdp", "smtpExpediteur"].forEach((k) => {
    if (typeof body[k] !== "string") return;
    const v = body[k].trim();
    if (v) cur[k] = v;
    else delete cur[k];
  });
  // Connecteur de signature électronique (la signature passe EXCLUSIVEMENT par
  // une API de tiers de confiance). Clé et secret webhook côté serveur
  // UNIQUEMENT — jamais renvoyés au navigateur (voir settingsStatus).
  if (["yousign", "zoho"].includes(body.fournisseurSignature)) cur.fournisseurSignature = body.fournisseurSignature;
  if (["sandbox", "production"].includes(body.yousignMode)) cur.yousignMode = body.yousignMode;
  if (["eu", "com", "in"].includes(body.zohoRegion)) cur.zohoRegion = body.zohoRegion;
  ["yousignCleApi", "yousignWebhookSecret", "zohoClientId", "zohoClientSecret", "zohoWebhookSecret"].forEach((k) => {
    if (typeof body[k] !== "string") return;
    const v = body[k].trim();
    if (v) cur[k] = v;
    else if (body[k] === "") delete cur[k];
  });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(cur, null, 2));
  return settingsStatus();
}

// État renvoyé au front : on expose si une clé est configurée, jamais sa
// valeur — que la source soit une variable d'environnement ou secrets.json.
function settingsStatus() {
  const s = loadSecrets();
  const val = (envName, secretName) => process.env[envName] || s[secretName] || "";
  const hasPappers = !!key("pappersApiKey", "PAPPERS_API_KEY");
  const hasInsee = !!key("inseeApiKey", "INSEE_API_KEY");
  // Source effective : si la source choisie exige une clé absente, on retombe sur "gouv" (gratuit).
  let source = s.source || "gouv";
  if (source === "pappers" && !hasPappers) source = "gouv";
  if (source === "insee" && !hasInsee) source = "gouv";
  const smtpHote = val("SMTP_HOST", "smtpHote");
  const smtpUtilisateur = val("SMTP_USER", "smtpUtilisateur");
  const smtpMdp = val("SMTP_PASS", "smtpMdp");
  return {
    pappers: hasPappers, insee: hasInsee, source,
    smtp: !!(smtpHote && smtpUtilisateur && smtpMdp),
    smtpHote, smtpPort: val("SMTP_PORT", "smtpPort"),
    smtpUtilisateur, smtpExpediteur: val("SMTP_FROM", "smtpExpediteur"),
    // Signature : le connecteur actif + l'état de configuration (jamais les clés).
    fournisseurSignature: s.fournisseurSignature === "local" ? "yousign" : (s.fournisseurSignature || "yousign"),
    yousignMode: (process.env.YOUSIGN_MODE || s.yousignMode) || "sandbox",
    yousignConfigure: !!val("YOUSIGN_API_KEY", "yousignCleApi"),
    yousignWebhook: !!val("YOUSIGN_WEBHOOK_SECRET", "yousignWebhookSecret"),
    zohoRegion: (process.env.ZOHO_REGION || s.zohoRegion) || "eu",
    zohoIdentifiants: !!(val("ZOHO_CLIENT_ID", "zohoClientId") && val("ZOHO_CLIENT_SECRET", "zohoClientSecret")),
    zohoConfigure: !!(val("ZOHO_CLIENT_ID", "zohoClientId") && val("ZOHO_CLIENT_SECRET", "zohoClientSecret") && val("ZOHO_REFRESH_TOKEN", "zohoRefreshToken")),
    zohoWebhook: !!val("ZOHO_WEBHOOK_SECRET", "zohoWebhookSecret"),
  };
}

/* ------------------------------------------------------------------ */
/* Recherche société                                                   */
/* ------------------------------------------------------------------ */

function normalizeSiren(q) {
  const digits = String(q || "").replace(/\D/g, "");
  if (digits.length === 14) return digits.slice(0, 9);   // SIRET -> SIREN
  if (digits.length === 9) return digits;
  throw new Error("Saisir un SIREN (9 chiffres) ou un SIRET (14 chiffres).");
}

async function lookupPappers(siren, token) {
  const url = `https://api.pappers.fr/v2/entreprise?api_token=${encodeURIComponent(token)}&siren=${siren}`;
  // Le signal couvre aussi la LECTURE du corps (r.json()) : un fournisseur
  // qui répond vite en-têtes mais dont le corps se bloque doit être
  // rattrapé ici aussi, pas seulement un fetch() qui ne répond jamais.
  try {
    const r = await fetch(url, { signal: delaiSignal(DELAI_HTTP_MS) });
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j.error || j.message || ""; } catch (e) {}
      if (r.status === 401 || r.status === 403) throw new Error("Clé Pappers invalide ou expirée.");
      if (r.status === 404) throw new Error("Aucune société trouvée pour ce SIREN/SIRET.");
      throw new Error("Pappers : HTTP " + r.status + (detail ? " — " + detail : ""));
    }
    const d = await r.json();
    const siege = d.siege || {};
    const adresse = [siege.adresse_ligne_1, siege.adresse_ligne_2].filter(Boolean).join(" ");
    const ville = [siege.code_postal, siege.ville].filter(Boolean).join(" ");
    const reps = Array.isArray(d.representants) ? d.representants : [];
    const rep = reps.find((x) => x && (x.qualite || x.nom_complet)) || reps[0];
    const repNom = rep ? (rep.nom_complet || [rep.prenom, rep.nom].filter(Boolean).join(" ")).trim() : "";
    return {
      stNom: d.denomination || d.nom_entreprise || "",
      stAdresse: [adresse, ville].filter(Boolean).join(", "),
      stSiren: siren,
      stSiret: siege.siret || "",
      stRepresentant: repNom + (rep && rep.qualite ? " (" + rep.qualite + ")" : ""),
      _source: "Pappers",
    };
  } catch (e) {
    throw messageDelai("Pappers", DELAI_HTTP_MS, e);
  }
}

async function lookupInsee(siren, apiKey) {
  // API Sirene 3.11 (portail api.insee.fr) — clé passée en en-tête.
  const url = `https://api.insee.fr/api-sirene/3.11/siret?q=siren:${siren}%20AND%20etablissementSiege:true&nombre=1`;
  // Le signal couvre aussi la LECTURE du corps (r.json()) : un fournisseur
  // qui répond vite en-têtes mais dont le corps se bloque doit être
  // rattrapé ici aussi, pas seulement un fetch() qui ne répond jamais.
  try {
    const r = await fetch(url, {
      headers: { "X-INSEE-Api-Key-Integration": apiKey, Accept: "application/json" },
      signal: delaiSignal(DELAI_HTTP_MS),
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new Error("Clé INSEE invalide ou non habilitée.");
      if (r.status === 404) throw new Error("Aucun établissement trouvé pour ce SIREN/SIRET.");
      throw new Error("INSEE : HTTP " + r.status);
    }
    const d = await r.json();
    const et = (d.etablissements || [])[0];
    if (!et) throw new Error("Aucun établissement trouvé.");
    const u = et.uniteLegale || {};
    const a = et.adresseEtablissement || {};
    const nom = u.denominationUniteLegale ||
      [u.prenom1UniteLegale, u.nomUniteLegale].filter(Boolean).join(" ");
    const adresse = [a.numeroVoieEtablissement, a.typeVoieEtablissement, a.libelleVoieEtablissement]
      .filter(Boolean).join(" ");
    const ville = [a.codePostalEtablissement, a.libelleCommuneEtablissement].filter(Boolean).join(" ");
    const etat = u.etatAdministratifUniteLegale === "C" ? "cessée" : "active";

    // Établissements : on compte les fermés pour signaler d'éventuelles fermetures.
    // Information secondaire, non bloquante : toute erreur (y compris un délai
    // dépassé) est ignorée, elle a son propre budget de temps.
    let fermes = null, total = null;
    try {
      const r2 = await fetch(
        `https://api.insee.fr/api-sirene/3.11/siret?q=siren:${siren}&champs=siret,etatAdministratifEtablissement&nombre=1000`,
        { headers: { "X-INSEE-Api-Key-Integration": apiKey, Accept: "application/json" }, signal: delaiSignal(DELAI_HTTP_MS) }
      );
      if (r2.ok) {
        const d2 = await r2.json();
        const arr = d2.etablissements || [];
        total = (d2.header && d2.header.total) || arr.length;
        fermes = arr.filter((e) => e.etatAdministratifEtablissement === "F").length;
      }
    } catch (e) { /* information secondaire : on ignore en cas d'échec */ }

    return {
      stNom: nom || "",
      stAdresse: [adresse, ville].filter(Boolean).join(", "),
      stSiren: siren,
      stSiret: et.siret || "",
      stRepresentant: "", // l'INSEE ne fournit pas le représentant légal
      etat,
      etablissementsFermes: fermes,
      etablissementsTotal: total,
      _source: "INSEE",
    };
  } catch (e) {
    throw messageDelai("INSEE", DELAI_HTTP_MS, e);
  }
}

// Forme juridique à partir du code « catégorie juridique » INSEE (nature_juridique).
// Classement par famille de code (correct au niveau catégorie) + détection EI.
function njForme(code) {
  const c = String(code || "");
  if (!c) return { forme: "", ei: false };
  if (c.startsWith("1")) return { forme: "Entrepreneur individuel", ei: true };
  const fam = {
    "52": "Société en nom collectif (SNC)",
    "53": "Société en commandite",
    "54": "SARL",
    "55": "Société anonyme (SA)",
    "57": "SAS",
    "62": "Groupement d'intérêt économique (GIE)",
    "63": "Société coopérative agricole",
    "65": "Société civile",
    "92": "Association déclarée",
  };
  return { forme: fam[c.slice(0, 2)] || "", ei: false };
}

// Source par défaut : API publique « Recherche d'entreprises » (annuaire-entreprises.data.gouv.fr).
// GRATUITE, sans clé ; recherche par SIREN/SIRET ET par nom ; renvoie le dirigeant + le statut.
function mapRechercheEntreprise(e) {
  const s = e.siege || {};
  const adresse = s.geo_adresse ||
    [s.numero_voie, s.type_voie, s.libelle_voie, s.code_postal, s.libelle_commune].filter(Boolean).join(" ");
  const dirs = Array.isArray(e.dirigeants) ? e.dirigeants : [];
  const dir = dirs.find((x) => x && (x.qualite || x.nom || x.denomination)) || dirs[0];
  let repNom = "", qualite = "";
  if (dir) {
    repNom = (dir.denomination || [dir.prenoms, dir.nom].filter(Boolean).join(" ")).trim();
    qualite = dir.qualite || "";
  }
  const total = typeof e.nombre_etablissements === "number" ? e.nombre_etablissements : null;
  const ouverts = typeof e.nombre_etablissements_ouverts === "number" ? e.nombre_etablissements_ouverts : null;
  const fermes = (total != null && ouverts != null) ? Math.max(0, total - ouverts) : null;
  // Établissements remontés par la recherche (jusqu'à 10) → choix du SIRET si plusieurs sites.
  const etabs = (Array.isArray(e.matching_etablissements) ? e.matching_etablissements : []).map((et) => ({
    siret: et.siret || "",
    adresse: et.adresse || [et.code_postal, et.libelle_commune].filter(Boolean).join(" "),
    ville: et.libelle_commune || "",
    estSiege: !!et.est_siege,
    actif: et.etat_administratif === "A",
    enseigne: (Array.isArray(et.liste_enseignes) && et.liste_enseignes[0]) || et.nom_commercial || "",
  }));
  const njCode = String(e.nature_juridique || "");
  const nj = njForme(njCode);
  return {
    stNom: e.nom_raison_sociale || e.nom_complet || "",
    stAdresse: adresse,
    stSiren: e.siren || "",
    stSiret: s.siret || "",
    stRepresentant: repNom,
    qualite: qualite,
    ville: s.libelle_commune || "",
    etat: e.etat_administratif === "C" ? "cessée" : "active",
    formeJuridique: nj.forme,
    natureJuridique: njCode,
    estEI: nj.ei,
    etablissements: etabs,
    etablissementsFermes: fermes,
    etablissementsTotal: total,
    _source: "Recherche d'entreprises (gouv.fr)",
  };
}

async function lookupRechercheEntreprises(query) {
  const q = String(query || "").replace(/\D/g, "");
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&page=1&per_page=1`;
  // Le signal couvre aussi la LECTURE du corps (r.json()) : un fournisseur
  // qui répond vite en-têtes mais dont le corps se bloque doit être
  // rattrapé ici aussi, pas seulement un fetch() qui ne répond jamais.
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: delaiSignal(DELAI_HTTP_MS) });
    if (!r.ok) throw new Error("API Recherche d'entreprises : HTTP " + r.status);
    const d = await r.json();
    const e = (d.results || [])[0];
    if (!e) throw new Error("Aucune entreprise trouvée pour ce SIREN/SIRET.");
    return mapRechercheEntreprise(e);
  } catch (e) {
    throw messageDelai("API Recherche d'entreprises", DELAI_HTTP_MS, e);
  }
}

// Recherche multi-résultats par SIREN/SIRET OU par nom (raison sociale).
async function searchCompanies(query, limit) {
  const q = String(query || "").trim();
  if (q.length < 2) throw new Error("Saisir un nom de société (2 caractères min.) ou un SIREN/SIRET.");
  const per = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 15);
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&page=1&per_page=${per}`;
  // Le signal couvre aussi la LECTURE du corps (r.json()) : cf. lookupRechercheEntreprises.
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: delaiSignal(DELAI_HTTP_MS) });
    if (!r.ok) throw new Error("API Recherche d'entreprises : HTTP " + r.status);
    const d = await r.json();
    return (d.results || []).map(mapRechercheEntreprise);
  } catch (e) {
    throw messageDelai("API Recherche d'entreprises", DELAI_HTTP_MS, e);
  }
}

async function getCompany(q) {
  const siren = normalizeSiren(q); // valide le format (9 ou 14 chiffres)
  const status = settingsStatus();
  if (status.source === "insee" && key("inseeApiKey", "INSEE_API_KEY")) {
    return lookupInsee(siren, key("inseeApiKey", "INSEE_API_KEY"));
  }
  if (status.source === "pappers" && key("pappersApiKey", "PAPPERS_API_KEY")) {
    return lookupPappers(siren, key("pappersApiKey", "PAPPERS_API_KEY"));
  }
  return lookupRechercheEntreprises(siren); // défaut : gratuit, sans clé
}

/* ------------------------------------------------------------------ */
/* Test de connexion (pastille verte/rouge) — sources de recherche     */
/* ------------------------------------------------------------------ */
async function testProvider(name) {
  try {
    if (name === "gouv") {
      await lookupRechercheEntreprises("552120222"); // Danone : entité connue, lecture seule
      return { ok: true, message: "Connecté (API publique gratuite)." };
    }
    if (name === "insee") {
      const k = key("inseeApiKey", "INSEE_API_KEY");
      if (!k) return { ok: false, message: "Clé non configurée." };
      await lookupInsee("552120222", k); // SIREN Danone : société connue, test de lecture
      return { ok: true, message: "Connecté." };
    }
    if (name === "pappers") {
      const t = key("pappersApiKey", "PAPPERS_API_KEY");
      if (!t) return { ok: false, message: "Clé non configurée." };
      await lookupPappers("552120222", t);
      return { ok: true, message: "Connecté." };
    }
    return { ok: false, message: "Fournisseur inconnu." };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

module.exports = { settingsStatus, saveSettings, getCompany, searchCompanies, testProvider };
