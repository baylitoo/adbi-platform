"""Réalisations d'une mission : une liste de phrases, lue aussi depuis l'ancienne chaîne « a · b » ou la liste du schéma."""
from __future__ import annotations

ANCIEN_SEPARATEUR = " · "
_MARQUES = " \t\r\n·•○◦▪▫‣∙●-–—→*"


def _phrase(valeur) -> str:
    if isinstance(valeur, dict):
        valeur = valeur.get("achievement") or valeur.get("item") or next(
            (v for v in valeur.values() if isinstance(v, str)), "")
    return " ".join(str(valeur or "").split()).strip(_MARQUES)


def realisations(exp: dict) -> list[str]:
    """Liste propre des réalisations : `realisations`, sinon `achievements` du schéma, sinon l'ancienne `description`."""
    for cle in ("realisations", "achievements"):
        valeur = exp.get(cle)
        if isinstance(valeur, list):
            return [p for p in (_phrase(v) for v in valeur) if p]
    return [p for p in (_phrase(v) for v in str(exp.get("description") or "").split(ANCIEN_SEPARATEUR)) if p]


def normaliser_experience(exp: dict) -> bool:
    """Ramène une mission à la forme stockée (`realisations` en liste, plus d'`achievements` ni de `description`) ; vrai si elle a changé."""
    avant = (exp.get("realisations"), "achievements" in exp, "description" in exp)
    exp["realisations"] = realisations(exp)
    exp.pop("achievements", None)
    exp.pop("description", None)
    return avant != (exp["realisations"], False, False)


def texte_realisations(exp: dict) -> str:
    """Les réalisations en un seul texte, pour la recherche et le rapprochement."""
    return " ".join(realisations(exp))
