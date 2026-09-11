"use strict";

/**
 * Tests de lib/docie-extract.js — la reprojection DocIE -> cv_master.
 *
 * Purement fonctionnels : aucun appel reseau, aucune dependance au bridge
 * (mapperAdbiResume est une fonction pure). Les tests d'integration avec le
 * bridge (mock fetch) vivent dans tests/import-pipeline.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  mapperAdbiResume,
  decouperDescription,
  missionEnCours,
  MOTIF_MISSION_EN_COURS,
} = require("../lib/docie-extract");
const { build } = require("../lib/onepager");

/**
 * Jeu d'essai « mission en cours », partage mot pour mot avec
 * cv-parser/tests/test_periode_mission.py : c'est ce fichier, et non deux
 * listes jumelles, qui empeche les deux services de rediverger (#177).
 */
const FIXTURE_EN_COURS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "document-parsing", "fixtures", "mission_en_cours.json"),
    "utf8"
  )
);

const ADBI_RESUME_COMPLET = {
  name: "Alice Dupont",
  title: "Data Engineer",
  years_experience: 6,
  contact: {
    email: "alice.dupont@example.com",
    phone: "0640115866",
    linkedin: "linkedin.com/in/alice-dupont",
    github: "github.com/alicedupont",
    location: "Paris",
  },
  experience: [
    {
      company: "Decathlon",
      title: "Data Engineer",
      start_date: "2022-03",
      end_date: "present",
      location: "Lille",
      description: "Pilotage de la plateforme data.\nMigration de 40 pipelines Airflow vers Databricks.\nRéduction de 30% du coût de calcul cloud.",
      env_technique: "Python, Airflow, Databricks, Azure",
    },
    {
      company: "Capgemini",
      title: "Consultant Data",
      start_date: "2019-09",
      end_date: "2022-02",
      location: "Paris",
      description: "Développement d'ETL pour un client bancaire.",
      env_technique: "SQL, Talend",
    },
  ],
  education: [
    { degree: "Master Informatique", institution: "Université de Lille", year: "2019" },
  ],
  skills: [
    { category: "Cloud", items: [{ item: "Azure" }, { item: "AWS" }] },
    { category: "Langages", items: ["Python", "SQL"] },
  ],
  languages: [
    { language: "Anglais", level: "courant" },
    { language: "Français", level: "langue maternelle" },
  ],
  certifications: [{ name: "AZ-900", issuer: "Microsoft", year: "2023" }],
  interests: [{ interest: "Photographie" }, "Course à pied"],
};

const METADATA_OK = { agent: "adbi_agent_1", request_id: "req_1", model: "spark-x2.5-1.7b", validation: { valid: true } };

test("mappe un adbi_resume complet dans le cv_master interne", () => {
  const master = mapperAdbiResume(ADBI_RESUME_COMPLET, METADATA_OK, { filename: "cv.pdf" });

  // N.properName met le nom de famille en capitales, convention du gabarit ADBI.
  assert.equal(master.identity.full_name, "Alice DUPONT");
  assert.equal(master.identity.title, "Data Engineer");
  assert.equal(master.source.extraction_method, "docie");
  assert.equal(master.source.docie.agent, "adbi_agent_1");
  assert.equal(master.source.docie.request_id, "req_1");

  assert.equal(master.contact.email, "alice.dupont@example.com");
  assert.equal(master.contact.phone, "+33640115866");
  assert.equal(master.contact.location.city, "Paris");
  assert.equal(master.contact.linkedin, "linkedin.com/in/alice-dupont");

  assert.equal(master.experiences.length, 2);
  // Tri chronologique decroissant, comme lib/extract.js.
  assert.equal(master.experiences[0].company, "Decathlon");
  assert.equal(master.experiences[0].is_current, true);
  assert.equal(master.experiences[0].end_date, null);
  assert.equal(master.experiences[0].start_date, "2022-03");
  assert.ok(master.experiences[0].highlights.length >= 2, "au moins 2 realisations extraites de la description multi-lignes");
  assert.ok(master.experiences[0].tech_stack.includes("Python"));
  assert.ok(master.experiences[0].tech_stack.includes("Azure"));
  assert.equal(master.experiences[0].id, "exp_1");

  assert.equal(master.experiences[1].company, "Capgemini");
  assert.equal(master.experiences[1].end_date, "2022-02");
  assert.equal(master.experiences[1].is_current, false);

  // Skills : formes objet {item} ET chaine brute doivent etre acceptees.
  const cloud = master.skills.find((g) => g.label === "Cloud");
  assert.ok(cloud);
  assert.ok(cloud.items.includes("Azure"));
  const langages = master.skills.find((g) => g.label === "Langages");
  assert.ok(langages.items.includes("Python"));

  assert.equal(master.education[0].degree, "Master Informatique");
  assert.equal(master.education[0].end_year, 2019);
  assert.equal(master.education[0].level, "bac+5");

  assert.equal(master.certifications[0].name, "AZ-900");
  assert.equal(master.certifications[0].year, 2023);

  const anglais = master.languages.find((l) => l.name === "Anglais");
  assert.equal(anglais.level, "C1");

  // interests : forme objet {interest} et chaine brute.
  assert.deepEqual(master.interests.sort(), ["Course à pied", "Photographie"].sort());

  // Technologies detectees a partir des stacks de mission + descriptions.
  assert.ok(master.technologies.some((t) => t.name === "Python"));
  assert.ok(master.technologies.some((t) => t.name === "Databricks"));

  assert.equal(master.quality.needs_review.includes("identity.full_name"), false);
  assert.equal(master.quality.needs_review.includes("contact.email"), false);
});

