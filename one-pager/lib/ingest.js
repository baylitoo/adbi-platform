/**
 * Ingestion : transforme un fichier source (PDF, DOCX, TXT) en une liste de
 * lignes de texte POSITIONNEES.
 *
 * On conserve les coordonnees et la taille de police parce que la suite du
 * pipeline (lib/layout.js) en a besoin pour retrouver les colonnes et les
 * titres de section. Un simple « texte brut » suffirait pour un CV lineaire,
 * mais melangerait la barre laterale et le corps sur les CV en 2 colonnes.
 */

const path = require("path");

/** Une ligne reconstruite : { text, x, y, w, size, bold, page } */

// ---------------------------------------------------------------- PDF -----

async function readPdf(buffer) {
  // pdfjs-dist v4 est en ESM : import dynamique depuis notre module CommonJS.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    // Resout les polices : sans cet appel, commonObjs ne connait pas encore les
    // fontes et l'information « gras » (un signal fort de titre) est perdue.
    await page.getOperatorList().catch(() => {});
    const content = await page.getTextContent();

    // 1) Chaque « item » pdfjs est un fragment de texte, pas une ligne.
    //    Les items purement blancs sont conserves : ils portent les espaces
    //    inter-mots que certains PDF emettent separement.
    const frags = [];
    for (const it of content.items) {
      if (!it.str) continue;
      const t = it.transform; // [a, b, c, d, e, f] : e/f = position
      const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
      frags.push({
        text: it.str,
        x: t[4],
        y: viewport.height - t[5], // origine PDF en bas -> on repasse en haut
        w: it.width || 0,
        size: Math.round(size * 10) / 10,
        font: it.fontName || "",
      });
    }

    // 2) Colonnes AVANT lignes : sur un CV en 2 colonnes, la barre laterale et
    //    le corps partagent les memes ordonnees. Grouper par y d'abord
    //    entrelacerait « Langues / Arabe » au milieu d'une mission.
    const fontBold = buildBoldIndex(page, content);
    const bands = detectColumns(frags.filter((f) => f.text.trim()), viewport.width);
    // Les espaces isoles rejoignent la bande dont ils sont le plus proche.
    for (const f of frags) {
      if (f.text.trim()) continue;
      const band = bands.find((b) => f.x >= b.x0 - 2 && f.x <= b.x1 + 2) || bands[0];
      band.frags.push(f);
    }
    const columns = bands.map((band) => ({
      x0: Math.round(band.x0),
      x1: Math.round(band.x1),
      width: Math.round(band.x1 - band.x0),
      isSidebar: false,
      lines: groupLines(band.frags, fontBold),
    }));
    markSidebar(columns, viewport.width);

    pages.push({
      number: p,
      width: viewport.width,
      height: viewport.height,
      columns,
      // Ordre de lecture : colonne par colonne, puis de haut en bas.
      lines: columns.flatMap((c, i) => c.lines.map((l) => ({ ...l, col: i, sidebar: c.isSidebar }))),
    });
  }

  return { pages, method: "text_layer" };
}

/**
 * Cherche une gouttiere verticale : une bande d'abscisses que AUCUN fragment ne
 * traverse. Renvoie 1 bande (page lineaire) ou 2 bandes (page en colonnes).
 */
