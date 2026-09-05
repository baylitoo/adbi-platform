#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_sample.py -- PROVENANCE ONLY, pas execute par les tests.

Documente comment contract_extraction_sample.json et
contract_extraction_sample_edge_cases.json ont ete produits, et permet de
les regenerer si le schema DocIE "contract" change.

Pourquoi pas une vraie extraction live captee : au moment ou ce module est
ecrit, aucune instance DocIE Studio n'est joignable dans cet environnement
(seuls Ollama et un serveur Inngest dev tournent), et la precedente
verification live (PR #46, document-parsing/scripts/register_and_test.py,
"small-doc-ie-bench @ 6e30bc6") n'a JAMAIS recupere le JSON extrait pour le
schema "contract" -- elle a seulement enregistre les 3 schemas et lance une
extraction sur le schema "resume", et meme pour celle-la la reponse reelle
n'a pas pu etre lue en HTTP simple (voir le docstring de register_and_test.py :
GET /v1/studio/runs/{event_id} ne renvoyait alors que le suivi Inngest, pas
le JSON extrait). Il n'existe donc AUCUN JSON reel de "contract" a
reproduire tel quel.

A la place : ce script importe les VRAIS modeles pydantic de DocIE
(docie_bench.schemas.dynamic.DynamicTemplateBuilder,
docie_bench.schemas.common.*) depuis un checkout local de small-doc-ie-bench,
construit le meme modele dynamique que le serveur construirait pour le
schema "contract" de register_and_test.py, l'instancie avec des valeurs
plausibles, puis appelle `.model_dump(mode="json")` -- exactement l'appel
que docie_bench/inngest/functions.py::_run_extraction fait sur la vraie
ExtractionResponse avant de la publier (TOPIC_RESULT) / la stocker
(ExtractionRunResult.output_json). Le JSON obtenu a donc la forme EXACTE
que produirait un serveur DocIE reel pour ce schema -- seules les valeurs
de champs sont fabriquees, pas la structure d'encapsulation.

Verifie en executant ce generateur (2026-09) : Decimal (NumberField.value,
MoneyField.amount) serialise en STRING par pydantic v2 mode="json" (ex:
"450", pas 450) -- contract_to_contrats.py s'appuie sur ce fait.

Checkout source utilise : C:\\Users\\ougue\\Documents\\ADBI_WORK\\
small-doc-ie-bench (branche locale non committee
"fix/extraction-result-durable-store", HEAD de branche a 6e30bc6 -- le MEME
commit que celui teste par register_and_test.py ; les modifications
non committees de ce checkout portent sur la durabilite de
GET /v1/studio/runs/{id}, PAS sur docie_bench/schemas/ utilise ici, qui est
inchange par rapport a 6e30bc6). Pas une dependance de ce depot : ce script
ne tourne pas en CI, il sert seulement a regenerer les fixtures a la main si
besoin. `python-side` : necessite pydantic + sqlalchemy installes dans
l'environnement du checkout DocIE (pas dans celui d'ADBI platform).

Usage (depuis un poste ayant le checkout DocIE a jour) :
    python generate_sample.py /path/to/small-doc-ie-bench/src
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CONTRACT_SPEC = {
    # Doit rester identique a SCHEMAS["contract"] dans
    # document-parsing/scripts/register_and_test.py (PR #46) -- c'est le
    # schema reellement enregistre cote DocIE.
    "document_type": "contract",
    "fields": [
        {"name": "numero_contrat", "type": "string"},
        {"name": "date_redaction", "type": "date"},
        {"name": "lieu_redaction", "type": "string"},
        {"name": "st_nom", "type": "string"},
        {"name": "st_adresse", "type": "string"},
        {"name": "st_siren", "type": "string"},
        {"name": "st_siret", "type": "string"},
        {"name": "st_representant", "type": "string"},
        {"name": "st_forme_juridique", "type": "string"},
        {"name": "st_qualite", "type": "string"},
        {"name": "consultant_nom", "type": "string"},
        {"name": "consultant_fonction", "type": "string"},
        {"name": "client_final", "type": "string"},
        {"name": "nature_travaux", "type": "string"},
        {"name": "lieu_execution", "type": "string"},
        {"name": "date_debut", "type": "date"},
        {"name": "date_fin", "type": "date"},
        {"name": "tjm", "type": "money", "description": "TJM en euros HT / jour"},
        {"name": "delai_paiement", "type": "number", "description": "Delai de paiement en jours"},
    ],
}

