"use strict";
// Tests de lib/date-plausible.js — plausibilité des dates lues par DocIE
// (#194). Pendant JS de document-parsing/mappings/test_date_plausible.py : les
// deux exécutent chaque cas de document-parsing/fixtures/date_plausible.json,
// messages exacts compris, et ce fichier exécute en plus le portage Python sur
// la même fixture (exécution croisée).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  STATUTS, NON_RECONNUE, IMPOSSIBLE, FUTURE, INCOHERENTE, PLAUSIBLE,
  dateDuJour, controlerDates, messagesDates,
} = require("../lib/date-plausible");

const RACINE = path.join(__dirname, "..", "..");
const FIXTURE = require(path.join(RACINE, "document-parsing", "fixtures", "date_plausible.json"));
const DATE_DOCIE = require(path.join(RACINE, "document-parsing", "fixtures", "date_docie.json"));

function libelle(cas) {
  return JSON.stringify(cas.valeurs) + " (" + cas.preuve + ")";
}
function controler(cas) {
  return controlerDates(cas.valeurs, {
    ordre: FIXTURE.ordre, futurAdmis: FIXTURE.futur_admis, aujourdhui: cas.aujourdhui || FIXTURE.aujourdhui,
  });
}

test("dates : statuts identiques à la fixture partagée", () => {
  assert.deepEqual(STATUTS, FIXTURE.statuts);
  assert.ok(FIXTURE._ports.includes("contrats/lib/date-plausible.js (JS, controle)"));
});

test("dates : chaque cas du jeu d'essai (statuts, dates, valeur conservée, messages exacts)", () => {
  for (const cas of FIXTURE.cas) {
    const controle = controler(cas);
    assert.deepEqual(Object.keys(controle), Object.keys(cas.valeurs), libelle(cas));
    for (const [champ, brut] of Object.entries(cas.valeurs)) {
      assert.equal(controle[champ].statut, cas.statuts[champ], libelle(cas) + " " + champ);
      assert.equal(controle[champ].date, cas.dates[champ], libelle(cas) + " " + champ);
      assert.equal(controle[champ].valeur, brut === null ? "" : String(brut), libelle(cas) + " " + champ);
    }
    assert.deepEqual(messagesDates(controle, FIXTURE.libelles, { ordre: FIXTURE.ordre }), cas.messages, libelle(cas));
  }
});

test("dates : chaque statut est exercé par la fixture", () => {
  const vus = new Set(FIXTURE.cas.flatMap((cas) => Object.values(cas.statuts)));
  assert.deepEqual([...vus].sort(), [...STATUTS].sort());
});

test("dates : la date du jour injectée est bien lue (cas jumeaux)", () => {
  const jumeaux = FIXTURE.cas.filter((c) => c.valeurs.issued_date === "2026-12-01");
  assert.equal(jumeaux.length, 2);
  assert.deepEqual(new Set(jumeaux.map((c) => controler(c).issued_date.statut)), new Set([FUTURE, PLAUSIBLE]));
});

test("dates : illisible, impossible, futur et incohérent ne s'annoncent pas pareil", () => {
  const libelles = { [NON_RECONNUE]: "date illisible", [IMPOSSIBLE]: "date impossible", [FUTURE]: "dans le futur", [INCOHERENTE]: "Dates incohérentes" };
  const noms = { a: "date a", b: "date b" };
  const exemples = {
    [NON_RECONNUE]: { a: "mars 2026", b: null },
    [IMPOSSIBLE]: { a: "12/05/1949", b: null },
    [FUTURE]: { a: "2026-09-16", b: null },
    [INCOHERENTE]: { a: "2026-03-10", b: "2026-03-04" },
  };
  for (const [statut, valeurs] of Object.entries(exemples)) {
    const controle = controlerDates(valeurs, { ordre: [["a", "b"]], aujourdhui: "2026-09-15" });
    const messages = messagesDates(controle, noms, { ordre: [["a", "b"]] });
    assert.equal(messages.length, 1, statut);
    for (const [autre, texte] of Object.entries(libelles)) {
      assert.equal(messages[0].message.includes(texte), autre === statut, statut + " / " + texte);
    }
  }
});

test("dates : fin de validité admise dans le futur ; période qui finit avant de commencer", () => {
  assert.equal(controlerDates({ valid_until: "2027-03-04" }, { futurAdmis: ["valid_until"], aujourdhui: "2026-09-15" }).valid_until.statut, PLAUSIBLE);
  assert.equal(controlerDates({ valid_until: "2027-03-04" }, { aujourdhui: "2026-09-15" }).valid_until.statut, FUTURE);
  const periode = controlerDates({ debut: "2026-06-01", fin: "2026-01-01" }, { ordre: [["debut", "fin"]], futurAdmis: ["fin"], aujourdhui: "2026-09-15" });
  assert.deepEqual(new Set(Object.values(periode).map((e) => e.statut)), new Set([INCOHERENTE]));
});

