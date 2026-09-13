#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_urssaf_sample.py -- PROVENANCE ONLY, pas execute par les tests.

Documente comment urssaf_extraction_sample.json,
urssaf_extraction_sample_edge_cases.json et
urssaf_extraction_sample_unreadable.json ont ete produits, et permet de les
regenerer si document-parsing/schemas/urssaf.schema.json change.

DIFFERENCE DE PROVENANCE ASSUMEE avec generate_kbis_sample.py -- a lire avant
de faire confiance a ces fixtures. Celui-la importait les VRAIS modeles
pydantic de DocIE depuis un checkout local de small-doc-ie-bench, donc sa
structure d'encapsulation etait celle d'un vrai serveur. Ce checkout n'est pas
disponible ici, et aucun appel DocIE n'est permis a un agent ADBI. Ce script ne
peut donc pas importer les modeles ; il RECOPIE la structure d'enveloppe telle
qu'elle est deja etablie dans le depot par deux sources independantes :

  1. document-parsing/mappings/fixtures/kbis_extraction_sample.json, genere
     depuis les vrais modeles pydantic (voir generate_kbis_sample.py) -- d'ou
     viennent l'ordre et la presence des cles de l'enveloppe (request_id,
     schema_name, model_profile, document_hash, result, validation, usage,
     latency_ms, dynamic_schema, routing, response_format_style), ainsi que
     l'encapsulation par type : string/date/number -> {"value", "evidence_ids",
     "confidence"}, money -> {"amount", "currency", "evidence_ids",
     "confidence"} ;
  2. document-parsing/bridge/tests/contract_text.json, trime d'une REPONSE
     REELLE de POST /v1/extract/text -- qui confirme que cette meme
     encapsulation par feuille survit a la voie texte, et qu'un champ non
     trouve revient en valeur vide a confiance 0 plutot qu'en cle absente.

Autrement dit : la STRUCTURE est reprise de sources mesurees, seules les
VALEURS sont fabriquees. Aucune attestation de vigilance URSSAF reelle n'a ete
lue pour les ecrire -- c'est la reserve a garder en tete, et c'est pourquoi
aucune logique du mapping ne depend d'autre chose que de la presence ou de
l'absence d'un champ.

Usage :  python generate_urssaf_sample.py     (reecrit les 3 fixtures)
"""

from __future__ import annotations

import json
from pathlib import Path

ICI = Path(__file__).resolve().parent
SCHEMA = json.loads((ICI.parents[1] / "schemas" / "urssaf.schema.json").read_text(encoding="utf-8"))


def feuille(champ: dict, valeur, confiance: float) -> dict:
    """Encapsulation DocIE d'une feuille, par type -- voir docstring."""
    if champ["type"] == "money":
        montant, devise = valeur if valeur is not None else (None, None)
        return {"amount": montant, "currency": devise, "evidence_ids": [], "confidence": confiance}
    return {"value": valeur, "evidence_ids": [], "confidence": confiance}


def enveloppe(suffixe: str, resultat: dict, validation: dict) -> dict:
    ident = "req-fixture-urssaf-" + suffixe
    return {
        "request_id": ident,
        "schema_name": SCHEMA["document_type"],
        "model_profile": "nuextract3_ollama",
        "document_hash": "sha256:" + ident,
        "result": resultat,
        "validation": validation,
        "usage": None,
        "latency_ms": 54321,
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
        out[nom] = feuille(champ, valeur, confiance)
    return out


# --- 1) cas nominal : tout se lit, tout est bien forme -----------------------
NOMINAL = resultat(
    {
        "company_name": ("SUND INDUSTRY SYSTEM", 0.97),
        "siren": ("941091316", 0.99),
        "siret": ("94109131600013", 0.99),
        "registered_address": ("12 rue de la Paix, 75002 Paris", 0.9),
        "issued_date": ("2026-03-04", 0.95),
        "valid_until": ("04/09/2026", 0.9),
        "security_code": ("A1B2C3D4E5", 0.93),
        "urssaf_agency": ("URSSAF Ile-de-France", 0.9),
        "employee_count": ("12", 0.88),
        "declared_payroll": (("480000.00", "EUR"), 0.85),
    },
    [],
)

# --- 2) cas limites : chaque degradation que le mapping doit nommer ----------
# issued_date en JJ/MM/AAAA (voie francaise), valid_until impossible au
# calendrier (30 fevrier), employee_count non numerique, montant en devise
# etrangere, SIRET absent de la reponse, validation negative.
EDGE = resultat(
    {
        "company_name": ("SUND INDUSTRY SYSTEM", 0.7),
        "siren": ("941091316", 0.7),
        "registered_address": (None, 0.0),
        "issued_date": ("31/08/2026", 0.6),
        "valid_until": ("30/02/2027", 0.4),
        "security_code": ("   ", 0.2),
        "urssaf_agency": ("URSSAF Provence-Alpes-Cote d'Azur", 0.8),
        "employee_count": ("douze", 0.3),
        "declared_payroll": (("480000", "CHF"), 0.5),
    },
    ["low confidence on valid_until"],
)

# --- 3) scan illisible : DocIE n'a lu aucun champ identifiant ----------------
UNREADABLE = resultat(
    {
        "company_name": (None, 0.0),
        "siren": (None, 0.0),
        "siret": (None, 0.0),
        "issued_date": (None, 0.0),
        "urssaf_agency": ("URSSAF", 0.2),
    },
    ["scan illisible, aucun champ identifiant extrait"],
)

SORTIES = {
    "urssaf_extraction_sample.json": enveloppe("0001", NOMINAL, {"valid": True, "errors": [], "warnings": []}),
    "urssaf_extraction_sample_edge_cases.json": enveloppe(
        "edge-0001", EDGE, {"valid": False, "errors": ["valid_until incoherente"], "warnings": ["confiance faible"]}
    ),
    "urssaf_extraction_sample_unreadable.json": enveloppe(
        "unreadable-0001", UNREADABLE, {"valid": False, "errors": ["aucun champ identifiant"], "warnings": []}
    ),
}

if __name__ == "__main__":
    for nom, contenu in SORTIES.items():
        (ICI / nom).write_text(json.dumps(contenu, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("ecrit", nom)
