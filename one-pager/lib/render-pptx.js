/**
 * Export PowerPoint du one-pager, au gabarit ADBI (slide 20 x 11,25 pouces).
 *
 * Deux sorties : le dossier d'un consultant (`buildPptx`) et le livret
 * multi-consultants (`buildLivret`), page de garde suivie d'une slide par
 * dossier. Les deux partagent le meme rendu de slide.
 *
 * Le PPTX est le format attendu en interne : les equipes commerciales
 * retouchent systematiquement le dossier avant envoi au client. Le PDF, lui,
 * est produit par l'impression du rendu HTML, qui reste la reference visuelle.
 *
 * Contrainte non negociable : le fichier doit s'ouvrir sans message de
 * reparation. D'ou les garde-fous de ce module — aucune image SVG, aucun
 * fichier absent reference, aucune coordonnee negative, nulle ou NaN.
 */

const fs = require("fs");
const path = require("path");
const PptxGenJS = require("pptxgenjs");
const N = require("./normalize");

// Charte ADBI relevee sur le gabarit existant.
const C = {
  orange: "FF5F00",
  orange2: "FB7603",
  violet: "8E0B80",
  encre: "2B2B33",
  gris: "6A6A76",
  blanc: "FFFFFF",
};

// Grille du gabarit, en pouces.
const G = {
  largeur: 20,
  hauteur: 11.25,

  titreX: 0.58,
  titreY: 0.3,
  titreW: 9.5,
  titreH: 0.6,

  portraitX: 10.16,
  portraitY: 0.27,
  portraitD: 2.13,

  expX: 0.58,
  expY: 1.3,
  expW: 8.62,

  missX: 0.58,
  missY: 2.1,
  missW: 12.2,
  missBas: 9.6,
  missBasSansBadges: 10.05,

  colX: 14.63,
  colW: 4.9,
  // Aligne sur expY : les deux bandeaux de titre demarrent a la meme hauteur.
  compY: 1.3,
  compW: 4.42,
  bandeauH: 0.63,

  pastilleW: 2.1,
  pastilleH: 0.75,
  pastilleGap: 0.2,

  certX: 14.78,
  certW: 4.42,

  badgeY: 9.6,
  badgeD: 1.4,
  badgeGap: 0.15,
  badgeCentre: 12.25,

  logoX: 0.5,
  logoY: 10.15,
  logoW: 1.75,
  logoH: 0.88,
};

const POLICE = "Calibri";

// Filigrane des vagues : 0 = opaque, 100 = invisible.
const TRANSPARENCE_VAGUES = 62;

/**
 * Corps de police, en points, releves dans le livret ADBI de reference.
 * La slide fait 20 pouces de large : des valeurs de 9 ou 10 pt y paraissent
 * minuscules a l'ecran comme a l'impression. Le gabarit travaille a 15 pt pour
 * le corps et 27 pt pour les bandeaux — c'est cette echelle qui est reprise.
 */
const T = {
  titre: 27,
  bandeau: 27,
  bandeauCote: 20,  // colonnes de droite : bandeaux plus etroits, texte reduit
  badge: 21,
  // Taille UNIQUE pour tout le bloc missions — intitule, contexte,
  // realisations et ligne technique. C'est le parti du livret ADBI de
  // reference : la hierarchie se lit a la couleur et a la graisse, pas au corps.
  role: 15,
  contexte: 15,
  puce: 15,
  tech: 15,
  chip: 18,
  chipLong: 14,
  competence: 14,
  certif: 14,
  pied: 12,
};

async function buildPptx(op) {
  const pres = nouvellePresentation();
  const d = ajouterSlideConsultant(pres, pres.addSlide(), op);
  pres.title = txt("Dossier de compétences — " + d.header.name);

  return pres.write({ outputType: "nodebuffer" });
}

/**
 * Livret multi-consultants : une page de garde, puis une slide par dossier.
 * Le rendu d'un consultant est exactement celui de `buildPptx` — c'est la meme
 * fonction qui est appelee, pour qu'un livret et un dossier isole ne puissent
 * jamais diverger.
 *
 * @param {object[]} ops       cv_onepager, dans l'ordre d'affichage
 * @param {object}   options   { titre, sousTitre, date }, tous facultatifs
 */
