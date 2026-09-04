// Definition des champs (variables) du formulaire, par type de contrat.
// Chaque champ : key, label, type, default, group, help, placeholder, full (pleine largeur)
//
// Les champs propres au contrat sont VIDES par defaut ; un exemple s'affiche en gris
// dans le champ (placeholder) pour montrer quoi saisir. Les infos ADBI (constantes)
// et les clauses standard restent pre-remplies.

const ADBI_DEFAULTS = {
  adbiNom: "A.D.B.I",
  adbiAdresse: "5 rue du Banquier 75013 Paris",
  adbiCapital: "SARL au capital de 250.000 €",
  adbiRcs: "RCS Paris n° 805 321 650",
  adbiRepresentant: "Monsieur Ahcene OUGUENOUNE",
  comptaContact: "Sofiane TAFAT",
  comptaTel: "01 86 95 71 61",
  comptaEmail: "compta.fournisseur@adbi.fr",
  tribunal: "PARIS",
  lieuRedaction: "Paris",
};

// Champs communs / sous-traitance (freelance)
const sousTraitance = [
  // Identification du contrat
  { key: "numeroContrat", label: "N° de contrat", group: "Contrat", default: "", placeholder: "ex : 01-06-2026", required: true },
  { key: "version", label: "Version", group: "Contrat", default: "1" },
  { key: "dateRedaction", label: "Fait le (date)", group: "Contrat", default: "", type: "date" },
  { key: "lieuRedaction", label: "Fait à", group: "Contrat", default: ADBI_DEFAULTS.lieuRedaction },

  // ADBI (le Client) - pre-rempli, modifiable
  { key: "adbiNom", label: "Raison sociale ADBI", group: "ADBI (Client)", default: ADBI_DEFAULTS.adbiNom },
  { key: "adbiAdresse", label: "Adresse ADBI", group: "ADBI (Client)", default: ADBI_DEFAULTS.adbiAdresse, full: true },
  { key: "adbiCapital", label: "Capital", group: "ADBI (Client)", default: ADBI_DEFAULTS.adbiCapital },
  { key: "adbiRcs", label: "RCS", group: "ADBI (Client)", default: ADBI_DEFAULTS.adbiRcs },
  { key: "adbiRepresentant", label: "Représentée par", group: "ADBI (Client)", default: ADBI_DEFAULTS.adbiRepresentant },

  // Sous-traitant (la societe freelance) - vide, ou rempli via la recherche par nom/SIREN
  { key: "stNom", label: "Raison sociale du Sous-Traitant", group: "Sous-Traitant", default: "", placeholder: "ex : SUND INDUSTRY SYSTEM", required: true },
  { key: "stAdresse", label: "Adresse", group: "Sous-Traitant", default: "", placeholder: "ex : 60 rue François 1er, 75008 Paris", full: true },
  { key: "stSiren", label: "SIREN", group: "Sous-Traitant", default: "", placeholder: "ex : 941091316" },
  { key: "stSiret", label: "SIRET", group: "Sous-Traitant", default: "", placeholder: "ex : 94109131600013" },
  { key: "stRepresentant", label: "Représentée par", group: "Sous-Traitant", default: "", placeholder: "ex : Monsieur Corentin CALVO" },
  { key: "stFormeJuridique", label: "Forme juridique", group: "Sous-Traitant", default: "", placeholder: "ex : SAS au capital de 1 000 €" },
  { key: "stQualite", label: "Qualité du représentant", group: "Sous-Traitant", default: "", placeholder: "ex : Président" },
  { key: "stEmail", label: "Email (envoi en signature)", group: "Sous-Traitant", default: "", placeholder: "ex : contact@societe.fr", help: "Adresse à laquelle le lien de signature électronique sera transmis." },

  // Signataire réel (peut différer du président/représentant indiqué en tête de contrat)
  { key: "stSignataireNom", label: "Signataire (si différent du représentant)", group: "Signataire", default: "", placeholder: "ex : Madame Julie MARTIN", help: "La personne qui signe réellement. Laisser vide si c'est le représentant ci-dessus." },
  { key: "stSignataireQualite", label: "En qualité de", group: "Signataire", default: "", placeholder: "ex : Directrice administrative", help: "Laisser vide pour un entrepreneur individuel (il signe pour lui-même)." },

  // Intervenant / consultant
  { key: "consultantNom", label: "Nom de l'intervenant", group: "Intervenant", default: "", placeholder: "ex : Monsieur Calvo Corentin", required: true },
  { key: "consultantFonction", label: "Fonction", group: "Intervenant", default: "", placeholder: "ex : Développeur Full stack" },
  { key: "consultantTel", label: "Téléphone", group: "Intervenant", default: "", placeholder: "ex : 07 70 36 73 15" },

  // Mission
  { key: "clientFinal", label: "Client final", group: "Mission", default: "", placeholder: "ex : Groupe Accor", required: true },
  { key: "natureTravaux", label: "Nature des travaux", group: "Mission", default: "", full: true, textarea: true, placeholder: "ex : Développement full stack de la plateforme de réservation (React / Node.js)…", help: "Description de la prestation réalisée" },
  { key: "lieuExecution", label: "Lieu d'exécution", group: "Mission", default: "", full: true, placeholder: "ex : 82 rue Henry Farman, 92130 Issy-les-Moulineaux", help: "Adresse du site client" },
  { key: "dateDebut", label: "Date de début", group: "Mission", default: "", type: "date", required: true },
  { key: "dateFin", label: "Date de fin", group: "Mission", default: "", type: "date", required: true },

  // Conditions financieres
  { key: "tjm", label: "TJM (€ HT / jour)", group: "Conditions financières", default: "", type: "number", placeholder: "ex : 420", required: true },
  { key: "delaiPaiement", label: "Délai de paiement (jours)", group: "Conditions financières", default: "45", type: "number" },
  { key: "craValidePar", label: "CRA validé par", group: "Conditions financières", default: "", placeholder: "ex : Monsieur André Dixe", help: "Responsable côté client final" },
  { key: "comptaContact", label: "Contact compta ADBI", group: "Conditions financières", default: ADBI_DEFAULTS.comptaContact },
  { key: "comptaTel", label: "Tél. compta", group: "Conditions financières", default: ADBI_DEFAULTS.comptaTel },
  { key: "comptaEmail", label: "Email compta", group: "Conditions financières", default: ADBI_DEFAULTS.comptaEmail },

  // Suivi
  { key: "bmNom", label: "Business Manager ADBI", group: "Suivi", default: "", placeholder: "ex : M. Amine OUKLI" },
  { key: "bmEmail", label: "Email", group: "Suivi", default: "", placeholder: "ex : aoukli@adbi.fr" },
  { key: "bmTel", label: "Téléphone", group: "Suivi", default: "", placeholder: "ex : 06 69 15 97 25" },

  // Clauses parametrables (valeurs standard)
  { key: "dureeNonSollicitation", label: "Indemnité non-sollicitation (Art. 13)", group: "Clauses", default: "Six mois de rémunération brute" },
  { key: "dureeExclusivite", label: "Durée d'exclusivité (Art. 14)", group: "Clauses", default: "douze « 12 » mois" },
  { key: "tribunal", label: "Tribunal compétent (Art. 19)", group: "Clauses", default: ADBI_DEFAULTS.tribunal },
];

