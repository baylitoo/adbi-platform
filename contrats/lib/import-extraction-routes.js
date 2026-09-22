"use strict";

/**
 * Pre-remplissage de l'import de contrat en tache asynchrone (issue #196).
 *
 * Isolees de server.js pour etre testables sans PostgreSQL : server.js exige
 * DATABASE_URL au chargement. Les dependances (extractContractValues, bridge,
 * gestionnaire de taches, env) sont injectees ; server.js passe les vraies.
 *
 * Seul appelant de POST /api/contracts/importer/extraire : public/app.js
 * (preremplirImportDepuisPdf) — verifie par recherche dans tout le depot ; les
 * autres occurrences sont README, .env.example et commentaires, les tests
 * appellent extractContractValues directement. La route passe donc directement
 * en 202 au lieu d'en ajouter une seconde.
 */

const { isEnabled, loadBridge, sniffMime } = require("./docie-extraction");
const { FileTachesPleineError, MESSAGES_SERVICE, TTL_MS } = require("./taches-extraction");
const choixModele = require("./choix-modele");

// Miroir de MIME_TYPES dans document-parsing/bridge/docie-bridge.js (non
// exporte par le bridge) : ce qu'extractDocument accepte. sniffMime reconnait
// aussi image/webp, que le bridge refuse : refuse ici, avant le 202.
const MIME_ACCEPTES = new Set(["application/pdf", "image/png", "image/jpeg"]);

// Express 4 ignore une promesse rejetée : un gestionnaire async passe son échec à next().
const asynchrone = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * @param {import("express").Express} app
 * @param {{
 *   extractContractValues: Function,
 *   gestionnaire: object,
 *   env?: object,
 *   chargerBridge?: () => { MAX_DOCUMENT_BYTES: number },
 *   journal?: (etiquette: string, e: any) => void,
 * }} deps
 */
