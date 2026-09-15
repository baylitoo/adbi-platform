"use strict";

// Transport OpenAI (Responses API) — modèle EXTERNE, choisi explicitement (#194).
// Portage jumeau de openai_responses.py.
//
// Ce module n'est jamais un repli : un consommateur ne l'appelle que lorsque
// l'utilisateur a choisi une entrée OpenAI du catalogue
// (document-parsing/models/catalogue.json, `externes`). Aucun autre modèle, ni
// DocIE ni analyse locale, ne prend le relais en cas d'échec (« échouer
// bruyamment », #194).
//
// Schéma : conversion de NOTRE format de schéma dynamique DocIE
// ({document_type, fields: [{name, type, description, fields}]}) vers un JSON
// Schema strict de Structured Outputs. Règles vérifiées dans la documentation
// OpenAI (guide Structured Outputs, consulté le 2026-09-16) : tous les champs
// `required`, `additionalProperties: false` à chaque objet, racine objet, champ
// facultatif émulé par une union avec "null". `format: "date"` n'y est PAS
// confirmé : la date est une chaîne dont le format est dit en description, sans
// motif imposé (un motif forcerait le modèle à inventer un jour absent).
//
// Forme du résultat : celle que rend le bridge DocIE APRÈS déballage des
// enveloppes, pour que les mappings des consommateurs servent sans changement :
//   string / date / number -> chaîne ou null (DocIE sérialise ses Decimal en
//                             chaîne : document-parsing/mappings/contract_to_contrats.py)
//   money                  -> {amount: chaîne|null, currency: chaîne|null}
//   object                 -> objet (jamais null), feuilles nulles si absentes
//   list                   -> tableau d'objets (ou de chaînes sans sous-champ), [] si absent

const NOM_CHAMP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TYPE_DOCUMENT = /^[a-z0-9_]{1,50}$/;

// Consignes de forme ajoutées à la description d'un champ. Identiques
// caractère pour caractère dans openai_responses.py (test de parité).
const CONSIGNE_DATE = "Date au format AAAA-MM-JJ lorsque le jour, le mois et l'année sont imprimés ; sinon recopiée telle qu'imprimée ; null si absente.";
const CONSIGNE_NOMBRE = "Nombre écrit en chiffres avec un point décimal, sans séparateur de milliers ni unité ; null si absent.";
const CONSIGNE_MONTANT = "Montant écrit en chiffres avec un point décimal, sans séparateur de milliers ni symbole ; null si absent.";
const CONSIGNE_DEVISE = "Code ISO 4217 de la devise (EUR pour « € ») lorsqu'elle est imprimée ; null sinon.";

class ErreurSchema extends Error {
  constructor(message) { super(message); this.name = "ErreurSchema"; }
}

function objet(valeur) { return valeur !== null && typeof valeur === "object" && !Array.isArray(valeur); }

function description(champ, consigne = null) {
  const propre = typeof champ.description === "string" && champ.description.trim() ? champ.description.trim() : null;
  const texte = [propre, consigne].filter(Boolean).join(" — ");
  return texte ? { description: texte } : {};
}

function objetStrict(champs, chemin) {
  if (!Array.isArray(champs) || !champs.length) throw new ErreurSchema("Objet sans sous-champ : " + (chemin || "racine") + ".");
  const properties = {};
  for (const champ of champs) {
    if (!objet(champ) || typeof champ.name !== "string" || !NOM_CHAMP.test(champ.name)) {
      throw new ErreurSchema("Nom de champ invalide sous " + (chemin || "racine") + ".");
    }
    if (Object.hasOwn(properties, champ.name)) throw new ErreurSchema("Champ en double : " + champ.name + ".");
    properties[champ.name] = champOpenAI(champ, chemin ? chemin + "." + champ.name : champ.name);
  }
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function champOpenAI(champ, chemin) {
  switch (champ.type) {
    case "string":
      return { type: ["string", "null"], ...description(champ) };
    case "date":
      return { type: ["string", "null"], ...description(champ, CONSIGNE_DATE) };
    case "number":
      return { type: ["string", "null"], ...description(champ, CONSIGNE_NOMBRE) };
    case "money":
      return {
        type: "object",
        ...description(champ),
        properties: {
          amount: { type: ["string", "null"], description: CONSIGNE_MONTANT },
          currency: { type: ["string", "null"], description: CONSIGNE_DEVISE },
        },
        required: ["amount", "currency"],
        additionalProperties: false,
      };
    case "object":
      return { ...objetStrict(champ.fields, chemin), ...description(champ) };
    case "list": {
      const sous = Array.isArray(champ.fields) ? champ.fields : [];
      const items = sous.length ? objetStrict(sous, chemin + "[]") : { type: "string" };
      return { type: "array", ...description(champ, "Liste vide si absente."), items };
    }
    default:
      throw new ErreurSchema("Type de champ non pris en charge : " + chemin + ".");
  }
}

/**
 * Schéma dynamique DocIE -> { name, schema } pour `text.format` (json_schema, strict).
 * Lève ErreurSchema (le transport la traduit en code `input`).
 */
function schemaOpenAI(dynamicSchema) {
  if (!objet(dynamicSchema) || typeof dynamicSchema.document_type !== "string" || !TYPE_DOCUMENT.test(dynamicSchema.document_type)) {
    throw new ErreurSchema("Schéma dynamique sans document_type valide.");
  }
  return { name: "adbi_" + dynamicSchema.document_type, schema: objetStrict(dynamicSchema.fields, "") };
}

module.exports = { schemaOpenAI, ErreurSchema, CONSIGNE_DATE, CONSIGNE_NOMBRE, CONSIGNE_MONTANT, CONSIGNE_DEVISE };
