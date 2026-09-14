/* ADBI Contrats — champs du modal « Importer un contrat existant ».
 *
 * Le schéma DocIE « contract » extrait 19 champs (lib/docie-contract-import.js
 * ::MAPPED_FIELDS) et POST /api/contracts/importer/extraire les renvoie tous.
 * Le modal n'en montrait que 7 : les 12 autres n'étaient ni affichés, ni
 * relus, ni stockés — alors que la reprise d'un contrat pour un avenant
 * (applyContractRef, creerAvenantDepuis), la fiche entreprise (stSiren via
 * GET /api/contracts) et la régénération du PDF les lisent dans le payload.
 *
 * Ce fichier ne contient QUE de la logique pure (aucun accès au DOM) : la
 * correspondance clé contrats <-> champ du modal, dans les deux sens. Il est
 * évalué par le navigateur (<script> avant app.js) ET chargé par les tests
 * Node (tests/import-champs.test.js) — même principe que
 * coffre/public/detecteurs.js.
 *
 * Invariant conservé : rien n'est stocké sans que l'utilisateur ait vu les
 * valeurs et cliqué « ⬆ Importer dans le dossier ». Le pré-remplissage ne fait
 * que remplir des champs visibles et modifiables.
 */

var CONTRATS_IMPORT_CHAMPS = (function () {
  "use strict";

  // Les 7 champs historiques du modal : [clé contrats, id de l'input].
  var CHAMPS_PRINCIPAUX = [
    ["numeroContrat", "impNumero"],
    ["stNom", "impSt"],
    ["clientFinal", "impClient"],
    ["consultantNom", "impConsultant"],
    ["tjm", "impTjm"],
    ["dateDebut", "impDebut"],
    ["dateFin", "impFin"],
  ];

  // Les 12 autres champs extraits par DocIE. Libellé, type, groupe,
  // placeholder et défaut RECOPIÉS de lib/fields.js::sousTraitance (le
  // formulaire d'un contrat créé ici) — tests/import-champs.test.js relit
  // fields.js en direct et échoue à la moindre divergence.
  var CHAMPS_AUTRES = [
    { key: "dateRedaction", id: "impDateRedaction", label: "Fait le (date)", group: "Contrat", type: "date" },
    { key: "lieuRedaction", id: "impLieuRedaction", label: "Fait à", group: "Contrat", defaut: "Paris" },
    { key: "stAdresse", id: "impStAdresse", label: "Adresse", group: "Sous-Traitant", placeholder: "ex : 60 rue François 1er, 75008 Paris", full: true },
    { key: "stSiren", id: "impStSiren", label: "SIREN", group: "Sous-Traitant", placeholder: "ex : 941091316" },
    { key: "stSiret", id: "impStSiret", label: "SIRET", group: "Sous-Traitant", placeholder: "ex : 94109131600013" },
    { key: "stFormeJuridique", id: "impStFormeJuridique", label: "Forme juridique", group: "Sous-Traitant", placeholder: "ex : SAS au capital de 1 000 €" },
    { key: "stRepresentant", id: "impStRepresentant", label: "Représentée par", group: "Sous-Traitant", placeholder: "ex : Monsieur Corentin CALVO" },
    { key: "stQualite", id: "impStQualite", label: "Qualité du représentant", group: "Sous-Traitant", placeholder: "ex : Président" },
    { key: "consultantFonction", id: "impConsultantFonction", label: "Fonction", group: "Intervenant", placeholder: "ex : Développeur Full stack" },
    { key: "natureTravaux", id: "impNatureTravaux", label: "Nature des travaux", group: "Mission", placeholder: "ex : Développement full stack de la plateforme de réservation (React / Node.js)…", full: true, textarea: true },
    { key: "lieuExecution", id: "impLieuExecution", label: "Lieu d'exécution", group: "Mission", placeholder: "ex : 82 rue Henry Farman, 92130 Issy-les-Moulineaux", full: true },
    { key: "delaiPaiement", id: "impDelaiPaiement", label: "Délai de paiement (jours)", group: "Conditions financières", type: "number", defaut: "45" },
  ];

  // Types pour lesquels la section est affichée et envoyée. Uniquement la
  // convention de sous-traitance : ce sont des clés de fields.js::sousTraitance,
  // le pré-remplissage DocIE est déjà refusé pour les autres types, et pour un
  // avenant ces clés n'auraient pas le même sens (stRepresentant d'un avenant
  // n'est lu par personne : applyContractRef lit le payload du contrat PARENT).
  var TYPES_AUTRES_CHAMPS = ["sous-traitance"];

  function nonVide(v) {
    return v !== null && v !== undefined && String(v).trim() !== "";
  }

  function afficherAutresChamps(type) {
    return TYPES_AUTRES_CHAMPS.indexOf(type) !== -1;
  }

  // Texte d'aide d'un champ : le placeholder de fields.js, ou à défaut la
  // valeur par défaut qui s'appliquera si le champ reste vide (le champ vide
  // n'est pas envoyé — voir valeursImport).
  function placeholder(champ) {
    if (champ.placeholder) return champ.placeholder;
    if (champ.defaut) return "par défaut : " + champ.defaut;
    return "";
  }

  // `values` renvoyées par /api/contracts/importer/extraire -> liste
  // [id de l'input, valeur] des 19 champs, NON VIDES seulement : un champ que
  // DocIE n'a pas trouvé n'efface jamais une saisie manuelle déjà faite.
  function preremplissage(values) {
    var v = values || {};
    var sortie = [];
    CHAMPS_PRINCIPAUX.forEach(function (c) {
      if (nonVide(v[c[0]])) sortie.push([c[1], String(v[c[0]])]);
    });
    CHAMPS_AUTRES.forEach(function (c) {
      if (nonVide(v[c.key])) sortie.push([c.id, String(v[c.key])]);
    });
    return sortie;
  }

  // Nombre de champs de la section « Autres informations » pré-remplis (pour
  // l'ouvrir automatiquement quand il y a quelque chose à relire).
  function nbAutresPreremplis(values) {
    var v = values || {};
    return CHAMPS_AUTRES.filter(function (c) { return nonVide(v[c.key]); }).length;
  }

  // Formulaire -> `values` envoyées à POST /api/contracts/importer.
  // `lire(id)` rend la valeur brute de l'input.
  //
  // Les 7 clés historiques gardent EXACTEMENT la forme d'avant (y compris ""
  // quand vide) : les défauts de fields.js pour ces clés sont tous "", donc
  // "" ou absent y est équivalent.
  //
  // Les 12 autres ne sont envoyées que si elles sont renseignées. Ce n'est pas
  // cosmétique : server.js::resolveBody et app.js::loadType font
  // Object.assign(défauts, values), et deux de ces clés ont un défaut non vide
  // (delaiPaiement "45", lieuRedaction "Paris"). Envoyer "" écraserait ce
  // défaut : le PDF régénéré afficherait « ……… jours » au lieu de « 45 jours ».
  // Un import saisi à la main sans toucher la section produit donc le même
  // payload qu'avant.
  function valeursImport(type, lire) {
    var avenant = type === "avenant";
    var brut = function (id) { var x = lire(id); return x === null || x === undefined ? "" : String(x); };
    var values = {
      stNom: avenant ? "" : brut("impSt").trim(),
      avPartie2Nom: avenant ? brut("impSt").trim() : "",
      clientFinal: brut("impClient").trim(),
      consultantNom: brut("impConsultant").trim(),
      tjm: brut("impTjm").trim(),
      dateDebut: brut("impDebut"),
      dateFin: brut("impFin"),
      numeroContrat: avenant ? "" : brut("impNumero").trim(),
      numeroAvenant: avenant ? brut("impNumAvenant").trim() : "",
      numeroContratInitial: avenant ? brut("impInitial").trim() : "",
      contratType: avenant ? "sous-traitance" : "",
    };
    if (afficherAutresChamps(type)) {
      CHAMPS_AUTRES.forEach(function (c) {
        var x = brut(c.id).trim();
        if (x) values[c.key] = x;
      });
    }
    return values;
  }

  // Ids à vider après un import réussi.
  var IDS_A_VIDER = ["impNumero", "impNumAvenant", "impInitial", "impSt", "impClient", "impConsultant", "impTjm", "impDebut", "impFin", "impFichier"]
    .concat(CHAMPS_AUTRES.map(function (c) { return c.id; }));

  return {
    CHAMPS_PRINCIPAUX: CHAMPS_PRINCIPAUX,
    CHAMPS_AUTRES: CHAMPS_AUTRES,
    TYPES_AUTRES_CHAMPS: TYPES_AUTRES_CHAMPS,
    IDS_A_VIDER: IDS_A_VIDER,
    afficherAutresChamps: afficherAutresChamps,
    placeholder: placeholder,
    preremplissage: preremplissage,
    nbAutresPreremplis: nbAutresPreremplis,
    valeursImport: valeursImport,
  };
})();

/* Le même fichier sert au navigateur (modal d'import) et aux tests Node. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = CONTRATS_IMPORT_CHAMPS;
}
