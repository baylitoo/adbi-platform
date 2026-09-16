#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cni_to_contrats.py -- traduit un resultat d'extraction DocIE (schema
dynamique "cni", document-parsing/schemas/cni.schema.json) vers une analyse
compatible avec ce que contrats/lib/docanalyze.js::analyzeDocumentLocal renvoie
a POST /api/document/analyze (contrats/server.js), avec la MEME forme que les
paires Kbis, URSSAF et RIB : un consommateur pourra la lire sans cas
particulier. Portage JS : contrats/lib/cni-mapping.js.

Piece : « Piece d'identite du consultant (afin de creer ses acces) »
(contrats/lib/checklist.js, ligne `id: "cni"`, rubrique Identite).

POURQUOI la voie vision, et ou c'est ecrit : document-parsing/models/
catalogue.json, tache "cni" (cle `taches`), ne declare QU'UNE voie, `agent`, avec NuExtract3
(« Vision. ») et pour `prerequis` « Controle des chiffres de la MRZ. ». Une
carte d'identite arrive en photo ou en scan : il n'y a pas de couche texte a
envoyer, a la difference du RIB et de l'URSSAF. Le controle exige par le
catalogue est mrz.py, importe ci-dessous.

AUCUN CABLAGE ici : contrats/lib/docie-extraction.js ne route pas la piece
"cni" (il compte aujourd'hui « cni, fiscale, coordonnees, specifique » parmi
les pieces sans voie DocIE) et ce module ne le change pas -- il n'en depend pas
non plus.

Schema DocIE "cni" -- dix champs, chacun la ou il se lit sur la carte :
    surname          string  (nom de famille du titulaire)
    given_names      string  (prenoms)
    document_number  string  (numero du titre, en clair)
    nationality      string
    birth_date       date
    sex              string
    issue_date       date    (date de delivrance -> issuedDate)
    expiry_date      date
    mrz_line1        string  (zone de lecture automatique, ligne 1)
    mrz_line2        string  (zone de lecture automatique, ligne 2)

MRZ : format TD1 (trois lignes de 30), celui de la carte francaise depuis 2021
-- affirmation CITEE DE MEMOIRE et non relue, voir l'en-tete de mrz.py et
`_format` dans document-parsing/fixtures/mrz.json. Seules les lignes 1 et 2
sont demandees : elles portent tous les chiffres de controle, la ligne 3 ne
porte que les noms, deja demandes en clair.

RESERVE : aucune carte d'identite reelle n'a ete lue pour ecrire ce schema
(meme reserve que urssaf, rib et fiscale), et aucun appel reseau n'etait
permis. Ce qui a ete laisse de cote est dans GAP_NOTES.

PAS DE COMPARAISON DE NOM, et c'est un ecart VOULU avec les trois autres
paires : une carte d'identite porte une PERSONNE PHYSIQUE (le consultant),
jamais la societe sous-traitante. `expectedName` vaut, cote appelant,
state.values.stNom -- la denomination du sous-traitant. Comparer ce nom au
titulaire de la carte rendrait False sur toute carte parfaitement valable, donc
le message bloquant « La societe du document ne correspond pas au sous-traitant
saisi. » sur une piece juste. `companyName` et `nameMatches` restent donc a
None, et _check_name n'est meme pas importe. Le nom lu n'est pas perdu pour
autant : il sort dans `nom` et `prenoms`.

REUTILISATION -- rien n'est recopie ici, tout est IMPORTE, et les tests le
verifient par identite d'objet, lecture du source et temoin :
  - `_normalize_date` (regle date_docie.json) et `_extract_scalar` de
    kbis_to_contrats.py, comme urssaf et fiscale ;
  - `controler_mrz` / `messages_mrz` de mrz.py.
Aucun champ `money` ni `number` : ni `_normalize_number` ni
`_extract_money_pair` ne sont importes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kbis_to_contrats import DOCANALYZE_BASE_KEYS, _extract_scalar, _normalize_date  # noqa: F401
from mrz import controler_mrz, messages_mrz

DOCIE_SCHEMA_NAME = "cni"

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schemas" / "cni.schema.json"


