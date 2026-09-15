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

  // Contrôle de clé SIREN / SIRET (PR #201) : la réponse de
  // /api/contracts/importer/extraire porte `controleSirenSiret` À CÔTÉ de
  // `values` ({ siren: {valeur, chiffres, statut}, siret }). Règle des
  // consommateurs : un numéro n'est tenu pour bon que si son statut vaut
  // exactement "valide". Le champ reste pré-rempli (l'utilisateur relit avant
  // d'importer, et corrige un chiffre en le voyant) mais il est signalé.
  // Même table que public/kbis-champs.js (tests/import-champs.test.js compare).
  var MESSAGES_STATUT = {
    format_invalide: "format invalide — vérifier sur le document",
    cle_invalide: "clé de contrôle invalide — vérifier sur le document",
    discordant: "SIREN et SIRET discordants (le SIRET ne commence pas par le SIREN) — vérifier sur le document",
  };
  var MESSAGE_STATUT_INCONNU = "numéro non vérifié — vérifier sur le document";
  // [clé du drapeau, clé contrats, libellé].
  var SIREN_SIRET = [["siren", "stSiren", "SIREN"], ["siret", "stSiret", "SIRET"]];

  function idDe(cle) {
    return CHAMPS_AUTRES.filter(function (c) { return c.key === cle; })[0].id;
  }
  var IDS_SIREN_SIRET = SIREN_SIRET.map(function (x) { return idDe(x[1]); });

  function messageStatut(statut) {
    return Object.prototype.hasOwnProperty.call(MESSAGES_STATUT, statut) ? MESSAGES_STATUT[statut] : MESSAGE_STATUT_INCONNU;
  }

  // `controleSirenSiret` de la réponse -> champs à signaler
  // [{ key, id, libelle, statut, message }]. Drapeau absent (réponse d'avant
  // #201) -> [] : rien n'est signalé, comme avant. "valide" et "absent" ne
  // sont pas signalés ; tout autre statut, inconnu ou illisible compris, l'est.
  function aVerifierSirenSiret(controle) {
    if (!controle || typeof controle !== "object") return [];
    var sortie = [];
    SIREN_SIRET.forEach(function (x) {
      var e = controle[x[0]];
      var statut = e && typeof e === "object" && typeof e.statut === "string" ? e.statut : null;
      if (statut === "valide" || statut === "absent") return;
      sortie.push({ key: x[1], id: idDe(x[1]), libelle: x[2], statut: statut, message: messageStatut(statut) });
    });
    return sortie;
  }

  // Texte de la ligne d'état : « SIREN : <message> ; SIRET : <message> ».
  function resumeSirenSiret(aVerifier) {
    return (aVerifier || []).map(function (a) { return a.libelle + " : " + a.message; }).join(" ; ");
  }

  // Résultat partiel (#203, #194) : `partiel` = [{ champ, raison, cle? }] et
  // `troncaturePossible`, repris par le serveur (lib/docie-extraction.js
  // ::signauxPartielsPublics) des métadonnées du bridge. Ce sont des FAITS sur
  // l'extraction : affichés dès qu'ils sont présents, choix de modèle ou non.
  // Partagé par le modal d'import et la checklist (URSSAF, RIB, Kbis).
  //
  // Une ligne française compacte par champ touché. Les clés sont les raisons du
  // bridge (document-parsing/bridge/docie-bridge.js::RAISONS_PARTIEL, comparées
  // par tests/resultat-partiel.test.js) ; une raison inconnue est quand même
  // affichée, jamais ignorée.
  var MESSAGES_PARTIEL = {
    boucle: "sortie du modèle en boucle, liste coupée (éléments suivants perdus)",
    valeur_abandonnee: "valeur lue mais abandonnée (nombre ou montant illisible)",
    forme_invalide: "valeur de forme invalide, rien n'a été gardé",
    feuille_abandonnee: "valeur invalide abandonnée par l'extraction",
    liste_plafonnee_possible: "liste de 100 éléments, peut-être plafonnée",
  };
  var MESSAGE_PARTIEL_INCONNU = "valeur peut-être perdue par l'extraction";
  var LIGNE_TRONCATURE = "Document peut-être tronqué (> 800 lignes) : la fin n'a peut-être pas été lue";

  // Libellés du modal pour les 7 champs principaux (index.html, vérifié par les
  // tests) ; les 12 autres portent le leur dans CHAMPS_AUTRES.
  var LIBELLES_PRINCIPAUX = {
    numeroContrat: "N° du contrat",
    stNom: "Sous-traitant / co-contractant",
    clientFinal: "Client final",
    consultantNom: "Consultant",
    tjm: "TJM (€ HT / jour)",
    dateDebut: "Date de début",
    dateFin: "Date de fin",
  };
  var IDS_CHAMPS = CHAMPS_PRINCIPAUX.map(function (c) { return c[1]; })
    .concat(CHAMPS_AUTRES.map(function (c) { return c.id; }));

  // Champs DocIE des pièces de la checklist -> libellé lisible. Un champ absent
  // de la table est nommé tel que DocIE l'écrit.
  var LIBELLES_PIECES = {
    urssaf: {
      company_name: "Société", siren: "SIREN", siret: "SIRET", registered_address: "Adresse",
      issued_date: "Date de délivrance", valid_until: "Valable jusqu'au", security_code: "Code de sécurité",
      urssaf_agency: "Organisme", employee_count: "Effectif", declared_payroll: "Masse salariale",
    },
    rib: { account_holder: "Titulaire", iban: "IBAN", bic: "BIC", bank_name: "Banque" },
    kbis: {
      company_name: "Dénomination", siren: "SIREN", siret_siege: "SIRET du siège", legal_form: "Forme juridique",
      share_capital: "Capital social", registration_date: "Date d'immatriculation", rcs_number: "RCS",
      registered_address: "Adresse du siège", activity_code: "Code activité", legal_representative: "Représentant légal",
      issued_date: "Date de délivrance",
    },
  };

  // Champs dont dépend le VERDICT de la ligne d'état d'une pièce : URSSAF et
  // Kbis (nom, validité 6 mois, clé SIREN/SIRET), RIB (titulaire, IBAN, BIC).
  // Avec un modèle choisi, un de ces champs dans `partiel` fait de la ligne un
  // ⛔ : un verdict bâti sur une valeur perdue ne peut pas être validé. Kbis :
  // sélecteur par type d'entrée (#194), mêmes règles sur ses deux voies.
  var CHAMPS_VERDICT = {
    urssaf: ["company_name", "issued_date", "siren", "siret"],
    rib: ["account_holder", "iban", "bic"],
    kbis: ["company_name", "issued_date", "siren", "siret_siege"],
  };

  function aPropre(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function racineChamp(champ) { return String(champ).split(/[.[]/)[0]; }

  // Réponse (ou résultat gardé) -> { partiel, troncaturePossible }, ou null s'il
  // n'y a rien à dire. Toute forme illisible est ignorée sans exception
  // (analyse locale, réponse d'avant #203).
  function signauxPartiels(d) {
    if (!d || typeof d !== "object") return null;
    var partiel = (Array.isArray(d.partiel) ? d.partiel : []).filter(function (p) {
      return p && typeof p === "object" && typeof p.champ === "string" && p.champ !== "" && typeof p.raison === "string";
    });
    var troncature = d.troncaturePossible === true;
    if (!partiel.length && !troncature) return null;
    return { partiel: partiel, troncaturePossible: troncature };
  }

  function messagePartiel(raison) {
    return aPropre(MESSAGES_PARTIEL, raison) ? MESSAGES_PARTIEL[raison] : MESSAGE_PARTIEL_INCONNU + " (" + raison + ")";
  }

  function libelleCle(cle) {
    if (aPropre(LIBELLES_PRINCIPAUX, cle)) return LIBELLES_PRINCIPAUX[cle];
    var c = CHAMPS_AUTRES.filter(function (x) { return x.key === cle; })[0];
    return c ? c.label : null;
  }

  // `piece` : "contract" (libellé du modal via `cle`) ou un id de la checklist.
  function libellePartiel(p, piece) {
    var libelle = null;
    if (piece === "contract") libelle = typeof p.cle === "string" ? libelleCle(p.cle) : null;
    else if (aPropre(LIBELLES_PIECES, piece) && aPropre(LIBELLES_PIECES[piece], racineChamp(p.champ))) libelle = LIBELLES_PIECES[piece][racineChamp(p.champ)];
    if (!libelle) return "champ « " + p.champ + " »";
    return racineChamp(p.champ) === p.champ ? libelle : libelle + " (" + p.champ + ")";
  }

  // Lignes à afficher, sans pictogramme (chaque écran ajoute le sien).
  function lignesPartiel(signaux, piece) {
    if (!signaux) return [];
    var lignes = signaux.partiel.map(function (p) {
      return "Résultat partiel — " + libellePartiel(p, piece) + " : " + messagePartiel(p.raison);
    });
    if (signaux.troncaturePossible) lignes.push(LIGNE_TRONCATURE);
    return lignes;
  }

  function uniques(liste) {
    return liste.filter(function (x, i) { return liste.indexOf(x) === i; });
  }

  // Suffixe de la ligne d'état du pré-remplissage : « — résultat partiel : TJM
  // (€ HT / jour) — document peut-être tronqué (> 800 lignes) ».
  function resumePartiel(signaux, piece) {
    if (!signaux) return "";
    var noms = uniques(signaux.partiel.map(function (p) { return libellePartiel(p, piece); }));
    return (noms.length ? " — résultat partiel : " + noms.join(", ") : "") +
      (signaux.troncaturePossible ? " — document peut-être tronqué (> 800 lignes)" : "");
  }

  // Libellés des champs du verdict de `piece` nommés dans `partiel`.
  function champsVerdictPartiels(signaux, piece) {
    if (!signaux || !aPropre(CHAMPS_VERDICT, piece)) return [];
    return uniques(signaux.partiel.filter(function (p) {
      return CHAMPS_VERDICT[piece].indexOf(racineChamp(p.champ)) !== -1;
    }).map(function (p) { return libellePartiel(p, piece); }));
  }

  // Pré-remplissage : champs du modal nommés dans `partiel` -> marques, même
  // forme qu'aVerifierSirenSiret. `bloquant` (modèle choisi) : l'import est
  // refusé tant que le champ n'a pas été modifié (app.js::validerImport).
  function aVerifierPartiel(signaux, choixModele) {
    if (!signaux) return [];
    var sortie = [];
    signaux.partiel.forEach(function (p) {
      if (typeof p.cle !== "string") return;
      var principal = CHAMPS_PRINCIPAUX.filter(function (c) { return c[0] === p.cle; })[0];
      var autre = CHAMPS_AUTRES.filter(function (c) { return c.key === p.cle; })[0];
      var id = principal ? principal[1] : autre ? autre.id : null;
      if (!id) return;
      sortie.push({ key: p.cle, id: id, libelle: libelleCle(p.cle), raison: p.raison,
        message: "résultat partiel, " + messagePartiel(p.raison), bloquant: choixModele === true });
    });
    return sortie;
  }

  return {
    MESSAGES_PARTIEL: MESSAGES_PARTIEL,
    MESSAGE_PARTIEL_INCONNU: MESSAGE_PARTIEL_INCONNU,
    LIGNE_TRONCATURE: LIGNE_TRONCATURE,
    LIBELLES_PRINCIPAUX: LIBELLES_PRINCIPAUX,
    LIBELLES_PIECES: LIBELLES_PIECES,
    CHAMPS_VERDICT: CHAMPS_VERDICT,
    IDS_CHAMPS: IDS_CHAMPS,
    signauxPartiels: signauxPartiels,
    lignesPartiel: lignesPartiel,
    resumePartiel: resumePartiel,
    champsVerdictPartiels: champsVerdictPartiels,
    aVerifierPartiel: aVerifierPartiel,
    MESSAGES_STATUT: MESSAGES_STATUT,
    MESSAGE_STATUT_INCONNU: MESSAGE_STATUT_INCONNU,
    IDS_SIREN_SIRET: IDS_SIREN_SIRET,
    aVerifierSirenSiret: aVerifierSirenSiret,
    resumeSirenSiret: resumeSirenSiret,
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
