/**
 * One pager — serveur local.
 *
 * Chaine complete : fichier -> ingestion -> segmentation -> extraction ->
 * cv_master (stocke, editable) -> reduction -> one-pager (PDF / PPTX / JSON).
 *
 * Outil mono-utilisateur lance en local : pas d'authentification, et une erreur
 * inattendue est journalisee sans couper le serveur (rester en ligne vaut mieux
 * qu'un « connexion refusee » en pleine saisie).
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { ingest } = require("./lib/ingest");
const { segment } = require("./lib/layout");
const { extract } = require("./lib/extract");
const { build, GABARIT, cheminBadge } = require("./lib/onepager");
const { buildPptx, buildLivret } = require("./lib/render-pptx");
const db = require("./lib/db.pg");

const PORT = Number(process.env.PORT) || 4200;
// DATABASE_URL est REQUISE (issue #16, PR B) : ce service ne sait plus parler
// qu'à PostgreSQL — plus de repli sql.js/fichier. Échec net et explicite au
// démarrage plutôt qu'une erreur tardive au premier appel de route.
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante — voir .env.example (PostgreSQL est requis depuis la PR B de l'issue #16).");
  process.exit(1);
}
// Local par defaut (poste de dev) ; le Dockerfile passe ADBI_HOTE=0.0.0.0 —
// sans ca, "127.0.0.1" a l'interieur du conteneur n'est PAS atteignable via
// le port publie ("-p 4200:4200" arrive sur l'interface externe, pas la
// loopback), meme si le HEALTHCHECK (execute dans le meme conteneur) semble
// fonctionner.
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";

/**
 * Une erreur inattendue est journalisee sans couper le serveur : en pleine
 * saisie, rester en ligne vaut mieux qu'un « connexion refusee ».
 *
 * EXCEPTION : les erreurs de demarrage. Un port deja pris signifie qu'une
 * autre instance tourne. Survivre a cette erreur laissait un processus
 * fantome, sans port mais avec la base ouverte en memoire — et comme la
 * persistance reecrit le fichier ENTIER, la derniere instance a ecrire
 * ecrasait le travail de l'autre. Un CV importe pouvait disparaitre.
 */
let demarre = false;
process.on("uncaughtException", (e) => {
  if (!demarre) {
    console.error("\n  [ARRÊT] " + messageDemarrage(e) + "\n");
    process.exit(1);
  }
  console.error("[erreur non gérée]", e && e.message ? e.message : e);
});
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e && e.message ? e.message : e));

function messageDemarrage(e) {
  if (e && e.code === "EADDRINUSE") {
    return `One pager est déjà lancé sur ce poste (port ${PORT}).\n` +
           "  Utilisez la fenêtre déjà ouverte, ou fermez-la avant de relancer.\n" +
           "  Deux instances simultanées se répartiraient mal la base de CV.";
  }
  return "Démarrage impossible : " + (e && e.message ? e.message : e);
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------- Import -----

/**
 * POST /api/import  { filename, contentBase64 }
 * Renvoie le cv_master extrait, sans l'enregistrer : l'utilisateur valide
 * d'abord (etape 2), c'est lui qui declenche l'enregistrement.
 */
app.post("/api/import", async (req, res) => {
  try {
    const { filename, contentBase64 } = req.body || {};
    if (!contentBase64) return res.status(400).json({ error: "Aucun fichier reçu." });

    const buffer = Buffer.from(contentBase64, "base64");
    if (buffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: "Fichier trop volumineux (20 Mo maximum)." });
    }

    const t0 = Date.now();
    const doc = await ingest(buffer, filename);

    if (doc.scanned) {
      return res.status(422).json({
        error: "Ce PDF ne contient pas de texte : il s'agit probablement d'un scan ou d'une image. " +
               "Exportez le CV en PDF texte ou en Word, puis réimportez-le.",
      });
    }
    if (!doc.charCount) {
      return res.status(422).json({ error: "Aucun texte n'a pu être lu dans ce fichier." });
    }

    const master = extract(doc, segment(doc));
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const existant = await db.findByHash(hash);

    res.json({
      id: crypto.randomUUID(),
      hash,
      master,
      duree_ms: Date.now() - t0,
      // Un meme fichier deja importe : on previent au lieu de creer un doublon.
      doublon: existant ? { id: existant.id, nom: existant.nom, maj_le: existant.maj_le } : null,
    });
  } catch (e) {
    console.error("[import]", e);
    res.status(500).json({ error: "Lecture impossible : " + (e.message || "erreur inconnue") });
  }
});

// --------------------------------------------------------------- CRUD -----

