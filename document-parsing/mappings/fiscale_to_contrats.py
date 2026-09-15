#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fiscale_to_contrats.py -- traduit un resultat d'extraction DocIE (schema
dynamique "fiscale", document-parsing/schemas/fiscale.schema.json) vers une
analyse compatible avec ce que contrats/lib/docanalyze.js::analyzeDocumentLocal
renvoie a POST /api/document/analyze (contrats/server.js), avec la MEME forme
que la paire URSSAF (urssaf_to_contrats.py) : la checklist pourra la consommer
sans cas particulier. Portage JS : contrats/lib/fiscale-mapping.js.

Piece : « L'attestation de regularite fiscale » (contrats/lib/checklist.js,
Art. 12). Voie texte (#194, liste retenue : LFM2.5-2.6B par defaut,
LFM2.5-350M en alternative derriere nos controles de plausibilite de date).
Le schema voyage dans le corps de la requete (`dynamic_schema` sur
POST /v1/extract/text) : aucun enregistrement Studio. Le cablage dans
contrats/lib/docie-extraction.js n'est PAS fait ici (PR #214 en vol sur ce
fichier) ; ce module ne depend de rien de ce cablage.

Schema DocIE "fiscale" -- sept champs, chacun la ou il se lit sur le document :
    company_name          string  (denomination, bloc d'identification)
    siren                 string  (SIREN, bloc d'identification)
    siret                 string  (SIRET, quand l'attestation l'imprime)
    tax_office            string  (service des impots emetteur, en-tete)
    issued_date           date    (date de delivrance)
    situation_date        date    (date a laquelle la regularite est attestee,
                                   quand elle est imprimee a part)
    regularity_statement  string  (mention « a jour de ses obligations
                                   fiscales », recopiee telle quelle)

RESERVE, a garder en tete : aucune attestation de regularite fiscale reelle n'a
ete lue pour ecrire ce schema (meme reserve que urssaf et rib), et aucun appel
reseau n'etait permis. Les champs suivent la structure publique du document ;
`siret` et `situation_date` sont decrits « quand ils figurent » parce que leur
presence sur toutes les variantes (attestation en ligne, formulaire papier)
n'a pas pu etre verifiee. Ce qui a ete laisse de cote est dans GAP_NOTES.

REUTILISATION -- rien n'est recopie ici, tout est IMPORTE et les tests le
verifient par identite d'objet, lecture du source et temoin :
  - `_normalize_date`, `_extract_scalar`, `_check_name` (regle nom_docie.json)
    et DOCANALYZE_BASE_KEYS de kbis_to_contrats.py, comme urssaf ;
  - `controler_siren_siret` / `messages_siren_siret` de siren_siret.py ;
  - `controler_dates` / `messages_dates` de date_plausible.py.
Aucun champ `money` ni `number` : ni `_normalize_number` ni
`_extract_money_pair` ne sont importes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from date_plausible import ABSENT, controler_dates, messages_dates
from kbis_to_contrats import DOCANALYZE_BASE_KEYS, _check_name, _extract_scalar, _normalize_date  # noqa: F401
from siren_siret import controler_siren_siret, messages_siren_siret

DOCIE_SCHEMA_NAME = "fiscale"

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "fiscale.schema.json"


def load_schema() -> dict:
    """Charge le schema dynamique fiscale (celui envoye a DocIE dans le corps)."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


# Nom de champ DocIE sous lequel chaque numero est lu (avertissements).
CHAMPS_SIREN_SIRET: dict[str, str] = {"siren": "siren", "siret": "siret"}

# Champs DocIE "fiscale" -> cles camelCase NOUVELLES (absentes de docanalyze.js).
# company_name / issued_date sont traites a part : ils alimentent companyName /
# issuedDate (cles docanalyze.js).
MAPPED_FIELDS: dict[str, tuple[str, str]] = {
    "siren": ("siren", "string"),
    "siret": ("siret", "string"),
    "tax_office": ("serviceImpots", "string"),
    "situation_date": ("dateSituation", "date"),
    "regularity_statement": ("mentionRegularite", "string"),
}

ENRICHED_KEYS = [out_key for out_key, _ in MAPPED_FIELDS.values()]

# Controle de plausibilite des dates (#194) : ordre d'affichage des champs,
# libelles (en minuscules, voir date_plausible.messages_dates) et contrainte
# d'ordre -- la situation attestee ne peut pas suivre la delivrance. Aucune
# des deux dates ne peut etre dans le futur (futur_admis vide). Memes valeurs
# que `libelles` / `ordre` / `futur_admis` de date_plausible.json, que les
# tests comparent.
LIBELLES_DATES: dict[str, str] = {"issued_date": "date de délivrance", "situation_date": "date de situation"}
ORDRE_DATES: tuple[tuple[str, str], ...] = (("situation_date", "issued_date"),)

# Libelle EXACT de contrats/lib/docanalyze.js::detectType() pour cette piece :
# l'origine de l'analyse ne doit pas changer le type affiche.
DOCUMENT_TYPE_LABEL = "Attestation de régularité fiscale"

DATE_ABSENTE = "Date de délivrance non trouvée dans le document."
ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."

# Ce que le schema ne porte PAS, dit explicitement plutot que devine plus tard :
GAP_NOTES = (
    "Aucun montant (champ money) : l'attestation certifie que les declarations sont deposees et les "
    "sommes exigibles payees, elle n'imprime pas de montant. La ligne « money » de #170 ne vaut pas ici.",
    "Pas de fin de validite ni de periode (debut/fin) : aucune date de fin de validite imprimee n'a pu "
    "etre verifiee sur ce document. Le controle « periode qui finit avant de commencer » de "
    "date_plausible.py est donc applique a la seule paire qui existe, situation <= delivrance.",
    "Adresse de l'entreprise : non extraite. Aucun consommateur ; l'adresse du sous-traitant vient du Kbis (#197).",
    "Detail par impot (IS / IR, TVA, lignes deposee / payee) : non modelise. Aucun consommateur, et sa "
    "presentation varie selon la variante de l'attestation, non verifiee.",
    "Signataire, cachet, numero ou code de verification de l'attestation : non extraits. Leur presence et "
    "leur forme n'ont pas pu etre verifiees ; aucun consommateur.",
)


class FiscaleMappingError(ValueError):
    """L'entree n'est pas une extraction DocIE valide du schema 'fiscale'."""


@dataclass
class FiscaleMappingResult:
    """`analysis` : sur-ensemble STRICT des 8 cles de docanalyze.js
    (DOCANALYZE_BASE_KEYS), plus ENRICHED_KEYS, `controleSirenSiret` et
    `controleDates`. `warnings` : degradations non bloquantes, distinctes de
    `analysis["issues"]` (message utilisateur)."""

    analysis: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def map_docie_fiscale_to_analysis(
    extraction_response: dict,
    expected_name: str | None = None,
    items: list[dict] | None = None,
    aujourdhui: str | None = None,
) -> FiscaleMappingResult:
    """Traduit une enveloppe ExtractionResponse DocIE (schema 'fiscale').

    expected_name : `expectedName` de analyzeDocumentLocal (nameMatches).
    items : `items` de analyzeDocumentLocal -- matchedId renseigne seulement si
    items[0].id vaut "fiscale", comme detectType().
    aujourdhui : date du jour AAAA-MM-JJ du controle « date dans le futur »
    (date locale si None) ; les tests la figent.
    """
    if not isinstance(extraction_response, dict):
        raise FiscaleMappingError("extraction_response doit etre un dict (enveloppe ExtractionResponse)")

    schema_name = extraction_response.get("schema_name")
    if schema_name != DOCIE_SCHEMA_NAME:
        raise FiscaleMappingError(
            f"schema_name attendu {DOCIE_SCHEMA_NAME!r}, recu {schema_name!r} -- "
            "ce module ne mappe QUE le schema dynamique 'fiscale'"
        )

    result = extraction_response.get("result")
    if not isinstance(result, dict):
        raise FiscaleMappingError("extraction_response['result'] manquant ou invalide")

    warnings: list[str] = []
    enriched: dict[str, str] = {}

    for docie_key, (out_key, kind) in MAPPED_FIELDS.items():
        raw = _extract_scalar(result, docie_key)
        if kind == "date":
            enriched[out_key] = _normalize_date(raw, docie_key, warnings)
        else:  # "string"
            enriched[out_key] = "" if raw is None else str(raw)

    # Cle de Luhn du SIREN / SIRET (#194), meme integration que urssaf / kbis.
    # Les valeurs lues restent dans `siren` / `siret`.
    controle_siren = controler_siren_siret(_extract_scalar(result, "siren"), _extract_scalar(result, "siret"))
    problemes_siren = messages_siren_siret(controle_siren)
    for probleme in problemes_siren:
        warnings.append(f"{CHAMPS_SIREN_SIRET[probleme['champ']]}: {probleme['message']}")

    raw_company_name = _extract_scalar(result, "company_name")
    name_matches = _check_name(raw_company_name, expected_name)
    company_name: str | None = str(raw_company_name) if raw_company_name else None

    issued_date = _normalize_date(_extract_scalar(result, "issued_date"), "issued_date", warnings)

    # Plausibilite des dates (#194). Une date future ou incoherente est
    # CONSERVEE dans issuedDate / dateSituation : c'est `controleDates` qui dit
    # si un consommateur peut s'en servir (statut exactement "plausible").
    controle_dates = controler_dates(
        {champ: _extract_scalar(result, champ) for champ in LIBELLES_DATES},
        ordre=ORDRE_DATES,
        aujourdhui=aujourdhui,
    )
    problemes_dates = messages_dates(controle_dates, LIBELLES_DATES, ordre=ORDRE_DATES)
    for probleme in problemes_dates:
        warnings.append(f"{probleme['champ']}: {probleme['message']}")

    item = (items or [None])[0]
    matched_id = item.get("id") if (isinstance(item, dict) and item.get("id") == "fiscale") else None

    # Meme arbitrage que urssaf / kbis (#179 B1) : nom, SIREN et SIRET tous
    # absents -> pas de lecture ; validation.valid=false avec des champs lus ->
    # extraction douteuse, pas illisible.
    validation = extraction_response.get("validation") or {}
    docie_says_invalid = validation.get("valid") is False
    nothing_identifying = not raw_company_name and not enriched["siren"] and not enriched["siret"]
    is_valid = not (docie_says_invalid or nothing_identifying)

    issues: list[str] = []
    if nothing_identifying:
        document_type = "Document"
        company_name = None
        name_matches = None
        issued_date = ""
        issues = [ILLISIBLE]
        summary = "Document illisible."
    else:
        document_type = DOCUMENT_TYPE_LABEL
        if docie_says_invalid:
            issues.append("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).")
        if name_matches is False:
            issues.append("La société du document ne correspond pas au sous-traitant saisi.")
        # Dans `issues` et pas seulement dans `warnings` : le chemin de
        # production ne garde que `analysis`. isValid n'est PAS touche.
        issues.extend(probleme["message"] for probleme in problemes_siren)
        issues.extend(probleme["message"] for probleme in problemes_dates)
        if controle_dates["issued_date"]["statut"] == ABSENT:
            # Seule l'ABSENCE garde le message de docanalyze.js : une date lue
            # mais illisible, impossible ou future a deja son message nomme.
            issues.append(DATE_ABSENTE)
        summary = document_type + (" — délivré le " + issued_date if issued_date else "")

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
        "issuedDate": issued_date,
        "companyName": company_name,
        "nameMatches": name_matches,
        "issues": issues,
        "summary": summary,
    }
    analysis.update(enriched)
    # Verdicts LISIBLES PAR MACHINE, presents dans les deux branches, HORS de
    # ENRICHED_KEYS (ce ne sont pas des champs lus sur l'attestation).
    analysis["controleSirenSiret"] = controle_siren
    analysis["controleDates"] = controle_dates

    return FiscaleMappingResult(analysis=analysis, warnings=warnings)


__all__ = [
    "DOCIE_SCHEMA_NAME",
    "DOCUMENT_TYPE_LABEL",
    "DOCANALYZE_BASE_KEYS",
    "MAPPED_FIELDS",
    "ENRICHED_KEYS",
    "LIBELLES_DATES",
    "ORDRE_DATES",
    "GAP_NOTES",
    "SCHEMA_PATH",
    "load_schema",
    "FiscaleMappingError",
    "FiscaleMappingResult",
    "map_docie_fiscale_to_analysis",
]
