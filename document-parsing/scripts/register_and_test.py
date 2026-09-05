#!/usr/bin/env python3
"""register_and_test.py -- register the 3 document-parsing schemas against a
running DocIE Studio instance and run one real extraction end to end.

Usage:
  DOCIE_BASE_URL=http://localhost:8080 DOCIE_API_KEY=<key-or-empty> \
      DOCIE_MODEL_PROFILE=<a configs/models.yaml profile> \
      python register_and_test.py

Requires: requests (pip install requests)

Actually run once (2026-09-04, local: postgres+redis-free native api/worker,
self-hosted Inngest dev server, NuExtract3 via a local Ollama instance as the
OPENAI_COMPAT_* backend -- see configs/models.yaml's nuextract3_ollama
profile added for this test) against small-doc-ie-bench @ 6e30bc6. Findings
that surprised me, in case anyone else integrates against this API:

- POST /v1/studio/schemas/dynamic is the real path -- NOT /schemas/dynamic.
- Field names are validated ^[a-z][a-z0-9_]{0,63}$ -- camelCase is REJECTED
  (422 string_pattern_mismatch). This breaks the "drop DocIE's output
  straight into contrats/lib/fields.js's `values` with zero renaming" plan
  from document-parsing/schemas/contract.md -- that file's camelCase keys
  (numeroContrat, stNom, ...) do not register as-is. A snake_case schema +
  a rename step is required; see the "contract" entry in SCHEMAS below for
  the actual mapping used.
- POST /v1/studio/extract needs `dynamic_schema_name`, NOT `schema_name` --
  `schema_name` only resolves the small built-in SCHEMA_REGISTRY
  (identity_card/invoice as of this commit) and is silently accepted by the
  request model, so sending a custom schema name there doesn't 4xx at
  trigger time -- it fails the run ~5 minutes later with "Unknown
  schema_name", after real inference time has already been spent.
- GET /v1/studio/runs/{event_id} (proxies Inngest's own run-status API) only
  ever returns Inngest bookkeeping (status/timestamps) for a *successful*
  extraction -- confirmed by running one for real end to end, not just
  reading the route. It does NOT carry the actual extracted JSON. The
  extraction result is published only over the realtime pub/sub channel
  (TOPIC_RESULT, see docie_bench/inngest/functions.py's extract_document),
  which this script does not consume (would need an Inngest-realtime or
  websocket client, not a plain HTTP poll). So "poll this endpoint with
  zero Inngest client" proves the run succeeded or failed, but NOT what was
  extracted -- getting the payload needs either the realtime channel or
  some other retrieval path not yet identified. Flag this explicitly to
  whoever designs the actual document-parsing router: it cannot be a bare
  HTTP polling loop if it needs the extracted content, only if "did it
  succeed" is enough.
- Real inference latency for the full ~34-node resume schema against
  NuExtract3 (Q4_K_M, CPU, via Ollama) was several minutes, not seconds --
  budget for that in any router design (this is likely the schema's
  evidence-grounding + per-field confidence passes, not just one model
  call; not confirmed precisely).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

SCHEMAS_DIR = Path(__file__).parent.parent / "schemas"

# Extracted from the payload blocks already checked into resume.md /
# contract.md / kbis.md -- kept here as plain dicts so this script has no
# markdown-parsing dependency. If a schema file's payload changes, update
# both places (or delete this duplication once there's a real serializer).
SCHEMAS = {
    "resume": {
        "document_type": "resume",
        "fields": [
            {"name": "name", "type": "string", "description": None, "fields": []},
            {"name": "title", "type": "string", "description": None, "fields": []},
            {"name": "years_experience", "type": "number", "description": None, "fields": []},
            {"name": "contact", "type": "object", "description": None, "fields": [
                {"name": "email", "type": "string", "description": None, "fields": []},
                {"name": "phone", "type": "string", "description": None, "fields": []},
                {"name": "linkedin", "type": "string", "description": None, "fields": []},
                {"name": "github", "type": "string", "description": None, "fields": []},
                {"name": "location", "type": "string", "description": None, "fields": []},
            ]},
            {"name": "experience", "type": "list", "description": None, "fields": [
                {"name": "company", "type": "string", "description": None, "fields": []},
                {"name": "title", "type": "string", "description": None, "fields": []},
                {"name": "start_date", "type": "date", "description": None, "fields": []},
                {"name": "end_date", "type": "date", "description": None, "fields": []},
                {"name": "location", "type": "string", "description": None, "fields": []},
                {"name": "description", "type": "string", "description": None, "fields": []},
                {"name": "env_technique", "type": "string",
                 "description": "Stack technique / environnement technologique de la mission",
                 "fields": []},
            ]},
            {"name": "education", "type": "list", "description": None, "fields": [
                {"name": "degree", "type": "string", "description": None, "fields": []},
                {"name": "institution", "type": "string", "description": None, "fields": []},
                {"name": "year", "type": "string", "description": None, "fields": []},
            ]},
            {"name": "skills", "type": "list", "description": None, "fields": [
                {"name": "category", "type": "string", "description": None, "fields": []},
                {"name": "items", "type": "list", "description": None, "fields": [
                    {"name": "item", "type": "string", "description": None, "fields": []},
                ]},
            ]},
            {"name": "languages", "type": "list", "description": None, "fields": [
                {"name": "language", "type": "string", "description": None, "fields": []},
                {"name": "level", "type": "string", "description": None, "fields": []},
            ]},
            {"name": "certifications", "type": "list", "description": None, "fields": [
                {"name": "name", "type": "string", "description": None, "fields": []},
                {"name": "issuer", "type": "string", "description": None, "fields": []},
                {"name": "year", "type": "string", "description": None, "fields": []},
            ]},
            {"name": "interests", "type": "list", "description": None, "fields": [
                {"name": "interest", "type": "string", "description": None, "fields": []},
            ]},
        ],
    },
    "kbis": {
        "document_type": "kbis",
        "fields": [
            {"name": "company_name", "type": "string", "description": None, "fields": []},
            {"name": "siren", "type": "string", "description": None, "fields": []},
            {"name": "siret_siege", "type": "string", "description": None, "fields": []},
            {"name": "legal_form", "type": "string", "description": None, "fields": []},
            {"name": "share_capital", "type": "money", "description": None, "fields": []},
            {"name": "registration_date", "type": "date", "description": None, "fields": []},
            {"name": "issued_date", "type": "date",
             "description": "Date d'edition/delivrance du Kbis", "fields": []},
            {"name": "rcs_number", "type": "string", "description": None, "fields": []},
            {"name": "registered_address", "type": "string", "description": None, "fields": []},
            {"name": "activity_code", "type": "string", "description": None, "fields": []},
            {"name": "legal_representative", "type": "string", "description": None, "fields": []},
        ],
    },
    # NOTE (found running this script for real, first attempt failed with
    # HTTP 422 string_pattern_mismatch): DocIE's dynamic-schema field names
    # must match ^[a-z][a-z0-9_]{0,63}$ -- camelCase is rejected outright.
    # contrats/lib/fields.js uses camelCase keys (numeroContrat, stNom, ...)
    # for its form `values`, so "DocIE output drops straight into values
    # with zero renaming" does NOT hold as originally hoped in
    # document-parsing/schemas/contract.md -- a snake_case-to-camelCase
    # rename step is required wherever this gets consumed. Mapping (DocIE
    # snake_case -> contrats/lib/fields.js camelCase):
    #   numero_contrat -> numeroContrat       date_redaction -> dateRedaction
    #   lieu_redaction -> lieuRedaction       st_nom -> stNom
    #   st_adresse -> stAdresse               st_siren -> stSiren
    #   st_siret -> stSiret                   st_representant -> stRepresentant
    #   st_forme_juridique -> stFormeJuridique st_qualite -> stQualite
    #   consultant_nom -> consultantNom       consultant_fonction -> consultantFonction
    #   client_final -> clientFinal           nature_travaux -> natureTravaux
    #   lieu_execution -> lieuExecution       date_debut -> dateDebut
    #   date_fin -> dateFin                   delai_paiement -> delaiPaiement
    "contract": {
        "document_type": "contract",
        "fields": [
            {"name": "numero_contrat", "type": "string", "description": None, "fields": []},
            {"name": "date_redaction", "type": "date", "description": None, "fields": []},
            {"name": "lieu_redaction", "type": "string", "description": None, "fields": []},
            {"name": "st_nom", "type": "string", "description": None, "fields": []},
            {"name": "st_adresse", "type": "string", "description": None, "fields": []},
            {"name": "st_siren", "type": "string", "description": None, "fields": []},
            {"name": "st_siret", "type": "string", "description": None, "fields": []},
            {"name": "st_representant", "type": "string", "description": None, "fields": []},
            {"name": "st_forme_juridique", "type": "string", "description": None, "fields": []},
            {"name": "st_qualite", "type": "string", "description": None, "fields": []},
            {"name": "consultant_nom", "type": "string", "description": None, "fields": []},
            {"name": "consultant_fonction", "type": "string", "description": None, "fields": []},
            {"name": "client_final", "type": "string", "description": None, "fields": []},
            {"name": "nature_travaux", "type": "string", "description": None, "fields": []},
            {"name": "lieu_execution", "type": "string", "description": None, "fields": []},
            {"name": "date_debut", "type": "date", "description": None, "fields": []},
            {"name": "date_fin", "type": "date", "description": None, "fields": []},
            {"name": "tjm", "type": "money", "description": "TJM en euros HT / jour", "fields": []},
            {"name": "delai_paiement", "type": "number",
             "description": "Delai de paiement en jours", "fields": []},
        ],
    },
}

SAMPLE_CV_TEXT = """\
Alice Dupont
Développeuse Python Senior

