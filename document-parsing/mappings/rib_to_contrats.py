#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rib_to_contrats.py -- traduit un resultat d'extraction DocIE (schema
dynamique "rib", document-parsing/schemas/rib.schema.json) vers une analyse
compatible avec ce que contrats/lib/docanalyze.js::analyzeDocumentLocal
renvoie a POST /api/document/analyze (contrats/server.js).
Portage JS : contrats/lib/rib-mapping.js.

POURQUOI la voie texte : meme raison que urssaf_to_contrats.py. Un RIB est
edite par un systeme bancaire, donc un PDF a couche texte dans le cas courant ;
le schema voyage dans le corps de la requete (`dynamic_schema` sur
POST /v1/extract/text), aucun enregistrement Studio n'est necessaire. Le choix
de la voie se fait a l'execution sur le document recu
(contrats/lib/docie-extraction.js) : un RIB scanne n'est jamais envoye.

Schema DocIE "rib" -- quatre champs, ceux qu'un RIB porte et dont quelqu'un a
l'usage :
    account_holder  string  (titulaire : compare au sous-traitant saisi)
    iban            string  (controle ISO 13616, voir iban_bic.py)
    bic             string  (controle de format ISO 9362, voir iban_bic.py)
    bank_name       string  (domiciliation, affichee au relecteur)