function detectColumns(frags, pageWidth) {
  const all = { x0: 0, x1: pageWidth, frags };
  if (frags.length < 25) return [all];

  const BIN = 4;
  const nbins = Math.ceil(pageWidth / BIN);
  const covered = new Array(nbins).fill(0);
  for (const f of frags) {
    const a = Math.max(0, Math.floor(f.x / BIN));
    const b = Math.min(nbins - 1, Math.floor((f.x + Math.max(f.w, 1)) / BIN));
    for (let i = a; i <= b; i++) covered[i]++;
  }

  // Une gouttiere plausible est vide, large d'au moins 2% de la page, et situee
  // dans le tiers median (au-dela, c'est une simple marge).
  const minGutter = Math.max(2, Math.round((pageWidth * 0.02) / BIN));
  const lo = Math.floor((pageWidth * 0.18) / BIN);
  const hi = Math.ceil((pageWidth * 0.68) / BIN);

  let best = null;
  let i = lo;
  while (i < hi) {
    if (covered[i] > 0) { i++; continue; }
    let j = i;
    while (j < hi && covered[j] === 0) j++;
    const len = j - i;
    if (len >= minGutter) {
      const split = ((i + j) / 2) * BIN;
      const left = frags.filter((f) => f.x + f.w / 2 < split);
      const right = frags.length - left.length;
      // Les deux cotes doivent etre reellement peuples, sinon c'est un faux positif.
      if (left.length >= frags.length * 0.15 && right >= frags.length * 0.15) {
        const score = len * Math.min(left.length, right);
        if (!best || score > best.score) best = { split, score };
      }
    }
    i = j + 1;
  }
  if (!best) return [all];

  const left = frags.filter((f) => f.x + f.w / 2 < best.split);
  const right = frags.filter((f) => f.x + f.w / 2 >= best.split);
  return [
    { x0: Math.min(...left.map((f) => f.x)), x1: best.split, frags: left },
    { x0: best.split, x1: Math.max(...right.map((f) => f.x + f.w)), frags: right },
  ];
}

/** La colonne etroite (< 40% de la page) porte contact / langues / outils. */
function markSidebar(columns, pageWidth) {
  if (columns.length < 2) return;
  const narrow = columns.reduce((a, b) => (a.width <= b.width ? a : b));
  if (narrow.width < pageWidth * 0.4) narrow.isSidebar = true;
}

/** Regroupe les fragments d'une colonne en lignes (meme y a la demi-police pres). */
function groupLines(frags, fontBold) {
  const sorted = [...frags].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const f of sorted) {
    const tol = Math.max(2, f.size * 0.5);
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - f.y) <= tol) {
      last.frags.push(f);
      last.y = (last.y * (last.frags.length - 1) + f.y) / last.frags.length;
    } else {
      rows.push({ y: f.y, frags: [f] });
    }
  }
  return rows.map((r) => assembleLine(r, fontBold)).filter((l) => l.text);
}

/**
 * Table « identifiant de police pdfjs -> est en gras ».
 * Le vrai nom de fonte (ex. « AAAAAC+Calibri-Bold ») n'est disponible que via
 * commonObjs, une fois les polices resolues.
 */
function buildBoldIndex(page, content) {
  const map = new Map();
  const ids = new Set(content.items.map((i) => i.fontName).filter(Boolean));
  for (const id of ids) {
    let name = id;
    try {
      const f = page.commonObjs.get(id);
      if (f && f.name) name = f.name;
    } catch {
      /* police non resolue : on retombe sur l'identifiant, sans gras */
    }
    map.set(id, /bold|black|heavy|semibold|demi/i.test(name));
  }
  return map;
}

/**
 * Seuil d'ecart au-dela duquel deux fragments appartiennent a des mots
 * differents — uniquement sur les lignes ecrites lettre par lettre.
 *
 * On ne le fixe pas a l'avance : selon la police et le crenage, la frontiere
 * de mot vaut 0,6 fois le corps sur un CV et 0,10 sur un autre. On cherche donc
 * la plus grande rupture dans la distribution des ecarts de la ligne.
 * @returns {number|null} l'ecart en points, ou null si la ligne est normale.
 */
function seuilSeparationMots(frags) {
  const reels = frags.filter((f) => f.text.trim());
  if (reels.length < 6) return null;
  const isoles = reels.filter((f) => f.text.trim().length === 1).length;
  if (isoles / reels.length < 0.6) return null; // ligne ecrite normalement

  const ecarts = [];
  for (let i = 1; i < frags.length; i++) {
    const g = frags[i].x - (frags[i - 1].x + frags[i - 1].w);
    if (g > 0.01) ecarts.push(g);
  }
  if (ecarts.length < 4) return null;

  ecarts.sort((a, b) => a - b);
  // La plus grande rupture separe les ecarts « entre lettres » des ecarts
  // « entre mots ». Sans rupture nette, la ligne est un mot unique.
  let meilleur = 0;
  let seuil = null;
  for (let i = 1; i < ecarts.length; i++) {
    const saut = ecarts[i] - ecarts[i - 1];
    if (saut > meilleur) { meilleur = saut; seuil = (ecarts[i] + ecarts[i - 1]) / 2; }
  }
  const median = ecarts[Math.floor(ecarts.length / 2)];
  return meilleur > Math.max(0.6, median * 0.8) ? seuil : null;
}

