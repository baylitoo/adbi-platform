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

# Bornes de date PARTAGEES avec les trois autres portages du mapping, fixees
# dans document-parsing/fixtures/date_docie.json (champs `annee_min` /
# `annee_max`), que les tests des deux cotes comparent a ces deux constantes.
# 1950-2100 n'est pas un chiffre tire au sort : c'est la fenetre d'annees deja
# retenue ailleurs dans le depot pour la meme question (#176), et en adopter
# une seconde ici creerait exactement le genre de divergence que recense #179.
# Le faux positif assume -- l'immatriculation d'une societe anterieure a 1950
# -- sort en avertissement citant la valeur brute, jamais en valeur perdue ni
# fabriquee ; la fenetre attrape en echange l'OCR a quatre chiffres du genre
# « 0202-05-14 », qu'un <input type="date"> accepte sans broncher.
ANNEE_MIN = 1950
ANNEE_MAX = 2100

_JOURS_PAR_MOIS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

# « Ce texte est-il un nombre ? » -- motif PARTAGE, identique caractere pour
# caractere au litteral JS (contrats/lib/docie-contract-import.js) et au champ
# `motif` de document-parsing/fixtures/nombre_docie.json, que les tests des
# deux cotes comparent a ce litteral : ajouter une forme d'un seul cote casse
# le test de l'autre service. [0-9] et non \d parce que \d reconnait aussi les
# chiffres arabes-indiens en Python et pas en JS (miroir inverse du piege
# re.ASCII de #177) ; la notation exponentielle est refusee parce que son
# rendu diverge entre les deux langages.
MOTIF_NOMBRE = r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$"
_NOMBRE_RE = re.compile(MOTIF_NOMBRE)


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


def _est_bissextile(annee: int) -> bool:
    return annee % 4 == 0 and (annee % 100 != 0 or annee % 400 == 0)


def _date_existe(annee: int, mois: int, jour: int) -> bool:
    """Le triplet designe-t-il une date reelle, dans la fenetre d'annees
    retenue ? Les bornes sont ecrites a la main plutot que deleguees a
    datetime.date() : le portage JS n'a pas d'equivalent fiable (new Date()
    reporte silencieusement un 30 fevrier au 2 mars, ce qui FABRIQUERAIT une
    date au lieu de la refuser), et les deux cotes doivent rendre le meme
    verdict. La regle complete est ecrite dans `_regle` cote fixture."""
    if not ANNEE_MIN <= annee <= ANNEE_MAX:
        return False
    if not 1 <= mois <= 12:
        return False
    dernier = 29 if (mois == 2 and _est_bissextile(annee)) else _JOURS_PAR_MOIS[mois - 1]
    return 1 <= jour <= dernier