test("deduit le titre de la mission la plus recente quand DocIE ne renvoie pas de titre", () => {
  const data = { ...ADBI_RESUME_COMPLET, title: "" };
  const master = mapperAdbiResume(data, METADATA_OK, { filename: "cv.pdf" });
  assert.equal(master.identity.title, "Data Engineer");
  assert.ok(master.quality.warnings.includes("titre_deduit_de_la_mission_la_plus_recente"));
});

test("signale une validation DocIE negative et un schema non confirme", () => {
  const master1 = mapperAdbiResume(ADBI_RESUME_COMPLET, { validation: { valid: false } }, { filename: "cv.pdf" });
  assert.ok(master1.quality.warnings.includes("docie_validation_negative"));

  const master2 = mapperAdbiResume(ADBI_RESUME_COMPLET, { schema_reported: false }, { filename: "cv.pdf" });
  assert.ok(master2.quality.warnings.includes("docie_schema_non_verifie"));
});

test("un cv_master vide reste valide et signale les champs manquants", () => {
  const master = mapperAdbiResume({}, {}, { filename: "cv.pdf" });
  assert.equal(master.identity.full_name, "");
  assert.ok(master.quality.needs_review.includes("identity.full_name"));
  assert.ok(master.quality.needs_review.includes("identity.title"));
  assert.ok(master.quality.needs_review.includes("contact.email"));
  assert.ok(master.quality.needs_review.includes("experiences"));
  assert.deepEqual(master.experiences, []);
});

// ── Metadonnees de relecture DocIE (issue : signaux jetes cote one-pager) ────

/** Meme CV, missions dans l'ordre du document : DocIE[0] est la PLUS ANCIENNE. */
const RESUME_ORDRE_DOCUMENT = {
  ...ADBI_RESUME_COMPLET,
  experience: [ADBI_RESUME_COMPLET.experience[1], ADBI_RESUME_COMPLET.experience[0]],
};

test("les avertissements et erreurs DocIE remontent verbatim dans quality.warnings", () => {
  const metadata = {
    ...METADATA_OK,
    validation: { valid: false, errors: ["missing contact"], warnings: ["experience[0].description truncated: repeated content detected"] },
  };
  const master = mapperAdbiResume(ADBI_RESUME_COMPLET, metadata, { filename: "cv.pdf" });

  assert.ok(master.quality.warnings.includes("docie_validation_negative"));
  assert.ok(master.quality.warnings.includes("docie_erreur:missing contact"));
  // Texte repris tel quel : aucun nom de champ n'en est extrait par regex.
  assert.ok(master.quality.warnings.includes(
    "docie_avertissement:experience[0].description truncated: repeated content detected"));
});

test("un champ dont DocIE doute (<= 0.5) devient un « a verifier » sur la BONNE mission apres tri", () => {
  const metadata = {
    ...METADATA_OK,
    // DocIE[0] = Capgemini (2019) : apres tri chronologique, c'est exp_2.
    field_confidence: { "experience[0].title": 0.5, "experience[1].company": 0.2, "contact.email": 0.4 },
  };
  const master = mapperAdbiResume(RESUME_ORDRE_DOCUMENT, metadata, { filename: "cv.pdf" });

  assert.equal(master.experiences[0].company, "Decathlon", "tri chronologique inchange");
  assert.ok(master.quality.needs_review.includes("exp_2.role"), "experience[0] de DocIE = exp_2 apres tri");
  assert.equal(master.quality.needs_review.includes("exp_1.role"), false, "la mission recente n'est pas mise en doute a tort");
  assert.ok(master.quality.needs_review.includes("exp_1.company"));
  // contact.email a un chemin cv_master identique et est surligne par l'ecran de relecture.
  assert.ok(master.quality.needs_review.includes("contact.email"));
});

