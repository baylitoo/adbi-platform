/**
 * Normalisation deterministe : dates, telephones, emails, niveaux de langue.
 *
 * Tout ce qui est ici est du code, pas du modele de langage : c'est
 * reproductible, instantane et testable. On ne laisse a l'extraction que ce qui
 * demande vraiment de la comprehension.
 */

// « Quelle date ce texte porte-t-il ? » — meme question, et donc meme table de
// mois et meme jeu d'essai, que cv-parser/periode_mission.py. cv-parser
// n'analysait AUCUNE date jusqu'a #177 : il cherchait une annee a quatre
// chiffres dans la periode entiere, d'ou l'ordre des missions et l'anciennete
// divergents entre les deux services (#177, lignes 7, 8 et 9). Un test verifie
// l'egalite de cette table avec le champ `mois` du jeu d'essai : ajouter un
// libelle d'un cote casse le test de l'autre.
//
// Un trou trouve en ecrivant ce jeu d'essai : « fevr » manquait.
// Intl.DateTimeFormat('fr', {month:'short'}) rend « janv. fevr. mars avr. mai
// juin juil. aout sept. oct. nov. dec. », et c'etait le SEUL de ces abreges
// absent — donc le seul mois qu'un CV francais mis en forme par une
// bibliotheque perdait : « fevr. 2022 » ressortait « 2022 », annee seule.
const DATE_MISSION = require("../../document-parsing/fixtures/date_mission.json");
const MOIS = DATE_MISSION.mois;

// « Cette mission est-elle toujours en cours ? » — meme question, et donc meme
// liste, que cv-parser/periode_mission.py et lib/docie-extract.js. La liste
// vivait ici en troisieme exemplaire independant, avec ses propres trous :
// « Poste actuel » n'y figurait pas, donc une mission en cours etait lue comme
// terminee sur la voie d'extraction par mise en page (cf. inventaire de
// divergence #177, lignes 4 a 6). Elle est desormais lue depuis le jeu d'essai
// partage, et un test verifie l'egalite : ajouter un synonyme d'un cote casse
// le test de l'autre.
const MISSION_EN_COURS = require("../../document-parsing/fixtures/mission_en_cours.json");
const EN_COURS = new RegExp(MISSION_EN_COURS.motif, "i");

function deaccent(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** « Avr 2025 », « 04/2025 », « avril 2025 », « 2019 » -> « 2025-04 » / « 2019 ». */
function parseMonthYear(raw) {
  const s = deaccent(raw).toLowerCase().trim();

  let m = s.match(/\b(\d{1,2})[\/.-](\d{4})\b/); // 04/2025
  if (m) return iso(Number(m[2]), Number(m[1]));

  m = s.match(/\b(\d{4})[\/.-](\d{1,2})\b/); // 2025-04
  if (m) return iso(Number(m[1]), Number(m[2]));

  m = s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/); // 12/04/2025
  if (m) {
    const y = Number(m[3].length === 2 ? "20" + m[3] : m[3]);
    return iso(y, Number(m[2]));
  }

  m = s.match(/\b([a-z]{3,10})\.?\s+(\d{4})\b/); // avril 2025
  if (m && MOIS[m[1]]) return iso(Number(m[2]), MOIS[m[1]]);

  m = s.match(/\b(\d{4})\b/); // 2019 seul
  if (m) {
    const y = Number(m[1]);
    if (y >= 1950 && y <= 2100) return String(y);
  }
  return null;
}

