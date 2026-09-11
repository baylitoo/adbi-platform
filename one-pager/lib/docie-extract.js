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
 * Ce que DocIE dit de SA PROPRE extraction (avertissements de validation,
 * confiance par champ) est reprojete dans `quality.warnings` / `quality.needs_review`,
 * c'est-a-dire dans le bandeau et les surlignages de l'ecran de relecture :
 * une extraction partielle ne doit pas s'y presenter comme complete et sure.
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
  return liste.map((v) => (v && typeof v === "object" ? texte(v[cle] ?? v) : texte(v))).filter(Boolean);
}

function texte(v) {
  // Filet de securite : un champ ancre par DocIE arrive enveloppe
  // ({value, confidence, evidence_ids}). Le bridge deballe ces enveloppes,
  // mais la liste des cles qui en signalent une a deja evolue cote DocIE
  // (`model_confidence`) ; sans ce repli un scalaire deballe une version trop
  // tot se lirait « [object Object] » jusque dans le dossier exporte.
  // Tout autre objet ne devient jamais du texte : « [object Object] » finirait
  // dans le dossier exporte. DocIE renvoie null pour une feuille absente, donc
  // {item: null} arrive bel et bien ici.
  if (v && typeof v === "object" && !Array.isArray(v)) return "value" in v ? texte(v.value) : "";
  return String(v ?? "").trim();
}

/**
 * Seuil de relecture humaine sur la confiance DocIE d'un champ.
 *
 * DocIE plafonne la confiance d'un champ a exactement 0.5 quand il a du
 * tronquer une liste qui bouclait : la valeur rendue est alors partielle, mais
 * rien dans le CV extrait ne le montre. C'est le seul signal par champ que
 * l'agent emette ; `validation.warnings` est une prose libre, sans contrat de
 * format, qu'on affiche telle quelle sans jamais en extraire un nom de champ.
 */
const SEUIL_CONFIANCE = 0.5;

/** Chemin DocIE -> chemin cv_master, pour les champs hors missions. */
const CHAMPS_DOCIE = {
  name: "identity.full_name",
  title: "identity.title",
  "contact.email": "contact.email",
  "contact.phone": "contact.phone_display",
  "contact.linkedin": "contact.linkedin",
  "contact.github": "contact.github",
  "contact.location": "contact.location.city",
};

/** Chemin DocIE -> chemin cv_master, a l'interieur d'une mission. */
const CHAMPS_MISSION = {
  title: "role",
  company: "company",
  start_date: "start_date",
  end_date: "end_date",
  location: "location",
  description: "context",
  env_technique: "tech_stack",
};

/**
 * Traduit « experience[2].title » en « exp_1.role ».
 *
 * DocIE numerote les missions dans l'ordre du document, le cv_master les trie
 * par date decroissante : sans `idParIndexDocie`, un champ peu sur designerait
 * la mauvaise mission dans l'ecran de relecture. Renvoie "" quand le champ n'a
 * pas d'equivalent adressable (formation, competences, langues...), l'appelant
 * le signale alors en avertissement plutot que de forger un chemin inexistant.
 */
function cheminMaster(cheminDocie, idParIndexDocie) {
  if (Object.hasOwn(CHAMPS_DOCIE, cheminDocie)) return CHAMPS_DOCIE[cheminDocie];
  const decoupe = /^experience\[(\d+)\]\.([a-z_]+)$/.exec(cheminDocie);
  if (!decoupe) return "";
  const id = idParIndexDocie.get(Number(decoupe[1]));
  const champ = CHAMPS_MISSION[decoupe[2]];
  return id && champ ? `${id}.${champ}` : "";
}

/** Valeur extraite a un chemin DocIE (« experience[0].title »), ou undefined. */
function valeurAuChemin(racine, chemin) {
  return (chemin.match(/[^.[\]]+/g) || []).reduce(
    (valeur, cle) => (valeur !== null && typeof valeur === "object" ? valeur[cle] : undefined),
    racine
  );
}

function estRempli(valeur) {
  if (valeur == null) return false;
  if (typeof valeur === "string") return valeur.trim() !== "";
  if (Array.isArray(valeur)) return valeur.length > 0;
  if (typeof valeur === "number") return Number.isFinite(valeur);
  if (typeof valeur === "object") return Object.keys(valeur).length > 0;
  return true;
}