test("dates : date du jour par défaut, refus d'une date du jour mal formée", () => {
  assert.match(dateDuJour(), /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  assert.equal(dateDuJour(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(controlerDates({ d: "2100-12-31" }).d.statut, FUTURE);
  for (const mauvais of ["15/09/2026", "2026-9-15", "", 20260915]) {
    assert.throws(() => controlerDates({ d: "2026-01-01" }, { aujourdhui: mauvais }), /aujourdhui/);
  }
});

test("dates : normaliseur et fenêtre IMPORTÉS de lib/kbis-mapping.js, jamais recopiés", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "date-plausible.js"), "utf8");
  assert.ok(/require\("\.\/kbis-mapping"\)/.test(source));
  assert.ok(!/function\s+(normalizeDate|dateExiste|estBissextile|formeEcrite|tableMois)\b|(const|let|var)\s+(normalizeDate|dateExiste|ANNEE_MIN|ANNEE_MAX|JOURS_PAR_MOIS|FR_DATE_RE|ISO_DATE_RE|DATE_ECRITE_RE)\s*=/.test(source),
    "date-plausible.js ne doit PAS redéfinir le normaliseur ni la fenêtre");
  // Aucune borne d'année écrite en dur dans le code (les commentaires la citent).
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\b(1950|2100)\b/.test(code), "seconde fenêtre d'années écrite en dur");
  assert.equal(DATE_DOCIE._ports.length, 4);
  assert.ok(!DATE_DOCIE._ports.some((p) => p.includes("plausible")));

  // Témoin : une copie renommée, require laissé en place, passerait la lecture
  // du source ; elle ne rendrait pas ce témoin.
  const cheminKbis = require.resolve("../lib/kbis-mapping");
  const cheminModule = require.resolve("../lib/date-plausible");
  const kbis = require(cheminKbis);
  const original = kbis.normalizeDate;
  const appels = [];
  delete require.cache[cheminModule];
  try {
    kbis.normalizeDate = (brut, champ, avertissements) => { appels.push(brut); avertissements.push(champ + ": date impossible (TÉMOIN)"); return ""; };
    const { controlerDates: espionne } = require(cheminModule);
    assert.equal(espionne({ d: "2026-01-01" }, { aujourdhui: "2026-09-15" }).d.statut, IMPOSSIBLE);
    assert.deepEqual(appels, ["2026-01-01"]);
  } finally {
    kbis.normalizeDate = original;
    delete require.cache[cheminModule];
  }
});

test("dates : même verdict que le portage Python sur chaque cas (exécution croisée)", (t) => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import date_plausible as m",
    "f = json.load(open(sys.argv[2], encoding='utf-8'))",
    "ordre = [tuple(p) for p in f['ordre']]",
    "out = []",
    "for c in f['cas']:",
    "    r = m.controler_dates(c['valeurs'], ordre=ordre, futur_admis=f['futur_admis'], aujourdhui=c.get('aujourdhui', f['aujourdhui']))",
    "    out.append({'controle': r, 'messages': m.messages_dates(r, f['libelles'], ordre=ordre)})",
    "sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))",
  ].join("\n");
  const interpreteur = process.platform === "win32" ? "python" : "python3";
  // On ne saute QUE si l'interpréteur manque (motif corrigé par #208) : un
  // contrôleur Python cassé doit faire échouer ce test, pas le sauter.
  const sonde = spawnSync(interpreteur, ["-c", "pass"], { encoding: "utf-8" });
  if (sonde.error || sonde.status !== 0) {
    t.skip("Python indisponible : " + (sonde.error ? sonde.error.message : sonde.stderr));
    return;
  }
  const python = spawnSync(interpreteur, [
    "-c", script,
    path.join(RACINE, "document-parsing", "mappings"),
    path.join(RACINE, "document-parsing", "fixtures", "date_plausible.json"),
  ], { encoding: "utf-8" });
  assert.equal(python.status, 0, "le contrôleur Python a échoué sur la fixture : " + python.stderr);
  const verdictsPython = JSON.parse(python.stdout);
  assert.equal(verdictsPython.length, FIXTURE.cas.length);
  FIXTURE.cas.forEach((cas, i) => {
    const controle = controler(cas);
    assert.deepEqual({ controle, messages: messagesDates(controle, FIXTURE.libelles, { ordre: FIXTURE.ordre }) }, verdictsPython[i], libelle(cas));
  });
});

test("dates : la fixture n'est chargée par aucun module de production", () => {
  const fichiers = [
    path.join(__dirname, "..", "server.js"),
    ...fs.readdirSync(path.join(__dirname, "..", "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(__dirname, "..", "lib", f)),
  ];
  for (const fichier of fichiers) {
    assert.doesNotMatch(fs.readFileSync(fichier, "utf-8"), /["'`][^"'`\n]*date_plausible\.json["'`]/, fichier);
  }
});
