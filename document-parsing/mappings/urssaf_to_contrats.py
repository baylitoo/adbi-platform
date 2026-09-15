#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""urssaf_to_contrats.py -- traduit un resultat d'extraction DocIE (schema
dynamique "urssaf", document-parsing/schemas/urssaf.schema.json) vers une
analyse compatible avec ce que contrats/lib/docanalyze.js::analyzeDocumentLocal
renvoie aujourd'hui a POST /api/document/analyze (contrats/server.js).

POURQUOI l'attestation de vigilance URSSAF, et pas une autre des six pieces
non-Kbis de la checklist : c'est la seule dont une valeur extraite pilote une
vraie logique metier cote front. contrats/lib/checklist.js la declare
`dateField: true` avec « A renouveler tous les 6 mois », et
contrats/public/app.js::renderChecklistDocResult calcule PERIME / bientot
perime / valable a partir de `issuedDate`. Cette date venait jusqu'ici d'une
devinette par regex sur du texte OCR local (docanalyze.js::extractIssuedDate,
qui choisit « la date la plus recente pas dans le futur » quand aucun mot-cle
de delivrance ne se trouve a proximite). Elle vient desormais du champ
`issued_date` d'un schema, quand la voie texte est utilisable.

POURQUOI la voie texte et pas la voie agent : le schema voyage dans le corps de
la requete (`dynamic_schema` sur POST /v1/extract/text, voir
document-parsing/bridge/docie_bridge.py::extract_text). Aucun enregistrement
prealable dans le Studio DocIE n'est donc necessaire -- c'est le point que
l'issue #170 tenait pour un blocage.

Forme du JSON consomme : la meme enveloppe `ExtractionResponse` que
mappings/kbis_to_contrats.py et mappings/contract_to_contrats.py (voir leurs
docstrings pour le detail de l'encapsulation par type DocIE -- string/date ->
{"value", ...}, number -> {"value", ...} (Decimal serialise en str), money ->
{"amount", "currency", ...}). Le portage JS de ce module
(contrats/lib/urssaf-mapping.js) lit au contraire le `result` DEJA DEBALLE par
docie-bridge.js::unwrap(), exactement comme kbis-mapping.js : c'est une
difference assumee entre les deux cotes, deja documentee la-bas.

Schema DocIE "urssaf" (document-parsing/schemas/urssaf.schema.json) :
    company_name        string
    siren               string
    siret               string
    registered_address  string
    issued_date         date    (date de delivrance -- la seule porteuse)
    valid_until         date
    security_code       string
    urssaf_agency       string
    employee_count      number
    declared_payroll    money

Ce schema n'a JAMAIS ete extrait pour de vrai : aucune attestation de vigilance
reelle n'etait disponible au moment de l'ecrire. Ses champs suivent la structure
publique du document ; seul `issued_date` a un consommateur aujourd'hui. Les
neuf autres sont rendus tels quels a l'appelant sans qu'aucune logique n'en
depende -- ils n'inventent donc rien s'ils reviennent vides.

