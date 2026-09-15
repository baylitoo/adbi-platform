"use strict";

/**
 * Taches d'extraction asynchrones (issue #196) : « demarrer -> interroger ».
 *
 * Pourquoi : #194 fait de NuExtract3 le modele par defaut des contrats.
 * L'evaluation de prompt non cachee est mesuree a 60-73 jetons/s pour
 * LFM2.5-2.6B, le plus rapide des deux (NuExtract3 est plus lent, non mesure) ;
 * un contrat de 10-30 pages (~17-30k jetons) represente ~5 min et plus avant
 * la premiere sortie. Le pre-remplissage ne tient donc plus dans une requete
 * HTTP, ni dans les proxys entre le navigateur et nous : le POST repond tout de
 * suite un identifiant (202) et le navigateur interroge l'etat.
 *
 * Meme contrat que one-pager (PR #199, commentaire de #196) :
 *
 *   POST ...             -> 202 { tache: "<uuid>" }
 *   GET  /api/taches/:id -> {
 *     etat: "en_cours" | "terminee" | "echec",
 *     etape?: "en_attente" | "extraction",   // seulement en_cours
 *     position?: number,                      // seulement en_attente (1 = la prochaine)
 *     resultat?: <ce que la route synchrone renvoyait>,   // seulement terminee
 *     erreur?: { code, message, eta_seconds? },           // seulement echec
 *     debut: ISO 8601, fin?: ISO 8601
 *   }
 *   id inconnu ou expire -> 404
 *
 * En memoire et borne :
 *   - MAX_SIMULTANEES (2) extractions a la fois : le nombre du contrat (#196,
 *     les 2 slots de LFM2.5-2.6B dans #194). Au-dela, les requetes attendraient
 *     DANS llama-server et cette attente consommerait le `timeout_seconds` de
 *     DocIE ;
 *   - MAX_EN_ATTENTE (20) taches en file, dans l'ordre d'arrivee : chacune tient
 *     son document en memoire (jusqu'a ~19 Mo, limite du bridge), la file ne
 *     peut donc pas croitre sans limite ; au-dela, `creer` refuse
 *     (FileTachesPleineError -> 503) ;
 *   - une tache terminee (ou en echec) est oubliee TTL_MS (30 min) apres sa fin.
 *     La purge est paresseuse (a chaque creer/obtenir) : aucun minuteur, donc
 *     rien qui retienne le processus, et une horloge injectable pour les tests.
 *
 * Un redemarrage du processus perd les taches : acceptable pour un
 * pre-remplissage que l'utilisateur relance (#196).
 *
 * Echouer bruyamment (#194) : aucune relance automatique, aucun repli ici (et le
 * pre-remplissage de contrat n'a pas de repli local non plus). Une erreur
 * devient un code nomme et un message francais CONSTANT : le texte amont
 * (DocIE, bridge, PostgreSQL) ne sort jamais dans `erreur.message` — il peut
 * porter une cle reflechie ou un chemin interne. Il est journalise cote serveur.
 */

const crypto = require("node:crypto");

const MAX_SIMULTANEES = 2;
const MAX_EN_ATTENTE = 20;
const TTL_MS = 30 * 60 * 1000;

class FileTachesPleineError extends Error {
  constructor(max) {
    super(`Trop de pré-remplissages en attente (${max} maximum) : réessayez dans un instant.`);
    this.name = "FileTachesPleineError";
  }
}

/**
 * Messages des codes nommes du bridge DocIE (document-parsing/bridge/
 * docie-bridge.js, appels fail("…")). Liste relevee dans le bridge, pas
 * supposee. Un code absent de cette table n'est PAS repris tel quel : il
 * devient `interne`.
 *
 * `input` du bridge = ses propres controles locaux (document vide ou trop gros,
 * format non pris en charge) : la route les verifie deja avant le 202, ce code
 * n'arrive donc ici que si les deux controles divergent.
 */
const MESSAGES_BRIDGE = {
  loading: "Modèle en cours de chargement, réessayez dans quelques instants.",
  context: "Contrat trop long pour le modèle d'extraction.",
  timeout: "L'extraction a dépassé le délai imparti.",
  limits: "Document refusé par le service d'extraction : au-delà de ses limites (taille, pages ou blocs OCR).",
  upstream: "Le service d'extraction a répondu en erreur.",
  network: "Service d'extraction injoignable.",
  input: "Document refusé pour l'extraction : vide, trop volumineux ou format non pris en charge.",
  configuration: "Service d'extraction mal configuré.",
  auth: "Accès au service d'extraction refusé (configuration).",
  rate_limit: "Service d'extraction saturé, réessayez plus tard.",
  response: "Réponse du service d'extraction invalide.",
  incomplete: "Extraction inachevée par le service d'extraction.",
  schema: "Le service d'extraction a renvoyé un autre type de document.",
};

/**
 * Erreurs metier levees par lib/docie-contract-import.js::extractContractValues
 * (Error simple portant `code`, pas une DocIEBridgeError). Messages recopies de
 * ce module, constants : un test verifie qu'ils restent identiques a ce qu'il
 * leve reellement.
 */
const MESSAGES_SERVICE = {
  disabled: "Extraction DocIE désactivée (DOCIE_EXTRACTION_ENABLED=false) — saisie manuelle requise.",
  input: "Aucun fichier reçu.",
};

