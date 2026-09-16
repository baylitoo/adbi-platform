"use strict";
// Contrôle des chiffres de la zone de lecture automatique (MRZ) lue par DocIE
// sur une pièce d'identité, importé par lib/cni-mapping.js. Portage JS de
// document-parsing/mappings/mrz.py (voir son en-tête pour le détail des choix
// et des réserves).
//
// POURQUOI, et où c'est écrit dans le dépôt : document-parsing/models/
// catalogue.json, tâche "cni" (clé `taches`), donne NuExtract3 par la voie vision avec pour
// `prerequis` « Contrôle des chiffres de la MRZ. ». Ce module EST ce
// prérequis. Même conception que lib/siren-siret.js (#201) et lib/iban-bic.js
// (#209) : un validateur par langage, importé par les mappings.
//
// FORMAT MODÉLISÉ : TD1, trois lignes de 30 caractères, celui de la carte
// nationale d'identité française depuis 2021. Seules les LIGNES 1 ET 2 sont
// contrôlées : elles portent la totalité des chiffres de contrôle. La ligne 3
// ne porte que les noms, déjà demandés en clair par `surname` /
// `given_names`.
// NON VÉRIFIÉ : « la carte française postérieure à 2021 est au format TD1 »
// est cité de mémoire, aucune source n'ayant pu être consultée (hors réseau).
// Une carte d'un autre format sort en « format_invalide » : faux positif
// BRUYANT, jamais une perte de donnée. L'ancienne carte (avant 2021, deux
// lignes de 36 d'un format national) n'est PAS couverte.
//
// Règle ICAO 9303 : « < » vaut 0, un chiffre sa valeur, A=10 … Z=35 ; poids
// 7, 3, 1 répétés ; chiffre de contrôle = somme pondérée modulo 10.
//
// Règle PARTAGÉE : document-parsing/fixtures/mrz.json, exécutée cas par cas
// par les tests des deux langages, messages exacts compris. Ce fichier n'est
// lu QUE par les tests, jamais ici : l'image Docker de contrats ne copie que
// des fixtures nommées une à une.
//
// Échec : valeur CONSERVÉE, avertissement nommé, `statut` lisible par machine.
// Un consommateur n'utilise une valeur de la MRZ que si son statut vaut
// exactement "valide".

const ABSENT = "absent";
const FORMAT_INVALIDE = "format_invalide";
const NON_CONTROLE = "non_controle";
const CLE_INVALIDE = "cle_invalide";
const VALIDE = "valide";
const STATUTS = [ABSENT, FORMAT_INVALIDE, NON_CONTROLE, CLE_INVALIDE, VALIDE];

// Motif PARTAGÉ, identique caractère pour caractère au littéral Python et au
// champ `motif_separateurs` de la fixture. PAS de tiret, à la différence de
// lib/iban-bic.js : « - » n'est pas un caractère de MRZ.
const MOTIF_SEPARATEURS = "[ \\t\\n\\r\\u00a0\\u202f]";
const SEPARATEURS_RE = new RegExp(MOTIF_SEPARATEURS, "g");
// Majuscules ASCII seulement : toUpperCase() ferait de « ı » un « I » valide.
const MINUSCULES_ASCII_RE = /[a-z]/g;

// Longueur d'une ligne TD1.
const LONGUEUR_LIGNE = 30;
const LIGNE_RE = new RegExp("^[A-Z0-9<]{" + LONGUEUR_LIGNE + "}$");

// Poids ICAO 9303, répétés sur la chaîne contrôlée.
const POIDS = [7, 3, 1];

// Tranches contrôlées, comptées à partir de 0 : [ligne, début, fin, position
// du chiffre]. Le composite est l'assemblage décrit par ICAO 9303 partie 5,
// CITÉ DE MÉMOIRE et non relu (voir `_composite` dans la fixture).
const NUMERO = ["ligne1", 5, 14, 14];
const NAISSANCE = ["ligne2", 0, 6, 6];
const EXPIRATION = ["ligne2", 8, 14, 14];
const COMPOSITE = [[[1, 5, 30], [2, 0, 7], [2, 8, 15], [2, 18, 29]], 29];

// Nom du champ DocIE (schéma "cni") qui porte chaque ligne : c'est lui qui
// nomme l'avertissement.
const CHAMPS = { ligne1: "mrz_line1", ligne2: "mrz_line2" };

function compacter(texte) {
  return texte.replace(SEPARATEURS_RE, "").replace(MINUSCULES_ASCII_RE, (c) => c.toUpperCase());
}

// Valeur ICAO 9303 d'un caractère de MRZ.
function valeurCaractere(caractere) {
  if (caractere === "<") return 0;
  const code = caractere.charCodeAt(0);
  return (code >= 48 && code <= 57) ? code - 48 : code - 55;
}

// Somme des valeurs pondérées par 7, 3, 1 répétés, modulo 10.
function chiffreControle(chaine) {
  let somme = 0;
  for (let index = 0; index < chaine.length; index++) {
    somme += valeurCaractere(chaine[index]) * POIDS[index % 3];
  }
  return String(somme % 10);
}

function controlerLigne(brut) {
  if (brut === null || brut === undefined) return { valeur: "", compact: null, statut: ABSENT };
  const texte = String(brut);
  const compact = compacter(texte);
  if (compact === "") return { valeur: texte, compact: null, statut: ABSENT };
  if (!LIGNE_RE.test(compact)) return { valeur: texte, compact: null, statut: FORMAT_INVALIDE };
  return { valeur: texte, compact, statut: VALIDE };
}

