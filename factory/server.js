/*
 * ADBI Factory — plateforme locale regroupant les outils internes ADBI.
 *
 * Sert le hub (tuiles des modules) et pilote le cycle de vie des applications
 * Node existantes (One pager, Générateur de contrats) : la Factory les démarre
 * à la demande, surveille leur port et les arrête à sa fermeture.
 *
 * Aucune dépendance npm : uniquement les modules natifs de Node 18+.
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ADBI_PORT permet de lancer une seconde instance a cote (test, depannage)
// sans couper celle qui tourne deja.
const PORT = Number(process.env.ADBI_PORT) || 4000;
// Local par defaut (poste de dev) ; le Dockerfile passe ADBI_HOTE=0.0.0.0 —
// sans ca, "127.0.0.1" a l'interieur du conteneur n'est PAS atteignable via
// le port publie ("-p 4000:4000" arrive sur l'interface externe, pas la
// loopback), meme si le HEALTHCHECK (execute dans le meme conteneur) semble
// fonctionner (voir le meme correctif sur one-pager, PR #38).
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
const RACINE = __dirname;
const PUBLIC = path.join(RACINE, "public");
const LOGS = path.join(RACINE, "logs");
// Plafond du journal d'un module (voir demarrerModule) : au-dela, on repart
// d'un fichier vide au prochain demarrage plutot que de le laisser grossir
// indefiniment au fil des redemarrages.
const JOURNAL_MAX_OCTETS = 2 * 1024 * 1024; // 2 Mo

// ── Configuration des modules ────────────────────────────────────────────────

function chargerModules() {
  // replace(/^﻿/) : Notepad et PowerShell ajoutent un BOM qui casserait JSON.parse.
  const brut = fs.readFileSync(path.join(RACINE, "modules.json"), "utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(brut).modules;
  } catch (err) {
    console.error("\n  [ERREUR] modules.json est invalide : " + err.message + "\n");
    process.exit(1);
  }
}

let MODULES = chargerModules();

function trouverModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

/**
 * Type « lien » : une tuile qui ouvre une VUE d'un autre module (ex. ADBI Sign
 * ouvre le suivi des signatures d'ADBI Contrats). L'état et le démarrage sont
 * délégués au module cible ; seule l'URL diffère (chemin/fragment ajouté).
 */
function cibleDe(m) {
  return m && m.type === "lien" ? trouverModule(m.cible) : m;
}

/** URL d'ouverture d'un module, quel que soit son type (service, statique, lien). */
function urlModule(m) {
  if (m.url) return m.url;
  if (m.type === "lien") {
    const c = cibleDe(m);
    return c && c.port ? `http://localhost:${c.port}/${m.chemin || ""}` : null;
  }
  return m.port ? `http://localhost:${m.port}/` : null;
}

// Processus enfants lancés par la Factory, indexés par identifiant de module.
const processus = new Map();

// ── Surveillance des ports ───────────────────────────────────────────────────

/**
 * Teste si un serveur écoute déjà sur le port (app lancée manuellement ou par
 * nous). `hote` par défaut 127.0.0.1 (poste/serveur classique, où Factory et
 * modules tournent sur la même machine) ; un module conteneurisé donne son
 * propre nom d'hôte réseau (voir `m.hote`, ex. le nom du service compose).
 */
function portOuvert(port, hote = "127.0.0.1", delai = 500) {
  return new Promise((resoudre) => {
    const prise = new net.Socket();
    let termine = false;
    const conclure = (valeur) => {
      if (termine) return;
      termine = true;
      prise.destroy();
      resoudre(valeur);
    };
    prise.setTimeout(delai);
    prise.once("connect", () => conclure(true));
    prise.once("timeout", () => conclure(false));
    prise.once("error", () => conclure(false));
    prise.connect(port, hote);
  });
}

function attendre(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Attend que le port réponde, jusqu'à `secondes` (le démarrage d'une app peut être lent). */
async function attendrePort(port, secondes = 40, hote = "127.0.0.1") {
  const limite = Date.now() + secondes * 1000;
  while (Date.now() < limite) {
    if (await portOuvert(port, hote)) return true;
    await attendre(600);
  }
  return false;
}

/** Hôte réseau où joindre un module — 127.0.0.1 sauf pour un module
 * conteneurisé (voir `demarrerModule`/`etatModule`), qui donne le sien. */
