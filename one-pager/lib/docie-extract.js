/**
 * Extraction via le bridge DocIE partage (issue #150/#152).
 *
 * Contrairement a lib/extract.js (heuristiques de mise en page sur du texte
 * positionne), ce module ne fait AUCUNE analyse de mise en page : il envoie
 * le PDF tel quel a DocIE (schema "adbi_resume", cf. cv-parser/adbi_resume.schema.json)
 * via document-parsing/bridge/docie-bridge.js, puis reprojette sa reponse dans
 * le meme « cv_master » que produit lib/extract.js#extract, pour que le reste
 * de la chaine (edition, reduction one-page, exports PDF/PPTX) ne voie aucune
 * difference entre les deux origines.
 *
 * Le client bridge n'est charge qu'a l'appel (jamais au chargement du module) :
 * le fichier partage vit dans document-parsing/bridge/ et n'est present que si
 * l'empaquetage Docker de ce service l'y copie (voir one-pager/Dockerfile).
 * Le drapeau DOCIE_EXTRACTION_ENABLED etant desactive par defaut, ce service
 * doit demarrer et fonctionner meme si ce fichier est absent.
 */

const N = require("./normalize");
const taxo = require("./taxonomy");
const { splitList, dedupe, hasMetric, seniorityYears, completeness } = require("./extract");

function chargerBridge() {
  // eslint-disable-next-line global-require
  return require("../../document-parsing/bridge/docie-bridge");
}

/** Une valeur de champ DocIE peut etre une chaine, ou une liste d'objets `{item}`/`{interest}`. */
function versListeDeChaines(valeur, cle) {
  if (valeur == null) return [];
  const liste = Array.isArray(valeur) ? valeur : [valeur];
  return liste
    .map((v) => (v && typeof v === "object" ? String(v[cle] ?? "").trim() : String(v ?? "").trim()))
    .filter(Boolean);
}

function texte(v) {
  return String(v ?? "").trim();
}

/** « bac+5 » deduit d'un intitule de diplome — memes mots-cles que lib/extract.js#guessLevel. */
function guessLevel(t) {
  if (/\bdoctorat|phd\b/i.test(t)) return "bac+8";
  if (/\bmaster|mba|msc|ing[ée]nieur|dess|bac\s*\+\s*5\b/i.test(t)) return "bac+5";
  if (/\blicence|bachelor|bac\s*\+\s*3\b/i.test(t)) return "bac+3";
  if (/\bbts|dut|but|bac\s*\+\s*2\b/i.test(t)) return "bac+2";
  return "";
}

