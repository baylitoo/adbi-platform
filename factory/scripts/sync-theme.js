/**
 * Recopie la charte ADBI dans chaque application.
 *
 * La source unique vit dans `theme/` ; chaque application en garde une copie
 * pour rester autonome (elle doit s'afficher correctement meme lancee seule,
 * sans la Factory). Relancez ce script apres chaque modification de la charte.
 *
 *   node scripts/sync-theme.js
 *
 * La destination se lit dans modules.json : champ `statiques` (dossier des
 * fichiers servis au navigateur, relatif a `dossier`).
 */

const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "..");
const THEME = path.join(RACINE, "theme");
const POLICES = path.join(THEME, "fonts");

// Fichiers de la charte recopies tels quels dans chaque application.
const FICHIERS = ["adbi-theme.css", "adbi-theme.js"];

/** Recopie les .woff2 a cote de la charte : elle les reference en relatif. */
function copierPolices(destination) {
  if (!fs.existsSync(POLICES)) return 0;
  const dossier = path.join(destination, "fonts");
  fs.mkdirSync(dossier, { recursive: true });
  let n = 0;
  for (const fichier of fs.readdirSync(POLICES)) {
    const source = path.join(POLICES, fichier);
    const cible = path.join(dossier, fichier);
    if (fs.existsSync(cible) && fs.statSync(cible).size === fs.statSync(source).size) {
      continue;
    }
    fs.copyFileSync(source, cible);
    n++;
  }
  return n;
}

const config = JSON.parse(
  fs.readFileSync(path.join(RACINE, "modules.json"), "utf8").replace(/^﻿/, "")
);

let copies = 0;
let ignores = 0;

for (const m of config.modules) {
  if (!m.dossier || !m.statiques) continue;

  const destination = path.join(m.dossier, m.statiques);
  if (!fs.existsSync(destination)) {
    console.log(`  [${m.id}] ignore — dossier absent : ${destination}`);
    ignores++;
    continue;
  }

  const polices = copierPolices(destination);
  const ecrits = [];

  for (const fichier of FICHIERS) {
    const contenu = fs.readFileSync(path.join(THEME, fichier), "utf8");
    const cible = path.join(destination, fichier);
    const actuel = fs.existsSync(cible) ? fs.readFileSync(cible, "utf8") : null;
    if (actuel === contenu) continue;
    fs.writeFileSync(cible, contenu);
    ecrits.push(fichier);
  }

  const details = [];
  if (ecrits.length) details.push(ecrits.join(", "));
  if (polices) details.push(`${polices} police(s)`);

  if (details.length) {
    console.log(`  [${m.id}] ${details.join(" + ")} -> ${destination}`);
    copies++;
  } else {
    console.log(`  [${m.id}] deja a jour`);
  }
}

console.log(`\n  ${copies} application(s) mise(s) a jour, ${ignores} ignoree(s).`);
