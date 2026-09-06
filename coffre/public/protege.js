/* ADBI Coffre — atelier « Protéger un document » (PDF et Word).
 *
 * PDF : lu et analysé EN LOCAL (pdfjs) — texte + positions ; les détecteurs
 * (detecteurs.js) repèrent les informations sensibles, l'utilisateur ajuste
 * dans l'aperçu (zones cliquables, surlignage manuel). Le PDF protégé garde
 * le MÊME format : pages ré-imagées sans le texte masqué, et original complet
 * chiffré embarqué en pièce jointe. Word : l'analyse et le remplacement se
 * font côté serveur local (docx.js), l'atelier liste les détections.
 *
 * Aucun mot de passe : le serveur chiffre avec la clé locale du poste.
 * pdfjs et pdf-lib sont servis en local (public/lib) : aucun CDN, hors ligne.
 */

import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const NOM_CHARGE = "original-chiffre.adbi";
const PAGES_MAX = 60;

const etat = {
  fichier: null,      // File d'origine (PDF)
  octets: null,       // ArrayBuffer de l'original (sert au chiffrement)
  doc: null,          // document pdfjs
  pages: [],          // { num, largeur, hauteur, texte, echelle }
  detections: [],     // { id, type, valeur, page, rects[{x,y,w,h}] échelle 1, choisi }
  compteur: 0,
};

const etatDocx = {
  fichier: null,      // File d'origine (Word)
  detections: [],     // { id, type, valeur, contexte, choisi }
};

/* Mode de sortie par format : « protege » (réversible, original chiffré
   embarqué) ou « anonyme » (définitif, rien d'embarqué). */
const modes = { pdf: "protege", docx: "protege" };

const AIDE_MODE = {
  protege:
    "L'original complet, chiffré par la clé locale, voyage dans le fichier : " +
    "déchiffrable ici même, sur ce poste. Sauvegardez data\\cle-locale.bin.",
  anonyme:
    "Aucun original embarqué : les informations masquées sont supprimées " +
    "définitivement — personne ne pourra les retrouver, ni vous ni ADBI. " +
    "Gardez votre fichier source en lieu sûr.",
};

/* ══ PDF — extraction du texte avec positions ═════════════════════════════ */

/* Mesureur hors écran : sert à répartir la largeur d'un fragment sur ses
   caractères. La police exacte du PDF est inconnue, mais les proportions
   relatives d'une police proportionnelle se ressemblent assez (un « i » est
   étroit, un « m » large) pour placer les bornes bien mieux qu'une division
   à parts égales. */
const MESUREUR = document.createElement("canvas").getContext("2d");
MESUREUR.font = "100px Helvetica, Arial, sans-serif";

/**
 * Bornes horizontales de chaque caractère d'un fragment, en proportion de sa
 * largeur réelle.
 *
 * La division à parts égales suppose une chasse fixe. Sur une police
 * proportionnelle, l'écart accumulé dépasse un caractère en fin de fragment :
 * le masque se décale, et le premier caractère de l'information censée être
 * couverte reste visible. C'est ce qui laissait apparaître le « 9 » d'un code
 * postal masqué.
 */
function bornesCaracteres(chaine, largeurTotale) {
  const bornes = [0];
  for (let i = 1; i <= chaine.length; i++) {
    bornes.push(MESUREUR.measureText(chaine.slice(0, i)).width);
  }
  const total = bornes[chaine.length] || 1;
  return bornes.map((b) => (b / total) * largeurTotale);
}

function extrairePage(contenuTexte, viewport) {
  let texte = "";
  const positions = []; // une entrée par caractère, null pour les séparateurs

  let precedent = null;
  for (const objet of contenuTexte.items) {
    if (!objet.str) {
      if (objet.hasEOL) { texte += "\n"; positions.push(null); }
      continue;
    }
    const t = pdfjsLib.Util.transform(viewport.transform, objet.transform);
    const hauteur = Math.hypot(t[2], t[3]) || 10;
    const x = t[4];
    const y = t[5]; // ligne de base, repère haut-gauche
    const largeur = objet.width * viewport.scale;

    if (precedent) {
      const memeLigne = Math.abs(precedent.y - y) < hauteur * 0.7;
      const ecart = x - precedent.finX;
      if (!memeLigne) {
        texte += "\n";
        positions.push(null);
      } else if (ecart > hauteur * 0.14 && texte && !texte.endsWith(" ")) {
        texte += " ";
        positions.push(null);
      }
    }

    const bornes = bornesCaracteres(objet.str, largeur);
    for (let i = 0; i < objet.str.length; i++) {
      texte += objet.str[i];
      positions.push({
        x: x + bornes[i],
        l: bornes[i + 1] - bornes[i],
        haut: y - hauteur,
        h: hauteur * 1.22,
      });
    }
    precedent = { y: y, finX: x + largeur };
    if (objet.hasEOL) { texte += "\n"; positions.push(null); }
  }
  return { texte, positions };
}