function iso(year, month) {
  if (!year || year < 1950 || year > 2100) return null;
  if (!month || month < 1 || month > 12) return String(year);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Extrait une periode d'une ligne libre.
 * Gere « De juin 2024 a octobre 2025 », « Avr 2025 - Juil 2026 »,
 * « Depuis novembre 2025 », « 2015 - 2020 ».
 * @returns {{start, end, current, matched}|null}
 */
function parsePeriod(text) {
  if (!text) return null;
  const s = String(text);
  // On travaille sur la version sans accent : « \bà\b » ne matche jamais en
  // regex JS (a accentue n'est pas un caractere de mot). La longueur est
  // preservee, donc les index restent valables sur la chaine d'origine.
  const ds = deaccent(s);

  // « Février - Juin 2023 » : l'annee n'est portee que par la seconde borne,
  // formulation courante en francais pour un stage ou une mission courte.
  const MOIS_NOMS = Object.keys(MOIS).join("|");
  const moisMois = ds.match(
    new RegExp(`\\b(?:de\\s+|du\\s+)?(${MOIS_NOMS})\\.?\\s*(?:[—–\\-−]|a|au|jusqu.?au?|to)\\s*(${MOIS_NOMS})\\.?\\s+(\\d{4})\\b`, "i")
  );
  if (moisMois) {
    const an = Number(moisMois[3]);
    const debut = iso(an, MOIS[moisMois[1].toLowerCase()]);
    const fin = iso(an, MOIS[moisMois[2].toLowerCase()]);
    if (debut && fin) {
      return { start: debut, end: fin, current: false, matched: s.substr(moisMois.index, moisMois[0].length).trim() };
    }
  }

  const DATE = "(?:[a-z]{3,10}\\.?\\s+)?\\d{1,4}(?:[\\/.-]\\d{1,4})?(?:[\\/.-]\\d{2,4})?";
  const SEP = "(?:\\s*[—–\\-−]{1,2}\\s*|\\s+(?:a|au|jusqu.?au?|to|until)\\s+)";
  // « ce jour » figure sans son « à » : dans « du 02/2022 à ce jour », le « à »
  // a deja ete consomme comme separateur de la periode.
  //
  // Role DIFFERENT de EN_COURS, d'ou une liste distincte plutot que le motif
  // partage : ici on TOKENISE (qu'est-ce qui peut tenir lieu de borne de fin
  // dans du texte brut), la-haut on CLASSE (cette borne signifie-t-elle « en
  // cours »). « depuis » appartient au motif partage mais pas ici : il ouvre
  // une periode au lieu de la fermer, et la branche `since` plus bas le traite.
  // Consequence a ne pas perdre de vue : EN_COURS ne voit que ce que END a
  // laisse passer, donc un synonyme absent d'ici est mort meme s'il figure
  // dans le motif partage — c'est ainsi que « Poste actuel » etait ignore.
  // Un test verifie que END couvre bien tout le vocabulaire du jeu d'essai.
  const FIN_EN_COURS = "aujourd.?hui|(?:a\\s+)?ce\\s+jour|present|en\\s+cours|actuel(?:le(?:ment)?)?|current|now|to\\s+date|maintenant";
  // Le `\b` final n'est pas decoratif : sans lui, « present » matche le debut de
  // « Présentation client » et la borne de fin capturee devient « Present », donc
  // EN_COURS declare la mission en cours. Mesure sur la branche avant ce commit :
  // « Mars 2019 - Présentation client » ressortait current=true, matched
  // « Mars 2019 - Présent ». Le jeu d'essai partage porte ce cas comme garde-fou.
  const END = `(?:${DATE}|(?:${FIN_EN_COURS})\\b)`;

  // « Du 02/2022 à ce jour » : mission toujours en cours. Traite a part, car la
  // regle generale doit deja arbitrer « à » comme separateur ET comme premiere
  // lettre de la borne de fin — ambiguite qu'une seule expression gere mal.
  const jusquAujourdhui = ds.match(
    new RegExp(`\\b(?:de|du|depuis|from)?\\s*(${DATE})\\s*(?:[—–\\-−]{1,2}|a|au|jusqu.?\\s*au?|to)\\s+(?:${FIN_EN_COURS})\\b`, "i")
  );
  if (jusquAujourdhui) {
    const debut = parseMonthYear(jusquAujourdhui[1]);
    if (debut) {
      return {
        start: debut, end: null, current: true,
        matched: s.substr(jusquAujourdhui.index, jusquAujourdhui[0].length).trim(),
      };
    }
  }

  const range = ds.match(new RegExp(`(?:\\b(?:de|du|from)\\s+)?(${DATE})${SEP}(${END})`, "i"));
  if (range) {
    const start = parseMonthYear(range[1]);
    const current = EN_COURS.test(range[2]);
    const end = current ? null : parseMonthYear(range[2]);
    if (start && (end || current)) {
      return { start, end, current, matched: s.substr(range.index, range[0].length).trim() };
    }
  }

  // « Depuis novembre 2025 » / « Since 2020 »
  const since = ds.match(new RegExp(`\\b(?:depuis|since|a\\s+partir\\s+d[eu])\\s+(${DATE})`, "i"));
  if (since) {
    const start = parseMonthYear(since[1]);
    if (start) return { start, end: null, current: true, matched: s.substr(since.index, since[0].length).trim() };
  }

  // Une seule date, la ligne ne contenant presque rien d'autre.
  const alone = s.trim();
  if (alone.length <= 24) {
    const one = parseMonthYear(alone);
    // Teste sur la version desaccentuee, comme `range` plus haut : le motif
    // partage est ecrit sans accent (« present », « ce jour »), donc l'appliquer
    // au texte brut ratait « Présent » et « À ce jour ».
    //
    // `end: one` est le defaut de cette branche (une date isolee borne les deux
    // cotes), mais une mission en cours n'a pas de fin : on aligne sur la
    // branche `range` plus haut, qui met deja end a null dans ce cas. Sans ca
    // « Mars 2019 - Poste actuel » (24 caracteres, donc traite ici) ressortait
    // current=true ET end=2019-03, soit une mission a la fois en cours et finie.
    if (one) {
      const enCours = EN_COURS.test(deaccent(alone));
      return { start: one, end: enCours ? null : one, current: enCours, matched: alone };
    }
  }

  return null;
}

/**
 * « 2022-03 » -> un numero de mois absolu, comparable et soustractible.
 *
 * Une annee seule vaut JANVIER. Vivait en copie privee dans lib/extract.js
 * (monthIndex) ; remontee ici parce que c'est la convention dont sort
 * l'anciennete affichee, et qu'elle doit etre la MEME que celle de
 * cv-parser/periode_mission.py::index_mois — jeu d'essai partage
 * document-parsing/fixtures/date_mission.json, bloc `durees` (#177 ligne 9).
 *
 * A ne pas confondre avec monthsBetween plus bas, qui fait terminer une annee
 * seule en DECEMBRE : celui-la sert `duration_months`, une duree affichee par
 * mission, pas le cumul d'anciennete.
 */
function indexMois(iso) {
  const [y, m] = String(iso).split("-").map(Number);
  return y * 12 + (m || 1);
}

/** Longueur d'une periode en mois, BORNES INCLUSES (janvier -> decembre = 12). */
function dureeMois(debut, fin) {
  return Math.max(0, indexMois(fin) - indexMois(debut) + 1);
}

/** Nombre de mois entre deux dates ISO partielles. */
function monthsBetween(start, end, current) {
  if (!start) return null;
  const [sy, sm] = start.split("-").map(Number);
  const e = current || !end ? isoNow() : end;
  const [ey, em] = e.split("-").map(Number);
  const n = (ey - sy) * 12 + ((em || 12) - (sm || 1)) + 1;
  return n > 0 ? n : null;
}

function isoNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** « Avr 2025 — Juil 2026 » -> « 04/2025 – 07/2026 » pour l'affichage. */
function formatPeriod(start, end, current) {
  const fr = (v) => {
    if (!v) return "";
    const [y, m] = v.split("-");
    return m ? `${m}/${y}` : y;
  };
  if (!start) return "";
  if (current) return `depuis ${fr(start)}`;
  if (!end || end === start) return fr(start);
  return `${fr(start)} – ${fr(end)}`;
}

// ------------------------------------------------------------- Contact ----

const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_TEL = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?){2,5}\d{2,4}/;
const RE_LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,;|)]+/i;
const RE_GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s,;|)]+/i;