async function buildLivret(ops, options = {}) {
  const liste = Array.isArray(ops) ? ops.filter((o) => o && typeof o === "object") : [];
  const o = options && typeof options === "object" ? options : {};

  const meta = {
    titre: txt(o.titre) || "Livret de compétences",
    sousTitre: txt(o.sousTitre),
    date: txt(o.date) || dateDuJour(),
  };

  const pres = nouvellePresentation();
  pres.title = meta.titre;

  pageDeGarde(pres, pres.addSlide(), liste.map(profil), meta);
  liste.forEach((op) => ajouterSlideConsultant(pres, pres.addSlide(), op));

  return pres.write({ outputType: "nodebuffer" });
}

/** Presentation vide au gabarit ADBI, commune au dossier isole et au livret. */
function nouvellePresentation() {
  const pres = new PptxGenJS();
  pres.defineLayout({ name: "ADBI", width: G.largeur, height: G.hauteur });
  pres.layout = "ADBI";
  pres.author = "ADBI";
  pres.company = "ADBI";
  return pres;
}

/** Rend un dossier de competences sur la slide fournie et renvoie ses donnees normalisees. */
function ajouterSlideConsultant(pres, s, op) {
  const d = normaliser(op);

  s.background = { color: C.blanc };

  decor(s);
  entete(pres, s, d);
  missions(s, d);
  // Les certifications sont mesurees d'abord : elles reservent leur place en
  // bas de colonne, ce qui evite au bandeau de remonter sur les competences.
  const bloc = blocCertifs(d);
  const yColonne = competences(pres, s, d, G.missBas - bloc.h);
  certifications(pres, s, yColonne, bloc);
  pied(s, d);

  return d;
}

// ------------------------------------------------------------------ Blocs ---

/**
 * Habillage fixe du gabarit : les deux vagues d'arcs, le coin orange et le
 * logo. Positions, tailles et rotations relevees dans le masque du livret ADBI
 * — elles ne dependent d'aucune donnee et sont donc identiques d'un dossier a
 * l'autre. Les debordements hors slide sont voulus : les vagues sont coupees
 * par les bords, comme dans le gabarit d'origine.
 */
function decor(s) {
  const vague = image("assets/fond-vagues.png");
  if (!vague) return;
  // Les arcs sont un filigrane, pas un motif : a pleine opacite ils passent
  // devant le texte. Le gabarit d'origine les detoure dans une forme libre,
  // ce que pptxgenjs ne sait pas faire — on obtient la meme discretion en
  // jouant sur la transparence.
  const filigrane = { transparency: TRANSPARENCE_VAGUES, altText: "" };
  s.addImage({ ...vague, ...filigrane, x: 9.09, y: -6.46, w: 14.96, h: 9.64, rotate: 336 });
  s.addImage({ ...vague, ...filigrane, x: 0.92, y: 8.65, w: 14.96, h: 9.64, rotate: 146 });
}

function entete(pres, s, d) {
  // Sans trigramme ni nom (CV deja anonymise, sans code), le titre tient seul :
  // pas de deux-points orphelin en tete de dossier.
  const runs = [];
  if (d.header.name) runs.push({ text: d.header.name, options: { color: C.orange, bold: true } });
  if (d.header.title) {
    runs.push({ text: (d.header.name ? " : " : "") + d.header.title, options: { color: C.encre, bold: false } });
  }

  s.addText(runs, {
    x: G.titreX, y: G.titreY, w: G.titreW, h: G.titreH,
    fontSize: T.titre, fontFace: POLICE, valign: "middle", fit: "shrink",
  });

  // Portrait : l'anneau orange est un disque plein pose sous l'image ronde,
  // l'image le recouvre entierement sauf sur son epaisseur.
  const img = image(d.visual.portrait);
  if (img) {
    const e = 0.045;
    s.addShape(pres.ShapeType.ellipse, {
      x: G.portraitX - e, y: G.portraitY - e,
      w: G.portraitD + 2 * e, h: G.portraitD + 2 * e,
      fill: { color: C.orange }, line: { color: C.orange, width: 1 },
    });
    s.addImage({
      ...img,
      x: G.portraitX, y: G.portraitY, w: G.portraitD, h: G.portraitD,
      rounding: true,
      altText: d.visual.is_photo ? "Portrait" : "Illustration",
    });
  }

  bandeau(pres, s, {
    x: G.expX, y: G.expY, w: G.expW,
    titre: "Expériences",
    droite: d.header.badge,
  });
}