/** Regroupe les caractères d'une plage en rectangles (un par ligne). */
function rectsPourPlage(positions, debut, fin) {
  const rects = [];
  let courant = null;
  for (let k = debut; k < fin; k++) {
    const p = positions[k];
    if (!p) continue;
    if (courant && Math.abs(p.haut - courant.y) < courant.h * 0.6) {
      courant.w = Math.max(courant.w, p.x + p.l - courant.x);
      courant.h = Math.max(courant.h, p.h);
    } else {
      if (courant) rects.push(courant);
      courant = { x: p.x, y: p.haut, w: p.l, h: p.h };
    }
  }
  if (courant) rects.push(courant);
  /* Marge de sécurité : les bornes restent une estimation (la police du PDF
     n'est pas celle du mesureur). Un demi-caractère de chaque côté absorbe
     l'écart résiduel — mieux vaut mordre sur le caractère voisin que laisser
     apparaître le premier chiffre d'un code postal. */
  return rects.map((r) => {
    const marge = Math.max(2, r.h * 0.22);
    return { x: r.x - marge, y: r.y - 1, w: r.w + marge * 2, h: r.h + 2 };
  });
}

/* ══ PDF — zones d'images (photo d'identité d'un CV, tampons, scans…) ═════ */

/**
 * Positions des images peintes sur la page, en suivant la matrice de
 * transformation courante : une image occupe le carré unité transformé.
 */
async function zonesImages(page, viewport) {
  const OPS = pdfjsLib.OPS;
  const ops = await page.getOperatorList();
  const zones = [];
  const pile = [];
  let matrice = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) {
      pile.push(matrice.slice());
    } else if (fn === OPS.restore) {
      matrice = pile.pop() || matrice;
    } else if (fn === OPS.transform) {
      matrice = pdfjsLib.Util.transform(matrice, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      pile.push(matrice.slice());
      if (args && args[0]) matrice = pdfjsLib.Util.transform(matrice, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      matrice = pile.pop() || matrice;
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintJpegXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      const m = pdfjsLib.Util.transform(viewport.transform, matrice);
      const coins = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
        m[0] * x + m[2] * y + m[4],
        m[1] * x + m[3] * y + m[5],
      ]);
      const xs = coins.map((c) => c[0]);
      const ys = coins.map((c) => c[1]);
      const rect = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
      // Filets, puces et pictogrammes minuscules : ignorés.
      if (rect.w >= 24 && rect.h >= 24) zones.push(rect);
    }
  }
  return zones;
}

/* ══ PDF — analyse ════════════════════════════════════════════════════════ */

