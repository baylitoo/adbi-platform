"use strict";
// Contrôle de plausibilité des dates lues par DocIE. Portage JS de
// document-parsing/mappings/date_plausible.py (voir son en-tête pour le détail
// des choix).
//
// Pourquoi (#194, liste retenue) : pour l'attestation URSSAF et l'attestation
// de régularité fiscale, LFM2.5-350M n'est proposé « que derrière nos
// contrôles de plausibilité de date ». Une date fausse ne se repère pas à l'œil
// (#170) : ce module en fait un échec NOMMÉ et lisible par machine.
//
// Ce que ce module N'ÉCRIT PAS : ni normaliseur de date, ni fenêtre d'années.
// normalizeDate et ANNEE_MIN / ANNEE_MAX (1950-2100, date_docie.json) sont
// IMPORTÉS de lib/kbis-mapping.js : une date avant 1950 y est déjà refusée en
// « date impossible », distincte de « date non reconnue ». Seuls contrôles
// nouveaux : « dans le futur » sur une date, et l'ordre entre deux dates.
//
// Statuts : absent | non_reconnue | impossible | future | incoherente |
// plausible. Un consommateur n'utilise une date que si son statut vaut
// exactement "plausible".
//
// Date du jour INJECTABLE (`aujourdhui`, AAAA-MM-JJ), date locale par défaut.
// Comparaisons sur le texte ISO, jamais par new Date() (qui reporte un
// 30 février au 2 mars).
//
// Règle PARTAGÉE : document-parsing/fixtures/date_plausible.json, exécutée cas
// par cas par les tests des deux langages, messages exacts compris. Jamais lue
// ici : l'image Docker de contrats ne copie que des fixtures nommées une à une.
const { normalizeDate, ANNEE_MIN, ANNEE_MAX } = require("./kbis-mapping");

const ABSENT = "absent";
const NON_RECONNUE = "non_reconnue";
const IMPOSSIBLE = "impossible";
const FUTURE = "future";
const INCOHERENTE = "incoherente";
const PLAUSIBLE = "plausible";
const STATUTS = [ABSENT, NON_RECONNUE, IMPOSSIBLE, FUTURE, INCOHERENTE, PLAUSIBLE];

const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

// Marqueur du normaliseur partagé pour une date lue mais refusée (règle
// `_avertissement` de date_docie.json).
const MARQUEUR_IMPOSSIBLE = "date impossible";

// Date locale du jour, AAAA-MM-JJ (même valeur que date.today() côté Python).
function dateDuJour(maintenant = new Date()) {
  const deux = (n) => String(n).padStart(2, "0");
  return String(maintenant.getFullYear()).padStart(4, "0") + "-" + deux(maintenant.getMonth() + 1) + "-" + deux(maintenant.getDate());
}

function majusculeInitiale(texte) {
  return texte.charAt(0).toUpperCase() + texte.slice(1);
}

// valeurs : { champ DocIE: valeur brute }, dans l'ordre d'affichage.
// ordre : paires [avant, apres] — `avant` ne peut pas suivre `apres`.
// futurAdmis : champs qui PEUVENT être dans le futur (fin de validité).
// Rend { champ: { valeur, date, statut } } : `valeur` est le texte lu, jamais
// modifié ("" si absent), `date` la date ISO lue (conservée même « future » ou
// « incoherente »), sinon "".
function controlerDates(valeurs, { ordre = [], futurAdmis = [], aujourdhui = null } = {}) {
  const jour = aujourdhui === null || aujourdhui === undefined ? dateDuJour() : aujourdhui;
  if (typeof jour !== "string" || !ISO_RE.test(jour)) {
    throw new Error("aujourdhui doit être une date AAAA-MM-JJ, reçu " + JSON.stringify(jour));
  }
  const admis = new Set(futurAdmis);
  const controle = {};
  for (const [champ, brut] of Object.entries(valeurs)) {
    const texte = brut === null || brut === undefined ? "" : String(brut);
    if (texte.trim() === "") {
      controle[champ] = { valeur: texte, date: "", statut: ABSENT };
      continue;
    }
    const avertissements = [];
    const iso = normalizeDate(brut, champ, avertissements);
    let statut;
    if (iso === "") {
      const impossible = avertissements.length > 0 && avertissements[0].includes(MARQUEUR_IMPOSSIBLE);
      statut = impossible ? IMPOSSIBLE : NON_RECONNUE;
    } else if (!admis.has(champ) && iso > jour) {
      statut = FUTURE;
    } else {
      statut = PLAUSIBLE;
    }
    controle[champ] = { valeur: texte, date: iso, statut };
  }
  for (const [avant, apres] of ordre) {
    const a = controle[avant];
    const b = controle[apres];
    if (a.statut === PLAUSIBLE && b.statut === PLAUSIBLE && a.date > b.date) {
      a.statut = INCOHERENTE;
      b.statut = INCOHERENTE;
    }
  }
  return controle;
}

// Messages destinés au relecteur, identiques au caractère près à ceux du
// portage Python. `libelles` donne le nom en minuscules de chaque champ. Un
// statut « absent » ne produit aucun message : au mapping de dire si l'absence
// d'une date donnée est un problème.
function messagesDates(controle, libelles, { ordre = [] } = {}) {
  const messages = [];
  for (const [champ, entree] of Object.entries(controle)) {
    const libelle = majusculeInitiale(libelles[champ]);
    if (entree.statut === NON_RECONNUE) {
      messages.push({
        champ,
        message: libelle + " « " + entree.valeur + " » : date illisible, format non reconnu"
          + " — à ressaisir depuis le document",
      });
    } else if (entree.statut === IMPOSSIBLE) {
      messages.push({
        champ,
        message: libelle + " « " + entree.valeur + " » : date impossible, hors calendrier ou hors "
          + ANNEE_MIN + "-" + ANNEE_MAX + " — à vérifier sur le document",
      });
    } else if (entree.statut === FUTURE) {
      messages.push({
        champ,
        message: libelle + " « " + entree.date + " » : date dans le futur, invraisemblable sur une pièce"
          + " déjà délivrée — valeur conservée, à vérifier sur le document",
      });
    }
  }
  for (const [avant, apres] of ordre) {
    const a = controle[avant];
    const b = controle[apres];
    if (a.statut === INCOHERENTE && b.statut === INCOHERENTE) {
      messages.push({
        champ: avant,
        message: "Dates incohérentes : " + libelles[avant] + " « " + a.date + " », " + libelles[apres]
          + " « " + b.date + " » — la première ne peut pas suivre la seconde, l'une des deux"
          + " est mal lue — valeurs conservées, à vérifier sur le document",
      });
    }
  }
  return messages;
}

module.exports = {
  ABSENT,
  NON_RECONNUE,
  IMPOSSIBLE,
  FUTURE,
  INCOHERENTE,
  PLAUSIBLE,
  STATUTS,
  dateDuJour,
  controlerDates,
  messagesDates,
};
