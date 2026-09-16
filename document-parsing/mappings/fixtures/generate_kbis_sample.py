#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_kbis_sample.py -- PROVENANCE ONLY, pas execute par les tests.

Documente comment kbis_extraction_sample.json,
kbis_extraction_sample_edge_cases.json et
kbis_extraction_sample_unreadable.json ont ete produits, et permet de les
regenerer si le schema DocIE "kbis" change. Meme demarche que
mappings/fixtures/generate_sample.py (schema "contract", PR
document-parsing-contract-field-mapping) -- voir ce fichier pour le contexte
complet ; ce qui suit ne redit que ce qui differe pour "kbis".

Pourquoi pas une vraie extraction live captee : reverifie explicitement dans
CET environnement avant d'ecrire ce module (pas suppose par analogie avec
PR #46/#49) --
  - `curl -m 3 http://localhost:8080/...` (l'URL par defaut de
    register_and_test.py, $DOCIE_BASE_URL non definie) : connexion refusee
    (aucun service sur ce port) ;
  - tour des ports effectivement en ecoute (`Get-NetTCPConnection -State
    Listen`) : 11434 repond avec la forme JSON native d'Ollama
    (`GET /api/tags`) -- c'est Ollama, pas DocIE ; 8288/8289 repondent
    comme le dev-server Inngest documente par PR #46/#49 ; le seul autre
    service HTTP local (port 3000) sert du HTML Next.js (verifie sur
    `/v1/studio/schemas/dynamic` : 200 avec un doctype HTML, pas du JSON)
    -- ce n'est pas non plus DocIE Studio.
