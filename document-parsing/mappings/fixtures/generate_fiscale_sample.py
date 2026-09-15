#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_fiscale_sample.py -- PROVENANCE ONLY, pas execute par les tests.

Documente comment fiscale_extraction_sample.json,
fiscale_extraction_sample_edge_cases.json et
fiscale_extraction_sample_unreadable.json ont ete produits, et permet de les
regenerer si document-parsing/schemas/fiscale.schema.json change.

Meme provenance, et meme reserve, que generate_urssaf_sample.py (a lire) : la
STRUCTURE d'enveloppe est reprise de sources mesurees du depot
(kbis_extraction_sample.json, genere depuis les vrais modeles pydantic DocIE,
et document-parsing/bridge/tests/contract_text.json, trime d'une vraie reponse
de POST /v1/extract/text) ; seules les VALEURS sont fabriquees. Aucune
attestation de regularite fiscale reelle n'a ete lue pour les ecrire, et aucun
appel DocIE n'est permis a un agent ADBI.

Le schema fiscale ne porte aucun champ `money` : pas d'encapsulation
{amount, currency} ici, toutes les feuilles sont {value, evidence_ids,
confidence}.

Les dates sont choisies par rapport a la date du jour FIGEE des tests
(`aujourdhui` de document-parsing/fixtures/date_plausible.json, 2026-09-15) :
aucune fixture ne doit changer de verdict le jour ou l'horloge avance.

Usage :  python generate_fiscale_sample.py     (reecrit les 3 fixtures)
"""

from __future__ import annotations

import json
from pathlib import Path

ICI = Path(__file__).resolve().parent
SCHEMA = json.loads((ICI.parents[1] / "schemas" / "fiscale.schema.json").read_text(encoding="utf-8"))


def feuille(valeur, confiance: float) -> dict:
    """Encapsulation DocIE d'une feuille scalaire -- voir docstring."""
    return {"value": valeur, "evidence_ids": [], "confidence": confiance}


def enveloppe(suffixe: str, resultat: dict, validation: dict) -> dict:
    ident = "req-fixture-fiscale-" + suffixe
    return {
        "request_id": ident,
        "schema_name": SCHEMA["document_type"],
        "model_profile": "lfm25_2_6b",
        "document_hash": "sha256:" + ident,
        "result": resultat,
        "validation": validation,
        "usage": None,
        "latency_ms": 12345,
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
        out[nom] = feuille(valeur, confiance)
    return out


# --- 1) cas nominal : tout se lit, dates plausibles et dans l'ordre ----------
NOMINAL = resultat(
    {
        "company_name": ("SUND INDUSTRY SYSTEM", 0.97),
        "siren": ("941091316", 0.99),
        "siret": ("94109131600013", 0.99),
        "tax_office": ("SIE de Paris 2e", 0.9),
        "issued_date": ("2026-03-04", 0.95),
        "situation_date": ("28/02/2026", 0.9),
        "regularity_statement": ("L'entreprise est a jour de ses obligations fiscales declaratives et de paiement", 0.8),
    },
    [],
)

# --- 2) cas limites : chaque degradation que le mapping doit nommer ----------
# issued_date en JJ/MM/AAAA, situation_date POSTERIEURE a la delivrance (dates
# incoherentes), SIRET absent de la reponse, service a null, mention reduite a
# des espaces, validation negative.
EDGE = resultat(
    {
        "company_name": ("SUND INDUSTRY SYSTEM", 0.7),
        "siren": ("941091316", 0.7),
        "tax_office": (None, 0.0),
        "issued_date": ("31/08/2026", 0.6),
        "situation_date": ("2026-09-10", 0.4),
        "regularity_statement": ("   ", 0.2),
    },
    ["low confidence on situation_date"],
)

# --- 3) scan illisible : DocIE n'a lu aucun champ identifiant ----------------
UNREADABLE = resultat(
    {
        "company_name": (None, 0.0),
        "siren": (None, 0.0),
        "siret": (None, 0.0),
        "issued_date": (None, 0.0),
        "tax_office": ("SIE", 0.2),
    },
    ["scan illisible, aucun champ identifiant extrait"],
)

SORTIES = {
    "fiscale_extraction_sample.json": enveloppe("0001", NOMINAL, {"valid": True, "errors": [], "warnings": []}),
    "fiscale_extraction_sample_edge_cases.json": enveloppe(
        "edge-0001", EDGE, {"valid": False, "errors": ["situation_date incoherente"], "warnings": ["confiance faible"]}
    ),
    "fiscale_extraction_sample_unreadable.json": enveloppe(
        "unreadable-0001", UNREADABLE, {"valid": False, "errors": ["aucun champ identifiant"], "warnings": []}
    ),
}

if __name__ == "__main__":
    for nom, contenu in SORTIES.items():
        (ICI / nom).write_text(json.dumps(contenu, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("ecrit", nom)