Ce que le schema ne demande PAS, et pourquoi :
  - code banque, code guichet, numero de compte, cle RIB : ils sont DANS l'IBAN
    francais. Les extraire a part doublerait la surface de lecture fausse
    (deux lectures des memes chiffres qui peuvent se contredire) et le cout en
    jetons d'un petit modele (LFM2.5-350M, #194), sans rien controler de plus :
    la cle IBAN couvre deja ces chiffres. Ils ne sont pas non plus derives ici :
    aucun consommateur ne les lit, et leur decoupage suppose une structure du
    BBAN francais non relue hors reseau (voir `_longueurs` dans
    document-parsing/fixtures/iban_bic.json).
  - adresse du titulaire et de l'agence : aucun consommateur ; l'adresse du
    sous-traitant vient du Kbis (#197).

Ce schema n'a JAMAIS ete extrait pour de vrai : aucun RIB reel n'a ete lu pour
l'ecrire (meme reserve que urssaf, voir fixtures/generate_rib_sample.py).

REUTILISATION : ce module n'ecrit ni sa propre comparaison de nom ni son propre
controle d'IBAN. `_check_name` et `_extract_scalar` viennent de
kbis_to_contrats.py (comme pour urssaf), `controler_iban_bic` et
`messages_iban_bic` de iban_bic.py -- les tests le verifient par IDENTITE
d'objet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from iban_bic import VALIDE, controler_iban_bic, messages_iban_bic  # noqa: F401  (VALIDE re-exporte)
from kbis_to_contrats import DOCANALYZE_BASE_KEYS, _check_name, _extract_scalar  # noqa: F401

DOCIE_SCHEMA_NAME = "rib"

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "rib.schema.json"


def load_schema() -> dict:
    """Charge le schema dynamique rib (celui envoye a DocIE dans le corps)."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


# Champs DocIE "rib" -> cles camelCase NOUVELLES (absentes de docanalyze.js).
# account_holder alimente AUSSI companyName / nameMatches (cles docanalyze.js).
MAPPED_FIELDS: dict[str, str] = {
    "account_holder": "titulaireCompte",
    "iban": "iban",
    "bic": "bic",
    "bank_name": "nomBanque",
}

ENRICHED_KEYS = list(MAPPED_FIELDS.values())

# Libelle EXACT de contrats/lib/docanalyze.js::detectType() pour cette piece.
DOCUMENT_TYPE_LABEL = "RIB"

# Message quand l'IBAN manque : c'est la valeur pour laquelle un RIB existe.
IBAN_ABSENT = "IBAN non trouvé dans le document."


class RibMappingError(ValueError):
    """L'entree n'est pas une extraction DocIE valide du schema 'rib'."""


@dataclass
class RibMappingResult:
    """`analysis` : sur-ensemble des 8 cles de analyzeDocumentLocal, plus
    ENRICHED_KEYS et `controleIbanBic`. `warnings` : diagnostic, distinct de
    `analysis["issues"]` (message utilisateur)."""

    analysis: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def map_docie_rib_to_analysis(
    extraction_response: dict,
    expected_name: str | None = None,
    items: list[dict] | None = None,
) -> RibMappingResult:
    """Traduit une enveloppe ExtractionResponse DocIE (schema 'rib').

    expected_name : `expectedName` de analyzeDocumentLocal (le sous-traitant
    saisi), compare au titulaire du compte par le meme algorithme que
    checkName(). items : seul items[0] compte, matchedId vaut "rib" seulement
    si son id vaut "rib" (port exact de detectType)."""
    if not isinstance(extraction_response, dict):
        raise RibMappingError("extraction_response doit etre un dict (enveloppe ExtractionResponse)")
    schema_name = extraction_response.get("schema_name")
    if schema_name != DOCIE_SCHEMA_NAME:
        raise RibMappingError(
            f"schema_name attendu {DOCIE_SCHEMA_NAME!r}, recu {schema_name!r} -- "
            "ce module ne mappe QUE le schema dynamique 'rib'"
        )
    result = extraction_response.get("result")
    if not isinstance(result, dict):
        raise RibMappingError("extraction_response['result'] manquant ou invalide")

    warnings: list[str] = []
    bruts = {docie_key: _extract_scalar(result, docie_key) for docie_key in MAPPED_FIELDS}
    enriched = {out_key: ("" if bruts[docie_key] is None else str(bruts[docie_key]))
                for docie_key, out_key in MAPPED_FIELDS.items()}

    # IBAN mod-97 + format BIC (#194). Valeurs CONSERVEES dans `iban` / `bic`.
    controle = controler_iban_bic(bruts["iban"], bruts["bic"])
    problemes = messages_iban_bic(controle)
    for probleme in problemes:
        warnings.append(f"{probleme['champ']}: {probleme['message']}")

    raw_holder = bruts["account_holder"]
    name_matches = _check_name(raw_holder, expected_name)
    company_name: str | None = str(raw_holder) if raw_holder else None

    item = (items or [None])[0]
    matched_id = item.get("id") if (isinstance(item, dict) and item.get("id") == "rib") else None

    # Meme arbitrage que kbis/urssaf (#179 B1) : les 3 signaux identifiants d'un
    # RIB sont le titulaire, l'IBAN et le BIC -- tous absents, rien n'a ete lu.
    # Le nom de la banque seul n'identifie pas un compte.
    validation = extraction_response.get("validation") or {}
    docie_says_invalid = validation.get("valid") is False
    nothing_identifying = not raw_holder and not enriched["iban"] and not enriched["bic"]
    is_valid = not (docie_says_invalid or nothing_identifying)

    issues: list[str] = []
    if nothing_identifying:
        document_type = "Document"
        company_name = None
        name_matches = None
        issues = ["Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."]
        summary = "Document illisible."
    else:
        document_type = DOCUMENT_TYPE_LABEL
        if docie_says_invalid:
            issues.append("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).")
        if name_matches is False:
            issues.append("La société du document ne correspond pas au sous-traitant saisi.")
        # Dans `issues` et pas seulement `warnings` : docie-extraction.js ne
        # garde que `analysis`. isValid n'est pas touche (meme regle que le
        # SIREN du Kbis) : le document reste un RIB lisible, c'est une valeur
        # qui est douteuse, et `controleIbanBic` le dit par machine.
        if not enriched["iban"]:
            issues.append(IBAN_ABSENT)
        for probleme in problemes:
            issues.append(probleme["message"])
        # Pas de « Date de delivrance non trouvee » : un RIB ne porte pas de
        # date de delivrance, et la checklist ne lui en demande pas
        # (contrats/lib/checklist.js, pas de `dateField`).
        summary = document_type

    for note in result.get("extraction_notes") or []:
        warnings.append(f"DocIE extraction_notes: {note}")
    for w in validation.get("warnings") or []:
        warnings.append(f"DocIE validation.warnings: {w}")
    for e in validation.get("errors") or []:
        warnings.append(f"DocIE validation.errors: {e}")

    analysis: dict[str, Any] = {
        "documentType": document_type,
        "matchedId": matched_id,
        "isValid": is_valid,
        "issuedDate": "",
        "companyName": company_name,
        "nameMatches": name_matches,
        "issues": issues,
        "summary": summary,
    }
    analysis.update(enriched)
    # Verdict lisible par machine, HORS de ENRICHED_KEYS (ce n'est pas un champ
    # lu sur le RIB). Un consommateur n'utilise `iban` / `bic` que si le statut
    # correspondant vaut exactement "valide".
    analysis["controleIbanBic"] = controle
    return RibMappingResult(analysis=analysis, warnings=warnings)


__all__ = [
    "DOCIE_SCHEMA_NAME",
    "DOCUMENT_TYPE_LABEL",
    "DOCANALYZE_BASE_KEYS",
    "MAPPED_FIELDS",
    "ENRICHED_KEYS",
    "IBAN_ABSENT",
    "SCHEMA_PATH",
    "load_schema",
    "RibMappingError",
    "RibMappingResult",
    "map_docie_rib_to_analysis",
]