function hoteModule(m) {
  return m.hote || "127.0.0.1";
}

/**
 * Commande de lancement d'un module.
 * Par défaut : le Node qui exécute la Factory (pas de dépendance au PATH).
 * Un module non-Node déclare sa propre `commande` et ses `arguments`
 * (ex. Flask : "py" avec ["-3.14", "app.py"]).
 */
function commandeModule(m) {
  return {
    commande: m.commande || process.execPath,
    arguments: m.arguments || [m.entree],
  };
}

/** Le module est-il bien installé sur ce poste ? */
function moduleInstalle(m) {
  if (!m.dossier || !fs.existsSync(m.dossier)) return false;
  return m.entree ? fs.existsSync(path.join(m.dossier, m.entree)) : true;
}

/** État courant d'un module : pret | demarrage | arrete | indisponible | statique | bientot */
async function etatModule(m) {
  if (m.type === "lien") {
    const c = cibleDe(m);
    return c ? etatModule(c) : "indisponible";
  }
  if (m.type === "statique") return "statique";
  if (m.type === "bientot") return "bientot";
  // Module conteneurisé : démarré par docker-compose, pas par la Factory —
  // aucun `dossier` local à vérifier, aucun processus à surveiller. "pret"
  // ou "demarrage" (jamais "arrete"/"indisponible", trompeurs pour un
  // conteneur que la Factory ne pilote pas).
  if (m.conteneur) return (await portOuvert(m.port, hoteModule(m))) ? "pret" : "demarrage";
  if (!moduleInstalle(m)) return "indisponible";
  if (await portOuvert(m.port)) return "pret";
  const enfant = processus.get(m.id);
  if (enfant && !enfant.tue) return "demarrage";
  return "arrete";
}

// ── Démarrage / arrêt des applications ───────────────────────────────────────

async function demarrerModule(m) {
  if (m.type === "lien") {
    const c = cibleDe(m);
    if (!c) return { etat: "indisponible", message: "Module cible introuvable." };
    return demarrerModule(c);
  }
  if (m.type !== "service") return { etat: m.type, message: "Module sans serveur." };

  if (m.conteneur) {
    // Rien à lancer : le conteneur du module est démarré par docker-compose,
    // en même temps que celui de la Factory (ou avant). On attend juste
    // qu'il réponde, comme pour un module local qui met du temps à démarrer.
    const hote = hoteModule(m);
    const ok = await attendrePort(m.port, m.delai || 40, hote);
    return ok
      ? { etat: "pret" }
      : { etat: "demarrage", message: `En attente de ${m.id} sur ${hote}:${m.port} (démarré par docker-compose).` };
  }

  if (await portOuvert(m.port)) return { etat: "pret" };

  if (!moduleInstalle(m)) {
    return {
      etat: "indisponible",
      message: `Introuvable : ${path.join(m.dossier || "?", m.entree || "")}`,
    };
  }

  const deja = processus.get(m.id);
  if (!deja || deja.tue) {
    fs.mkdirSync(LOGS, { recursive: true });
    const cheminJournal = path.join(LOGS, `${m.id}.log`);
    // Repart d'un journal vide si le precedent a depasse le plafond : sans ca,
    // un module redemarre regulierement (ou qui log en continu) fait grossir
    // ce fichier sans fin — et dernieresLignes() le relit ENTIEREMENT en
    // memoire au moindre echec de demarrage.
    try {
      if (fs.statSync(cheminJournal).size > JOURNAL_MAX_OCTETS) fs.truncateSync(cheminJournal, 0);
    } catch (e) {}
    const journal = fs.openSync(cheminJournal, "a");

    const lancement = commandeModule(m);
    const enfant = spawn(lancement.commande, lancement.arguments, {
      cwd: m.dossier,
      stdio: ["ignore", journal, journal],
      windowsHide: true,
      // PYTHONUNBUFFERED : sans cela un module Python n'ecrit dans son journal
      // qu'a la sortie du processus, et un plantage au demarrage reste muet.
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      // shell sous Windows : permet d'appeler un lanceur du PATH (py, python…).
      shell: process.platform === "win32" && lancement.commande !== process.execPath,
    });
    // spawn() duplique le descripteur pour l'enfant : celui-ci a desormais sa
    // propre copie, et rien ne ferme jamais celle-ci cote Factory (Node ne le
    // fait pas automatiquement pour un fd ouvert "a la main" et passe en
    // stdio). Sans ce close, chaque redemarrage d'un module fuit un
    // descripteur — a la longue (un module instable relance souvent), le
    // process Factory finit par epuiser sa limite de descripteurs (EMFILE) et
    // ne peut plus rien demarrer ni servir la moindre requete.
    try { fs.closeSync(journal); } catch (e) {}
    enfant.tue = false;
    enfant.on("exit", (code) => {
      enfant.tue = true;
      console.log(`  [${m.id}] arrêté (code ${code})`);
    });
    enfant.on("error", (err) => {
      enfant.tue = true;
      console.error(`  [${m.id}] échec du lancement : ${err.message}`);
    });
    processus.set(m.id, enfant);
    console.log(`  [${m.id}] démarrage sur le port ${m.port}…`);
  }

  // `delai` : duree pendant laquelle on garde la requete ouverte. Certains
  // modules sont lents (le CV Parser importe docling, et Flask en mode debug
  // le fait deux fois). Sans surcharge, 40 s suffisent aux applications Node.
  const ok = await attendrePort(m.port, m.delai || 40);
  if (ok) {
    console.log(`  [${m.id}] prêt sur http://localhost:${m.port}`);
    return { etat: "pret" };
  }

  // Delai depasse : ce n'est un echec que si le processus est mort. S'il vit
  // encore, il finit souvent d'arriver — l'interface continue de surveiller.
  const enfant = processus.get(m.id);
  if (enfant && !enfant.tue) {
    return {
      etat: "demarrage",
      message: `Toujours en cours de démarrage sur le port ${m.port}.`,
    };
  }
  return {
    etat: "erreur",
    message: `Le module s'est arrêté sans répondre sur le port ${m.port}.`,
    journal: dernieresLignes(m.id),
  };
}