async function analyserFichierPdf(fichier) {
  etat.fichier = fichier;
  etat.octets = await fichier.arrayBuffer();
  etat.pages = [];
  etat.detections = [];
  etat.compteur = 0;
  // Référence du document : elle nomme le fichier produit ET remplace le nom
  // de la personne à l'intérieur. Déterministe, donc un même CV redéposé garde
  // sa référence au lieu d'en recevoir une nouvelle à chaque essai.
  // L'empreinte est stable ; la référence, elle, n'est attribuée qu'à la
  // génération — analyser un document sans le protéger ne doit pas remplir le
  // registre.
  // Calculée sur le CONTENU réel du fichier (voir issue #109) : se fier au nom
  // + à la taille faisait confondre deux CV différents partageant un nom
  // générique ("CV.pdf") et un nombre d'octets identique (gabarit commun) —
  // le second déposé écrasait alors silencieusement le document conservé du
  // premier sous la même référence.
  etat.empreinte = COFFRE_DETECTEURS.empreinteDocument(new Uint8Array(etat.octets));
  etat.reference = "";
  annoncerReference();

  afficherEtape("analyse");
  $("analyse-texte").textContent = "Ouverture du document…";

  // pdfjs transfère le tampon au worker : on lui donne une COPIE,
  // l'original reste disponible pour le chiffrement.
  const copie = etat.octets.slice(0);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: copie }).promise;
  } catch (err) {
    const protege = err && err.name === "PasswordException";
    afficherErreurDepot(protege
      ? "Ce PDF est déjà verrouillé par un mot de passe : impossible de l'analyser."
      : "Impossible de lire ce fichier comme un PDF.");
    afficherEtape("depot");
    return;
  }
  etat.doc = doc;

  if (doc.numPages > PAGES_MAX) {
    afficherErreurDepot("Document trop long (" + doc.numPages + " pages, limite : " + PAGES_MAX + ").");
    afficherEtape("depot");
    return;
  }

  // Mémoire des noms partagée par toutes les pages : le nom repéré dans
  // l'en-tête de la première page doit aussi être masqué en page 5, où plus
  // aucun motif ne le signale (pied de page, référence, filigrane).
  const identites = new Set();

  for (let n = 1; n <= doc.numPages; n++) {
    $("analyse-texte").textContent = "Analyse de la page " + n + " / " + doc.numPages + "…";
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const contenu = await page.getTextContent();
    const { texte, positions } = extrairePage(contenu, viewport);

    // Un CV, une lettre : la première page commence par le nom — l'analyse
    // reçoit l'indication pour appliquer l'heuristique de ligne d'en-tête.
    for (const d of COFFRE_DETECTEURS.analyserPage(texte, { enTete: n === 1, identites })) {
      const rects = rectsPourPlage(positions, d.debut, d.fin);
      if (!rects.length) continue;
      etat.detections.push({
        id: ++etat.compteur,
        type: d.type,
        valeur: d.valeur,
        page: n,
        rects: rects,
        choisi: true,
      });
    }

    // Photos et images (photo d'identité, tampon, signature scannée…).
    for (const rect of await zonesImages(page, viewport)) {
      const pleinePage = rect.w * rect.h > 0.85 * viewport.width * viewport.height;
      etat.detections.push({
        id: ++etat.compteur,
        type: "photo",
        valeur: "Image " + Math.round(rect.w) + " × " + Math.round(rect.h) +
          (pleinePage ? " (pleine page)" : ""),
        page: n,
        rects: [rect],
        // Une image pleine page est souvent le fond d'un document scanné :
        // la masquer viderait la page, on laisse l'utilisateur décider.
        choisi: !pleinePage,
      });
    }

    etat.pages.push({
      num: n,
      largeur: viewport.width,
      hauteur: viewport.height,
      texte: texte,
      echelle: 1,
    });
  }

  await construireAtelier();
  afficherEtape("atelier");
}

/* ══ PDF — atelier (aperçu + panneau) ═════════════════════════════════════ */

async function construireAtelier() {
  const apercu = $("apercu-pages");
  apercu.innerHTML = "";
  // clientWidth peut valoir 0 (onglet en arrière-plan, conteneur pas encore
  // affiché) : on retombe alors sur une largeur sûre, jamais négative.
  const dispo = apercu.clientWidth;
  const largeurCible = Math.min(760, dispo > 60 ? dispo - 4 : 640);

  for (const infos of etat.pages) {
    const page = await etat.doc.getPage(infos.num);
    const echelle = Math.min(1.6, largeurCible / infos.largeur);
    infos.echelle = echelle;
    const viewport = page.getViewport({ scale: echelle });

    const conteneur = document.createElement("div");
    conteneur.className = "page-pdf";
    conteneur.dataset.page = String(infos.num);
    conteneur.style.width = viewport.width + "px";
    conteneur.style.height = viewport.height + "px";
    conteneur.style.setProperty("--scale-factor", String(echelle));

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * devicePixelRatio);
    canvas.height = Math.floor(viewport.height * devicePixelRatio);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(devicePixelRatio, devicePixelRatio);
    // intent "print" : rendu sans requestAnimationFrame, qui ne se déclenche
    // pas dans un onglet en arrière-plan — la préparation aboutit toujours.
    await page.render({ canvasContext: ctx, viewport: viewport, intent: "print" }).promise;
    conteneur.appendChild(canvas);

    // Couche texte transparente : permet de surligner pour un masquage manuel.
    const coucheTexte = document.createElement("div");
    coucheTexte.className = "textLayer";
    conteneur.appendChild(coucheTexte);
    try {
      const couche = new pdfjsLib.TextLayer({
        textContentSource: await page.getTextContent(),
        container: coucheTexte,
        viewport: viewport,
      });
      await couche.render();
    } catch (err) {
      /* sans couche texte, la sélection manuelle est indisponible — sans plus */
    }

    const etiquette = document.createElement("div");
    etiquette.className = "page-numero";
    etiquette.textContent = "Page " + infos.num;
    conteneur.appendChild(etiquette);

    apercu.appendChild(conteneur);
  }

  majZones();
  majPanneau();
  majTexteBoutons();

  const aucunTexte = etat.pages.every((p) => p.texte.trim().length === 0);
  $("alerte-scan").hidden = !aucunTexte;
}