function missions(s, d) {
  // La rangee de badges n'occupe le bas de page que s'il y en a. Sans badge,
  // ces 0,45 pouce sont rendus aux missions — c'est autant de realisations
  // conservees, alors qu'elles etaient sacrifiees pour une zone vide.
  const bas = d.visual.badges.length ? G.missBas : G.missBasSansBadges;
  const dispo = bas - G.missY;
  const gap = 0.18;

  // Le dossier recu fait foi : on n'enleve NI mission NI realisation. C'est
  // l'apercu qui a deja arbitre ce qui tient, et l'export doit montrer
  // exactement la meme chose — sinon le commercial envoie un document qui ne
  // correspond pas a ce qu'il a validé a l'ecran.
  //
  // Quand le contenu depasse malgre tout, on reduit le corps de police plutot
  // que de retrancher : un texte legerement plus petit reste fidele, un texte
  // amputé ne l'est pas. Le facteur est plafonne pour rester lisible.
  const exps = d.experiences.map((e) => ({ ...e, bullets: [...e.bullets] }));
  const mesurer = (k) =>
    exps.reduce((a, e) => a + hauteurMission(e, k), 0) + gap * Math.max(0, exps.length - 1);

  // La hauteur ne decroit pas proportionnellement au corps : le nombre de
  // lignes est un arrondi superieur, et l'espacement de paragraphe est fixe.
  // Un facteur calcule en une division tombe donc a cote — on balaye.
  let k = 1;
  // Le plancher est bas parce que la reduction n'est PAS uniforme : grace a
  // corps(), les puces resistent (elles ne descendent pas sous ~12 pt) tandis
  // que l'intitule et le contexte se compriment davantage. Descendre bas ne
  // sacrifie donc pas la lisibilite de ce qui compte.
  for (let essai = 1; essai >= 0.5; essai -= 0.02) {
    k = essai;
    if (mesurer(k) <= dispo) break;
  }

  // Ultime recours : meme au plus petit corps lisible, le contenu ne rentre
  // pas. On retire alors les realisations les moins bien notees, en le
  // signalant, plutot que de laisser les textes se chevaucher.
  let retirees = 0;
  for (let i = 0; i < 60 && mesurer(k) > dispo; i++) {
    const cible = exps
      .filter((e) => e.bullets.length > 1)
      .sort((a, b) => b.bullets.length - a.bullets.length)[0];
    if (!cible) break;
    cible.bullets.pop();
    retirees++;
  }
  if (retirees) {
    console.warn(`[pptx] ${retirees} réalisation(s) retirée(s) : contenu trop long même au corps minimal.`);
  }

  const naturelles = exps.map((e) => hauteurMission(e, k));
  const totalNat = naturelles.reduce((a, b) => a + b, 0) + gap * Math.max(0, exps.length - 1);
  const surplus = Math.max(0, dispo - totalNat);

  let y = G.missY;
  exps.forEach((e, i) => {
    const part = totalNat > 0 ? naturelles[i] / totalNat : 1 / exps.length;
    // Chaque mission garde sa hauteur naturelle ; le surplus eventuel est
    // reparti au prorata, plafonne pour ne pas creuser de grands vides.
    const bande = naturelles[i] + Math.min(surplus * part, 0.4);
    mission(s, e, y, k);
    y += bande + gap;
  });
}