/** Telephone -> E.164 francais quand c'est possible, sinon forme compactee. */
function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (/^\+/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return "+33" + digits.slice(1);
  if (/^33\d{9}$/.test(digits)) return "+" + digits;
  return digits.length >= 8 ? digits : "";
}

/** Affichage lisible : +33 6 40 11 58 66. */
function formatPhone(e164) {
  if (!e164) return "";
  const m = String(e164).match(/^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? `+33 ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}` : e164;
}

function findEmail(text) {
  const m = String(text || "").match(RE_EMAIL);
  return m ? m[0].replace(/[.,;]$/, "") : "";
}

function findPhone(text) {
  // On isole d'abord les segments plausibles pour eviter de capturer une date
  // ou un montant (« 619M », « 2019 - 2020 »).
  const candidates = String(text || "").match(new RegExp(RE_TEL.source, "g")) || [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    if (/^(19|20)\d{2}$/.test(digits)) continue;
    const n = normalizePhone(c);
    if (n) return n;
  }
  return "";
}

function findUrl(text, re) {
  const m = String(text || "").match(re);
  return m ? m[0].replace(/[.,;)]$/, "") : "";
}

// ------------------------------------------------------------- Langues ----

// « natif » manquait la ou « native » etait deja reconnu : c'est pourtant la
// forme qu'un CV francais emploie, et celle que DocIE renvoie sur le CV
// d'exemple du depot (document-parsing/fixtures/cv_samples/results/simple_docie.json,
// languages[0].level = "natif"). Un locuteur natif ressortait donc sans niveau
// du tout — ni ici ni dans lib/docie-extract.js, qui appelle cette meme
// fonction —, alors que « langue maternelle » donnait bien C2 : deux facons
// d'ecrire la meme chose, deux fiches differentes pour le meme candidat.
// Meme question, et donc meme table, que cv-parser/niveau_langue.py : « quel
// niveau CECRL ce libelle annonce-t-il ? ». cv-parser ne normalisait RIEN — il
// stockait le libelle verbatim (#177 ligne 11), troisieme divergence de la
// famille « texte libre que les deux services doivent classer » apres
// mission_en_cours.json et date_mission.json. Le jeu d'essai partage
// document-parsing/fixtures/niveau_langue.json porte la table ET les cas ; un
// test verifie l'egalite des deux, donc ajouter un libelle d'un seul cote casse
// le test de l'autre service.
//
// L'ORDRE fait partie du contrat : le premier motif qui reconnait gagne, on
// s'arrete la. C'est ce qui fait valoir B1 — et non A2 — a « niveau scolaire
// solide ».
const NIVEAUX = [
  [/\b(c2|bilingue|langue\s+maternelle|maternelle|nati[fv]e?s?|courant\s*\/?\s*bilingue)\b/i, "C2"],
  [/\b(c1|courant|fluent|avance|professionnel\s+complet|full\s+professional)\b/i, "C1"],
  [/\b(b2|intermediaire\s+avance|professionnel|upper[\s-]intermediate|bon\s+niveau)\b/i, "B2"],
  [/\b(b1|intermediaire|intermediate|niveau\s+scolaire\s+solide)\b/i, "B1"],
  [/\b(a2|elementaire|elementary|scolaire)\b/i, "A2"],
  [/\b(a1|debutant|notions?|beginner)\b/i, "A1"],
];