HAPPY_PATH_VALUES = {
    "numero_contrat": {"value": "01-06-2026", "evidence_ids": ["e1"], "confidence": 0.94},
    "date_redaction": {"value": "2026-01-05", "evidence_ids": ["e2"], "confidence": 0.9},
    "lieu_redaction": {"value": "Paris", "evidence_ids": [], "confidence": 0.7},
    "st_nom": {"value": "SUND INDUSTRY SYSTEM", "evidence_ids": ["e3"], "confidence": 0.97},
    "st_adresse": {"value": "60 rue Francois 1er, 75008 Paris", "evidence_ids": [], "confidence": 0.85},
    "st_siren": {"value": "941091316", "evidence_ids": [], "confidence": 0.99},
    "st_siret": {"value": "94109131600013", "evidence_ids": [], "confidence": 0.99},
    "st_representant": {"value": "Monsieur Corentin CALVO", "evidence_ids": [], "confidence": 0.88},
    "st_forme_juridique": {"value": "SAS au capital de 1 000 EUR", "evidence_ids": [], "confidence": 0.6},
    "st_qualite": {"value": "President", "evidence_ids": [], "confidence": 0.8},
    "consultant_nom": {"value": "Corentin Calvo", "evidence_ids": [], "confidence": 0.91},
    "consultant_fonction": {"value": "Developpeur Full Stack", "evidence_ids": [], "confidence": 0.75},
    "client_final": {"value": "Groupe Accor", "evidence_ids": [], "confidence": 0.93},
    "nature_travaux": {
        "value": "Developpement full stack de la plateforme de reservation",
        "evidence_ids": [], "confidence": 0.7,
    },
    "lieu_execution": {
        "value": "82 rue Henry Farman, 92130 Issy-les-Moulineaux",
        "evidence_ids": [], "confidence": 0.65,
    },
    # DD/MM/YYYY delibere : DateField ne garantit que "ISO quand possible"
    # (docie_bench/schemas/common.py) -- ce champ exerce la conversion.
    "date_debut": {"value": "01/02/2026", "evidence_ids": [], "confidence": 0.8},
    "date_fin": {"value": "2026-12-31", "evidence_ids": [], "confidence": 0.8},
    "tjm": {"amount": "450", "currency": "EUR", "evidence_ids": [], "confidence": 0.9},
    "delai_paiement": {"value": "45", "evidence_ids": [], "confidence": 0.5},
}

EDGE_CASE_VALUES = {
    # numero_contrat vu mais vide -> doit produire une erreur bloquante cote mapping.
    "numero_contrat": {"value": None, "evidence_ids": [], "confidence": 0.0},
    # Date en texte libre, non parseable -> doit etre videe + avertissement.
    "date_redaction": {"value": "le 5 courant", "evidence_ids": [], "confidence": 0.2},
    # Champs volontairement absents des kwargs plus bas (wrapper entier
    # absent/None cote DocIE) : lieu_redaction, st_adresse, st_siret,
    # consultant_fonction, nature_travaux, lieu_execution.
    "st_nom": {"value": "ACME FREELANCE", "evidence_ids": ["e9"], "confidence": 0.9},
    "st_siren": {"value": "123456789", "evidence_ids": [], "confidence": 0.9},
    "st_representant": {"value": "Jane DOE", "evidence_ids": [], "confidence": 0.8},
    "st_forme_juridique": {"value": "EI", "evidence_ids": [], "confidence": 0.5},
    "st_qualite": {"value": "", "evidence_ids": [], "confidence": 0.1},
    "consultant_nom": {"value": "Jane Doe", "evidence_ids": [], "confidence": 0.85},
    "client_final": {"value": "Client Test SAS", "evidence_ids": [], "confidence": 0.8},
    "date_debut": {"value": "2026-03-01", "evidence_ids": [], "confidence": 0.7},
    "date_fin": {"value": "31/08/2026", "evidence_ids": [], "confidence": 0.7},
    # Devise non-EUR -> doit etre reportee avec avertissement, pas convertie.
    "tjm": {"amount": "500", "currency": "USD", "evidence_ids": [], "confidence": 0.6},
    # Decimal non entier serialise en str -> doit se normaliser en "30".
    "delai_paiement": {"value": "30.0", "evidence_ids": [], "confidence": 0.4},
}


def _build_envelope(docie_src: Path, values: dict, request_id: str, notes: list[str]) -> dict:
    sys.path.insert(0, str(docie_src))
    from docie_bench.schemas.common import ExtractionResponse, ExtractionValidation
    from docie_bench.schemas.dynamic import DynamicSchemaSpec, DynamicTemplateBuilder

    spec = DynamicSchemaSpec(**CONTRACT_SPEC)
    model = DynamicTemplateBuilder.build_model(spec)
    instance = model(document_type="contract", extraction_notes=notes, **values)
    result = instance.model_dump(mode="json")
    resp = ExtractionResponse(
        request_id=request_id,
        schema_name="contract",
        model_profile="nuextract3_ollama",
        document_hash=f"sha256:{request_id}",
        result=result,
        validation=ExtractionValidation(valid=True, errors=[], warnings=[]),
        usage=None,
        latency_ms=123456,
        dynamic_schema=spec.model_dump(mode="json"),
        routing=None,
        response_format_style="json_schema",
    )
    return resp.model_dump(mode="json")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    docie_src = Path(sys.argv[1])
    out_dir = Path(__file__).parent

    happy = _build_envelope(
        docie_src, HAPPY_PATH_VALUES, "req-fixture-0001", ["low confidence on lieu_execution"]
    )
    (out_dir / "contract_extraction_sample.json").write_text(
        json.dumps(happy, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    edge = _build_envelope(
        docie_src,
        EDGE_CASE_VALUES,
        "req-fixture-edge-0001",
        ["numero_contrat absent du document source", "date_redaction ambigue, verifier manuellement"],
    )
    (out_dir / "contract_extraction_sample_edge_cases.json").write_text(
        json.dumps(edge, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print("Fixtures regenerees dans", out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
