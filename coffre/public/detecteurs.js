/* ADBI Coffre — détection des informations sensibles dans le texte d'une page.
 *
 * Entrée : le texte d'une page (+ options { enTete } pour les débuts de
 * document) ; sortie : une liste de détections { type, valeur, debut, fin }.
 * Tout est local : motifs + VALIDATION arithmétique (clé IBAN, Luhn, clé du
 * numéro de sécurité sociale, clé de TVA) pour limiter les faux positifs.
 * Les détecteurs les plus sûrs passent en premier et « réservent » leurs
 * caractères : un IBAN ne ressort pas une seconde fois comme téléphone.
 *
 * Les identités combinent quatre approches complémentaires :
 *   1. dictionnaire de prénoms (avec noms adjacents, MAJUSCULES comprises) ;
 *   2. civilités et étiquettes (« M. », « Nom : », « représenté par ») ;
 *   3. motif structurel « Prénom NOMENMAJUSCULES » (sans dictionnaire) ;
 *   4. ligne d'en-tête de document (un CV commence par le nom du candidat).
 * L'atelier laisse toujours l'utilisateur cocher/décocher et compléter.
 *
 * Fichier partagé : évalué par le navigateur (PDF) ET par le serveur (Word).
 */

var COFFRE_DETECTEURS = (function () {
  "use strict";

  var TYPES = {
    email: "E-mail",
    telephone: "Téléphone",
    iban: "IBAN",
    carte: "Carte bancaire",
    nir: "N° de sécurité sociale",
    tva: "N° TVA",
    siret: "SIREN / SIRET",
    identite: "Nom / prénom",
    adresse: "Adresse postale",
    date: "Date",
    montant: "Montant",
    lien: "Profil en ligne",
    plaque: "Plaque d'immatriculation",
    photo: "Photo / image",
    manuel: "Sélection manuelle",
  };

  /* ── Validations arithmétiques ─────────────────────────────────────────── */

  function resteMod97(chiffres) {
    var r = 0;
    for (var i = 0; i < chiffres.length; i++) {
      r = (r * 10 + (chiffres.charCodeAt(i) - 48)) % 97;
    }
    return r;
  }

  function ibanValide(brut) {
    var c = brut.replace(/[ ]/g, "").toUpperCase();
    if (c.length < 15 || c.length > 34) return false;
    var reordonne = c.slice(4) + c.slice(0, 4);
    var chiffres = "";
    for (var i = 0; i < reordonne.length; i++) {
      var code = reordonne.charCodeAt(i);
      if (code >= 65 && code <= 90) chiffres += String(code - 55);
      else if (code >= 48 && code <= 57) chiffres += reordonne[i];
      else return false;
    }
    return resteMod97(chiffres) === 1;
  }

  function luhnValide(chiffres) {
    var somme = 0;
    var double = false;
    for (var i = chiffres.length - 1; i >= 0; i--) {
      var d = chiffres.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      somme += d;
      double = !double;
    }
    return somme % 10 === 0;
  }

  function nirValide(brut) {
    var c = brut.replace(/[ .]/g, "").toUpperCase();
    if (c.length !== 15) return false;
    // Corse : 2A vaut 19, 2B vaut 18 dans le calcul de la clé.
    var numero = c.slice(0, 13).replace("2A", "19").replace("2B", "18");
    if (!/^\d{13}$/.test(numero)) return false;
    var cle = Number(c.slice(13));
    return 97 - resteMod97(numero) === cle;
  }

  /** N° TVA intracommunautaire FR : clé = (12 + 3 × (SIREN mod 97)) mod 97. */
  function tvaValide(brut) {
    var c = brut.replace(/[ ]/g, "").toUpperCase();
    if (!/^FR\d{11}$/.test(c)) return false;
    var cle = Number(c.slice(2, 4));
    var siren = c.slice(4);
    return luhnValide(siren) && (12 + 3 * (Number(siren) % 97)) % 97 === cle;
  }

  /** 06/07/01…, +33 6, (+33) 680 988 967, points, tirets, collé : 10 chiffres
      nationaux, ou indicatif 33 + 9 chiffres (avec (0) toléré). */
  function telephoneValide(v) {
    var ch = v.replace(/\D/g, "");
    if (ch.slice(0, 2) === "33") {
      return ch.length === 11 || (ch.length === 12 && ch[2] === "0");
    }
    return ch.length === 10;
  }

  /* ── Normalisation et dictionnaire de prénoms ──────────────────────────── */

  var AVEC_ACCENTS = "àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ";
  var SANS_ACCENTS = "aaaaaaceeeeiiiinooooouuuuyyoa";

  function normaliser(mot) {
    var sortie = "";
    var minuscule = mot.toLowerCase();
    for (var i = 0; i < minuscule.length; i++) {
      var pos = AVEC_ACCENTS.indexOf(minuscule[i]);
      sortie += pos >= 0 ? SANS_ACCENTS[pos] : minuscule[i];
    }
    return sortie;
  }

  function estPrenom(mot) {
    if (typeof COFFRE_PRENOMS === "undefined") return false;
    // Prénom simple ou composé : chaque composant compte (Jean-Pierre).
    var parts = mot.split("-");
    for (var i = 0; i < parts.length; i++) {
      if (COFFRE_PRENOMS.has(normaliser(parts[i]))) return true;
    }
    return false;
  }

  /* Mots à ne PAS prendre pour des personnes dans les motifs structurels. */
  var STOP_MOTS = new Set((
    "apache,google,microsoft,amazon,oracle,adobe,gitlab,github,linkedin,power,data,cloud,open,web," +
    "big,air,france,paris,groupe,societe,university,universite,institut,lycee,faculte,ecole,master," +
    "licence,bachelor,direction,service,agence,cabinet,departement,region,projet,mission,client," +
    "formation,experience,experiences,competence,competences,langues,contact,profil,profils,diplome," +
    "diplomes,projets,education,technologies,technologie,certifications,certification,curriculum," +
    "vitae,resume,laureat,laureate,ingenieur,ingenieure,docteur,titulaire,analytics,engineer,analyst," +
    "developer,consultant,manager,senior,junior,stage,stagiaire,alternance,freelance,sorbonne,pantheon"
  ).split(","));

  function estStop(mot) {
    return STOP_MOTS.has(normaliser(mot));
  }

  /* ── Briques de motifs ─────────────────────────────────────────────────── */

  var MAJ = "A-ZÀÂÄÁÇÉÈÊËÎÏÔÖÙÛÜ";
  var MIN = "a-zàâäáçéèêëîïôöùûüÿ";
  // Mot capitalisé, composés compris : « Karim », « Jean-Pierre », « N'Guyen ».
  var MOT_CAP = "[" + MAJ + "][" + MIN + "'’]+(?:-[" + MAJ + "][" + MIN + "'’]+)*";
  // Mot de nom de famille : Capitalisé ou TOUT EN MAJUSCULES (BENALI).
  var MOT_NOM = "[" + MAJ + "][" + MAJ + MIN + "'’-]+";
  // Mot ENTIÈREMENT en majuscules, assez long pour ne pas être un sigle (SQL…).
  var MOT_MAJUSCULES = "[" + MAJ + "][" + MAJ + "'’-]{4,}";
  // Particules acceptées : Karim ben Ali, Sophie de La Tour, João dos Santos.
  var PARTICULE = "(?:[ ](?:de la|de|del|van|von|ben|el|al|di|da|le|la|dos|du))?";

  function chercher(texte, regex, type, garde) {
    var trouvailles = [];
    regex.lastIndex = 0;
    var m;
    while ((m = regex.exec(texte)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue; }
      var valeur = m[0];
      if (garde && !garde(valeur, m, texte)) continue;
      trouvailles.push({ type: type, valeur: valeur, debut: m.index, fin: m.index + valeur.length });
    }
    return trouvailles;
  }

  /** Comme chercher(), mais seule la plage du groupe 1 est retenue (flag d). */
  function chercherGroupe(texte, regex, type, garde) {
    var trouvailles = [];
    regex.lastIndex = 0;
    var m;
    while ((m = regex.exec(texte)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue; }
      if (!m[1] || !m.indices || !m.indices[1]) continue;
      if (garde && !garde(m[1], m, texte)) continue;
      var debut = m.indices[1][0];
      var fin = m.indices[1][1];
      trouvailles.push({ type: type, valeur: texte.slice(debut, fin), debut: debut, fin: fin });
    }
    return trouvailles;
  }

  /* ── Analyse d'une page ────────────────────────────────────────────────── */

  function analyserPage(texte, options) {
    var reserve = new Uint8Array(texte.length);
    var retenues = [];

    function poser(liste) {
      for (var i = 0; i < liste.length; i++) {
        var d = liste[i];
        var libre = true;
        for (var k = d.debut; k < d.fin; k++) {
          if (reserve[k]) { libre = false; break; }
        }
        if (!libre) continue;
        for (var k2 = d.debut; k2 < d.fin; k2++) reserve[k2] = 1;
        retenues.push(d);
      }
    }

    /* 1. IBAN — validé par sa clé, prioritaire sur tout motif numérique. */
    poser(chercher(texte, /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){2,8}\b/g, "iban", function (v) {
      return ibanValide(v);
    }));

    /* 2. Numéro de sécurité sociale (clé vérifiée). */
    poser(chercher(
      texte,
      /\b[12][ .]?\d{2}[ .]?(?:0[1-9]|1[0-2]|[2-9]\d)[ .]?(?:\d{2}|2A|2B)[ .]?\d{3}[ .]?\d{3}[ .]?\d{2}\b/g,
      "nir",
      function (v) { return nirValide(v); }
    ));

    /* 3. N° de TVA (clé vérifiée), avant le SIREN qu'il contient. */
    poser(chercher(texte, /\bFR[ ]?\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g, "tva", function (v) {
      return tvaValide(v);
    }));

    /* 4. SIRET (14 chiffres) puis SIREN (9), tous deux au Luhn. Avant les
       cartes bancaires : un SIRET valide passe aussi le Luhn des cartes. */
    poser(chercher(texte, /\b\d{3}[ .]?\d{3}[ .]?\d{3}[ .]?\d{5}\b/g, "siret", function (v) {
      return luhnValide(v.replace(/[ .]/g, ""));
    }));
    poser(chercher(texte, /\b\d{3}[ .]?\d{3}[ .]?\d{3}\b/g, "siret", function (v) {
      return luhnValide(v.replace(/[ .]/g, ""));
    }));

    /* 5. Carte bancaire (formule de Luhn, 13 à 19 chiffres). */
    poser(chercher(texte, /\b(?:\d[ -]?){12,18}\d\b/g, "carte", function (v) {
      var c = v.replace(/[ -]/g, "");
      return c.length >= 13 && c.length <= 19 && luhnValide(c);
    }));

    /* 6. E-mail.
       L'extraction d'un PDF insère souvent des espaces parasites autour du @
       et du point ; certains CV écrivent volontairement « (at) » pour éviter
       les robots. Les deux cas passaient à travers le motif strict. */
    poser(chercher(
      texte,
      /[A-Za-z0-9._%+-]{1,64}[ ]?(?:@|\(at\)|\[at\])[ ]?[A-Za-z0-9-]+(?:[ ]?\.[ ]?[A-Za-z0-9-]+)*[ ]?\.[ ]?[A-Za-z]{2,24}/gi,
      "email",
      function (v) {
        // Un domaine sans point n'est pas une adresse ; une extension trop
        // longue trahit un faux positif (mot collé au domaine).
        var apres = v.split(/@|\(at\)|\[at\]/i)[1] || "";
        return apres.indexOf(".") !== -1;
      }
    ));

    /* 7. Profils en ligne nominatifs (LinkedIn, GitHub…). */
    poser(chercher(
      texte,
      /(?:https?:\/\/)?(?:www[.])?(?:linkedin[.]com\/in|github[.]com|gitlab[.]com|twitter[.]com|x[.]com)\/[A-Za-z0-9_.-]{2,40}/gi,
      "lien"
    ));

    /* 8. Téléphones : international d'abord ((+33) 680 988 967, +33 (0)6…),
       puis national (06 12 34 56 78, 0612345678, 06.12.34.56.78). Le nombre
       exact de chiffres est vérifié — pas de demi-numéros. */
    poser(chercher(
      texte,
      /[(]?\+[ ]?33[)]?[ .-]?[(]?0?[)]?[ .-]?[1-9](?:[ .-]?\d){8}/g,
      "telephone",
      function (v) { return telephoneValide(v); }
    ));
    poser(chercher(
      texte,
      /\b0[1-9](?:[ .-]?\d){8}\b/g,
      "telephone",
      function (v) { return telephoneValide(v); }
    ));

    /* 9. Dates (chiffrées ou en toutes lettres). */
    poser(chercher(texte, /\b[0-3]?\d[\/.\-][01]?\d[\/.\-](?:19|20)\d{2}\b/g, "date"));
    poser(chercher(
      texte,
      /\b[0-3]?\d(?:er)?[ ]+(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)[ ]+(?:19|20)\d{2}\b/gi,
      "date"
    ));

    /* 10. Adresses : n° + voie ; code postal + ville ; ville + code postal. */
    poser(chercher(
      texte,
      new RegExp(
        "\\b\\d{1,4}(?:[ ]?(?:bis|ter|quater))?[ ]?,?[ ]?" +
        "(?:rue|avenue|av[.]?|boulevard|bd[.]?|chemin|all[ée]e|impasse|place|route|quai|cours|square|villa|passage|hameau|lotissement|faubourg|r[ée]sidence|rond[- ]point|esplanade|promenade|sentier|traverse|venelle|cit[ée]|clos|domaine|parvis|mont[ée]e|c[ôo]te|voie|zone|za|zi|zac|lieu[- ]dit)" +
        "[ ]+[" + MAJ + MIN + "0-9'’-][" + MAJ + MIN + "0-9'’ -]{2,45}",
        "gi"
      ),
      "adresse",
      function (v) { return !/\bau\b[ ]*$/i.test(v); }
    ));
    poser(chercher(
      texte,
      new RegExp("\\b\\d{5}[ ]?(?:-[ ]?)?[" + MAJ + "][" + MAJ + MIN + "'’ -]{2,30}", "g"),
      "adresse",
      function (v) { return codePostalPlausible(v.slice(0, 5)); }
    ));
    // « Bagneux 92220 » : la ville d'abord, comme sur beaucoup de CV.
    poser(chercher(
      texte,
      new RegExp(
        "\\b[" + MAJ + "][" + MIN + "'’-]{2,}(?:[ -][" + MAJ + "][" + MIN + "'’-]{2,}){0,2}[ ]?,?[ ]\\d{5}\\b",
        "g"
      ),
      "adresse",
      function (v) { return codePostalPlausible(v.slice(-5)); }
    ));

    /* 11. Plaque d'immatriculation (SIV : AA-123-BC, lettres sans I, O, U). */
    poser(chercher(
      texte,
      /\b[A-HJ-NP-TV-Z]{2}[- ]\d{3}[- ][A-HJ-NP-TV-Z]{2}\b/g,
      "plaque"
    ));

    /* 12. Montants (TJM, salaires, loyers…). */
    poser(chercher(texte, /\b\d{1,3}(?:[ .]\d{3})*(?:,\d{2})?[ ]?(?:€|EUR|euros?)\b/gi, "montant"));

    /* 13. Identités. */

    /* a) Ligne d'en-tête de document : un CV, une lettre, une attestation
       commencent presque toujours par le nom de la personne. */
    if (options && options.enTete) {
      var candidatsEnTete = [];
      var lignes = texte.split("\n");
      var pos = 0;
      var vues = 0;
      var motifLigne = new RegExp("^" + MOT_NOM + "(?:[ ]" + MOT_NOM + "){1,3}$");
      for (var li = 0; li < lignes.length && vues < 4; li++) {
        var brutLigne = lignes[li];
        var ligne = brutLigne.trim();
        if (ligne) {
          vues++;
          if (
            ligne.length >= 5 && ligne.length <= 40 &&
            !/\d/.test(ligne) &&
            motifLigne.test(ligne) &&
            !ligne.split(/[ ]/).some(estStop)
          ) {
            var debutLigne = pos + brutLigne.indexOf(ligne);
            candidatsEnTete.push({
              type: "identite",
              valeur: ligne,
              debut: debutLigne,
              fin: debutLigne + ligne.length,
            });
          }
        }
        pos += brutLigne.length + 1;
      }
      poser(candidatsEnTete);
    }

    /* b) Civilité suivie du nom : M. Karim Benali, Madame Martin, Me DUPONT. */
    poser(chercherGroupe(
      texte,
      new RegExp(
        "\\b(?:M[.]|Mr[.]?|Mme|Mlle|Melle|Monsieur|Madame|Mademoiselle|Dr|Docteur|Me|Ma[îi]tre|Pr|Professeur)" +
        "[ ]+(" + MOT_NOM + PARTICULE + "(?:[ ]" + MOT_NOM + "){0,2})",
        "gd"
      ),
      "identite"
    ));

    /* c) Étiquette : « Nom : DUPONT », « Candidat : Sophie Martin »,
       « représentée par Jean Dubois ». Seule la valeur est masquée. */
    poser(chercherGroupe(
      texte,
      new RegExp(
        "\\b(?:[Nn]om(?:[ ]de[ ]famille)?|[Pp]r[ée]nom(?:s)?|NOM|PR[ÉE]NOM|[Cc]andidat(?:e)?|[Cc]onsultant(?:e)?|" +
        "[Ss]alari[ée](?:e)?|[Ee]mploy[ée](?:e)?|[Ii]ntervenant(?:e)?|[Rr][ée]f[ée]rent(?:e)?|[Ss]ous-traitant|" +
        "[Rr]epr[ée]sent[ée](?:e)?[ ]par|[Ss]ign[ée][ ]par|[Cc]ontact)" +
        "[ ]*:?[ ]+(" + MOT_NOM + PARTICULE + "(?:[ ]" + MOT_NOM + "){0,2})",
        "gd"
      ),
      "identite",
      function (v) { return !v.split(/[ ]/).some(estStop); }
    ));

    /* d) Motif structurel sans dictionnaire : « Oussama NIDHAMMOU » ou
       « NIDHAMMOU Oussama » — un mot capitalisé accolé à un mot tout en
       majuscules d'au moins 5 lettres (écarte les sigles SQL, HTML…). */
    poser(chercher(
      texte,
      new RegExp("\\b" + MOT_CAP + "[ ]" + MOT_MAJUSCULES + "\\b", "g"),
      "identite",
      function (v) { return !v.split(/[ ]/).some(estStop); }
    ));
    poser(chercher(
      texte,
      new RegExp("\\b" + MOT_MAJUSCULES + "[ ]" + MOT_CAP + "\\b", "g"),
      "identite",
      function (v) { return !v.split(/[ ]/).some(estStop); }
    ));

    /* e) Prénom du dictionnaire, avec l'éventuel nom autour. */
    var rxPrenom = new RegExp(MOT_CAP, "g");
    var candidats = [];
    var m;
    while ((m = rxPrenom.exec(texte)) !== null) {
      if (!estPrenom(m[0])) continue;
      var debut = m.index;
      var fin = m.index + m[0].length;

      // Nom(s) derrière : « Karim Benali », « Karim ben Ali », « Karim BENALI ».
      var suite = new RegExp("^" + PARTICULE + "(?:[ ]" + MOT_NOM + "){1,2}")
        .exec(texte.slice(fin, fin + 64));
      if (suite && suite[0] && !suite[0].trim().split(/[ ]/).some(estStop)) {
        fin += suite[0].length;
      }

      // Nom TOUT EN MAJUSCULES devant : « BENALI Karim ».
      var avantTexte = texte.slice(Math.max(0, debut - 40), debut);
      var avant = new RegExp("([" + MAJ + "][" + MAJ + "'’-]{2,})[ ]$").exec(avantTexte);
      if (avant && !estStop(avant[1])) debut -= avant[1].length + 1;

      candidats.push({ type: "identite", valeur: texte.slice(debut, fin), debut: debut, fin: fin });
    }
    poser(candidats);

    /* f) Nom déduit de l'adresse e-mail, puis propagation à tout le document.
       Deux manques que les motifs seuls ne couvraient pas :
         · un prénom absent du dictionnaire (rare, étranger) n'était jamais
           reconnu — alors que « prenom.nom@societe.fr » le donne en clair ;
         · un nom reconnu en en-tête restait en clair partout ailleurs, car
           chaque occurrence devait à nouveau correspondre à un motif. Or dans
           un CV le nom revient en pied de page, en filigrane, dans les
           références. Une seule occurrence oubliée annule l'anonymisation.
       La mémoire est portée par options.identites, que l'appelant partage
       entre les pages : un nom vu en première page vaut pour les suivantes. */
    var jetons = (options && options.identites) || new Set();

    for (var ie = 0; ie < retenues.length; ie++) {
      if (retenues[ie].type === "email") {
        var local = retenues[ie].valeur.split(/@|\(at\)|\[at\]/i)[0];
        var morceaux = local.split(/[._\-+\d]+/);
        for (var im = 0; im < morceaux.length; im++) ajouterJeton(jetons, morceaux[im]);
      } else if (retenues[ie].type === "identite") {
        var mots = retenues[ie].valeur.split(/[ ]+/);
        for (var iw = 0; iw < mots.length; iw++) ajouterJeton(jetons, mots[iw]);
      }
    }

    poser(chercherJetons(texte, jetons));

    retenues.sort(function (a, b) { return a.debut - b.debut; });
    return retenues;
  }

  /** Jeton d'identité retenu : au moins 4 lettres, et pas un mot courant —
      en deçà, propager reviendrait à masquer des fragments de phrase. */
  function ajouterJeton(ensemble, mot) {
    var propre = String(mot || "").replace(/[^A-Za-zÀ-ÿ'-]/g, "");
    var n = normaliser(propre);
    if (n.length < 4 || estStop(n)) return;
    ensemble.add(n);
  }

  function echapperRegex(t) {
    return t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  }

  /** Toutes les occurrences des jetons connus, sans égard à la casse ni aux
      accents. normaliser() remplace chaque caractère par un seul autre, donc
      les positions relevées dans le texte normalisé valent tel quel pour le
      texte d'origine. */
  function chercherJetons(texte, jetons) {
    if (!jetons || !jetons.size) return [];
    var norm = normaliser(texte);
    var sortie = [];
    jetons.forEach(function (jeton) {
      var rx = new RegExp("(?:^|[^a-z0-9])" + echapperRegex(jeton) + "(?![a-z0-9])", "g");
      var m;
      while ((m = rx.exec(norm)) !== null) {
        var debut = m.index + m[0].length - jeton.length;
        sortie.push({
          type: "identite",
          valeur: texte.slice(debut, debut + jeton.length),
          debut: debut,
          fin: debut + jeton.length,
        });
        rx.lastIndex = debut + jeton.length;
      }
    });
    sortie.sort(function (a, b) { return a.debut - b.debut; });
    return sortie;
  }

  function codePostalPlausible(cp) {
    var dep = Number(cp.slice(0, 2));
    return dep >= 1 && dep <= 98 && dep !== 96 && dep !== 99;
  }

  /* ── Masquage ──────────────────────────────────────────────────────────────
     Les zones masquées sont laissées EN BLANC, sans rien écrire dessus : ni
     pavé de « XXXX », ni étiquette. Le document produit se lit comme un
     document normal dont certaines informations n'ont simplement pas été
     renseignées. La référence, elle, n'est plus posée dans le texte : elle
     nomme le fichier et vit dans le registre, ce qui suffit à identifier le
     document sans l'écrire sur chaque page. */

  /* Alphabet mêlant lettres et chiffres, sans les caractères qu'on confond à la
     lecture ou à la dictée (0/O, 1/I/L, 5/S, 8/B) : une référence se recopie
     souvent à la main, et se lit au téléphone. */
  var ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ2346789";

  /**
   * Empreinte stable d'un document : 4 caractères tirés de son nom et de sa
   * taille. C'est la partie qui ne change jamais — elle sert à reconnaître un
   * document déjà traité, même des mois plus tard.
   */
  function empreinteDocument(graine) {
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    var s = String(graine || "");
    for (var i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
      h1 = (h1 * 0x01000193) >>> 0;
      h2 = (h2 + s.charCodeAt(i) * (i + 7)) >>> 0;
    }
    var melange = (h1 ^ h2) >>> 0;
    var code = "";
    for (var k = 0; k < 4; k++) {
      code += ALPHABET[melange % ALPHABET.length];
      melange = Math.floor(melange / ALPHABET.length) + (h1 % (k + 3));
    }
    // Au moins un chiffre et une lettre : un code tout en lettres se confond
    // avec un mot, un code tout en chiffres avec une date ou un montant.
    if (!/\d/.test(code)) code = code.slice(0, 3) + "2346789"[h2 % 7];
    if (!/[A-Z]/.test(code)) code = "ACDEFGH"[h1 % 7] + code.slice(1);
    return code;
  }

  /** « CV » pour un CV ou un dossier de compétences, « DOC » sinon. */
  function prefixeDocument(nom) {
    return /(^|[^a-z])(cv|curriculum|resum|r[ée]sum|dossier|profil)/.test(String(nom || "").toLowerCase())
      ? "CV" : "DOC";
  }

  /**
   * Référence lisible d'un document : « CV-2608-K7M2 ».
   *
   * Trois parties qui se lisent : la nature du document, l'année et le mois du
   * traitement, puis l'empreinte. On sait donc d'un coup d'œil de quoi il
   * s'agit et de quand cela date, là où un code purement aléatoire n'apprenait
   * rien. Le mois vient du PREMIER traitement : c'est le serveur qui attribue
   * la référence, pour qu'un même document garde la sienne indéfiniment.
   */
  function construireReference(prefixe, quand, empreinte) {
    var d = quand instanceof Date ? quand : new Date(quand || Date.now());
    var aa = String(d.getFullYear()).slice(2);
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    return prefixe + "-" + aa + mm + "-" + empreinte;
  }

  var MOTIF_REFERENCE = /^(?:CV|DOC)-\d{4}-[A-Z0-9]{4}$/;

  /**
   * Nom du fichier produit : « CV_ADBI-7K4M (anonymisé).pdf ».
   *
   * Le nom d'origine porte presque toujours l'identité — « CV Sophie
   * Martin.pdf » — et ce nom-là voyage en pièce jointe, s'affiche dans les
   * listes de fichiers et se retrouve dans les journaux des serveurs de
   * messagerie. Masquer le nom dans le document sans le masquer dans le nom du
   * fichier ne protège rien.
   */
  function nommerSortie(nomOrigine, extension, reference, anonymise) {
    // La référence porte déjà la nature du document (« CV-2608-K7M2 ») :
    // la répéter en préfixe donnerait « CV_CV-2608-K7M2 ».
    return reference + (anonymise ? " (anonymisé)" : " (protégé)") + extension;
  }

  return {
    analyserPage: analyserPage,
    TYPES: TYPES,
    empreinteDocument: empreinteDocument,
    prefixeDocument: prefixeDocument,
    construireReference: construireReference,
    MOTIF_REFERENCE: MOTIF_REFERENCE,
    nommerSortie: nommerSortie,
  };
})();

/* Le même fichier sert au navigateur (PDF) et au serveur (Word). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = COFFRE_DETECTEURS;
}