// Baremes des tests de langue, en table plutot qu'en cascade de ternaires :
// c'est la forme que le jeu d'essai partage porte (champ `bareme`) et que le
// port Python lit, donc celle qu'un test peut comparer. Paliers du plus haut au
// plus bas ; sous le dernier palier, `defaut`.
const BAREMES = [
  { motif: /toeic\D{0,8}(\d{3,4})/i, paliers: [[945, "C1"], [785, "B2"], [550, "B1"]], defaut: "A2" },
  { motif: /toefl\D{0,8}(\d{2,3})/i, paliers: [[95, "C1"], [72, "B2"]], defaut: "B1" },
  { motif: /tcf\D{0,8}(\d{3})/i, paliers: [[600, "C1"], [500, "B2"], [400, "B1"]], defaut: "A2" },
];

const ORDRE_CECRL = ["A1", "A2", "B1", "B2", "C1", "C2"];

/** Deduit un niveau CECRL d'un libelle libre, en tenant compte des scores de tests. */
function languageLevel(text) {
  const s = deaccent(text || "");
  const levels = [];

  for (const { motif, paliers, defaut } of BAREMES) {
    const m = s.match(motif);
    if (!m) continue;
    const v = Number(m[1]);
    levels.push((paliers.find(([seuil]) => v >= seuil) || [0, defaut])[1]);
  }
  for (const [re, lvl] of NIVEAUX) {
    if (re.test(s)) { levels.push(lvl); break; }
  }

  // Un candidat qui ecrit « courant » ET « TOEIC 880 » ne doit pas etre
  // deprecie par le bareme du test : on retient le niveau le plus favorable.
  return levels.length
    ? levels.sort((a, b) => ORDRE_CECRL.indexOf(b) - ORDRE_CECRL.indexOf(a))[0]
    : null;
}