function mission(s, e, yTop, k = 1) {
  let y = yTop;
  // k : facteur d'echelle applique quand le contenu depasse. Il touche les
  // corps de police ET les hauteurs, pour que le calcul reste coherent.
  const P = corps(k);

  const runs = [
    { text: "●  ", options: { color: C.violet, bold: true } },
    { text: e.role, options: { color: C.violet, bold: true } },
  ];
  // Ordre impose par le gabarit : intitule du poste, puis client, puis periode.
  // Le separateur est pose meme sans client, sinon la date se colle au titre.
  if (e.client) runs.push({ text: "  —  " + e.client, options: { color: C.orange, bold: true } });
  if (e.period) runs.push({ text: "  —  " + e.period, options: { color: C.gris, bold: false } });

  s.addText(runs.filter((r) => r.text), {
    x: G.missX, y, w: G.missW, h: 0.32 * k,
    fontSize: P.role, fontFace: POLICE, valign: "middle",
  });
  y += 0.34 * k;

  // Les hauteurs ne sont plus rognees : la bande allouee vaut deja la hauteur
  // naturelle du contenu (voir missions()). Rogner ferait deborder le texte
  // par-dessus le bloc suivant, PowerPoint ne coupant jamais un paragraphe.
  if (e.context) {
    const h = hauteurTexte(e.context, G.missW - 0.3, P.contexte);
    s.addText(e.context, {
      x: G.missX + 0.28, y, w: G.missW - 0.3, h,
      fontSize: P.contexte, color: C.encre, fontFace: POLICE, valign: "top",
      lineSpacingMultiple: 0.95, fit: "shrink",
    });
    y += h + 0.04;
  }

  const hTech = e.tech_line ? hauteurTexte(e.tech_line, G.missW - 0.5, P.tech) + 0.04 : 0;

  if (e.bullets.length) {
    const h = e.bullets.reduce((a, b) => a + hauteurTexte(b.text, G.missW - 0.75, P.puce), 0);
    s.addText(
      e.bullets.map((b) => ({
        text: b.text,
        options: {
          // Puce pleine sur les resultats chiffres, creuse sinon : la couleur
          // de puce suit celle du texte, on la distingue donc par la forme.
          bullet: { code: b.metric ? "25CF" : "25CB" },
          color: C.encre,
          bold: !!b.metric,
          fontSize: P.puce,
          breakLine: true,
        },
      })),
      {
        x: G.missX + 0.46, y, w: G.missW - 0.5, h,
        fontFace: POLICE, valign: "top", lineSpacingMultiple: 0.95, fit: "shrink",
      }
    );
    y += h + 0.04;
  }

  if (e.tech_line) {
    // Posee a la suite, jamais remontee : c'est ce recalage vers le haut qui
    // faisait chevaucher la ligne technique et les realisations.
    const yy = y;
    s.addText(
      [
        { text: "Environnement technique : ", options: { color: C.orange, bold: true } },
        { text: e.tech_line, options: { color: C.encre, bold: false } },
      ],
      {
        x: G.missX + 0.28, y: yy, w: G.missW - 0.3, h: Math.max(0.18, hTech),
        fontSize: P.tech, fontFace: POLICE, valign: "top", lineSpacingMultiple: 0.95, fit: "shrink",
      }
    );
  }
}

