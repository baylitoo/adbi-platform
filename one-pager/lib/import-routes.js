"use strict";

/**
 * Routes d'import d'un CV en tache asynchrone (issue #196).
 *
 * Isolees de server.js pour etre testables sans PostgreSQL : server.js exige
 * DATABASE_URL et ouvre la base au chargement. Les dependances (importerCv, db,
 * gestionnaire de taches) sont injectees ; server.js passe les vraies.
 *
 * Seul appelant de POST /api/import : public/app.js (verifie par recherche dans
 * tout le depot, factory compris — il ne fait que lier l'URL du module). La
 * route passe donc directement en 202 au lieu d'en ajouter une seconde.
 */

const crypto = require("node:crypto");
const { FileImportsPleineError, TTL_MS } = require("./import-taches");

const TAILLE_MAX = 20 * 1024 * 1024;

/**
 * @param {import("express").Express} app
 * @param {{ importerCv: Function, db: { findByHash: Function }, gestionnaire: object }} deps
 */
function monterImport(app, { importerCv, db, gestionnaire }) {
  /**
   * POST /api/import  { filename, contentBase64 } -> 202 { tache }
   *
   * Validation synchrone (fichier present, 20 Mo), puis reponse immediate.
   * Le resultat de la tache est exactement l'ancienne reponse synchrone :
   * { id, hash, master, duree_ms, doublon } — le cv_master extrait, SANS
   * l'enregistrer : l'utilisateur valide d'abord (etape 2), c'est lui qui
   * declenche l'enregistrement.
   */
  app.post("/api/import", (req, res) => {
    const { filename, contentBase64 } = req.body || {};
    if (!contentBase64) return res.status(400).json({ error: "Aucun fichier reçu." });

    const buffer = Buffer.from(contentBase64, "base64");
    if (buffer.length > TAILLE_MAX) {
      return res.status(413).json({ error: "Fichier trop volumineux (20 Mo maximum)." });
    }

    try {
      const tache = gestionnaire.creer(async () => {
        // duree_ms mesure l'analyse elle-meme, attente en file exclue.
        const t0 = Date.now();
        // lib/import-pipeline choisit la voie d'extraction (locale par defaut,
        // DocIE si DOCIE_EXTRACTION_ENABLED=true : voie fichier pour un PDF, voie
        // texte pour un depot texte — voir issues #152 et #180)
        // et gere elle-meme le repli local en cas d'echec DocIE.
        const master = await importerCv(buffer, filename);
        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        const existant = await db.findByHash(hash);
        return {
          id: crypto.randomUUID(),
          hash,
          master,
          duree_ms: Date.now() - t0,
          // Un meme fichier deja importe : on previent au lieu de creer un doublon.
          doublon: existant ? { id: existant.id, nom: existant.nom, maj_le: existant.maj_le } : null,
        };
      });
      res.status(202).json({ tache });
    } catch (e) {
      if (e instanceof FileImportsPleineError) return res.status(503).json({ error: e.message });
      console.error("[import]", e);
      res.status(500).json({ error: "Import impossible : erreur interne." });
    }
  });

  /**
   * GET /api/taches/:id -> etat de la tache (contrat : lib/import-taches.js).
   *
   * Pas d'authentification ni d'utilisateur dans ce service (outil
   * mono-utilisateur, voir server.js) : aucune regle « seul l'auteur lit sa
   * tache » n'est applicable. La protection est l'identifiant lui-meme,
   * crypto.randomUUID() (122 bits aleatoires), jamais liste nulle part.
   */
  app.get("/api/taches/:id", (req, res) => {
    const vue = gestionnaire.obtenir(req.params.id);
    if (!vue) {
      return res.status(404).json({
        error: `Tâche inconnue ou expirée (conservée ${Math.round(TTL_MS / 60000)} min après sa fin, ` +
          "perdue au redémarrage du service) : relancez l'import.",
      });
    }
    res.json(vue);
  });
}

module.exports = { monterImport };