/** (Re)pose les zones cliquables sur les pages. */
function majZones() {
  document.querySelectorAll(".zone-detectee").forEach((z) => z.remove());
  for (const d of etat.detections) {
    const conteneur = document.querySelector('.page-pdf[data-page="' + d.page + '"]');
    if (!conteneur) continue;
    const infos = etat.pages[d.page - 1];
    for (const r of d.rects) {
      const zone = document.createElement("button");
      zone.type = "button";
      zone.className = "zone-detectee" + (d.choisi ? "" : " off");
      zone.style.left = r.x * infos.echelle + "px";
      zone.style.top = r.y * infos.echelle + "px";
      zone.style.width = r.w * infos.echelle + "px";
      zone.style.height = r.h * infos.echelle + "px";
      zone.title = COFFRE_DETECTEURS.TYPES[d.type] + " : " + d.valeur +
        (d.choisi ? " — sera masqué (cliquer pour garder en clair)" : " — restera en clair (cliquer pour masquer)");
      zone.addEventListener("click", () => basculerDetection(d.id));
      conteneur.appendChild(zone);
    }
  }
}

/** Construit une liste groupée par type dans `conteneur`. */
function construireGroupes(conteneur, detections, surBascule, texteVide) {
  conteneur.innerHTML = "";

  if (!detections.length) {
    const vide = document.createElement("p");
    vide.className = "aide";
    vide.textContent = texteVide;
    conteneur.appendChild(vide);
    return;
  }

  const parType = new Map();
  for (const d of detections) {
    if (!parType.has(d.type)) parType.set(d.type, []);
    parType.get(d.type).push(d);
  }

  for (const [type, liste] of parType) {
    const groupe = document.createElement("details");
    groupe.className = "groupe";
    groupe.open = liste.length <= 6;

    const entete = document.createElement("summary");
    const coche = document.createElement("input");
    coche.type = "checkbox";
    const nbChoisis = liste.filter((d) => d.choisi).length;
    coche.checked = nbChoisis === liste.length;
    coche.indeterminate = nbChoisis > 0 && nbChoisis < liste.length;
    coche.addEventListener("click", (e) => {
      e.stopPropagation();
      const valeur = coche.checked;
      liste.forEach((d) => (d.choisi = valeur));
      surBascule(null);
    });
    const titre = document.createElement("span");
    titre.className = "groupe-titre";
    titre.textContent = COFFRE_DETECTEURS.TYPES[type] || type;
    const nombre = document.createElement("span");
    nombre.className = "groupe-nombre";
    nombre.textContent = nbChoisis + "/" + liste.length;
    entete.append(coche, titre, nombre);
    groupe.appendChild(entete);

    for (const d of liste) {
      const ligne = document.createElement("label");
      ligne.className = "detection";
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = d.choisi;
      c.addEventListener("change", () => surBascule(d));
      const val = document.createElement("span");
      val.className = "detection-valeur";
      val.textContent = d.valeur.length > 34 ? d.valeur.slice(0, 33) + "…" : d.valeur;
      val.title = d.contexte || d.valeur;
      const ou = document.createElement("span");
      ou.className = "detection-page";
      ou.textContent = d.page ? "p." + d.page : "";
      ligne.append(c, val, ou);
      groupe.appendChild(ligne);
    }
    conteneur.appendChild(groupe);
  }
}

function majPanneau() {
  construireGroupes(
    $("groupes-detections"),
    etat.detections,
    (d) => { if (d) d.choisi = !d.choisi; rafraichir(); },
    "Aucune information sensible détectée automatiquement. Surlignez du texte dans l'aperçu pour masquer manuellement."
  );
}

function basculerDetection(id) {
  const d = etat.detections.find((x) => x.id === id);
  if (d) d.choisi = !d.choisi;
  rafraichir();
}