/** Rend la colonne de droite et renvoie l'ordonnee libre sous les competences. */
function competences(pres, s, d, plafond) {
  bandeau(pres, s, { x: G.colX, y: G.compY, w: G.compW, titre: "Compétences techniques", centre: true });

  const chips = d.chips.slice(0, 4);
  const yPastilles = G.compY + G.bandeauH + G.pastilleGap;
  chips.forEach((chip, i) => {
    const x = G.colX + (i % 2) * (G.pastilleW + G.pastilleGap);
    const y = yPastilles + Math.floor(i / 2) * (G.pastilleH + G.pastilleGap);
    const fond = image("assets/" + (i === 0 || i === 3 ? "chip-orange.png" : "chip-orange2.png"));
    if (fond) {
      s.addImage({ ...fond, x, y, w: G.pastilleW, h: G.pastilleH, altText: "" });
    } else {
      s.addShape(pres.ShapeType.roundRect, {
        x, y, w: G.pastilleW, h: G.pastilleH,
        fill: { color: i === 0 || i === 3 ? C.orange : C.orange2 },
        line: { color: C.blanc, width: 1 },
        rectRadius: G.pastilleH / 2,
      });
    }
    s.addText(chip, {
      x: x + 0.06, y, w: G.pastilleW - 0.12, h: G.pastilleH,
      // Un libelle fonctionnel (« Pilotage de programme ») est bien plus long
      // qu'un nom de techno : il passe au corps reduit plutot que de deborder.
      fontSize: chip.length > 14 ? T.chipLong : T.chip,
      color: C.blanc, bold: true, align: "center", valign: "middle",
      fontFace: POLICE, fit: "shrink",
    });
  });

  const lignes = Math.ceil(chips.length / 2);
  let y = lignes ? yPastilles + lignes * (G.pastilleH + G.pastilleGap) + 0.08 : yPastilles;

  d.skill_groups.forEach((g) => {
    const h = hauteurTexte(g.label + " : " + g.value, G.colW - 0.1, T.competence) + 0.02;
    // Une categorie entre entierement ou pas du tout : jamais de debordement.
    if (y + h > plafond) return;
    s.addText(
      [
        { text: g.label + " : ", options: { color: C.violet, bold: true } },
        { text: g.value, options: { color: C.encre, bold: false } },
      ],
      {
        x: G.colX, y, w: G.colW, h,
        fontSize: T.competence, fontFace: POLICE, valign: "top", lineSpacingMultiple: 0.95, fit: "shrink",
      }
    );
    y += h;
  });

  return y;
}

/** Certifications retenues et hauteur du bloc, plafonnee pour tenir en colonne. */
function blocCertifs(d) {
  const MAX = 3.2;
  const items = [];
  let hListe = 0.08;
  for (const c of d.certifications) {
    const h = hauteurTexte(c.text, G.certW - 0.35, T.certif);
    if (0.16 + G.bandeauH + hListe + h > MAX) break;
    items.push(c);
    hListe += h;
  }
  if (!items.length) return { items: [], hListe: 0, h: 0 };
  return { items, hListe, h: 0.16 + G.bandeauH + hListe };
}

function certifications(pres, s, yLibre, bloc) {
  if (!bloc.items.length) return;

  // Le bandeau enchaine directement sur les competences, sans espace mort :
  // la place a ete reservee en amont, il ne peut donc pas deborder.
  const y = yLibre + 0.16;

  bandeau(pres, s, { x: G.certX, y, w: G.certW, titre: "Certifications /Formations", centre: true });

  s.addText(
    bloc.items.map((c) => ({
      text: c.text,
      options: { bullet: { code: "2022" }, color: C.encre, fontSize: T.certif, breakLine: true },
    })),
    {
      x: G.certX + 0.1, y: y + G.bandeauH + 0.06, w: G.certW - 0.1, h: Math.max(0.2, bloc.hListe),
      fontFace: POLICE, valign: "top", lineSpacingMultiple: 0.95, fit: "shrink",
    }
  );
}

function pied(s, d) {
  const badges = d.visual.badges.map(image).filter(Boolean).slice(0, 5);
  if (badges.length) {
    const total = badges.length * G.badgeD + (badges.length - 1) * G.badgeGap;
    // Centre sur le gabarit, mais jamais sous la colonne de droite.
    const x0 = Math.max(0.1, Math.min(G.badgeCentre - total / 2, G.colX - 0.25 - total));
    badges.forEach((b, i) => {
      s.addImage({
        ...b,
        x: x0 + i * (G.badgeD + G.badgeGap),
        y: G.badgeY, w: G.badgeD, h: G.badgeD,
        altText: "Certification",
      });
    });
  }

  // Logo couleur pose sur le blanc, sans pave orange : c'est le pied de page
  // valide sur l'apercu, et il reste lisible quelle que soit la vague derriere.
  const logo = image(d.visual.logo) || image("assets/logo-adbi.png");
  if (logo) {
    s.addImage({ ...logo, x: G.logoX, y: G.logoY, w: G.logoW, h: G.logoH, altText: "ADBI" });
  }

  // Langues alignees a droite, sous la colonne des competences.
  if (d.languages.length) {
    s.addText("Langues : " + d.languages.join(" · "), {
      x: G.largeur - 7.2, y: G.logoY + 0.28, w: 6.6, h: 0.4,
      fontSize: T.pied, color: C.gris, fontFace: POLICE, valign: "middle", align: "right",
    });
  }
}