REUTILISATION DES NORMALISEURS PARTAGES : ce module n'ecrit PAS sa propre copie
de `_normalize_date` / `_normalize_number` / `_check_name`. Quatre copies
independantes de ces regles ont deja produit six divergences mesurees entre
Python et JS (inventaire #179, lignes A2-A6 et B2-B3), corrigees en fixant la
regle dans document-parsing/fixtures/date_docie.json et nombre_docie.json. Une
cinquieme copie rouvrirait exactement cette porte. Elles sont donc IMPORTEES de
kbis_to_contrats.py, qui les porte deja pour le meme couple de types (date de
delivrance + montant) et vers la meme forme de sortie.

Leur place naturelle serait un module de normalisation dedie, importe par les
cinq portages. Ce demenagement n'est pas fait ici : kbis_to_contrats.py et
contrats/lib/kbis-mapping.js sont pris par un autre travail en vol (#182), et
un module partage se cree en touchant les fichiers d'ou l'on deplace le code.
L'import ci-dessous ne touche a aucun des deux.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kbis_to_contrats import (  # noqa: F401  (re-exports assumes, voir __all__)
    ANNEE_MAX,
    ANNEE_MIN,
    DOCANALYZE_BASE_KEYS,
    MOTIF_NOMBRE,
    _check_name,
    _extract_money_pair,
    _extract_scalar,
    _normalize_date,
    _normalize_number,
)

# Controle de cle du SIREN / SIRET (#194), IMPORTE du validateur unique, comme
# kbis_to_contrats.py et contract_to_contrats.py le font deja : pas de
# troisieme copie de Luhn (test_urssaf_to_contrats.py le verifie par identite
# d'objet et par lecture de ce fichier).
from siren_siret import controler_siren_siret, messages_siren_siret

DOCIE_SCHEMA_NAME = "urssaf"

# Nom de champ DocIE sous lequel chaque numero est lu (avertissements). Le
# schema urssaf nomme le SIRET `siret`, la ou le Kbis dit `siret_siege`.
CHAMPS_SIREN_SIRET: dict[str, str] = {"siren": "siren", "siret": "siret"}

# Le fichier de schema est la source unique des noms de champs : les tests
# verifient que chaque cle de MAPPED_FIELDS ci-dessous y figure, pour qu'un
# renommage cote schema ne puisse pas passer inapercu cote mapping.
SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "urssaf.schema.json"


def load_schema() -> dict:
    """Charge le schema dynamique urssaf (celui envoye a DocIE dans le corps)."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Champs DocIE "urssaf" mappes 1-pour-1 vers des cles camelCase NOUVELLES
# (absentes de docanalyze.js -- l'enrichissement vise). company_name /
# issued_date / declared_payroll sont traites a part : les deux premiers
# alimentent directement companyName / issuedDate (cles docanalyze.js), le
# troisieme produit 2 cles (masseSalariale + masseSalarialeDevise).
# ---------------------------------------------------------------------------
MAPPED_FIELDS: dict[str, tuple[str, str]] = {
    "siren": ("siren", "string"),
    "siret": ("siret", "string"),
    "registered_address": ("adresseSiege", "string"),
    "valid_until": ("dateValidite", "date"),
    "security_code": ("codeSecurite", "string"),
    "urssaf_agency": ("organismeUrssaf", "string"),
    "employee_count": ("nombreSalaries", "number"),
}

ENRICHED_KEYS = [out_key for out_key, _ in MAPPED_FIELDS.values()] + [
    "masseSalariale",
    "masseSalarialeDevise",
]

# Libelle EXACT de contrats/lib/docanalyze.js::detectType() pour cette piece
# (deux branches y menent, toutes deux avec cette meme chaine) : l'origine de
# l'analyse ne doit pas changer le type affiche a l'utilisateur.
DOCUMENT_TYPE_LABEL = "Attestation de vigilance URSSAF"

# Ce que le schema ne porte PAS, dit explicitement plutot que devine plus tard :
GAP_NOTES = (
    "Periode de reference couverte par l'attestation : non isolee. Elle "
    "s'imprime sous des formes tres variables et aucun consommateur ne la "
    "demande ; `valid_until` suffit a dire jusqu'a quand l'attestation vaut.",
    "Motif d'une attestation refusee ou sous reserve : non modelise. Une "
    "attestation de vigilance est delivree ou ne l'est pas ; le cas 'delivree "
    "avec reserve' n'a pas d'echantillon reel pour l'ecrire.",
    "Le nom du signataire et la qualite du signataire ne sont pas extraits : "
    "l'attestation est un document d'organisme, pas un acte contractuel.",
)


class UrssafMappingError(ValueError):
    """L'entree n'est pas une extraction DocIE valide du schema 'urssaf'."""


@dataclass
class UrssafMappingResult:
    """`analysis` est le dict pret a etre renvoye a la place de
    contrats/lib/docanalyze.js::analyzeDocumentLocal() -- sur-ensemble STRICT
    de ses 8 cles actuelles (DOCANALYZE_BASE_KEYS), plus ENRICHED_KEYS.
    `warnings` reprend les degradations non bloquantes (notes d'extraction,
    avertissements/erreurs de validation, dates/nombres non reconnus), une
    information de diagnostic distincte de `analysis["issues"]`, qui est le
    message utilisateur deja affiche par contrats/public/app.js."""

    analysis: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def map_docie_urssaf_to_analysis(
    extraction_response: dict,
    expected_name: str | None = None,
    items: list[dict] | None = None,
) -> UrssafMappingResult:
    """Traduit une enveloppe ExtractionResponse DocIE (schema 'urssaf') vers un
    dict compatible avec contrats/lib/docanalyze.js::analyzeDocumentLocal.

    expected_name : equivalent du parametre `expectedName` de
    analyzeDocumentLocal (contrats/public/app.js envoie state.values.stNom) --
    utilise pour nameMatches via le meme algorithme que checkName().
    items : equivalent du parametre `items` -- utilise pour matchedId
    EXACTEMENT comme detectType() : seul items[0] est regarde, et matchedId
    n'est renseigne que si son id vaut "urssaf".
    """
    if not isinstance(extraction_response, dict):
        raise UrssafMappingError("extraction_response doit etre un dict (enveloppe ExtractionResponse)")

    schema_name = extraction_response.get("schema_name")
    if schema_name != DOCIE_SCHEMA_NAME:
        raise UrssafMappingError(
            f"schema_name attendu {DOCIE_SCHEMA_NAME!r}, recu {schema_name!r} -- "
            "ce module ne mappe QUE le schema dynamique 'urssaf'"
        )

    result = extraction_response.get("result")
    if not isinstance(result, dict):
        raise UrssafMappingError("extraction_response['result'] manquant ou invalide")

    warnings: list[str] = []
    enriched: dict[str, str] = {}

    for docie_key, (out_key, kind) in MAPPED_FIELDS.items():
        raw = _extract_scalar(result, docie_key)
        if kind == "date":
            enriched[out_key] = _normalize_date(raw, docie_key, warnings)
        elif kind == "number":
            enriched[out_key] = _normalize_number(raw, docie_key, warnings)
        else:  # "string"
            enriched[out_key] = "" if raw is None else str(raw)

    # Cle de Luhn du SIREN / SIRET (#194, regle « echouer bruyamment »), meme
    # integration que kbis_to_contrats.py. Les valeurs lues restent dans
    # `siren` / `siret` : les vider ferait basculer une attestation lisible
    # dans la branche « illisible » ci-dessous (#179 B1).
    controle = controler_siren_siret(_extract_scalar(result, "siren"), _extract_scalar(result, "siret"))
    problemes = messages_siren_siret(controle)
    for probleme in problemes:
        warnings.append(f"{CHAMPS_SIREN_SIRET[probleme['champ']]}: {probleme['message']}")

    payroll_amount, payroll_currency = _extract_money_pair(result, "declared_payroll", warnings)
    enriched["masseSalariale"] = payroll_amount
    enriched["masseSalarialeDevise"] = payroll_currency

    raw_company_name = _extract_scalar(result, "company_name")
    name_matches = _check_name(raw_company_name, expected_name)
    # Meme raisonnement que kbis_to_contrats.py : le repli « companyName =
    # expectedName si nameMatches » de docanalyze.js est STRUCTURELLEMENT
    # inatteignable ici, _check_name comparant expected_name au company_name
    # DEJA EXTRAIT et non a du texte brut plus large.
    company_name: str | None = str(raw_company_name) if raw_company_name else None

    issued_date = _normalize_date(_extract_scalar(result, "issued_date"), "issued_date", warnings)

    item = (items or [None])[0]
    matched_id = item.get("id") if (isinstance(item, dict) and item.get("id") == "urssaf") else None

    # Meme arbitrage que kbis_to_contrats.py, aligne sur la regle du portage JS
    # (inventaire de divergence #179, ligne B1) : « extraction douteuse » et
    # « document illisible » sont deux pannes differentes et ne se traitent pas
    # pareil. Les 3 champs identifiants d'une attestation de vigilance sont le
    # nom du cotisant, son SIREN et son SIRET -- tous les trois absents, il n'y
    # a pas eu de lecture. Un validation.valid=false avec des champs bel et
    # bien lus rend l'extraction douteuse, pas illisible : les champs restent.
    validation = extraction_response.get("validation") or {}
    docie_says_invalid = validation.get("valid") is False
    nothing_identifying = not raw_company_name and not enriched["siren"] and not enriched["siret"]
    is_valid = not (docie_says_invalid or nothing_identifying)

    issues: list[str] = []
    if nothing_identifying:
        # Miroir exact de la branche "Aucun texte lisible" de
        # analyzeDocumentLocal (memes cles, memes valeurs par defaut).
        document_type = "Document"
        company_name = None
        name_matches = None
        issued_date = ""
        issues = ["Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."]
        summary = "Document illisible."
    else:
        document_type = DOCUMENT_TYPE_LABEL
        if docie_says_invalid:
            issues.append("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).")
        if name_matches is False:
            issues.append("La société du document ne correspond pas au sous-traitant saisi.")
        # Dans `issues` et pas seulement dans `warnings` : le chemin de
        # production (contrats/lib/docie-extraction.js) ne garde que
        # `analysis` et jette les avertissements. isValid n'est PAS touche :
        # l'attestation reste lisible, c'est un numero qui est douteux.
        issues.extend(probleme["message"] for probleme in problemes)
        if not issued_date:
            # Message identique a celui de docanalyze.js : c'est la meme panne
            # vue par l'utilisateur, et elle a ici une consequence precise --
            # sans date de delivrance, la validite 6 mois ne se calcule pas.
            issues.append("Date de délivrance non trouvée dans le document.")
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
    # Les cles enrichies restent presentes MEME dans la branche illisible :
    # meme raison que kbis_to_contrats.py -- DocIE peut avoir lu un champ isole
    # sans avoir lu aucun des 3 signaux identifiants, et ces cles n'existent de
    # toute facon pas cote docanalyze.js.
    analysis.update(enriched)
    # Verdict LISIBLE PAR MACHINE du controle de cle (voir siren_siret.py),
    # present dans les deux branches, meme cle et meme forme que le Kbis.
    # Volontairement HORS de ENRICHED_KEYS : ce n'est pas un champ lu sur
    # l'attestation. Un consommateur n'utilise `siren` / `siret` que si le
    # statut correspondant vaut exactement "valide".
    analysis["controleSirenSiret"] = controle

    return UrssafMappingResult(analysis=analysis, warnings=warnings)


__all__ = [
    "DOCIE_SCHEMA_NAME",
    "DOCUMENT_TYPE_LABEL",
    "DOCANALYZE_BASE_KEYS",
    "MAPPED_FIELDS",
    "ENRICHED_KEYS",
    "GAP_NOTES",
    "MOTIF_NOMBRE",
    "ANNEE_MIN",
    "ANNEE_MAX",
    "SCHEMA_PATH",
    "load_schema",
    "UrssafMappingError",
    "UrssafMappingResult",
    "map_docie_urssaf_to_analysis",
]
