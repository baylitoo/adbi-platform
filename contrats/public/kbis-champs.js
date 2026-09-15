/* ADBI Contrats — proposition des valeurs lues sur un Kbis (issue #170).
 *
 * L'analyse DocIE d'un Kbis (lib/kbis-mapping.js::mapKbisResult) renvoie,
 * en plus des 8 clés de docanalyze.js, les champs officiels du document :
 * SIREN, SIRET, forme juridique, adresse du siège, représentant légal, etc.
 * POST /api/document/analyze les transmet tels quels au navigateur, mais
 * app.js::analyzeChecklistDoc n'en gardait que trois (date, société, contrôle
 * du nom) : l'utilisateur ressaisissait à la main — ou redemandait à
 * Pappers/INSEE — ce que DocIE venait de lire.
 *
 * Ce fichier ne contient QUE de la logique pure (aucun accès au DOM) : quelles
 * valeurs du Kbis correspondent à quels champs du contrat, comment elles se
 * comparent aux valeurs déjà saisies, et ce qu'il faut réellement écrire. Il
 * est évalué par le navigateur (<script> avant app.js) ET chargé par les tests
 * Node (tests/kbis-champs.test.js) — même principe que public/import-champs.js.
 *
 * Invariant : rien n'est écrit dans le contrat sans que l'utilisateur ait vu
 * les valeurs et cliqué pour les reporter. Un champ déjà rempli avec une autre
 * valeur n'est jamais écrasé par défaut : l'utilisateur choisit champ par champ.
 */