Aucune instance DocIE Studio n'est donc joignable dans cet environnement,
comme dans PR #46/#49, mais cette fois verifie a la main plutot que
suppose. document-parsing/scripts/register_and_test.py (branche
document-parsing-docie-live-test, PR #46) n'a de toute facon jamais lance
d'extraction "kbis" reelle -- seul le schema "resume" a ete extrait de bout
en bout ; "kbis" et "contract" n'ont ete qu'ENREGISTRES (POST
/v1/studio/schemas/dynamic), jamais executes. Il n'existe donc AUCUN JSON
reel de "kbis" a reproduire tel quel.

A la place : ce script importe les VRAIS modeles pydantic de DocIE
(docie_bench.schemas.dynamic.DynamicTemplateBuilder,
docie_bench.schemas.common.*) depuis un checkout local de small-doc-ie-bench,
construit le meme modele dynamique que le serveur construirait pour le
schema "kbis" -- LU dans document-parsing/schemas/kbis.schema.json, que
test_kbis_to_contrats.py tient egal a SCHEMAS["kbis"] de register_and_test.py
-- l'instancie avec des valeurs plausibles, puis appelle
`.model_dump(mode="json")` -- exactement l'appel que
docie_bench/inngest/functions.py::_run_extraction fait sur la vraie
ExtractionResponse. Le JSON obtenu a donc la forme EXACTE que produirait un
serveur DocIE reel pour ce schema -- seules les valeurs de champs sont
fabriquees, pas la structure d'encapsulation.

Checkout source utilise pour generer les fixtures committees (2026-09-05) :
un clone local de small-doc-ie-bench, branche "docs/server-integration-contract",
HEAD a dce1a5d. Le CHEMIN depend du poste et n'a pas sa place ici : il se passe
en argument (voir Usage plus bas).
Verifie explicitement : `git diff 6e30bc6 dce1a5d -- src/docie_bench/schemas/
common.py src/docie_bench/schemas/dynamic.py` ne renvoie AUCUNE difference
-- c'est le meme commit de reference que celui documente dans
document-parsing/scripts/register_and_test.py (PR #46) et dans
mappings/fixtures/generate_sample.py (schema "contract") pour ces deux
fichiers ; les fixtures "kbis" ci-dessous sont donc a la meme version de
schema que les fixtures "contract" deja committees. Pas une dependance de ce
depot : ce script ne tourne pas en CI, il sert seulement a regenerer les
fixtures a la main si besoin. Necessite pydantic + sqlalchemy installes dans
l'environnement du checkout DocIE (pas dans celui d'ADBI platform).

Usage (depuis un poste ayant le checkout DocIE a jour) :
    python generate_kbis_sample.py /path/to/small-doc-ie-bench/src
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ICI = Path(__file__).resolve().parent

# Le schema est LU, il n'est plus recopie ici.
#
# Il l'etait : une copie du schema enregistre, a resynchroniser A LA MAIN, dont
# la seule protection etait le commentaire « Doit rester identique a
# SCHEMAS["kbis"] » -- et qu'AUCUN test ne comparait a quoi que ce soit. Deux
# definitions qui derivent en silence, c'est la trappe #164. #248 vient d'en
# faire la demonstration : les descriptions ont du etre ajoutees ICI *et* dans
# le .schema.json *et* dans register_and_test.py, a la main, sans filet.
#
# `document-parsing/schemas/kbis.schema.json` est deja tenu egal a
# SCHEMAS["kbis"] par test_kbis_to_contrats.py::
# test_identique_au_schema_enregistre_et_a_la_fixture (qui l'egale AUSSI au
# `dynamic_schema` de la fixture nominale). Lire ce fichier raccroche donc ce
# generateur a une definition DEJA gardee deux fois, au lieu d'en entretenir
# une quatrieme. C'est la forme qu'ont deja generate_rib_sample.py,
# generate_cni_sample.py, generate_fiscale_sample.py et
# generate_urssaf_sample.py ; generate_sample.py (contract) l'a adoptee en
# #250. Ce fichier etait le dernier a recopier son schema.
#
# Verifie AVANT de retirer la copie : DynamicSchemaSpec(**ancien KBIS_SPEC) et
# DynamicSchemaSpec(**kbis.schema.json) se normalisent au meme modele
# (11 champs, 9 decrits, egaux champ par champ). La copie etait redondante,
# pas divergente -- ce correctif supprime un risque, il ne repare pas un ecart.
KBIS_SPEC = json.loads(
    (ICI.parents[1] / "schemas" / "kbis.schema.json").read_text(encoding="utf-8")
)

HAPPY_PATH_VALUES = {
    "company_name": {"value": "SUND INDUSTRY SYSTEM", "evidence_ids": ["e1"], "confidence": 0.97},
    "siren": {"value": "941091316", "evidence_ids": ["e2"], "confidence": 0.99},
    "siret_siege": {"value": "94109131600013", "evidence_ids": ["e2"], "confidence": 0.99},
    "legal_form": {"value": "SAS", "evidence_ids": [], "confidence": 0.9},
    "share_capital": {"amount": "1000", "currency": "EUR", "evidence_ids": [], "confidence": 0.85},
    "registration_date": {"value": "2019-03-12", "evidence_ids": [], "confidence": 0.8},
    # DD/MM/YYYY delibere : DateField ne garantit que "ISO quand possible"
    # (docie_bench/schemas/common.py) -- ce champ exerce la conversion, comme
    # date_debut dans la fixture "contract".
    "issued_date": {"value": "04/09/2026", "evidence_ids": ["e3"], "confidence": 0.92},
    "rcs_number": {"value": "941 091 316 RCS Paris", "evidence_ids": [], "confidence": 0.88},
    "registered_address": {"value": "60 rue Francois 1er, 75008 Paris", "evidence_ids": [], "confidence": 0.85},
    "activity_code": {"value": "6202A", "evidence_ids": [], "confidence": 0.7},
    "legal_representative": {"value": "Monsieur Corentin CALVO", "evidence_ids": [], "confidence": 0.88},
}

EDGE_CASE_VALUES = {
    # company_name vu mais vide -> nameMatches doit rester None sans
    # expected_name, et la comparaison doit echouer proprement avec un.
    "company_name": {"value": None, "evidence_ids": [], "confidence": 0.0},
    "siren": {"value": "123456789", "evidence_ids": [], "confidence": 0.9},
    # siret_siege, legal_form, registered_address, activity_code : wrapper
    # entier absent (None) cote DocIE -- doit se comporter comme une valeur
    # nulle -> "".
    "registration_date": {"value": "le 12 mars 2019", "evidence_ids": [], "confidence": 0.2},
    "issued_date": {"value": "2026-09-01", "evidence_ids": ["e9"], "confidence": 0.9},
    "rcs_number": {"value": "", "evidence_ids": [], "confidence": 0.1},
    # Devise non-EUR -> doit etre reportee avec avertissement, pas convertie
    # (meme politique que "tjm" dans la fixture "contract").
    "share_capital": {"amount": "5000.00", "currency": "USD", "evidence_ids": [], "confidence": 0.6},
    "legal_representative": {"value": "Madame Jane DOE, Presidente", "evidence_ids": [], "confidence": 0.75},
}

# Les 3 champs les plus identifiants (nom, SIREN, SIRET) tous absents -> doit
# faire basculer le mapping dans la branche "Document illisible" (memes cles
# de sortie que la branche courte de docanalyze.js::analyzeDocumentLocal).
UNREADABLE_VALUES = {
    "company_name": {"value": None, "evidence_ids": [], "confidence": 0.0},
    "siren": {"value": None, "evidence_ids": [], "confidence": 0.0},
    # siret_siege, legal_form, share_capital, registration_date, rcs_number,
    # registered_address, activity_code, legal_representative : wrapper
    # entier absent -- scan trop degrade pour que le modele extraie quoi
    # que ce soit d'exploitable.
    "issued_date": {"value": None, "evidence_ids": [], "confidence": 0.0},
}


def _build_envelope(docie_src: Path, values: dict, request_id: str, notes: list[str]) -> dict:
    sys.path.insert(0, str(docie_src))
    from docie_bench.schemas.common import ExtractionResponse, ExtractionValidation
    from docie_bench.schemas.dynamic import DynamicSchemaSpec, DynamicTemplateBuilder

    spec = DynamicSchemaSpec(**KBIS_SPEC)
    model = DynamicTemplateBuilder.build_model(spec)
    instance = model(document_type="kbis", extraction_notes=notes, **values)
    result = instance.model_dump(mode="json")
    resp = ExtractionResponse(
        request_id=request_id,
        schema_name="kbis",
        model_profile="nuextract3_ollama",
        document_hash=f"sha256:{request_id}",
        result=result,
        validation=ExtractionValidation(valid=True, errors=[], warnings=[]),
        usage=None,
        latency_ms=98765,
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
        docie_src, HAPPY_PATH_VALUES, "req-fixture-kbis-0001", ["low confidence on activity_code"]
    )
    (out_dir / "kbis_extraction_sample.json").write_text(
        json.dumps(happy, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    edge = _build_envelope(
        docie_src,
        EDGE_CASE_VALUES,
        "req-fixture-kbis-edge-0001",
        ["company_name illisible sur ce scan", "registration_date en toutes lettres, non normalisee"],
    )
    (out_dir / "kbis_extraction_sample_edge_cases.json").write_text(
        json.dumps(edge, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    unreadable = _build_envelope(
        docie_src, UNREADABLE_VALUES, "req-fixture-kbis-unreadable-0001",
        ["scan illisible, aucun champ identifiant extrait"],
    )
    (out_dir / "kbis_extraction_sample_unreadable.json").write_text(
        json.dumps(unreadable, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print("Fixtures kbis regenerees dans", out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