function monterPreremplissage(app, {
  extractContractValues,
  gestionnaire,
  env = process.env,
  chargerBridge = loadBridge,
  journal = (etiquette, e) => console.error(etiquette, e && e.code, e && e.message),
}) {
  /**
   * POST /api/contracts/importer/extraire { mimeType, dataBase64 } -> 202 { tache }
   *
   * Validation synchrone, avant toute tache — memes controles et meme statut
   * (400 { error, code }) qu'avant, mais messages francais constants (l'ancienne
   * route renvoyait le texte anglais du bridge) :
   *   - flag DOCIE_EXTRACTION_ENABLED -> `disabled` ;
   *   - fichier absent -> `input` ;
   *   - format hors PDF/PNG/JPEG (apres detection par signature) -> `input` ;
   *   - vide ou au-dela de MAX_DOCUMENT_BYTES du bridge -> `input`.
   * La configuration DocIE (URL, cle, agent) reste verifiee par le bridge, dans
   * la tache : echec `configuration` au premier releve.
   *
   * Le resultat de la tache est exactement l'ancienne reponse synchrone :
   * { requestId, values, warnings, errors, ok }. Rien n'est ecrit en base.
   */
  app.post("/api/contracts/importer/extraire", asynchrone(async (req, res) => {
    const { mimeType, dataBase64 } = req.body || {};
    if (!isEnabled(env)) {
      return res.status(400).json({ error: MESSAGES_SERVICE.disabled, code: "disabled" });
    }
    if (!dataBase64 || typeof dataBase64 !== "string") {
      return res.status(400).json({ error: MESSAGES_SERVICE.input, code: "input" });
    }

    let maxOctets;
    try {
      // Paresseux, comme extractContractValues : flag coupe = bridge jamais requis.
      maxOctets = chargerBridge().MAX_DOCUMENT_BYTES;
    } catch (e) {
      journal("[contracts/importer/extraire] bridge", e);
      return res.status(500).json({ error: "Pré-remplissage impossible : erreur interne.", code: "interne" });
    }
    const buffer = Buffer.from(dataBase64, "base64");
    if (!MIME_ACCEPTES.has(sniffMime(mimeType, buffer))) {
      return res.status(400).json({ error: "Format non pris en charge : PDF, PNG ou JPEG.", code: "input" });
    }
    if (!buffer.length || buffer.length > maxOctets) {
      return res.status(400).json({
        error: `Document vide ou trop volumineux (${Math.floor(maxOctets / (1024 * 1024))} Mo maximum).`,
        code: "input",
      });
    }

    // Modele choisi (#194) : refuse avant le 202 s'il n'est pas configure. La
    // regle des 800 lignes, elle, se verifie dans la tache, sur le texte lu.
    let modele;
    try {
      modele = choixModele.demandeModele(req.body);
      if (modele !== null) await choixModele.rafraichirStore(env);
      if (modele !== null) choixModele.verifierDemande("contract", modele, { env });
    } catch (e) {
      if (e && e.name === "ErreurChoixModele") return res.status(400).json({ error: e.message, code: e.code });
      journal("[contracts/importer/extraire] catalogue", e);
      return res.status(500).json({ error: "Pré-remplissage impossible : erreur interne.", code: "interne" });
    }

    try {
      // Seuls ces champs entrent dans la tache : ni req, ni req.body (dont
      // rawBody, copie brute du JSON recu). Le gestionnaire lache ce travail des
      // son demarrage.
      const corps = { mimeType, dataBase64 };
      if (modele !== null) corps.modele = modele;
      const tache = gestionnaire.creer(() => extractContractValues(corps));
      res.status(202).json({ tache });
    } catch (e) {
      if (e instanceof FileTachesPleineError) return res.status(503).json({ error: e.message });
      journal("[contracts/importer/extraire]", e);
      res.status(500).json({ error: "Pré-remplissage impossible : erreur interne.", code: "interne" });
    }
  }));

  /**
   * GET /api/taches/:id -> etat de la tache (contrat : lib/taches-extraction.js).
   *
   * Aucune identite utilisateur dans ce service : seul un code partage protege
   * l'ecran Parametres (exigerCodeParametres sur /api/settings et
   * /api/templates-perso), aucune session ni utilisateur ailleurs. La regle
   * « seul l'auteur lit sa tache » n'a donc rien sur quoi s'appuyer ; la
   * protection est l'identifiant lui-meme, crypto.randomUUID() (122 bits
   * aleatoires), jamais liste nulle part — comme one-pager.
   */
  app.get("/api/taches/:id", (req, res) => {
    const vue = gestionnaire.obtenir(req.params.id);
    if (!vue) {
      return res.status(404).json({
        error: `Tâche inconnue ou expirée (conservée ${Math.round(TTL_MS / 60000)} min après sa fin, ` +
          "perdue au redémarrage du service) : relancez le pré-remplissage.",
      });
    }
    res.json(vue);
  });

  /**
   * GET /api/modeles?tache=contract|urssaf|rib|kbis[&voie=texte|agent] ->
   * { tache, voie?, modeles: [{ id, libelle, description, role, lignesMax }] }
   * (#194), defaut d'abord.
   *
   * Monte ici plutot que dans server.js pour garder server.js intact. Sert les
   * quatre selecteurs de ce service : pre-remplissage de contrat, analyses
   * URSSAF, RIB et Kbis.
   * `voie` (Kbis seulement, « choisi par type d'entree ») : offres de la voie du
   * fichier choisi dans le navigateur (PDF -> texte, image -> agent). Elle ne
   * decide jamais de la voie de l'extraction : le serveur la tranche sur le
   * fichier recu (lib/docie-extraction.js::extractParType). Voie non admise pour
   * la tache -> 400.
   * Aucun identifiant reel (`store:<nom>`, nom d'agent) dans la reponse. Flag
   * DocIE coupe ou rien de configure -> liste vide : le navigateur n'affiche
   * aucun selecteur et n'envoie aucun `modele`, soit exactement le comportement
   * d'avant.
   */
  app.get("/api/modeles", asynchrone(async (req, res) => {
    const tache = String((req.query && req.query.tache) || "");
    if (!Object.hasOwn(choixModele.TACHES, tache)) {
      return res.status(400).json({ error: "Tâche sans sélecteur de modèle.", code: "tache" });
    }
    const voie = req.query && req.query.voie !== undefined ? String(req.query.voie) : null;
    if (voie !== null && !choixModele.voiesDe(tache).includes(voie)) {
      return res.status(400).json({ error: "Voie inconnue pour cette tâche.", code: "voie" });
    }
    const entete = voie !== null ? { tache, voie } : { tache };
    if (!isEnabled(env)) return res.json({ ...entete, modeles: [] });
    try {
      await choixModele.rafraichirStore(env);
      res.json({ ...entete, modeles: choixModele.offresPubliques(tache, { env, voie }) });
    } catch (e) {
      journal("[modeles]", e);
      const code = e && e.name === "ErreurChoixModele" ? e.code : "interne";
      res.status(500).json({ error: choixModele.MESSAGES_CHOIX.configuration, code });
    }
  }));
}

module.exports = { monterPreremplissage, MIME_ACCEPTES };
