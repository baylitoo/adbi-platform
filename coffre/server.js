/*
 * ADBI Coffre — chiffrement local de documents.
 *
 * Chiffre et déchiffre des fichiers en AES-256-GCM, la clé étant dérivée du
 * mot de passe par scrypt. Tout se passe sur ce poste : le serveur n'écoute
 * qu'en local (127.0.0.1), n'écrit aucun fichier et ne conserve aucun mot de
 * passe — chaque requête est traitée en mémoire puis oubliée.
 *
 * Aucune dépendance npm : uniquement les modules natifs de Node 18+. Pour un
 * outil de chiffrement c'est un choix délibéré, pas une coquetterie : aucune
 * bibliothèque tierce à auditer, aucune mise à jour piégée possible.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const docx = require("./docx");

const PORT = Number(process.env.ADBI_COFFRE_PORT) || 4300;
// Local par defaut (poste de dev) ; le Dockerfile passe ADBI_HOTE=0.0.0.0 —
// sans ca, "127.0.0.1" a l'interieur du conteneur n'est PAS atteignable via
// le port publie ("-p 4300:4300" arrive sur l'interface externe, pas la
// loopback), meme si le HEALTHCHECK (execute dans le meme conteneur) semble
// fonctionner (voir le meme correctif sur one-pager, PR #38).
const HOTE = process.env.ADBI_HOTE || "127.0.0.1";
const RACINE = __dirname;
const PUBLIC = path.join(RACINE, "public");

// Les détecteurs d'informations sensibles sont écrits UNE fois (public/) et
// servent aux deux côtés : le navigateur pour les PDF, le serveur pour les
// documents Word. Ils sont évalués ici dans un bac à sable dédié.
const DETECTEURS = (() => {
  const bac = vm.createContext({});
  for (const fichier of ["prenoms.js", "detecteurs.js"]) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, fichier), "utf8"), bac, {
      filename: fichier,
    });
  }
  return bac.COFFRE_DETECTEURS;
})();

// ── Format de fichier .adbi ──────────────────────────────────────────────────
//
//   [ 6 o  magic "ADBIC1" ][ 1 o log2(N) ][ 1 o r ][ 1 o p ]
//   [ 16 o sel ][ 12 o IV ][ données chiffrées ][ 16 o étiquette GCM ]
//
// L'en-tête clair (37 octets) sert de données authentifiées (AAD) : le
// modifier fait échouer le déchiffrement, exactement comme une altération du
// contenu. Le nom du fichier d'origine voyage DANS la partie chiffrée
// ([2 o longueur][nom UTF-8][contenu]) : un .adbi qui traîne ne révèle rien,
// et le déchiffrement restitue le vrai nom.

const MAGIC = Buffer.from("ADBIC1");   // clé dérivée d'un mot de passe (scrypt)
const MAGIC2 = Buffer.from("ADBIC2");  // clé locale de l'application (HKDF)
const TAILLE_SEL = 16;
const TAILLE_IV = 12;
const TAILLE_TAG = 16;
const ENTETE = MAGIC.length + 3 + TAILLE_SEL + TAILLE_IV; // 37 octets

// Paramètres scrypt à l'écriture : N = 2^17, r = 8, p = 1 (recommandation
// OWASP, ~128 Mio de mémoire par dérivation). Ils sont inscrits dans chaque
// fichier : une future version pourra les durcir sans casser l'existant.
const SCRYPT = { log2N: 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const CORPS_MAX = 512 * 1024 * 1024; // documents : au-delà, refus net et clair
const NOM_MAX = 512; // octets UTF-8 du nom conservé dans l'enveloppe
const MDP_MIN = 8;

/** Erreur destinée à l'utilisateur : code HTTP + message en français. */
class ErreurCoffre extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Clé locale de l'application ──────────────────────────────────────────────
// Mode « sans mot de passe » : la clé vit sur ce poste (data/cle-locale.bin),
// créée au premier lancement. Un document protégé ainsi ne se déchiffre que
// par l'application détenant cette clé — à SAUVEGARDER : la perdre, c'est
// perdre les originaux. La copier sur un autre poste ADBI le rend capable de
// déchiffrer aussi.