function anneeDepuis(v) {
  const m = String(v ?? "").match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/**
 * Separe une description DocIE (une seule chaine) en un contexte et des
 * realisations. DocIE ne renvoie pas la mise en page d'origine : on se fie
 * aux retours a la ligne, puis aux phrases si le texte n'en contient aucun.
 */
function decouperDescription(description) {
  const lignes = texte(description)
    .split(/\r?\n+/)
    .map((l) => l.replace(/^[\s•▪◦●○·\-–—*✓✔»›→]+\s*/, "").trim())
    .filter(Boolean);

  if (lignes.length > 1) {
    return { context: "", highlights: lignes.filter((l) => l.length > 12) };
  }

  const seule = lignes[0] || "";
  const phrases = seule
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (phrases.length > 1) return { context: "", highlights: phrases.filter((p) => p.length > 12) };
  return { context: seule, highlights: [] };
}

function mapperExperience(brut, index) {
  const role = texte(brut && brut.title);
  const company = texte(brut && brut.company);
  const location = texte(brut && brut.location);
  const startRaw = texte(brut && brut.start_date);
  const endRaw = texte(brut && brut.end_date);
  const isCurrent = !endRaw || /present|actuel|current|en\s*cours|aujourd|a\s*ce\s*jour/i.test(endRaw);
  const start = startRaw ? N.parseMonthYear(startRaw) : null;
  const end = isCurrent ? null : (endRaw ? N.parseMonthYear(endRaw) : null);

  const { context, highlights } = decouperDescription(brut && brut.description);
  const techStack = dedupe(
    splitList(texte(brut && brut.env_technique)).map((t) => taxo.canonical(t))
  );

  return {
    role,
    mission: "",
    company,
    end_client: company,
    via: "",
    contract_type: "",
    location,
    start_date: start,
    end_date: end,
    is_current: !!(isCurrent && start),
    duration_months: start ? N.monthsBetween(start, end, isCurrent) : null,
    context,
    highlights: highlights.map((t) => ({ text: t, has_metric: hasMetric(t), score: 0 })),
    tech_stack: techStack,
    confidence: start && role ? 0.9 : role || start ? 0.6 : 0.35,
    id: `exp_${index + 1}`,
  };
}

function mapperCompetences(liste) {
  if (!Array.isArray(liste)) return [];
  return liste
    .map((groupe) => {
      const label = texte(groupe && groupe.category) || "Compétences";
      const items = dedupe(versListeDeChaines(groupe && groupe.items, "item").map((t) => taxo.canonical(t)));
      return { label, items };
    })
    .filter((g) => g.items.length);
}

function mapperFormation(liste) {
  if (!Array.isArray(liste)) return [];
  return liste
    .map((e) => {
      const degree = texte(e && e.degree);
      const institution = texte(e && e.institution);
      return {
        degree,
        institution,
        location: "",
        end_year: anneeDepuis(e && e.year),
        level: guessLevel(degree),
      };
    })
    .filter((e) => e.degree || e.institution);
}

function mapperCertifications(liste) {
  if (!Array.isArray(liste)) return [];
  return liste
    .map((c) => ({
      name: texte(c && c.name),
      year: anneeDepuis(c && c.year),
      issuer: texte(c && c.issuer),
    }))
    .filter((c) => c.name);
}

function mapperLangues(liste) {
  if (!Array.isArray(liste)) return [];
  return liste
    .map((l) => {
      const niveauBrut = texte(l && l.level);
      return {
        name: texte(l && l.language),
        level: N.languageLevel(niveauBrut) || "",
        self_described: niveauBrut,
        certification: "",
      };
    })
    .filter((l) => l.name);
}

/**
 * Technologies detectees a partir de tout le texte disponible, enrichies des
 * stacks de mission — meme logique que lib/extract.js#extract (lignes autour
 * de la detection `taxo.detect`), reprise ici car elle est imbriquee dans une
 * fonction non exportee.
 */
function calculerTechnologies(identity, experiences, skills) {
  const texteComplet = [
    identity.title,
    ...experiences.flatMap((e) => [e.role, e.context, ...e.highlights.map((h) => h.text)]),
    ...skills.flatMap((g) => g.items),
  ].join(" \n ");

  const detected = taxo.detect(texteComplet);
  const byName = new Map(detected.map((d) => [d.name, { ...d, last_used: null }]));
  for (const exp of experiences) {
    const year = Number(String(exp.end_date || exp.start_date || "").slice(0, 4)) || null;
    for (const raw of exp.tech_stack) {
      const c = taxo.lookup(raw);
      if (!c) continue;
      const cur = byName.get(c.name) || { ...c, occurrences: 0, last_used: null };
      cur.occurrences += 2;
      if (year && (!cur.last_used || year > cur.last_used)) cur.last_used = year;
      byName.set(c.name, cur);
    }
  }
  return [...byName.values()].sort(
    (a, b) => b.weight - a.weight || b.occurrences - a.occurrences || a.name.localeCompare(b.name)
  );
}

/**
 * Reprojette la reponse DocIE (schema adbi_resume, deja depouillee de ses
 * enveloppes {value,confidence,evidence_ids} par le bridge) dans le cv_master
 * interne. Fonction pure : aucun appel reseau, testable directement.
 *
 * @param {object} data      `result` renvoye par extractDocument()
 * @param {object} metadata  `metadata` renvoye par extractDocument()
 * @param {object} doc       { filename }
 */
function mapperAdbiResume(data, metadata, doc) {
  const d = data && typeof data === "object" ? data : {};
  const fullName = texte(d.name);

  const experiences = (Array.isArray(d.experience) ? d.experience : [])
    .map(mapperExperience)
    .sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")))
    .map((e, k) => ({ ...e, id: `exp_${k + 1}` }));

  const identity = {
    full_name: fullName ? N.properName(fullName) : "",
    initials: fullName ? N.initials(fullName) : "",
    trigram: fullName ? N.trigram(fullName) : "",
    title: texte(d.title),
  };

  let title_derive = false;
  if (!identity.title) {
    const usable = experiences.find((e) => e.role);
    if (usable) { identity.title = usable.role; title_derive = true; }
  }

  const contactBrut = d.contact && typeof d.contact === "object" ? d.contact : {};
  const phone = N.normalizePhone(texte(contactBrut.phone));
  const locationStr = texte(contactBrut.location);
  const contact = {
    email: texte(contactBrut.email),
    phone,
    phone_display: N.formatPhone(phone),
    linkedin: texte(contactBrut.linkedin),
    github: texte(contactBrut.github),
    location: { city: locationStr, region: "", country: /\bfrance\b/i.test(locationStr) ? "France" : "" },
    mobility: locationStr,
    work_mode: "",
    availability: "",
    driving_license: false,
  };

  const skills = mapperCompetences(d.skills);
  const education = mapperFormation(d.education);
  const certifications = mapperCertifications(d.certifications);
  const languages = mapperLangues(d.languages);
  const interests = versListeDeChaines(d.interests, "interest");
  const technologies = calculerTechnologies(identity, experiences, skills);

  const seniority = experiences.some((e) => e.start_date)
    ? seniorityYears(experiences)
    : Math.max(0, Math.round(Number(d.years_experience) || 0));

  const warnings = [];
  const needs_review = [];
  if (!identity.full_name) needs_review.push("identity.full_name");
  if (!identity.title) needs_review.push("identity.title");
  else if (title_derive) warnings.push("titre_deduit_de_la_mission_la_plus_recente");
  if (!contact.email) needs_review.push("contact.email");
  if (!experiences.length) needs_review.push("experiences");
  experiences.forEach((e) => { if (!e.start_date) needs_review.push(`${e.id}.start_date`); });

  const validation = metadata && metadata.validation;
  if (validation && validation.valid === false) warnings.push("docie_validation_negative");
  if (metadata && metadata.schema_reported === false) warnings.push("docie_schema_non_verifie");

  const master = {
    source: {
      filename: (doc && doc.filename) || "cv",
      pages: null,
      layout: "unknown",
      extraction_method: "docie",
      language: "fr",
      parsed_at: new Date().toISOString(),
      parser_version: "1.0.0-docie",
      docie: {
        agent: (metadata && metadata.agent) || null,
        request_id: (metadata && metadata.request_id) || null,
        model: (metadata && metadata.model) || null,
      },
    },
    identity: { ...identity, seniority_years: seniority },
    contact,
    summary: { raw: "", condensed: "" },
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
  return master;
}

/**
 * Point d'entree : envoie le PDF au bridge DocIE et renvoie un cv_master.
 * Ne rattrape aucune erreur : lib/import-pipeline.js decide du repli.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{env?: object, fetchImpl?: Function}} [options]
 */
async function extraireViaDocie(buffer, filename, { env = process.env, fetchImpl } = {}) {
  const { extractDocument } = chargerBridge();
  const { result, metadata } = await extractDocument(buffer, "application/pdf", {
    kind: "resume",
    env,
    fetchImpl,
  });
  return mapperAdbiResume(result, metadata, { filename });
}

module.exports = { extraireViaDocie, mapperAdbiResume, decouperDescription };
