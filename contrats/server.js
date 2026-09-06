const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");
const db = require("./lib/db.pg");

const { TEMPLATES } = require("./lib/template");
const { sousTraitance: stFields, optionsSousTraitance, avenant: avFields, cds: cdsFields } = require("./lib/fields");
const { CHECKLISTS } = require("./lib/checklist");
const { buildDocx } = require("./lib/render-docx");
const { buildPdf, buildCertificatPdf } = require("./lib/render-pdf");
const { buildChecklistPdf } = require("./lib/render-checklist");
const { settingsStatus, saveSettings, getCompany, searchCompanies, testProvider } = require("./lib/integrations");
const referentiels = require("./lib/referentiels");
const { analyzeDocumentLocal } = require("./lib/docanalyze");
const signatures = require("./lib/signatures");
const templatesPerso = require("./lib/templates-perso");
const fournisseurs = require("./lib/fournisseurs");

const PORT = Number(process.env.PORT) || 4100;
// Local par defaut (poste de dev) ; le Dockerfile passe ADBI_HOTE=0.0.0.0 —
// sans ca, "127.0.0.1" a l'interieur du conteneur n'est PAS atteignable via
// le port publie ("-p 4100:4100" arrive sur l'interface externe, pas la
// loopback), meme si le HEALTHCHECK (execute dans le meme conteneur) semble
// fonctionner (meme correctif que one-pager/factory/coffre, PR #38/#41).
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
// DATABASE_URL est REQUISE (issue #14, PR B) : ce service ne sait plus parler
// qu'à PostgreSQL — plus de repli sql.js/fichier. Échec net et explicite au
// démarrage plutôt qu'une erreur tardive au premier appel de route.
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante — voir .env.example (PostgreSQL est requis depuis la PR B de l'issue #14).");
  process.exit(1);
}
// Lieu de stockage : un dossier par contrat généré (data/contrats-generes/<base>/),
// alimenté à chaque export et par le flux de signature.
const GENERES_DIR = path.join(__dirname, "data", "contrats-generes");