const DOSSIER_DONNEES = path.join(RACINE, "data");
const CHEMIN_CLE = path.join(DOSSIER_DONNEES, "cle-locale.bin");

const CLE_LOCALE = (() => {
  if (!fs.existsSync(CHEMIN_CLE)) {
    fs.mkdirSync(DOSSIER_DONNEES, { recursive: true });
    fs.writeFileSync(CHEMIN_CLE, crypto.randomBytes(32));
    console.log("  [coffre] clé locale créée : " + CHEMIN_CLE);
  }
  const cle = fs.readFileSync(CHEMIN_CLE);
  if (cle.length !== 32) {
    console.error("  [ERREUR] " + CHEMIN_CLE + " est corrompue (taille inattendue).");
    process.exit(1);
  }
  return cle;
})();

// ── Chiffrement ──────────────────────────────────────────────────────────────

function deriverCle(motDePasse, sel, params) {
  return new Promise((resoudre, rejeter) => {
    crypto.scrypt(
      motDePasse,
      sel,
      32,
      { N: 2 ** params.log2N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, cle) => (err ? rejeter(err) : resoudre(cle))
    );
  });
}

/** Clé de séance en mode « clé locale » : HKDF-SHA256, un sel par fichier. */
function deriverCleLocale(sel) {
  return Buffer.from(crypto.hkdfSync("sha256", CLE_LOCALE, sel, Buffer.from("adbi-coffre-v2"), 32));
}

// ── Registre des références ──────────────────────────────────────────────────
// « ADBI-7K4M → CV Sophie Martin.pdf, le 13/08/2026 » : c'est la table qui
// permet de ré-identifier un document anonymisé. Elle est donc chiffrée par la
// clé locale, exactement comme les originaux — un registre en clair posé à côté
// de l'application annulerait le travail d'anonymisation pour quiconque ouvre
// le dossier. Elle ne quitte jamais ce poste.

const CHEMIN_REGISTRE = path.join(DOSSIER_DONNEES, "references.bin");
const REGISTRE_MAX = 5000;

function cleRegistre(sel) {
  return Buffer.from(
    crypto.hkdfSync("sha256", CLE_LOCALE, sel, Buffer.from("adbi-coffre-registre"), 32)
  );
}

function lireRegistre() {
  if (!fs.existsSync(CHEMIN_REGISTRE)) return [];
  try {
    const brut = fs.readFileSync(CHEMIN_REGISTRE);
    const dechiffreur = crypto.createDecipheriv(
      "aes-256-gcm", cleRegistre(brut.subarray(0, 16)), brut.subarray(16, 28)
    );
    dechiffreur.setAuthTag(brut.subarray(brut.length - 16));
    const clair = Buffer.concat([
      dechiffreur.update(brut.subarray(28, brut.length - 16)),
      dechiffreur.final(),
    ]);
    const liste = JSON.parse(clair.toString("utf8"));
    return Array.isArray(liste) ? liste : [];
  } catch (err) {
    // Registre illisible (clé locale remplacée, fichier corrompu) : on repart
    // d'une liste vide plutôt que d'empêcher toute protection de document.
    console.error("  [coffre] registre des références illisible : " + err.message);
    return [];
  }
}

function ecrireRegistre(liste) {
  const sel = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chiffreur = crypto.createCipheriv("aes-256-gcm", cleRegistre(sel), iv);
  const corps = Buffer.concat([
    chiffreur.update(Buffer.from(JSON.stringify(liste), "utf8")),
    chiffreur.final(),
  ]);
  fs.mkdirSync(DOSSIER_DONNEES, { recursive: true });
  fs.writeFileSync(CHEMIN_REGISTRE, Buffer.concat([sel, iv, corps, chiffreur.getAuthTag()]));
}