def _normalize_date(raw: Any, field_key: str, warnings: list[str]) -> str:
    """DocIE's DateField ne garantit PAS l'ISO ("ISO-8601 quand possible" --
    docie_bench/schemas/common.py) alors que contrats/lib/fields.js attend un
    <input type="date"> (YYYY-MM-DD). ISO transparent ; DD/MM/YYYY converti ;
    tout le reste -> vide + avertissement (jamais de valeur injectee dans un
    champ date que le navigateur ne saura pas afficher).

    Regle partagee : document-parsing/fixtures/date_docie.json. Les deux
    motifs ne comptent que des chiffres, jamais leurs bornes : « 01/13/2026 »
    ressortait en « 2026-13-01 » et « 45/02/2026 » en « 2026-02-45 », ici
    comme dans les trois autres portages, sans un seul avertissement
    (inventaire de divergence #179, lignes A8 et A9 -- le rare cas ou Python
    et JS sont d'accord ET tous les deux faux). Le navigateur refuse
    silencieusement une telle valeur dans <input type="date"> : le champ
    s'affiche VIDE et la date est perdue sans erreur, si bien que la panne
    ressemble a « DocIE n'a rien trouve ». Une date hors calendrier ou hors
    fenetre est desormais refusee explicitement, avec un avertissement
    DISTINCT de « date non reconnue » : les deux pannes ne se corrigent pas
    de la meme facon (l'une dit que DocIE a lu une date fausse, l'autre qu'il
    n'a rien su lire). Elle n'est jamais reparee ni tronquee -- pas de
    2026-02-28 pour un 30 fevrier."""
    if raw is None or raw == "":
        return ""
    raw_s = str(raw).strip()
    if raw_s == "":
        # Un champ reduit a des espaces est un champ vide : "champ vu, rien
        # trouve", meme regle que _normalize_number. Avertir ici noierait les
        # vrais avertissements sous un "date non reconnue ('')".
        return ""
    annee = mois = jour = None
    if _ISO_DATE_RE.match(raw_s):
        annee, mois, jour = int(raw_s[0:4]), int(raw_s[5:7]), int(raw_s[8:10])
    else:
        m = _FR_DATE_RE.match(raw_s)
        if m:
            d, mo, y = m.groups()
            annee, mois, jour = int(y), int(mo), int(d)
    if annee is None:
        warnings.append(f"{field_key}: date non reconnue ({raw_s!r}), laissee vide -- a corriger manuellement")
        return ""
    if not _date_existe(annee, mois, jour):
        warnings.append(
            f"{field_key}: date impossible ({raw_s!r}), laissee vide -- "
            f"jour/mois hors calendrier ou annee hors {ANNEE_MIN}-{ANNEE_MAX} ; a corriger manuellement"
        )
        return ""
    return f"{annee:04d}-{mois:02d}-{jour:02d}"


def _forme_nombre(texte: str) -> str:
    """Mise en forme PUREMENT LEXICALE d'un texte deja reconnu par
    MOTIF_NOMBRE : jamais d'aller-retour par le flottant du langage, dont le
    rendu differe (str(1e16) rend "1e+16" en Python, String(1e16) rend
    "10000000000000000" en JS). Voir `_regle_forme` dans la fixture."""
    negatif = texte[:1] == "-"
    corps = texte[1:] if texte[:1] in ("+", "-") else texte
    entier, _, frac = corps.partition(".")
    entier = entier.lstrip("0") or "0"
    frac = frac.rstrip("0")
    sortie = entier + ("." + frac if frac else "")
    return "-" + sortie if negatif and sortie != "0" else sortie


def _normalize_number(raw: Any, field_key: str, warnings: list[str]) -> str:
    """fields.js type "number" attend une chaine numerique simple (ex:
    "420", "45") ; DocIE serialise ses Decimal en str (pydantic v2
    mode="json").

    Regle partagee : document-parsing/fixtures/nombre_docie.json. Ce module
    s'en remettait a float(), qui accepte des textes que Number() cote JS
    refuse -- et inversement -- d'ou six des neuf ecarts mesures de
    l'inventaire #179. float("1_000") rendait "1000" SANS avertissement (le
    separateur de milliers de la syntaxe Python, qu'aucun document n'ecrit),
    et float("nan") / float("inf") faisaient remonter une exception depuis
    le int() laisse hors du try. Un texte non reconnu ressort desormais tel
    quel avec un avertissement : une valeur visiblement fausse que le
    relecteur corrige vaut mieux qu'une valeur plausible fabriquee."""
    if raw is None or raw == "":
        return ""
    raw_s = str(raw).strip()
    if raw_s == "":
        # Un champ reduit a des espaces est un champ vide : "champ vu, rien
        # trouve", meme traitement que {"value": null}. Surtout pas un 0
        # (un delai de paiement de 0 jour, un TJM de 0 euro).
        return ""
    if not _NOMBRE_RE.match(raw_s):
        warnings.append(f"{field_key}: nombre non reconnu ({raw_s!r}), reporte tel quel")
        return raw_s
    return _forme_nombre(raw_s)


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
    "MOTIF_NOMBRE",
    "ANNEE_MIN",
    "ANNEE_MAX",
    "ContractMappingError",
    "MappingResult",
    "map_docie_contract_to_sous_traitance",
    "build_import_payload",
]