app.get("/api/cvs", async (req, res) => {
  try {
    res.json(await db.search(req.query.q));
  } catch (e) {
    console.error("[cvs:list]", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/cvs/:id", async (req, res) => {
  try {
    const r = await db.get(req.params.id);
    if (!r) return res.status(404).json({ error: "CV introuvable." });
    res.json(r);
  } catch (e) {
    console.error("[cvs:get]", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/cvs", async (req, res) => {
  try {
    const { id, hash, master, options } = req.body || {};
    if (!master || !master.identity) return res.status(400).json({ error: "Données invalides." });
    res.json(await db.save({ id: id || crypto.randomUUID(), hash, master, options }));
  } catch (e) {
    console.error("[save]", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/cvs/:id", async (req, res) => {
  try {
    await db.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[cvs:delete]", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------- One-pager -----

/** POST /api/onepager  { master, options } -> projection budgetee, sans effet de bord. */
app.post("/api/onepager", (req, res) => {
  try {
    const { master, options } = req.body || {};
    if (!master) return res.status(400).json({ error: "cv_master manquant." });
    res.json(build(master, options || {}));
  } catch (e) {
    console.error("[onepager]", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/export/pptx", async (req, res) => {
  try {
    const { master, options, op: opAffiche } = req.body || {};
    // L'apercu transmet le dossier tel qu'il l'affiche : c'est lui qui fait foi.
    // Le recalcul serveur ne sert que de repli (appel direct a l'API).
    const op = opAffiche && Array.isArray(opAffiche.experiences)
      ? opAffiche
      : master ? build(master, options || {}) : null;
    if (!op) return res.status(400).json({ error: "cv_master manquant." });
    const buffer = await buildPptx(op);
    const nom = fileSafe(op.header.name || "one-pager");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="One-pager-${nom}.pptx"`);
    res.send(buffer);
  } catch (e) {
    console.error("[pptx]", e);
    res.status(500).json({ error: e.message });
  }
});

// Plafond sur le nombre de profils UNIQUES d'un livret. Cote client, la
// selection vient de cases a cocher dans l'historique (etat.selection est deja
// un Set), donc un usage reel ne depasse jamais quelques dizaines de profils —
// ce plafond est la pour un corps de requete forge, pas pour l'usage normal.
// Sans lui, un seul identifiant valide repete des milliers de fois passe le
// filtre `filter(Boolean)` (il EXISTE, juste duplique) et fait generer a
// buildLivret autant de slides (image + mesure de texte chacune), bloquant
// le service entier (mono-process, pas de pool de workers) — voir issue #68.
const LIVRET_MAX_PROFILS = Number(process.env.LIVRET_MAX_PROFILS) || 200;

/**
 * POST /api/export/livret  { ids: [...], options }
 * Assemble un seul .pptx : page de garde puis une slide par consultant.
 * Les options de rendu sont communes a tout le livret — melanger noms complets
 * et trigrammes dans un meme document n'aurait pas de sens.
 */
app.post("/api/export/livret", async (req, res) => {
  try {
    const { ids: idsBruts, options } = req.body || {};
    if (!Array.isArray(idsBruts) || !idsBruts.length) {
      return res.status(400).json({ error: "Aucun profil sélectionné." });
    }
    // Dedoublonnage AVANT le plafond : un meme identifiant repete plusieurs
    // fois (par erreur cote client, ou forge) ne doit compter qu'une fois —
    // sinon le plafond se contourne trivialement en repetant un seul id valide.
    const ids = [...new Set(idsBruts)].filter((id) => typeof id === "string" && id);
    if (!ids.length) {
      return res.status(400).json({ error: "Aucun profil sélectionné." });
    }
    if (ids.length > LIVRET_MAX_PROFILS) {
      return res.status(400).json({
        error: `Trop de profils pour un seul livret (${ids.length}, max ${LIVRET_MAX_PROFILS}) — genere-le en plusieurs lots.`,
      });
    }

    const fiches = await Promise.all(ids.map((id) => db.get(id)));
    const dossiers = fiches
      .filter(Boolean)
      // Les reglages du livret priment sur ceux memorises par dossier :
      // c'est le document assemble qui doit etre homogene.
      .map((rec) => build(rec.master, { ...(rec.options || {}), ...(options || {}) }));

    if (!dossiers.length) return res.status(404).json({ error: "Profils introuvables." });

    const buffer = await buildLivret(dossiers, {
      titre: "Livret de compétences",
      sousTitre: `${dossiers.length} profil${dossiers.length > 1 ? "s" : ""}`,
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="Livret-ADBI.pptx"`);
    res.send(buffer);
  } catch (e) {
    console.error("[livret]", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/matching  { offre }
 * Classe tout le vivier par adequation a une fiche de poste.
 */
app.post("/api/matching", async (req, res) => {
  try {
    const offre = String((req.body || {}).offre || "").trim();
    if (offre.length < 15) return res.status(400).json({ error: "Fiche de poste trop courte." });

    const matching = require("./lib/matching");
    const resumes = await db.list();
    // Une seule lecture complete par CV (master + options) : le classement a
    // besoin du master, l'habillage du resultat a besoin des options — les
    // charger ensemble evite un second aller-retour base par candidat plus bas.
    const fiches = await Promise.all(resumes.map(async (r) => {
      const complet = await db.get(r.id);
      return { ...r, master: complet.master, options: complet.options || {} };
    }));

    // L'identifiant est glisse dans le cv_master avant classement : se fier a
    // l'identite des objets pour les retrouver ensuite serait fragile, le
    // moteur etant libre de travailler sur des copies.
    fiches.forEach((f) => { f.master.__ref = f.id; });
    const { besoin, resultats } = matching.classer(fiches.map((f) => f.master), offre);
    const parId = new Map(fiches.map((f) => [f.id, f]));

    res.json({
      besoin,
      resultats: resultats.map((r) => {
        const meta = parId.get(r.cv && r.cv.__ref) || {};
        // Le portrait suit le profil : photo importee si elle existe, sinon
        // l'illustration choisie pour son dossier, sinon celle par defaut.
        const opt = meta.options || {};
        return {
          ...r,
          cv: {
            id: meta.id, nom: meta.nom, titre: meta.titre, trigramme: meta.trigramme,
            portrait: opt.photo || "assets/" + (opt.avatar || "avatar-homme-rose.png"),
          },
        };
      }).filter((r) => r.cv.id),
    });
  } catch (e) {
    console.error("[matching]", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/templates", (req, res) =>
  res.json(Object.entries(GABARIT).map(([key, g]) => ({ key, label: g.label })))
);

/** Bibliotheque d'illustrations : avatars et logos de certification. */
app.get("/api/assets", (req, res) => {
  const dir = path.join(__dirname, "public", "assets");
  const lire = (sous, filtre) => {
    const d = path.join(dir, sous);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(filtre).sort();
  };
  res.json({
    // Les PNG servent aussi bien a l'apercu qu'a l'export PowerPoint,
    // qui n'accepte pas le SVG sans repli.
    avatars: lire("", (f) => /^avatar-.*\.png$/i.test(f)),
    badges: catalogueBadges(path.join(dir, "badges")),
  });
});

const DOSSIER_BADGES = path.join(__dirname, "public", "assets", "badges");

// Un libelle sert de NOM DE FICHIER : on limite le jeu de caracteres au lieu de
// se contenter d'echapper, et on refuse tout ce qui n'y entre pas. Les points
// sont admis (« Scrum.org ») mais pas deux de suite, qui ouvriraient un « .. ».
const RE_LIBELLE = /^[\wÀ-ÿ .()&+'’-]{1,60}$/;

function libelleValide(s) {
  const t = String(s || "").trim();
  return RE_LIBELLE.test(t) && !t.includes("..") ? t : "";
}

/**
 * POST /api/badges  { editeur, libelle, contentBase64 }
 *
 * Range une image de certification dans la bibliotheque, sous le dossier de
 * son editeur. C'est le pendant du depot manuel de fichiers : meme resultat,
 * mais sans quitter l'application.
 */
app.post("/api/badges", (req, res) => {
  try {
    const editeur = libelleValide(req.body.editeur);
    const libelle = libelleValide(req.body.libelle);
    if (!editeur) return res.status(400).json({ error: "Nom d'éditeur invalide ou absent." });
    if (!libelle) return res.status(400).json({ error: "Libellé invalide ou absent." });

    const brut = String(req.body.contentBase64 || "").replace(/^data:[^,]*,/, "");
    const octets = Buffer.from(brut, "base64");
    if (!octets.length) return res.status(400).json({ error: "Image vide." });
    if (octets.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: "Image trop lourde (4 Mo maximum)." });
    }

    // On se fie aux octets, pas au nom annonce : sans cette verification, on
    // ecrirait n'importe quel contenu sous une extension d'image.
    const ext = typeImage(octets);
    if (!ext) return res.status(400).json({ error: "Seuls les fichiers PNG et JPEG sont acceptés." });

    const cle = cheminBadge(editeur + "/" + libelle + ext);
    if (!cle.includes("/")) return res.status(400).json({ error: "Nom de fichier refusé." });

    const cible = path.join(DOSSIER_BADGES, cle);
    // Ceinture et bretelles : on verifie que le chemin resolu reste dans la
    // bibliotheque, quoi qu'ait pu produire l'assainissement en amont.
    if (!cible.startsWith(DOSSIER_BADGES + path.sep)) {
      return res.status(400).json({ error: "Chemin refusé." });
    }
    if (fs.existsSync(cible)) {
      return res.status(409).json({ error: `« ${libelle} » existe déjà chez ${editeur}.` });
    }

    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.writeFileSync(cible, octets);
    res.json({ cle, editeur, libelle });
  } catch (e) {
    console.error("[badges]", e);
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/badges?cle=Editeur/fichier.png — retire une image du disque. */
app.delete("/api/badges", (req, res) => {
  const cle = cheminBadge(req.query.cle || "");
  // Seules les images rangees sous un editeur sont supprimables. Les fichiers
  // restes a plat sont ceux d'origine, references par des dossiers deja
  // enregistres : les effacer les casserait.
  if (!cle.includes("/")) {
    return res.status(400).json({ error: "Seules les images ajoutées depuis l'application peuvent être supprimées." });
  }
  const cible = path.join(DOSSIER_BADGES, cle);
  if (!cible.startsWith(DOSSIER_BADGES + path.sep) || !fs.existsSync(cible)) {
    return res.status(404).json({ error: "Image introuvable." });
  }
  fs.unlinkSync(cible);
  res.json({ ok: true });
});

/** Extension deduite des octets, ou vide si ce n'est pas une image acceptee. */
function typeImage(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  return "";
}

/**
 * Catalogue des badges, groupe par editeur.
 *
 * Deux provenances, volontairement :
 *  - les fichiers deposes dans un SOUS-DOSSIER, dont le nom donne l'editeur et
 *    le nom de fichier le libelle. C'est la voie normale pour en ajouter : il
 *    suffit de deposer l'image, sans toucher au code ni au catalogue.
 *  - les fichiers restes a plat (badge-12.png), heritage des premiers imports.
 *    Leur nom ne dit rien, donc catalogue.json les decrit. On ne les renomme
 *    PAS : les dossiers de competences deja enregistres pointent dessus.
 */
function catalogueBadges(racine) {
  if (!fs.existsSync(racine)) return [];

  let decrits = {};
  try {
    decrits = JSON.parse(fs.readFileSync(path.join(racine, "catalogue.json"), "utf8"));
  } catch (_) { /* catalogue absent ou illisible : on se rabat sur les noms de fichiers */ }

  const estImage = (f) => /\.(png|jpe?g)$/i.test(f);
  const groupes = new Map();
  const ajouter = (editeur, cle, libelle) => {
    if (!groupes.has(editeur)) groupes.set(editeur, []);
    groupes.get(editeur).push({ cle, libelle });
  };

  for (const e of fs.readdirSync(racine, { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(racine, e.name)).filter(estImage)) {
        ajouter(e.name, e.name + "/" + f, f.replace(/\.\w+$/, ""));
      }
    } else if (estImage(e.name)) {
      const d = decrits[e.name];
      if (d && d.exclu) continue;
      ajouter(
        (d && d.editeur) || "Autres",
        e.name,
        (d && d.libelle) || e.name.replace(/\.\w+$/, "")
      );
    }
  }

  return [...groupes.entries()]
    .map(([editeur, items]) => ({
      editeur,
      items: items.sort((a, b) => a.libelle.localeCompare(b.libelle, "fr")),
    }))
    // « Autres » ferme la marche : c'est le fourre-tout, pas un editeur.
    .sort((a, b) =>
      (a.editeur === "Autres") - (b.editeur === "Autres") ||
      a.editeur.localeCompare(b.editeur, "fr"));
}

function fileSafe(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "cv";
}

// ------------------------------------------------------------ Demarrage ---

db.init()
  .then(() => {
    // Local par defaut : le vivier contient des CV de candidats (donnees
    // personnelles), consultable sans mot de passe — ne pas lier "0.0.0.0" en
    // poste de dev. En conteneur, ADBI_HOTE=0.0.0.0 (Dockerfile) : l'isolation
    // reseau est alors assuree par Docker/le reverse proxy, pas par la loopback.
    const serveur = app.listen(PORT, HOTE, () => {
      demarre = true;
      console.log("");
      console.log("  One pager — prêt sur http://" + HOTE + ":" + PORT);
      console.log("  Base : PostgreSQL (DATABASE_URL)");
      console.log("");
    });

    // Sans ce gestionnaire, l'echec de « listen » remonte en erreur non geree
    // et le processus survivrait sans port : voir le commentaire en tete.
    serveur.on("error", (e) => {
      console.error("\n  [ARRÊT] " + messageDemarrage(e) + "\n");
      process.exit(1);
    });
  })
  .catch((e) => {
    console.error("Impossible d'initialiser la base :", e);
    process.exit(1);
  });