// --------------------------------------------------------------- Texte ----

/** Coupe proprement a la limite d'un mot, sans jamais laisser de « … » orphelin. */
function trimTo(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf(" ");
  return (i > max * 0.6 ? cut.slice(0, i) : cut).replace(/[\s,;:.-]+$/, "");
}

/** Majuscule initiale, sans toucher aux sigles. */
function sentenceCase(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t[0].toUpperCase() + t.slice(1);
}

/** « MAMADOU DIALLO » -> « Mamadou DIALLO » (on garde le nom en capitales). */
function properName(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .map((w, i, arr) => {
      if (w.length <= 1) return w.toUpperCase();
      // Convention francaise repandue : prenom capitalise, nom en majuscules.
      const isLast = i === arr.length - 1;
      if (isLast && arr.length > 1) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Trigramme ADBI : initiale du prenom + deux premieres lettres du nom
 * (Mamadou DIALLO -> MDI). C'est la convention du livret de CV, ou l'en-tete
 * s'ecrit « MDI : Data engineer ».
 * Sur un nom d'un seul mot, on prend ses trois premieres lettres.
 */
function trigram(fullName) {
  const mots = deaccent(String(fullName || ""))
    .replace(/[^A-Za-z\s'’-]/g, " ")
    .split(/[\s'’-]+/)
    .filter((w) => w.length > 1);
  if (!mots.length) return "";
  if (mots.length === 1) return mots[0].slice(0, 3).toUpperCase();
  const prenom = mots[0];
  const nom = mots[mots.length - 1];
  return (prenom[0] + nom.slice(0, 2)).toUpperCase();
}

function initials(fullName) {
  return String(fullName || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join(".") + (fullName ? "." : "");
}

module.exports = {
  parseMonthYear, parsePeriod, monthsBetween, formatPeriod, isoNow,
  indexMois, dureeMois,
  findEmail, findPhone, findUrl, normalizePhone, formatPhone,
  RE_LINKEDIN, RE_GITHUB, RE_EMAIL,
  languageLevel, deaccent, trimTo, sentenceCase, properName, initials, trigram,
  // Exposes pour les tests d'egalite avec les jeux d'essai partages (#177).
  MOTIF_MISSION_EN_COURS: EN_COURS,
  MOIS,
  NIVEAUX,
  BAREMES,
  ORDRE_CECRL,
};