// Options (annexes activables) - les articles 13/14 sont desormais dans le corps du contrat
const optionsSousTraitance = [
  { key: "optProprieteAnnexe", label: "Annexe 1 — Propriété intellectuelle & commerciale", default: true },
  { key: "optAnticorruption", label: "Annexe 2 — Anticorruption (Loi Sapin 2)", default: true },
  { key: "optRgpd", label: "Annexe 3 — Protection des données (RGPD)", default: true },
];

// ------------------------------------------------------------------
// Avenant à la convention de sous-traitance : référence un contrat déjà
// existant (n° + date) + reprend les infos (parties, mission, prix, suivi),
// idéalement pré-remplies depuis l'Historique.
// ------------------------------------------------------------------
// Avenant UNIVERSEL : s'adapte à n'importe quel contrat initial (sous-traitance,
// CDS, CDI, CDD) via un sélecteur de type. Il référence le contrat, énonce l'objet
// (ce qui change) et maintient les autres conditions. Parties pré-remplies depuis l'Historique.
const CONTRAT_TYPES = [
  { value: "sous-traitance", label: "Convention de sous-traitance" },
  { value: "cds", label: "Contrat Centre de services (CDS)" },
  { value: "cdi", label: "Contrat de travail (CDI)" },
  { value: "cdd", label: "Contrat de travail (CDD)" },
];
const avenant = [
  // Référence au contrat initial
  { key: "numeroAvenant", label: "N° d'avenant", group: "Avenant", default: "", placeholder: "ex : 2", required: true, help: "Règle de nommage : numéro d'ordre de l'avenant POUR CE CONTRAT (1er avenant = 1, 2e = 2…). Rempli automatiquement quand l'avenant est créé depuis l'historique ; le document s'intitulera « AVENANT N° x » et sera rangé sous son contrat initial." },
  { key: "contratType", label: "Type du contrat initial", group: "Avenant", default: "sous-traitance", type: "select", options: CONTRAT_TYPES, help: "Le type de contrat que cet avenant modifie : les libellés du document (Client / Sous-Traitant / Prestataire / Salarié…) s'adaptent automatiquement." },
  { key: "numeroContratInitial", label: "N° du contrat initial", group: "Avenant", default: "", placeholder: "ex : 01-07-2025", required: true, help: "Le numéro EXACT du contrat que l'avenant modifie (la liste propose ceux de l'historique). C'est ce numéro qui rattache l'avenant à son contrat dans l'historique." },
  { key: "dateContratInitial", label: "Date du contrat initial", group: "Avenant", default: "", type: "date", help: "La date « Fait le » du contrat d'origine (reprise automatiquement depuis l'historique)." },
  { key: "objetAvenant", label: "Objet de l'avenant", group: "Avenant", default: "", full: true, textarea: true, placeholder: "ex : prolongation de la mission jusqu'au 31/12/2026", help: "Ce que l'avenant modifie", required: true },
  { key: "dateEffet", label: "Prend effet le", group: "Avenant", default: "", type: "date", help: "Date à partir de laquelle les modifications de l'avenant s'appliquent (souvent le lendemain de la fin initiale pour une prolongation)." },
  { key: "dateRedaction", label: "Fait le (date)", group: "Avenant", default: "", type: "date" },
  { key: "lieuRedaction", label: "Fait à", group: "Avenant", default: ADBI_DEFAULTS.lieuRedaction },

  // Parties (désignations adaptées au type ; pré-remplies depuis l'Historique)
  { key: "avPartie1Nom", label: "Partie 1 — raison sociale", group: "Parties", default: "", placeholder: "ex : ADBI" },
  { key: "avPartie1Repr", label: "Partie 1 — représentée par", group: "Parties", default: "", placeholder: "ex : Monsieur Ahcene OUGUENOUNE" },
  { key: "avPartie1Qualite", label: "Partie 1 — en qualité de", group: "Parties", default: "", placeholder: "ex : Gérant" },
  { key: "avPartie2Nom", label: "Partie 2 — raison sociale", group: "Parties", default: "", placeholder: "ex : SUND INDUSTRY SYSTEM" },
  { key: "avPartie2Repr", label: "Partie 2 — représentée par", group: "Parties", default: "", placeholder: "ex : Monsieur Corentin CALVO" },
  { key: "avPartie2Qualite", label: "Partie 2 — en qualité de", group: "Parties", default: "", placeholder: "ex : Président (vide si entrepreneur individuel)" },
];

