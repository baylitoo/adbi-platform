"use strict";
// Tests de lib/mrz.js — chiffres de contrôle de la MRZ d'une pièce d'identité.
// Pendant JS de document-parsing/mappings/test_mrz.py : les deux exécutent
// chaque cas de document-parsing/fixtures/mrz.json, messages exacts compris,
// et le test d'exécution croisée ci-dessous compare les deux portages sur la
// même fixture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  MOTIF_SEPARATEURS, LONGUEUR_LIGNE, POIDS, STATUTS, FORMAT_INVALIDE, NON_CONTROLE, ABSENT, VALIDE,
  valeurCaractere, chiffreControle, controlerMrz, messagesMrz,
} = require("../lib/mrz");

const RACINE = path.join(__dirname, "..", "..");
const MRZ = require(path.join(RACINE, "document-parsing", "fixtures", "mrz.json"));
const ALPHABET = "<0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHIFFRES = ["numero_document", "date_naissance", "date_expiration", "composite"];
const SPECIMEN = MRZ.cas[0];

function libelle(cas) {
  return JSON.stringify([cas.ligne1, cas.ligne2]) + " (" + cas.preuve + ")";
}

test("mrz : motif, longueur, poids et statuts identiques à la fixture partagée", () => {
  assert.equal(MOTIF_SEPARATEURS, MRZ.motif_separateurs);
  assert.equal(LONGUEUR_LIGNE, MRZ.longueur_ligne);
  assert.deepEqual(POIDS, MRZ.poids);
  assert.deepEqual(STATUTS, MRZ.statuts);
  assert.ok(MRZ._ports.includes("contrats/lib/mrz.js (JS, controle)"));
});

test("mrz : chaque cas du jeu d'essai (statuts, compacts, valeurs, clés, messages exacts)", () => {
  for (const cas of MRZ.cas) {
    const controle = controlerMrz(cas.ligne1, cas.ligne2);
    for (const nom of ["ligne1", "ligne2"]) {
      assert.equal(controle[nom].statut, cas.statuts[nom], libelle(cas) + " " + nom);
      assert.equal(controle[nom].compact, cas.compacts[nom], libelle(cas) + " " + nom);
      // Valeur lue CONSERVÉE, jamais modifiée.
      assert.equal(controle[nom].valeur, cas[nom] === null ? "" : String(cas[nom]), libelle(cas) + " " + nom);
    }
    for (const nom of CHIFFRES) {
      assert.equal(controle[nom].statut, cas.statuts[nom], libelle(cas) + " " + nom);
      assert.equal(controle[nom].valeur, cas.valeurs[nom], libelle(cas) + " " + nom);
      assert.deepEqual([controle[nom].cle_lue, controle[nom].cle_calculee], cas.cles[nom], libelle(cas) + " " + nom);
    }
    assert.deepEqual(messagesMrz(controle), cas.messages, libelle(cas));
  }
});

test("mrz : chaque statut est exercé par la fixture", () => {
  const vus = new Set(MRZ.cas.flatMap((cas) => Object.values(cas.statuts)));
  assert.deepEqual([...vus].sort(), [...STATUTS].sort());
});

test("mrz : l'arithmétique du chiffre est refaite à la main, sans chiffreControle()", () => {
  // Fige le calcul lui-même — poids 7-3-1 et table A=10..Z=35 — sans dépendre
  // des tranches citées de mémoire (voir `_composite` dans la fixture).
  const cas = MRZ.cas.filter((c) => c.arithmetique);
  assert.equal(cas.length, 1);
  const a = cas[0].arithmetique;
  const produits = [...a.chaine].map((car, i) => valeurCaractere(car) * POIDS[i % 3]);
  const somme = produits.reduce((t, p) => t + p, 0);
  assert.deepEqual(produits, a.produits);
  assert.equal(somme, a.somme);
  assert.equal(String(somme % 10), a.chiffre);
  assert.equal(chiffreControle(a.chaine), a.chiffre);
  const tranche = MRZ.tranches.numero_document;
  assert.equal(cas[0].compacts.ligne1[tranche.chiffre], a.chiffre);
  assert.equal(cas[0].compacts.ligne1.slice(tranche.debut, tranche.fin), a.chaine);
});

