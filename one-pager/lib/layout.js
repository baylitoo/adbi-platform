/**
 * Segmentation : decoupe les lignes positionnees en SECTIONS typees
 * (profil, experience, formation, competences...).
 *
 * La detection repose sur des signaux de mise en forme (gras, corps de police,
 * majuscules, ligne isolee) croises avec un lexique FR/EN. Aucun CV ne respecte
 * la meme nomenclature : le lexique est volontairement large, et une section
 * non reconnue n'est jamais jetee — elle devient « unknown » et reste
 * disponible pour l'extraction.
 */

// Lexique des intitules de section. L'ordre compte : le premier motif qui
// correspond gagne, donc les libelles les plus specifiques d'abord.
const LEXICON = [
  ["experience", /^(experiences?|parcours|parcours\s+professionnel|experiences?\s+professionnelles?|vie\s+professionnelle|missions?|realisations?\s+professionnelles?|work\s+experience|professional\s+experience|employment)\b/i],
  ["education", /^(formations?|diplomes?|diplomes?\s+et\s+formations?|formations?\s+et\s+diplomes?|education|cursus|etudes|scolarite|academic)\b/i],
  ["certifications", /^(certifications?|certifications?\s*\/?\s*formations?|habilitations?|accreditations?|certificats?)\b/i],
  ["skills", /^(competences?|competences?\s+(techniques?|cles|fonctionnelles?|metiers?)|domaines?\s+de\s+competences?|expertises?|savoir[\s-]faire|skills|technical\s+skills|core\s+competencies|atouts|qualifications)\b/i],
  // « Environnement technique » et « Stack » sont volontairement absents : ce
  // sont des etiquettes INTERNES a une mission, pas des titres de section.
  // Les promouvoir coupait le parcours en plein milieu des missions.
  ["tech", /^(technologies?|outils?|logiciels?|informatique|maitrises?\s+techniques?|tools)\b/i],
  ["languages", /^(langues?|languages?|langues?\s+etrangeres?)\b/i],
  ["projects", /^(projets?|projets?\s+(personnels?|significatifs?|majeurs?)|realisations?|portfolio|projects?)\b/i],
  ["profile", /^(profil|resume|a\s+propos|presentation|synthese|accroche|objectif|summary|about|profile|professional\s+summary)\b/i],
  ["interests", /^(centres?\s+d.?interets?|loisirs?|hobbies|interests?|divers|autres|extra[\s-]professionnel)\b/i],
  ["contact", /^(contacts?|coordonnees|informations?\s+personnelles?|etat\s+civil)\b/i],
  ["sectors", /^(secteurs?|secteurs?\s+d.?activites?|domaines?\s+d.?intervention|industries)\b/i],
];

/** Supprime accents et ponctuation decorative pour comparer les intitules. */
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[:•▪◦●·|—–_>»«]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchLexicon(text) {
  const n = norm(text);
  if (!n || n.length > 60) return null;
  for (const [type, re] of LEXICON) if (re.test(n)) return type;
  return null;
}

/**
 * Une ligne est-elle un titre de section ?
 * On exige un intitule reconnu ET au moins un signal de mise en forme, ou
 * plusieurs signaux forts en l'absence d'intitule connu.
 */
function headingScore(line, stats) {
  let score = 0;
  const t = line.text;
  if (line.bold) score += 2;
  if (line.size >= stats.bodySize * 1.15) score += 2;
  if (line.size >= stats.bodySize * 1.4) score += 1;
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length >= 3 && letters === letters.toUpperCase()) score += 2;
  if (t.length <= 35) score += 1;
  if (/[.;]$/.test(t)) score -= 2; // une phrase ponctuee n'est pas un titre
  if (t.length > 70) score -= 3;
  return score;
}

/** Corps de police dominant : la taille la plus frequente, ponderee par le texte. */
function pageStats(pages) {
  const weight = new Map();
  for (const p of pages) {
    for (const l of p.lines) {
      weight.set(l.size, (weight.get(l.size) || 0) + l.text.length);
    }
  }
  let bodySize = 10;
  let max = 0;
  for (const [size, w] of weight) if (w > max) { max = w; bodySize = size; }
  return { bodySize };
}

/**
 * Decoupe en sections. La barre laterale est traitee comme un flux distinct :
 * ses titres ne doivent pas interrompre les sections du corps de page.
 */
function segment(doc) {
  const stats = pageStats(doc.pages);
  const streams = { body: [], sidebar: [] };

  for (const page of doc.pages) {
    for (const line of page.lines) {
      streams[line.sidebar ? "sidebar" : "body"].push({ ...line, page: page.number });
    }
  }

  const sections = [];
  for (const [stream, lines] of Object.entries(streams)) {
    if (!lines.length) continue;
    sections.push(...cutStream(lines, stats, stream === "sidebar"));
  }

  // Les sections de meme type sont fusionnees : certains CV repetent
  // « Competences » a trois endroits differents (cas reel).
  const merged = [];
  for (const s of sections) {
    const twin = s.type !== "unknown" && merged.find((m) => m.type === s.type && m.sidebar === s.sidebar);
    if (twin) twin.lines.push(...s.lines);
    else merged.push(s);
  }

  return { sections: merged, stats, headerLines: headerOf(doc) };
}

function cutStream(lines, stats, sidebar) {
  const sections = [];
  let current = { type: "header", label: null, sidebar, lines: [] };

  for (const line of lines) {
    const lex = matchLexicon(line.text);
    const score = headingScore(line, stats);
    // Intitule connu + un minimum de mise en forme, ou mise en forme tres marquee.
    const isHeading = (lex && score >= 3) || (!lex && score >= 6 && line.text.length <= 35);

    if (isHeading) {
      if (current.lines.length) sections.push(current);
      // On conserve la ligne de titre elle-meme : sur les CV sans rubrique
      // « Expériences », ce sont les noms d'employeurs qui font office de
      // titres, et les perdre reviendrait a perdre le debut de chaque mission.
      current = { type: lex || "unknown", label: line.text, labelLine: line, sidebar, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);
  return sections;
}

/**
 * Les premieres lignes de la page 1 : identite, titre, coordonnees.
 * On prend le haut de CHAQUE colonne : sur un CV a barre laterale, le nom est
 * dans la colonne principale mais les coordonnees dans la laterale.
 */
function headerOf(doc) {
  const page = doc.pages[0];
  if (!page) return [];
  const cols = page.columns && page.columns.length ? page.columns : [{ lines: page.lines, isSidebar: false }];
  return cols.flatMap((c) =>
    c.lines.slice(0, c.isSidebar ? 8 : 12).map((l, i) => ({ ...l, rank: i, sidebar: !!c.isSidebar }))
  );
}

module.exports = { segment, matchLexicon, norm, pageStats };