// -------------------------------------------------------- Page de garde ---

/** Grille de la page de garde, en pouces. Meme marge gauche que les slides consultants. */
const GARDE = {
  x: G.titreX,
  titreY: 1.55,
  titreH: 1.25,
  barreY: 2.98,
  sousTitreY: 3.2,
  dateY: 3.78,
  listeY: 4.35,
  ligneH: 0.36,
  parColonne: 14,
  colonneGap: 0.8,
};

const T_GARDE = { titre: 44, sousTitre: 22, date: 16, profil: 15 };

function pageDeGarde(pres, s, profils, meta) {
  s.background = { color: C.blanc };
  decor(s);

  const large = G.largeur - 2 * GARDE.x;

  s.addText(meta.titre, {
    x: GARDE.x, y: GARDE.titreY, w: large, h: GARDE.titreH,
    fontSize: T_GARDE.titre, color: C.encre, bold: true,
    fontFace: POLICE, valign: "middle", fit: "shrink",
  });

  // Filet orange : le seul rappel de charte qui ne depende pas des vagues,
  // lesquelles sont trop pales pour signer la page a elles seules.
  s.addShape(pres.ShapeType.rect, {
    x: GARDE.x, y: GARDE.barreY, w: 3.4, h: 0.07,
    fill: { color: C.orange }, line: { color: C.orange, width: 1 },
  });

  if (meta.sousTitre) {
    s.addText(meta.sousTitre, {
      x: GARDE.x, y: GARDE.sousTitreY, w: large, h: 0.55,
      fontSize: T_GARDE.sousTitre, color: C.violet,
      fontFace: POLICE, valign: "middle", fit: "shrink",
    });
  }

  if (meta.date) {
    s.addText(meta.date, {
      x: GARDE.x, y: GARDE.dateY, w: large, h: 0.4,
      fontSize: T_GARDE.date, color: C.gris,
      fontFace: POLICE, valign: "middle", fit: "shrink",
    });
  }

  listeProfils(s, profils, large);

  const logo = image("assets/logo-adbi.png");
  if (logo) {
    s.addImage({ ...logo, x: G.logoX, y: G.logoY, w: G.logoW, h: G.logoH, altText: "ADBI" });
  }
}

/**
 * Sommaire des profils, une ligne par consultant. Chaque ligne est un bloc
 * autonome de hauteur fixe : un intitule trop long est raccourci en amont
 * plutot que laisse deborder sur la ligne suivante, PowerPoint ne rognant
 * jamais un paragraphe.
 */
function listeProfils(s, profils, large) {
  const MAX = GARDE.parColonne * 2;

  let lignes = profils.slice(0, MAX);
  let reste = "";
  if (profils.length > MAX) {
    lignes = profils.slice(0, MAX - 1);
    reste = "… et " + (profils.length - (MAX - 1)) + " autres profils";
  }

  const deuxColonnes = lignes.length + (reste ? 1 : 0) > GARDE.parColonne;
  const w = deuxColonnes ? (large - GARDE.colonneGap) / 2 : large;
  const maxCar = Math.floor(w / (T_GARDE.profil * 0.0072));

  const poser = (i, runs) => {
    const col = deuxColonnes ? Math.floor(i / GARDE.parColonne) : 0;
    s.addText(runs, {
      x: GARDE.x + col * (w + GARDE.colonneGap),
      y: GARDE.listeY + (i - col * GARDE.parColonne) * GARDE.ligneH,
      w, h: GARDE.ligneH,
      fontSize: T_GARDE.profil, fontFace: POLICE, valign: "middle", fit: "shrink",
    });
  };

  lignes.forEach((p, i) => {
    const fixe = p.tri.length + p.badge.length + 6;
    const titre = tronquer(p.titre, Math.max(12, maxCar - fixe));
    const runs = [{ text: p.tri, options: { color: C.orange, bold: true } }];
    if (titre) runs.push({ text: "  —  " + titre, options: { color: C.encre, bold: false } });
    if (p.badge) runs.push({ text: "  —  " + p.badge, options: { color: C.gris, bold: false } });
    poser(i, runs);
  });

  if (reste) poser(lignes.length, [{ text: reste, options: { color: C.gris, bold: false } }]);
}