function rafraichir() {
  majZones();
  majPanneau();
  majTexteBoutons();
}

function majTexteBoutons() {
  const n = etat.detections.filter((d) => d.choisi).length;
  const mot = modes.pdf === "anonyme" ? "anonymisé" : "protégé";
  $("btn-generer-protege").textContent =
    n > 0 ? "Générer le PDF " + mot + " (" + n + " zone" + (n > 1 ? "s" : "") + " masquée" + (n > 1 ? "s" : "") + ")"
          : "Générer le PDF " + mot + " (aucune zone masquée)";
}

/* ══ PDF — sélection manuelle dans l'aperçu ═══════════════════════════════ */

const boutonMasquer = $("btn-masquer-selection");

document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    boutonMasquer.hidden = true;
    return;
  }
  const plage = sel.getRangeAt(0);
  const apercu = $("apercu-pages");
  if (!apercu.contains(plage.commonAncestorContainer)) {
    boutonMasquer.hidden = true;
    return;
  }
  const boite = plage.getBoundingClientRect();
  if (!boite.width && !boite.height) { boutonMasquer.hidden = true; return; }
  const cadre = $("vue-protege").getBoundingClientRect();
  boutonMasquer.style.left = boite.left - cadre.left + boite.width / 2 + "px";
  boutonMasquer.style.top = boite.top - cadre.top - 38 + "px";
  boutonMasquer.hidden = false;
});

boutonMasquer.addEventListener("click", () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const plage = sel.getRangeAt(0);
  const valeur = sel.toString().replace(/[\n ]+/g, " ").trim();

  const parPage = new Map();
  for (const boite of plage.getClientRects()) {
    if (boite.width < 2 || boite.height < 2) continue;
    for (const conteneur of document.querySelectorAll(".page-pdf")) {
      const cadre = conteneur.getBoundingClientRect();
      if (boite.left >= cadre.left - 2 && boite.right <= cadre.right + 2 &&
          boite.top >= cadre.top - 2 && boite.bottom <= cadre.bottom + 2) {
        const num = Number(conteneur.dataset.page);
        const e = etat.pages[num - 1].echelle;
        if (!parPage.has(num)) parPage.set(num, []);
        parPage.get(num).push({
          x: (boite.left - cadre.left) / e - 1,
          y: (boite.top - cadre.top) / e - 1,
          w: boite.width / e + 2,
          h: boite.height / e + 2,
        });
        break;
      }
    }
  }
  for (const [num, rects] of parPage) {
    etat.detections.push({
      id: ++etat.compteur,
      type: "manuel",
      valeur: valeur.length > 40 ? valeur.slice(0, 39) + "…" : valeur || "zone",
      page: num,
      rects: rects,
      choisi: true,
    });
  }
  sel.removeAllRanges();
  boutonMasquer.hidden = true;
  rafraichir();
});

/** Signale si ce document a déjà une référence — ce qui évite d'en produire un
 *  second exemplaire pour un candidat déjà enregistré, et permet de retrouver
 *  la trace d'un document reçu anonymisé. */
async function annoncerReference() {
  const note = $("note-reference");
  if (!note) return;
  note.hidden = false;

  const connue = window.COFFRE_REFERENCES
    ? await window.COFFRE_REFERENCES.parEmpreinte(etat.empreinte)
    : null;

  if (!connue) {
    note.textContent =
      "Nouveau document : sa référence lui sera attribuée à la génération.";
    return;
  }

  etat.reference = connue.reference;
  note.innerHTML =
    "Déjà traité le " + new Date(connue.cree).toLocaleDateString("fr-FR") +
    " (" + connue.mode + ") sous la référence <strong>" + connue.reference + "</strong>," +
    " à partir de « " + connue.nom + " ».";
}

/* ══ PDF — génération du document protégé ═════════════════════════════════ */

/** Cache de masquage : bandeau sombre rempli de « XXXX ». */
/** Efface une zone : un rectangle blanc, sans rien écrire dessus.
 *
 *  Le bandeau est légèrement débordé (un demi-pixel de chaque côté) car les
 *  jambages et accents d'une police dépassent souvent de la boîte du texte :
 *  sans cette marge, un fragment de lettre resterait visible au bord. */
function dessinerMasque(ctx, x, y, l, h) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 0.5, y - 0.5, l + 1, h + 1);
}