/**
 * Attribue — ou retrouve — la référence d'un document, à partir de son
 * empreinte stable.
 *
 * C'est le serveur qui attribue, et non le navigateur : la référence porte le
 * mois du PREMIER traitement, information que seul le registre détient. Un
 * document redéposé en octobre garde ainsi la référence reçue en août.
 */
function attribuerReference(demande) {
  const maintenant = new Date();
  const iso = maintenant.toISOString();
  const liste = lireRegistre();
  const connue = liste.find((e) => e.empreinte === demande.empreinte);

  if (connue) {
    connue.dernier = iso;
    connue.passages = (connue.passages || 1) + 1;
    if (demande.mode) connue.mode = demande.mode;
    if (demande.sortie) connue.sortie = demande.sortie;
    ecrireRegistre(liste);
    return { entree: connue, deja: true };
  }

  const nouvelle = {
    reference: DETECTEURS.construireReference(
      DETECTEURS.prefixeDocument(demande.nom), maintenant, demande.empreinte
    ),
    empreinte: demande.empreinte,
    nom: demande.nom || "",
    sortie: demande.sortie || "",
    format: demande.format || "",
    mode: demande.mode || "",
    cree: iso,
    dernier: iso,
    passages: 1,
    document: false,
  };
  liste.unshift(nouvelle);
  ecrireRegistre(liste.slice(0, REGISTRE_MAX));
  return { entree: nouvelle, deja: false };
}

/** Complète une entrée sans compter un passage de plus : le nom du fichier
 *  produit n'est connu qu'après la protection, mais c'est le même passage. */
function completerReference(reference, champs) {
  const liste = lireRegistre();
  const entree = liste.find((e) => e.reference === reference);
  if (!entree) return;
  Object.assign(entree, champs);
  ecrireRegistre(liste);
}

// ── Documents conservés, pour pouvoir relire un CV depuis sa référence ───────
// Le document produit est rangé chiffré par la clé locale : le registre sert à
// retrouver « le CV qui porte ce code », pas seulement son nom.

const DOSSIER_DOCUMENTS = path.join(DOSSIER_DONNEES, "documents");
const DOCUMENT_MAX = 30 * 1024 * 1024;

function cheminDocument(reference) {
  // La référence est validée par MOTIF_REFERENCE avant d'arriver ici : aucun
  // séparateur de chemin ne peut s'y glisser.
  return path.join(DOSSIER_DOCUMENTS, reference + ".bin");
}

function rangerDocument(reference, nomFichier, contenu) {
  if (!contenu || !contenu.length || contenu.length > DOCUMENT_MAX) return false;
  const sel = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chiffreur = crypto.createCipheriv("aes-256-gcm", cleRegistre(sel), iv);
  const nom = Buffer.from(String(nomFichier || "document"), "utf8").subarray(0, 255);
  const entete = Buffer.alloc(1);
  entete[0] = nom.length;
  const corps = Buffer.concat([
    chiffreur.update(Buffer.concat([entete, nom, contenu])),
    chiffreur.final(),
  ]);
  fs.mkdirSync(DOSSIER_DOCUMENTS, { recursive: true });
  fs.writeFileSync(cheminDocument(reference), Buffer.concat([sel, iv, corps, chiffreur.getAuthTag()]));

  const liste = lireRegistre();
  const entree = liste.find((e) => e.reference === reference);
  if (entree) { entree.document = true; ecrireRegistre(liste); }
  return true;
}

function sortirDocument(reference) {
  const chemin = cheminDocument(reference);
  if (!fs.existsSync(chemin)) return null;
  const brut = fs.readFileSync(chemin);
  const dechiffreur = crypto.createDecipheriv(
    "aes-256-gcm", cleRegistre(brut.subarray(0, 16)), brut.subarray(16, 28)
  );
  dechiffreur.setAuthTag(brut.subarray(brut.length - 16));
  const clair = Buffer.concat([
    dechiffreur.update(brut.subarray(28, brut.length - 16)),
    dechiffreur.final(),
  ]);
  const taille = clair[0];
  return {
    nom: clair.subarray(1, 1 + taille).toString("utf8"),
    contenu: clair.subarray(1 + taille),
  };
}