/** Trigramme, titre et anciennete tels qu'ils apparaissent au sommaire. */
function profil(op) {
  const d = normaliser(op);
  // Un dossier anonymise porte deja le trigramme en guise de nom : le
  // recalculer dessus donnerait un sigle du sigle.
  const anonyme = !!(op && op.header && op.header.anonymized);
  const tri = anonyme ? d.header.name.toUpperCase() : N.trigram(d.header.name) || d.header.name.toUpperCase();
  return { tri: tri || "???", titre: d.header.title, badge: d.header.badge };
}

function tronquer(s, max) {
  const v = String(s || "");
  return v.length <= max ? v : v.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
  "août", "septembre", "octobre", "novembre", "décembre"];

/** Date du jour en francais, sans dependre de la locale ICU du poste. */
function dateDuJour() {
  const d = new Date();
  return d.getDate() + " " + MOIS_FR[d.getMonth()] + " " + d.getFullYear();
}

/** Bandeau violet a coins pleinement arrondis, avec libelle et mention a droite. */
function bandeau(pres, s, o) {
  // Le degrade est une image : PowerPoint le gere nativement, mais pptxgenjs
  // n'expose aucune API pour en declarer un. Les pastilles ont des dimensions
  // fixes, l'image est donc posee a l'echelle 1, sans deformation des arrondis.
  const fond = image("assets/" + (o.centre ? "pill-violet-etroit.png" : "pill-violet-large.png"));
  if (fond) {
    s.addImage({ ...fond, x: o.x, y: o.y, w: o.w, h: G.bandeauH, altText: "" });
  } else {
    s.addShape(pres.ShapeType.roundRect, {
      x: o.x, y: o.y, w: o.w, h: G.bandeauH,
      fill: { color: C.violet }, line: { color: C.violet, width: 1 },
      rectRadius: G.bandeauH / 2,
    });
  }
  s.addText(o.titre, {
    x: o.x + 0.3, y: o.y, w: o.w - 0.6, h: G.bandeauH,
    // Les bandeaux de la colonne de droite sont deux fois plus etroits :
    // « Certifications /Formations » n'y tiendrait pas au corps du bandeau
    // principal.
    fontSize: o.centre ? T.bandeauCote : T.bandeau,
    color: C.blanc, bold: true, fontFace: POLICE,
    align: o.centre ? "center" : "left", valign: "middle", fit: "shrink",
  });
  if (o.droite) {
    s.addText(o.droite, {
      x: o.x + o.w * 0.45, y: o.y, w: o.w * 0.55 - 0.3, h: G.bandeauH,
      fontSize: T.badge, color: C.blanc, fontFace: POLICE,
      align: "right", valign: "middle", fit: "shrink",
    });
  }
}

// --------------------------------------------------------------- Outillage ---

/**
 * Resout une reference d'image en source pptxgenjs. Renvoie null si le format
 * n'est pas rasterise ou si le fichier n'existe pas : PowerPoint affiche un
 * cadre vide (voire refuse le fichier) pour un SVG sans repli PNG.
 */
