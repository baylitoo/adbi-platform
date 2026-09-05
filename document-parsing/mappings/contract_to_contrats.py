#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""contract_to_contrats.py -- traduit un resultat d'extraction DocIE Studio
(schema dynamique "contract") vers le `values` attendu par
contrats/lib/fields.js::sousTraitance, en vue de POST /api/contracts/importer
(contrats/server.js).

Contexte (PR #46, document-parsing/scripts/register_and_test.py) : DocIE
valide les noms de champs de schema dynamique avec `^[a-z][a-z0-9_]{0,63}$`
-- le camelCase de contrats/lib/fields.js (stNom, numeroContrat, dateDebut,
...) est REJETE a l'enregistrement (HTTP 422 string_pattern_mismatch,
confirme en conditions reelles contre une instance DocIE Studio). Le schema
"contract" enregistre cote DocIE utilise donc des noms snake_case
(numero_contrat, st_nom, date_debut, ...) -- la premisse initiale ("le JSON
de DocIE s'injecte tel quel dans le formulaire contrats, sans renommage")
ne tient donc PAS. Ce module EST le renommage manquant, plus la conversion
de forme (chaque champ scalaire du schema dynamique DocIE est encapsule
selon son type, pas une valeur nue -- voir plus bas).

Forme du JSON consomme : l'enveloppe `ExtractionResponse` complete telle
que renvoyee par `extract_document`/`_run_extraction`
(docie_bench/inngest/functions.py :: `response.model_dump(mode="json")`),
c'est-a-dire :
    {"schema_name": "contract", "result": {...}, "validation": {...}, ...}
et, dans `result`, chaque champ du schema dynamique "contract"
(docie_bench/schemas/dynamic.py + docie_bench/schemas/common.py) est
encapsule selon son type DocIE :
  - string / date -> {"value": str|None, "evidence_ids": [...], "confidence": float}
  - number        -> {"value": str|None, ...}   (Decimal serialise en str par pydantic v2 mode="json")
  - money         -> {"amount": str|None, "currency": str|None, ...}
Un champ peut etre PRESENT avec une valeur null (`{"value": null}` = "champ
vu, rien trouve") -- traite ici exactement comme une cle absente : "".

Ce module n'a AUCUNE dependance a register_and_test.py (ce fichier n'existe
pas sur master : PR #46 est encore ouverte au moment ou ce module est
ecrit) ni a un serveur DocIE reel. Verification : voir
mappings/fixtures/contract_extraction_sample.json (genere depuis les vrais
modeles pydantic de DocIE -- voir fixtures/generate_sample.py pour la
provenance) et test_contract_to_contrats.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

DOCIE_SCHEMA_NAME = "contract"

# ---------------------------------------------------------------------------
# 1) Champs reellement EXTRAITS DU DOCUMENT par le schema DocIE "contract"
#    (register_and_test.py, table SCHEMAS["contract"]), mappes 1-pour-1 vers
#    contrats/lib/fields.js::sousTraitance. Cle = nom de champ snake_case
#    DocIE (contournement du 422 camelCase) ; valeur = (cle camelCase
#    contrats, type DocIE a desencapsuler).
# ---------------------------------------------------------------------------
MAPPED_FIELDS: dict[str, tuple[str, str]] = {
    "numero_contrat": ("numeroContrat", "string"),
    "date_redaction": ("dateRedaction", "date"),
    "lieu_redaction": ("lieuRedaction", "string"),
    "st_nom": ("stNom", "string"),
    "st_adresse": ("stAdresse", "string"),
    "st_siren": ("stSiren", "string"),
    "st_siret": ("stSiret", "string"),
    "st_representant": ("stRepresentant", "string"),
    "st_forme_juridique": ("stFormeJuridique", "string"),
    "st_qualite": ("stQualite", "string"),
    "consultant_nom": ("consultantNom", "string"),
    "consultant_fonction": ("consultantFonction", "string"),
    "client_final": ("clientFinal", "string"),
    "nature_travaux": ("natureTravaux", "string"),
    "lieu_execution": ("lieuExecution", "string"),
    "date_debut": ("dateDebut", "date"),
    "date_fin": ("dateFin", "date"),
    "tjm": ("tjm", "money"),
    "delai_paiement": ("delaiPaiement", "number"),
}

# ---------------------------------------------------------------------------
# 2) Champs sousTraitance qui ne sont PAS sources depuis DocIE : ce sont des
#    CONSTANTES ADBI (identite du Client, contact compta, clauses standard,
#    version) deja portees par leur propre `default` dans fields.js.
#    contrats/server.js::resolveBody fait, a CHAQUE rendu (PDF/DOCX) :
#        values = Object.assign(defaults(type), body.values || {})
#    donc les omettre ici est SANS RISQUE : elles se remplissent seules au
#    rendu. Attention en revanche : POST /api/contracts/importer, lui,
#    stocke `req.body.values` TEL QUEL (pas de merge des defauts a
#    l'import) -- seule la regeneration du PDF/DOCX applique `defaults()`.
#    Ce module ne les emet donc jamais ; les emettre serait redondant, pas
#    faux, mais figerait dans l'historique une valeur qui devrait rester
#    "vivante" (ex: si l'adresse ADBI change un jour dans fields.js).
# ---------------------------------------------------------------------------
CONSTANT_FIELDS_NOT_FROM_DOCIE: set[str] = {
    "adbiNom", "adbiAdresse", "adbiCapital", "adbiRcs", "adbiRepresentant",
    "comptaContact", "comptaTel", "comptaEmail",
    "dureeNonSollicitation", "dureeExclusivite", "tribunal",
    "version",
}

# ---------------------------------------------------------------------------
# 3) GAP REEL : champs sousTraitance pour lesquels le schema DocIE "contract"
#    (tel qu'enregistre dans register_and_test.py / PR #46) n'a AUCUN champ
#    correspondant. A signaler explicitement a qui fera l'integration reelle
#    -- pas a masquer derriere une valeur vide silencieuse. Laisses "" ; a
#    completer a la main dans le formulaire tant que le schema DocIE n'est
#    pas etendu.
# ---------------------------------------------------------------------------
GAP_FIELDS_NO_DOCIE_EQUIVALENT: dict[str, str] = {
    "stEmail": "email du sous-traitant pour l'envoi en signature -- absent du schema DocIE 'contract'",
    "stSignataireNom": "signataire reel si different du representant legal -- distinction non capturee par le schema",
    "stSignataireQualite": "qualite du signataire reel -- meme lacune que stSignataireNom",
    "consultantTel": "telephone de l'intervenant -- absent du schema DocIE 'contract'",
    "craValidePar": "responsable de validation des CRA cote client final -- suivi ADBI, pas une info du contrat source",
    "bmNom": "business manager ADBI en charge du suivi -- info interne ADBI, jamais dans le document source",
    "bmEmail": "email du business manager ADBI -- idem",
    "bmTel": "telephone du business manager ADBI -- idem",
}

# Union des trois categories : doit correspondre EXACTEMENT aux 39 cles de
# contrats/lib/fields.js::sousTraitance (verifie par test_contract_to_contrats.py
# en lisant fields.js en direct -- garde-fou anti-derive si fields.js change).
ALL_ACCOUNTED_KEYS: set[str] = (
    {contrats_key for contrats_key, _ in MAPPED_FIELDS.values()}
    | CONSTANT_FIELDS_NOT_FROM_DOCIE
    | set(GAP_FIELDS_NO_DOCIE_EQUIVALENT)
)

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FR_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


class ContractMappingError(ValueError):
    """L'entree n'est pas une extraction DocIE valide du schema 'contract'."""


@dataclass
class MappingResult:
    """Resultat du mapping : `values` est le dict pret pour
    POST /api/contracts/importer ({"type": ..., "values": ...}).
    `warnings` signale les degradations non bloquantes (date/nombre non
    reconnu, devise inattendue, notes DocIE...). `errors` reprend les memes
    controles bloquants que /api/contracts/importer cote contrats/server.js
    (numeroContrat / stNom requis) -- verifies ICI, avant tout appel HTTP,
    pour que l'echec se voie au mapping plutot qu'a l'import."""

    values: dict[str, str]
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _normalize_date(raw: Any, field_key: str, warnings: list[str]) -> str:
    """DocIE's DateField ne garantit PAS l'ISO ("ISO-8601 quand possible" --
    docie_bench/schemas/common.py) alors que contrats/lib/fields.js attend un
    <input type="date"> (YYYY-MM-DD). ISO transparent ; DD/MM/YYYY converti ;
    tout le reste -> vide + avertissement (jamais de valeur injectee dans un
    champ date que le navigateur ne saura pas afficher)."""
    if raw is None or raw == "":
        return ""
    raw_s = str(raw).strip()
    if _ISO_DATE_RE.match(raw_s):
        return raw_s
    m = _FR_DATE_RE.match(raw_s)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    warnings.append(f"{field_key}: date non reconnue ({raw_s!r}), laissee vide -- a corriger manuellement")
    return ""


def _normalize_number(raw: Any, field_key: str, warnings: list[str]) -> str:
    """fields.js type "number" attend une chaine numerique simple (ex:
    "420", "45") ; DocIE serialise ses Decimal en str (pydantic v2
    mode="json"). Entier -> sans decimales ; sinon valeur telle quelle."""
    if raw is None or raw == "":
        return ""
    raw_s = str(raw).strip()
    try:
        as_float = float(raw_s)
    except ValueError:
        warnings.append(f"{field_key}: nombre non reconnu ({raw_s!r}), reporte tel quel")
        return raw_s
    if as_float == int(as_float):
        return str(int(as_float))
    return str(as_float)


def _extract_scalar(result: dict, docie_key: str) -> Any:
    wrapper = result.get(docie_key)
    if not isinstance(wrapper, dict):
        return None
    return wrapper.get("value")


def _extract_money(result: dict, docie_key: str, warnings: list[str]) -> str:
    wrapper = result.get(docie_key)
    if not isinstance(wrapper, dict):
        return ""
    amount = wrapper.get("amount")
    currency = wrapper.get("currency")
    if amount is None or amount == "":
        return ""
    if currency and str(currency).upper() != "EUR":
        # contrats/lib/fields.js "tjm" est libelle "€ HT / jour" : pas de
        # colonne devise separee dans le formulaire. On ne convertit pas
        # (pas de taux de change fiable a ce niveau) -- on garde le montant
        # brut et on remonte l'ecart pour verification humaine.
        warnings.append(
            f"{docie_key}: devise {currency!r} != EUR -- contrats/lib/fields.js suppose des euros, "
            f"montant reporte tel quel sans conversion"
        )
    return _normalize_number(amount, docie_key, warnings)


def map_docie_contract_to_sous_traitance(extraction_response: dict) -> MappingResult:
    """Traduit une enveloppe ExtractionResponse DocIE (schema 'contract')
    vers le `values` de contrats/lib/fields.js::sousTraitance.

    N'emet QUE les 19 champs listes dans MAPPED_FIELDS : les constantes ADBI
    (CONSTANT_FIELDS_NOT_FROM_DOCIE) sont volontairement absentes (voir leur
    commentaire plus haut) et les champs sans equivalent DocIE
    (GAP_FIELDS_NO_DOCIE_EQUIVALENT) aussi -- ni l'un ni l'autre n'est une
    omission par erreur.
    """
    if not isinstance(extraction_response, dict):
        raise ContractMappingError("extraction_response doit etre un dict (enveloppe ExtractionResponse)")

    schema_name = extraction_response.get("schema_name")
    if schema_name != DOCIE_SCHEMA_NAME:
        raise ContractMappingError(
            f"schema_name attendu {DOCIE_SCHEMA_NAME!r}, recu {schema_name!r} -- "
            "ce module ne mappe QUE le schema dynamique 'contract'"
        )

    result = extraction_response.get("result")
    if not isinstance(result, dict):
        raise ContractMappingError("extraction_response['result'] manquant ou invalide")

    warnings: list[str] = []
    values: dict[str, str] = {}

    for docie_key, (contrats_key, kind) in MAPPED_FIELDS.items():
        if kind == "money":
            values[contrats_key] = _extract_money(result, docie_key, warnings)
        elif kind == "date":
            values[contrats_key] = _normalize_date(_extract_scalar(result, docie_key), docie_key, warnings)
        elif kind == "number":
            raw = _extract_scalar(result, docie_key)
            values[contrats_key] = _normalize_number(raw, docie_key, warnings) if raw not in (None, "") else ""
        else:  # "string"
            raw = _extract_scalar(result, docie_key)
            values[contrats_key] = "" if raw is None else str(raw)

    for note in result.get("extraction_notes") or []:
        warnings.append(f"DocIE extraction_notes: {note}")
    validation = extraction_response.get("validation") or {}
    for w in validation.get("warnings") or []:
        warnings.append(f"DocIE validation.warnings: {w}")
    for e in validation.get("errors") or []:
        warnings.append(f"DocIE validation.errors: {e}")

    errors: list[str] = []
    # Miroir exact des controles de contrats/server.js::POST /api/contracts/importer
    # (colonnesContrat + les deux `if` juste apres) : autant echouer ici.
    if not values.get("numeroContrat"):
        errors.append("Le numero du contrat est requis.")
    if not values.get("stNom"):
        errors.append("Le nom du sous-traitant / co-contractant est requis.")

    return MappingResult(values=values, warnings=warnings, errors=errors)


def build_import_payload(
    extraction_response: dict, contract_type: str = "sous-traitance"
) -> tuple[dict[str, Any], MappingResult]:
    """Construit le body pret pour POST /api/contracts/importer
    (contrats/server.js) a partir d'une extraction DocIE 'contract'.

    Ne fait PAS l'appel HTTP : le cablage reel dans contrats/server.js (ou
    un futur routeur /document-parsing) est une etape d'integration
    separee, hors perimetre de ce module (mapping de donnees pur)."""
    mapping = map_docie_contract_to_sous_traitance(extraction_response)
    payload = {"type": contract_type, "values": mapping.values}
    return payload, mapping


__all__ = [
    "DOCIE_SCHEMA_NAME",
    "MAPPED_FIELDS",
    "CONSTANT_FIELDS_NOT_FROM_DOCIE",
    "GAP_FIELDS_NO_DOCIE_EQUIVALENT",
    "ALL_ACCOUNTED_KEYS",
    "ContractMappingError",
    "MappingResult",
    "map_docie_contract_to_sous_traitance",
    "build_import_payload",
]