/** Recolle les fragments d'une ligne en inserant les espaces manquants. */
function assembleLine(line, fontBold) {
  const frags = line.frags.sort((a, b) => a.x - b.x);
  // Sur une ligne interlettree, la frontiere de mot se situe a 0,6 fois le
  // corps ; ailleurs a 0,15. Aucun seuil fixe ne convient aux deux : on le
  // deduit des ecarts effectivement observes sur CETTE ligne.
  const seuilMot = seuilSeparationMots(frags);
  let text = "";
  let prevEnd = null;
  for (const f of frags) {
    if (prevEnd !== null) {
      const gap = f.x - prevEnd;
      // La coupure franche prime sur un blanc deja pose : certains PDF emettent
      // un fragment « espace » avant chaque mot, qui masquerait la frontiere.
      // Deux mecanismes : le seuil deduit de la ligne (lettres emises comme
      // fragments distincts) et un seuil large de secours (lettres espacees a
      // l'interieur d'un meme fragment, ou seuls les blancs de mot ressortent).
      if ((seuilMot !== null && gap >= seuilMot) || gap > f.size * 0.55) {
        text = text.replace(/[\s ]+$/, "") + SEP_MOT;
      } else if (gap > f.size * 0.22 && !/\s$/.test(text) && !/^\s/.test(f.text)) {
        text += " ";
      }
    }
    // Un fragment fait UNIQUEMENT d'espaces est une frontiere de mot certaine,
    // posee par le document lui-meme. Sur les PDF qui ecrivent lettre par
    // lettre (« e x p e r t i s e »), c'est le SEUL indice fiable : une fois
    // assemble, l'espace inter-lettres et l'espace inter-mots se confondent,
    // et « une expertise en » devenait « uneexpertiseen ».
    text += f.text.trim() ? f.text : SEP_MOT;
    prevEnd = f.x + f.w;
  }
  text = separerParCasse(corrigerInterlettrage(text).split(SEP_MOT).join(" "));
  const first = frags[0];
  const sizes = frags.map((f) => f.size);
  return {
    text: cleanText(text),
    x: Math.round(first.x),
    y: Math.round(line.y),
    w: Math.round(prevEnd - first.x),
    size: Math.max(...sizes),
    bold: frags.some((f) => /bold|black|heavy|semibold/i.test(f.font) || (fontBold && fontBold.get(f.font))),
  };
}

// --------------------------------------------------------------- DOCX -----

async function readDocx(buffer) {
  const mammoth = require("mammoth");
  const { value: html } = await mammoth.convertToHtml({ buffer });

  // On rejoue le HTML en lignes : les balises portent le meme signal que la
  // taille de police en PDF (h1/h2 = titre de section, strong = intitule).
  const lines = [];
  const re = /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    const text = cleanText(stripTags(inner));
    if (!text) continue;
    const heading = /^h[1-6]$/.test(tag);
    lines.push({
      text: tag === "li" ? "• " + text : text,
      x: tag === "li" ? 40 : 0,
      y: lines.length * 14,
      w: text.length * 5,
      size: heading ? 16 - Number(tag[1]) : 10,
      bold: heading || /<(strong|b)>/i.test(inner),
    });
  }
  return { pages: [singleColumnPage(lines, Math.max(800, lines.length * 14))], method: "docx_xml" };
}

