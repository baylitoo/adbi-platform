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

const { mapperAdbiResume, decouperDescription } = require("../lib/docie-extract");
const { build } = require("../lib/onepager");

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