test("une confiance haute ne signale rien, un champ vide non plus", () => {
  const sansGithub = { ...ADBI_RESUME_COMPLET, contact: { ...ADBI_RESUME_COMPLET.contact, github: "" } };
  const metadata = { ...METADATA_OK, field_confidence: { "contact.github": 0, name: 1, "experience[0].title": 0.9 } };
  const master = mapperAdbiResume(sansGithub, metadata, { filename: "cv.pdf" });

  // Un champ que DocIE n'a pas trouve vaut "" a confiance 0 : c'est une absence,
  // pas une valeur douteuse — la completude s'en charge deja.
  assert.equal(master.quality.needs_review.includes("contact.github"), false);
  assert.equal(master.quality.warnings.some((w) => w.startsWith("docie_confiance_faible")), false);
  assert.equal(master.quality.needs_review.includes("identity.full_name"), false);
});

test("un champ peu sur sans equivalent adressable est signale en avertissement, pas en faux chemin", () => {
  const metadata = { ...METADATA_OK, field_confidence: { "education[0].degree": 0.3, "skills[0].items[1].item": 0.1 } };
  const master = mapperAdbiResume(ADBI_RESUME_COMPLET, metadata, { filename: "cv.pdf" });

  assert.ok(master.quality.warnings.includes("docie_confiance_faible:education[0].degree"));
  assert.ok(master.quality.warnings.includes("docie_confiance_faible:skills[0].items[1].item"));
  assert.equal(master.quality.needs_review.some((r) => r.startsWith("education")), false);
});

test("validation absente : reponse non verifiee, jamais presentee comme un succes", () => {
  const master = mapperAdbiResume(ADBI_RESUME_COMPLET, { ...METADATA_OK, validation: null }, { filename: "cv.pdf" });
  assert.ok(master.quality.warnings.includes("docie_validation_absente"));

  // Validation propre : aucun bruit ajoute.
  const propre = mapperAdbiResume(ADBI_RESUME_COMPLET,
    { ...METADATA_OK, validation: { valid: true, errors: [], warnings: [] } }, { filename: "cv.pdf" });
  assert.equal(propre.quality.warnings.some((w) => w.startsWith("docie_")), false);
});

test("un scalaire encore enveloppe (logprob model_confidence) reste lisible", () => {
  // Si DocIE active la confiance par logprob avant que son deballage ne connaisse
  // la cle, « Alice Dupont » arrive en {value, model_confidence} : sans repli, le
  // dossier exporte afficherait « [object Object] ».
  const data = {
    ...ADBI_RESUME_COMPLET,
    name: { value: "Alice Dupont", model_confidence: 0.82 },
    title: { value: "Data Engineer", confidence: 0.9, model_confidence: 0.4, evidence_ids: ["b2"] },
    interests: [{ interest: { value: "Photographie", model_confidence: 0.7 } }],
  };
  const master = mapperAdbiResume(data, METADATA_OK, { filename: "cv.pdf" });

  assert.equal(master.identity.full_name, "Alice DUPONT");
  assert.equal(master.identity.title, "Data Engineer");
  assert.deepEqual(master.interests, ["Photographie"]);
});

test("une feuille absente reste vide, jamais « [object Object] » dans le dossier", () => {
  // DocIE renvoie null pour une feuille qu'il n'a pas trouvee : {item: null}
  // arrive tel quel apres deballage de l'enveloppe.
  const data = {
    ...ADBI_RESUME_COMPLET,
    skills: [{ category: "Langages", items: [{ item: null }, {}, { item: "Python" }] }],
    interests: [{ interest: null }, {}, "Course à pied"],
    languages: [{ language: { value: null, confidence: 0 }, level: "courant" }, { language: "Anglais", level: null }],
  };
  const master = mapperAdbiResume(data, METADATA_OK, { filename: "cv.pdf" });

  assert.deepEqual(master.skills, [{ label: "Langages", items: ["Python"] }]);
  assert.deepEqual(master.interests, ["Course à pied"]);
  assert.deepEqual(master.languages.map((l) => l.name), ["Anglais"]);
  const texteComplet = JSON.stringify(master);
  assert.equal(texteComplet.includes("[object Object]"), false, "aucun objet converti en texte");
});

test("metadonnees sans champ de relecture : comportement inchange (retrocompatibilite)", () => {
  const avant = mapperAdbiResume(ADBI_RESUME_COMPLET, null, { filename: "cv.pdf" });
  assert.deepEqual(avant.quality.warnings, []);
  assert.deepEqual(avant.quality.needs_review, []);
});

test("le motif « mission en cours » est celui de la fixture partagee avec cv-parser", () => {
  // Comparer le motif, et pas seulement les verdicts : ajouter un synonyme
  // d'un seul cote casse alors le test de l'autre service.
  assert.equal(MOTIF_MISSION_EN_COURS.source, FIXTURE_EN_COURS.motif);
  assert.ok(MOTIF_MISSION_EN_COURS.flags.includes("i"), "insensible a la casse");
});