/** `motDePasse` vide ou absent : mode clé locale (ADBIC2, sans mot de passe). */
async function chiffrer(contenu, nom, motDePasse) {
  const nomOctets = Buffer.from(nom, "utf8");
  if (nomOctets.length > NOM_MAX) {
    throw new ErreurCoffre(400, "Nom de fichier trop long.");
  }

  const sel = crypto.randomBytes(TAILLE_SEL);
  const iv = crypto.randomBytes(TAILLE_IV);
  const cle = motDePasse ? await deriverCle(motDePasse, sel, SCRYPT) : deriverCleLocale(sel);

  const entete = Buffer.alloc(ENTETE);
  if (motDePasse) {
    MAGIC.copy(entete, 0);
    entete[6] = SCRYPT.log2N;
    entete[7] = SCRYPT.r;
    entete[8] = SCRYPT.p;
  } else {
    MAGIC2.copy(entete, 0);
  }
  sel.copy(entete, 9);
  iv.copy(entete, 9 + TAILLE_SEL);

  const enveloppe = Buffer.alloc(2 + nomOctets.length + contenu.length);
  enveloppe.writeUInt16BE(nomOctets.length, 0);
  nomOctets.copy(enveloppe, 2);
  contenu.copy(enveloppe, 2 + nomOctets.length);

  const chiffreur = crypto.createCipheriv("aes-256-gcm", cle, iv);
  chiffreur.setAAD(entete);
  const donnees = Buffer.concat([chiffreur.update(enveloppe), chiffreur.final()]);
  cle.fill(0); // la clé dérivée ne survit pas à la requête

  return Buffer.concat([entete, donnees, chiffreur.getAuthTag()]);
}

async function dechiffrer(fichier, motDePasse) {
  if (fichier.length < ENTETE + 2 + TAILLE_TAG) {
    throw new ErreurCoffre(415, "Ce fichier n'est pas une charge chiffrée ADBI Coffre.");
  }
  const modeLocal = fichier.subarray(0, MAGIC2.length).equals(MAGIC2);
  if (!modeLocal && !fichier.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ErreurCoffre(415, "Ce fichier n'est pas une charge chiffrée ADBI Coffre.");
  }

  const sel = fichier.subarray(9, 9 + TAILLE_SEL);
  const iv = fichier.subarray(9 + TAILLE_SEL, ENTETE);
  const donnees = fichier.subarray(ENTETE, fichier.length - TAILLE_TAG);
  const etiquette = fichier.subarray(fichier.length - TAILLE_TAG);

  let cle;
  if (modeLocal) {
    cle = deriverCleLocale(sel);
  } else {
    if (!motDePasse) {
      throw new ErreurCoffre(400, "Ce fichier a été protégé par un mot de passe : il est requis pour le déchiffrer.");
    }
    // Garde-fou : un fichier forgé pourrait réclamer une dérivation démesurée
    // et épuiser la mémoire du poste. On n'accepte que des paramètres sensés.
    const params = { log2N: fichier[6], r: fichier[7], p: fichier[8] };
    if (
      params.log2N < 14 || params.log2N > 20 ||
      params.r < 1 || params.r > 16 ||
      params.p < 1 || params.p > 4
    ) {
      throw new ErreurCoffre(415, "Paramètres de chiffrement hors limites : fichier rejeté.");
    }
    cle = await deriverCle(motDePasse, sel, params);
  }

  const dechiffreur = crypto.createDecipheriv("aes-256-gcm", cle, iv);
  dechiffreur.setAAD(fichier.subarray(0, ENTETE));
  dechiffreur.setAuthTag(etiquette);

  let enveloppe;
  try {
    enveloppe = Buffer.concat([dechiffreur.update(donnees), dechiffreur.final()]);
  } catch (err) {
    // GCM ne distingue pas les causes : c'est une propriété, pas un manque.
    throw new ErreurCoffre(
      400,
      modeLocal
        ? "Document protégé par la clé d'un autre poste, ou fichier modifié depuis sa protection."
        : "Mot de passe incorrect, ou fichier modifié depuis son chiffrement."
    );
  } finally {
    cle.fill(0);
  }

  const longueurNom = enveloppe.readUInt16BE(0);
  if (longueurNom > NOM_MAX || 2 + longueurNom > enveloppe.length) {
    throw new ErreurCoffre(400, "Enveloppe illisible : fichier corrompu.");
  }
  return {
    nom: enveloppe.subarray(2, 2 + longueurNom).toString("utf8"),
    contenu: enveloppe.subarray(2 + longueurNom),
  };
}