/** Chiffre l'original par la clé locale du serveur (aucun mot de passe). */
async function chiffrerOriginal() {
  const reponse = await fetch("/api/chiffrer", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Nom-Fichier": encodeURIComponent(etat.fichier.name),
    },
    body: etat.octets,
  });
  if (!reponse.ok) {
    let message = "Erreur " + reponse.status;
    try { message = (await reponse.json()).erreur || message; } catch (err) { /* brut */ }
    throw new Error(message);
  }
  return new Uint8Array(await reponse.arrayBuffer());
}

async function genererProtege(toutMasquer) {
  const resultats = $("resultats-protege");
  resultats.innerHTML = "";

  const li = document.createElement("li");
  li.className = "encours";
  const nom = document.createElement("span");
  nom.className = "nom";
  nom.textContent = etat.fichier.name;
  const etatTexte = document.createElement("span");
  etatTexte.className = "etat";
  etatTexte.innerHTML = '<span class="tourne"></span>Chiffrement et assemblage…';
  li.append(nom, etatTexte);
  resultats.appendChild(li);
  li.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const anonyme = modes.pdf === "anonyme";
  try {
    const charge = anonyme ? null : await chiffrerOriginal();

    const sortie = await PDFLib.PDFDocument.create();
    sortie.setProducer("ADBI Coffre");
    sortie.setCreator("ADBI Coffre");
    sortie.setSubject(anonyme ? "ADBI-COFFRE-ANONYME:v1" : "ADBI-COFFRE-PROTEGE:v1");

    if (toutMasquer) {
      const premiere = etat.pages[0];
      const page = sortie.addPage([premiere.largeur, premiere.hauteur]);
      const police = await sortie.embedFont(PDFLib.StandardFonts.HelveticaBold);
      const policeTexte = await sortie.embedFont(PDFLib.StandardFonts.Helvetica);
      const { width, height } = page.getSize();
      page.drawRectangle({ x: 0, y: 0, width: width, height: height, color: PDFLib.rgb(0.965, 0.965, 0.975) });
      page.drawRectangle({ x: 0, y: height - 8, width: width, height: 8, color: PDFLib.rgb(0.545, 0.102, 0.494) });
      page.drawText("Document protégé", {
        x: 60, y: height / 2 + 30, size: 26, font: police, color: PDFLib.rgb(0.07, 0.07, 0.1),
      });
      page.drawText("Le contenu intégral de ce document est chiffré (AES-256-GCM).", {
        x: 60, y: height / 2 - 8, size: 12, font: policeTexte, color: PDFLib.rgb(0.3, 0.3, 0.39),
      });
      page.drawText("Pour le lire : ADBI Coffre, onglet « Déchiffrer », sur un poste détenant la clé.", {
        x: 60, y: height / 2 - 30, size: 12, font: policeTexte, color: PDFLib.rgb(0.3, 0.3, 0.39),
      });
    } else {
      const parPage = new Map();
      for (const d of etat.detections) {
        if (!d.choisi) continue;
        if (!parPage.has(d.page)) parPage.set(d.page, []);
        parPage.get(d.page).push(...d.rects);
      }

      const qualite = etat.pages.length > 20 ? 1.5 : 2;
      for (const infos of etat.pages) {
        etatTexte.innerHTML = '<span class="tourne"></span>Page ' + infos.num + " / " + etat.pages.length + "…";
        const page = await etat.doc.getPage(infos.num);
        const viewport = page.getViewport({ scale: qualite });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: viewport, intent: "print" }).promise;

        for (const r of parPage.get(infos.num) || []) {
          dessinerMasque(ctx, r.x * qualite, r.y * qualite, r.w * qualite, r.h * qualite);
        }

        const jpeg = canvas.toDataURL("image/jpeg", 0.85);
        const image = await sortie.embedJpg(jpeg);
        const pageSortie = sortie.addPage([infos.largeur, infos.hauteur]);
        pageSortie.drawImage(image, { x: 0, y: 0, width: infos.largeur, height: infos.hauteur });
      }
    }

    if (charge) {
      await sortie.attach(charge, NOM_CHARGE, {
        mimeType: "application/octet-stream",
        description: "Original chiffré (AES-256-GCM) — ADBI Coffre",
        creationDate: new Date(),
        modificationDate: new Date(),
      });
    }

    const octets = await sortie.save();

    /* La référence est attribuée par le registre, pas calculée ici : lui seul
       sait si ce document en a déjà une, et de quel mois elle date. */
    const mode = anonyme ? "anonymisé" : "protégé";
    const attribution = window.COFFRE_REFERENCES
      ? await window.COFFRE_REFERENCES.attribuer({
          empreinte: etat.empreinte, nom: etat.fichier.name, format: "PDF", mode: mode,
        })
      : null;
    // Registre injoignable : on produit quand même le fichier, avec la seule
    // partie stable de la référence. Mieux vaut un document protégé sans trace
    // qu'un échec de génération.
    etat.reference = attribution ? attribution.entree.reference : "CV-0000-" + etat.empreinte;

    const nomSortie = COFFRE_DETECTEURS.nommerSortie(etat.fichier.name, ".pdf", etat.reference, anonyme);
    if (attribution) {
      window.COFFRE_REFERENCES.conserver(etat.reference, nomSortie, octets, "application/pdf");
    }
    const blob = new Blob([octets], { type: "application/pdf" });

    li.className = "ok";
    etatTexte.textContent = toutMasquer
      ? "Document entièrement masqué"
      : anonyme ? "PDF anonymisé (définitif)" : "PDF protégé";
    nom.textContent = etat.fichier.name + " → " + nomSortie;
    li.appendChild(window.COFFRE.lienTelechargement(nomSortie, blob, true));
  } catch (err) {
    li.className = "erreur";
    etatTexte.textContent = err.message;
  }
}