test("chaque cas du jeu d'essai partage est classe comme cote cv-parser", () => {
  for (const cas of FIXTURE_EN_COURS.cas) {
    assert.equal(missionEnCours(cas.valeur), cas.en_cours, `${cas.valeur} — ${cas.preuve}`);
  }
  assert.equal(FIXTURE_EN_COURS.vide_est_en_cours, true);
  for (const vide of ["", "   ", null, undefined]) {
    assert.equal(missionEnCours(vide), true, "une mission sans date de fin est ouverte");
  }
});

test("#177 lignes 4-6 : « Poste actuel », « Maintenant », fin absente donnent la meme mission en cours", () => {
  // Avant : « Maintenant » etait absent de la liste locale, la mission
  // ressortait TERMINEE avec une date de fin nulle — un consultant en poste
  // presente comme disponible depuis mars 2019.
  for (const fin of ["Poste actuel", "Maintenant", ""]) {
    const master = mapperAdbiResume(
      { name: "Alice Dupont", experience: [{ company: "Numelia", title: "Dev", start_date: "Mars 2019", end_date: fin }] },
      null,
      { filename: "cv.pdf" }
    );
    const mission = master.experiences[0];
    assert.equal(mission.is_current, true, `end_date « ${fin} »`);
    assert.equal(mission.end_date, null, `end_date « ${fin} » : pas de fin fabriquee`);
  }

  // Temoin : une fin reelle reste une fin.
  const terminee = mapperAdbiResume(
    { name: "Alice Dupont", experience: [{ company: "Numelia", title: "Dev", start_date: "Mars 2019", end_date: "Juin 2021" }] },
    null,
    { filename: "cv.pdf" }
  );
  assert.equal(terminee.experiences[0].is_current, false);
  assert.equal(terminee.experiences[0].end_date, "2021-06");
});

test("#177 ligne 14 : une formation « 2016 - 2019 » se date de 2019, pas de 2016", () => {
  // `education[].year` est du texte libre cote DocIE : le CV y ecrit aussi bien
  // une annee qu'une plage. On prenait la PREMIERE annee rencontree, donc
  // l'annee d'INSCRIPTION — un master termine en 2019 s'affichait « (2016) »
  // (lib/onepager.js ligne 227) et passait derriere une formation plus ancienne
  // au tri (ligne 228). lib/extract.js, l'autre voie d'extraction, prenait deja
  // la fin de la periode (`period.end || period.start`, ligne 814).
  const annee = (y) =>
    mapperAdbiResume({ education: [{ degree: "Master Informatique", institution: "Lyon 1", year: y }] }, {}, {})
      .education[0].end_year;

  assert.equal(annee("2016 - 2019"), 2019);   // mesure avant correction : 2016
  assert.equal(annee("2016-2019"), 2019);     // sans espaces autour du tiret
  assert.equal(annee("2016 – 2019"), 2019);   // tiret demi-cadratin, frequent en PDF
  assert.equal(annee("2019/2020"), 2020);     // annee scolaire : le diplome est de 2020
  assert.equal(annee("2019"), 2019);          // temoin : annee seule, inchangee
  assert.equal(annee("Septembre 2019"), 2019);
  assert.equal(annee("en cours"), null);      // aucune annee a en tirer

  // Meme champ, meme lecture, pour les certifications.
  const cert = mapperAdbiResume(
    { certifications: [{ name: "AWS Solutions Architect", year: "2018 - 2021", issuer: "Amazon" }] }, {}, {}
  );
  assert.equal(cert.certifications[0].year, 2021);
});

test("decouperDescription: puces multi-lignes vs paragraphe unique", () => {
  const multi = decouperDescription("Pilotage de la plateforme.\nMigration de 40 pipelines vers Databricks.\nRéduction du coût cloud de 30%.");
  assert.equal(multi.context, "");
  assert.equal(multi.highlights.length, 3);

  const court = decouperDescription("Stage");
  assert.equal(court.context, "Stage");
  assert.deepEqual(court.highlights, []);
});

test("le cv_master mappe reste exploitable par lib/onepager#build (edition/export downstream inchanges)", () => {
  const master = mapperAdbiResume(ADBI_RESUME_COMPLET, METADATA_OK, { filename: "cv.pdf" });
  const onePager = build(master, { template: "adbi_16_9" });
  assert.ok(onePager && onePager.header, "build() produit un cv_onepager exploitable");
  assert.equal(onePager.header.title, "Data Engineer");
  assert.ok(Array.isArray(onePager.experiences));
  assert.ok(onePager.experiences.length > 0);
});
