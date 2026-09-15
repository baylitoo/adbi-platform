"use strict";
// Contrôle de la clé de Luhn du SIREN et du SIRET lus par DocIE, commun aux
// deux mappings JS qui les lisent : lib/kbis-mapping.js (`siren`,
// `siret_siege`) et lib/docie-contract-import.js (`st_siren`, `st_siret`).
// Portage JS de document-parsing/mappings/siren_siret.py (voir son en-tête
// pour le détail des choix).
//
// Pourquoi (#194, liste retenue, règle « échouer bruyamment ») : le SIREN et
// le SIRET n'étaient contrôlés qu'en FORMAT (lib/integrations.js::
// normalizeSiren, « 9 ou 14 chiffres »). Un seul chiffre mal lu passait,
// arrivait dans le contrat et alimentait la recherche de fiche société par
// SIREN — la mauvaise société pouvait s'ouvrir sans que rien ne le signale.
//
// Règle PARTAGÉE : document-parsing/fixtures/siren_siret.json, exécutée cas
// par cas par les tests des deux langages, messages exacts compris. Ce
// fichier n'est lu QUE par les tests, jamais ici : l'image Docker de contrats
// ne copie que des fixtures nommées une à une, et le dépôt a déjà livré trois
// fois un fichier absent de l'image. L'algorithme vit donc dans le code.
//
// Échec : valeur CONSERVÉE (un relecteur corrige un chiffre en le voyant ;
// vider SIREN et SIRET ferait en outre basculer un Kbis lisible en « Document
// illisible », #179 B1), avertissement nommé distinct du format, et `statut`
// lisible par machine. Un consommateur n'utilise un numéro que si son statut
// vaut exactement "valide".
//
// La Poste (SIREN 356000000) : la règle particulière de ses SIRET n'a pu être
// vérifiée sur aucune source disponible — elle n'est PAS implémentée. Un tel
// SIRET qui ne passe pas Luhn sort en "cle_invalide" : faux positif bruyant,
// jamais une perte de donnée. Voir `_la_poste` dans la fixture.

const ABSENT = "absent";
const FORMAT_INVALIDE = "format_invalide";
const CLE_INVALIDE = "cle_invalide";
const DISCORDANT = "discordant";
const VALIDE = "valide";
const STATUTS = [ABSENT, FORMAT_INVALIDE, CLE_INVALIDE, DISCORDANT, VALIDE];

// Séparateurs retirés AVANT le contrôle, et seulement pour lui. Motif PARTAGÉ,
// identique caractère pour caractère au littéral Python et au champ
// `motif_separateurs` de la fixture. Pas le \D de integrations.js : il efface
// les lettres, et « 941O91316 » (O lu pour 0) y deviendrait 8 chiffres au lieu
// d'un format invalide nommé. Caractères énumérés plutôt que \s.
const MOTIF_SEPARATEURS = "[ \\t\\n\\r\\u00a0\\u202f.\\-]";
const SEPARATEURS_RE = new RegExp(MOTIF_SEPARATEURS, "g");
// [0-9] et non \d, pour rendre le même verdict que Python sur les chiffres
// non ASCII.
const CHIFFRES_RE = { 9: /^[0-9]{9}$/, 14: /^[0-9]{14}$/ };

// Formule de Luhn : en partant de la droite, un chiffre sur deux est doublé
// (et diminué de 9 s'il dépasse 9) ; la somme doit être multiple de 10.
function luhnValide(chiffres) {
  let somme = 0;
  for (let rang = 0; rang < chiffres.length; rang++) {
    let chiffre = chiffres.charCodeAt(chiffres.length - 1 - rang) - 48;
    if (rang % 2 === 1) {
      chiffre *= 2;
      if (chiffre > 9) chiffre -= 9;
    }
    somme += chiffre;
  }
  return somme % 10 === 0;
}

function controlerUn(brut, longueur) {
  if (brut === null || brut === undefined) return { valeur: "", chiffres: null, statut: ABSENT };
  // Le modèle peut rendre un champ `string` en NOMBRE (#179 A14) : String()
  // en donne le texte, comme str() côté Python.
  const texte = String(brut);
  const compact = texte.replace(SEPARATEURS_RE, "");
  // « Champ vu, rien trouvé » : même règle que les nombres et les dates.
  if (compact === "") return { valeur: texte, chiffres: null, statut: ABSENT };
  if (!CHIFFRES_RE[longueur].test(compact)) return { valeur: texte, chiffres: null, statut: FORMAT_INVALIDE };
  let cleOk = luhnValide(compact);
  // Un SIRET est un SIREN suivi du NIC : ses 9 premiers chiffres portent eux
  // aussi une clé de Luhn (cas 12345678900007 de la fixture).
  if (longueur === 14) cleOk = cleOk && luhnValide(compact.slice(0, 9));
  return { valeur: texte, chiffres: compact, statut: cleOk ? VALIDE : CLE_INVALIDE };
}

// Contrôle un SIREN et un SIRET lus sur le même document. Rend
// { siren: {valeur, chiffres, statut}, siret: {...} }. Deux numéros valides
// chacun de son côté mais dont le SIRET ne commence pas par le SIREN : l'un
// des deux est mal lu sans qu'on sache lequel, les DEUX passent en
// "discordant". Non évaluée si l'un des deux a déjà une clé invalide.
function controlerSirenSiret(sirenBrut, siretBrut) {
  const siren = controlerUn(sirenBrut, 9);
  const siret = controlerUn(siretBrut, 14);
  if (siren.statut === VALIDE && siret.statut === VALIDE && siret.chiffres.slice(0, 9) !== siren.chiffres) {
    siren.statut = DISCORDANT;
    siret.statut = DISCORDANT;
  }
  return { siren, siret };
}

// Messages destinés au relecteur, identiques au caractère près à ceux du
// portage Python (la fixture les compare). `champ` vaut "siren" ou "siret".
function messagesSirenSiret(controle) {
  const messages = [];
  for (const [champ, libelle, longueur] of [["siren", "SIREN", 9], ["siret", "SIRET", 14]]) {
    const entree = controle[champ];
    if (entree.statut === FORMAT_INVALIDE) {
      messages.push({
        champ,
        message: libelle + " « " + entree.valeur + " » : format invalide, " + longueur + " chiffres attendus"
          + " — valeur conservée, à vérifier sur le document",
      });
    } else if (entree.statut === CLE_INVALIDE) {
      messages.push({
        champ,
        message: libelle + " « " + entree.valeur + " » : clé de contrôle invalide, chiffre probablement mal lu"
          + " — valeur conservée, à vérifier sur le document",
      });
    }
  }
  if (controle.siret.statut === DISCORDANT) {
    messages.push({
      champ: "siret",
      message: "SIRET « " + controle.siret.valeur + " » discordant du SIREN « " + controle.siren.valeur + " » :"
        + " ses 9 premiers chiffres devraient être ce SIREN, l'un des deux est mal lu"
        + " — valeurs conservées, à vérifier sur le document",
    });
  }
  return messages;
}

module.exports = {
  ABSENT,
  FORMAT_INVALIDE,
  CLE_INVALIDE,
  DISCORDANT,
  VALIDE,
  STATUTS,
  MOTIF_SEPARATEURS,
  controlerSirenSiret,
  messagesSirenSiret,
};