var CONTRATS_KBIS_CHAMPS = (function () {
  "use strict";

  // [clé renvoyée par /api/document/analyze, clé de fields.js::sousTraitance,
  //  manière de comparer]. Uniquement les correspondances de MÊME sens :
  // - companyName -> stNom est exclu : c'est le contrôle du nom (nameMatches)
  //   qui décide que ce Kbis est bien celui du sous-traitant saisi. Remplir
  //   stNom depuis le document rendrait ce contrôle circulaire.
  // - stQualite n'est pas visé : le schéma DocIE « kbis » n'isole pas la
  //   qualité du représentant de son nom (kbis_to_contrats.py::GAP_NOTES).
  // - capitalSocial, rcsNumber, codeActivite, dateImmatriculation n'ont aucun
  //   champ dans fields.js::sousTraitance : ils sont montrés pour information
  //   (INFOS), jamais reportés. Le capital n'est pas non plus fondu dans
  //   stFormeJuridique (« SAS au capital de … ») : ce serait fabriquer une
  //   mise en forme, et la recherche société y met la forme seule.
  var CORRESPONDANCES = [
    ["siren", "stSiren", "identifiant"],
    ["siret", "stSiret", "identifiant"],
    ["formeJuridique", "stFormeJuridique", "texte"],
    ["adresseSiege", "stAdresse", "texte"],
    ["representantLegal", "stRepresentant", "texte"],
  ];

  // Lus sur le Kbis, sans champ correspondant dans le contrat.
  var INFOS = [
    ["capitalSocial", "Capital social"],
    ["rcsNumber", "RCS"],
    ["codeActivite", "Code activité"],
    ["dateImmatriculation", "Immatriculé le"],
  ];

  // Contrôle de clé SIREN / SIRET (PR #201, lib/siren-siret.js) : la réponse
  // porte `controleSirenSiret = { siren: {valeur, chiffres, statut}, siret }`.
  // Règle des consommateurs : un numéro n'est utilisé QUE si son statut vaut
  // exactement "valide" — jamais « s'il n'y a pas de problème », pour qu'un
  // statut ajouté plus tard ne passe pas pour une valeur propre.
  // Un message FIXE par statut, montré à côté de la valeur lue : un humain
  // corrige un chiffre en le voyant. Même table dans public/import-champs.js
  // (tests/import-champs.test.js compare les deux et les statuts de #201).
  var MESSAGES_STATUT = {
    format_invalide: "format invalide — vérifier sur le document",
    cle_invalide: "clé de contrôle invalide — vérifier sur le document",
    discordant: "SIREN et SIRET discordants (le SIRET ne commence pas par le SIREN) — vérifier sur le document",
  };
  // Statut inconnu, ou entrée illisible dans un drapeau présent : échec FERMÉ.
  var MESSAGE_STATUT_INCONNU = "numéro non vérifié — vérifier sur le document";
  var CHAMPS_CONTROLES = [["siren", "SIREN"], ["siret", "SIRET"]];

  function texte(v) {
    return v === null || v === undefined ? "" : String(v);
  }

  function messageStatut(statut) {
    return Object.prototype.hasOwnProperty.call(MESSAGES_STATUT, statut) ? MESSAGES_STATUT[statut] : MESSAGE_STATUT_INCONNU;
  }

  // Réponse de /api/document/analyze -> { siren: {statut, valeur}, siret }
  // (liste blanche, conservée dans state.dateState), ou null si la réponse ne
  // porte pas le drapeau : analyse locale sans DocIE, réponse antérieure à
  // #201, dossier enregistré avant — tout se passe alors comme avant.
  // Drapeau présent mais entrée absente ou statut non textuel : statut null,
  // traité comme non valide (jamais comme une valeur propre).
  function controleCompact(d) {
    var c = d && typeof d === "object" ? d.controleSirenSiret : null;
    if (!c || typeof c !== "object") return null;
    var sortie = {};
    CHAMPS_CONTROLES.forEach(function (x) {
      var e = c[x[0]];
      sortie[x[0]] = e && typeof e === "object" && typeof e.statut === "string"
        ? { statut: e.statut, valeur: texte(e.valeur) }
        : { statut: null, valeur: "" };
    });
    return sortie;
  }

  function nonVide(v) {
    return texte(v).trim() !== "";
  }

  // Normalisation POUR COMPARER uniquement — la valeur affichée et la valeur
  // écrite restent celles du document ou de la saisie, jamais celle-ci.
  function normaliser(v, maniere) {
    var s = texte(v);
    if (maniere === "identifiant") return s.replace(/\s+/g, "");
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Réponse de /api/document/analyze -> les seules valeurs utiles ici, non
  // vides. Liste blanche : rien d'autre de la réponse n'est conservé dans
  // state.dateState (donc dans le payload enregistré). Une analyse locale
  // (docanalyze.js, 8 clés, aucune clé enrichie) donne {}.
  function extraire(d) {
    var sortie = {};
    if (!d || typeof d !== "object") return sortie;
    CORRESPONDANCES.forEach(function (c) {
      if (nonVide(d[c[0]])) sortie[c[0]] = texte(d[c[0]]);
    });
    INFOS.forEach(function (c) {
      if (nonVide(d[c[0]])) sortie[c[0]] = texte(d[c[0]]);
    });
    if (nonVide(d.capitalSocial) && nonVide(d.capitalSocialDevise)) {
      sortie.capitalSocialDevise = texte(d.capitalSocialDevise);
    }
    return sortie;
  }

  // Proposition à montrer, ou null s'il n'y a rien à proposer :
  // - nameMatches === false : le document est au nom d'une autre société (le
  //   ⛔ le dit déjà) — pré-remplir depuis lui serait exactement l'erreur ;
  // - aucune valeur correspondant à un champ du contrat (analyse locale).
  //
  // `valeurs` : state.values au moment de l'affichage. Chaque champ sort avec
  // son état : "vide" (le report le remplira), "identique" (rien à faire),
  // "different" (l'utilisateur choisit ; par défaut la saisie est gardée).
  //
  // `controle` : controleCompact() de la même réponse. Absent (null/undefined)
  // -> comportement d'avant #201. Présent -> un SIREN/SIRET dont le statut
  // n'est pas "valide" n'est PAS proposé au report (ni coché, ni « identique »
  // à une saisie qui porterait le même numéro faux) : il sort dans `aVerifier`
  // avec sa valeur lue et le message de son statut. "absent" : rien du tout.
  function proposer(kbis, nameMatches, valeurs, controle) {
    if (nameMatches === false || !kbis || typeof kbis !== "object") return null;
    var v = valeurs || {};
    var champs = [];
    var aVerifier = [];
    var libelles = {};
    CHAMPS_CONTROLES.forEach(function (x) { libelles[x[0]] = x[1]; });
    CORRESPONDANCES.forEach(function (c) {
      var lu = kbis[c[0]];
      if (controle && typeof controle === "object" && libelles[c[0]]) {
        var e = controle[c[0]] || { statut: null, valeur: "" };
        if (e.statut === "absent") return;
        if (e.statut !== "valide") {
          var valeurLue = nonVide(lu) ? texte(lu) : texte(e.valeur);
          if (!nonVide(valeurLue)) return;
          aVerifier.push({
            source: c[0], cle: c[1], libelle: libelles[c[0]], kbis: valeurLue,
            statut: e.statut, message: messageStatut(e.statut),
          });
          return;
        }
      }
      if (!nonVide(lu)) return;
      var actuel = texte(v[c[1]]);
      var etat;
      if (!nonVide(actuel)) etat = "vide";
      else if (normaliser(actuel, c[2]) === normaliser(lu, c[2])) etat = "identique";
      else etat = "different";
      champs.push({ source: c[0], cle: c[1], kbis: texte(lu), actuel: actuel, etat: etat });
    });
    // Rien à reporter mais un numéro à vérifier : la proposition s'affiche
    // quand même, pour montrer la valeur lue et la raison.
    if (!champs.length && !aVerifier.length) return null;
    var infos = [];
    INFOS.forEach(function (c) {
      if (!nonVide(kbis[c[0]])) return;
      var val = texte(kbis[c[0]]);
      if (c[0] === "capitalSocial" && nonVide(kbis.capitalSocialDevise)) val += " " + texte(kbis.capitalSocialDevise);
      infos.push({ source: c[0], libelle: c[1], valeur: val });
    });
    return {
      champs: champs,
      aVerifier: aVerifier,
      infos: infos,
      // null : raison sociale non saisie, le contrôle du nom n'a pas pu tourner.
      nomVerifie: nameMatches === true,
    };
  }

  // Ligne compacte de la checklist (sous le résultat de l'analyse) : le
  // verdict de clé de chaque numéro lu. null quand il n'y a rien à dire :
  // drapeau absent (analyse locale, dossier d'avant #201 -> comme avant) ou
  // les deux numéros absents. `alerte` : au moins un numéro non valide.
  function ligneControle(controle) {
    if (!controle || typeof controle !== "object") return null;
    var parties = [];
    var alerte = false;
    CHAMPS_CONTROLES.forEach(function (x) {
      var e = controle[x[0]] || { statut: null, valeur: "" };
      if (e.statut === "absent") return;
      if (e.statut === "valide") {
        parties.push(x[1] + " " + texte(e.valeur) + " : clé valide");
        return;
      }
      alerte = true;
      parties.push(x[1] + (nonVide(e.valeur) ? " « " + texte(e.valeur) + " »" : "") + " : " + messageStatut(e.statut));
    });
    if (!parties.length) return null;
    return { texte: (alerte ? "⚠️ " : "🔢 ") + parties.join(" · "), alerte: alerte };
  }

  // Choix initial par champ : true = prendre la valeur du Kbis. Les champs
  // vides sont cochés, les champs différents ne le sont PAS.
  function choixParDefaut(proposition) {
    var choix = {};
    ((proposition && proposition.champs) || []).forEach(function (c) {
      if (c.etat === "vide") choix[c.cle] = true;
      if (c.etat === "different") choix[c.cle] = false;
    });
    return choix;
  }

  // Ce qu'il faut réellement écrire : [[clé, valeur du Kbis], ...].
  // `valeursActuelles` est relu AU MOMENT DU CLIC : un champ modifié depuis
  // l'affichage de la proposition (saisie ou recherche société entre-temps)
  // n'est pas écrasé — il sort dans `modifies` et la proposition est à
  // réafficher. Mesuré contre la valeur vue à l'affichage, avec la même
  // normalisation que proposer().
  function aReporter(proposition, choix, valeursActuelles) {
    var paires = [];
    var modifies = [];
    var ch = choix || {};
    var v = valeursActuelles || {};
    var maniere = {};
    CORRESPONDANCES.forEach(function (c) { maniere[c[1]] = c[2]; });
    ((proposition && proposition.champs) || []).forEach(function (c) {
      if (c.etat === "identique" || ch[c.cle] !== true) return;
      if (normaliser(v[c.cle], maniere[c.cle]) !== normaliser(c.actuel, maniere[c.cle])) {
        modifies.push(c.cle);
        return;
      }
      paires.push([c.cle, c.kbis]);
    });
    return { paires: paires, modifies: modifies };
  }

  // Pièce « coordonnees » (« adresse, représentant légal, etc. ») : le Kbis
  // n'en couvre qu'une partie. Renvoie null tant que rien n'a été reporté
  // depuis le Kbis ; sinon les libellés des champs reportés et ceux des champs
  // du groupe Sous-Traitant encore vides. La case n'est JAMAIS cochée
  // automatiquement — même « complet » ne veut dire que « champs du formulaire
  // remplis » ; le « etc. » de la pièce reste à vérifier par l'utilisateur.
  function noteCoordonnees(champsFormulaire, valeurs, reportes) {
    if (!reportes || !reportes.length) return null;
    var v = valeurs || {};
    var st = (champsFormulaire || []).filter(function (f) { return f.group === "Sous-Traitant"; });
    var libelle = function (cle) {
      var f = st.filter(function (x) { return x.key === cle; })[0];
      return f ? f.label : cle;
    };
    var manquants = st.filter(function (f) { return !nonVide(v[f.key]); }).map(function (f) { return f.label; });
    return {
      reportes: reportes.map(libelle),
      manquants: manquants,
      complet: manquants.length === 0,
    };
  }

  return {
    CORRESPONDANCES: CORRESPONDANCES,
    INFOS: INFOS,
    MESSAGES_STATUT: MESSAGES_STATUT,
    MESSAGE_STATUT_INCONNU: MESSAGE_STATUT_INCONNU,
    messageStatut: messageStatut,
    controleCompact: controleCompact,
    ligneControle: ligneControle,
    normaliser: normaliser,
    extraire: extraire,
    proposer: proposer,
    choixParDefaut: choixParDefaut,
    aReporter: aReporter,
    noteCoordonnees: noteCoordonnees,
  };
})();

/* Le même fichier sert au navigateur (checklist) et aux tests Node. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = CONTRATS_KBIS_CHAMPS;
}