test("mrz : table des valeurs", () => {
  assert.equal(valeurCaractere("<"), 0);
  assert.equal(valeurCaractere("0"), 0);
  assert.equal(valeurCaractere("9"), 9);
  assert.equal(valeurCaractere("A"), 10);
  assert.equal(valeurCaractere("Z"), 35);
});

test("mrz : format de ligne, numéro et composite ne s'annoncent pas pareil", () => {
  const libelles = { format: "format invalide", numero: "Numéro de document", composite: "composite" };
  const exemples = {
    format: [SPECIMEN.ligne1.slice(0, -1), SPECIMEN.ligne2],
    numero: [SPECIMEN.ligne1.replace("SPECIMEN1", "SPECIMEM1"), SPECIMEN.ligne2],
    composite: [SPECIMEN.ligne1, SPECIMEN.ligne2.slice(0, -1) + "7"],
  };
  for (const [panne, [l1, l2]] of Object.entries(exemples)) {
    // Un numéro mal lu fait AUSSI échouer le composite : on vérifie que le
    // PREMIER message nomme bien la panne, et elle seule.
    const premier = messagesMrz(controlerMrz(l1, l2))[0].message;
    for (const [autre, texte] of Object.entries(libelles)) {
      assert.equal(premier.includes(texte), autre === panne, panne + " / " + texte);
    }
  }
});

test("mrz : un « non_controle » ne produit aucun message de plus, un « absent » non plus", () => {
  const controle = controlerMrz(SPECIMEN.ligne1.slice(0, -1), SPECIMEN.ligne2);
  assert.equal(controle.numero_document.statut, NON_CONTROLE);
  assert.equal(controle.composite.statut, NON_CONTROLE);
  assert.equal(messagesMrz(controle).length, 1);
  const vide = controlerMrz(null, null);
  assert.deepEqual(CHIFFRES.map((nom) => vide[nom].statut), [ABSENT, ABSENT, ABSENT, ABSENT]);
  assert.deepEqual(messagesMrz(vide), []);
  assert.equal(controlerMrz(1234, null).ligne1.statut, FORMAT_INVALIDE);
});

test("mrz : couverture MESURÉE sur le spécimen, limites du modulo 10 figées", () => {
  // Voir `_couverture` dans la fixture : une clé à un chiffre ne peut pas
  // refuser toute substitution, à la différence du modulo 97 de l'IBAN. Ce
  // test dit exactement ce qui passe, pour ne pas promettre davantage.
  const lignes = [SPECIMEN.ligne1, SPECIMEN.ligne2];
  const couvertes = [
    new Set([...Array(25).keys()].map((i) => i + 5)),
    new Set([...Array(7).keys(), ...[...Array(7).keys()].map((i) => i + 8), ...[...Array(12).keys()].map((i) => i + 18)]),
  ];
  let total = 0, attrapees = 0, manqueesEnTranche = 0;
  const jamais = [[], []];
  lignes.forEach((ligne, numero) => {
    for (let position = 0; position < ligne.length; position++) {
      let refusees = 0, candidates = 0;
      for (const autre of ALPHABET) {
        if (autre === ligne[position]) continue;
        candidates++;
        const faux = ligne.slice(0, position) + autre + ligne.slice(position + 1);
        const controle = numero === 0 ? controlerMrz(faux, lignes[1]) : controlerMrz(lignes[0], faux);
        if (CHIFFRES.some((nom) => controle[nom].statut !== VALIDE)) {
          refusees++;
        } else if (couvertes[numero].has(position)) {
          const ecart = valeurCaractere(autre) - valeurCaractere(ligne[position]);
          // `=== 0` et non assert.equal : un écart négatif multiple de 10 rend
          // -0, que la comparaison stricte de node:assert distingue de 0.
          assert.ok(ecart % 10 === 0, "ligne " + (numero + 1) + ", position " + position);
          manqueesEnTranche++;
        }
      }
      total += candidates;
      attrapees += refusees;
      if (refusees === 0) jamais[numero].push(position);
    }
  });
  assert.equal(total, 2160);
  assert.equal(attrapees, 1667);
  assert.equal(total - attrapees, 493);
  assert.equal(manqueesEnTranche, 169);
  // Positions qu'AUCUN chiffre ne couvre : code document + code État (ligne 1),
  // sexe et nationalité (ligne 2).
  assert.deepEqual(jamais[0], [0, 1, 2, 3, 4]);
  assert.deepEqual(jamais[1], [7, 15, 16, 17]);
  for (const nombre of ["2160", "1667", "493", "169"]) assert.ok(MRZ._couverture.includes(nombre), nombre);
});

