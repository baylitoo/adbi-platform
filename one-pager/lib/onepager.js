/**
 * Reduction one-page : projette un « cv_master » complet en « cv_onepager »,
 * c'est-a-dire uniquement ce qui sera imprime, aux budgets du gabarit.
 *
 * Regle absolue : on ne tronque JAMAIS au milieu d'une phrase. Soit un element
 * entre entier, soit il est retire — et sa suppression est tracee dans
 * `layout.dropped` pour que l'utilisateur puisse le reintegrer.
 */

const N = require("./normalize");
const taxo = require("./taxonomy");
const fonc = require("./fonctionnel");
const { scoreAll } = require("./score");

/** Budgets du gabarit ADBI (slide 16:9). */
const GABARIT = {
  adbi_16_9: {
    label: "ADBI — dossier de compétences (16:9)",
    // Ces plafonds ne sont plus des budgets de mise en page mais de simples
    // garde-fous contre un texte aberrant. L'ajustement se fait desormais sur
    // le CORPS DE POLICE, pas en amputant le contenu : un contexte de 700
    // caracteres doit s'afficher en entier, quitte a etre ecrit plus petit.
    titre: 120,
    contexte: 900,
    highlight: 320,
    experiences: 3,
    bullets: [4, 4, 3], // par mission, de la plus recente a la plus ancienne
    techLine: 260,
    chips: 4,
    chipLen: 14,
    groupes: 8,      // le gabarit ADBI en affiche 8, bien remplies
    groupeLen: 210,
    certifications: 4,
  },
};

const DENSITE = { compact: 0.8, normal: 1, aere: 1.25 };

/** Mots-cles a privilegier selon l'angle choisi. */
const FOCUS = {
  technique: /\b(architecture|d[ée]veloppement|api|cloud|docker|kubernetes|migration|int[ée]gration|donn[ée]es|infrastructure|s[ée]curit[ée]|performance|automatisation|ci\/cd|stack|技)/i,
  management: /\b([ée]quipe|budget|pilotage|gouvernance|copil|fournisseurs?|coordination|management|animation|arbitrage|planning|risques?|comit[ée])\b/i,
};

/**
 * @param {object} cv       cv_master
 * @param {object} options  { template, anonymization, headerClient, targetJob,
 *                            density, focus, maxExperiences, keep, drop }
 */