const MESSAGE_INTERNE = "Pré-remplissage impossible : erreur interne.";

/**
 * Erreur -> { code, message, eta_seconds? } presentable a l'utilisateur.
 *
 * - DocIEBridgeError de code connu -> message constant de la table ;
 *   `loading` porte `eta_seconds` (arrondi a la seconde superieure) quand DocIE
 *   l'a annonce ;
 * - erreur metier d'extractContractValues (`disabled`, `input`) -> meme code,
 *   message constant (le texte que ce module ecrit lui-meme) ;
 * - tout le reste, code inconnu compris -> `interne`, message constant.
 *
 * La distinction se fait sur le nom : le bridge ET extractContractValues
 * utilisent tous deux le code `input`, avec des textes differents (anglais cote
 * bridge).
 */
function mapperErreur(e) {
  const code = e && typeof e.code === "string" ? e.code : null;
  if (code && e.name === "DocIEBridgeError" && Object.hasOwn(MESSAGES_BRIDGE, code)) {
    if (code === "loading") {
      const eta = e.eta_seconds;
      if (typeof eta === "number" && Number.isFinite(eta) && eta >= 0) {
        const n = Math.ceil(eta);
        return { code, message: `Modèle en cours de chargement, réessayez dans ~${n} s.`, eta_seconds: n };
      }
    }
    return { code, message: MESSAGES_BRIDGE[code] };
  }
  if (code && e.name !== "DocIEBridgeError" && Object.hasOwn(MESSAGES_SERVICE, code)) {
    return { code, message: MESSAGES_SERVICE[code] };
  }
  return { code: "interne", message: MESSAGE_INTERNE };
}

/**
 * @param {object} [options]
 * @param {number} [options.maxSimultanees]
 * @param {number} [options.maxEnAttente]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.maintenant] horloge en ms (injectable)
 * @param {(e: Error) => void} [options.journal] erreur brute, cote serveur seulement
 */
function creerGestionnaire({
  maxSimultanees = MAX_SIMULTANEES,
  maxEnAttente = MAX_EN_ATTENTE,
  ttlMs = TTL_MS,
  maintenant = Date.now,
  journal = (e) => console.error("[tache]", e && e.code, e && e.message),
} = {}) {
  const taches = new Map();   // id -> tache (en attente, en cours, finie non expiree)
  const file = [];            // taches en attente, ordre d'arrivee
  let enCours = 0;

  function purger() {
    const t = maintenant();
    for (const [id, tache] of taches) {
      if (tache.fin !== null && t - tache.fin >= ttlMs) taches.delete(id);
    }
  }

  function demarrerSuivantes() {
    while (enCours < maxSimultanees && file.length) {
      const tache = file.shift();
      const travail = tache.travail;
      // Le travail retient le document (base64) : on le lache des le demarrage
      // pour qu'une tache finie ne garde que son resultat.
      tache.travail = null;
      tache.etape = "extraction";
      enCours++;
      Promise.resolve()
        .then(travail)
        .then(
          (resultat) => { tache.etat = "terminee"; tache.resultat = resultat; },
          (e) => { tache.etat = "echec"; tache.erreur = mapperErreur(e); journal(e); }
        )
        .finally(() => {
          tache.fin = maintenant();
          tache.etape = null;
          enCours--;
          demarrerSuivantes();
        });
    }
  }

  /**
   * Met un travail en file et rend son identifiant sans l'attendre.
   * @param {() => Promise<any>} travail
   * @returns {string}
   */
  function creer(travail) {
    purger();
    if (file.length >= maxEnAttente) throw new FileTachesPleineError(maxEnAttente);
    const id = crypto.randomUUID();
    const tache = {
      id, travail, etat: "en_cours", etape: "en_attente",
      resultat: undefined, erreur: undefined, debut: maintenant(), fin: null,
    };
    taches.set(id, tache);
    file.push(tache);
    demarrerSuivantes();
    return id;
  }

  /** Vue publique d'une tache, ou null si inconnue ou expiree. */
  function obtenir(id) {
    purger();
    const tache = typeof id === "string" ? taches.get(id) : undefined;
    if (!tache) return null;
    const vue = { etat: tache.etat };
    if (tache.etat === "en_cours") {
      vue.etape = tache.etape;
      if (tache.etape === "en_attente") vue.position = file.indexOf(tache) + 1;
    }
    if (tache.etat === "terminee") vue.resultat = tache.resultat;
    if (tache.etat === "echec") vue.erreur = tache.erreur;
    vue.debut = new Date(tache.debut).toISOString();
    if (tache.fin !== null) vue.fin = new Date(tache.fin).toISOString();
    return vue;
  }

  /** Compteurs, pour les tests et le diagnostic. */
  function statistiques() {
    return { enCours, enAttente: file.length, conservees: taches.size };
  }

  return { creer, obtenir, statistiques };
}

module.exports = {
  creerGestionnaire, mapperErreur, FileTachesPleineError,
  MESSAGES_BRIDGE, MESSAGES_SERVICE, MESSAGE_INTERNE,
  MAX_SIMULTANEES, MAX_EN_ATTENTE, TTL_MS,
};