test("mrz : la valeur lue n'est jamais modifiée", () => {
  const brut = "  " + SPECIMEN.ligne1.toLowerCase() + "\n";
  const controle = controlerMrz(brut, null);
  assert.equal(controle.ligne1.valeur, brut);
  assert.equal(controle.ligne1.compact, SPECIMEN.ligne1);
  assert.equal(controle.ligne1.statut, VALIDE);
});

test("mrz : les tranches du code sont celles que la fixture annonce", () => {
  // La fixture redit les tranches pour qu'un lecteur puisse les confronter à
  // ICAO 9303 sans lire le code ; elles ne doivent pas diverger.
  const compacts = { 1: SPECIMEN.compacts.ligne1, 2: SPECIMEN.compacts.ligne2 };
  for (const nom of ["numero_document", "date_naissance", "date_expiration"]) {
    const t = MRZ.tranches[nom];
    assert.equal(compacts[t.ligne].slice(t.debut, t.fin), SPECIMEN.valeurs[nom], nom);
    assert.equal(compacts[t.ligne][t.chiffre], SPECIMEN.cles[nom][0], nom);
  }
  const composite = MRZ.tranches.composite;
  assert.equal(composite.morceaux.map(([ligne, debut, fin]) => compacts[ligne].slice(debut, fin)).join(""),
    SPECIMEN.valeurs.composite);
  assert.equal(compacts[2][composite.chiffre], SPECIMEN.cles.composite[0]);
});

test("mrz : même verdict que le portage Python sur chaque cas (exécution croisée)", (t) => {
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import mrz as m",
    "f = json.load(open(sys.argv[2], encoding='utf-8'))",
    "out = []",
    "for c in f['cas']:",
    "    r = m.controler_mrz(c['ligne1'], c['ligne2'])",
    "    out.append({'controle': r, 'messages': m.messages_mrz(r)})",
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
    path.join(RACINE, "document-parsing", "fixtures", "mrz.json"),
  ], { encoding: "utf-8" });
  assert.equal(python.status, 0, "le contrôleur Python a échoué sur la fixture : " + python.stderr);
  const verdictsPython = JSON.parse(python.stdout);
  assert.equal(verdictsPython.length, MRZ.cas.length);
  MRZ.cas.forEach((cas, i) => {
    const controle = controlerMrz(cas.ligne1, cas.ligne2);
    assert.deepEqual({ controle, messages: messagesMrz(controle) }, verdictsPython[i], libelle(cas));
  });
});

test("mrz : la fixture n'est chargée par aucun module de production", () => {
  const fichiers = [
    path.join(__dirname, "..", "server.js"),
    ...fs.readdirSync(path.join(__dirname, "..", "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(__dirname, "..", "lib", f)),
  ];
  for (const fichier of fichiers) {
    assert.doesNotMatch(fs.readFileSync(fichier, "utf-8"), /["'`][^"'`\n]*mrz\.json["'`]/, fichier);
  }
});