// Garde-fou : une erreur inattendue est journalisée mais NE coupe PAS le serveur
// (outil local mono-utilisateur : rester en ligne vaut mieux que « connexion refusée »).
process.on("uncaughtException", (e) => console.error("[erreur non gérée]", e && e.message ? e.message : e));
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e && e.message ? e.message : e));
const app = express();
// rawBody conservé : indispensable pour vérifier la signature HMAC des webhooks
// des fournisseurs de signature (l'authenticité se vérifie sur les octets bruts).
app.use(express.json({
  limit: "30mb",
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Santé ----------
// Interrogée par le HEALTHCHECK Docker (voir Dockerfile) — auparavant sur
// "/", qui ne fait que servir index.html en statique et ne dit donc rien de
// la base. Ici, un SELECT 1 réel et borné dans le temps (db.pg.js) : si
// PostgreSQL est injoignable, on répond 503 pour que Docker/Coolify cesse
// de router du trafic vers un conteneur qui répondrait quand même en HTTP.
app.get("/api/sante", async (req, res) => {
  try {
    await db.verifierConnexion();
    res.json({ etat: "pret", base: "ok" });
  } catch (e) {
    res.status(503).json({ etat: "indisponible", base: "ko", erreur: e.message });
  }
});

// ---------- Code d'accès aux Paramètres ----------
// L'écran Paramètres (clés API, modèles de contrat, corbeille) est protégé par
// un code, stocké dans data/code-parametres.txt (modifiable là, sans toucher au
// code). Le navigateur l'envoie dans l'en-tête x-code-parametres après
// déverrouillage ; les routes SENSIBLES le vérifient côté serveur.
//
// ADBI_CODE_PARAMETRES (variable d'environnement) est prioritaire sur le
// fichier : à poser en déploiement pour ne jamais dépendre du code par défaut
// ci-dessous, qui n'a de sens qu'en développement local.
const CODE_PARAM_DEFAUT = "ADbi2027@@";
const CODE_PARAM_FICHIER = path.join(__dirname, "data", "code-parametres.txt");

// Webhooks de signature dont le TRAITEMENT (pas la réception) a échoué — voir
// traiterEvenementSignature ci-dessous. Fichier plutôt que mémoire : la file
// doit survivre à un redémarrage du service, seul moyen de rattraper un
// événement reçu juste avant un arrêt/crash.
const ECHECS_WEBHOOKS_FICHIER = path.join(__dirname, "data", "webhooks-en-echec.json");
// Rejeu automatique toutes les 5 min (réglable, pour les tests notamment).
const ECHEC_WEBHOOK_RELANCE_MS = Number(process.env.ADBI_ECHEC_WEBHOOK_RELANCE_MS) || 5 * 60 * 1000;
// Au-delà, on cesse de rejouer (une enveloppe supprimée chez le fournisseur, une
// clé révoquée… échoueraient sinon indéfiniment, à chaque relance, pour rien —
// même logique de plafond que le reste de l'audit, ex. issue #94/#95) : ~24h
// à raison d'un rejeu toutes les 5 min. L'entrée reste dans le fichier
// (dernière erreur consultable) mais n'est plus rejouée automatiquement.
const MAX_TENTATIVES_WEBHOOK = 288;

function codeParametres() {
  if (process.env.ADBI_CODE_PARAMETRES) return process.env.ADBI_CODE_PARAMETRES.trim();
  try {
    if (!fs.existsSync(CODE_PARAM_FICHIER)) {
      fs.writeFileSync(CODE_PARAM_FICHIER, CODE_PARAM_DEFAUT);
    }
    return fs.readFileSync(CODE_PARAM_FICHIER, "utf8").trim();
  } catch (e) {
    return CODE_PARAM_DEFAUT;
  }
}

function codeValide(code) {
  const attendu = Buffer.from(codeParametres());
  const recu = Buffer.from(String(code || ""));
  return recu.length === attendu.length && crypto.timingSafeEqual(attendu, recu);
}

// Middleware des routes d'administration (écriture des réglages, modèles, corbeille).
function exigerCodeParametres(req, res, next) {
  if (codeValide(req.headers["x-code-parametres"])) return next();
  res.status(401).json({ error: "Code d'accès aux Paramètres requis ou invalide." });
}

// ---------- Stockage des contrats générés + accès signature ----------
function dossierContrat(base) {
  const d = path.join(GENERES_DIR, base.replace(/[^a-zA-Z0-9_-]+/g, "_"));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function archiverFichier(base, nom, buf) {
  // Copie horodatée : les versions successives cohabitent, rien n'est écrasé.
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "_" + p2(d.getHours()) + "h" + p2(d.getMinutes());
  const chemin = path.join(dossierContrat(base), stamp + "__" + nom);
  fs.writeFileSync(chemin, buf);
  return chemin;
}
// Demandes de signature — lecture/écriture directe via lib/db.pg.js
// (chargerDemande/chargerDemandes/sauverDemande, table `signatures`, colonne
// JSONB `donnees`). (L'ancien flux de signature LOCAL — page /signer, jetons,
// invitations SMTP — a été retiré en septembre 2026 : la signature passe
// exclusivement par les CONNECTEURS API de lib/fournisseurs/. Les demandes
// locales déjà signées restent lisibles : PDF et certificat se régénèrent
// depuis leurs données.)
// Vue « suivi » d'une demande : tout sauf les images (lourdes) — les jetons restent
// visibles car l'outil est local mono-utilisateur et ils servent aux boutons copier/mail.
function vueDemande(d) {
  const tour = signatures.tourDe(d);
  return {
    id: d.id, base: d.base, numero: d.numero, titre: d.titre, type: d.type,
    statut: d.statut, creeLe: d.creeLe, completeLe: d.completeLe,
    echeance: d.echeance || "", echeanceFr: signatures.echeanceFr(d),
    expiree: signatures.estExpiree(d),
    fournisseur: d.fournisseur || "local",
    journal: (d.journal || []).length,
    // À qui de signer maintenant (null quand tout est signé ou annulé).
    tour: tour && d.statut === "envoyee" ? { cote: tour.cote, role: tour.role, nom: tour.nom, rang: tour.rang } : null,
    signataires: (d.signataires || []).map((s) => {
      // Lien de signature = celui du FOURNISSEUR (page sécurisée chez lui),
      // quand il l'expose ; sinon le signataire passe par son e-mail d'invitation.
      const externe = ((d.externe && d.externe.signataires) || []).find((x) => x.email === s.email);
      return {
        role: s.role, cote: s.cote, nom: s.nom, email: s.email,
        rang: s.rang || 0, statut: s.statut, signeLe: s.signeLe,
        url: (externe && externe.url) || "",
      };
    }),
  };
}

const FIELDS = { "sous-traitance": stFields, avenant: avFields, cds: cdsFields, cdi: [], cdd: [] };
const OPTIONS = { "sous-traitance": optionsSousTraitance, avenant: [], cds: [], cdi: [], cdd: [] };

function defaults(type) {
  const v = {};
  (FIELDS[type] || []).forEach((f) => (v[f.key] = f.default || ""));
  return v;
}
function optionDefaults(type) {
  const o = {};
  (OPTIONS[type] || []).forEach((op) => (o[op.key] = !!op.default));
  return o;
}

// Fragments OPTIONNELS (clé en …Clause) : rendus « rien » si vide (au lieu de « ……… »),
// sinon avec leur séparateur. Voir lib/render.js (une clé finissant par « Clause » → vide si non renseignée).
function deriveClauses(v) {
  v.craValideParClause = v.craValidePar ? " (" + v.craValidePar + ")" : "";      // CRA : « (Nom) » ou rien
  v.bmEmailClause = v.bmEmail ? " — " + v.bmEmail : "";                            // Suivi : contacts BM
  v.bmTelClause = v.bmTel ? " — " + v.bmTel : "";
  v.consultantFonctionClause = v.consultantFonction ? " — " + v.consultantFonction : ""; // Suivi : intervenant
  v.consultantTelClause = v.consultantTel ? " — " + v.consultantTel : "";
  // Signataire du sous-traitant : la personne qui signe (à défaut, le représentant).
  const stSig = (v.stSignataireNom || "").trim();
  v.sigStNom = stSig || v.stRepresentant || "";
  const stQ = stSig ? (v.stSignataireQualite || "") : (v.stQualite || "");
  v.sigStQualiteClause = stQ ? "En qualité de : " + stQ : "";                     // vide (ex : EI) => rien
  v.clientSignataireQualiteClause = v.clientSignataireFonction ? "En qualité de : " + v.clientSignataireFonction : "";
  // Avenant universel : libellés + désignations des parties selon le type de contrat initial.
  const AVT = {
    "sous-traitance": { short: "CONVENTION DE SOUS-TRAITANCE", def: "la Convention de sous-traitance d'assistance technique", d1: "le Client", d2: "le Sous-Traitant" },
    "cds": { short: "CENTRE DE SERVICES", def: "le Contrat de prestations informatiques du Centre de Services", d1: "le Client", d2: "le Prestataire" },
    "cdi": { short: "CONTRAT CDI", def: "le Contrat de travail à durée indéterminée", d1: "l'Employeur", d2: "le Salarié" },
    "cdd": { short: "CONTRAT CDD", def: "le Contrat de travail à durée déterminée", d1: "l'Employeur", d2: "le Salarié" },
  };
  const at = AVT[v.contratType] || AVT["sous-traitance"];
  v.contratTypeLabelShort = at.short;
  v.contratTypeLabelDef = at.def;
  v.avDesignation1 = at.d1;
  v.avDesignation2 = at.d2;
  v.avPartie1QualiteClause = v.avPartie1Qualite ? ", agissant en qualité de " + v.avPartie1Qualite : "";
  v.avPartie2QualiteClause = v.avPartie2Qualite ? ", agissant en qualité de " + v.avPartie2Qualite : "";
  v.avPartie1QualiteLine = v.avPartie1Qualite ? "En qualité de : " + v.avPartie1Qualite : "";
  v.avPartie2QualiteLine = v.avPartie2Qualite ? "En qualité de : " + v.avPartie2Qualite : "";
  return v;
}

// ---------- API ----------
// Partout ci-dessous : templates EFFECTIFS = base lib/template.js + retouches
// utilisateur (Paramètres → Modèles de contrat), via lib/templates-perso.js.
app.get("/api/types", (req, res) => {
  res.json(Object.values(templatesPerso.effectifs()).map((t) => ({ id: t.id, titre: t.titre, stub: !!t.stub })));
});

app.get("/api/template/:type", (req, res) => {
  const type = req.params.type;
  const tpl = templatesPerso.effectifs()[type];
  if (!tpl) return res.status(404).json({ error: "Type inconnu" });
  res.json({
    titre: tpl.titre,
    stub: !!tpl.stub,
    blocks: tpl.blocks,
    fields: FIELDS[type] || [],
    options: OPTIONS[type] || [],
    checklist: CHECKLISTS[type] || [],
    defaults: defaults(type),
    optionDefaults: optionDefaults(type),
    // Méta d'en-tête (aperçu) — l'avenant a un en-tête différent + dès la 1re page.
    headerTitle: tpl.headerTitle || "",
    headerNum: tpl.headerNum || "",
    headerOnFirst: !!tpl.headerOnFirst,
  });
});

function resolveBody(body) {
  const type = body.type || "sous-traitance";
  const tpl = templatesPerso.effectifs()[type];
  const values = Object.assign(defaults(type), body.values || {});
  deriveClauses(values);
  const options = Object.assign(optionDefaults(type), body.options || {});
  // Clauses optionnelles TOUJOURS incluses (choix utilisateur sept. 2026) — même
  // pour les contrats anciens rechargés depuis l'historique avec options décochées.
  Object.keys(options).forEach((k) => { options[k] = true; });
  return { type, tpl, values, options };
}
function resolve(req) {
  return resolveBody(req.body);
}

function fileBase(values) {
  const st = (values.stNom || "sous-traitant").replace(/[^a-zA-Z0-9]+/g, "_");
  const num = (values.numeroContrat || "contrat").replace(/[^a-zA-Z0-9-]+/g, "_");
  return `Convention_ADBI_${st}_${num}`;
}

app.post("/api/export/docx", async (req, res) => {
  try {
    const { tpl, values, options } = resolve(req);
    if (!tpl || tpl.stub) return res.status(400).json({ error: "Mod\u00E8le non disponible pour ce type." });
    const buf = await buildDocx(tpl, values, options);
    try { archiverFichier(fileBase(values), fileBase(values) + ".docx", buf); } catch (e) { console.error("[archivage]", e.message); }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase(values)}.docx"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post("/api/export/pdf", async (req, res) => {
  try {
    const { tpl, values, options } = resolve(req);
    if (!tpl || tpl.stub) return res.status(400).json({ error: "Mod\u00E8le non disponible pour ce type." });
    const buf = await buildPdf(tpl, values, options);
    try { archiverFichier(fileBase(values), fileBase(values) + ".pdf", buf); } catch (e) { console.error("[archivage]", e.message); }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase(values)}.pdf"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post("/api/export/zip", async (req, res) => {
  try {
    const { type, tpl, values, options } = resolve(req);
    if (!tpl || tpl.stub) return res.status(400).json({ error: "Mod\u00E8le non disponible pour ce type." });
    const doneMap = req.body.checklist || {};
    const [docx, pdf, checkPdf] = await Promise.all([
      buildDocx(tpl, values, options),
      buildPdf(tpl, values, options),
      buildChecklistPdf(CHECKLISTS[type] || [], values, doneMap),
    ]);
    const base = fileBase(values);
    try {
      archiverFichier(base, base + ".pdf", pdf);
      archiverFichier(base, base + ".docx", docx);
    } catch (e) { console.error("[archivage]", e.message); }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.zip"`);
    const arch = archiver("zip", { zlib: { level: 9 } });
    arch.on("error", (e) => { throw e; });
    arch.pipe(res);
    arch.append(pdf, { name: `${base}.pdf` });
    arch.append(docx, { name: `${base}.docx` });
    arch.append(checkPdf, { name: `Checklist_documents_${(values.stNom || "ST").replace(/[^a-zA-Z0-9]+/g, "_")}.pdf` });
    arch.finalize();
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ---------- Personnalisation des modèles (Paramètres → Modèles de contrat) ----------
// Vue d'édition : blocs de texte (originaux + texte effectif) et métadonnées du modèle.
app.get("/api/templates-perso/:type", (req, res) => {
  try {
    const type = req.params.type;
    const base = TEMPLATES[type];
    if (!base) return res.status(404).json({ error: "Type inconnu" });
    const eff = templatesPerso.effectifs()[type];
    res.json({
      type,
      stub: !!base.stub,
      titre: eff.titre,
      meta: templatesPerso.META_DEFS.map((m) => ({
        cle: m.cle, libelle: m.libelle, defaut: m.defaut,
        original: String(base[m.cle] || ""), texte: String(eff[m.cle] || ""),
      })),
      blocs: base.blocks
        .map((b, i) => ({ i, t: b.t, original: b.x, texte: eff.blocks[i].x, modifie: eff.blocks[i].x !== b.x }))
        .filter((b) => typeof b.original === "string"),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/templates-perso/:type", exigerCodeParametres, async (req, res) => {
  try { res.json(await templatesPerso.sauver(req.params.type, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Retour complet au modèle d'origine pour ce type.
app.delete("/api/templates-perso/:type", exigerCodeParametres, async (req, res) => {
  try {
    await templatesPerso.reinitialiser(req.params.type);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Recherche société (gouv.fr / Pappers / INSEE) ----------
app.get("/api/settings", (req, res) => res.json(settingsStatus()));

// Déverrouillage de l'écran Paramètres (le code vit dans data/code-parametres.txt).
app.post("/api/parametres/verifier", (req, res) => {
  if (codeValide(req.body && req.body.code)) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: "Code invalide." });
});

app.post("/api/settings", exigerCodeParametres, (req, res) => {
  try { res.json(saveSettings(req.body || {})); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post("/api/lookup", async (req, res) => {
  try { res.json(await getCompany(req.body && req.body.q)); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.post("/api/search", async (req, res) => {
  try { res.json({ results: await searchCompanies(req.body && req.body.q) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Analyse LOCALE des pièces (Kbis/URSSAF) — sans LLM, sans envoi externe.
app.post("/api/document/analyze", async (req, res) => {
  try { res.json(await analyzeDocumentLocal(req.body || {})); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// ── Frein sur les appels amont des connecteurs de signature ─────────────────
// GET /api/test/:provider (branche yousign/zoho, ci-dessous) et POST
// /api/signatures/:id/synchroniser (plus bas) sont publics et sans
// authentification, contrairement à /api/settings (exigerCodeParametres) —
// même trou que la recherche société (#132/#133), jamais porté ici : chaque
// appel relayait un test ou un statutEnveloppe/téléchargement RÉEL vers
// Yousign/Zoho Sign, sans aucune limite. Contrairement au SIREN de #132
// (paramètre libre), l'identifiant de demande est borné aux demandes
// réellement créées, mais un balayage de ces identifiants épuiserait quand
// même le quota/la limite de débit du fournisseur, cassant la signature
// électronique pour l'usage légitime (création d'enveloppe, webhook de statut).
//
// Cache court (5 s — la synchronisation doit rester quasi temps réel pour
// « est-ce signé ? », contrairement aux 60 s tolérables pour une fiche
// société) + coalescence des appels concurrents identiques, ET plafond
// glissant par fournisseur (comme #133) car l'identifiant de demande varie
// d'un appel à l'autre — un cache seul ne freinerait pas un balayage.
const CACHE_FOURNISSEUR_MS = 5000;
const PLAFOND_FOURNISSEUR = 20; // appels amont / fournisseur / fenêtre
const FENETRE_PLAFOND_MS = 60000;
const cacheAppelsFournisseur = new Map(); // cle -> { expire, promesse }
const historiqueAppelsFournisseur = new Map(); // fournisseur -> [horodatages]

function avecCacheEtPlafond(fournisseur, cle, tache) {
  const maintenant = Date.now();
  const entree = cacheAppelsFournisseur.get(cle);
  if (entree && entree.expire > maintenant) return entree.promesse;

  const horodatages = (historiqueAppelsFournisseur.get(fournisseur) || [])
    .filter((t) => maintenant - t < FENETRE_PLAFOND_MS);
  if (horodatages.length >= PLAFOND_FOURNISSEUR) {
    const err = new Error("Trop d'appels vers " + fournisseur + " — réessaie dans quelques instants.");
    err.status = 429;
    return Promise.reject(err);
  }
  horodatages.push(maintenant);
  historiqueAppelsFournisseur.set(fournisseur, horodatages);

  const promesse = Promise.resolve().then(tache);
  cacheAppelsFournisseur.set(cle, { expire: maintenant + CACHE_FOURNISSEUR_MS, promesse });
  // Un échec ne doit pas rester en cache : le prochain appel doit pouvoir réessayer.
  promesse.catch(() => cacheAppelsFournisseur.delete(cle));
  return promesse;
}

app.get("/api/test/:provider", async (req, res) => {
  try {
    if (req.params.provider === "yousign") {
      return res.json(await avecCacheEtPlafond("yousign", "test:yousign", () => fournisseurs.externe("yousign").verifier()));
    }
    if (req.params.provider === "zoho") {
      return res.json(await avecCacheEtPlafond("zoho", "test:zoho", () => fournisseurs.externe("zoho").verifier()));
    }
    res.json(await testProvider(req.params.provider));
  } catch (e) { res.status(e.status || 500).json({ ok: false, message: e.message }); }
});

// Référentiels (clients + valideurs CRA + lieux, managers)
app.get("/api/referentiels", (req, res) => res.json(referentiels.load()));
app.post("/api/referentiels", (req, res) => {
  try { res.json(referentiels.save(req.body || {})); }
  catch (e) {
    // Conflit de version (issue #84) : quelqu'un d'autre a sauvegardé entre
    // la lecture et cet envoi — on renvoie l'état courant pour que le client
    // se resynchronise, plutôt que d'écraser silencieusement son travail.
    if (e.code === "REF_CONFLICT") return res.status(409).json({ error: e.message, referentiels: e.actuel });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

// ---------- Fichiers stockés par contrat ----------
// path.basename NE bloque PAS ".." (il ne fait que retirer les séparateurs :
// path.basename("..") === "..") — un segment ":base"/":nom" valant ".." passait
// donc intact à path.join et en ressortait hors de GENERES_DIR (issue #116).
// On exige ici un segment "plat" (ni "." ni ".." ni séparateur) ET on vérifie
// en plus que le chemin résolu reste sous GENERES_DIR, comme le fait déjà
// factory/server.js pour ses fichiers statiques.
function segmentFichier(s) {
  const v = String(s || "");
  return v && v !== "." && v !== ".." && v === path.basename(v) ? v : "";
}

app.get("/api/fichiers/:base", (req, res) => {
  try {
    const base = segmentFichier(req.params.base);
    if (!base) return res.status(400).json({ error: "Identifiant de contrat invalide." });
    const d = path.join(GENERES_DIR, base);
    if (!d.startsWith(GENERES_DIR + path.sep) || !fs.existsSync(d)) return res.json([]);
    const rows = fs.readdirSync(d).map((nom) => {
      const st = fs.statSync(path.join(d, nom));
      return { nom, taille: st.size, modifieLe: st.mtime.toISOString() };
    }).sort((a, b) => b.modifieLe.localeCompare(a.modifieLe));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/fichiers/:base/:nom", (req, res) => {
  const base = segmentFichier(req.params.base);
  const nom = segmentFichier(req.params.nom);
  if (!base || !nom) return res.status(404).json({ error: "Fichier introuvable" });
  const chemin = path.join(GENERES_DIR, base, nom);
  if (!chemin.startsWith(GENERES_DIR + path.sep) || !fs.existsSync(chemin)) {
    return res.status(404).json({ error: "Fichier introuvable" });
  }
  res.download(chemin);
});

// ---------- Signature électronique (façon Zoho Sign, en local) ----------
// Création d'une demande : fige le contrat courant, archive le PDF transmis,
// crée un lien personnel par signataire (partie1 = ADBI/gauche, partie2 = co-contractant/droite).
app.post("/api/signatures", async (req, res) => {
  try {
    const { type, tpl, values, options } = resolve(req);
    if (!tpl || tpl.stub) return res.status(400).json({ error: "Modèle non disponible pour ce type." });
    const p1 = (req.body.signataires || {}).partie1 || {};
    const p2 = (req.body.signataires || {}).partie2 || {};
    if (!p1.email || !p2.email) return res.status(400).json({ error: "Les deux adresses e-mail sont requises." });

    const pdfBase = await buildPdf(tpl, values, options);
    const base = fileBase(values);
    archiverFichier(base, base + "__POUR-SIGNATURE.pdf", pdfBase);

    // Délai de signature : date du formulaire, sinon J+7 par défaut (prolongeable ensuite).
    let echeance = String(req.body.echeance || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(echeance)) {
      const d7 = new Date(Date.now() + 7 * 86400000);
      echeance = d7.toISOString().slice(0, 10);
    }
    // Le suivi de signature vit DANS l'historique : si ce contrat n'y est pas
    // encore (jamais enregistré), on l'y ancre pour que la demande ait sa ligne.
    const col = colonnesContrat(type, values);
    const dejaEnregistre = await db.contratExiste(col.numero, col.sousTraitant);
    if (!dejaEnregistre) {
      await db.sauverContrat({
        numero: col.numero, type, sousTraitant: col.sousTraitant, clientFinal: col.clientFinal,
        payload: { type, values: req.body.values || {}, options: req.body.options || {} },
      });
    }

    const demande = signatures.nouvelleDemande({
      base,
      numero: values.numeroContrat || values.numeroAvenant || "",
      titre: tpl.titre,
      type,
      echeance,
      payload: { type, values: req.body.values || {}, options: req.body.options || {} },
      empreinte: crypto.createHash("sha256").update(pdfBase).digest("hex"),
      // Ordre de signature imposé : le co-contractant (partie 2) signe EN PREMIER,
      // ADBI signe ensuite — et l'app affiche « À vous de signer » quand c'est son tour.
      signataires: [
        { role: p2.role || "Sous-Traitant", cote: "right", nom: p2.nom || "", email: p2.email },
        { role: p1.role || "Client (ADBI)", cote: "left", nom: p1.nom || "", email: p1.email },
      ],
    });
    // ── La signature passe EXCLUSIVEMENT par un connecteur API (tiers de
    // confiance eIDAS) : il gère invitations, relances, OTP, page de signature
    // et dossier de preuve. Aucun repli local : une erreur doit se voir.
    const actif = fournisseurs.fournisseurActif();
    const fournisseur = fournisseurs.externe(actif);
    if (!fournisseur) {
      return res.status(400).json({ error: "Aucun connecteur de signature disponible — configure Yousign dans Paramètres → Signature électronique." });
    }
    try {
      // Reconstruire le PDF en capturant les positions réelles des cadres de
      // signature (le champ du fournisseur tombe pile sur le cadre du document).
      const positions = {};
      const pdfPourEnveloppe = await buildPdf(tpl, values, options, { sortiePositions: positions });
      const env = await fournisseur.creerEnveloppe({
        pdf: pdfPourEnveloppe,
        nomFichier: base + ".pdf",
        titre: demande.titre,
        numero: demande.numero,
        echeance: demande.echeance,
        signataires: demande.signataires.map((s) => ({ nom: s.nom, email: s.email, rang: s.rang })),
        positions,
      });
      demande.fournisseur = actif;
      demande.externe = { id: env.idExterne, signataires: env.signataires || [] };
      signatures.journaliser(demande, "Enveloppe créée chez " + actif + " (réf. " + env.idExterne + ") — invitations envoyées par le fournisseur");
      // À ce stade le fournisseur a DÉJÀ activé l'enveloppe et envoyé les
      // invitations/OTP aux vrais signataires — ce n'est plus annulable
      // silencieusement. Un échec de sauvegarde ICI (panne DB passagère,
      // pool épuisé…) ne doit surtout pas retomber dans le catch générique
      // ci-dessous : celui-ci blâme le "Connecteur" (message pensé pour un
      // échec CHEZ le fournisseur, ex. clé API invalide) alors que le
      // fournisseur a réussi — l'utilisateur irait vérifier sa clé API pour
      // rien, puis relancerait "Envoyer pour signature", créant une SECONDE
      // enveloppe et un second jeu d'invitations pour le même contrat. Sans
      // ligne enregistrée, `env.idExterne` est aussi la SEULE trace qui
      // reste de cette enveloppe (aucun id de demande, rien dans /api/signatures) :
      // on la journalise et on la renvoie explicitement plutôt que de la perdre.
      try {
        await db.sauverDemande(demande);
      } catch (eSauvegarde) {
        console.error(
          "[signatures] Enveloppe " + actif + " " + env.idExterne + " créée et activée " +
          "(invitations déjà envoyées) mais NON enregistrée dans ADBI Contrats : " + eSauvegarde.message
        );
        return res.status(500).json({
          error: "Le document a été envoyé pour signature chez " + actif + " (référence " + env.idExterne +
            ") et les invitations sont déjà parties, mais l'enregistrement dans ADBI Contrats a échoué (" +
            eSauvegarde.message + "). Ne relancez pas l'envoi : contactez un administrateur avec cette référence.",
        });
      }
      res.json({
        ok: true,
        demande: vueDemande(demande),
        envoiAuto: { envoye: true, destinataire: demande.signataires[0].email, fournisseur: actif },
      });
    } catch (e) {
      res.status(502).json({ error: "Connecteur " + actif + " : " + e.message + " — vérifie la clé et le mode dans Paramètres → Signature électronique (bouton Tester)." });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Verrou par demande (issue #55) ───────────────────────────────────────────
// synchroniserDemandeExterne lit une demande, interroge le fournisseur externe
// (appel HTTP potentiellement long) puis réécrit la ligne ENTIÈRE via
// db.sauverDemande (UPDATE signatures SET donnees=... — sans verrou ni
// contrôle de version). Deux déclenchements concurrents sur la MÊME demande —
// le bouton « Synchroniser » et le webhook du fournisseur, ou deux livraisons
// du même webhook (les fournisseurs redélivrent en cas de doute) — peuvent
// tous deux lire l'état d'avant, muter chacun leur copie (journal, statuts,
// archivage du signé/preuve) et écrire : le dernier à écrire efface
// silencieusement le travail de l'autre, y compris des entrées du `journal`
// documenté comme VALEUR PROBANTE et reproduit sur le certificat de
// signature. Même remède que le lost update de cv-parser (issue #53/#54) :
// un verrou en mémoire par identifiant de demande, cohérent avec le process
// Node mono-instance de ce service, qui sérialise tout le cycle
// lecture -> appel fournisseur -> écriture — la (re)lecture de la demande se
// fait DANS le verrou, pas seulement l'appel externe, sinon le second
// arrivant travaillerait quand même sur une copie périmée.
const verrousDemande = new Map();

function avecVerrouDemande(id, tache) {
  const precedent = verrousDemande.get(id) || Promise.resolve();
  const courant = precedent.catch(() => {}).then(tache);
  verrousDemande.set(id, courant);
  // Nettoyage du registre une fois cette tâche terminée (succès ou échec),
  // sur une branche distincte qui avale l'erreur : ne doit jamais produire de
  // rejet non intercepté, `courant` (retourné à l'appelant) reste la seule
  // promesse dont l'échec compte pour lui.
  courant.catch(() => {}).finally(() => {
    if (verrousDemande.get(id) === courant) verrousDemande.delete(id);
  });
  return courant;
}

// Synchronisation d'une demande EXTERNE : statut, signataires, et à la fin
// téléchargement du PDF signé + du dossier de preuve, archivés dans le dossier.
async function synchroniserDemandeExterne(d) {
  const fournisseur = fournisseurs.externe(d.fournisseur);
  if (!fournisseur || !d.externe || !d.externe.id) throw new Error("Demande sans enveloppe externe.");
  const etat = await fournisseur.statutEnveloppe(d.externe.id);
  (etat.signataires || []).forEach((se) => {
    const s = (d.signataires || []).find((x) => x.email === se.email);
    if (s && se.statut === "signe" && s.statut !== "signe") {
      s.statut = "signe";
      s.signeLe = se.signeLe ? new Date(se.signeLe).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : signatures.horodatageFr();
      signatures.journaliser(d, "Signature de " + s.nom + " (" + d.fournisseur + ")");
    }
  });
  if (etat.statut === "complete" && d.statut !== "complete") {
    d.statut = "complete";
    d.completeLe = new Date().toISOString();
    signatures.journaliser(d, "Document signé par toutes les parties (" + d.fournisseur + ")");
    try {
      const signe = await fournisseur.telechargerSigne(d.externe.id);
      archiverFichier(d.base, d.base + "__SIGNE-" + d.fournisseur.toUpperCase() + ".pdf", signe);
      const preuve = await fournisseur.telechargerPreuve(d.externe.id);
      if (preuve) archiverFichier(d.base, d.base + "__PREUVE-" + d.fournisseur.toUpperCase() + ".pdf", preuve);
      signatures.journaliser(d, "PDF signé et dossier de preuve archivés");
    } catch (e) {
      signatures.journaliser(d, "Téléchargement du signé/preuve à refaire : " + e.message);
    }
  } else if (etat.statut === "annulee") {
    d.statut = "annulee";
    signatures.journaliser(d, "Demande refusée ou annulée chez le fournisseur");
  }
  await db.sauverDemande(d);
  return d;
}

// Point d'entrée verrouillé : recharge la demande DANS le verrou puis la
// synchronise si elle a un fournisseur externe. Renvoie la demande à jour
// (fraîchement relue, éventuellement synchronisée), ou null si elle n'existe
// plus (supprimée entre-temps).
function synchroniserDemandeExterneParId(id) {
  return avecVerrouDemande(id, async () => {
    const d = await db.chargerDemande(id);
    if (!d) return null;
    if (d.fournisseur === "local") return d;
    // Cache + plafond partagés avec /api/test/:provider (voir avecCacheEtPlafond
    // ci-dessus) : sans eux, POST /api/signatures/:id/synchroniser — public,
    // sans authentification — relayait un statutEnveloppe/téléchargement RÉEL
    // vers Yousign/Zoho à chaque appel, y compris un même id spammé ou balayé.
    return avecCacheEtPlafond(d.fournisseur, "sync:" + d.fournisseur + ":" + id, () => synchroniserDemandeExterne(d));
  });
}

app.post("/api/signatures/:id/synchroniser", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const d = await synchroniserDemandeExterneParId(id);
    if (!d) return res.status(404).json({ error: "Demande introuvable" });
    res.json({ ok: true, demande: vueDemande(d) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ── File des webhooks dont le TRAITEMENT a échoué ────────────────────────────
// La route répond 200 avant tout traitement (voir plus bas) : un fournisseur
// ne redélivre PAS un webhook déjà acquitté en 2xx. Si la synchronisation qui
// suit échoue ensuite (Postgres injoignable pile à ce moment, timeout réseau
// vers le fournisseur…), l'événement — potentiellement « document signé par
// toutes les parties », avec l'archivage du PDF signé et du dossier de
// preuve qui va avec — était jusqu'ici simplement perdu (un console.error,
// rien de plus) : la demande restait bloquée au statut "envoyée" tant que
// personne ne remarquait l'écart et ne cliquait manuellement sur
// « Synchroniser le statut ». Fichier (et non mémoire) pour survivre à un
// redémarrage du service, et rejeu automatique ci-dessous plutôt que de
// compter sur un humain qui doit d'abord soupçonner le problème.
function chargerEchecsWebhooks() {
  try { return JSON.parse(fs.readFileSync(ECHECS_WEBHOOKS_FICHIER, "utf8")); }
  catch (e) { return []; }
}
function sauverEchecsWebhooks(liste) {
  try {
    fs.mkdirSync(path.dirname(ECHECS_WEBHOOKS_FICHIER), { recursive: true });
    fs.writeFileSync(ECHECS_WEBHOOKS_FICHIER, JSON.stringify(liste, null, 2));
  } catch (e) { console.error("[webhook signature] file d'échecs illisible/inscriptible :", e.message); }
}
// `fournisseur` ("yousign"/"zoho") est conservé dans l'entrée dès sa création
// (déjà connu de l'appelant, qui vient de reconnaître la forme du payload) —
// même s'il n'est pas encore exploité par la recherche ci-dessous, pour ne
// pas avoir à re-migrer ce fichier le jour où cette recherche filtrera aussi
// par fournisseur (voir note dans traiterEvenementSignature).
function enregistrerEchecWebhook(idExterne, fournisseur, message) {
  const liste = chargerEchecsWebhooks();
  const existant = liste.find((x) => x.idExterne === idExterne);
  const maintenant = new Date().toISOString();
  if (existant) {
    existant.tentatives = (existant.tentatives || 1) + 1;
    existant.derniereErreur = message;
    existant.derniereTentativeLe = maintenant;
    if (fournisseur) existant.fournisseur = fournisseur;
  } else {
    liste.push({ idExterne, fournisseur: fournisseur || null, recuLe: maintenant, tentatives: 1, derniereErreur: message, derniereTentativeLe: maintenant });
  }
  sauverEchecsWebhooks(liste);
}
function retirerEchecWebhook(idExterne) {
  const liste = chargerEchecsWebhooks();
  const suivante = liste.filter((x) => x.idExterne !== idExterne);
  if (suivante.length !== liste.length) sauverEchecsWebhooks(suivante);
}
function marquerAbandonWebhook(idExterne) {
  const liste = chargerEchecsWebhooks();
  const entree = liste.find((x) => x.idExterne === idExterne);
  if (entree && !entree.abandonne) { entree.abandonne = true; sauverEchecsWebhooks(liste); }
}

// Synchronise la demande correspondant à idExterne (identifiant déjà vérifié
// — HMAC le cas échéant — par l'appelant). Toute erreur ici est un problème
// de TRAITEMENT (base injoignable, appel fournisseur en échec…), pas une
// donnée douteuse : on la garde en file pour rejeu plutôt que de la perdre.
//
// NB : la recherche ci-dessous ne filtre PAS encore par fournisseur (elle
// reprend le comportement actuel de la route) — `fournisseur` n'est là que
// pour être déjà disponible dans la file d'échecs le jour où ce filtre est
// ajouté (voir issue du contournement HMAC cross-fournisseur, corrigé côté
// vérification de signature indépendamment de ce correctif-ci).
async function traiterEvenementSignature(idExterne, fournisseur) {
  try {
    // La recherche par id externe se fait hors verrou (simple lecture) ; seule
    // la synchronisation elle-même (relecture + appel fournisseur + écriture)
    // passe par synchroniserDemandeExterneParId, verrouillée par demande —
    // deux livraisons du même webhook, ou ce webhook et le bouton manuel,
    // sérialisent alors sur la même demande au lieu de s'écraser l'un l'autre.
    const demandes = await db.chargerDemandes();
    const d = demandes.find((x) => x.externe && x.externe.id === idExterne);
    if (d) await synchroniserDemandeExterneParId(d.id);
    retirerEchecWebhook(idExterne);
  } catch (e) {
    console.error("[webhook signature]", e.message);
    enregistrerEchecWebhook(idExterne, fournisseur, e.message);
  }
}

// Rejeu de tous les événements en file — appelé au démarrage (rattrape ce qui
// a échoué avant un redémarrage/crash) puis toutes les ECHEC_WEBHOOK_RELANCE_MS
// (rattrape une panne Postgres/fournisseur transitoire sans intervention).
// Au-delà de MAX_TENTATIVES_WEBHOOK, on cesse de rejouer une entrée qui
// échoue systématiquement (enveloppe supprimée chez le fournisseur, clé
// révoquée…) : elle resterait sinon rejouée — et donc à rappeler l'API du
// fournisseur — indéfiniment, toutes les 5 min, pour rien. L'entrée reste
// dans le fichier (dernière erreur consultable) mais n'est plus retentée.
async function rejouerEchecsWebhooks() {
  // Chaque itération relit/réécrit le fichier depuis le disque (via
  // traiterEvenementSignature / marquerAbandonWebhook) plutôt que de réutiliser
  // ce tableau une fois toutes les entrées traitées : sinon, la sauvegarde
  // finale d'un instantané devenu périmé écraserait les mises à jour
  // (tentatives, suppression) faites entre-temps sur les AUTRES entrées.
  for (const entree of chargerEchecsWebhooks()) {
    if ((entree.tentatives || 0) >= MAX_TENTATIVES_WEBHOOK) {
      if (!entree.abandonne) {
        console.error(
          "[webhook signature] abandon du rejeu pour " + entree.idExterne + " après " + entree.tentatives +
          " tentatives — dernière erreur : " + entree.derniereErreur + " (à traiter manuellement si besoin)"
        );
        marquerAbandonWebhook(entree.idExterne);
      }
      continue;
    }
    await traiterEvenementSignature(entree.idExterne, entree.fournisseur);
  }
}

// Webhook du fournisseur de signature (à déclarer chez lui vers
// http(s)://<hôte>/webhooks/signature). Vérification HMAC si un secret est
// configuré ; sinon le webhook déclenche simplement une synchronisation —
// AUCUNE donnée du webhook n'est crue sur parole, on relit l'API.
app.post("/webhooks/signature", async (req, res) => {
  res.status(200).json({ ok: true }); // répondre vite : le traitement suit
  try {
    // Format Yousign : {data:{signature_request:{id}}} + en-tête HMAC
    // (X-Yousign-Signature-256, hex) vérifié si le secret est configuré.
    // Format Zoho Sign : {requests:{request_id}} + en-tête HMAC
    // (X-ZS-Webhook-Signature, base64) vérifié si le secret est configuré.
    // Dans tous les cas le contenu N'EST PAS cru : on relit l'API du fournisseur.
    //
    // `fournisseurWebhook` est déterminé UNE FOIS ici à partir de la forme du
    // corps, et sert ensuite à la fois à choisir QUEL secret vérifier et à
    // filtrer la recherche de la demande (voir plus bas) : sans ce filtre, un
    // attaquant qui connaît l'id externe d'UNE demande Yousign pouvait
    // l'envoyer emballé dans la forme Zoho ({requests:{request_id}}) — le
    // code ne consultait alors JAMAIS le secret webhook Yousign configuré
    // (branche `else if`, jamais atteinte pour cette forme), et la recherche
    // ci-dessous ne filtrait pas non plus par fournisseur : la vérification
    // HMAC de l'administrateur était donc totalement contournable.
    const corps = req.body || {};
    let fournisseurWebhook = null;
    let idExterne = corps.data && corps.data.signature_request && corps.data.signature_request.id;
    let fournisseurWebhook;
    if (idExterne) {
      fournisseurWebhook = "yousign";
      const y = fournisseurs.externe("yousign");
      const cfg = y && y.config();
      if (cfg && cfg.webhookSecret) {
        const attendu = crypto.createHmac("sha256", cfg.webhookSecret).update(req.rawBody || Buffer.alloc(0)).digest("hex");
        const recu = String(req.headers["x-yousign-signature-256"] || "").replace(/^sha256=/, "");
        if (!hmacCorrespond(recu, attendu)) {
          console.error("[webhook signature] HMAC Yousign invalide — événement ignoré");
          return;
        }
      }
    } else if (corps.requests && corps.requests.request_id) {
      fournisseurWebhook = "zoho";
      idExterne = String(corps.requests.request_id);
      fournisseurWebhook = "zoho";
    }
    if (!idExterne) return;
    // Rejet de forme/signature : géré ci-dessus (return sans traitement, rien
    // à rejouer). Au-delà, toute erreur relève de traiterEvenementSignature.
    await traiterEvenementSignature(idExterne, fournisseurWebhook);
  } catch (e) {
    console.error("[webhook signature]", e.message);
  }
});

// Échange du code « self client » Zoho contre le refresh token (stocké serveur).
app.post("/api/zoho/echanger-code", exigerCodeParametres, async (req, res) => {
  try {
    res.json(await fournisseurs.externe("zoho").echangerCode(req.body && req.body.code));
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// Suivi : liste des demandes (sans les images).
// (Relances et délais sont gérés PAR LE FOURNISSEUR : rappels automatiques
// Yousign, expiration fixée à la création de l'enveloppe.)
app.get("/api/signatures", async (req, res) => {
  // Bornée comme /api/contrats (listerContrats) : voir le commentaire de
  // chargerDemandes() dans lib/db.pg.js.
  try { res.json((await db.chargerDemandes(200)).map(vueDemande)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Certificat de signature — document séparé du contrat signé.
app.get("/api/signatures/:id/certificat", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const d = await db.chargerDemande(id);
    if (!d) return res.status(404).json({ error: "Demande introuvable" });
    if (d.fournisseur && d.fournisseur !== "local") {
      return servirArchiveExterne(d, "__PREUVE-" + d.fournisseur.toUpperCase(), res,
        "Le dossier de preuve " + d.fournisseur + " n'est pas encore téléchargé — clique « Synchroniser » une fois le document signé.");
    }
    if (d.statut !== "complete") return res.status(400).json({ error: "Le certificat n'existe qu'une fois toutes les signatures réunies." });
    const buf = await buildCertificatPdf(signatures.certificatDe(d));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${d.base}__CERTIFICAT.pdf"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Suppression d'une demande : la ligne disparaît du suivi et les liens cessent
// aussitôt de fonctionner — mais elle part dans la CORBEILLE : la restaurer
// depuis Paramètres réactive les mêmes jetons (les liens envoyés remarchent).
app.delete("/api/signatures/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await db.supprimerDemande(id);
    res.json({ ok: true, corbeille: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Corbeille : consultation, restauration sélective, purge ----------
app.get("/api/corbeille", async (req, res) => {
  try {
    const lignes = await db.listerCorbeille();
    const out = lignes.map((l) => {
      const d = l.donnees || {};
      const libelle = l.type === "contrat"
        ? (d.numero || "(sans n°)") + " — " + (d.sous_traitant || "") + (d.client_final ? " chez " + d.client_final : "")
        : "Demande de signature " + (d.numero || "") + " — " + (d.titre || "");
      return { id: l.id, type: l.type, libelle, supprimeLe: l.supprimeLe };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restaure la SÉLECTION : chaque élément retrouve sa table d'origine.
app.post("/api/corbeille/restaurer", exigerCodeParametres, async (req, res) => {
  try {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.status(400).json({ error: "Rien à restaurer." });
    const { restaures } = await db.restaurerCorbeille(ids);
    res.json({ ok: true, restaures });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Purge DÉFINITIVE d'une sélection de la corbeille (après double confirmation côté interface).
app.post("/api/corbeille/purger", exigerCodeParametres, async (req, res) => {
  try {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.status(400).json({ error: "Rien à purger." });
    const { purges } = await db.purgerCorbeille(ids);
    res.json({ ok: true, purges });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pour une demande EXTERNE, le document de référence est l'archive téléchargée
// chez le fournisseur (la plus récente du dossier correspondant au suffixe).
function servirArchiveExterne(d, suffixe, res, messageAbsent) {
  const dossier = dossierContrat(d.base);
  const fichiers = fs.readdirSync(dossier).filter((n) => n.includes(suffixe)).sort();
  if (!fichiers.length) return res.status(400).json({ error: messageAbsent });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=\"" + fichiers[fichiers.length - 1] + "\"");
  res.send(fs.readFileSync(path.join(dossier, fichiers[fichiers.length - 1])));
}

// PDF courant d'une demande (signatures déjà apposées + certificat si complète).
app.get("/api/signatures/:id/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const d = await db.chargerDemande(id);
    if (!d) return res.status(404).json({ error: "Demande introuvable" });
    if (d.fournisseur && d.fournisseur !== "local") {
      return servirArchiveExterne(d, "__SIGNE-" + d.fournisseur.toUpperCase(), res,
        "Le document signé n'est pas encore téléchargé — clique « Synchroniser » (ou attends la fin des signatures chez " + d.fournisseur + ").");
    }
    // d.payload est un objet JS ordinaire (JSONB) depuis la PR B — plus de
    // JSON.parse ici (voir lib/signatures.js::nouvelleDemande, correctif du
    // double-encodage historique).
    const { tpl, values, options } = resolveBody(d.payload);
    const buf = await buildPdf(tpl, values, options, signatures.signaturesPourPdf(d));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${d.base}${d.statut === "complete" ? "__SIGNE" : ""}.pdf"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// (Les routes « côté signataire » — page /signer/<jeton>, API de signature
// locale — ont été retirées : la page de signature est celle du FOURNISSEUR.)

// Historique (PostgreSQL, table `contrats` — voir lib/db.pg.js)
// Un avenant n'a pas de numeroContrat/stNom : on retombe sur ses champs propres,
// pour que la ligne d'historique reste identifiable et regroupable par entreprise.
function colonnesContrat(type, values) {
  return {
    numero: values.numeroContrat || values.numeroAvenant || "",
    sousTraitant: values.stNom || values.avPartie2Nom || "",
    clientFinal: values.clientFinal || "",
  };
}

app.post("/api/save", async (req, res) => {
  try {
    const { type, values } = resolve(req);
    const c = colonnesContrat(type, values);
    const { id } = await db.sauverContrat({
      numero: c.numero, type, sousTraitant: c.sousTraitant, clientFinal: c.clientFinal, payload: req.body,
    });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Modification d'un contrat existant (bouton « Enregistrer » en mode édition).
app.put("/api/contracts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const { type, values } = resolve(req);
    const c = colonnesContrat(type, values);
    const ok = await db.mettreAJourContrat(id, {
      numero: c.numero, type, sousTraitant: c.sousTraitant, clientFinal: c.clientFinal, payload: req.body,
    });
    if (!ok) return res.status(404).json({ error: "Contrat introuvable" });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/contracts", async (req, res) => {
  try {
    const lignes = await db.listerContrats(200);
    const out = lignes.map((c) => {
      // base = nom du dossier de stockage (mêmes règles que le nom de fichier exporté)
      const base = fileBase({ stNom: c.sousTraitant, numeroContrat: c.numero });
      // Depuis le payload : rattachement d'avenant, date de fin de mission (alertes), SIREN (fiche entreprise).
      const v = (c.payload && c.payload.values) || {};
      return {
        id: c.id, numero: c.numero, type: c.type, sousTraitant: c.sousTraitant, clientFinal: c.clientFinal,
        creeLe: c.creeLe, base,
        contratInitial: c.type === "avenant" ? (v.numeroContratInitial || "") : "",
        dateFin: v.dateFin || "", stSiren: v.stSiren || "",
        statut: c.statut || "", signe: c.signe || "",
      };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/contracts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const c = await db.obtenirContrat(id);
    if (!c) return res.status(404).json({ error: "introuvable" });
    res.json(c.payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aperçu PDF d'un contrat de l'historique (la « loupe ») : régénéré depuis le payload.
app.get("/api/contracts/:id/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const c = await db.obtenirContrat(id);
    if (!c) return res.status(404).json({ error: "introuvable" });
    const { tpl, values, options } = resolveBody(c.payload);
    if (!tpl || tpl.stub) return res.status(400).json({ error: "Modèle non disponible pour ce type." });
    const buf = await buildPdf(tpl, values, options);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileBase(values)}.pdf"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Décode un fichier envoyé en dataURL ({nom, contenu}) — PDF uniquement, 25 Mo max.
function fichierDepuisJson(f) {
  if (!f || typeof f.contenu !== "string") return null;
  const m = f.contenu.match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error("Le fichier joint doit être un PDF.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 25 * 1024 * 1024) throw new Error("PDF trop lourd (25 Mo max).");
  const nom = String(f.nom || "document.pdf").replace(/[^\wÀ-ÿ .-]+/g, "_").slice(0, 120);
  return { nom, buf };
}

// Signature EXTERNE : le contrat a été signé HORS application (papier, autre
// outil) — on coche la mention « signé » (date) et on archive le PDF signé
// fourni en pièce jointe dans le dossier du contrat.
app.post("/api/contracts/:id/signe", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const c = await db.obtenirContrat(id);
    if (!c) return res.status(404).json({ error: "Contrat introuvable" });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || "")) ? req.body.date : new Date().toISOString().slice(0, 10);
    let fichierArchive = "";
    const f = fichierDepuisJson(req.body.fichier);
    if (f) {
      const base = fileBase({ stNom: c.sousTraitant, numeroContrat: c.numero });
      fichierArchive = path.basename(archiverFichier(base, base + "__SIGNE-EXTERNE.pdf", f.buf));
    }
    await db.marquerSigne(id, date);
    res.json({ ok: true, signe: date, fichier: fichierArchive });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Retire la mention « signé » (le PDF déjà archivé, lui, reste dans le dossier).
app.delete("/api/contracts/:id/signe", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await db.retirerSigne(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORT d'un contrat EXISTANT (créé hors application) dans le dossier :
// le PDF (souvent déjà signé) est archivé, et les informations clés (dates,
// client final, consultant, TJM…) alimentent l'historique, les alertes de fin
// et les récaps d'avenant exactement comme un contrat créé ici.
app.post("/api/contracts/importer", async (req, res) => {
  try {
    const type = ["sous-traitance", "cds", "cdi", "cdd", "avenant"].includes(req.body.type) ? req.body.type : "sous-traitance";
    const values = req.body.values && typeof req.body.values === "object" ? req.body.values : {};
    const c = colonnesContrat(type, values);
    if (!c.numero) return res.status(400).json({ error: "Le numéro du contrat est requis." });
    if (!c.sousTraitant) return res.status(400).json({ error: "Le nom du sous-traitant / co-contractant est requis." });
    const signe = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.signeLe || "")) ? req.body.signeLe : "";
    const payload = { type, values, importe: true };
    const { id } = await db.importerContrat({
      numero: c.numero, type, sousTraitant: c.sousTraitant, clientFinal: c.clientFinal, payload, signe,
    });
    let fichierArchive = "";
    const f = fichierDepuisJson(req.body.fichier);
    if (f) {
      const base = fileBase({ stNom: c.sousTraitant, numeroContrat: c.numero });
      fichierArchive = path.basename(archiverFichier(base, base + (signe ? "__SIGNE-IMPORTE.pdf" : "__IMPORTE.pdf"), f.buf));
    }
    res.json({ ok: true, id, fichier: fichierArchive });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Cycle de vie : clôturer / rouvrir un contrat (alertes de fin de mission).
app.patch("/api/contracts/:id/statut", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    const statut = req.body.statut === "clos" ? "clos" : "";
    await db.definirStatutContrat(id, statut);
    res.json({ ok: true, statut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Suppression — unitaire et groupée (sélection dans l'historique).
// Les lignes partent dans la CORBEILLE (restaurables depuis Paramètres) —
// voir lib/db.pg.js::supprimerContrats (transaction : bascule en corbeille
// PUIS suppression, tout ou rien).
app.delete("/api/contracts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await db.supprimerContrats([id]);
    res.json({ ok: true, corbeille: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/contracts/supprimer", async (req, res) => {
  try {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.status(400).json({ error: "Aucun contrat sélectionné." });
    const { supprimes } = await db.supprimerContrats(ids);
    res.json({ ok: true, supprimes, corbeille: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Démarrage ----------
// db.init() applique lib/schema.sql (CREATE TABLE IF NOT EXISTS, idempotent),
// puis templatesPerso.init() charge le cache mémoire des retouches de modèles
// (voir lib/templates-perso.js — décision de conception issue #14/PR B).
db.init()
  .then(() => templatesPerso.init())
  .then(() => {
    app.listen(PORT, HOTE, () => {
      console.log("\n  ADBI - Generateur de contrats");
      console.log("  -> http://" + HOTE + ":" + PORT + "\n");
    });
    // Rattrape tout webhook de signature dont le traitement avait échoué avant
    // cet arrêt/redémarrage, puis réessaie périodiquement (voir plus haut).
    rejouerEchecsWebhooks();
    setInterval(rejouerEchecsWebhooks, ECHEC_WEBHOOK_RELANCE_MS);
  })
  .catch((e) => { console.error("Erreur init DB:", e); process.exit(1); });