// ── Serveur HTTP ─────────────────────────────────────────────────────────────

/** Corps brut de la requête, borné : on refuse net plutôt que d'étouffer. */
function lireCorps(req) {
  return new Promise((resoudre, rejeter) => {
    const morceaux = [];
    let taille = 0;
    req.on("data", (m) => {
      taille += m.length;
      if (taille > CORPS_MAX) {
        rejeter(new ErreurCoffre(413, "Fichier trop volumineux (limite : 512 Mo)."));
        req.destroy();
        return;
      }
      morceaux.push(m);
    });
    req.on("end", () => resoudre(Buffer.concat(morceaux)));
    req.on("error", (err) => rejeter(err));
  });
}

/**
 * En-têtes maison (X-Nom-Fichier, X-Cle) encodés par encodeURIComponent côté
 * navigateur : les en-têtes HTTP n'acceptent pas l'UTF-8 brut. Le mot de
 * passe ne transite que sur la boucle locale (127.0.0.1) et n'est jamais
 * journalisé ni conservé.
 */
function lireEnteteEncode(req, nom) {
  const brut = req.headers[nom];
  if (!brut) return "";
  try {
    return decodeURIComponent(brut);
  } catch (err) {
    return "";
  }
}

/** Ne garde que le nom de base et neutralise les caractères interdits. */
function nettoyerNom(nom) {
  const base = String(nom).split(/[\\/]/).pop() || "document";
  return base.replace(/[<>:"|?*\x00-\x1f]/g, "_").trim() || "document";
}

/**
 * Évite qu'un chemin déjà présent dans `entrees` n'écrase silencieusement le
 * précédent (deux fichiers différents ajoutés sous le même nom, par exemple
 * via deux sélections successives depuis des dossiers distincts) : ajoute un
 * suffixe " (2)", " (3)", … avant l'extension, à la manière d'un explorateur
 * de fichiers, jusqu'à trouver un chemin libre.
 */
function nommerSansCollision(entrees, chemin) {
  if (!entrees.has(chemin)) return chemin;
  const pos = chemin.lastIndexOf("/");
  const dossier = pos >= 0 ? chemin.slice(0, pos + 1) : "";
  const feuille = pos >= 0 ? chemin.slice(pos + 1) : chemin;
  const pointExt = feuille.lastIndexOf(".");
  const base = pointExt > 0 ? feuille.slice(0, pointExt) : feuille;
  const ext = pointExt > 0 ? feuille.slice(pointExt) : "";
  let n = 2;
  let candidat;
  do {
    candidat = dossier + base + " (" + n + ")" + ext;
    n++;
  } while (entrees.has(candidat));
  return candidat;
}

function repondreJson(rep, code, donnees) {
  const corps = JSON.stringify(donnees);
  rep.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  rep.end(corps);
}

function repondreFichier(rep, nom, contenu) {
  rep.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": contenu.length,
    "X-Nom-Fichier": encodeURIComponent(nom),
    "Cache-Control": "no-store",
  });
  rep.end(contenu);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

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

  try {
    // ── API ──
    if (chemin === "/api/sante" && req.method === "GET") {
      return repondreJson(rep, 200, { etat: "pret", application: "adbi-coffre" });
    }

    if (chemin === "/api/chiffrer" && req.method === "POST") {
      // Sans X-Cle : mode « clé locale », aucun mot de passe à retenir.
      const motDePasse = lireEnteteEncode(req, "x-cle");
      if (motDePasse && motDePasse.length < MDP_MIN) {
        throw new ErreurCoffre(400, `Mot de passe trop court : ${MDP_MIN} caractères minimum.`);
      }
      const nom = nettoyerNom(lireEnteteEncode(req, "x-nom-fichier"));
      const corps = await lireCorps(req);
      if (corps.length === 0) throw new ErreurCoffre(400, "Fichier vide.");
      const resultat = await chiffrer(corps, nom, motDePasse);
      return repondreFichier(rep, nom + ".adbi", resultat);
    }

    if (chemin === "/api/dechiffrer" && req.method === "POST") {
      // X-Cle facultatif : inutile pour une charge « clé locale » (ADBIC2),
      // exigé par dechiffrer() seulement pour une charge à mot de passe.
      const motDePasse = lireEnteteEncode(req, "x-cle");
      let corps = await lireCorps(req);
      if (corps.length === 0) throw new ErreurCoffre(400, "Fichier vide.");
      // Un document protégé (docx = ZIP, signature « PK ») s'envoie tel quel :
      // on en extrait la charge chiffrée avant déchiffrement.
      if (corps[0] === 0x50 && corps[1] === 0x4b) {
        const extraction = docx.extraireCharge(corps);
        if (!extraction.charge) {
          if (extraction.anonyme) {
            throw new ErreurCoffre(410, "Document anonymisé : les informations masquées ont été supprimées définitivement, il n'y a rien à déchiffrer.");
          }
          throw new ErreurCoffre(415, "Ce document ne contient pas d'original chiffré ADBI Coffre.");
        }
        corps = extraction.charge;
      }
      const resultat = await dechiffrer(corps, motDePasse);
      return repondreFichier(rep, nettoyerNom(resultat.nom), resultat.contenu);
    }

    // ── Documents Word ──
    if (chemin === "/api/docx/analyser" && req.method === "POST") {
      const corps = await lireCorps(req);
      if (corps.length === 0) throw new ErreurCoffre(400, "Fichier vide.");
      let analyse;
      try {
        analyse = docx.analyserDocx(corps, DETECTEURS.analyserPage);
      } catch (err) {
        throw new ErreurCoffre(415, err.message);
      }
      return repondreJson(rep, 200, { detections: analyse.detections });
    }

    if (chemin === "/api/docx/proteger" && req.method === "POST") {
      // Sans X-Cle : mode « clé locale », aucun mot de passe à retenir.
      const motDePasse = lireEnteteEncode(req, "x-cle");
      if (motDePasse && motDePasse.length < MDP_MIN) {
        throw new ErreurCoffre(400, `Mot de passe trop court : ${MDP_MIN} caractères minimum.`);
      }
      const nom = nettoyerNom(lireEnteteEncode(req, "x-nom-fichier"));
      const tout = lireEnteteEncode(req, "x-tout") === "1";
      // X-Anonymiser: 1 → masquage DÉFINITIF, aucun original embarqué.
      const anonymiser = lireEnteteEncode(req, "x-anonymiser") === "1";
      const brutZones = lireEnteteEncode(req, "x-zones");
      const zones = brutZones === "toutes"
        ? "toutes"
        : brutZones.split(",").map((n) => Number(n)).filter(Number.isFinite);
      const corps = await lireCorps(req);
      if (corps.length === 0) throw new ErreurCoffre(400, "Fichier vide.");

      const charge = anonymiser ? null : await chiffrer(corps, nom, motDePasse);
      // L'empreinte est tirée du CONTENU du document (voir issue #109 : se
      // fier au nom + à la taille faisait confondre deux fichiers différents
      // partageant un nom générique et un nombre d'octets identique — le
      // registre en déduit la référence, ou rend celle déjà attribuée à ce
      // document si les octets sont bien les mêmes.
      const attribution = attribuerReference({
        empreinte: DETECTEURS.empreinteDocument(corps),
        nom: nom,
        format: "Word",
        mode: anonymiser ? "anonymisé" : "protégé",
      });
      const reference = attribution.entree.reference;
      let resultat;
      try {
        resultat = docx.protegerDocx(corps, DETECTEURS.analyserPage, zones, tout, charge);
      } catch (err) {
        throw new ErreurCoffre(415, err.message);
      }
      // Le nom du fichier ne doit plus porter l'identité : « CV de Martin.docx »
      // annule le travail de masquage dès qu'il apparaît dans une liste, une
      // pièce jointe ou un journal de serveur.
      const nomSortie = DETECTEURS.nommerSortie(nom, ".docx", reference, anonymiser);
      completerReference(reference, { sortie: nomSortie });
      rangerDocument(reference, nomSortie, resultat);
      return repondreFichier(rep, nomSortie, resultat);
    }

    // ── Registre des références (local, chiffré par la clé du poste) ──
    if (chemin === "/api/references" && req.method === "GET") {
      // Recherche par empreinte : sert à savoir, au dépôt d'un fichier, s'il a
      // déjà une référence — sans en attribuer une à un document qu'on se
      // contente peut-être de regarder.
      const empreinte = (url.searchParams.get("empreinte") || "").trim().toUpperCase();
      if (empreinte) {
        const trouvee = lireRegistre().find((e) => e.empreinte === empreinte) || null;
        return repondreJson(rep, 200, { entree: trouvee });
      }

      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      let entrees = lireRegistre();
      if (q) {
        entrees = entrees.filter(
          (e) =>
            e.reference.toLowerCase().includes(q) ||
            (e.nom || "").toLowerCase().includes(q) ||
            (e.sortie || "").toLowerCase().includes(q)
        );
      }
      return repondreJson(rep, 200, { total: lireRegistre().length, entrees: entrees.slice(0, 300) });
    }

    if (chemin === "/api/references/attribuer" && req.method === "POST") {
      // Le PDF étant produit dans le navigateur, c'est lui qui demande la
      // référence ; le Word est traité directement par la route ci-dessus.
      const corps = await lireCorps(req);
      let donnees;
      try {
        donnees = JSON.parse(corps.toString("utf8"));
      } catch (err) {
        throw new ErreurCoffre(400, "Requête illisible.");
      }
      if (!donnees || !/^[A-Z0-9]{4}$/.test(String(donnees.empreinte || ""))) {
        throw new ErreurCoffre(400, "Empreinte absente ou mal formée.");
      }
      return repondreJson(rep, 200, attribuerReference({
        empreinte: String(donnees.empreinte),
        nom: nettoyerNom(String(donnees.nom || "")),
        sortie: nettoyerNom(String(donnees.sortie || "")),
        format: String(donnees.format || "").slice(0, 20),
        mode: String(donnees.mode || "").slice(0, 20),
      }));
    }

    // Dépôt et relecture du document conservé pour une référence.
    const routeDoc = chemin.match(/^\/api\/references\/([^/]+)\/document$/);
    if (routeDoc) {
      const reference = decodeURIComponent(routeDoc[1]);
      if (!DETECTEURS.MOTIF_REFERENCE.test(reference)) {
        throw new ErreurCoffre(400, "Référence mal formée.");
      }

      if (req.method === "POST") {
        const contenu = await lireCorps(req);
        const nomFichier = nettoyerNom(lireEnteteEncode(req, "x-nom-fichier"));
        const range = rangerDocument(reference, nomFichier, contenu);
        // Le nom du fichier produit n'est connu qu'ici : on complète l'entrée
        // sans compter un passage supplémentaire.
        if (range) completerReference(reference, { sortie: nomFichier });
        return repondreJson(rep, range ? 200 : 400, { range: range });
      }

      if (req.method === "GET") {
        const doc = sortirDocument(reference);
        if (!doc) throw new ErreurCoffre(404, "Aucun document conservé pour cette référence.");
        // Affiché dans l'onglet plutôt que téléchargé : on veut « voir le CV ».
        const type = /[.]pdf$/i.test(doc.nom)
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        rep.writeHead(200, {
          "Content-Type": type,
          "Content-Length": doc.contenu.length,
          "Content-Disposition":
            (type === "application/pdf" ? "inline" : "attachment") +
            "; filename*=UTF-8''" + encodeURIComponent(doc.nom),
        });
        return rep.end(doc.contenu);
      }
    }

    // ── Archive à clé (fichier ou dossier → ZIP chiffré AES-256) ──
    if (chemin === "/api/archiver" && req.method === "POST") {
      const motDePasse = lireEnteteEncode(req, "x-cle");
      if (motDePasse.length < MDP_MIN) {
        throw new ErreurCoffre(400, `Clé trop courte : ${MDP_MIN} caractères minimum.`);
      }
      const nom = nettoyerNom(lireEnteteEncode(req, "x-nom-fichier")) || "Archive";
      const corps = await lireCorps(req);
      if (corps.length < 5) throw new ErreurCoffre(400, "Contenu vide.");

      // Corps : [4 o longueur][manifeste JSON][contenus concaténés].
      const tailleManifeste = corps.readUInt32BE(0);
      if (4 + tailleManifeste > corps.length) throw new ErreurCoffre(400, "Manifeste illisible.");
      let manifeste;
      try {
        manifeste = JSON.parse(corps.subarray(4, 4 + tailleManifeste).toString("utf8"));
      } catch (err) {
        throw new ErreurCoffre(400, "Manifeste illisible.");
      }

      const entrees = new Map();
      let position = 4 + tailleManifeste;
      for (const f of manifeste.fichiers || []) {
        const taille = Number(f.taille);
        const nettoye = String(f.chemin || "")
          .replace(/\\/g, "/")
          .replace(/^\/+/, "")
          .replace(/[.][.]/g, "_");
        const cheminEntree = nommerSansCollision(entrees, nettoye || "fichier");
        if (!Number.isFinite(taille) || taille < 0 || position + taille > corps.length) {
          throw new ErreurCoffre(400, "Manifeste incohérent.");
        }
        entrees.set(cheminEntree, corps.subarray(position, position + taille));
        position += taille;
      }
      if (!entrees.size) throw new ErreurCoffre(400, "Aucun fichier à archiver.");

      const archive = docx.ecrireZipAes(entrees, motDePasse);
      return repondreFichier(rep, nom + " (protégé).zip", archive);
    }

    if (chemin.startsWith("/api/")) {
      return repondreJson(rep, 404, { erreur: "Route inconnue" });
    }

    // ── Fichiers statiques ──
    const relatif = chemin === "/" ? "/index.html" : chemin;
    const cible = path.join(PUBLIC, path.normalize(relatif).replace(/^[\\/]+/, ""));
    if (!cible.startsWith(PUBLIC)) {
      rep.writeHead(403);
      return rep.end("Interdit");
    }
    return servirFichier(rep, cible);
  } catch (err) {
    if (err instanceof ErreurCoffre) {
      return repondreJson(rep, err.code, { erreur: err.message });
    }
    console.error("  [coffre] erreur inattendue : " + err.message);
    return repondreJson(rep, 500, { erreur: "Erreur interne du serveur." });
  }
});

serveur.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  ADBI Coffre est déjà lancé sur ce poste (port ${PORT}).\n` +
        `  Ouvrez http://localhost:${PORT} dans votre navigateur.\n`
    );
    process.exit(1);
  }
  throw err;
});

serveur.listen(PORT, HOTE, () => {
  console.log("");
  console.log("  ADBI Coffre — prêt sur http://" + HOTE + ":" + PORT);
  console.log("  Chiffrement local : aucun fichier ni mot de passe n'est conservé.");
  console.log("");
});
