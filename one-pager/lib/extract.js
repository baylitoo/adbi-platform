/**
 * Extraction : transforme les sections typees en objet « cv_master ».
 *
 * Principe : extraction SANS PERTE. On ne jette rien a ce stade, on structure.
 * La reduction pour tenir sur une page est un traitement separe (lib/onepager).
 * Tout champ dont on n'est pas sur est laisse vide et signale dans
 * quality.needs_review, jamais devine.
 */

const N = require("./normalize");
const taxo = require("./taxonomy");
const { matchLexicon } = require("./layout");

// Intitules de poste les plus frequents dans les CV IT francais.
const RE_ROLE = new RegExp(
  "\\b(chef+?e?\\s+de\\s+projet|cheffe?\\s+de\\s+projet|directeur|directrice|responsable|manager|manageur|consultant|consultante|architecte|ingenieur|ingenieure|developpeur|developpeuse|lead|tech\\s+lead|team\\s+lead|expert|experte|analyste|administrateur|technicien|product\\s+owner|product\\s+manager|scrum\\s+master|coach\\s+agile|data\\s+(?:scientist|engineer|analyst)|devops|sre|business\\s+analyst|amoa|moa|moe|pmo|stage|stagiaire|alternance|alternant|apprenti|freelance|alternante|charge\\s+de|chargee\\s+de|assistant|assistante|coordinateur|coordinatrice|superviseur|gestionnaire|auditeur|formateur|referent|referente|animateur|animatrice)\\b",
  "i"
);

// Intitules de POSTE uniquement — sans les types de contrat, qui ne disent
// rien de la fonction et faussent le partage entre titre et employeur.
const RE_POSTE = /\b(chef+?e?\s+de\s+projet|cheffe?\s+de\s+projet|directeur|directrice|responsable|manager|consultant|consultante|architecte|ing[ée]nieur|ing[ée]nieure|d[ée]veloppeur|d[ée]veloppeuse|developer|lead|tech\s+lead|team\s+lead|expert|experte|analyste|administrateur|technicien|product\s+owner|product\s+manager|scrum\s+master|coach\s+agile|data\s+(?:scientist|engineer|analyst)|devops|sre|business\s+analyst|amoa|moa|moe|pmo|charg[ée]\s+de|assistant|assistante|coordinateur|coordinatrice|superviseur|gestionnaire|auditeur|formateur|r[ée]f[ée]rent)\b/i;

/**
 * Un intitule de poste contient-il un metier reconnu ?
 *
 * Le test se fait sur la forme SANS ACCENT : les motifs sont ecrits en ASCII,
 * et « Développeur » ou « Ingénieur » — la graphie normale en francais — leur
 * echappaient. Des missions entieres passaient ainsi inapercues.
 */
function estRole(texte) {
  return RE_ROLE.test(N.deaccent(String(texte || "")));
}

const RE_CLIENT_LINE = /^(client|clients|employeur|entreprise|societe|soci[ée]t[ée]|mission|contexte\s*client|chez|pour)\s*[:\-–]/i;
// Le deux-points est facultatif : beaucoup de CV posent « Environnement
// technique » seul sur sa ligne et listent la stack sur la ligne suivante.
const RE_TECH_LINE = /^(environnements?(\s+(technique|technologique)s?)?|stack(\s+(technique|technologique))?|technologies?(\s+utilis[ée]es?)?|outils?(\s+(et|&)\s*technologies?)?|techno)\s*(?:[:\-–]|$)/i;
const RE_BULLET = /^\s*[•▪◦●○·\-–—*✓✔»›→]\s*/;

const CONTRATS = [
  [/\bfreelance|independant|portage\b/i, "freelance"],
  [/\bstage|stagiaire\b/i, "stage"],
  [/\balternance|alternant|apprenti/i, "alternance"],
  [/\bcdd\b/i, "cdd"],
  [/\bcdi\b/i, "cdi"],
  [/\bmission|prestation|regie\b/i, "mission"],
];

function deacc(s) { return N.deaccent(String(s || "")).toLowerCase(); }

// Mots qui trahissent un en-tete de societe, de contrat ou de plaquette —
// jamais un patronyme.
const RE_PAS_UN_NOM = /\b(adbi|sarl|sas|sasu|eurl|sa|societe|company|cv|curriculum|vitae|propos|france|paris|monsieur|madame|conditions|entre|service|contrat|devis|facture|client|projet|profil|resume|competences?|experiences?|formation|contact|telephone|email|page|confidentiel|presentation|expert|consultant|ingenieur|developpeur|manager|directeur|responsable|analyste|architecte|chef|domaines?|expertises?|cles?|langues?|outils?|centres?|interets?)\b/i;

/**
 * Le libelle est-il un vrai « Prénom NOM » ?
 *
 * On rejette durement plutot que de deviner : un nom faux sur un dossier
 * commercial est pire qu'un champ vide, que l'utilisateur corrige en deux
 * secondes a l'ecran de validation.
 */
