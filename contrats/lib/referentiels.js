// Référentiels persistés (clients + valideurs CRA + lieux, et managers/BM).
// Stockés dans data/referentiels.json. Aucune donnée personnelle sensible.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "referentiels.json");

const DEFAULT = {
  clients: [
    {
      nom: "Groupe Accor",
      craValidateurs: ["Monsieur André Dixe"],
      lieux: ["82 rue Henry Farman, 92130 Issy-les-Moulineaux"],
    },
  ],
  managers: [
    { nom: "M. Amine OUKLI", email: "aoukli@adbi.fr", tel: "06 69 15 97 25" },
    { nom: "Mme Kahina MAKHLOUFI", email: "kmakhloufi@adbi.fr", tel: "06 69 15 97 51" },
    { nom: "Mme Sonia BOULABAS", email: "sboulabas@adbi.fr", tel: "+33 (0)6 60 70 96 76" },
  ],
  // Signataires réutilisables (personnes qui signent, côté cocontractant) : nom + qualité.
  signataires: [],
  // Entreprises sous-traitantes réutilisables (fiche complète pour pré-remplir le contrat).
  soustraitants: [],
};

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return {
        clients: Array.isArray(d.clients) ? d.clients : [],
        managers: Array.isArray(d.managers) ? d.managers : [],
        signataires: Array.isArray(d.signataires) ? d.signataires : [],
        soustraitants: Array.isArray(d.soustraitants) ? d.soustraitants : [],
      };
    }
  } catch (e) { /* fichier corrompu : on repart du défaut */ }
  // Première utilisation : on sème le fichier avec les valeurs par défaut.
  try { fs.writeFileSync(FILE, JSON.stringify(DEFAULT, null, 2)); } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT));
}

function save(data) {
  const clean = {
    clients: (Array.isArray(data && data.clients) ? data.clients : []).map((c) => ({
      nom: String(c.nom || "").trim(),
      siren: String(c.siren || "").trim(),
      adresse: String(c.adresse || "").trim(),
      email: String(c.email || "").trim(),
      tel: String(c.tel || "").trim(),
      craValidateurs: Array.isArray(c.craValidateurs) ? c.craValidateurs.filter(Boolean) : [],
      lieux: Array.isArray(c.lieux) ? c.lieux.filter(Boolean) : [],
    })).filter((c) => c.nom),
    managers: (Array.isArray(data && data.managers) ? data.managers : []).map((m) => ({
      nom: String(m.nom || "").trim(),
      email: String(m.email || "").trim(),
      tel: String(m.tel || "").trim(),
    })).filter((m) => m.nom),
    signataires: (Array.isArray(data && data.signataires) ? data.signataires : []).map((s) => ({
      nom: String(s.nom || "").trim(),
      qualite: String(s.qualite || "").trim(),
    })).filter((s) => s.nom),
    soustraitants: (Array.isArray(data && data.soustraitants) ? data.soustraitants : []).map((e) => ({
      nom: String(e.nom || "").trim(),
      formeJuridique: String(e.formeJuridique || "").trim(),
      adresse: String(e.adresse || "").trim(),
      siren: String(e.siren || "").trim(),
      siret: String(e.siret || "").trim(),
      representant: String(e.representant || "").trim(),
      qualite: String(e.qualite || "").trim(),
      email: String(e.email || "").trim(),
    })).filter((e) => e.nom),
  };
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { load, save };