function build(cv, options = {}) {
  const opt = {
    template: "adbi_16_9",
    anonymization: "none",
    headerClient: "",
    targetJob: "",
    density: "normal",
    focus: "neutre",
    maxExperiences: null,
    keep: [],   // identifiants forces par l'utilisateur
    drop: [],   // identifiants exclus par l'utilisateur
    photo: null,        // data URI d'une vraie photo, prioritaire sur l'avatar
    avatar: "avatar-homme-rose.png",  // illustration de repli (public/assets/)
    badges: [],         // logos de certification affiches en pied (public/assets/badges/)
    ...options,
  };

  const G = GABARIT[opt.template] || GABARIT.adbi_16_9;
  const facteur = DENSITE[opt.density] || 1;
  const scored = scoreAll(deepCopy(cv), opt.targetJob);
  const dropped = [];

  // ------------------------------------------------------------- En-tete --
  const anon = opt.anonymization;
  // Le trigramme calcule reste modifiable : deux consultants peuvent le
  // partager, et l'usage interne prime sur la regle automatique.
  const tri = (opt.headerClient || scored.identity.trigram || N.trigram(scored.identity.full_name) || scored.identity.initials || "").toUpperCase();
  const nom =
    anon === "trigram" || anon === "initials" ? tri :
    anon === "client_prefix" ? (opt.headerClient || tri) :
    scored.identity.full_name;

  // Le titre professionnel est obligatoire sur le dossier. Quand le CV source
  // n'en porte aucun, on affiche un marqueur visible plutot qu'un blanc : il
  // est impossible d'envoyer le document sans s'en apercevoir.
  const titre = N.trimTo(cleanTitle(scored.identity.title), Math.round(G.titre * facteur)) || "Titre à compléter";
  if (scored.identity.title && titre.length < scored.identity.title.length) {
    dropped.push({ what: "identity.title", reason: "budget_caracteres" });
  }

  // -------------------------------------------------------- Experiences ---
  const maxExp = opt.maxExperiences || Math.max(1, Math.round(G.experiences * facteur));
  const candidates = scored.experiences.filter((e) => !opt.drop.includes(e.id));
  const forced = candidates.filter((e) => opt.keep.includes(e.id));
  const rest = candidates
    .filter((e) => !opt.keep.includes(e.id))
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const retenues = [...forced, ...rest].slice(0, maxExp);
  // On reste en ordre chronologique inverse : un recruteur lit le present d'abord.
  retenues.sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")));

  for (const e of candidates) {
    if (!retenues.includes(e)) {
      dropped.push({ what: e.id, label: `${e.role} — ${e.end_client || e.company}`, reason: raisonRejet(e, scored) });
    }
  }

  const experiences = retenues.map((e, i) => {
    const budget = Math.max(1, Math.round((G.bullets[i] ?? G.bullets[G.bullets.length - 1]) * facteur));
    let hl = [...e.highlights];
    if (opt.focus !== "neutre" && FOCUS[opt.focus]) {
      // Le focus reordonne, il ne filtre pas : on ne perd pas un resultat chiffre.
      hl = hl.sort((a, b) => (FOCUS[opt.focus].test(b.text) ? 1 : 0) - (FOCUS[opt.focus].test(a.text) ? 1 : 0) || b.score - a.score);
    }
    const gardes = hl.slice(0, budget);
    hl.slice(budget).forEach((h) =>
      dropped.push({ what: `${e.id}.highlight`, label: N.trimTo(h.text, 60), reason: "budget_puces" })
    );

    return {
      id: e.id,
      role: N.trimTo(joinRole(e), 78),
      client: clientAffichable(e),
      via: e.via || "",
      location: e.location || "",
      period: N.formatPeriod(e.start_date, e.end_date, e.is_current),
      context: N.trimTo(cleanSentence(e.context), Math.round(G.contexte * facteur)),
      bullets: gardes.map((h) => ({
        text: N.sentenceCase(N.trimTo(cleanSentence(h.text), Math.round(G.highlight * facteur))),
        metric: h.has_metric,
        score: h.score,
      })),
      tech_line: N.trimTo(techLine(e), Math.round(G.techLine * facteur)),
      score: e.relevance_score,
    };
  });

  // --------------------------------------------------------- Competences --
  const chips = headlineChips(scored, G);
  const groupes = skillGroups(scored, G, facteur, chips, dropped);

  // ------------------------------------------- Certifications & formation -
  const certifs = [
    ...scored.certifications.map((c) => ({
      text: c.name + (c.year ? ` (${c.year})` : ""),
      sort: c.year || 0,
      kind: "certification",
    })),
    ...scored.education
      .filter((e) => ["bac+5", "bac+8", "bac+3"].includes(e.level) || !scored.education.some((x) => x.level))
      .map((e) => ({
        text: [e.degree, e.institution].filter(Boolean).join(" — ") + (e.end_year ? ` (${e.end_year})` : ""),
        sort: e.end_year || 0,
        kind: "formation",
      })),
  ].sort((a, b) => b.sort - a.sort);

  const certifications = certifs.slice(0, Math.round(G.certifications * facteur)).map((c) => ({ text: N.trimTo(c.text, 72), kind: c.kind }));
  certifs.slice(Math.round(G.certifications * facteur)).forEach((c) =>
    dropped.push({ what: "certifications", label: c.text, reason: "budget_lignes" })
  );

  // -------------------------------------------------------------- Langues -
  const langues = scored.languages
    .filter((l) => !l.level || ["B2", "C1", "C2"].includes(l.level))
    .map((l) => l.name + (l.level ? ` (${l.level})` : ""));

  return {
    template: opt.template,
    options: opt,
    header: {
      name: nom,
      anonymized: anon !== "none",
      title: titre,
      badge: scored.identity.seniority_years ? `${scored.identity.seniority_years} ans d'expérience` : "",
      contact: anon === "none" ? publicContact(scored.contact) : null,
    },
    // Element visuel du portrait : une vraie photo si elle a ete fournie,
    // sinon l'illustration ADBI. Les deux sont rendus dans le meme cercle.
    visual: {
      portrait: opt.photo || "assets/" + opt.avatar,
      is_photo: !!opt.photo,
      // Un badge est soit un fichier de la bibliotheque, soit une image
      // importee par l'utilisateur (deja sous forme de data URI).
      badges: (opt.badges || []).map((b) =>
        String(b).startsWith("data:") ? String(b) : "assets/badges/" + cheminBadge(b)
      ),
      logo: "assets/logo-adbi.png",
      fond: "assets/fond-vagues.svg",
    },
    summary: N.trimTo(cleanSentence(scored.summary.raw), Math.round(300 * facteur)),
    experiences,
    chips,
    skill_groups: groupes,
    certifications,
    languages: langues,
    layout: {
      density: opt.density,
      focus: opt.focus,
      dropped,
      kept_experiences: retenues.length,
      total_experiences: scored.experiences.length,
    },
  };
}

// ------------------------------------------------------------- Fabriques ---

