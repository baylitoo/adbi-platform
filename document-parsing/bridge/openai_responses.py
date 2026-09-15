"""Transport OpenAI (Responses API) — modèle EXTERNE, choisi explicitement (#194).

Portage jumeau de openai-responses.js ; mêmes règles, mêmes chaînes.

Ce module n'est jamais un repli : un consommateur ne l'appelle que lorsque
l'utilisateur a choisi une entrée OpenAI du catalogue
(document-parsing/models/catalogue.json, ``externes``). Aucun autre modèle, ni
DocIE ni analyse locale, ne prend le relais en cas d'échec (« échouer
bruyamment », #194).

Schéma : conversion de NOTRE format de schéma dynamique DocIE vers un JSON
Schema strict de Structured Outputs (tous les champs requis,
``additionalProperties: false``, facultatif = union avec "null", racine objet ;
guide Structured Outputs consulté le 2026-09-16). ``format: "date"`` n'y est pas
confirmé : la date est une chaîne dont le format est dit en description, sans
motif imposé (un motif forcerait le modèle à inventer un jour absent).

Forme du résultat : celle du bridge DocIE après déballage des enveloppes
(string/date/number -> chaîne ou None ; money -> {amount, currency} ; object ->
objet ; list -> liste), pour que les mappings des consommateurs servent tels quels.
"""
import re

NOM_CHAMP = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
TYPE_DOCUMENT = re.compile(r"[a-z0-9_]{1,50}")

CONSIGNE_DATE = ("Date au format AAAA-MM-JJ lorsque le jour, le mois et l'année sont imprimés ; "
                 "sinon recopiée telle qu'imprimée ; null si absente.")
CONSIGNE_NOMBRE = "Nombre écrit en chiffres avec un point décimal, sans séparateur de milliers ni unité ; null si absent."
CONSIGNE_MONTANT = "Montant écrit en chiffres avec un point décimal, sans séparateur de milliers ni symbole ; null si absent."
CONSIGNE_DEVISE = "Code ISO 4217 de la devise (EUR pour « € ») lorsqu'elle est imprimée ; null sinon."


class ErreurSchema(ValueError):
    pass


def _description(champ, consigne=None):
    propre = champ.get("description")
    propre = propre.strip() if isinstance(propre, str) and propre.strip() else None
    texte = " — ".join(t for t in (propre, consigne) if t)
    return {"description": texte} if texte else {}


def _objet_strict(champs, chemin):
    if not isinstance(champs, list) or not champs:
        raise ErreurSchema("Objet sans sous-champ : " + (chemin or "racine") + ".")
    properties = {}
    for champ in champs:
        if not isinstance(champ, dict) or not isinstance(champ.get("name"), str) or not NOM_CHAMP.fullmatch(champ["name"]):
            raise ErreurSchema("Nom de champ invalide sous " + (chemin or "racine") + ".")
        if champ["name"] in properties:
            raise ErreurSchema("Champ en double : " + champ["name"] + ".")
        properties[champ["name"]] = _champ_openai(champ, chemin + "." + champ["name"] if chemin else champ["name"])
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _champ_openai(champ, chemin):
    genre = champ.get("type")
    if genre == "string":
        return {"type": ["string", "null"], **_description(champ)}
    if genre == "date":
        return {"type": ["string", "null"], **_description(champ, CONSIGNE_DATE)}
    if genre == "number":
        return {"type": ["string", "null"], **_description(champ, CONSIGNE_NOMBRE)}
    if genre == "money":
        return {
            "type": "object",
            **_description(champ),
            "properties": {
                "amount": {"type": ["string", "null"], "description": CONSIGNE_MONTANT},
                "currency": {"type": ["string", "null"], "description": CONSIGNE_DEVISE},
            },
            "required": ["amount", "currency"],
            "additionalProperties": False,
        }
    if genre == "object":
        return {**_objet_strict(champ.get("fields"), chemin), **_description(champ)}
    if genre == "list":
        sous = champ.get("fields") if isinstance(champ.get("fields"), list) else []
        items = _objet_strict(sous, chemin + "[]") if sous else {"type": "string"}
        return {"type": "array", **_description(champ, "Liste vide si absente."), "items": items}
    raise ErreurSchema("Type de champ non pris en charge : " + chemin + ".")


def schema_openai(dynamic_schema):
    """Schéma dynamique DocIE -> {"name", "schema"} pour ``text.format`` (json_schema, strict).

    Lève ErreurSchema (le transport la traduit en code ``input``).
    """
    if (not isinstance(dynamic_schema, dict) or not isinstance(dynamic_schema.get("document_type"), str)
            or not TYPE_DOCUMENT.fullmatch(dynamic_schema["document_type"])):
        raise ErreurSchema("Schéma dynamique sans document_type valide.")
    return {"name": "adbi_" + dynamic_schema["document_type"], "schema": _objet_strict(dynamic_schema.get("fields"), "")}
