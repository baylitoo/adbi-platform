// Checklist des documents a collecter aupres du Sous-Traitant.
// dateField:true => champ "delivre le" + verification de validite (6 mois) cote front.

const checklistSousTraitance = [
  { id: "kbis", label: "Une copie à jour du Kbis de la société", art: "Art. 12", recurrent: "À renouveler tous les 6 mois", dateField: true },
  { id: "fiscale", label: "L'attestation de régularité fiscale", art: "Art. 12", recurrent: "" },
  { id: "urssaf", label: "L'attestation de vigilance URSSAF", art: "Art. 12", recurrent: "À renouveler tous les 6 mois", dateField: true },
  { id: "rib", label: "Un RIB", art: "Facturation", recurrent: "" },
  { id: "coordonnees", label: "Coordonnées complètes pour le contrat (adresse, représentant légal, etc.)", art: "Identification", recurrent: "" },
  { id: "cni", label: "Pièce d'identité du consultant (afin de créer ses accès)", art: "Identité", recurrent: "" },
  { id: "specifique", label: "Toute information spécifique à inclure (clauses particulières, confidentialité, propriété intellectuelle, etc.)", art: "", recurrent: "" },
];

const CHECKLISTS = { "sous-traitance": checklistSousTraitance, cdi: [], cdd: [] };

module.exports = { CHECKLISTS };