function image(ref) {
  const src = typeof ref === "string" ? ref.trim() : "";
  if (!src) return null;

  if (src.startsWith("data:")) {
    return /^data:image\/(png|jpe?g|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(src) ? { data: src } : null;
  }
  if (!/\.(png|jpe?g|gif)$/i.test(src)) return null;

  const abs = path.join(__dirname, "..", "public", src.replace(/^[\\/]+/, ""));
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch (_) {
    return null;
  }
  return { path: abs };
}

/** Nombre de lignes estime pour un texte, a largeur et corps donnes. */
/**
 * Estimation du nombre de lignes rendues.
 *
 * Calibri fait en moyenne 0,48 cadratin par caractere. L'ancienne valeur
 * (0,52) surestimait la largeur de 8 % et, cumulee a un interligne surestime,
 * faisait croire que le contenu ne tenait pas — l'export sacrifiait alors des
 * realisations que l'apercu affichait sans peine.
 */
function nbLignes(texte, largeur, taille) {
  const parCaractere = (taille * 0.48) / 72; // en pouces
  const parLigne = Math.max(8, Math.floor(largeur / parCaractere));
  return Math.max(1, Math.ceil(String(texte).length / parLigne));
}

// Interligne reel : 1,2 cadratin, module par le lineSpacingMultiple de 0,95
// applique aux blocs de texte. La marge forfaitaire couvre l'espacement de
// paragraphe.
function hauteurTexte(texte, largeur, taille) {
  return nbLignes(texte, largeur, taille) * ((taille * 1.2 * 0.95) / 72) + 0.04;
}

/**
 * Corps de police effectifs pour un facteur de reduction donne.
 *
 * Les PUCES resistent davantage que le reste : c'est le contenu utile du
 * dossier, celui que le lecteur parcourt. L'intitule, le contexte et la ligne
 * technique se compriment plus vite pour lui laisser la place.
 */
function corps(k) {
  // Reduction strictement uniforme : les quatre niveaux gardent le meme
  // corps entre eux, quel que soit le facteur.
  return {
    role: T.role * k,
    contexte: T.contexte * k,
    puce: T.puce * k,
    tech: T.tech * k,
  };
}

function hauteurMission(e, k = 1) {
  const P = corps(k);
  let h = 0.34 * k;
  if (e.context) h += hauteurTexte(e.context, G.missW - 0.3, P.contexte) + 0.04;
  h += e.bullets.reduce((a, b) => a + hauteurTexte(b.text, G.missW - 0.75, P.puce), 0);
  if (e.tech_line) h += hauteurTexte(e.tech_line, G.missW - 0.5, P.tech) + 0.08;
  return h;
}

function txt(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  // Les caracteres de controle sont illegaux en XML 1.0, meme echappes.
  let out = "";
  for (const ch of String(v)) {
    const c = ch.codePointAt(0);
    if (c >= 32 || c === 9 || c === 10 || c === 13) out += ch;
  }
  return out.trim();
}

/** Projette `op` sur une structure sans trou : aucun champ ne peut valoir undefined. */
function normaliser(op) {
  const o = op && typeof op === "object" ? op : {};
  const header = o.header && typeof o.header === "object" ? o.header : {};
  const visual = o.visual && typeof o.visual === "object" ? o.visual : {};

  return {
    header: {
      name: txt(header.name) || "Consultant",
      title: txt(header.title),
      badge: txt(header.badge),
    },
    visual: {
      portrait: typeof visual.portrait === "string" ? visual.portrait : "",
      is_photo: !!visual.is_photo,
      badges: Array.isArray(visual.badges) ? visual.badges.filter((b) => typeof b === "string") : [],
      logo: typeof visual.logo === "string" ? visual.logo : "assets/logo-adbi.png",
    },
    experiences: (Array.isArray(o.experiences) ? o.experiences : [])
      .map((e) => e && typeof e === "object" ? e : {})
      .map((e) => ({
        role: txt(e.role) || "Mission",
        client: [txt(e.client), txt(e.via) ? "via " + txt(e.via) : ""].filter(Boolean).join(" "),
        period: txt(e.period),
        context: txt(e.context),
        bullets: (Array.isArray(e.bullets) ? e.bullets : [])
          .map((b) => ({ text: txt(b && b.text), metric: !!(b && b.metric) }))
          .filter((b) => b.text),
        tech_line: txt(e.tech_line),
      })),
    chips: (Array.isArray(o.chips) ? o.chips : []).map(txt).filter(Boolean),
    skill_groups: (Array.isArray(o.skill_groups) ? o.skill_groups : [])
      .map((g) => ({ label: txt(g && g.label), value: txt(g && g.value) }))
      .filter((g) => g.label && g.value),
    certifications: (Array.isArray(o.certifications) ? o.certifications : [])
      .map((c) => ({ text: txt(c && c.text) }))
      .filter((c) => c.text),
    languages: (Array.isArray(o.languages) ? o.languages : []).map(txt).filter(Boolean),
  };
}

module.exports = { buildPptx, buildLivret, COULEURS: C };
