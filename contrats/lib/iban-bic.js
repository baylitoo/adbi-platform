"use strict";
// Contrôle de l'IBAN et du BIC lus par DocIE sur un RIB, importé par
// lib/rib-mapping.js. Portage JS de document-parsing/mappings/iban_bic.py
// (voir son en-tête pour le détail des choix).
//
// Pourquoi (#194, liste retenue, ligne RIB, règle « échouer bruyamment ») :
// LFM2.5-350M n'est proposé pour le RIB que « derrière IBAN mod-97 + format
// BIC ». Un IBAN mal lu d'un seul caractère ressemble exactement à un IBAN
// juste. Même conception que lib/siren-siret.js (PR #201).
//
// Règle PARTAGÉE : document-parsing/fixtures/iban_bic.json, exécutée cas par
// cas par les tests des deux langages, messages exacts compris. Ce fichier
// n'est lu QUE par les tests, jamais ici : l'image Docker de contrats ne copie
// que des fixtures nommées une à une.
//
// Clé RIB française : NON implémentée, faute de norme consultable (voir
// `_cle_rib` dans la fixture). Pays discordant : porté par le BIC seul, le pays
// de l'IBAN étant couvert par sa clé.
//
// Échec : valeur CONSERVÉE, avertissement nommé, `statut` lisible par machine.
// Un consommateur n'utilise un IBAN ou un BIC que si son statut vaut
// exactement "valide".

const ABSENT = "absent";
const FORMAT_INVALIDE = "format_invalide";
const CLE_INVALIDE = "cle_invalide";
const PAYS_DISCORDANT = "pays_discordant";
const VALIDE = "valide";
const STATUTS = [ABSENT, FORMAT_INVALIDE, CLE_INVALIDE, PAYS_DISCORDANT, VALIDE];

// Motif PARTAGÉ, identique caractère pour caractère au littéral Python et au
// champ `motif_separateurs` de la fixture.
const MOTIF_SEPARATEURS = "[ \\t\\n\\r\\u00a0\\u202f\\-]";
const SEPARATEURS_RE = new RegExp(MOTIF_SEPARATEURS, "g");
// Majuscules ASCII seulement : toUpperCase() ferait de « ı » un « I » valide.
const MINUSCULES_ASCII_RE = /[a-z]/g;
const IBAN_RE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/;
const BIC_RE = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;

// FR seulement : voir `_longueurs` dans la fixture.
const LONGUEURS_IBAN = { FR: 27 };

function compacter(texte) {
  return texte.replace(SEPARATEURS_RE, "").replace(MINUSCULES_ASCII_RE, (c) => c.toUpperCase());
}

// Reste ISO 7064 MOD 97-10 de l'IBAN réordonné, caractère par caractère (le
// grand entier n'est jamais construit, comme côté Python).
function modulo97(compact) {
  let reste = 0;
  for (const caractere of compact.slice(4) + compact.slice(0, 4)) {
    const code = caractere.charCodeAt(0);
    reste = (code >= 48 && code <= 57) ? (reste * 10 + (code - 48)) % 97 : (reste * 100 + (code - 55)) % 97;
  }
  return reste;
}

function controlerIban(brut) {
  if (brut === null || brut === undefined) return { valeur: "", compact: null, pays: null, statut: ABSENT };
  const texte = String(brut);
  const compact = compacter(texte);
  if (compact === "") return { valeur: texte, compact: null, pays: null, statut: ABSENT };
  if (!IBAN_RE.test(compact)) return { valeur: texte, compact: null, pays: null, statut: FORMAT_INVALIDE };
  const pays = compact.slice(0, 2);
  if (Object.hasOwn(LONGUEURS_IBAN, pays) && compact.length !== LONGUEURS_IBAN[pays]) {
    return { valeur: texte, compact: null, pays, statut: FORMAT_INVALIDE };
  }
  return { valeur: texte, compact, pays, statut: modulo97(compact) === 1 ? VALIDE : CLE_INVALIDE };
}

function controlerBic(brut) {
  if (brut === null || brut === undefined) return { valeur: "", compact: null, pays: null, statut: ABSENT };
  const texte = String(brut);
  const compact = compacter(texte);
  if (compact === "") return { valeur: texte, compact: null, pays: null, statut: ABSENT };
  if (!BIC_RE.test(compact)) return { valeur: texte, compact: null, pays: null, statut: FORMAT_INVALIDE };
  return { valeur: texte, compact, pays: compact.slice(4, 6), statut: VALIDE };
}

// { iban: {valeur, compact, pays, statut}, bic: {...} }. Discordance de pays
// évaluée seulement si l'IBAN est "valide" et le BIC bien formé ; portée par
// le BIC seul.
function controlerIbanBic(ibanBrut, bicBrut) {
  const iban = controlerIban(ibanBrut);
  const bic = controlerBic(bicBrut);
  if (iban.statut === VALIDE && bic.statut === VALIDE && bic.pays !== iban.pays) bic.statut = PAYS_DISCORDANT;
  return { iban, bic };
}

const FIN = " — valeur conservée, à vérifier sur le document";

// Messages identiques au caractère près à ceux du portage Python (la fixture
// les compare). `champ` vaut "iban" ou "bic".
function messagesIbanBic(controle) {
  const messages = [];
  const { iban, bic } = controle;
  if (iban.statut === FORMAT_INVALIDE) {
    const detail = Object.hasOwn(LONGUEURS_IBAN, iban.pays || "")
      ? LONGUEURS_IBAN[iban.pays] + " caractères attendus pour un IBAN " + iban.pays
      : "2 lettres de pays, 2 chiffres de clé puis 1 à 30 lettres ou chiffres attendus";
    messages.push({ champ: "iban", message: "IBAN « " + iban.valeur + " » : format invalide, " + detail + FIN });
  } else if (iban.statut === CLE_INVALIDE) {
    messages.push({
      champ: "iban",
      message: "IBAN « " + iban.valeur + " » : clé de contrôle invalide (modulo 97), caractère probablement mal lu" + FIN,
    });
  }
  if (bic.statut === FORMAT_INVALIDE) {
    messages.push({
      champ: "bic",
      message: "BIC « " + bic.valeur + " » : format invalide, 8 ou 11 caractères attendus"
        + " (6 lettres puis 2 ou 5 lettres ou chiffres)" + FIN,
    });
  } else if (bic.statut === PAYS_DISCORDANT) {
    messages.push({
      champ: "bic",
      message: "BIC « " + bic.valeur + " » : pays " + bic.pays + " différent du pays " + iban.pays + " de l'IBAN"
        + " « " + iban.valeur + " », dont la clé est valide — BIC probablement mal lu" + FIN,
    });
  }
  return messages;
}

module.exports = {
  ABSENT,
  FORMAT_INVALIDE,
  CLE_INVALIDE,
  PAYS_DISCORDANT,
  VALIDE,
  STATUTS,
  MOTIF_SEPARATEURS,
  LONGUEURS_IBAN,
  controlerIbanBic,
  messagesIbanBic,
};