// ------------------------------------------------------------------
// CDS — Contrat de prestations informatiques du Centre de Services.
// ICI ADBI est le PRESTATAIRE (fixe), l'autre partie est LE CLIENT.
// ------------------------------------------------------------------
const cds = [
  // Contrat
  { key: "numeroContrat", label: "N° de contrat", group: "Contrat", default: "", placeholder: "ex : CDS-2025-014", required: true },
  { key: "dateRedaction", label: "Fait à Paris le", group: "Contrat", default: "", type: "date" },

  // Client (le donneur d'ordre)
  { key: "clientNom", label: "Raison sociale du Client", group: "Client", default: "", placeholder: "ex : ACME SAS", required: true },
  { key: "clientFormeJuridique", label: "Forme juridique", group: "Client", default: "Société par actions simplifiée" },
  { key: "clientAdresse", label: "Adresse", group: "Client", default: "", full: true, placeholder: "ex : 12 rue de la République, 69002 Lyon" },
  { key: "clientCapital", label: "Capital", group: "Client", default: "", placeholder: "ex : 50 000 €" },
  { key: "clientRcs", label: "RCS", group: "Client", default: "", placeholder: "ex : RCS de Lyon n° 900 000 000" },
  { key: "clientTva", label: "N° TVA intracommunautaire", group: "Client", default: "", placeholder: "ex : FR00 900000000" },
  { key: "clientDomaine", label: "Domaine d'activité du Client", group: "Client", default: "", placeholder: "ex : la distribution spécialisée", help: "…spécialisé dans le domaine de …" },
  { key: "clientSignataireNom", label: "Signataire du Client (nom)", group: "Client", default: "", placeholder: "ex : Madame Claire DUPONT" },
  { key: "clientSignataireFonction", label: "Signataire — en qualité de", group: "Client", default: "", placeholder: "ex : Directrice Générale" },

  // Centre de services — tarifs
  { key: "mntSouscription", label: "Souscription mensuelle (€ HT)", group: "Centre de services", default: "", type: "number", placeholder: "ex : 1500" },
  { key: "pack40", label: "Pack 40 heures (€ HT)", group: "Centre de services", default: "", type: "number" },
  { key: "pack80", label: "Pack 80 heures (€ HT)", group: "Centre de services", default: "", type: "number" },
  { key: "pack200", label: "Pack 200 heures (€ HT)", group: "Centre de services", default: "", type: "number" },
  { key: "pack400", label: "Pack 400 heures (€ HT)", group: "Centre de services", default: "", type: "number" },

  // Régie — tarifs
  { key: "tjmExpert", label: "TJM Expert Technique (€ HT)", group: "Régie", default: "", type: "number" },
  { key: "tjmConsultant", label: "TJM Consultant CDS (€ HT)", group: "Régie", default: "", type: "number" },

  // Suivi — interlocuteur côté Client
  { key: "clientSuiviNom", label: "Interlocuteur Client (nom)", group: "Suivi", default: "", placeholder: "ex : Monsieur Paul MARTIN" },
  { key: "clientSuiviFonction", label: "Fonction", group: "Suivi", default: "" },
  { key: "clientSuiviEmail", label: "Email", group: "Suivi", default: "" },
  { key: "clientSuiviTel", label: "Téléphone", group: "Suivi", default: "" },
];

module.exports = { sousTraitance, optionsSousTraitance, ADBI_DEFAULTS, avenant, cds };
