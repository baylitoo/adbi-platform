/*
 * ADBI Coffre — lecture/écriture ZIP minimale et protection des documents
 * Word (.docx), sans aucune dépendance npm : uniquement zlib natif.
 *
 * Un .docx est une archive ZIP de fichiers XML. La protection remplace, dans
 * word/document.xml (et les en-têtes/pieds de page), les caractères des zones
 * choisies par des pavés pleins, puis ajoute l'original chiffré dans l'archive
 * (adbi/original.bin, extension déclarée dans [Content_Types].xml pour que
 * Word accepte le fichier). Le document reste un .docx ordinaire.
 */

const zlib = require("zlib");
const crypto = require("crypto");

/* ── CRC-32 (nécessaire au format ZIP) ───────────────────────────────────── */

const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(donnees) {
  let c = 0xffffffff;
  for (let i = 0; i < donnees.length; i++) {
    c = TABLE_CRC[(c ^ donnees[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ── Lecture d'une archive ZIP ───────────────────────────────────────────── */

/** Renvoie une Map nom → Buffer (ordre du répertoire central). */
function lireZip(buffer) {
  // Fin de répertoire central : cherchée depuis la fin (commentaire possible).
  let eocd = -1;
  const plancher = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= plancher; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Archive ZIP illisible.");

  const nombre = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const fichiers = new Map();

  for (let e = 0; e < nombre; e++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error("Répertoire ZIP corrompu.");
    }
    const methode = buffer.readUInt16LE(pos + 10);
    const tailleComprimee = buffer.readUInt32LE(pos + 20);
    const longNom = buffer.readUInt16LE(pos + 28);
    const longExtra = buffer.readUInt16LE(pos + 30);
    const longCommentaire = buffer.readUInt16LE(pos + 32);
    const offsetLocal = buffer.readUInt32LE(pos + 42);
    const nom = buffer.toString("utf8", pos + 46, pos + 46 + longNom);
    pos += 46 + longNom + longExtra + longCommentaire;

    if (nom.endsWith("/")) continue; // dossier

    // Les tailles fiables sont celles du répertoire central : l'en-tête local
    // peut porter des zéros (descripteur de données différé).
    const nomLocal = buffer.readUInt16LE(offsetLocal + 26);
    const extraLocal = buffer.readUInt16LE(offsetLocal + 28);
    const debut = offsetLocal + 30 + nomLocal + extraLocal;
    const brut = buffer.subarray(debut, debut + tailleComprimee);
    if (methode === 8) fichiers.set(nom, zlib.inflateRawSync(brut));
    else if (methode === 0) fichiers.set(nom, Buffer.from(brut));
    else throw new Error("Compression ZIP non gérée (méthode " + methode + ").");
  }
  return fichiers;
}

/* ── Écriture d'une archive ZIP ──────────────────────────────────────────── */

function ecrireZip(fichiers) {
  const locaux = [];
  const centraux = [];
  let offset = 0;

  for (const [nom, donnees] of fichiers) {
    const nomBuf = Buffer.from(nom, "utf8");
    const somme = crc32(donnees);
    const comprime = zlib.deflateRawSync(donnees, { level: 6 });
    const stocker = comprime.length >= donnees.length;
    const corps = stocker ? donnees : comprime;
    const methode = stocker ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version requise
    local.writeUInt16LE(0x0800, 6);      // noms en UTF-8
    local.writeUInt16LE(methode, 8);
    local.writeUInt16LE(0, 10);          // heure DOS
    local.writeUInt16LE(0x0021, 12);     // date DOS (1980-01-01)
    local.writeUInt32LE(somme, 14);
    local.writeUInt32LE(corps.length, 18);
    local.writeUInt32LE(donnees.length, 22);
    local.writeUInt16LE(nomBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locaux.push(local, nomBuf, corps);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(methode, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(somme, 16);
    central.writeUInt32LE(corps.length, 20);
    central.writeUInt32LE(donnees.length, 24);
    central.writeUInt16LE(nomBuf.length, 28);
    central.writeUInt32LE(0, 30);        // extra + commentaire
    central.writeUInt32LE(0, 34);        // disque + attributs internes
    central.writeUInt32LE(0, 38);        // attributs externes
    central.writeUInt32LE(offset, 42);
    centraux.push(central, nomBuf);

    offset += 30 + nomBuf.length + corps.length;
  }

  const tailleCentral = centraux.reduce((s, b) => s + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(fichiers.size, 8);
  fin.writeUInt16LE(fichiers.size, 10);
  fin.writeUInt32LE(tailleCentral, 12);
  fin.writeUInt32LE(offset, 16);

  return Buffer.concat([...locaux, ...centraux, fin]);
}

/* ── Archive ZIP chiffrée AES-256 (format WinZip AE-2) ───────────────────────
   Lisible par 7-Zip, WinRAR, etc. : la clé est demandée à l'ouverture.
   Spécification : PBKDF2-HMAC-SHA1 (1000 itérations) → clé AES + clé HMAC +
   2 octets de vérification ; AES-256 en mode compteur PETIT-boutiste (le CTR
   natif de Node incrémente en gros-boutiste, on construit donc le flux à la
   main) ; authentification HMAC-SHA1 tronquée à 10 octets ; CRC nul (AE-2). */

function chiffrerEntreeAes(donnees, motDePasse) {
  const sel = crypto.randomBytes(16);
  const cles = crypto.pbkdf2Sync(Buffer.from(motDePasse, "utf8"), sel, 1000, 66, "sha1");
  const cleAes = cles.subarray(0, 32);
  const cleHmac = cles.subarray(32, 64);
  const verification = cles.subarray(64, 66);

  const ecb = crypto.createCipheriv("aes-256-ecb", cleAes, null);
  const chiffre = Buffer.alloc(donnees.length);
  const compteur = Buffer.alloc(16);
  let masque = null;
  for (let i = 0; i < donnees.length; i++) {
    if (i % 16 === 0) {
      for (let k = 0; k < 16; k++) {
        compteur[k] = (compteur[k] + 1) & 0xff;
        if (compteur[k] !== 0) break;
      }
      masque = ecb.update(compteur);
    }
    chiffre[i] = donnees[i] ^ masque[i % 16];
  }

  const authentification = crypto.createHmac("sha1", cleHmac).update(chiffre).digest().subarray(0, 10);
  return Buffer.concat([sel, verification, chiffre, authentification]);
}

/** Écrit une archive ZIP dont chaque entrée est chiffrée (WinZip AES-256). */
function ecrireZipAes(fichiers, motDePasse) {
  const locaux = [];
  const centraux = [];
  let offset = 0;

  for (const [nom, donnees] of fichiers) {
    const nomBuf = Buffer.from(nom, "utf8");
    const comprime = zlib.deflateRawSync(donnees, { level: 6 });
    const stocker = comprime.length >= donnees.length;
    const methodeReelle = stocker ? 0 : 8;
    const corps = chiffrerEntreeAes(stocker ? donnees : comprime, motDePasse);

    // Champ supplémentaire 0x9901 : version AE-2, éditeur « AE », AES-256,
    // et la méthode de compression réelle (le champ méthode vaut 99).
    const extra = Buffer.alloc(11);
    extra.writeUInt16LE(0x9901, 0);
    extra.writeUInt16LE(7, 2);
    extra.writeUInt16LE(2, 4);
    extra.write("AE", 6, "ascii");
    extra[8] = 3;
    extra.writeUInt16LE(methodeReelle, 9);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(51, 4);          // version requise (AES)
    local.writeUInt16LE(0x0801, 6);      // chiffré + noms UTF-8
    local.writeUInt16LE(99, 8);          // méthode 99 : AES
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(0, 14);          // CRC nul (AE-2)
    local.writeUInt32LE(corps.length, 18);
    local.writeUInt32LE(donnees.length, 22);
    local.writeUInt16LE(nomBuf.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locaux.push(local, nomBuf, extra, corps);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(51, 4);
    central.writeUInt16LE(51, 6);
    central.writeUInt16LE(0x0801, 8);
    central.writeUInt16LE(99, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(corps.length, 20);
    central.writeUInt32LE(donnees.length, 24);
    central.writeUInt16LE(nomBuf.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0, 32);        // commentaire + disque
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);        // attributs externes
    central.writeUInt32LE(offset, 42);
    centraux.push(central, nomBuf, extra);

    offset += 30 + nomBuf.length + extra.length + corps.length;
  }

  const tailleCentral = centraux.reduce((s, b) => s + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(fichiers.size, 8);
  fin.writeUInt16LE(fichiers.size, 10);
  fin.writeUInt32LE(tailleCentral, 12);
  fin.writeUInt32LE(offset, 16);

  return Buffer.concat([...locaux, ...centraux, fin]);
}

/* ── Pavé de remplacement des images masquées ────────────────────────────── */

// PNG 8×8 gris, construit à la main (signature, IHDR, IDAT, IEND) : remplace
// les octets d'une image masquée pour qu'elle ne reste pas dans l'archive.
const PNG_GRIS = (() => {
  function morceau(type, donnees) {
    const t = Buffer.from(type, "ascii");
    const longueur = Buffer.alloc(4);
    longueur.writeUInt32BE(donnees.length, 0);
    const somme = Buffer.alloc(4);
    somme.writeUInt32BE(crc32(Buffer.concat([t, donnees])), 0);
    return Buffer.concat([longueur, t, donnees, somme]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;  // 8 bits par pixel
  ihdr[9] = 0;  // niveaux de gris
  const lignes = [];
  for (let y = 0; y < 8; y++) {
    lignes.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(8, 0x9a)]));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    morceau("IHDR", ihdr),
    morceau("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    morceau("IEND", Buffer.alloc(0)),
  ]);
})();

/* ── Texte des fichiers XML Word ─────────────────────────────────────────── */

function decoderEntites(texte) {
  return texte.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (tout, code) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return String.fromCharCode(34);
    if (code === "apos") return "'";
    const hexa = code[1] === "x" || code[1] === "X";
    const n = parseInt(code.slice(hexa ? 2 : 1), hexa ? 16 : 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : tout;
  });
}

function encoderEntites(texte) {
  return texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fichiers XML porteurs de texte, dans un ordre stable (identifiants sûrs). */
function ciblesTexte(fichiers) {
  return [...fichiers.keys()]
    .filter((nom) =>
      nom === "word/document.xml" ||
      /^word\/(?:header|footer)\d*[.]xml$/.test(nom) ||
      /^word\/(?:footnotes|endnotes)[.]xml$/.test(nom)
    )
    .sort();
}

/**
 * Découpe un XML Word en paragraphes ; chaque paragraphe fournit son texte
 * concaténé et la liste de ses segments <w:t> avec offsets dans le XML.
 */
function paragraphesDuXml(xml) {
  const paragraphes = [];
  const rxParagraphe = /<w:p[ >][^]*?<\/w:p>/g;
  let p;
  while ((p = rxParagraphe.exec(xml)) !== null) {
    const rxMorceau = /<w:t([^>]*)>([^<]*)<\/w:t>|<w:t[^>]*\/>|<w:(?:tab|br|cr)\b[^>]*\/>/g;
    const segments = [];
    let texte = "";
    let m;
    while ((m = rxMorceau.exec(p[0])) !== null) {
      if (m[2] !== undefined) {
        const contenu = decoderEntites(m[2]);
        segments.push({
          debutXml: p.index + m.index,
          longueurXml: m[0].length,
          attributs: m[1],
          texte: contenu,
          debutTexte: texte.length,
        });
        texte += contenu;
      } else {
        // tabulation, retour à la ligne, w:t vide : séparateur non masquable
        texte += " ";
      }
    }
    if (texte.trim()) paragraphes.push({ texte, segments });
  }
  return paragraphes;
}

/** Cibles des relations du document : rId → chemin du média dans l'archive. */
function relationsMedias(fichiers) {
  const relations = new Map();
  const rels = fichiers.get("word/_rels/document.xml.rels");
  if (!rels) return relations;
  const xml = rels.toString("utf8");
  const rx = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const cible = m[2].replace(/^[.]\//, "");
    if (/^media\//.test(cible)) relations.set(m[1], "word/" + cible);
  }
  return relations;
}

/**
 * Analyse un .docx : renvoie les détections (identifiants stables) et le plan
 * interne nécessaire au masquage. `analyser` est COFFRE_DETECTEURS.analyserPage.
 */
function analyserDocx(buffer, analyser) {
  const fichiers = lireZip(buffer);
  if (!fichiers.has("word/document.xml")) {
    throw new Error("Ce fichier n'est pas un document Word (.docx).");
  }
  const detections = [];
  const plan = [];
  let id = 0;

  // Mémoire des noms partagée par tous les paragraphes et tous les fichiers de
  // l'archive : un nom repéré en tête du corps doit aussi être masqué dans un
  // en-tête, un pied de page ou une note, où aucun motif ne le signale.
  const identites = new Set();

  for (const cible of ciblesTexte(fichiers)) {
    const xml = fichiers.get(cible).toString("utf8");
    const paragraphes = paragraphesDuXml(xml);
    for (let ip = 0; ip < paragraphes.length; ip++) {
      const paragraphe = paragraphes[ip];
      // Les premiers paragraphes du corps portent souvent le nom (CV, lettre).
      const options = { enTete: cible === "word/document.xml" && ip < 4, identites };
      for (const d of analyser(paragraphe.texte, options)) {
        id += 1;
        const avant = paragraphe.texte.slice(Math.max(0, d.debut - 28), d.debut);
        const apres = paragraphe.texte.slice(d.fin, d.fin + 28);
        detections.push({
          id: id,
          type: d.type,
          valeur: d.valeur,
          contexte: "…" + avant + "❰" + d.valeur + "❱" + apres + "…",
        });
        // `type` accompagne la zone : c'est lui qui décide de l'étiquette
        // posée à la place du texte ([E-MAIL], [ADRESSE], la référence…).
        plan.push({ id: id, cible: cible, paragraphe: ip, debut: d.debut, fin: d.fin, type: d.type });
      }
    }
  }

  // Photos et images : chaque cadre <w:drawing> du corps, avec le média
  // qu'il référence (r:embed → word/media/…).
  const relations = relationsMedias(fichiers);
  const xmlCorps = fichiers.get("word/document.xml").toString("utf8");
  const rxDessin = /<w:drawing>[^]*?<\/w:drawing>/g;
  let dessin;
  let numero = 0;
  while ((dessin = rxDessin.exec(xmlCorps)) !== null) {
    numero += 1;
    const ref = /r:embed="(rId\d+)"/.exec(dessin[0]);
    const media = ref ? relations.get(ref[1]) : null;
    id += 1;
    detections.push({
      id: id,
      type: "photo",
      valeur: "Image " + numero + (media ? " (" + media.split("/").pop() + ")" : ""),
      contexte: "Image insérée dans le document.",
    });
    plan.push({
      id: id,
      dessin: {
        debutXml: dessin.index,
        longueurXml: dessin[0].length,
        rId: ref ? ref[1] : null,
        media: media,
      },
    });
  }

  return { detections, plan, fichiers };
}

/**
 * Produit le .docx protégé : zones choisies remplacées par des étiquettes
 * nommées, charge chiffrée ajoutée à l'archive.
 * `choix` = liste d'identifiants, ou "toutes".
 * `tout` = true : le corps du document est remplacé par une page neutre.
 * `chargeChiffree` = null : ANONYMISATION — aucun original embarqué, le
 * masquage est définitif et irréversible ; un marqueur l'indique au
 * déchiffrement pour expliquer qu'il n'y a rien à récupérer.
 * Le texte masqué est simplement RETIRÉ : rien n'est écrit à la place, comme
 * le bandeau blanc du PDF. Un document dont une information n'a pas été
 * renseignée se lit mieux qu'un document truffé de pavés.
 */
function protegerDocx(buffer, analyser, choix, tout, chargeChiffree) {
  const { plan, fichiers } = analyserDocx(buffer, analyser);
  const retenus = tout
    ? []
    : plan.filter((z) => choix === "toutes" || choix.includes(z.id));

  if (tout) {
    const xml = fichiers.get("word/document.xml").toString("utf8");
    const corps =
      "<w:p><w:pPr><w:jc w:val=" + String.fromCharCode(34) + "center" + String.fromCharCode(34) + "/></w:pPr>" +
      "<w:r><w:rPr><w:b/><w:sz w:val=" + String.fromCharCode(34) + "40" + String.fromCharCode(34) + "/></w:rPr>" +
      "<w:t>Document protégé</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Le contenu intégral de ce document est chiffré (AES-256-GCM).</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Pour le lire : ADBI Coffre, onglet « Déchiffrer », sur un poste détenant la clé.</w:t></w:r></w:p>";
    // On garde l'enveloppe (w:document, attributs, sectPr final si présent).
    const nouveau = xml.replace(/(<w:body>)[^]*(<\/w:body>)/, (t, ouvre, ferme) => {
      const section = /<w:sectPr[ >][^]*?<\/w:sectPr>/.exec(t);
      return ouvre + corps + (section ? section[0] : "") + ferme;
    });
    fichiers.set("word/document.xml", Buffer.from(nouveau, "utf8"));
    // Les en-têtes/pieds conservés par la section peuvent porter le nom, et
    // l'archive garde ses images : on vide les uns, on grise les autres.
    for (const cible of ciblesTexte(fichiers)) {
      if (cible === "word/document.xml") continue;
      const contenu = fichiers.get(cible).toString("utf8")
        .replace(/(<w:t[^>\/]*>)[^<]*(<\/w:t>)/g, "$1$2");
      fichiers.set(cible, Buffer.from(contenu, "utf8"));
    }
    for (const nom of fichiers.keys()) {
      if (/^word\/media\//.test(nom)) fichiers.set(nom, PNG_GRIS);
    }
  } else if (retenus.length) {
    // Masquage caractère par caractère dans les segments <w:t> concernés,
    // regroupé par fichier XML puis appliqué de la fin vers le début pour ne
    // pas invalider les offsets. Les cadres d'images choisis sont retirés du
    // corps dans la même passe (leurs offsets visent le même XML d'origine).
    const zonesTexte = retenus.filter((z) => !z.dessin);
    const dessins = retenus.filter((z) => z.dessin);

    const parCible = new Map();
    for (const zone of zonesTexte) {
      if (!parCible.has(zone.cible)) parCible.set(zone.cible, []);
      parCible.get(zone.cible).push(zone);
    }
    if (dessins.length && !parCible.has("word/document.xml")) {
      parCible.set("word/document.xml", []);
    }

    for (const [cible, zones] of parCible) {
      const xml = fichiers.get(cible).toString("utf8");
      const paragraphes = paragraphesDuXml(xml);
      const remplacements = []; // { debutXml, longueurXml, nouveauXml }

      const parParagraphe = new Map();
      for (const z of zones) {
        if (!parParagraphe.has(z.paragraphe)) parParagraphe.set(z.paragraphe, []);
        parParagraphe.get(z.paragraphe).push(z);
      }

      for (const [ip, liste] of parParagraphe) {
        const paragraphe = paragraphes[ip];
        if (!paragraphe) continue;
        for (const segment of paragraphe.segments) {
          const debutSeg = segment.debutTexte;
          const finSeg = debutSeg + segment.texte.length;
          const coupes = [];
          for (const z of liste) {
            const debut = Math.max(z.debut, debutSeg);
            const fin = Math.min(z.fin, finSeg);
            if (debut >= fin) continue;
            // Rien n'est écrit à la place : la zone disparaît, y compris
            // lorsqu'elle traverse plusieurs runs (Word découpe au moindre
            // changement de style).
            coupes.push({ debut: debut - debutSeg, fin: fin - debutSeg, texte: "" });
          }
          if (coupes.length) {
            // De la fin vers le début : les positions restent valables même
            // quand l'étiquette n'a pas la longueur du texte remplacé.
            coupes.sort((a, b) => b.debut - a.debut);
            let texteSegment = segment.texte;
            for (const c of coupes) {
              texteSegment = texteSegment.slice(0, c.debut) + c.texte + texteSegment.slice(c.fin);
            }
            remplacements.push({
              debutXml: segment.debutXml,
              longueurXml: segment.longueurXml,
              nouveauXml: "<w:t" + segment.attributs + ">" + encoderEntites(texteSegment) + "</w:t>",
            });
          }
        }
      }

      if (cible === "word/document.xml") {
        for (const z of dessins) {
          remplacements.push({
            debutXml: z.dessin.debutXml,
            longueurXml: z.dessin.longueurXml,
            nouveauXml: "",
          });
        }
      }

      remplacements.sort((a, b) => b.debutXml - a.debutXml);
      let sortie = xml;
      for (const r of remplacements) {
        sortie = sortie.slice(0, r.debutXml) + r.nouveauXml + sortie.slice(r.debutXml + r.longueurXml);
      }
      fichiers.set(cible, Buffer.from(sortie, "utf8"));

      // Un média dont plus aucun cadre ne se sert est grisé : la photo ne
      // doit pas rester lisible dans l'archive.
      if (cible === "word/document.xml") {
        for (const z of dessins) {
          const d = z.dessin;
          if (d.media && d.rId && !sortie.includes('"' + d.rId + '"') && fichiers.has(d.media)) {
            fichiers.set(d.media, PNG_GRIS);
          }
        }
      }
    }
  }

  // Déclare les extensions ajoutées, sinon Word considère l'archive invalide.
  const nomTypes = "[Content_Types].xml";
  let types = fichiers.get(nomTypes).toString("utf8");
  const g = String.fromCharCode(34);
  const declarer = (extension, contentType) => {
    if (!new RegExp("Extension=." + extension + ".").test(types)) {
      types = types.replace(
        "</Types>",
        "<Default Extension=" + g + extension + g +
          " ContentType=" + g + contentType + g + "/></Types>"
      );
    }
  };

  if (chargeChiffree) {
    declarer("bin", "application/octet-stream");
    fichiers.set("adbi/original.bin", chargeChiffree);
  } else {
    // Anonymisation : pas d'original, seulement un marqueur explicatif.
    declarer("txt", "text/plain");
    fichiers.set(
      "adbi/anonymise.txt",
      Buffer.from("Document anonymisé par ADBI Coffre : les informations masquées ont été supprimées définitivement, aucun original n'est embarqué.", "utf8")
    );
  }
  fichiers.set(nomTypes, Buffer.from(types, "utf8"));

  return ecrireZip(fichiers);
}

/** Charge chiffrée d'un document protégé : { charge, anonyme }. */
function extraireCharge(buffer) {
  let fichiers;
  try {
    fichiers = lireZip(buffer);
  } catch (err) {
    return { charge: null, anonyme: false };
  }
  return {
    charge: fichiers.get("adbi/original.bin") || null,
    anonyme: fichiers.has("adbi/anonymise.txt"),
  };
}

module.exports = { lireZip, ecrireZip, ecrireZipAes, analyserDocx, protegerDocx, extraireCharge };