// Statut d'un chiffre dont la ou les lignes ne sont pas exploitables : ABSENT
// si aucune n'a été lue, NON_CONTROLE si l'une a été lue mais mal formée (son
// propre avertissement nomme déjà la cause). null si tout est exploitable.
function statutHote(lignes) {
  if (lignes.every((ligne) => ligne.statut === ABSENT)) return ABSENT;
  if (lignes.some((ligne) => ligne.statut !== VALIDE)) return NON_CONTROLE;
  return null;
}

function controlerChiffre(ligne, debut, fin, position) {
  const indisponible = statutHote([ligne]);
  if (indisponible !== null) return { valeur: "", cle_lue: null, cle_calculee: null, statut: indisponible };
  const valeur = ligne.compact.slice(debut, fin);
  const lue = ligne.compact[position];
  const calculee = chiffreControle(valeur);
  return { valeur, cle_lue: lue, cle_calculee: calculee, statut: lue === calculee ? VALIDE : CLE_INVALIDE };
}

function controlerComposite(ligne1, ligne2) {
  const indisponible = statutHote([ligne1, ligne2]);
  if (indisponible !== null) return { valeur: "", cle_lue: null, cle_calculee: null, statut: indisponible };
  const compacts = { 1: ligne1.compact, 2: ligne2.compact };
  const [tranches, position] = COMPOSITE;
  const valeur = tranches.map(([numero, debut, fin]) => compacts[numero].slice(debut, fin)).join("");
  const lue = compacts[2][position];
  const calculee = chiffreControle(valeur);
  return { valeur, cle_lue: lue, cle_calculee: calculee, statut: lue === calculee ? VALIDE : CLE_INVALIDE };
}

// { ligne1, ligne2, numero_document, date_naissance, date_expiration,
// composite }, dans cet ordre. `valeur` est toujours le texte lu, jamais
// modifié ("" quand il n'y a rien) ; `compact` est la ligne sans séparateurs
// et en majuscules, ou null si elle est absente ou mal formée.
function controlerMrz(ligne1Brut, ligne2Brut) {
  const ligne1 = controlerLigne(ligne1Brut);
  const ligne2 = controlerLigne(ligne2Brut);
  const lignes = { ligne1, ligne2 };
  const controle = { ligne1, ligne2 };
  for (const [nom, [ligne, debut, fin, position]] of [
    ["numero_document", NUMERO], ["date_naissance", NAISSANCE], ["date_expiration", EXPIRATION],
  ]) {
    controle[nom] = controlerChiffre(lignes[ligne], debut, fin, position);
  }
  controle.composite = controlerComposite(ligne1, ligne2);
  return controle;
}

const FIN = " — valeur conservée, à vérifier sur le document";

// Libellé de chaque chiffre contrôlé et ligne qui le porte.
const LIBELLES = {
  numero_document: ["Numéro de document", "ligne1"],
  date_naissance: ["Date de naissance", "ligne2"],
  date_expiration: ["Date d'expiration", "ligne2"],
};

// Messages identiques au caractère près à ceux du portage Python (la fixture
// les compare). `champ` vaut "mrz_line1" ou "mrz_line2".
//
// Un statut NON_CONTROLE ne produit AUCUN message : la ligne qui le cause a
// déjà le sien (« format invalide »), et répéter la même panne quatre fois
// noierait les vraies. Un statut ABSENT non plus : c'est au mapping de dire si
// l'absence de MRZ est un problème.
function messagesMrz(controle) {
  const messages = [];
  for (const nom of ["ligne1", "ligne2"]) {
    const ligne = controle[nom];
    if (ligne.statut === FORMAT_INVALIDE) {
      messages.push({
        champ: CHAMPS[nom],
        message: "MRZ ligne " + nom.slice(-1) + " « " + ligne.valeur + " » : format invalide, "
          + LONGUEUR_LIGNE + " caractères A-Z, 0-9 ou « < » attendus (format TD1)" + FIN,
      });
    }
  }
  for (const [nom, [libelle, ligne]] of Object.entries(LIBELLES)) {
    const entree = controle[nom];
    if (entree.statut === CLE_INVALIDE) {
      messages.push({
        champ: CHAMPS[ligne],
        message: libelle + " « " + entree.valeur + " » de la MRZ : chiffre de contrôle invalide (lu "
          + entree.cle_lue + ", calculé " + entree.cle_calculee + "), caractère probablement mal lu" + FIN,
      });
    }
  }
  const composite = controle.composite;
  if (composite.statut === CLE_INVALIDE) {
    messages.push({
      champ: CHAMPS.ligne2,
      message: "Chiffre de contrôle composite de la MRZ invalide (lu " + composite.cle_lue + ", calculé "
        + composite.cle_calculee + ") : au moins un caractère des lignes 1 et 2 est mal lu" + FIN,
    });
  }
  return messages;
}

module.exports = {
  ABSENT,
  FORMAT_INVALIDE,
  NON_CONTROLE,
  CLE_INVALIDE,
  VALIDE,
  STATUTS,
  MOTIF_SEPARATEURS,
  LONGUEUR_LIGNE,
  POIDS,
  CHAMPS,
  valeurCaractere,
  chiffreControle,
  controlerMrz,
  messagesMrz,
};
