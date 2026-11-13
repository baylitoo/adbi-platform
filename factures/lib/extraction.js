"use strict";

const path = require("path");

// contrats/lib et document-parsing sont copiés à la racine de l'image : même profondeur relative qu'en checkout.
const CONTRATS_LIB = path.join(__dirname, "..", "..", "contrats", "lib");
const PONT = path.join(__dirname, "..", "..", "document-parsing", "bridge", "docie-bridge.js");
const CATALOGUE = path.join(__dirname, "..", "..", "document-parsing", "models", "catalogue.js");
const SCHEMA = path.join(__dirname, "..", "..", "document-parsing", "schemas", "facture.schema.json");

const { lireDocument, sniffMime, signauxPartielsPublics } = require(path.join(CONTRATS_LIB, "docie-extraction"));
const { normalizeDate } = require(path.join(CONTRATS_LIB, "kbis-mapping"));
const { storePret, rafraichirStore } = require(path.join(CONTRATS_LIB, "choix-modele"));

const KIND = "facture";
const CHAMPS_TEXTE = ["fournisseur", "siren", "siret", "tva_intracom", "numero", "iban", "bic", "devise"];
const CHAMPS_DATE = ["date_facture", "date_echeance"];
const CHAMPS_MONTANT = ["total_ht", "total_tva", "total_ttc"];
const CHAMPS_LIGNE = ["quantite", "pu_ht", "taux_tva", "total_ht"];

function texte(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// Lit un montant écrit à la française ou à l'anglaise ; null si illisible.
function lireNombre(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = texte(v).replace(/[\s  €%]|EUR/gi, "");
  if (!s) return null;
  const virgule = s.lastIndexOf(","), point = s.lastIndexOf(".");
  if (virgule > -1 && point > -1) s = virgule > point ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (virgule > -1) s = s.replace(/,/g, (m, i) => (i === virgule ? "." : ""));
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Number(s);
}

function lireDate(v, champ, avertissements) {
  const brut = texte(v);
  if (!brut) return "";
  const iso = normalizeDate(brut, champ, avertissements);
  if (!iso) avertissements.push(champ + " : date « " + brut + " » non reconnue, à saisir.");
  return iso || "";
}

// Résultat DocIE déballé -> données de facture normalisées (ISO, nombres), jamais recalculées.
function normaliserResultat(result) {
  const r = result && typeof result === "object" ? result : {};
  const avertissements = [];
  const donnees = {};
  for (const c of CHAMPS_TEXTE) donnees[c] = texte(r[c]);
  for (const c of CHAMPS_DATE) donnees[c] = lireDate(r[c], c, avertissements);
  for (const c of CHAMPS_MONTANT) {
    donnees[c] = lireNombre(r[c]);
    if (donnees[c] === null && texte(r[c])) avertissements.push(c + " : montant « " + texte(r[c]) + " » illisible.");
  }
  donnees.siren = donnees.siren.replace(/\D/g, "") || donnees.siren;
  donnees.siret = donnees.siret.replace(/\D/g, "") || donnees.siret;
  donnees.lignes = (Array.isArray(r.lignes) ? r.lignes : [])
    .filter((l) => l && typeof l === "object")
    .map((l) => {
      const ligne = { designation: texte(l.designation) };
      for (const c of CHAMPS_LIGNE) ligne[c] = lireNombre(l[c]);
      return ligne;
    })
    .filter((l) => l.designation || CHAMPS_LIGNE.some((c) => l[c] !== null));
  if (!donnees.devise) donnees.devise = "EUR";
  return { donnees, avertissements };
}

function chargerPont() { return require(PONT); }
function chargerCatalogue() { return require(CATALOGUE); }

// Premier modèle proposé par le catalogue pour la voie (défaut d'abord), ou null : le pont retombe alors sur l'environnement.
function offre(voie, document, env) {
  try {
    return chargerCatalogue().modelesOfferts(KIND, voie, { env, document, store: storePret() })[0] || null;
  } catch (e) {
    console.error("[extraction] catalogue illisible :", e.message);
    return null;
  }
}

function metadonnees(reponse, voie, choisi) {
  const m = (reponse && reponse.metadata) || {};
  return {
    voie,
    modele: choisi ? { id: choisi.id, libelle: choisi.libelle } : null,
    modeleServi: m.model || null,
    agent: m.agent || null,
    requete: m.request_id || null,
    confiance: m.field_confidence || {},
    ...signauxPartielsPublics(m),
  };
}

// Lit le fichier : couche texte -> voie texte avec le schéma en ligne ; scan ou image -> agent Studio adbi_facture.
async function extraireFacture(buffer, mimeDeclare, { env = process.env } = {}) {
  const pont = chargerPont();
  const mime = sniffMime(mimeDeclare, buffer);
  await rafraichirStore(env);
  const lecture = await lireDocument(buffer, mime);
  let reponse, voie, choisi;
  if (lecture.ok) {
    voie = "texte";
    choisi = offre("texte", { lignesNonVides: chargerCatalogue().compterLignesNonVides(lecture.texte) }, env);
    const options = { kind: KIND, dynamicSchema: require(SCHEMA), langue: "fr", env };
    if (choisi) options.modelProfile = choisi.identifiant;
    reponse = await pont.extractText(lecture.texte, options);
  } else {
    voie = "agent";
    choisi = offre("agent", typeof lecture.pages === "number" ? { pages: lecture.pages } : null, env);
    const options = { kind: KIND, env };
    if (choisi) options.agent = choisi.identifiant;
    reponse = await pont.extractDocument(buffer, mime, options);
  }
  const { donnees, avertissements } = normaliserResultat(reponse.result);
  return { donnees, extraction: { ...metadonnees(reponse, voie, choisi), avertissements, raisonVoie: lecture.ok ? null : lecture.raison } };
}

module.exports = { extraireFacture, normaliserResultat, lireNombre, sniffMime, KIND };
