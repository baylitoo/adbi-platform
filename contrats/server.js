const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");
const initSqlJs = require("sql.js");

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
const DB_PATH = path.join(__dirname, "data", "contrats.sqlite");
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

// ---------- Base SQLite (sql.js / WASM, sans compilation native) ----------
let SQL, db;
async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
    db.run(`CREATE TABLE contrats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT, type TEXT, sous_traitant TEXT, client_final TEXT,
      payload TEXT, cree_le TEXT
    );`);
  }
  // Demandes de signature : tout l'objet vit en JSON (volumes minuscules, filtrage en JS).
  db.run("CREATE TABLE IF NOT EXISTS signatures (id INTEGER PRIMARY KEY AUTOINCREMENT, donnees TEXT);");
  // Statut de vie du contrat ("" = en cours, "clos" = clôturé) — idempotent.
  try { db.run("ALTER TABLE contrats ADD COLUMN statut TEXT DEFAULT '';"); } catch (e) {}
  // Signature EXTERNE (papier, autre outil) : date ISO de signature, '' sinon.
  try { db.run("ALTER TABLE contrats ADD COLUMN signe TEXT DEFAULT '';"); } catch (e) {}
  // CORBEILLE : toute suppression (contrat, demande de signature) passe ici et
  // reste restaurable depuis Paramètres — rien n'est perdu sur une fausse manip.
  db.run("CREATE TABLE IF NOT EXISTS corbeille (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, donnees TEXT, supprime_le TEXT);");
  persist();
}

// ---------- Code d'accès aux Paramètres ----------
// L'écran Paramètres (clés API, modèles de contrat, corbeille) est protégé par
// un code, stocké dans data/code-parametres.txt (modifiable là, sans toucher au
// code). Le navigateur l'envoie dans l'en-tête x-code-parametres après
// déverrouillage ; les routes SENSIBLES le vérifient côté serveur.
const CODE_PARAM_FICHIER = path.join(__dirname, "data", "code-parametres.txt");