function estNomPlausible(texte) {
  const t = String(texte || "").trim();
  if (t.length < 4 || t.length > 40) return false;
  // Chiffres et ponctuation de structure : ce n'est plus un nom.
  if (/[0-9@/\\()[\]:;,|%°&+*=<>_"«»]/.test(t)) return false;
  if (RE_PAS_UN_NOM.test(N.deaccent(t))) return false;

  const mots = t.split(/\s+/);
  if (mots.length < 2 || mots.length > 4) return false;

  // Particules nobiliaires : « DE BARROS », « van der Berg », « Da Silva ».
  const PARTICULE = /^(de|du|des|la|le|van|von|der|den|da|di|do|dos|el|al|ben|bin|ould|mac|mc|o)$/i;

  for (const m of mots) {
    if (PARTICULE.test(m)) continue;
    // Chaque mot est capitalise ou entierement en capitales ; une initiale
    // seule (« Ilyas E. ») reste admise.
    if (!/^[A-ZÀ-Ý][a-zà-ÿ'’-]*$|^[A-ZÀ-Ý'’-]{2,}$|^[A-ZÀ-Ý]\.$/.test(m)) return false;
  }
  // Une suite de particules n'est pas un nom.
  if (mots.every((m) => PARTICULE.test(m))) return false;
  // La moindre technologie reconnue trahit une ligne de competences
  // (« Data Visualisation Power BI »), pas un patronyme.
  return taxo.detect(t).length === 0;
}

/** Retire la decoration de mise en page qui colle aux titres. */
function nettoyerTitre(t) {
  return String(t || "")
    .replace(/[-–—_•|]{2,}/g, " ")
    // Suffixes parasites : « [ 7 ans d'expérience ] », « (H/F) ».
    .replace(/[[(]\s*\d+\s*ans?[^)\]]*[\])]/gi, " ")
    .replace(/\(\s*h\s*\/\s*f\s*\)/gi, " ")
    .replace(/^[\s:–—-]+|[\s:–—|-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Un titre professionnel n'est ni une phrase, ni un fragment de paragraphe. */
function estTitrePlausible(texte) {
  const t = String(texte || "").trim();
  if (t.length < 4 || t.length > 90) return false;
  if (/^[a-zà-ÿ]/.test(t)) return false;          // fragment de phrase
  if (/[,;]\s*$/.test(t)) return false;            // phrase coupee
  // On compte les mots reels : les separateurs « | » et « / » d'un titre
  // compose (« Chef de projet | Expert Santé / Banque ») ne sont pas des mots.
  if ((t.match(/[A-Za-zÀ-ÿ]{2,}/g) || []).length > 14) return false;
  if (/\b(je |nous |mon |ma |mes |notre |afin de|qui |que |dont )/i.test(t)) return false;
  if (/^\d+\s*ans?\b/i.test(t)) return false;      // « 6 ans d'expérience »
  if (/^(n°|ref|tel|fax|siret|tva)\b/i.test(t)) return false;
  if (/\.\s+[A-ZÀ-Ý]/.test(t)) return false;        // deux phrases enchainees
  if (/\b(et de|de la|de l['’]|afin|capable|permet)\b/i.test(t)) return false;
  // Un intitule de section (« COMPETENCES », « PROFIL ») n'est pas un titre.
  if (matchLexicon(t)) return false;
  return /[A-Za-zÀ-ÿ]{3}/.test(t);
}

// ============================================================== IDENTITE ===

function extractIdentity(doc, seg, fullText) {
  const header = seg.headerLines;
  const stats = seg.stats;

  // Le nom est la ligne la plus mise en avant du haut de page qui ressemble a
  // un patronyme : 2 a 4 mots, pas de chiffre, pas de mot-cle de section.
  // Cas particulier : le document est deja anonymise au format ADBI. L'en-tete
  // s'ecrit « ALO : Developpeur IA », ou bien « ALO » puis le titre en dessous.
  // Il n'y a alors aucun nom a chercher : le trigramme est donne tel quel.
  const tete = header.slice(0, 6);
  for (let i = 0; i < tete.length; i++) {
    const t = tete[i].text.trim();
    const surUneLigne = t.match(/^([A-ZÀ-Ý]{2,4})\s*:\s*(\S.{3,90})$/);
    const seul = /^[A-ZÀ-Ý]{2,4}$/.test(t) ? t : null;
    if (/^(RE|TEL|FAX|MAIL|WEB|NB|CV|SIRET|TVA)$/i.test(surUneLigne ? surUneLigne[1] : seul || "")) continue;

    if (surUneLigne && estTitrePlausible(surUneLigne[2])) {
      return { full_name: "", initials: "", trigram: surUneLigne[1], title: nettoyerTitre(surUneLigne[2]), from_trigram: true };
    }
    if (seul && (tete[i].bold || i <= 1)) {
      // Le titre peut etre coupe sur deux lignes, ou absent : on prend le
      // premier libelle credible parmi les suivants. Un trigramme mis en
      // evidence en tete de page reste un trigramme meme sans titre — celui-ci
      // sera deduit de la mission la plus recente.
      const candidats = [
        tete[i + 1] && tete[i + 1].text,
        tete[i + 1] && tete[i + 2] && tete[i + 1].text + " " + tete[i + 2].text,
        tete[i + 2] && tete[i + 2].text,
      ];
      const titre = candidats.map(nettoyerTitre).find(estTitrePlausible) || "";
      return { full_name: "", initials: "", trigram: seul, title: N.trimTo(titre, 90), from_trigram: true };
    }
  }

  let name = "";
  let nameLine = -1;
  let bestScore = -1;
  header.forEach((l, i) => {
    const brut = l.text.replace(/^[^A-Za-zÀ-ÿ]+/, "").trim();
    // « BOUKARMA Abderraouf | Data Engineer », « Nom — Titre » : le nom et le
    // titre partagent souvent une ligne. On teste chaque segment.
    const t = [brut, ...brut.split(/\s*[|–—]\s*/)].find(estNomPlausible) || brut;
    const words = t.split(/\s+/);
    if (!estNomPlausible(t)) return;
    if (estRole(t)) return;
    // Un nom est toujours mis en avant : plus gros que le corps de texte, ou
    // en gras, ou tout en haut. Sans ce garde-fou, une ligne de tableau au
    // libelle capitalise passe pour un patronyme.
    if (!(l.bold || l.size >= stats.bodySize * 1.1 || (l.rank ?? i) <= 1)) return;
    // Mots outils qui trahissent une phrase. « de », « du », « la »... en sont
    // volontairement absents : ce sont des particules de patronyme
    // (« ADRIEN DE BARROS »), deja encadrees par estNomPlausible.
    if (/\b(ou|et|en|sur|avec|pour|permis|adresse|mobilit)\b/i.test(t)) return;
    let score = l.size / stats.bodySize;
    if (l.bold) score += 0.4;
    if ((l.rank ?? i) < 3) score += 0.5;
    if (l.sidebar) score -= 0.8; // le nom est rarement dans la barre laterale
    // Convention francaise : au moins un mot entierement en capitales.
    if (words.some((w) => w.length > 1 && w === w.toUpperCase())) score += 0.6;
    if (score > bestScore) { bestScore = score; name = t; nameLine = i; }
  });

  // Le titre professionnel suit generalement le nom, dans la meme colonne.
  // Sans nom trouve, on balaye tout l'en-tete plutot que de renoncer : le CV
  // peut etre anonymise, ou son patronyme illisible.
  let title = "";
  const debut = nameLine >= 0 ? nameLine + 1 : 0;
  const fin = nameLine >= 0 ? Math.min(header.length, nameLine + 5) : header.length;
  for (let i = debut; i < fin; i++) {
    const h = header[i];
    if (!h) continue;
    if (nameLine >= 0 && h.sidebar !== header[nameLine].sidebar) continue;
    const t = h.text;
    if (!t || !estTitrePlausible(t)) continue;
    if (N.findEmail(t) || N.findPhone(t)) continue;
    if (estRole(t) || /\b(expert|senior|s[ée]nior|junior|confirm[ée])\b/i.test(t)) { title = nettoyerTitre(t); break; }
  }

  // Second passage, sans exiger de mot-cle de poste : beaucoup de CV titrent
  // « Talend / SQL / Administration BDD » ou « Big Data & Cloud ».
  if (!title) {
    for (let i = debut; i < fin; i++) {
      const h = header[i];
      if (!h || !estTitrePlausible(h.text)) continue;
      if (N.findEmail(h.text) || N.findPhone(h.text) || estNomPlausible(h.text)) continue;
      if (h.text.length < 8) continue;
      title = nettoyerTitre(h.text);
      break;
    }
  }

  return {
    full_name: name ? N.properName(name) : "",
    initials: name ? N.initials(name) : "",
    trigram: name ? N.trigram(name) : "",
    title: title.replace(/\s*[|•]\s*$/, "").trim(),
  };
}

function extractContact(doc, seg, fullText) {
  // Les coordonnees sont cherchees dans tout le document : elles se logent
  // aussi bien en tete qu'en barre laterale ou en pied de page.
  const email = N.findEmail(fullText);
  const phone = N.findPhone(fullText);
  const linkedin = N.findUrl(fullText, N.RE_LINKEDIN);
  const github = N.findUrl(fullText, N.RE_GITHUB);

  const cp = fullText.match(/\b(\d{5})\b\s*[,\-–]?\s*([A-ZÀ-Ý][\wÀ-ÿ'’\- ]{2,30})?/);
  const villeAvantCp = fullText.match(/([A-ZÀ-Ý][\wÀ-ÿ'’\- ]{2,30})\s*[-–,]\s*(\d{5})\b/);

  let city = "";
  if (villeAvantCp) city = villeAvantCp[1].trim();
  else if (cp && cp[2]) city = cp[2].trim();

  const region = (fullText.match(/\b(Ile[\s-]de[\s-]France|Île[\s-]de[\s-]France|Auvergne[\w\s-]*|Nouvelle[\s-]Aquitaine|Occitanie|Bretagne|Normandie|Grand[\s-]Est|Hauts[\s-]de[\s-]France|PACA|Provence[\w\s-]*|Pays de la Loire|Centre[\s-]Val[\s-]de[\s-]Loire|Bourgogne[\w\s-]*)\b/i) || [])[0] || "";

  let work_mode = "";
  if (/\b(100\s*%\s*remote|full\s*remote|t[ée]l[ée]travail\s+total)\b/i.test(fullText)) work_mode = "remote";
  else if (/\b(hybrid|hybride|t[ée]l[ée]travail\s+(?:partiel|ou)|\d\s*jours?\s+(?:de\s+)?t[ée]l[ée]travail)\b/i.test(fullText)) work_mode = "hybrid";
  else if (/\b(pr[ée]sentiel|sur\s*site|on\s*site)\b/i.test(fullText)) work_mode = "onsite";

  const dispo = fullText.match(/\b(ouvert\s+aux\s+opportunit[ée]s|disponible\s+[^.|\n]{0,40}|disponibilit[ée]\s*:\s*[^.|\n]{0,40}|imm[ée]diatement\s+disponible)/i);

  return {
    email,
    phone,
    phone_display: N.formatPhone(phone),
    linkedin,
    github,
    location: { city, region, country: /\bfrance\b/i.test(fullText) || region ? "France" : "" },
    mobility: region || city,
    work_mode,
    availability: dispo ? dispo[0].trim() : "",
    driving_license: /\bpermis\s+(?:de\s+conduire|b)\b/i.test(fullText),
  };
}

// =============================================================== PROFIL ====

function extractSummary(seg) {
  let sec = seg.sections.find((s) => s.type === "profile");
  // Beaucoup de CV placent l'accroche sans titre, juste avant les experiences.
  if (!sec) {
    const idx = seg.sections.findIndex((s) => s.type === "experience");
    const cand = seg.sections.slice(0, idx === -1 ? 2 : idx).filter((s) => !s.sidebar && ["unknown", "header"].includes(s.type));
    sec = cand.sort((a, b) => textOf(b).length - textOf(a).length)[0];
  }
  if (!sec) return { raw: "", condensed: "" };

  const raw = textOf(sec)
    .replace(/^[«"'\s]+|[»"'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Une accroche fait rarement plus de 700 caracteres : au-dela, on a capture
  // autre chose (souvent le debut des experiences).
  return { raw: raw.slice(0, 900), condensed: "" };
}

function textOf(section) {
  return (section.lines || []).map((l) => l.text).join(" ");
}

// ========================================================== EXPERIENCES ====

/**
 * Decoupe la section « experience » en missions.
 *
 * Une mission commence par un BLOC D'EN-TETE : une suite de lignes non
 * indentees contenant l'intitule de poste, l'employeur/client et la periode.
 * Les lignes indentees (ou prefixees d'une puce) qui suivent sont les
 * realisations.
 */
// Sections qui ne contiennent jamais de mission : elles sont exclues du repli.
const HORS_PARCOURS = ["skills", "certifications", "languages", "interests", "contact", "sectors", "profile"];

function extractExperiences(seg) {
  const sec = seg.sections.find((s) => s.type === "experience" && !s.sidebar)
    || seg.sections.find((s) => s.type === "experience");

  const parSection = sec && sec.lines.length ? decouperMissions(sec.lines) : [];

  // Le parcours complet, toutes rubriques confondues. Beaucoup de CV n'ont pas
  // de titre « Expériences » : les missions sont rangees sous « Projets », ou
  // n'ont aucun intitule. La ligne de titre de chaque section est reinjectee —
  // « Groupe Bouygues » n'est pas une rubrique mais le debut d'une mission.
  const lignes = seg.sections
    .filter((s) => !s.sidebar && !HORS_PARCOURS.includes(s.type))
    .flatMap((s) => (s.labelLine ? [s.labelLine, ...s.lines] : s.lines));

  const parBalayage = lignes.length
    ? decouperMissions(lignes).filter((e) => e.start_date && !estFormation(e))
    : [];

  // On tranche sur le RESULTAT, pas sur l'etiquette. Un sous-titre interne
  // comme « Missions et réalisations : » est type « experience » par le
  // lexique alors qu'il ne couvre qu'une seule mission : s'y fier ferait
  // perdre tout le reste du parcours. Le balayage complet ne l'emporte que
  // s'il apporte davantage, pour ne pas defaire un decoupage deja propre.
  return parBalayage.length > parSection.length ? parBalayage : parSection;
}

const RE_DIPLOME_LIGNE = /\b(master|licence|bachelor|dut|bts|but|doctorat|mba|msc|dess|deug|baccalaur[ée]at|dipl[ôo]me|pr[ée]pa)\b/i;

function estLigneFormation(t) {
  return RE_DIPLOME_LIGNE.test(N.deaccent(String(t || "")).replace(/[ée]/g, "e")) || RE_DIPLOME_LIGNE.test(String(t || ""));
}

/** Un diplome a une date et un etablissement, mais ni realisations ni stack. */
function estFormation(e) {
  const t = deacc(`${e.role} ${e.company} ${e.mission}`);
  if (!/\b(master|licence|bachelor|dut|bts|but|doctorat|mba|msc|dess|baccalaur|diplome|prepa|universite|faculte|ecole|lycee|formation|certification)\b/.test(t)) return false;
  return e.highlights.length === 0 && e.tech_stack.length === 0;
}

/**
 * Marge gauche du bloc, servant de reference pour mesurer les retraits.
 *
 * On prend le 5e centile plutot que le minimum : une seule ligne excentree —
 * une puce decorative, un filet, un element de mise en page — suffirait a
 * decaler la reference et a faire passer TOUS les intitules de mission pour du
 * texte indente. C'est ce qui reduisait certains CV a une seule experience.
 */
function margeGauche(lines) {
  const xs = lines.map((l) => l.x).sort((a, b) => a - b);
  return xs[Math.floor(xs.length * 0.05)] ?? xs[0];
}

function decouperMissions(lines) {
  if (!lines.length) return [];
  const baseX = margeGauche(lines);
  const colW = Math.max(...lines.map((l) => l.x + l.w)) - baseX;

  const marked = lines.map((l) => {
    const glyph = RE_BULLET.test(l.text);
    const indent = l.x - baseX;
    const texte = l.text.replace(RE_BULLET, "").trim();
    const periode = N.parsePeriod(l.text);
    // Une ligne reduite a sa periode (« De Septembre 2025 à ce jour ») est un
    // en-tete de mission, jamais du corps de texte — meme calee a droite,
    // comme le font les gabarits qui alignent l'employeur a gauche et les
    // dates a l'oppose. L'indentation ne doit donc pas la disqualifier.
    const periodeSeule = !!periode && periode.matched
      && periode.matched.length >= texte.length - 4 && texte.length <= 44;

    return {
      ...l,
      glyph,
      text: texte,
      indent,
      isDetail: !periodeSeule && (glyph || indent > 10),
      period: periode,
      periodeSeule,
      isClient: RE_CLIENT_LINE.test(l.text),
      isTech: RE_TECH_LINE.test(l.text),
      // Une ligne « pleine largeur » annonce presque toujours un retour a la
      // ligne automatique : la suivante en est la continuation.
      full: l.w >= colW * 0.8,
    };
  });

  // Une ligne d'ancrage est courte, non ponctuee en fin de phrase et non
  // indentee : « Pilotage MOA du portefeuille applicatif ... santé. » est une
  // phrase de contexte, pas un intitule de poste, malgre le mot « MOA ».
  // La ligne qui suit une etiquette « Environnement technique » seule porte la
  // liste des technologies : ce n'est jamais un intitule de mission.
  for (let k = 0; k < marked.length - 1; k++) {
    if (marked[k].isTech && !marked[k].text.replace(RE_TECH_LINE, "").trim()) marked[k + 1].isTechValue = true;
  }

  // Le gras n'est un indice que s'il DISTINGUE. Certains CV composent tout leur
  // corps de texte en gras : s'y fier ferait alors passer chaque phrase pour un
  // intitule de mission, et le decoupage s'effondre sur une seule entree.
  const partGras = marked.filter((m) => m.bold).length / marked.length;
  const grasSignifiant = partGras < 0.6;

  const isAnchor = (m) =>
    !m.isDetail && !m.isTech && !m.isTechValue && m.text.length <= 95 && !/[.;]$/.test(m.text) &&
    ((grasSignifiant && m.bold) || estRole(m.text) || !!m.period || m.isClient);

  const entries = [];
  let i = 0;
  let pending = null; // entree en cours, pour lui rattacher un corps orphelin

  while (i < marked.length) {
    // Ni un diplome ni un intitule de rubrique n'ouvrent une mission. Le
    // premier happerait l'employeur suivant ; le second — « Projets »,
    // « Expériences » — se retrouverait affiche comme un poste, puisque le
    // balayage complet reinjecte les lignes de titre de section.
    if (!isAnchor(marked[i]) || estLigneFormation(marked[i].text) || matchLexicon(marked[i].text)) {
      i++;
      continue;
    }

    // 1) bloc d'en-tete : les lignes d'ancrage consecutives.
    const start = i;
    const head = [];
    while (i < marked.length && isAnchor(marked[i]) && head.length < 5) {
      head.push(marked[i]);
      i++;
      // Un en-tete s'arrete des qu'on a vu a la fois un intitule et une periode.
      if (head.some((h) => h.period) && head.length >= 2 && i < marked.length && !marked[i].isClient && !marked[i].period) break;
    }

    // Un vrai debut de mission porte une periode OU une mise en forme de titre.
    // Sinon c'est un sous-titre interne : on le rend au corps de la mission
    // precedente plutot que de creer une entree fantome sans dates.
    if (!head.some((h) => h.period || (grasSignifiant && h.bold))) {
      if (pending) pending.body.push(...head);
      else i = start + 1;
      continue;
    }

    // 2) corps : tout jusqu'au prochain en-tete.
    const body = [];
    while (i < marked.length) {
      const m = marked[i];
      const gras = grasSignifiant && m.bold;
      if (isAnchor(m) && (gras || estRole(m.text)) && !m.isDetail && (gras || m.period)) break;
      body.push(m);
      i++;
    }
    pending = { head, body };
    entries.push(pending);
  }

  const built = entries.map((e) => buildExperience(e.head, e.body)).filter(Boolean);
  return finalize(built);
}

function finalize(entries) {
  // Une entree sans aucune date n'est pas une mission : c'est un sous-titre
  // interne que le decoupage a pris pour un debut. On rend ses realisations a
  // la mission precedente plutot que de laisser une ligne inexploitable.
  const merged = [];
  for (const e of entries) {
    const prev = merged[merged.length - 1];
    if (!e.start_date && prev) {
      prev.highlights.push(...e.highlights);
      prev.tech_stack = dedupe(prev.tech_stack.concat(e.tech_stack));
      if (!prev.context && e.context) prev.context = e.context;
      continue;
    }
    merged.push(e);
  }

  // Chronologie decroissante : c'est ce qu'attend un recruteur.
  merged.sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")));
  return merged.map((e, k) => ({ ...e, id: "exp_" + (k + 1) }));
}

function buildExperience(head, body) {
  const headText = head.map((h) => h.text).join(" | ");
  if (!headText.trim()) return null;

  const period = head.map((h) => h.period).find(Boolean) || body.map((b) => b.period).find(Boolean) || null;

  // Client final et intermediaire : « Client : Urssaf IDF (via DLA Conseil) »
  let end_client = "";
  let via = "";
  let company = "";
  let location = "";
  const clientLine = head.concat(body).find((l) => RE_CLIENT_LINE.test(l.text));
  if (clientLine) {
    let v = clientLine.text.replace(RE_CLIENT_LINE, "").trim();
    const viaM = v.match(/\(\s*(?:via|par l.interm[ée]diaire de|through)\s+([^)]+)\)/i);
    if (viaM) { via = viaM[1].trim(); v = v.replace(viaM[0], " "); }
    // La ligne « Client : » se termine souvent par la ville ou la region :
    // c'est une localisation, pas une partie du nom du client.
    const tail = v.match(/[\s\-–,]+([A-ZÀ-Ý][\wÀ-ÿ'’\- ]{2,28})$/);
    if (tail && isLocation(tail[1])) { location = tail[1].trim(); v = v.slice(0, tail.index); }
    end_client = cleanCompany(v);
  }

  // Intitule de poste : la premiere ligne d'en-tete, debarrassee de la periode.
  let roleLine = head.find((h) => estRole(h.text)) || head[0];
  let role = stripPeriod(roleLine.text, roleLine.period);

  // Intitule coupe par la mise en page : « ... déploiement du SI de » /
  // « Gestion de l'Opco Santé ». La suite appartient au titre, pas a l'employeur.
  const after = head[head.indexOf(roleLine) + 1];
  if (roleLine.full && after && !after.period && !after.isClient && !/[.;]$/.test(after.text)) {
    role += " " + after.text;
    after.consumed = true;
  }

  // Etiquette explicite « Rôle : », « Poste : » — le mot n'apporte rien au rendu.
  role = role.replace(/^\s*(r[ôo]les?|postes?|fonctions?|intitul[ée]s?)\s*[:\-–]\s*/i, "");
  // Deux-points orphelin laisse par le retrait de la periode (« Client : … »).
  role = role.replace(/^\s*[:\-–—]\s*/, "");

  let mission = "";
  // Style « Consultante AMOA_Fiabilisation de la DSN » : poste + intitule de mission.
  const us = role.match(/^([^_]{3,60})_(.+)$/);
  if (us) { role = us[1].trim(); mission = us[2].trim(); }
  role = role.replace(/\s*[|–—-]\s*$/, "").trim();

  // Employeur : la ligne d'en-tete restante, souvent « Societe | Ville | Dates ».
  for (const h of head) {
    if (h === roleLine || h.isClient || h.consumed) continue;
    const parts = stripPeriod(h.text, h.period).split(/\s*[|·•]\s*/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (!company) company = cleanCompany(parts[0]);
    const loc = parts.slice(1).find((p) => isLocation(p));
    if (loc && !location) location = loc;
  }
  if (!location) {
    const l = head.concat(body).map((x) => x.text).join(" | ").split(/\s*[|·•]\s*/).find(isLocation);
    if (l) location = l.trim();
  }
  // Beaucoup de CV posent le poste ET l'employeur sur la meme ligne
  // (« Tech lead data | Decathlon », « aLTRan | Team Manager »). Le gabarit
  // demande titre, puis client, puis dates : on separe les deux.
  if (!end_client && !company) {
    const parts = role.split(/\s*\|\s*|\s+[–—]\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      // On teste sur les intitules de POSTE seuls : « Freelance » ou « Stage »
      // sont des types de contrat, ils ne departagent rien
      // (« Tech lead data | Decathlon - Freelance »).
      const aRole = RE_POSTE.test(parts[0]);
      const bRole = RE_POSTE.test(parts[1]);
      // Le camp « client » ne doit pas etre un nom de technologie
      // (« Developer PHP | Symfony » : Symfony n'est pas un employeur).
      if (aRole && !bRole && !taxo.detect(parts[1]).length) { role = parts[0]; company = parts[1]; }
      else if (bRole && !aRole && !taxo.detect(parts[0]).length) { role = parts[1]; company = parts[0]; }
    }
  }

  if (!company && end_client) company = end_client;
  if (company && !end_client) end_client = company;

  // Realisations : puces explicites, lignes indentees, ou lignes de detail.
  const { context, highlights, tech } = splitBody(body);

  const contract = (CONTRATS.find(([re]) => re.test(headText + " " + context))?.[1]) || "";

  const start = period ? period.start : null;
  const end = period ? period.end : null;
  const current = period ? !!period.current : false;

  return {
    role: role || "",
    mission,
    company: company || "",
    end_client: end_client || "",
    via,
    contract_type: contract,
    location,
    start_date: start,
    end_date: end,
    is_current: current,
    duration_months: N.monthsBetween(start, end, current),
    context,
    highlights: highlights.map((t) => ({ text: t, has_metric: hasMetric(t), score: 0 })),
    tech_stack: tech,
    confidence: period && role ? 0.9 : role || period ? 0.6 : 0.35,
  };
}

/** Separe le corps d'une mission en contexte, realisations et ligne technique. */
function splitBody(body) {
  const context = [];
  const highlights = [];
  let tech = [];
  let prev = null;
  let techEnAttente = false; // « Environnement technique » sans sa liste

  for (const m of body) {
    const t = m.text.trim();
    if (!t) continue;

    if (m.isTech || RE_TECH_LINE.test(t)) {
      const reste = t.replace(RE_TECH_LINE, "").trim();
      if (reste) tech = tech.concat(splitList(reste));
      else techEnAttente = true; // la liste est sur la ligne suivante
      prev = null;
      continue;
    }

    if (techEnAttente) {
      tech = tech.concat(splitList(t));
      techEnAttente = false;
      prev = null;
      continue;
    }

    // Continuation d'une ligne pleine largeur. Une ligne pleine peut aussi
    // etre suivie d'une VRAIE nouvelle puce : on tranche sur des indices de
    // langue (minuscule initiale, parenthese fermante, mot de liaison final)
    // plutot que sur la seule geometrie, qui est ambigue ici.
    const isWrap = prev && prev.full && !m.glyph && continues(prev.text, t);
    const isNewBullet = !isWrap && (m.glyph || m.isDetail);

    if (isWrap) {
      if (prev.target === "hl" && highlights.length) highlights[highlights.length - 1] += " " + t;
      else if (context.length) context[context.length - 1] += " " + t;
      prev = { ...m, target: prev.target };
      continue;
    }

    if (isNewBullet) {
      highlights.push(t);
      prev = { ...m, target: "hl" };
    } else {
      context.push(t);
      prev = { ...m, target: "ctx" };
    }
  }

  return {
    context: context.join(" ").replace(/\s+/g, " ").trim(),
    highlights: highlights.map((h) => h.replace(/\s+/g, " ").trim()).filter((h) => h.length > 12),
    // L'etiquette elle-meme peut se retrouver collee a la liste quand la mise
    // en page la place en fin de ligne : on la retire des valeurs.
    tech: dedupe(
      tech
        .map((t) => t.replace(RE_TECH_LINE, "").replace(/\s*environnements?\s+techniques?\s*$/i, "").trim())
        .filter((t) => t.length > 1 && t.length < 45)
        .map((t) => taxo.canonical(t))
    ),
  };
}

/**
 * `suite` est-elle la fin de la phrase `debut`, coupee par la mise en page ?
 */
function continues(debut, suite) {
  const d = String(debut || "").trim();
  const s = String(suite || "").trim();
  if (!s) return false;
  if (/^[a-zà-ÿ)\],;]/.test(s)) return true;          // minuscule ou ponctuation fermante
  if (/\(/.test(d) && !/\)/.test(d.slice(d.lastIndexOf("(")))) return true; // parenthese restee ouverte
  if (/[,;:]$/.test(d)) return true;
  // Mot de liaison en fin de ligne : la phrase ne peut pas s'arreter la.
  if (/\b(de|des|du|d['’]|et|ou|la|le|les|un|une|aux?|en|sur|pour|par|dans|avec|via|entre|chez|vers|selon|dont|que|qui)$/i.test(d)) return true;
  return false;
}

function stripPeriod(text, period) {
  let t = String(text || "");
  if (period && period.matched) t = t.replace(period.matched, " ");
  return t
    .replace(/\s*[|·•]\s*/g, " | ")
    .replace(/\|\s*\|/g, "|")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    // Preposition orpheline laissee par le retrait de la periode : « D'août 2013 » -> « D' ».
    .replace(/^\s*(?:de|du|d['’]|from|depuis|since)\s*$/i, "")
    .replace(/^\s*(?:de|du|d['’]|depuis)\s+(?=[|,]|$)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompany(s) {
  return String(s || "")
    .replace(/^[-–—•\s]+|[-–—•\s]+$/g, "")
    .replace(/\s*\(\s*\)\s*/g, " ")
    // Tirets doubles laisses par le retrait de la periode : « SAFRAN – – Projet ».
    .replace(/\s*[-–—]\s*[-–—]\s*/g, " – ")
    .replace(/\s+/g, " ")
    .trim();
}

const VILLES = /\b(paris|lyon|marseille|toulouse|nice|nantes|montpellier|strasbourg|bordeaux|lille|rennes|reims|saint[\s-]etienne|toulon|grenoble|dijon|angers|nimes|villeurbanne|clermont|levallois|puteaux|boulogne|courbevoie|nanterre|issy|montreuil|neuilly|la\s+defense|ile[\s-]de[\s-]france|france|belgique|suisse|luxembourg|maroc|tunisie|remote|distanciel)\b/i;

function isLocation(s) {
  const t = String(s || "").trim();
  if (!t || t.length > 40) return false;
  if (N.parsePeriod(t)) return false;
  return VILLES.test(N.deaccent(t)) || /\b\d{5}\b/.test(t) || /\d{1,2}\s*[eè]me?\s+arrondissement/i.test(t);
}

function hasMetric(t) {
  return /\d+\s*(%|k€|m€|€|k\b|m\b|millions?|milliers?|jours?|mois|ans?|personnes?|collaborateurs?|utilisateurs?|patients?|clients?|équipes?|projets?|sites?|pays)/i.test(t)
    || /[+-]\s?\d+\s*%/.test(t)
    || /\b\d{2,}\s*(?:k|m)\b/i.test(t);
}

/**
 * Decoupe une enumeration. La barre oblique n'est un separateur que si elle est
 * entouree d'espaces : sinon on casserait « SAP S/4HANA », « CI/CD », « MOA/MOE ».
 */
function splitList(s) {
  return String(s || "")
    .split(/\s*[,;•·|]\s*|\s+\/\s+|\s+&\s+|\s+et\s+/i)
    .map((x) => x.replace(/^[-–—:\s]+|[.\s]+$/g, "").trim())
    .filter((x) => x.length > 1 && x.length < 45);
}

/** Annee isolee en fin de libelle : « ITIL v4 — Certifié | 2025 ». */
function trailingYear(text) {
  const m = String(text || "").match(/(?:^|[\s|(\-–—:])((?:19|20)\d{2})\s*[)\]]?\s*$/);
  return m ? { year: Number(m[1]), matched: m[0] } : null;
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = deacc(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ========================================== COMPETENCES / FORMATION / ... ==

/** « Cloud & DevOps : Azure, Docker, K8s » -> une categorie et ses items. */
function extractSkills(seg, fullText) {
  const secs = seg.sections.filter((s) => ["skills", "tech", "sectors"].includes(s.type));
  const groups = [];
  const orphans = [];

  for (const sec of secs) {
    const lines = mergeWrappedLines(sec.lines);
    if (!lines.length) continue;
    // Les items sans categorie heritent du titre de la section qui les porte
    // (« Logiciels », « Informatique »...), bien plus parlant qu'un fourre-tout.
    const loose = [];
    // Deux mises en page coexistent : « Categorie : a, b, c » sur une ligne, ou
    // une categorie non indentee suivie de ses items indentes (barre laterale).
    const baseX = Math.min(...lines.map((l) => l.x));
    let current = null;

    for (const l of lines) {
      const t = l.text;
      const m = t.match(/^([^:]{2,45})\s*:\s*(.+)$/);
      if (m && !N.findEmail(t)) {
        groups.push({ label: m[1].trim(), items: dedupe(splitList(m[2]).map(taxo.canonical)) });
        current = null;
        continue;
      }
      const isLabel = l.x <= baseX + 3 && t.length <= 45 && !/[,;]/.test(t);
      if (isLabel && lines.some((o) => o.x > baseX + 3)) {
        current = { label: t.replace(/\s*:$/, ""), items: [] };
        groups.push(current);
      } else if (current) {
        current.items.push(...splitList(t).map(taxo.canonical));
      } else {
        loose.push(...splitList(t).map(taxo.canonical));
      }
    }
    if (loose.length) groups.push({ label: sec.label || "Compétences", items: dedupe(loose) });
  }

  // Un groupe reste vide quand la « categorie » etait en fait un item isole.
  const cleaned = [];
  for (const g of groups) {
    if (g.items.length) cleaned.push({ ...g, items: dedupe(g.items) });
    else orphans.push(g.label);
  }
  if (orphans.length) cleaned.push({ label: "Autres compétences", items: dedupe(orphans.map(taxo.canonical)) });

  return cleaned.filter((g) => g.items.length);
}

/**
 * Recolle les lignes coupees par la mise en page d'une colonne etroite.
 * Renvoie des objets (texte + abscisse) : l'indentation reste necessaire en
 * aval pour distinguer une categorie de ses items.
 */
function mergeWrappedLines(lines) {
  const out = [];
  const colW = Math.max(...lines.map((l) => l.w), 1);
  lines.forEach((l, i) => {
    const t = l.text.replace(RE_BULLET, "").trim();
    if (!t) return;
    const prevFull = i > 0 && lines[i - 1].w >= colW * 0.86;
    const startsLower = /^[a-zà-ÿ(]/.test(t);
    if (out.length && prevFull && startsLower) out[out.length - 1].text += " " + t;
    else out.push({ text: t, x: l.x, bold: l.bold, size: l.size });
  });
  return out;
}

function mergeWrapped(lines) {
  return mergeWrappedLines(lines).map((l) => l.text);
}

function extractEducation(seg) {
  const sec = seg.sections.find((s) => s.type === "education");
  if (!sec) return { education: [], certifications: [] };

  const lines = mergeWrapped(sec.lines);
  const education = [];
  const certifications = [];

  const RE_DIPLOME = /\b(master|licence|bachelor|dut|bts|but|doctorat|ing[ée]nieur|mba|dess|deug|baccalaur|dipl[ôo]me|msc|prepa|classe\s+pr[ée]paratoire)\b/i;
  const RE_ETAB = /\b([ée]cole|universit|facult|institut|iut|cnam|lyc[ée]e|epitech|epita|esiea|efrei|insa|polytech|centrale|supinfo|hetic|ionis)\b/i;

  for (const t of lines) {
    if (t.length < 4) continue;
    const period = N.parsePeriod(t);
    const ty = trailingYear(t);
    const year = period ? Number(String(period.end || period.start).slice(0, 4)) : ty ? ty.year : null;
    let clean = t;
    if (period && period.matched) clean = clean.replace(period.matched, " ");
    else if (ty) clean = clean.replace(ty.matched, " ");
    clean = clean.replace(/^[\s|,–—-]+|[\s|,–—-]+$/g, "").replace(/\s+/g, " ").trim();

    if (/\b(certifi|certification|habilitation|accredit)/i.test(t)) {
      certifications.push({ name: clean.replace(/\s*[-–|]\s*certifi[ée]e?\s*$/i, "").trim(), year, issuer: "" });
      continue;
    }

    const last = education[education.length - 1];
    // Une ligne sans diplome ni annee complete l'entree precedente : les CV
    // etalent souvent « diplome / periode / etablissement » sur trois lignes.
    if (last && !RE_DIPLOME.test(t)) {
      if (!clean && year) { last.end_year = last.end_year || year; continue; }
      if (RE_ETAB.test(t) || (!last.institution && clean.length < 80)) {
        const parts = clean.split(/\s*[-–—|,_]\s*/).filter(Boolean);
        last.institution = last.institution || parts.find((p) => !isLocation(p)) || clean;
        last.location = last.location || parts.find(isLocation) || "";
        last.end_year = last.end_year || year;
        continue;
      }
    }

    if (!clean) continue;
    const parts = clean.split(/\s*[-–—|,]\s*/).filter(Boolean);
    education.push({
      degree: parts[0] || clean,
      institution: parts.slice(1).find((p) => !isLocation(p)) || "",
      location: parts.find(isLocation) || "",
      end_year: year,
      level: guessLevel(clean),
    });
  }
  return { education, certifications };
}

function guessLevel(t) {
  if (/\bdoctorat|phd\b/i.test(t)) return "bac+8";
  if (/\bmaster|mba|msc|ing[ée]nieur|dess|bac\s*\+\s*5\b/i.test(t)) return "bac+5";
  if (/\blicence|bachelor|bac\s*\+\s*3\b/i.test(t)) return "bac+3";
  if (/\bbts|dut|but|bac\s*\+\s*2\b/i.test(t)) return "bac+2";
  return "";
}

function extractCertifications(seg) {
  const sec = seg.sections.find((s) => s.type === "certifications");
  if (!sec) return [];
  return mergeWrapped(sec.lines)
    .filter((t) => t.length > 2)
    .map((t) => {
      const period = N.parsePeriod(t);
      const ty = trailingYear(t);
      const year = period ? Number(String(period.end || period.start).slice(0, 4)) : ty ? ty.year : null;
      let name = t;
      if (period && period.matched) name = name.replace(period.matched, " ");
      else if (ty) name = name.replace(ty.matched, " ");
      name = name.replace(/[\s|,–—-]+$/g, "").replace(/\s+/g, " ").trim();
      return { name: name.replace(/\s*[-–|:]\s*certifi[ée]e?\s*$/i, "").trim(), year, issuer: "" };
    })
    .filter((c) => c.name);
}

function extractLanguages(seg, fullText) {
  const sec = seg.sections.find((s) => s.type === "languages");
  const LANGS = /\b(fran[çc]ais|anglais|espagnol|allemand|italien|arabe|portugais|russe|chinois|mandarin|japonais|n[ée]erlandais|polonais|roumain|turc|hindi|cor[ée]en|su[ée]dois|grec|h[ée]breu|wolof|peul|berb[èe]re|kabyle|english|french|spanish|german)\b/gi;

  const source = sec ? mergeWrapped(sec.lines) : [];
  const out = [];

  // Une langue par ligne, le niveau pouvant se trouver sur la ligne suivante.
  source.forEach((t, i) => {
    const found = t.match(LANGS);
    if (!found) return;
    for (const name of found) {
      const ctx = [t, source[i + 1] || ""].join(" ");
      out.push({
        name: cap(name),
        level: N.languageLevel(ctx),
        self_described: t.replace(new RegExp(name, "i"), "").replace(/^[\s:–—-]+/, "").trim() || "",
        certification: (ctx.match(/\b(toeic|toefl|tcf|ielts|cambridge|bulats|delf|dalf)\b[^,;.|]{0,18}/i) || [""])[0].trim(),
      });
    }
  });

  if (!out.length) {
    // Repli : on balaye tout le document (langues souvent citees en en-tete).
    const seen = new Set();
    let m;
    const re = new RegExp(LANGS.source, "gi");
    while ((m = re.exec(fullText))) {
      const name = cap(m[0]);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const ctx = fullText.slice(m.index, m.index + 70);
      out.push({ name, level: N.languageLevel(ctx), self_described: "", certification: "" });
    }
  }

  return dedupeBy(out, (l) => l.name.toLowerCase());
}

function cap(s) {
  const t = String(s || "").toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function dedupeBy(arr, key) {
  const seen = new Map();
  for (const x of arr) {
    const k = key(x);
    const prev = seen.get(k);
    // On garde l'occurrence la plus renseignee.
    if (!prev || (!prev.level && x.level)) seen.set(k, x);
  }
  return [...seen.values()];
}

function extractInterests(seg) {
  const sec = seg.sections.find((s) => s.type === "interests");
  if (!sec) return [];
  return dedupe(mergeWrapped(sec.lines).flatMap(splitList));
}

// ================================================================ PUBLIC ===

/**
 * @param {object} doc  sortie de lib/ingest
 * @param {object} seg  sortie de lib/layout
 * @returns {object} cv_master
 */
function extract(doc, seg) {
  const fullText = doc.pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");

  const identity = extractIdentity(doc, seg, fullText);
  const contact = extractContact(doc, seg, fullText);
  const summary = extractSummary(seg);
  const experiences = extractExperiences(seg);
  const skills = extractSkills(seg, fullText);
  const { education, certifications: eduCerts } = extractEducation(seg);
  const certifications = dedupeBy(extractCertifications(seg).concat(eduCerts), (c) => deacc(c.name));
  const languages = extractLanguages(seg, fullText);
  const interests = extractInterests(seg);

  // Technologies : detectees dans TOUT le texte, puis enrichies des stacks de
  // mission (une techno citee dans une mission recente vaut plus).
  const detected = taxo.detect(fullText);
  const byName = new Map(detected.map((d) => [d.name, { ...d, last_used: null }]));
  for (const exp of experiences) {
    const year = Number(String(exp.end_date || exp.start_date || "").slice(0, 4)) || null;
    for (const raw of exp.tech_stack) {
      const c = taxo.lookup(raw);
      if (!c) continue;
      const cur = byName.get(c.name) || { ...c, occurrences: 0, last_used: null };
      cur.occurrences += 2; // une techno explicitement listee compte double
      if (year && (!cur.last_used || year > cur.last_used)) cur.last_used = year;
      byName.set(c.name, cur);
    }
  }
  const technologies = [...byName.values()].sort(
    (a, b) => b.weight - a.weight || b.occurrences - a.occurrences || a.name.localeCompare(b.name)
  );

  // Le titre professionnel est obligatoire sur le dossier : a defaut d'en
  // trouver un en tete du CV, on prend l'intitule de la mission la plus
  // recente, qui est la reponse la plus juste et la plus verifiable.
  if (!identity.title && experiences.length) {
    // On privilegie une mission dont l'intitule ressemble vraiment a un poste :
    // certains CV titrent leurs blocs « Tâches » ou « Missions ».
    const generique = /^(t[âa]ches?|missions?|projets?|activit[ée]s?|r[ée]alisations?|contexte|description|r[ôo]les?|poste)$/i;
    const utilisable = (e) => e.role && estTitrePlausible(e.role) && !generique.test(nettoyerTitre(e.role));
    const recente = experiences.find((e) => utilisable(e) && estRole(e.role))
      || experiences.find(utilisable);
    if (recente) {
      identity.title = N.trimTo(nettoyerTitre(recente.role), 90);
      identity.title_derive = true;
    }
  }

  const seniority = seniorityYears(experiences);

  const warnings = [];
  const needs_review = [];
  if (!identity.full_name && !identity.trigram) needs_review.push("identity.full_name");
  if (!identity.title) needs_review.push("identity.title");
  else if (identity.title_derive) warnings.push("titre_deduit_de_la_mission_la_plus_recente");
  if (!contact.email) needs_review.push("contact.email");
  if (!experiences.length) needs_review.push("experiences");
  if (doc.scanned) warnings.push("pdf_probablement_scanne_sans_couche_texte");
  if (doc.pages.some((p) => p.columns && p.columns.length > 1)) warnings.push("mise_en_page_multi_colonnes_detectee");
  const now = N.isoNow();
  experiences.forEach((e) => {
    if (e.end_date && e.end_date > now) warnings.push(`date_future:${e.id} (${e.end_date})`);
    if (!e.start_date) needs_review.push(`${e.id}.start_date`);
  });

  return {
    source: {
      filename: doc.filename,
      pages: doc.pageCount,
      layout: doc.pages.some((p) => p.columns && p.columns.length > 1) ? "two_column" : "single_column",
      extraction_method: doc.method,
      language: "fr",
      parsed_at: new Date().toISOString(),
      parser_version: "1.0.0",
    },
    identity: { ...identity, seniority_years: seniority },
    contact,
    summary,
    experiences,
    skills,
    technologies,
    education,
    certifications,
    languages,
    interests,
    quality: {
      completeness: completeness({ identity, contact, experiences, skills, education }),
      warnings,
      needs_review,
    },
  };
}

/**
 * Anciennete = union des periodes, pas leur somme : deux missions menees en
 * parallele ne font pas deux fois plus d'experience.
 */
function seniorityYears(experiences) {
  const spans = experiences
    .filter((e) => e.start_date)
    .map((e) => [monthIndex(e.start_date), monthIndex(e.is_current || !e.end_date ? N.isoNow() : e.end_date)])
    .filter(([a, b]) => b >= a)
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return 0;

  let total = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce + 1) ce = Math.max(ce, e);
    else { total += ce - cs + 1; [cs, ce] = [s, e]; }
  }
  total += ce - cs + 1;
  return Math.max(0, Math.round(total / 12));
}

function monthIndex(iso) {
  const [y, m] = String(iso).split("-").map(Number);
  return y * 12 + (m || 1);
}

function completeness(d) {
  const checks = [
    !!d.identity.full_name, !!d.identity.title, !!d.contact.email, !!d.contact.phone,
    d.experiences.length > 0, d.experiences.length > 1,
    d.experiences.some((e) => e.highlights.length), d.experiences.some((e) => e.start_date),
    d.skills.length > 0, d.education.length > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100) / 100;
}

// seniorityYears et completeness sont exportees en plus de `extract` : la
// voie d'extraction DocIE (lib/docie-extract.js, issue #152) en a besoin pour
// calculer les memes metriques de qualite sans dupliquer cette logique.
module.exports = { extract, RE_ROLE, estRole, splitList, dedupe, hasMetric, seniorityYears, completeness };
