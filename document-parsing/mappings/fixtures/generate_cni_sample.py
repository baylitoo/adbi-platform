#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_cni_sample.py -- PROVENANCE ONLY, pas execute par les tests.

Documente comment cni_extraction_sample.json,
cni_extraction_sample_edge_cases.json et cni_extraction_sample_unreadable.json
ont ete produits, et permet de les regenerer si
document-parsing/schemas/cni.schema.json change.

Meme provenance, et meme reserve, que generate_rib_sample.py et
generate_urssaf_sample.py (a lire) : la STRUCTURE de l'enveloppe et
l'encapsulation par feuille sont reprises de sources mesurees du depot
(kbis_extraction_sample.json, genere depuis les vrais modeles pydantic DocIE ;
document-parsing/bridge/tests/contract_text.json, trime d'une vraie reponse).
Seules les VALEURS sont fabriquees.

AUCUNE CARTE D'IDENTITE REELLE N'A ETE LUE, et aucun numero de titre reel
n'apparait ici -- c'est la reserve la plus importante de ce fichier : une piece
d'identite est la donnee la plus sensible de la checklist. Le titulaire
(« SPECIMEN / JEAN PAUL ») est invente, et les deux lignes de MRZ sont
construites caractere par caractere autour du numero fabrique « SPECIMEN1 »,
avec leurs quatre chiffres de controle CALCULES par la regle de
document-parsing/fixtures/mrz.json (voir `_specimens` la-bas).

`model_profile` vaut "nuextract3" : c'est le modele que
document-parsing/models/catalogue.json declare pour la tache "cni" (cle `taches`, voie
`agent`, « Vision. »), et non le profil texte des fixtures RIB et URSSAF.

Usage :  python generate_cni_sample.py     (reecrit les 3 fixtures)
"""

from __future__ import annotations

import json
from pathlib import Path

ICI = Path(__file__).resolve().parent
SCHEMA = json.loads((ICI.parents[1] / "schemas" / "cni.schema.json").read_text(encoding="utf-8"))

# Specimen TD1, construit a la main : code « ID », Etat « FRA », numero
# fabrique, remplissage « < ». Les chiffres de controle (3, 4, 4 et le
# composite 6) sont ceux que calcule document-parsing/mappings/mrz.py, et le
# jeu d'essai partage les reprend cas par cas.
MRZ_LIGNE1 = "IDFRASPECIMEN13<<<<<<<<<<<<<<<"
MRZ_LIGNE2 = "8001014M3501014FRA<<<<<<<<<<<6"
# Meme ligne 1 avec le N du numero lu M : le chiffre du numero ET le composite
# la refusent (cas correspondant de document-parsing/fixtures/mrz.json).
MRZ_LIGNE1_MAL_LUE = "IDFRASPECIMEM13<<<<<<<<<<<<<<<"


def feuille(valeur, confiance: float) -> dict:
    """Encapsulation DocIE d'une feuille scalaire -- voir docstring."""
    return {"value": valeur, "evidence_ids": [], "confidence": confiance}


def enveloppe(suffixe: str, resultat: dict, validation: dict) -> dict:
    ident = "req-fixture-cni-" + suffixe
    return {
        "request_id": ident,
        "schema_name": SCHEMA["document_type"],
        "model_profile": "nuextract3",
        "document_hash": "sha256:" + ident,
        "result": resultat,
        "validation": validation,
        "usage": None,
        "latency_ms": 9876,
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


# --- 1) cas nominal : tout se lit, les quatre chiffres de la MRZ sont justes --
NOMINAL = resultat(
    {
        "surname": ("SPECIMEN", 0.97),
        "given_names": ("JEAN PAUL", 0.95),
        "document_number": ("SPECIMEN1", 0.93),
        "nationality": ("FRA", 0.99),
        "birth_date": ("1980-01-01", 0.96),
        "sex": ("M", 0.99),
        "issue_date": ("2025-01-02", 0.94),
        # Forme francaise : la voie JJ/MM/AAAA du normaliseur partage doit la
        # convertir (date_docie.json).
        "expiry_date": ("01/01/2035", 0.94),
        "mrz_line1": (MRZ_LIGNE1, 0.98),
        "mrz_line2": (MRZ_LIGNE2, 0.98),
    },
    [],
)

# --- 2) cas limites : chaque degradation que le mapping doit nommer ----------
# Numero de la MRZ mal lu (chiffre du numero ET composite refuses), date
# d'expiration hors calendrier, date de delivrance ecrite en toutes lettres,
# numero en clair absent de la reponse, sexe a null, nationalite reduite a des
# espaces, validation negative.
EDGE = resultat(
    {
        "surname": ("SPECIMEN", 0.6),
        "given_names": ("JEAN PAUL", 0.6),
        "nationality": ("   ", 0.2),
        "birth_date": ("1980-01-01", 0.5),
        "sex": (None, 0.0),
        "issue_date": ("le 2 janvier 2025", 0.5),
        "expiry_date": ("30/02/2035", 0.4),
        "mrz_line1": (MRZ_LIGNE1_MAL_LUE, 0.5),
        "mrz_line2": (MRZ_LIGNE2, 0.5),
    },
    ["low confidence on mrz_line1"],
)

# --- 3) scan illisible : ni nom, ni numero, ni MRZ ---------------------------
UNREADABLE = resultat(
    {
        "surname": (None, 0.0),
        "given_names": (None, 0.0),
        "document_number": (None, 0.0),
        "mrz_line1": (None, 0.0),
        "mrz_line2": (None, 0.0),
        # Un champ isole bel et bien lu : il ne doit pas etre jete.
        "nationality": ("FRA", 0.2),
    },
    ["scan illisible, aucun champ identifiant extrait"],
)

SORTIES = {
    "cni_extraction_sample.json": enveloppe("0001", NOMINAL, {"valid": True, "errors": [], "warnings": []}),
    "cni_extraction_sample_edge_cases.json": enveloppe(
        "edge-0001", EDGE, {"valid": False, "errors": ["mrz_line1 douteuse"], "warnings": ["confiance faible"]}
    ),
    "cni_extraction_sample_unreadable.json": enveloppe(
        "unreadable-0001", UNREADABLE, {"valid": False, "errors": ["aucun champ identifiant"], "warnings": []}
    ),
}

if __name__ == "__main__":
    for nom, contenu in SORTIES.items():
        (ICI / nom).write_text(json.dumps(contenu, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("ecrit", nom)