/** Fin du journal d'un module, pour expliquer un echec sans ouvrir le fichier. */
function dernieresLignes(id, nb = 6) {
  try {
    const contenu = fs.readFileSync(path.join(LOGS, `${id}.log`), "utf8");
    return contenu.trim().split(/\r?\n/).slice(-nb).join("\n");
  } catch (err) {
    return "";
  }
}

function arreterModule(m) {
  const enfant = processus.get(m.id);
  if (!enfant || enfant.tue) return { etat: "arrete" };
  try {
    // taskkill /T pour couper aussi les éventuels sous-processus sous Windows.
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(enfant.pid), "/T", "/F"], { windowsHide: true });
    } else {
      enfant.kill();
    }
  } catch (err) {
    return { etat: "erreur", message: err.message };
  }
  return { etat: "arrete" };
}

function toutArreter() {
  for (const m of MODULES) {
    if (m.type === "service") arreterModule(m);
  }
}

// ── Serveur HTTP ─────────────────────────────────────────────────────────────

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",   // mascotte 3D du hub
  ".webp": "image/webp",
};

function repondreJson(rep, code, donnees) {
  const corps = JSON.stringify(donnees);
  rep.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  rep.end(corps);
}

// ── Voyant IA (widget du hub) ────────────────────────────────────────────────
//
// Le hub affichait autrefois un indicateur qui appelait OVHcloud et Mistral AI
// DEPUIS LE NAVIGATEUR (public/llm.js, retiré). Avec la passerelle interne
// ADBI, ce n'est plus possible sans exposer ADBI_LLM_API_KEY dans le JS servi
// à chaque visiteur : la clé reste donc ici, côté serveur, et le navigateur ne
// parle qu'à ces deux routes.
const LLM_BASE_URL = (process.env.ADBI_LLM_BASE_URL || "").replace(/\/+$/, "");
const LLM_API_KEY = process.env.ADBI_LLM_API_KEY || "";
const LLM_MODELES = (process.env.ADBI_LLM_MODELS || process.env.ADBI_LLM_MODEL || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function testerModeleLlm(modele) {
  const entetes = { "Content-Type": "application/json" };
  if (LLM_API_KEY) entetes.Authorization = "Bearer " + LLM_API_KEY;
  const debut = Date.now();
  const rep = await fetch(LLM_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: entetes,
    body: JSON.stringify({
      model: modele,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const ms = Date.now() - debut;
  if (!rep.ok) {
    const texte = await rep.text().catch(() => "");
    throw new Error(`HTTP ${rep.status}` + (texte ? " — " + texte.slice(0, 200) : ""));
  }
  return ms;
}

// Le seul appelant (POST /api/llm/tester) envoie {"modele": "..."} : quelques
// octets. Sans plafond, un corps arbitrairement volumineux serait accumulé
// intégralement en mémoire avant même le JSON.parse — voir coffre/server.js
// (CORPS_MAX, lireCorps) qui applique déjà cette discipline sur ses routes.
const CORPS_JSON_MAX = 8 * 1024;

function erreurCorpsTropVolumineux() {
  const err = new Error("Corps de requête trop volumineux.");
  err.code = 413;
  return err;
}

function lireCorpsJson(req) {
  return new Promise((resoudre, rejeter) => {
    // Content-Length annoncé au-delà du plafond : on rejette avant même de
    // lire un octet (réponse propre, rien n'est accumulé).
    const annonce = Number(req.headers["content-length"]);
    if (Number.isFinite(annonce) && annonce > CORPS_JSON_MAX) {
      return rejeter(erreurCorpsTropVolumineux());
    }

    const morceaux = [];
    let taille = 0;
    req.on("data", (bloc) => {
      taille += bloc.length;
      // Garde-fou si Content-Length est absent, mensonger ou en chunked : on
      // arrête d'accumuler dès le dépassement (mémoire bornée), même si la
      // rupture de connexion qui suit est moins propre qu'un 413 lu par le
      // client — même compromis que coffre/server.js (lireCorps).
      if (taille > CORPS_JSON_MAX) {
        rejeter(erreurCorpsTropVolumineux());
        req.destroy();
        return;
      }
      morceaux.push(bloc);
    });
    req.on("end", () => {
      try {
        resoudre(JSON.parse(Buffer.concat(morceaux).toString("utf8") || "{}"));
      } catch (e) {
        resoudre({});
      }
    });
    req.on("error", (err) => rejeter(err));
  });
}

function servirFichier(rep, chemin) {
  fs.readFile(chemin, (err, contenu) => {
    if (err) {
      rep.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      rep.end("Introuvable");
      return;
    }
    rep.writeHead(200, {
      "Content-Type": TYPES[path.extname(chemin).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    rep.end(contenu);
  });
}

const serveur = http.createServer(async (req, rep) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chemin = decodeURIComponent(url.pathname);

  // ── API ──
  if (chemin === "/api/modules" && req.method === "GET") {
    const liste = [];
    for (const m of MODULES) {
      liste.push({
        id: m.id,
        nom: m.nom,
        accroche: m.accroche,
        detail: m.detail,
        tags: m.tags || [],
        icone: m.icone,
        type: m.type,
        port: m.port || null,
        url: urlModule(m),
        // Prévient l'interface qu'il faut annoncer une attente inhabituelle.
        delai_long: (m.delai || 40) > 50,
        etat: await etatModule(m),
      });
    }
    return repondreJson(rep, 200, { modules: liste });
  }

  const action = chemin.match(/^\/api\/modules\/([\w-]+)\/(demarrer|arreter)$/);
  if (action && req.method === "POST") {
    const m = trouverModule(action[1]);
    if (!m) return repondreJson(rep, 404, { erreur: "Module inconnu" });
    const resultat =
      action[2] === "demarrer" ? await demarrerModule(m) : arreterModule(m);
    return repondreJson(rep, 200, {
      id: m.id,
      url: urlModule(m),
      ...resultat,
    });
  }

  if (chemin === "/api/llm/chaine" && req.method === "GET") {
    return repondreJson(rep, 200, {
      configure: !!LLM_BASE_URL && LLM_MODELES.length > 0,
      modeles: LLM_MODELES,
    });
  }

  if (chemin === "/api/llm/tester" && req.method === "POST") {
    if (!LLM_BASE_URL) return repondreJson(rep, 200, { ok: false, erreur: "Passerelle non configurée (ADBI_LLM_BASE_URL)." });
    let corps;
    try {
      corps = await lireCorpsJson(req);
    } catch (err) {
      // err.code peut être un code système ("ECONNRESET" si le client coupe
      // la connexion en cours de lecture, via req.on("error", rejeter)) :
      // writeHead exige un entier, on ne relaie donc que notre propre 413.
      return repondreJson(rep, err.code === 413 ? 413 : 400, { ok: false, erreur: err.message });
    }
    const modele = (corps.modele || LLM_MODELES[0] || "").trim();
    if (!modele) return repondreJson(rep, 200, { ok: false, erreur: "Aucun modèle à tester." });
    try {
      const ms = await testerModeleLlm(modele);
      return repondreJson(rep, 200, { ok: true, modele, ms });
    } catch (e) {
      return repondreJson(rep, 200, { ok: false, modele, erreur: e.message });
    }
  }

  if (chemin.startsWith("/api/")) return repondreJson(rep, 404, { erreur: "Route inconnue" });

  // La charte commune vit dans theme/ (source unique, recopiee dans les
  // applications par scripts/sync-theme.js). La Factory la sert directement
  // plutot que d'en garder une copie de plus dans public/.
  if (chemin === "/adbi-theme.css" || chemin === "/adbi-theme.js") {
    return servirFichier(rep, path.join(RACINE, "theme", chemin.slice(1)));
  }
  // La charte reference ses polices en relatif : /fonts/... pointe donc ici.
  if (chemin.startsWith("/fonts/") && !chemin.includes("..")) {
    return servirFichier(rep, path.join(RACINE, "theme", chemin.slice(1)));
  }

  // ── Fichiers statiques ──
  let relatif = chemin === "/" ? "/index.html" : chemin;
  if (relatif === "/module") relatif = "/module.html";
  const cible = path.join(PUBLIC, path.normalize(relatif).replace(/^[\\/]+/, ""));
  if (!cible.startsWith(PUBLIC)) {
    rep.writeHead(403);
    return rep.end("Interdit");
  }
  servirFichier(rep, cible);
});

serveur.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  ADBI Factory est déjà lancée sur ce poste (port ${PORT}).\n` +
        `  Ouvrez http://localhost:${PORT} dans votre navigateur.\n`
    );
    process.exit(1);
  }
  throw err;
});

// ── Préchauffage ─────────────────────────────────────────────────────────────
// Les modules « service » démarrent DÈS l'ouverture de la Factory, en
// arrière-plan : au premier clic sur une tuile, le port répond déjà et le
// module s'ouvre aussitôt — au lieu de faire patienter l'utilisateur le temps
// d'un démarrage à froid (le CV Parser charge son moteur d'extraction pendant
// près d'une minute). Les plus rapides partent en premier, échelonnés pour ne
// pas marteler le disque au démarrage du poste.
// Se désactive au besoin : ADBI_SANS_PRECHAUFFAGE=1, ou "prechauffage": false
// sur un module dans modules.json.
async function prechaufferModules() {
  if (process.env.ADBI_SANS_PRECHAUFFAGE === "1") {
    console.log("  Préchauffage désactivé (ADBI_SANS_PRECHAUFFAGE=1).");
    return;
  }
  const services = MODULES
    // Un module conteneurisé n'a pas de `dossier` local à vérifier (moduleInstalle
    // renverrait toujours faux) : son propre conteneur, démarré par
    // docker-compose, en tient lieu.
    .filter((m) => m.type === "service" && m.prechauffage !== false && (m.conteneur || moduleInstalle(m)))
    .sort((a, b) => (a.delai || 40) - (b.delai || 40));
  if (!services.length) return;

  console.log("  Préchauffage : " + services.map((m) => m.nom).join(", ") + "…");
  for (const m of services) {
    const depart = Date.now();
    demarrerModule(m)
      .then((r) => {
        const duree = ((Date.now() - depart) / 1000).toFixed(1);
        if (r.etat === "pret") {
          console.log(`  [préchauffage] ${m.nom} — prêt en ${duree} s`);
        } else {
          console.log(`  [préchauffage] ${m.nom} — ${r.etat}${r.message ? " : " + r.message : ""}`);
        }
      })
      .catch((err) => console.log(`  [préchauffage] ${m.nom} — ${err.message}`));
    await attendre(800);
  }
}

serveur.listen(PORT, HOTE, () => {
  console.log("");
  console.log("  ADBI Factory — prêt sur http://" + HOTE + ":" + PORT);
  console.log("  Modules : " + MODULES.map((m) => m.nom).join(", "));
  console.log("  (Fermez cette fenêtre pour arrêter la plateforme.)");
  console.log("");
  prechaufferModules();
});

// Arrêt propre : on coupe les applications démarrées par la Factory.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    toutArreter();
    process.exit(0);
  });
}
process.on("exit", toutArreter);