function codeParametres() {
  try {
    if (!fs.existsSync(CODE_PARAM_FICHIER)) {
      fs.writeFileSync(CODE_PARAM_FICHIER, "ADbi2027@@");
    }
    return fs.readFileSync(CODE_PARAM_FICHIER, "utf8").trim();
  } catch (e) {
    return "ADbi2027@@";
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

// Dépose un élément supprimé dans la corbeille (donnees = objet complet re-insérable).
function mettreCorbeille(type, donnees) {
  db.run("INSERT INTO corbeille (type, donnees, supprime_le) VALUES (?,?,?)",
    [type, JSON.stringify(donnees), new Date().toISOString()]);
}
function persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
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
// Demandes de signature — lecture/écriture de la table JSON.
// (L'ancien flux de signature LOCAL — page /signer, jetons, invitations SMTP —
// a été retiré en septembre 2026 : la signature passe exclusivement par les
// CONNECTEURS API de lib/fournisseurs/. Les demandes locales déjà signées
// restent lisibles : PDF et certificat se régénèrent depuis leurs données.)
function chargerDemande(id) {
  const r = db.exec("SELECT donnees FROM signatures WHERE id=" + parseInt(id, 10));
  if (!r[0]) return null;
  const d = JSON.parse(r[0].values[0][0]);
  d.id = parseInt(id, 10);
  return d;
}
function chargerDemandes() {
  const out = [];
  const r = db.exec("SELECT id, donnees FROM signatures ORDER BY id DESC");
  if (r[0]) r[0].values.forEach((row) => {
    const d = JSON.parse(row[1]);
    d.id = row[0];
    out.push(d);
  });
  return out;
}
function sauverDemande(d) {
  const json = JSON.stringify(Object.assign({}, d, { id: undefined }));
  if (d.id) {
    db.run("UPDATE signatures SET donnees=? WHERE id=?", [json, d.id]);
  } else {
    db.run("INSERT INTO signatures (donnees) VALUES (?)", [json]);
    d.id = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    // Recopie l'id dans le JSON (référence SIG-<id> stable dans le certificat).
    db.run("UPDATE signatures SET donnees=? WHERE id=?", [JSON.stringify(Object.assign({}, d, { id: undefined })), d.id]);
  }
  persist();
  return d;
}
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

app.post("/api/templates-perso/:type", exigerCodeParametres, (req, res) => {
  try { res.json(templatesPerso.sauver(req.params.type, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Retour complet au modèle d'origine pour ce type.
app.delete("/api/templates-perso/:type", exigerCodeParametres, (req, res) => {
  try {
    templatesPerso.reinitialiser(req.params.type);
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
  catch (e) { res.status(400).json({ error: e.message }); }
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

app.get("/api/test/:provider", async (req, res) => {
  try {
    if (req.params.provider === "yousign") return res.json(await fournisseurs.externe("yousign").verifier());
    if (req.params.provider === "zoho") return res.json(await fournisseurs.externe("zoho").verifier());
    res.json(await testProvider(req.params.provider));
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// Référentiels (clients + valideurs CRA + lieux, managers)
app.get("/api/referentiels", (req, res) => res.json(referentiels.load()));
app.post("/api/referentiels", (req, res) => {
  try { res.json(referentiels.save(req.body || {})); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ---------- Fichiers stockés par contrat ----------
app.get("/api/fichiers/:base", (req, res) => {
  try {
    const base = path.basename(req.params.base);
    const d = path.join(GENERES_DIR, base);
    if (!fs.existsSync(d)) return res.json([]);
    const rows = fs.readdirSync(d).map((nom) => {
      const st = fs.statSync(path.join(d, nom));
      return { nom, taille: st.size, modifieLe: st.mtime.toISOString() };
    }).sort((a, b) => b.modifieLe.localeCompare(a.modifieLe));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/fichiers/:base/:nom", (req, res) => {
  // path.basename bloque toute traversée (../) ; on ne sert que le dossier du contrat.
  const chemin = path.join(GENERES_DIR, path.basename(req.params.base), path.basename(req.params.nom));
  if (!fs.existsSync(chemin)) return res.status(404).json({ error: "Fichier introuvable" });
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
    const lignes = db.exec("SELECT numero, sous_traitant FROM contrats");
    const dejaEnregistre = lignes[0] && lignes[0].values.some((v) => v[0] === col.numero && v[1] === col.sousTraitant);
    if (!dejaEnregistre) {
      db.run("INSERT INTO contrats (numero,type,sous_traitant,client_final,payload,cree_le,statut) VALUES (?,?,?,?,?,?,?)",
        [col.numero, type, col.sousTraitant, col.clientFinal,
         JSON.stringify({ type, values: req.body.values || {}, options: req.body.options || {} }),
         new Date().toISOString(), ""]);
      persist();
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
      sauverDemande(demande);
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
  sauverDemande(d);
  return d;
}

app.post("/api/signatures/:id/synchroniser", async (req, res) => {
  try {
    const d = chargerDemande(req.params.id);
    if (!d) return res.status(404).json({ error: "Demande introuvable" });
    if (d.fournisseur === "local") return res.json({ ok: true, demande: vueDemande(d) });
    await synchroniserDemandeExterne(d);
    res.json({ ok: true, demande: vueDemande(d) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Webhook du fournisseur de signature (à déclarer chez lui vers
// http(s)://<hôte>/webhooks/signature). Vérification HMAC si un secret est
// configuré ; sinon le webhook déclenche simplement une synchronisation —
// AUCUNE donnée du webhook n'est crue sur parole, on relit l'API.
app.post("/webhooks/signature", async (req, res) => {
  res.status(200).json({ ok: true }); // répondre vite : le traitement suit
  try {
    // Format Yousign : {data:{signature_request:{id}}} + en-tête HMAC vérifié si
    // le secret est configuré. Format Zoho Sign : {requests:{request_id}}.
    // Dans tous les cas le contenu N'EST PAS cru : on relit l'API du fournisseur.
    const corps = req.body || {};
    let idExterne = corps.data && corps.data.signature_request && corps.data.signature_request.id;
    if (idExterne) {
      const y = fournisseurs.externe("yousign");
      const cfg = y && y.config();
      if (cfg && cfg.webhookSecret) {
        const attendu = crypto.createHmac("sha256", cfg.webhookSecret).update(req.rawBody || Buffer.alloc(0)).digest("hex");
        const recu = String(req.headers["x-yousign-signature-256"] || "").replace(/^sha256=/, "");
        if (!recu || !crypto.timingSafeEqual(Buffer.from(attendu), Buffer.from(recu.padEnd(attendu.length).slice(0, attendu.length)))) {
          console.error("[webhook signature] HMAC Yousign invalide — événement ignoré");
          return;
        }
      }
    } else if (corps.requests && corps.requests.request_id) {
      idExterne = String(corps.requests.request_id);
    }
    if (!idExterne) return;
    const d = chargerDemandes().find((x) => x.externe && x.externe.id === idExterne);
    if (d) await synchroniserDemandeExterne(d);
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
app.get("/api/signatures", (req, res) => {
  try { res.json(chargerDemandes().map(vueDemande)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Certificat de signature — document séparé du contrat signé.
app.get("/api/signatures/:id/certificat", async (req, res) => {
  try {
    const d = chargerDemande(req.params.id);
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
app.delete("/api/signatures/:id", (req, res) => {
  try {
    const d = chargerDemande(req.params.id);
    if (d) mettreCorbeille("signature", Object.assign({}, d, { id: undefined }));
    db.run("DELETE FROM signatures WHERE id=?", [parseInt(req.params.id, 10)]);
    persist();
    res.json({ ok: true, corbeille: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Corbeille : consultation, restauration sélective, purge ----------
app.get("/api/corbeille", (req, res) => {
  try {
    const out = [];
    const r = db.exec("SELECT id, type, donnees, supprime_le FROM corbeille ORDER BY id DESC");
    if (r[0]) r[0].values.forEach((v) => {
      let libelle = "";
      try {
        const d = JSON.parse(v[2]);
        libelle = v[1] === "contrat"
          ? (d.numero || "(sans n°)") + " — " + (d.sous_traitant || "") + (d.client_final ? " chez " + d.client_final : "")
          : "Demande de signature " + (d.numero || "") + " — " + (d.titre || "");
      } catch (e) {}
      out.push({ id: v[0], type: v[1], libelle, supprimeLe: v[3] });
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restaure la SÉLECTION : chaque élément retrouve sa table d'origine.
app.post("/api/corbeille/restaurer", exigerCodeParametres, (req, res) => {
  try {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.status(400).json({ error: "Rien à restaurer." });
    let restaures = 0;
    for (const id of ids) {
      const r = db.exec("SELECT type, donnees FROM corbeille WHERE id=" + id);
      if (!r[0]) continue;
      const type = r[0].values[0][0];
      const d = JSON.parse(r[0].values[0][1]);
      if (type === "contrat") {
        db.run("INSERT INTO contrats (numero,type,sous_traitant,client_final,payload,cree_le,statut,signe) VALUES (?,?,?,?,?,?,?,?)",
          [d.numero, d.type, d.sous_traitant, d.client_final, d.payload, d.cree_le, d.statut || "", d.signe || ""]);
      } else if (type === "signature") {
        db.run("INSERT INTO signatures (donnees) VALUES (?)", [JSON.stringify(Object.assign({}, d, { id: undefined }))]);
      }
      db.run("DELETE FROM corbeille WHERE id=?", [id]);
      restaures++;
    }
    persist();
    res.json({ ok: true, restaures });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Purge DÉFINITIVE d'une sélection de la corbeille (après double confirmation côté interface).
app.post("/api/corbeille/purger", exigerCodeParametres, (req, res) => {
  try {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.status(400).json({ error: "Rien à purger." });
    db.run("DELETE FROM corbeille WHERE id IN (" + ids.join(",") + ")");
    persist();
    res.json({ ok: true, purges: ids.length });
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
    const d = chargerDemande(req.params.id);
    if (!d) return res.status(404).json({ error: "Demande introuvable" });
    if (d.fournisseur && d.fournisseur !== "local") {
      return servirArchiveExterne(d, "__SIGNE-" + d.fournisseur.toUpperCase(), res,
        "Le document signé n'est pas encore téléchargé — clique « Synchroniser » (ou attends la fin des signatures chez " + d.fournisseur + ").");
    }
    const { tpl, values, options } = resolveBody(JSON.parse(d.payload));
    const buf = await buildPdf(tpl, values, options, signatures.signaturesPourPdf(d));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${d.base}${d.statut === "complete" ? "__SIGNE" : ""}.pdf"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// (Les routes « côté signataire » — page /signer/<jeton>, API de signature
// locale — ont été retirées : la page de signature est celle du FOURNISSEUR.)

// Historique (sql.js)
// Un avenant n'a pas de numeroContrat/stNom : on retombe sur ses champs propres,
// pour que la ligne d'historique reste identifiable et regroupable par entreprise.
function colonnesContrat(type, values) {
  return {
    numero: values.numeroContrat || values.numeroAvenant || "",
    sousTraitant: values.stNom || values.avPartie2Nom || "",
    clientFinal: values.clientFinal || "",
  };
}

app.post("/api/save", (req, res) => {
  try {
    const { type, values } = resolve(req);
    const c = colonnesContrat(type, values);
    db.run("INSERT INTO contrats (numero,type,sous_traitant,client_final,payload,cree_le) VALUES (?,?,?,?,?,?)",
      [c.numero, type, c.sousTraitant, c.clientFinal, JSON.stringify(req.body), new Date().toISOString()]);
    // last_insert_rowid AVANT persist() : l'export sql.js remet le compteur de session à zéro.
    const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    persist();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Modification d'un contrat existant (bouton « Enregistrer » en mode édition).
app.put("/api/contracts/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = db.exec("SELECT id FROM contrats WHERE id=" + id);
    if (!r[0]) return res.status(404).json({ error: "Contrat introuvable" });
    const { type, values } = resolve(req);
    const c = colonnesContrat(type, values);
    db.run("UPDATE contrats SET numero=?, type=?, sous_traitant=?, client_final=?, payload=? WHERE id=?",
      [c.numero, type, c.sousTraitant, c.clientFinal, JSON.stringify(req.body), id]);
    persist();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/contracts", (req, res) => {
  try {
    const out = [];
    const r = db.exec("SELECT id,numero,type,sous_traitant,client_final,cree_le,payload,statut,signe FROM contrats ORDER BY id DESC LIMIT 200");
    if (r[0]) r[0].values.forEach((row) => {
      // base = nom du dossier de stockage (mêmes règles que le nom de fichier exporté)
      const base = fileBase({ stNom: row[3], numeroContrat: row[1] });
      // Depuis le payload : rattachement d'avenant, date de fin de mission (alertes), SIREN (fiche entreprise).
      let contratInitial = "", dateFin = "", stSiren = "";
      try {
        const v = JSON.parse(row[6]).values || {};
        if (row[2] === "avenant") contratInitial = v.numeroContratInitial || "";
        dateFin = v.dateFin || "";
        stSiren = v.stSiren || "";
      } catch (e) {}
      out.push({
        id: row[0], numero: row[1], type: row[2], sousTraitant: row[3], clientFinal: row[4],
        creeLe: row[5], base, contratInitial, dateFin, stSiren, statut: row[7] || "",
        signe: row[8] || "",
      });
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/contracts/:id", (req, res) => {
  try {
    const r = db.exec("SELECT payload FROM contrats WHERE id=" + parseInt(req.params.id, 10));
    if (!r[0]) return res.status(404).json({ error: "introuvable" });
    res.json(JSON.parse(r[0].values[0][0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aperçu PDF d'un contrat de l'historique (la « loupe ») : régénéré depuis le payload.
app.get("/api/contracts/:id/pdf", async (req, res) => {
  try {
    const r = db.exec("SELECT payload FROM contrats WHERE id=" + parseInt(req.params.id, 10));
    if (!r[0]) return res.status(404).json({ error: "introuvable" });
    const { tpl, values, options } = resolveBody(JSON.parse(r[0].values[0][0]));
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
app.post("/api/contracts/:id/signe", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = db.exec("SELECT numero, sous_traitant FROM contrats WHERE id=" + id);
    if (!r[0]) return res.status(404).json({ error: "Contrat introuvable" });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || "")) ? req.body.date : new Date().toISOString().slice(0, 10);
    let fichierArchive = "";
    const f = fichierDepuisJson(req.body.fichier);
    if (f) {
      const base = fileBase({ stNom: r[0].values[0][1], numeroContrat: r[0].values[0][0] });
      fichierArchive = path.basename(archiverFichier(base, base + "__SIGNE-EXTERNE.pdf", f.buf));
    }
    db.run("UPDATE contrats SET signe=? WHERE id=?", [date, id]);
    persist();
    res.json({ ok: true, signe: date, fichier: fichierArchive });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Retire la mention « signé » (le PDF déjà archivé, lui, reste dans le dossier).
app.delete("/api/contracts/:id/signe", (req, res) => {
  try {
    db.run("UPDATE contrats SET signe='' WHERE id=?", [parseInt(req.params.id, 10)]);
    persist();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORT d'un contrat EXISTANT (créé hors application) dans le dossier :
// le PDF (souvent déjà signé) est archivé, et les informations clés (dates,
// client final, consultant, TJM…) alimentent l'historique, les alertes de fin
// et les récaps d'avenant exactement comme un contrat créé ici.
app.post("/api/contracts/importer", (req, res) => {
  try {
    const type = ["sous-traitance", "cds", "cdi", "cdd", "avenant"].includes(req.body.type) ? req.body.type : "sous-traitance";
    const values = req.body.values && typeof req.body.values === "object" ? req.body.values : {};
    const c = colonnesContrat(type, values);
    if (!c.numero) return res.status(400).json({ error: "Le numéro du contrat est requis." });
    if (!c.sousTraitant) return res.status(400).json({ error: "Le nom du sous-traitant / co-contractant est requis." });
    const signe = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.signeLe || "")) ? req.body.signeLe : "";
    const payload = { type, values, importe: true };
    db.run("INSERT INTO contrats (numero,type,sous_traitant,client_final,payload,cree_le,statut,signe) VALUES (?,?,?,?,?,?,?,?)",
      [c.numero, type, c.sousTraitant, c.clientFinal, JSON.stringify(payload), new Date().toISOString(), "", signe]);
    // last_insert_rowid AVANT persist() : l'export sql.js remet le compteur de session à zéro.
    const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    persist();
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
app.patch("/api/contracts/:id/statut", (req, res) => {
  try {
    const statut = req.body.statut === "clos" ? "clos" : "";
    db.run("UPDATE contrats SET statut=? WHERE id=?", [statut, parseInt(req.params.id, 10)]);
    persist();
    res.json({ ok: true, statut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Suppression — unitaire et groupée (sélection dans l'historique).
// Les lignes partent dans la CORBEILLE (restaurables depuis Paramètres).
function contratsVersCorbeille(ids) {
  const r = db.exec("SELECT numero,type,sous_traitant,client_final,payload,cree_le,statut,signe FROM contrats WHERE id IN (" + ids.join(",") + ")");
  if (r[0]) r[0].values.forEach((v) => mettreCorbeille("contrat", {
    numero: v[0], type: v[1], sous_traitant: v[2], client_final: v[3],
    payload: v[4], cree_le: v[5], statut: v[6] || "", signe: v[7] || "",
  }));
  db.run("DELETE FROM contrats WHERE id IN (" + ids.join(",") + ")");
  persist();
}

app.delete("/api/contracts/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide." });
    contratsVersCorbeille([id]);
    res.json({ ok: true, corbeille: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/contracts/supprimer", (req, res) => {
  try {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
    if (!ids.length) return res.status(400).json({ error: "Aucun contrat sélectionné." });
    contratsVersCorbeille(ids);
    res.json({ ok: true, supprimes: ids.length, corbeille: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log("\n  ADBI - Generateur de contrats");
    console.log("  -> http://localhost:" + PORT + "\n");
  });
}).catch((e) => { console.error("Erreur init DB:", e); process.exit(1); });