/** Les 4 technologies mises en avant : rares, recentes et effectivement citees. */
function headlineChips(cv, G) {
  const recent = new Set();
  cv.experiences
    .slice(0, 3)
    .forEach((e) => e.tech_stack.forEach((t) => recent.add(taxo.canonical(t))));

  const techniques = cv.technologies
    .map((t) => ({ ...t, boost: (recent.has(t.name) ? 2 : 0) + (t.last_used ? 1 : 0) }))
    .filter((t) => t.name.length <= G.chipLen + 4)
    .sort((a, b) => b.weight + b.boost - (a.weight + a.boost) || b.occurrences - a.occurrences)
    .slice(0, G.chips)
    .map((t) => t.name);

  if (techniques.length >= G.chips) return techniques;

  // Un profil fonctionnel n'a aucune techno a mettre en pastille. Plutot que
  // de laisser des cases vides dans le gabarit, on met en avant ses domaines,
  // tires de ses propres missions.
  const corpus = cv.experiences
    .flatMap((e) => [e.role, e.mission, e.context, ...e.highlights.map((h) => h.text)])
    .filter(Boolean)
    .join(" . ");
  const complement = fonc
    .detectFlat(corpus)
    .filter((n) => n.length <= 24 && !techniques.includes(n));

  return techniques.concat(complement).slice(0, G.chips);
}

/**
 * Categories de competences.
 *
 * On ne choisit PAS entre les groupes declares par le candidat et ce que le
 * referentiel detecte : on fusionne. Le referentiel apporte les categories
 * techniques propres et bien remplies (le CV oublie souvent de lister ce qu'il
 * a pourtant utilise dans ses missions), les groupes du candidat apportent le
 * fonctionnel et le metier, que le referentiel ne connait pas.
 */
function skillGroups(cv, G, facteur, chips, dropped) {
  const chipSet = new Set(chips);

  // 1) Tout ce qui a ete detecte, y compris dans le corps des missions.
  const techniques = taxo
    .categorize(cv.technologies.map((t) => t.name).filter((n) => !chipSet.has(n)))
    .filter((c) => c.key !== "autres")
    .map((c) => ({ label: c.label, items: c.items }));

  // 2) Les groupes du CV, prives de ce que le referentiel a deja classe.
  const dejaVus = new Set(techniques.flatMap((c) => c.items.map((i) => deacc(i))));
  const metier = cv.skills
    .map((g) => ({
      // « COMPÉTENCES FONCTIONNELLES » crie a cote des libelles du referentiel.
      label: N.trimTo(normaliserLibelle(g.label), 34),
      items: g.items.filter((i) => !chipSet.has(i) && !dejaVus.has(deacc(i)) && estCompetence(i)),
    }))
    // Un groupe d'un seul item survivant est un residu de decoupage, pas une
    // categorie : les colonnes du gabarit en attendent plusieurs.
    .filter((g) => g.items.length >= 2 && g.label.length <= 30)
    .slice(0, 2);

  // 3) Competences fonctionnelles lues dans les missions. Indispensable pour
  //    les profils AMOA, gestion de projet ou relation client, dont le CV ne
  //    cite quasiment aucun outil : sans elles, la colonne reste vide.
  const corpus = cv.experiences
    .flatMap((e) => [e.role, e.mission, e.context, ...e.highlights.map((h) => h.text)])
    .concat(cv.summary ? cv.summary.raw : "")
    .filter(Boolean)
    .join(" . ");
  const fonctionnels = fonc
    .detect(corpus)
    .map((g) => ({ label: g.label, items: g.items.filter((i) => !chipSet.has(i) && !dejaVus.has(deacc(i))) }))
    .filter((g) => g.items.length);

  const tous = [...techniques, ...fonctionnels, ...metier].filter((g) => g.items.length);

  // Selection par richesse (une categorie a un seul item remplit mal une
  // colonne), affichage dans l'ordre canonique du referentiel.
  const max = Math.round(G.groupes * facteur);
  const retenus = [...tous].sort((a, b) => b.items.length - a.items.length).slice(0, max);
  tous.filter((g) => !retenus.includes(g)).forEach((g) =>
    dropped.push({ what: "skills", label: g.label, reason: "budget_categories" })
  );
  const kept = tous.filter((g) => retenus.includes(g));

  return kept.map((g) => {
    const value = g.items.join(", ");
    const budget = Math.round(G.groupeLen * facteur);
    if (value.length <= budget) return { label: g.label, value, items: g.items };
    // On retire des items entiers, jamais une fin de mot.
    const items = [];
    let len = 0;
    for (const it of g.items) {
      if (len + it.length + 2 > budget) { dropped.push({ what: "skills." + g.label, label: it, reason: "budget_caracteres" }); continue; }
      items.push(it);
      len += it.length + 2;
    }
    return { label: g.label, value: items.join(", "), items };
  }).filter((g) => g.value);
}

