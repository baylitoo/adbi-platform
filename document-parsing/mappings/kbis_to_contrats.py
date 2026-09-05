#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kbis_to_contrats.py -- traduit un resultat d'extraction DocIE Studio
(schema dynamique "kbis") vers une analyse compatible avec ce que
contrats/lib/docanalyze.js::analyzeDocumentLocal renvoie aujourd'hui a
POST /api/document/analyze (contrats/server.js), en l'enrichissant des
champs structures que le parsing par regex de docanalyze.js n'a jamais su
extraire (SIREN, SIRET, forme juridique, capital, RCS, adresse du siege,
representant legal, date d'immatriculation).

Contexte -- POURQUOI ce module cible docanalyze.js et pas
contrats/lib/fields.js::sousTraitance (a la difference de
mappings/contract_to_contrats.py, qui lui alimente sousTraitance) : Kbis et
URSSAF ne sont PAS des sources de `values` de contrat aujourd'hui -- ce sont
des pieces justificatives verifiees par /api/document/analyze, dont la
sortie JSON part telle quelle vers contrats/public/app.js::
analyzeChecklistDoc (qui ne lit que issuedDate / companyName / nameMatches,
mais le contrat d'API expose bien les 8 cles ci-dessous). Le mandat de cette
tache est explicite : produire un SUR-ENSEMBLE STRICT de la sortie actuelle
de docanalyze.js -- memes noms de champs pour documentType / companyName /
issuedDate / nameMatches (rien ne casse en aval si ce module remplace un
jour le chemin regex), PLUS les champs plus riches que DocIE sait produire.
Le garde-fou anti-derive de test_kbis_to_contrats.py lit docanalyze.js EN
DIRECT (regex sur son code source, docanalyze.js etant une fonction et non
un tableau statique comme fields.js::sousTraitance) pour verifier que ces 8
cles sont exactement celles que la fonction retourne aujourd'hui.

Forme du JSON consomme : la meme enveloppe `ExtractionResponse` que
mappings/contract_to_contrats.py (voir son docstring pour le detail complet
de l'encapsulation par type DocIE -- string/date -> {"value", ...},
number -> {"value", ...} (Decimal serialise en str), money -> {"amount",
"currency", ...} ; confirme ici aussi contre docie_bench/schemas/common.py
dans le checkout local small-doc-ie-bench, au meme commit de reference
(6e30bc6) que celui documente dans document-parsing/scripts/
register_and_test.py -- verifie : `git diff 6e30bc6 dce1a5d -- src/
docie_bench/schemas/common.py src/docie_bench/schemas/dynamic.py` ne montre
aucune difference sur ces deux fichiers).

Schema DocIE "kbis" (SCHEMAS["kbis"] dans register_and_test.py, branche
document-parsing-docie-live-test / PR #46) :
    company_name         string
    siren                string
    siret_siege          string
    legal_form           string
    share_capital        money
    registration_date    date
    issued_date          date   (date d'edition/delivrance du Kbis)
    rcs_number           string
    registered_address   string
    activity_code        string
    legal_representative string

Ce schema n'a JAMAIS ete extrait pour de vrai (seul "resume" l'a ete, voir
register_and_test.py) -- les fixtures sont donc generees depuis les VRAIS
modeles pydantic de DocIE, pas ecrites a la main (voir
fixtures/generate_kbis_sample.py pour la provenance).
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

DOCIE_SCHEMA_NAME = "kbis"

# ---------------------------------------------------------------------------
# 1) Les 8 cles que contrats/lib/docanalyze.js::analyzeDocumentLocal renvoie
#    aujourd'hui (les deux branches de retour -- document illisible et
#    analyse complete -- utilisent exactement le meme jeu de cles). Ce
#    module DOIT toujours les produire, avec la meme semantique, pour rester
#    un sur-ensemble valide. Verifie par test_kbis_to_contrats.py en relisant
#    contrats/lib/docanalyze.js en direct -- ne pas modifier cette liste sans
#    verifier que docanalyze.js n'a pas change (et inversement).
# ---------------------------------------------------------------------------
DOCANALYZE_BASE_KEYS: set[str] = {
    "documentType", "matchedId", "isValid", "issuedDate",
    "companyName", "nameMatches", "issues", "summary",
}

# ---------------------------------------------------------------------------
# 2) Champs DocIE "kbis" reellement extraits du document, mappes 1-pour-1
#    vers des cles camelCase NOUVELLES (absentes de docanalyze.js -- c'est
#    l'enrichissement demande). Reprend la convention de nommage deja en
#    usage pour le sous-traitant dans contrats/lib/fields.js (stSiren,
#    stSiret, stFormeJuridique, stRepresentant, stAdresse existent deja pour
#    la SAISIE MANUELLE / la source "contract" -- volontairement PAS
#    reutilisees ici telles quelles : un Kbis est une piece justificative
#    verifiee, pas le formulaire de saisie, et le fusionner directement dans
#    ces cles la court-circuiterait la relecture humaine. Un futur
#    controleur d'integration reste libre de recopier ces valeurs dans
#    stSiren/stSiret/... s'il juge la source Kbis assez fiable pour cela --
#    hors perimetre de ce module, qui ne fait que le mapping de donnees.)
# ---------------------------------------------------------------------------
MAPPED_FIELDS: dict[str, tuple[str, str]] = {
    "siren": ("siren", "string"),
    "siret_siege": ("siret", "string"),
    "legal_form": ("formeJuridique", "string"),
    "registration_date": ("dateImmatriculation", "date"),
    "rcs_number": ("rcsNumber", "string"),
    "registered_address": ("adresseSiege", "string"),
    "activity_code": ("codeActivite", "string"),
    "legal_representative": ("representantLegal", "string"),
    # company_name et issued_date sont traites a part : ils alimentent
    # directement companyName/issuedDate (cles docanalyze.js), pas une
    # cle enrichie separee -- voir map_docie_kbis_to_analysis().
    # share_capital (money) est aussi traite a part (2 cles en sortie :
    # capitalSocial + capitalSocialDevise) -- voir _extract_money_pair().
}

ENRICHED_KEYS: set[str] = {contrats_key for contrats_key, _ in MAPPED_FIELDS.values()} | {
    "capitalSocial", "capitalSocialDevise",
}

# ---------------------------------------------------------------------------
# 3) GAPS REELS : ce qu'un vrai Kbis porte et que le schema DocIE "kbis"
#    (register_and_test.py, PR #46) ne capture PAS du tout, ou capture de
#    facon trop grossiere pour etre exploitable telle quelle. A signaler a
#    qui fera l'integration reelle -- meme esprit que
#    contract_to_contrats.py::GAP_FIELDS_NO_DOCIE_EQUIVALENT.
# ---------------------------------------------------------------------------
GAP_NOTES: dict[str, str] = {
    "qualite_representant": (
        "legal_representative est UNE SEULE chaine (ex: 'Monsieur Corentin CALVO') -- "
        "le schema n'a pas de champ separe pour la qualite (Gerant/President/DG), a la "
        "difference du schema 'contract' qui a st_qualite en plus de st_representant. "
        "Si le modele inclut la qualite dans la chaine (ex: 'Madame Jane DOE, Presidente', "
        "voir la fixture d'edge case), elle reste imbriquee dans representantLegal, non "
        "structuree."
    ),
    "objet_social": (
        "activity_code ne capture que le CODE APE/NAF (ex: '6202A') -- aucun champ pour le "
        "libelle en clair de l'activite declaree (« objet social » / « activite principale "
        "exercee ») qu'un Kbis affiche pourtant en toutes lettres a cote du code."
    ),
    "greffe": (
        "rcs_number est une chaine libre qui peut ou non inclure le greffe (ex: '941 091 316 "
        "RCS Paris' dans la fixture nominale) -- rien ne garantit que le modele l'isole du "
        "numero ; pas de champ dedie 'greffe' distinct du numero RCS lui-meme."
    ),
    "etablissements_secondaires": (
        "registered_address ne couvre que le siege (siret_siege est explicitement le SIRET du "
        "siege) -- aucun champ pour d'eventuels etablissements secondaires listes sur le meme "
        "extrait Kbis."
    ),
    "duree_personne_morale": (
        "aucun champ pour la duree de la personne morale (ex: '99 ans a compter de son "
        "immatriculation'), pourtant presente sur un Kbis standard."
    ),
}

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FR_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")

# ---------------------------------------------------------------------------
# Port fidele de contrats/lib/docanalyze.js::norm() / checkName() -- MEME
# POLITIQUE de comparaison de nom, reutilisee ici plutot que reinventee (voir
# la consigne de la tache). Difference assumee et documentee : docanalyze.js
# compare expectedName au TEXTE BRUT du document entier (issu de pdf-parse /
# tesseract.js) ; ce module compare expectedName au champ `company_name` DEJA
# EXTRAIT par DocIE, car l'enveloppe ExtractionResponse ne transporte pas le
# texte brut du document (seuls les champs structures + evidence_ids, pas le
# texte source). C'est un texte plus court et plus propre a comparer -- la
# meme normalisation et le meme seuil de 60% s'appliquent, seule la source du
# texte candidat change.
# ---------------------------------------------------------------------------
_LEGAL_FORM_TOKENS = {"SARL", "SAS", "SASU", "EURL", "SA", "SCI", "GROUPE", "EI"}
_NON_ALNUM_SPACE_RE = re.compile(r"[^A-Z0-9 ]")
_MULTI_SPACE_RE = re.compile(r"\s+")


def _norm(s: Any) -> str:
    text = "" if s is None else str(s)
    text = text.upper()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = _NON_ALNUM_SPACE_RE.sub(" ", text)
    text = _MULTI_SPACE_RE.sub(" ", text).strip()
    return text


def _check_name(candidate_text: Any, expected_name: str | None) -> bool | None:
    """Port de checkName(text, expectedName) : null si pas de nom attendu,
    sinon vrai si >= ceil(60%) des tokens (>=3 caracteres, formes juridiques
    exclues) du nom attendu se retrouvent dans le texte candidat normalise."""
    if not expected_name:
        return None
    nt = _norm(candidate_text)
    tokens = [t for t in _norm(expected_name).split(" ") if len(t) >= 3 and t not in _LEGAL_FORM_TOKENS]
    if not tokens:
        return None
    found = sum(1 for t in tokens if t in nt)
    return found >= math.ceil(len(tokens) * 0.6)


def _normalize_date(raw: Any, field_key: str, warnings: list[str]) -> str:
    """Port de contract_to_contrats.py::_normalize_date (meme politique :
    ISO transparent, DD/MM/YYYY converti, sinon vide + avertissement)."""
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
    """Port de contract_to_contrats.py::_normalize_number (Decimal serialise
    en str par pydantic v2 mode="json" -> entier propre si possible)."""
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


def _extract_money_pair(result: dict, docie_key: str, warnings: list[str]) -> tuple[str, str]:
    """Contrairement a contract_to_contrats.py::_extract_money (qui doit
    aplatir vers le champ "number" unique `tjm` de fields.js), capitalSocial
    n'a pas de contrainte de forme preexistante -- le montant ET la devise
    sont donc conserves comme 2 cles separees plutot que la devise
    silencieusement abandonnee apres avertissement."""
    wrapper = result.get(docie_key)
    if not isinstance(wrapper, dict):
        return "", ""
    amount = wrapper.get("amount")
    currency = wrapper.get("currency")
    amount_out = "" if amount is None or amount == "" else _normalize_number(amount, docie_key, warnings)
    currency_out = "" if not currency else str(currency).upper()
    if currency_out and currency_out != "EUR":
        warnings.append(
            f"{docie_key}: devise {currency_out!r} != EUR -- montant reporte tel quel sans conversion"
        )
    return amount_out, currency_out


class KbisMappingError(ValueError):
    """L'entree n'est pas une extraction DocIE valide du schema 'kbis'."""


@dataclass
class KbisMappingResult:
    """`analysis` est le dict pret a etre renvoye a la place (ou en plus) de
    contrats/lib/docanalyze.js::analyzeDocumentLocal() -- sur-ensemble
    STRICT de ses 8 cles actuelles (DOCANALYZE_BASE_KEYS), plus les cles
    enrichies de ENRICHED_KEYS. `warnings` reprend les degradations non
    bloquantes internes a DocIE (notes d'extraction, avertissements/erreurs
    de validation, dates/nombres non reconnus) -- une information de
    diagnostic distincte de `analysis["issues"]`, qui elle est le message
    utilisateur DEJA affiche par contrats/public/app.js (meme role que le
    `issues` de docanalyze.js, pas un nouveau concept)."""

    analysis: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def map_docie_kbis_to_analysis(
    extraction_response: dict,
    expected_name: str | None = None,
    items: list[dict] | None = None,
) -> KbisMappingResult:
    """Traduit une enveloppe ExtractionResponse DocIE (schema 'kbis') vers
    un dict compatible avec contrats/lib/docanalyze.js::analyzeDocumentLocal.

    expected_name : equivalent du parametre `expectedName` de
    analyzeDocumentLocal (contrats/public/app.js envoie state.values.stNom)
    -- utilise pour nameMatches via le meme algorithme que checkName().
    items : equivalent du parametre `items` de analyzeDocumentLocal (liste
    de {"id","label"} de la checklist front) -- utilise pour matchedId
    EXACTEMENT comme detectType() : seul items[0] est regarde, et matchedId
    n'est renseigne que si son id vaut "kbis".
    """
    if not isinstance(extraction_response, dict):
        raise KbisMappingError("extraction_response doit etre un dict (enveloppe ExtractionResponse)")

    schema_name = extraction_response.get("schema_name")
    if schema_name != DOCIE_SCHEMA_NAME:
        raise KbisMappingError(
            f"schema_name attendu {DOCIE_SCHEMA_NAME!r}, recu {schema_name!r} -- "
            "ce module ne mappe QUE le schema dynamique 'kbis'"
        )

    result = extraction_response.get("result")
    if not isinstance(result, dict):
        raise KbisMappingError("extraction_response['result'] manquant ou invalide")

    warnings: list[str] = []
    enriched: dict[str, str] = {}

    for docie_key, (out_key, kind) in MAPPED_FIELDS.items():
        raw = _extract_scalar(result, docie_key)
        if kind == "date":
            enriched[out_key] = _normalize_date(raw, docie_key, warnings)
        else:  # "string"
            enriched[out_key] = "" if raw is None else str(raw)

    capital_amount, capital_currency = _extract_money_pair(result, "share_capital", warnings)
    enriched["capitalSocial"] = capital_amount
    enriched["capitalSocialDevise"] = capital_currency

    raw_company_name = _extract_scalar(result, "company_name")
    name_matches = _check_name(raw_company_name, expected_name)
    # docanalyze.js a un repli `companyName = extractCompanyName(text) ||
    # (nameMatches ? expectedName : null)` : si son regex de denomination
    # echoue MAIS que le nom attendu se retrouve quand meme dans le texte
    # brut, il retombe sur ce nom plutot que sur null. Ce repli est
    # STRUCTURELLEMENT INATTEIGNABLE ici : _check_name() compare
    # expected_name au company_name DEJA EXTRAIT (pas a du texte brut plus
    # large ou le nom pourrait apparaitre ailleurs) -- si raw_company_name
    # est absent, _norm(None) est "" et _check_name ne peut jamais renvoyer
    # True (seulement False ou None). Le repli est donc volontairement omis
    # ici plutot que garde comme code mort : company_name est None des que
    # DocIE n'a rien extrait, point final.
    company_name: str | None = str(raw_company_name) if raw_company_name else None

    issued_date = _normalize_date(_extract_scalar(result, "issued_date"), "issued_date", warnings)

    # Item matchedId : port exact de detectType() -- seul items[0] compte,
    # et uniquement si son id vaut "kbis" (la cle du type de document).
    item = (items or [None])[0]
    matched_id = item.get("id") if (isinstance(item, dict) and item.get("id") == "kbis") else None

    # DocIE ayant reussi a produire des champs structures, considerer le
    # document comme lisible PAR DEFAUT (a la difference de docanalyze.js,
    # qui doit deviner la lisibilite depuis la longueur du texte OCR/pdf-
    # parse brut). Deux signaux DocIE peuvent neanmoins renverser ce constat,
    # mimant le "Document illisible" de docanalyze.js :
    #   - validation.valid est explicitement False cote DocIE ;
    #   - les 3 champs les plus identifiants (nom, SIREN, SIRET) sont TOUS
    #     absents -- un Kbis dont on ne peut identifier ni le nom ni aucun
    #     numero d'immatriculation n'a, en pratique, pas ete lu.
    validation = extraction_response.get("validation") or {}
    docie_says_invalid = validation.get("valid") is False
    nothing_identifying = not raw_company_name and not enriched["siren"] and not enriched["siret"]
    is_valid = not (docie_says_invalid or nothing_identifying)

    issues: list[str] = []
    if is_valid:
        document_type = "Extrait Kbis"
        if name_matches is False:
            issues.append("La société du document ne correspond pas au sous-traitant saisi.")
        if not issued_date:
            issues.append("Date de délivrance non trouvée dans le document.")
        summary = document_type + (" — délivré le " + issued_date if issued_date else "")
    else:
        # Miroir exact de la branche "Aucun texte lisible" de
        # analyzeDocumentLocal (memes cles, memes valeurs par defaut).
        document_type = "Document"
        company_name = None
        name_matches = None
        issued_date = ""
        issues = ["Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."]
        summary = "Document illisible."

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
    # Les cles enrichies restent presentes MEME dans la branche "illisible" :
    # a la difference de docanalyze.js (qui n'a litteralement rien d'autre
    # que du texte brut trop court a offrir), DocIE peut avoir extrait
    # quelques champs isoles (ex: legal_form) alors meme qu'aucun des 3
    # signaux identifiants (nom/SIREN/SIRET) n'a ete lu -- les jeter serait
    # perdre une information reelle sans aucun benefice de parite, puisque
    # ces cles n'existent de toute facon pas cote docanalyze.js.
    analysis.update(enriched)

    return KbisMappingResult(analysis=analysis, warnings=warnings)


__all__ = [
    "DOCIE_SCHEMA_NAME",
    "DOCANALYZE_BASE_KEYS",
    "MAPPED_FIELDS",
    "ENRICHED_KEYS",
    "GAP_NOTES",
    "KbisMappingError",
    "KbisMappingResult",
    "map_docie_kbis_to_analysis",
]