/** `validation.errors[]` / `validation.warnings[]` sont des chaines cote DocIE. */
function texteDocie(entree) {
  if (entree && typeof entree === "object" && !Array.isArray(entree)) {
    return texte(entree.message ?? entree.detail ?? entree.field ?? "");
  }
  return texte(entree);
}

/** « bac+5 » deduit d'un intitule de diplome — memes mots-cles que lib/extract.js#guessLevel. */
function guessLevel(t) {
  if (/\bdoctorat|phd\b/i.test(t)) return "bac+8";
  if (/\bmaster|mba|msc|ing[ée]nieur|dess|bac\s*\+\s*5\b/i.test(t)) return "bac+5";
  if (/\blicence|bachelor|bac\s*\+\s*3\b/i.test(t)) return "bac+3";
  if (/\bbts|dut|but|bac\s*\+\s*2\b/i.test(t)) return "bac+2";
  return "";
}

/**
 * Annee de fin lue dans un `education[].year` / `certifications[].year` DocIE.
 *
 * Ces deux champs sont du TEXTE LIBRE (comme start_date / end_date, cf.
 * missionEnCours plus bas) : DocIE y recopie ce que le CV ecrit, donc aussi
 * bien « 2019 » qu'une plage « 2016 - 2019 » ou une annee scolaire
 * « 2019/2020 ». On prend la DERNIERE annee rencontree, pas la premiere :
 * un diplome se date de son obtention, pas de son inscription (#177 ligne 14).
 *
 * Mesure avant correction : « 2016 - 2019 » rendait 2016. Le champ alimente
 * l'affichage « (2019) » ET le tri des formations (lib/onepager.js, lignes 227
 * et 228) — un master termine en 2019 s'affichait donc « (2016) » et passait
 * derriere une licence plus ancienne. lib/extract.js, l'autre voie
 * d'extraction, prenait deja la fin (`period.end || period.start`, ligne 814) :
 * le meme CV se lisait differemment selon qu'il passait par DocIE ou par la
 * mise en page.
 *
 * cv-parser garde la chaine verbatim (`education[].period` = « 2016 - 2019 »),
 * et c'est voulu : une fiche CVtheque affiche la plage, un dossier one-page a
 * besoin d'un scalaire triable. Ce qui doit s'accorder, c'est la regle — la
 * derniere annee est celle du diplome —, pas la forme.
 */
