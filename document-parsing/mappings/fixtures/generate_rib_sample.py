#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_rib_sample.py -- PROVENANCE ONLY, pas execute par les tests.

Documente comment rib_extraction_sample.json,
rib_extraction_sample_edge_cases.json et rib_extraction_sample_unreadable.json
ont ete produits, et permet de les regenerer si
document-parsing/schemas/rib.schema.json change.

Meme provenance que generate_urssaf_sample.py (lire sa docstring) : la
STRUCTURE de l'enveloppe et l'encapsulation par feuille sont reprises de sources
mesurees du depot (kbis_extraction_sample.json, genere depuis les vrais modeles
pydantic DocIE ; bridge/tests/contract_text.json, trime d'une vraie reponse de
POST /v1/extract/text). Seules les VALEURS sont fabriquees. Aucun RIB reel n'a
ete lu : l'IBAN est l'exemple FR du registre IBAN (voir `_exemples` dans
document-parsing/fixtures/iban_bic.json), le titulaire et la banque sont
inventes, et aucune coherence entre le code banque de l'IBAN, le BIC et le nom
de banque n'est pretendue.

Usage :  python generate_rib_sample.py     (reecrit les 3 fixtures)
"""

from __future__ import annotations

import json
from pathlib import Path

ICI = Path(__file__).resolve().parent
SCHEMA = json.loads((ICI.parents[1] / "schemas" / "rib.schema.json").read_text(encoding="utf-8"))


def enveloppe(suffixe: str, resultat: dict, validation: dict) -> dict:
    ident = "req-fixture-rib-" + suffixe
    return {
        "request_id": ident,
        "schema_name": SCHEMA["document_type"],
        "model_profile": "lfm2.5-2.6b",
        "document_hash": "sha256:" + ident,
        "result": resultat,
        "validation": validation,
        "usage": None,
        "latency_ms": 4321,
        "dynamic_schema": SCHEMA,
        "routing": None,
        "response_format_style": "json_schema",
    }


def resultat(valeurs: dict, notes: list[str]) -> dict:
    out = {"document_type": SCHEMA["document_type"], "extraction_notes": notes}
    for champ in SCHEMA["fields"]:
        nom = champ["name"]
        if nom not in valeurs:
            out[nom] = None  # champ absent de la reponse : cas a couvrir aussi
            continue
        valeur, confiance = valeurs[nom]
        out[nom] = {"value": valeur, "evidence_ids": [], "confidence": confiance}
    return out


# --- 1) cas nominal : IBAN groupe par 4, BIC du meme pays ------------------
NOMINAL = resultat(
    {
        "account_holder": ("SUND INDUSTRY SYSTEM", 0.96),
        "iban": ("FR14 2004 1010 0505 0001 3M02 606", 0.98),
        "bic": ("BNPAFRPP", 0.97),
        "bank_name": ("BANQUE EXEMPLE PARIS OPERA", 0.9),
    },
    [],
)

# --- 2) cas limites : dernier chiffre de l'IBAN mal lu, BIC de 9 caracteres,
# banque absente de la reponse, validation negative ------------------------
EDGE = resultat(
    {
        "account_holder": ("SUND INDUSTRY SYSTEM", 0.7),
        "iban": ("FR14 2004 1010 0505 0001 3M02 607", 0.6),
        "bic": ("BNPAFRPPX", 0.5),
    },
    ["low confidence on iban"],
)

# --- 3) scan illisible : ni titulaire, ni IBAN, ni BIC ----------------------
UNREADABLE = resultat(
    {
        "account_holder": (None, 0.0),
        "iban": (None, 0.0),
        "bic": (None, 0.0),
        "bank_name": ("BANQUE", 0.2),
    },
    ["scan illisible, aucun champ identifiant extrait"],
)

SORTIES = {
    "rib_extraction_sample.json": enveloppe("0001", NOMINAL, {"valid": True, "errors": [], "warnings": []}),
    "rib_extraction_sample_edge_cases.json": enveloppe(
        "edge-0001", EDGE, {"valid": False, "errors": ["bank_name manquant"], "warnings": ["confiance faible"]}
    ),
    "rib_extraction_sample_unreadable.json": enveloppe(
        "unreadable-0001", UNREADABLE, {"valid": False, "errors": ["aucun champ identifiant"], "warnings": []}
    ),
}

if __name__ == "__main__":
    for nom, contenu in SORTIES.items():
        (ICI / nom).write_text(json.dumps(contenu, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("ecrit", nom)