def load_schema() -> dict:
    """Charge le schema dynamique cni (celui envoye a DocIE dans le corps)."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


# Champs DocIE "cni" -> cles camelCase NOUVELLES (absentes de docanalyze.js).
# issue_date est traite a part : il alimente issuedDate, cle docanalyze.js.
MAPPED_FIELDS: dict[str, tuple[str, str]] = {
    "surname": ("nom", "string"),
    "given_names": ("prenoms", "string"),
    "document_number": ("numeroDocument", "string"),
    "nationality": ("nationalite", "string"),
    "birth_date": ("dateNaissance", "date"),
    "sex": ("sexe", "string"),
    "expiry_date": ("dateExpiration", "date"),
    "mrz_line1": ("mrzLigne1", "string"),
    "mrz_line2": ("mrzLigne2", "string"),
}

ENRICHED_KEYS = [out_key for out_key, _ in MAPPED_FIELDS.values()]

# Libelle EXACT de contrats/lib/docanalyze.js::detectType() pour cette piece
# (branche « CARTE NATIONALE D IDENTITE | PIECE D IDENTITE | PASSEPORT | TITRE
# DE SEJOUR ») : l'origine de l'analyse ne doit pas changer le type affiche.
DOCUMENT_TYPE_LABEL = "Pièce d'identité"

ILLISIBLE = "Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."

# Ce que le schema ne porte PAS, dit explicitement plutot que devine plus tard :
GAP_NOTES = (
    "Le numero lu en clair (`document_number`) n'est PAS compare a celui de la MRZ. Le champ TD1 du numero "
    "compte 9 caracteres et le mecanisme de debordement d'un numero plus long vers les donnees optionnelles "
    "n'a pas pu etre relu (hors reseau) : la comparaison produirait des discordances fausses sur les numeros "
    "longs. Le chiffre de controle de la MRZ couvre deja le numero cote MRZ.",
    "Les dates de la MRZ (AAMMJJ, sans siecle) ne sont PAS comparees a `birth_date` / `expiry_date` : la regle "
    "de siecle d'un AAMMJJ n'a pas pu etre relue, et la deviner ferait exactement ce que le controle doit "
    "empecher. Les deux dates de la MRZ ont leur propre chiffre de controle.",
    "La ligne 3 de la MRZ (noms) n'est pas demandee : elle ne porte aucun chiffre de controle et redirait "
    "`surname` / `given_names`, en doublant la surface de lecture fausse.",
    "L'ancienne carte francaise (avant 2021, MRZ a deux lignes de 36 d'un format national) n'est pas couverte : "
    "ses lignes sortiront en « format_invalide », faux positif bruyant et jamais une valeur fausse acceptee.",
    "Lieu de naissance, taille, adresse, autorite de delivrance et numero d'acte de naissance : non extraits. "
    "Aucun consommateur, et une piece d'identite est la donnee personnelle la plus sensible de la checklist -- "
    "on n'en extrait que ce dont quelqu'un a l'usage.",
    "Plausibilite des dates (delivrance dans le futur, expiration anterieure a la delivrance) : non controlee "
    "ici. Le module qui la porte (date_plausible, PR #215) n'est pas sur master au moment d'ecrire cette paire ; "
    "l'y brancher se fera quand il y sera, sans rien changer a ce schema.",
)


class CniMappingError(ValueError):
    """L'entree n'est pas une extraction DocIE valide du schema 'cni'."""


@dataclass
class CniMappingResult:
    """`analysis` : sur-ensemble STRICT des 8 cles de docanalyze.js
    (DOCANALYZE_BASE_KEYS), plus ENRICHED_KEYS et `controleMrz`. `warnings` :
    degradations non bloquantes, distinctes de `analysis["issues"]` (message
    utilisateur)."""

    analysis: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


def map_docie_cni_to_analysis(
    extraction_response: dict,
    expected_name: str | None = None,
    items: list[dict] | None = None,
) -> CniMappingResult:
    """Traduit une enveloppe ExtractionResponse DocIE (schema 'cni').

    expected_name : accepte pour garder la MEME signature que les trois autres
    paires, et VOLONTAIREMENT IGNORE (voir l'en-tete : une carte d'identite ne
    porte pas la societe sous-traitante). `nameMatches` vaut None quoi qu'il
    arrive, et les tests le verifient.
    items : `items` de analyzeDocumentLocal -- matchedId renseigne seulement si
    items[0].id vaut "cni", port exact de detectType().
    """
    if not isinstance(extraction_response, dict):
        raise CniMappingError("extraction_response doit etre un dict (enveloppe ExtractionResponse)")

    schema_name = extraction_response.get("schema_name")
    if schema_name != DOCIE_SCHEMA_NAME:
        raise CniMappingError(
            f"schema_name attendu {DOCIE_SCHEMA_NAME!r}, recu {schema_name!r} -- "
            "ce module ne mappe QUE le schema dynamique 'cni'"
        )

    result = extraction_response.get("result")
    if not isinstance(result, dict):
        raise CniMappingError("extraction_response['result'] manquant ou invalide")

    warnings: list[str] = []
    enriched: dict[str, str] = {}

    for docie_key, (out_key, kind) in MAPPED_FIELDS.items():
        raw = _extract_scalar(result, docie_key)
        if kind == "date":
            enriched[out_key] = _normalize_date(raw, docie_key, warnings)
        else:  # "string"
            enriched[out_key] = "" if raw is None else str(raw)

    # Chiffres de controle de la MRZ (prerequis du catalogue pour cette piece).
    # Les lignes lues restent dans `mrzLigne1` / `mrzLigne2` : les vider ferait
    # basculer une carte lisible dans la branche « illisible » (#179 B1).
    controle_mrz = controler_mrz(_extract_scalar(result, "mrz_line1"), _extract_scalar(result, "mrz_line2"))
    problemes = messages_mrz(controle_mrz)
    for probleme in problemes:
        # `champ` est deja le nom DocIE de la ligne en cause (mrz_line1/2).
        warnings.append(f"{probleme['champ']}: {probleme['message']}")

    issued_date = _normalize_date(_extract_scalar(result, "issue_date"), "issue_date", warnings)

    item = (items or [None])[0]
    matched_id = item.get("id") if (isinstance(item, dict) and item.get("id") == "cni") else None

    # Meme arbitrage que les trois autres paires (#179 B1) : « extraction
    # douteuse » et « document illisible » sont deux pannes differentes. Les
    # signaux identifiants d'une piece d'identite sont le nom du titulaire, le
    # numero du titre et les deux lignes de MRZ -- tous absents, il n'y a pas eu
    # de lecture. Le prenom seul, la nationalite seule ou le sexe seul
    # n'identifient aucun titre. Un validation.valid=false avec des champs bel
    # et bien lus rend l'extraction douteuse, pas illisible.
    raw_surname = _extract_scalar(result, "surname")
    validation = extraction_response.get("validation") or {}
    docie_says_invalid = validation.get("valid") is False
    nothing_identifying = not (
        raw_surname or enriched["numeroDocument"] or enriched["mrzLigne1"] or enriched["mrzLigne2"]
    )
    is_valid = not (docie_says_invalid or nothing_identifying)

    issues: list[str] = []
    if nothing_identifying:
        document_type = "Document"
        issued_date = ""
        issues = [ILLISIBLE]
        summary = "Document illisible."
    else:
        document_type = DOCUMENT_TYPE_LABEL
        if docie_says_invalid:
            issues.append("DocIE n'a pas validé l'extraction (vérification manuelle recommandée).")
        # Dans `issues` et pas seulement dans `warnings` : le chemin de
        # production (contrats/lib/docie-extraction.js) ne garde que `analysis`.
        # isValid n'est PAS touche (meme regle que le SIREN du Kbis et l'IBAN du
        # RIB) : la carte reste lisible, c'est une valeur qui est douteuse, et
        # `controleMrz` le dit par machine.
        issues.extend(probleme["message"] for probleme in problemes)
        # Pas de « Date de delivrance non trouvee » : a la difference du Kbis et
        # de l'URSSAF, contrats/lib/checklist.js ne declare PAS `dateField` pour
        # la ligne "cni" -- aucune validite n'est calculee a partir de cette
        # date, et l'absence n'a donc pas de consequence a annoncer.
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
        # Une carte d'identite ne porte pas de societe : ces deux cles existent
        # pour rester un sur-ensemble de docanalyze.js, et valent toujours None.
        "companyName": None,
        "nameMatches": None,
        "issues": issues,
        "summary": summary,
    }
    # Les cles enrichies restent presentes MEME dans la branche illisible : DocIE
    # peut avoir lu un champ isole (la nationalite) sans avoir lu aucun signal
    # identifiant, et ces cles n'existent de toute facon pas cote docanalyze.js.
    analysis.update(enriched)
    # Verdict LISIBLE PAR MACHINE, present dans les deux branches, HORS de
    # ENRICHED_KEYS (ce n'est pas un champ lu sur la carte). Un consommateur
    # n'utilise une valeur de la MRZ que si son statut vaut exactement "valide".
    analysis["controleMrz"] = controle_mrz

    return CniMappingResult(analysis=analysis, warnings=warnings)


__all__ = [
    "DOCIE_SCHEMA_NAME",
    "DOCUMENT_TYPE_LABEL",
    "DOCANALYZE_BASE_KEYS",
    "MAPPED_FIELDS",
    "ENRICHED_KEYS",
    "GAP_NOTES",
    "ILLISIBLE",
    "SCHEMA_PATH",
    "load_schema",
    "CniMappingError",
    "CniMappingResult",
    "map_docie_cni_to_analysis",
]