/** DOCX et TXT n'ont pas de geometrie : une seule colonne, pas de barre laterale. */
function singleColumnPage(lines, height) {
  const tagged = lines.map((l) => ({ ...l, col: 0, sidebar: false }));
  return {
    number: 1,
    width: 600,
    height,
    columns: [{ x0: 0, x1: 600, width: 600, isSidebar: false, lines: tagged }],
    lines: tagged,
  };
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// ---------------------------------------------------------------- TXT -----

function readTxt(buffer) {
  const lines = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((t) => cleanText(t))
    .filter(Boolean)
    .map((text, i) => ({
      text,
      x: /^\s/.test(text) ? 40 : 0,
      y: i * 14,
      w: text.length * 5,
      size: 10,
      // Faute de mise en forme, une ligne courte en majuscules fait office de titre.
      bold: text === text.toUpperCase() && text.length < 40,
    }));
  return { pages: [singleColumnPage(lines, lines.length * 14)], method: "plain_text" };
}

// --------------------------------------------------------------- Utils ----

// Marqueur interne de coupure entre deux mots, retire avant restitution.
const SEP_MOT = " ";

/**
 * Recolle un libelle ecrit avec un interlettrage large — « E l M e h d i
 * B O U Z I A N E ». Frequent sur les noms en tete des CV mis en page dans un
 * outil graphique ; sans correction, le nom devient introuvable.
 */
function corrigerInterlettrage(text) {
  const jetons = text.split(/[ \s]+/).filter(Boolean);
  const isoles = jetons.filter((j) => j.length === 1).length;
  // Cas courant : une majorite de lettres isolees. Cas court mais sans ambiguite
  // (« A D D A ») : toutes les lettres le sont.
  const interlettre = (jetons.length >= 6 && isoles / jetons.length >= 0.6)
    || (jetons.length >= 3 && isoles === jetons.length);
  if (!interlettre) return text;

  // Dans un libelle interlettre, les lettres sont separees par un espace simple
  // et les MOTS par un espace plus large — deux espaces, ou le marqueur pose
  // par assembleLine. C'est la seule frontiere de mot disponible : sans elle,
  // « T r a n s f o r m a t i o n   d i g i t a l e » deviendrait un seul bloc.
  return text
    .split(/ |\s{2,}/)
    .map((mot) => mot.replace(/\s+/g, ""))
    .filter(Boolean)
    .join(SEP_MOT);
}

/**
 * Dernier recours quand la mise en page n'a laisse aucune frontiere de mot :
 * « ElMehdiBOUZIANE » -> « El Mehdi BOUZIANE ». On ne coupe qu'un agglomerat
 * long presentant de vraies alternances de casse, jamais un mot ordinaire.
 */
function separerParCasse(text) {
  return text.replace(/[A-Za-zÀ-ÿ]{12,}/g, (mot) => {
    const coupures = (mot.match(/[a-zà-ÿ][A-ZÀ-Ý]/g) || []).length;
    if (coupures < 2) return mot;
    return mot.replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, "$1 $2");
  });
}

/**
 * Ligatures mal cartographiees par les PDF issus de Word.
 *
 * Le glyphe de la ligature « ti » de Calibri est souvent declare comme U+019F
 * (Ɵ) : « applicaƟon » au lieu de « application ». Le texte reste lisible a
 * l'ecran du redacteur mais devient faux des qu'on l'extrait — et se retrouve
 * tel quel dans le dossier de competences.
 */