/* ══ Word (.docx) — analyse et protection via le serveur local ════════════ */

async function analyserFichierDocx(fichier) {
  etatDocx.fichier = fichier;
  etatDocx.detections = [];

  afficherEtape("analyse");
  $("analyse-texte").textContent = "Analyse du document Word…";

  const reponse = await fetch("/api/docx/analyser", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: fichier,
  });
  if (!reponse.ok) {
    let message = "Analyse impossible.";
    try { message = (await reponse.json()).erreur || message; } catch (err) { /* brut */ }
    afficherErreurDepot(message);
    afficherEtape("depot");
    return;
  }
  const donnees = await reponse.json();
  etatDocx.detections = (donnees.detections || []).map((d) => Object.assign({ choisi: true }, d));

  $("docx-nom").textContent = fichier.name;
  majPanneauDocx();
  afficherEtape("atelier-docx");
}

function majPanneauDocx() {
  construireGroupes(
    $("groupes-docx"),
    etatDocx.detections,
    (d) => { if (d) d.choisi = !d.choisi; majPanneauDocx(); },
    "Aucune information sensible détectée automatiquement dans ce document."
  );
  const n = etatDocx.detections.filter((d) => d.choisi).length;
  const mot = modes.docx === "anonyme" ? "anonymisé" : "protégé";
  $("btn-generer-docx").textContent =
    n > 0 ? "Générer le Word " + mot + " (" + n + " zone" + (n > 1 ? "s" : "") + " masquée" + (n > 1 ? "s" : "") + ")"
          : "Générer le Word " + mot + " (aucune zone masquée)";
}

async function genererDocx(toutMasquer) {
  const resultats = $("resultats-docx");
  resultats.innerHTML = "";

  const li = document.createElement("li");
  li.className = "encours";
  const nom = document.createElement("span");
  nom.className = "nom";
  nom.textContent = etatDocx.fichier.name;
  const etatTexte = document.createElement("span");
  etatTexte.className = "etat";
  etatTexte.innerHTML = '<span class="tourne"></span>Chiffrement et assemblage…';
  li.append(nom, etatTexte);
  resultats.appendChild(li);

  const anonyme = modes.docx === "anonyme";
  try {
    const entetes = {};
    if (anonyme) entetes["X-Anonymiser"] = "1";
    if (toutMasquer) entetes["X-Tout"] = "1";
    else entetes["X-Zones"] = etatDocx.detections.filter((d) => d.choisi).map((d) => d.id).join(",");

    const sortie = await window.COFFRE.envoyer(
      "/api/docx/proteger",
      etatDocx.fichier.name,
      etatDocx.fichier,
      entetes
    );
    li.className = "ok";
    etatTexte.textContent = toutMasquer
      ? "Document entièrement masqué"
      : anonyme ? "Word anonymisé (définitif)" : "Word protégé";
    nom.textContent = etatDocx.fichier.name + " → " + sortie.nom;
    li.appendChild(window.COFFRE.lienTelechargement(sortie.nom, sortie.blob, true));
  } catch (err) {
    li.className = "erreur";
    etatTexte.textContent = err.message;
  }
}