Contact : alice.dupont@example.com / 06 12 34 56 78
Localisation : Paris, France

EXPERIENCE

Développeuse Full Stack -- Société Generale (Paris)
Janvier 2022 - Present
Développement d'une plateforme de reporting réglementaire. Migration d'un
monolithe Django vers des microservices FastAPI. Environnement technique :
Python, FastAPI, PostgreSQL, Docker, Kubernetes, React.

Ingénieure logiciel -- Capgemini (La Défense)
Mars 2019 - Décembre 2021
Développement backend pour un client bancaire. Environnement technique :
Python, Flask, MySQL, Airflow, AWS.

FORMATION

Master Informatique -- Université Paris-Saclay, 2018

COMPETENCES
Langages : Python, SQL, JavaScript
Cloud : AWS, Docker, Kubernetes

LANGUES
Français : natif
Anglais : courant
"""


def _headers(api_key: str) -> dict:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["X-API-Key"] = api_key
    return h


def register_schema(base_url: str, api_key: str, name: str) -> None:
    payload = SCHEMAS[name]
    resp = requests.post(f"{base_url}/v1/studio/schemas/dynamic", json=payload, headers=_headers(api_key), timeout=30)
    if resp.status_code in (200, 201):
        print(f"[schema:{name}] registered ({resp.status_code}).")
    elif resp.status_code == 409 or "already exists" in resp.text.lower():
        print(f"[schema:{name}] already exists, skipping ({resp.status_code}).")
    else:
        print(f"[schema:{name}] UNEXPECTED {resp.status_code}: {resp.text[:500]}")
        resp.raise_for_status()


def run_extraction(base_url: str, api_key: str, schema_name: str, text: str, timeout_s: int = 480,
                    model_profile: str | None = None) -> dict:
    # dynamic_schema_name, NOT schema_name -- schema_name only resolves the
    # built-in SCHEMA_REGISTRY (identity_card/invoice as of this commit), a
    # completely separate lookup from the schemas registered via
    # POST /schemas/dynamic. Sending schema_name for a custom schema fails
    # the run with "Unknown schema_name" even though registration succeeded
    # -- found running this for real, not documented anywhere obvious.
    body = {"text": text, "dynamic_schema_name": schema_name}
    if model_profile:
        body["model_profile"] = model_profile
    resp = requests.post(
        f"{base_url}/v1/studio/extract",
        json=body,
        headers=_headers(api_key),
        timeout=30,
    )
    resp.raise_for_status()
    trigger = resp.json()
    print(f"[extract] triggered: {trigger}")
    event_ids = trigger.get("event_ids") or trigger.get("ids") or []
    if not event_ids:
        raise RuntimeError(f"No event_ids in trigger response: {trigger}")
    event_id = event_ids[0]

    # GET /v1/studio/runs/{event_id} proxies Inngest's /v1/events/{id}/runs,
    # which wraps the run(s) in a "data" LIST (not a bare top-level status --
    # found running this for real). CONFIRMED by running a real successful
    # extraction end to end: this endpoint returns ONLY Inngest's run
    # bookkeeping (status/timestamps), never the extracted JSON, even once
    # status="Completed". The actual result is published exclusively on the
    # realtime pub/sub channel (TOPIC_RESULT) -- this function proves
    # success/failure, not what was extracted. See module docstring.
    deadline = time.time() + timeout_s
    last_status = None
    while time.time() < deadline:
        r = requests.get(f"{base_url}/v1/studio/runs/{event_id}", headers=_headers(api_key), timeout=30)
        r.raise_for_status()
        payload = r.json()
        rows = payload.get("data") or []
        run = rows[0] if rows else {}
        status = run.get("status")
        if status != last_status:
            print(f"[extract] poll status={status}")
            last_status = status
        if status and status.lower() in ("completed", "success", "succeeded", "failed", "cancelled", "error"):
            return run
        time.sleep(3)
    raise TimeoutError(f"Extraction did not complete within {timeout_s}s (event_id={event_id})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", choices=["resume"], default="resume",
                     help="Which sample document to extract (only resume has a bundled sample text).")
    ap.add_argument("--schemas-only", action="store_true", help="Register schemas, skip the extraction call.")
    args = ap.parse_args()

    base_url = os.environ.get("DOCIE_BASE_URL", "http://localhost:8080").rstrip("/")
    api_key = os.environ.get("DOCIE_API_KEY", "")

    print(f"DocIE base URL: {base_url}")
    for name in ("resume", "kbis", "contract"):
        register_schema(base_url, api_key, name)

    if args.schemas_only:
        return 0

    model_profile = os.environ.get("DOCIE_MODEL_PROFILE")
    result = run_extraction(base_url, api_key, "resume", SAMPLE_CV_TEXT, model_profile=model_profile)
    print("\n=== FINAL RESULT ===")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