const LIGATURES = [
  [/Ɵ/g, "ti"],   // Ɵ  applicaƟon -> application
  [/ﬀ/g, "ff"], [/ﬁ/g, "fi"], [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"], [/ﬄ/g, "ffl"],
  [/ﬅ/g, "st"], [/ﬆ/g, "st"],
];

// Accents composes separement, typiques des PDF produits par LaTeX :
// « contrˆoles r´eglementaires ». On recompose la lettre accentuee.
const ACCENTS_DETACHES = [
  // Volontairement limite aux lettres modificatives : l'accent circonflexe
  // ASCII et l'apostrophe inverse apparaissent dans des extraits de code.
  [/[ˆ](?=[aeiouAEIOU])/g, "̂"],
  [/[´ˊ](?=[aeiouyAEIOUY])/g, "́"],
  [/[ˋ](?=[aeiouAEIOU])/g, "̀"],
  [/[¨˙](?=[aeiouAEIOU])/g, "̈"],
  [/[˜](?=[anoANO])/g, "̃"],
  [/[¸](?=[cC])/g, "̧"],
];

/**
 * Remet le texte extrait dans un alphabet exploitable : ligatures deployees,
 * accents recomposes, glyphes de polices d'icones retires. Sans ce passage,
 * ces caracteres traversent toute la chaine et s'impriment sur le dossier.
 */
function normaliserCaracteres(s) {
  let t = String(s);
  for (const [re, rep] of LIGATURES) t = t.replace(re, rep);

  // L'accent precede la lettre dans le flux : on le deplace derriere avant de
  // recomposer, ce que fait la forme normale NFC.
  for (const [re, comb] of ACCENTS_DETACHES) t = t.replace(re, " " + comb);
  t = t.replace(/ ([̀-ͯ])(.)/g, "$2$1").normalize("NFC");

  return t
    // La puce Wingdings vit en zone privee : on la rend au jeu standard, sans
    // quoi le decoupage des realisations ne la reconnait pas comme une puce.
    .replace(/[◦⮚›]/g, "•")
    // Les autres glyphes de zone privee sont des icones (telephone, enveloppe,
    // maison) : purement decoratifs, ils n'apportent aucun texte.
    .replace(/[-]/g, " ")
    .replace(/[‑−]/g, "-");
}

function cleanText(s) {
  return normaliserCaracteres(s)
    .replace(/ /g, "")
    .replace(/[­​-‍﻿]/g, "") // cesures et espaces invisibles
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Point d'entree unique.
 * @param {Buffer} buffer  contenu du fichier
 * @param {string} filename  nom d'origine (sert a deviner le format)
 */
async function ingest(buffer, filename) {
  const ext = path.extname(filename || "").toLowerCase();
  let res;
  if (ext === ".pdf" || isPdf(buffer)) res = await readPdf(buffer);
  else if (ext === ".docx" || ext === ".doc") res = await readDocx(buffer);
  else res = readTxt(buffer);

  retirerEntetesRepetes(res.pages);

  const charCount = res.pages.reduce((n, p) => n + p.lines.reduce((k, l) => k + l.text.length, 0), 0);
  return {
    ...res,
    filename: filename || "cv",
    pageCount: res.pages.length,
    charCount,
    // Un PDF scanne a une couche texte quasi vide : on le signale, l'OCR n'est pas embarque.
    scanned: res.method === "text_layer" && charCount < 120 * res.pages.length,
  };
}

/**
 * Supprime les en-tetes et pieds de page repetes.
 *
 * Sur un CV de plusieurs pages, une bande du type « ALO — Data Engineer » se
 * repete en bas de chaque page. Laissee en place, elle est prise pour un
 * intitule de poste et vient polluer le decoupage des missions.
 * Critere : meme texte, meme hauteur relative, sur la majorite des pages.
 */
function retirerEntetesRepetes(pages) {
  if (pages.length < 3) return;

  const vus = new Map();
  for (const p of pages) {
    for (const l of p.lines) {
      const cle = l.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
      if (cle.length < 6) continue;
      const rel = l.y / (p.height || 1);
      if (rel > 0.12 && rel < 0.88) continue; // seules les marges sont concernees
      if (!vus.has(cle)) vus.set(cle, []);
      vus.get(cle).push({ page: p.number, rel });
    }
  }

  const seuil = Math.max(3, Math.ceil(pages.length * 0.6));
  const aRetirer = new Set();
  for (const [cle, occ] of vus) {
    const pagesDistinctes = new Set(occ.map((o) => o.page)).size;
    if (pagesDistinctes < seuil) continue;
    const rels = occ.map((o) => o.rel);
    // Une bande figee occupe toujours la meme hauteur d'une page a l'autre.
    if (Math.max(...rels) - Math.min(...rels) > 0.05) continue;
    aRetirer.add(cle);
  }
  if (!aRetirer.size) return;

  for (const p of pages) {
    const garde = (l) => !aRetirer.has(l.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim());
    p.lines = p.lines.filter(garde);
    for (const c of p.columns || []) c.lines = c.lines.filter(garde);
  }
}

function isPdf(buffer) {
  return buffer && buffer.length > 4 && buffer.slice(0, 5).toString("latin1") === "%PDF-";
}

// isPdf est exportee en plus de `ingest` : lib/import-pipeline.js (issue #152)
// en a besoin pour decider si un fichier peut passer par le bridge DocIE
// (PDF uniquement, voir document-parsing/bridge/README.md) avant de lire
// l'integralite du document.
module.exports = { ingest, cleanText, isPdf };