/* ══ Extraction de la charge d'un PDF protégé (pour l'onglet Déchiffrer) ══ */

async function extraireCharge(octets) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(octets) }).promise;
  const attachements = (await doc.getAttachments()) || {};
  let anonyme = false;
  try {
    const meta = await doc.getMetadata();
    anonyme = String((meta.info || {}).Subject || "").includes("ADBI-COFFRE-ANONYME");
  } catch (err) {
    /* métadonnées absentes : sans conséquence */
  }
  doc.destroy();
  for (const nom of Object.keys(attachements)) {
    if (nom === NOM_CHARGE || nom.toLowerCase().endsWith(".adbi")) {
      return { charge: attachements[nom].content, anonyme: anonyme };
    }
  }
  return { charge: null, anonyme: anonyme };
}

window.COFFRE_PDF = { extraireCharge: extraireCharge };

/* ══ Branchement de la vue ════════════════════════════════════════════════ */

function afficherEtape(nom) {
  $("protege-depot").hidden = nom !== "depot";
  $("protege-analyse").hidden = nom !== "analyse";
  $("protege-atelier").hidden = nom !== "atelier";
  $("protege-atelier-docx").hidden = nom !== "atelier-docx";
}

function afficherErreurDepot(message) {
  const alerte = $("erreur-protege");
  alerte.textContent = message;
  alerte.hidden = false;
}

function nouveauFichier(fichiers) {
  $("erreur-protege").hidden = true;
  const pdf = fichiers.find((f) => /[.]pdf$/i.test(f.name));
  const word = fichiers.find((f) => /[.]docx$/i.test(f.name));
  if (pdf) {
    analyserFichierPdf(pdf).catch((err) => {
      afficherErreurDepot("Analyse impossible : " + err.message);
      afficherEtape("depot");
    });
  } else if (word) {
    analyserFichierDocx(word).catch((err) => {
      afficherErreurDepot("Analyse impossible : " + err.message);
      afficherEtape("depot");
    });
  } else {
    afficherErreurDepot(
      "Formats gérés pour la protection « même format » : PDF et Word (.docx). " +
      "Les autres formats (Excel, images…) arrivent dans une prochaine version."
    );
  }
}

window.COFFRE.initDepot(
  $("depot-protege"),
  $("fichier-protege"),
  $("btn-parcourir-protege"),
  nouveauFichier
);

function retourDepot() {
  if (etat.doc) { etat.doc.destroy(); etat.doc = null; }
  etat.pages = [];
  etat.detections = [];
  etatDocx.fichier = null;
  etatDocx.detections = [];
  $("apercu-pages").innerHTML = "";
  $("resultats-protege").innerHTML = "";
  $("resultats-docx").innerHTML = "";
  afficherEtape("depot");
}

$("btn-tout-cocher").addEventListener("click", () => {
  etat.detections.forEach((d) => (d.choisi = true));
  rafraichir();
});
$("btn-tout-decocher").addEventListener("click", () => {
  etat.detections.forEach((d) => (d.choisi = false));
  rafraichir();
});
$("btn-generer-protege").addEventListener("click", () => genererProtege(false));
$("btn-tout-masquer").addEventListener("click", () => genererProtege(true));
$("btn-autre-pdf").addEventListener("click", retourDepot);

document.querySelectorAll(".choix-mode .mode").forEach((bouton) => {
  bouton.addEventListener("click", () => {
    const portee = bouton.dataset.portee;
    modes[portee] = bouton.dataset.mode;
    document
      .querySelectorAll('.choix-mode .mode[data-portee="' + portee + '"]')
      .forEach((b) => b.classList.toggle("actif", b === bouton));
    $(portee === "pdf" ? "aide-mode-pdf" : "aide-mode-docx").textContent =
      AIDE_MODE[modes[portee]];
    if (portee === "pdf") majTexteBoutons();
    else majPanneauDocx();
  });
});

$("btn-tout-cocher-docx").addEventListener("click", () => {
  etatDocx.detections.forEach((d) => (d.choisi = true));
  majPanneauDocx();
});
$("btn-tout-decocher-docx").addEventListener("click", () => {
  etatDocx.detections.forEach((d) => (d.choisi = false));
  majPanneauDocx();
});
$("btn-generer-docx").addEventListener("click", () => genererDocx(false));
$("btn-tout-masquer-docx").addEventListener("click", () => genererDocx(true));
$("btn-autre-docx").addEventListener("click", retourDepot);