/**
 * Chemin d'un badge de la bibliotheque, relatif a public/assets/badges/.
 *
 * La cle arrive du navigateur. On accepte au plus « Editeur/fichier.png » et on
 * refuse tout le reste : sans cette borne, un « ../../ » ferait sortir de la
 * bibliotheque et embarquerait un fichier quelconque du disque dans le PPTX.
 */
function cheminBadge(cle) {
  const parts = String(cle).split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
  const fichier = parts.pop() || "";
  if (!/^[\wÀ-ÿ .()&+'’-]+\.(png|jpe?g)$/i.test(fichier)) return "";
  const dossier = parts.pop() || "";
  return /^[\wÀ-ÿ .()&+'’-]+$/.test(dossier) ? dossier + "/" + fichier : fichier;
}

// Libelles de structure que le decoupage prend parfois pour un nom de client.
const RE_FAUX_CLIENT = /^(contexte|projets?|missions?|r[ôo]les?|description|pr[ée]sentation|objectifs?|r[ée]alisations?|t[âa]ches?|activit[ée]s?|environnement|client|entreprise)\s*:?\s*$/i;

/** Nom du client tel qu'il sera imprime, ou vide plutot qu'un intitule parasite. */
function clientAffichable(e) {
  const c = (e.end_client || e.company || "").trim();
  return RE_FAUX_CLIENT.test(c) ? "" : c;
}

function joinRole(e) {
  if (e.mission && e.role) return `${e.role} — ${e.mission}`;
  return e.role || e.mission || "";
}

/**
 * Ligne « Environnement technique » d'une mission.
 * A defaut de liste explicite dans le CV, on la reconstitue en balayant TOUT
 * le contenu de la mission — intitule, client et realisations compris. Un CV
 * fonctionnel ne liste presque jamais sa stack, mais la cite dans ses phrases.
 */
function techLine(e) {
  if (e.tech_stack && e.tech_stack.length) return e.tech_stack.join(", ");
  const text = [e.role, e.mission, e.end_client, e.company, e.context, ...e.highlights.map((h) => h.text)]
    .filter(Boolean)
    .join(" . ");
  const outils = taxo.detect(text).slice(0, 8).map((t) => t.name);
  // A defaut d'outil, on cite les methodes : c'est l'environnement de travail
  // reel d'un profil fonctionnel, et c'est verifiable dans son CV.
  const methodes = outils.length ? [] : fonc.detectFlat(text).slice(0, 6);
  return outils.concat(methodes).join(", ");
}

function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[|•]\s*/g, " — ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSentence(t) {
  return String(t || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s•\-–—:]+/, "")
    .replace(/\s*[;,]\s*$/, "")
    .trim();
}

function publicContact(c) {
  return {
    email: c.email,
    phone: c.phone_display || c.phone,
    location: [c.location.city, c.location.region].filter(Boolean).join(", "),
    linkedin: c.linkedin,
  };
}

/** Motif lisible du rejet, affiche dans l'interface a cote de chaque element ecarte. */
function raisonRejet(e, cv) {
  const p = e.score_parts || {};
  if (p.recency < 0.2) return "experience_ancienne";
  if ((e.duration_months || 0) < 4) return "mission_courte";
  if (p.fit < 0.3) return "hors_perimetre_cible";
  return "score_inferieur";
}

function deepCopy(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * Une competence est un libelle court. Les sections « Compétences » mal
 * decoupees laissent passer des phrases entieres (« Analyse des besoins métier
 * et rédaction de spécifications... ») : elles ruinent la colonne de droite.
 */
function estCompetence(t) {
  const s = String(t || "").trim();
  if (s.length < 2 || s.length > 32) return false;
  if (s.split(/\s+/).length > 4) return false;
  // Un fragment de phrase commence en minuscule (« industrialisation de… »,
  // « techniques ») ; un vrai libelle commence par une majuscule ou un
  // chiffre — sauf les technologies qui s'ecrivent ainsi (dbt, npm).
  if (/^[a-zà-ÿ]/.test(s) && !taxo.lookup(s)) return false;
  return true;
}

/** Titre de categorie en casse de phrase, sigles preserves (SI, ETL, BI). */
function normaliserLibelle(t) {
  const s = String(t || "").replace(/\s*:\s*$/, "").trim();
  const lettres = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!lettres || lettres !== lettres.toUpperCase() || lettres.length <= 3) return s;
  return s
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\b(si|etl|elt|bi|api|rgpd|sql|erp|crm|moa|moe|amoa|it|qa|ia)\b/gi, (m) => m.toUpperCase());
}

/** Cle de comparaison insensible aux accents et a la casse. */
function deacc(s) {
  return N.deaccent(String(s || "")).toLowerCase().trim();
}

module.exports = { build, GABARIT, DENSITE, cheminBadge };