function anneeDepuis(v) {
  const annees = String(v ?? "").match(/(?:19|20)\d{2}/g);
  return annees ? Number(annees[annees.length - 1]) : null;
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

/**
 * « Cette mission est-elle toujours en cours ? » — liste de synonymes partagee.
 *
 * DocIE type experience[].start_date / end_date en `date` dans le schema
 * adbi_resume, mais les renvoie en TEXTE LIBRE : la vraie reponse enregistree
 * (document-parsing/fixtures/cv_samples/results/simple_docie.json) porte
 * « Mars 2022 » et « Aujourd'hui ». Chaque service doit donc reconnaitre
 * lui-meme « la mission continue », et les deux listes avaient diverge
 * (inventaire #177, lignes 4, 5 et 6) : celle-ci connaissait « actuel » sans
 * « maintenant », celle de cv-parser l'inverse. Mesure ici : une mission
 * « Mars 2019 - Maintenant » ressortait TERMINEE, avec une date de fin nulle.
 *
 * Le motif et le jeu d'essai sont partages avec cv-parser
 * (document-parsing/fixtures/mission_en_cours.json) ; le port Python vit dans
 * cv-parser/periode_mission.py. Les tests des deux cotes comparent leur motif
 * a ce fichier : ajouter un synonyme d'un seul cote casse le test de l'autre.
 *
 * Le texte est desaccentue avant l'essai, le motif n'a donc que des formes sans
 * accent (« present » couvre « Present »). « ce jour » figure sans son « a » :
 * dans « du 02/2022 a ce jour », le « a » est souvent deja consomme comme
 * separateur de periode.
 */
const MOTIF_MISSION_EN_COURS = /\b(?:aujourd.?hui|ce\s+jour|actuel(?:le(?:ment)?)?|en\s+cours|maintenant|depuis|present|current|now|to\s+date)\b/i;

/**
 * Une date de fin absente vaut « en cours » : une mission sans fin connue est
 * ouverte, pas ponctuelle (#177 ligne 6).
 */
function missionEnCours(dateFin) {
  const valeur = N.deaccent(texte(dateFin)).toLowerCase().trim();
  return !valeur || MOTIF_MISSION_EN_COURS.test(valeur);
}

function mapperExperience(brut, index) {
  const role = texte(brut && brut.title);
  const company = texte(brut && brut.company);
  const location = texte(brut && brut.location);
  const startRaw = texte(brut && brut.start_date);
  const endRaw = texte(brut && brut.end_date);
  const isCurrent = missionEnCours(endRaw);
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

  // L'index DocIE d'origine est conserve a cote de la mission (jamais dedans :
  // le cv_master est un contrat partage avec l'edition et les exports) pour
  // pouvoir rattacher un champ peu sur a la bonne mission apres le tri.
  const triees = (Array.isArray(d.experience) ? d.experience : [])
    .map((brut, indexDocie) => ({ indexDocie, exp: mapperExperience(brut, indexDocie) }))
    .sort((a, b) => String(b.exp.start_date || "").localeCompare(String(a.exp.start_date || "")));
  const experiences = triees.map(({ exp }, k) => ({ ...exp, id: `exp_${k + 1}` }));
  const idParIndexDocie = new Map(triees.map(({ indexDocie }, k) => [indexDocie, `exp_${k + 1}`]));

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

  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const validation = meta.validation;
  if (validation && validation.valid === false) warnings.push("docie_validation_negative");
  if (meta.schema_reported === false) warnings.push("docie_schema_non_verifie");

  // ── Ce dont DocIE lui-meme doute ──────────────────────────────────────────
  // Jusqu'ici seul `validation.valid === false` remontait : les avertissements
  // et erreurs de DocIE, et la confiance qu'il attache a chaque champ, etaient
  // jetes. Une extraction tronquee s'affichait donc comme complete et sure.
  //
  // `validation` accompagne toute extraction terminee (listes vides si tout va
  // bien) : son absence n'est pas un succes, c'est une reponse qu'on n'a pas pu
  // verifier — on le signale au lieu de la passer sous silence.
  if (meta.validation === undefined || meta.validation === null) {
    if (Object.keys(meta).length) warnings.push("docie_validation_absente");
  } else {
    for (const [cle, prefixe] of [["errors", "docie_erreur"], ["warnings", "docie_avertissement"]]) {
      const entrees = Array.isArray(validation[cle]) ? validation[cle] : [];
      // Texte repris verbatim : la prose de DocIE n'a aucun format stable dont
      // on pourrait deduire un nom de champ, et le pretendre serait pire que
      // de l'afficher telle quelle au relecteur.
      for (const entree of entrees) {
        const message = texteDocie(entree);
        if (message) warnings.push(`${prefixe}:${message}`);
      }
    }
  }

  // Confiance par champ : <= 0.5 signifie « partiel, a relire » (DocIE plafonne
  // a 0.5 exactement un champ dont il a du tronquer la liste). Un champ vide a
  // une confiance nulle sans rien avoir de douteux : c'est une absence, deja
  // couverte par les controles de completude ci-dessus.
  const confiances = meta.field_confidence;
  for (const [cheminDocie, confiance] of Object.entries(confiances && typeof confiances === "object" ? confiances : {})) {
    if (typeof confiance !== "number" || !Number.isFinite(confiance) || confiance > SEUIL_CONFIANCE) continue;
    if (!estRempli(valeurAuChemin(d, cheminDocie))) continue;
    const chemin = cheminMaster(cheminDocie, idParIndexDocie);
    if (!chemin) warnings.push(`docie_confiance_faible:${cheminDocie}`);
    else if (!needs_review.includes(chemin)) needs_review.push(chemin);
  }

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

module.exports = {
  extraireViaDocie,
  mapperAdbiResume,
  decouperDescription,
  // Exportes pour le test d'accord avec cv-parser (fixture partagee).
  missionEnCours,
  MOTIF_MISSION_EN_COURS,
};
