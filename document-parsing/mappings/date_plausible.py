#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""date_plausible.py -- controle de plausibilite des dates lues par DocIE.
Portage JS : contrats/lib/date-plausible.js.

Pourquoi (#194, liste retenue) : pour l'attestation URSSAF et l'attestation
de regularite fiscale, l'alternative LFM2.5-350M n'est proposee « que derriere
nos controles de plausibilite de date ». Et #170 l'a note : un montant faux se
repere a l'oeil, une date fausse non -- une date de delivrance decalee
ressemble exactement a une date correcte. Ce module transforme les dates
invraisemblables en echec NOMME, lisible par machine, au lieu d'une valeur
qui passe pour une lecture precise.

Ce que ce module N'ECRIT PAS : ni normaliseur de date, ni fenetre d'annees.
La lecture de la date (ISO, JJ/MM/AAAA, toutes lettres) et la fenetre
ANNEE_MIN-ANNEE_MAX (1950-2100, document-parsing/fixtures/date_docie.json)
viennent de kbis_to_contrats.py, IMPORTEES : une date avant 1950 y est deja
refusee en « date impossible », distincte de « date non reconnue ». Une
seconde fenetre ici rouvrirait exactement les divergences de #179. Le seul
controle nouveau sur une date isolee est « dans le futur » ; le seul controle
nouveau entre deux dates est leur ordre.

Statuts d'une date (voir STATUTS), un consommateur n'utilisant une date que si
son statut vaut exactement "plausible" :
  - absent        : null, vide ou reduit a des espaces ;
  - non_reconnue  : texte lu mais aucune forme de date reconnue (illisible) ;
  - impossible    : date lue mais hors calendrier ou hors fenetre (avant 1950) ;
  - future        : date posterieure a `aujourdhui`, pour un champ qui ne peut
                    pas l'etre (date deja imprimee sur une piece delivree) ;
  - incoherente   : deux dates plausibles chacune, mais dans le mauvais ordre
                    (celle qui doit preceder suit l'autre) -- les DEUX prennent
                    ce statut, on ne sait pas laquelle est mal lue ;
  - plausible     : rien a signaler.

La date du jour est INJECTABLE (`aujourdhui`, texte AAAA-MM-JJ) : les tests la
figent, sinon un cas « futur » pourrirait avec le calendrier et l'egalite
entre langages dependrait de l'heure. Par defaut, date locale du jour. Les
comparaisons se font sur le texte ISO (ordre lexical = ordre chronologique),
jamais par un objet date du langage.

Regle PARTAGEE : document-parsing/fixtures/date_plausible.json, executee cas
par cas par les tests des deux langages, messages exacts compris. Ce fichier
n'est lu QUE par les tests : l'image Docker de contrats ne copie que des
fixtures nommees une a une.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Iterable

# Normaliseur et fenetre IMPORTES, jamais recopies (voir docstring). ANNEE_MIN /
# ANNEE_MAX ne servent qu'au texte du message « date impossible ».
from kbis_to_contrats import ANNEE_MAX, ANNEE_MIN, _normalize_date

ABSENT = "absent"
NON_RECONNUE = "non_reconnue"
IMPOSSIBLE = "impossible"
FUTURE = "future"
INCOHERENTE = "incoherente"
PLAUSIBLE = "plausible"
STATUTS = (ABSENT, NON_RECONNUE, IMPOSSIBLE, FUTURE, INCOHERENTE, PLAUSIBLE)

# Forme exigee de `aujourdhui`. [0-9] et non \d (chiffres non ASCII en Python).
_ISO_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")

# Marqueur du normaliseur partage pour une date lue mais refusee (regle
# `_avertissement` de date_docie.json : le premier avertissement NOMME la
# panne, « date impossible » ou « date non reconnue »).
_MARQUEUR_IMPOSSIBLE = "date impossible"


def date_du_jour() -> str:
    """Date locale du jour, AAAA-MM-JJ."""
    return date.today().isoformat()


def _majuscule_initiale(texte: str) -> str:
    return texte[:1].upper() + texte[1:]


def controler_dates(
    valeurs: dict[str, Any],
    *,
    ordre: Iterable[tuple[str, str]] = (),
    futur_admis: Iterable[str] = (),
    aujourdhui: str | None = None,
) -> dict[str, dict[str, str]]:
    """Controle des dates lues sur un meme document.

    valeurs     : {nom de champ DocIE: valeur brute}, dans l'ordre d'affichage.
    ordre       : paires (avant, apres) -- `avant` ne peut pas suivre `apres`.
    futur_admis : champs qui PEUVENT etre dans le futur (une fin de validite).
    aujourdhui  : AAAA-MM-JJ ; date locale du jour si None.

    Rend {champ: {"valeur", "date", "statut"}} : `valeur` est le texte lu, jamais
    modifie ("" si absent), `date` la date ISO si elle a ete lue (conservee
    meme « future » ou « incoherente »), sinon ""."""
    if aujourdhui is None:
        aujourdhui = date_du_jour()
    if not isinstance(aujourdhui, str) or not _ISO_RE.fullmatch(aujourdhui):
        raise ValueError(f"aujourdhui doit etre une date AAAA-MM-JJ, recu {aujourdhui!r}")
    admis = set(futur_admis)

    controle: dict[str, dict[str, str]] = {}
    for champ, brut in valeurs.items():
        texte = "" if brut is None else str(brut)
        if texte.strip() == "":
            controle[champ] = {"valeur": texte, "date": "", "statut": ABSENT}
            continue
        avertissements: list[str] = []
        iso = _normalize_date(brut, champ, avertissements)
        if iso == "":
            impossible = bool(avertissements) and _MARQUEUR_IMPOSSIBLE in avertissements[0]
            statut = IMPOSSIBLE if impossible else NON_RECONNUE
        elif champ not in admis and iso > aujourdhui:
            statut = FUTURE
        else:
            statut = PLAUSIBLE
        controle[champ] = {"valeur": texte, "date": iso, "statut": statut}

    for avant, apres in ordre:
        a, b = controle[avant], controle[apres]
        if a["statut"] == PLAUSIBLE and b["statut"] == PLAUSIBLE and a["date"] > b["date"]:
            a["statut"] = INCOHERENTE
            b["statut"] = INCOHERENTE
    return controle


def messages_dates(
    controle: dict[str, dict[str, str]],
    libelles: dict[str, str],
    *,
    ordre: Iterable[tuple[str, str]] = (),
) -> list[dict[str, str]]:
    """Messages destines au relecteur, identiques au caractere pres dans les
    deux langages (la fixture les compare). `libelles` donne le nom en
    minuscules de chaque champ (« date de delivrance »). Chaque panne a son
    libelle : illisible, impossible, future et incoherente ne se corrigent pas
    de la meme facon. Un statut « absent » ne produit aucun message : c'est au
    mapping de dire si l'absence d'une date donnee est un probleme."""
    messages: list[dict[str, str]] = []
    for champ, entree in controle.items():
        libelle = _majuscule_initiale(libelles[champ])
        if entree["statut"] == NON_RECONNUE:
            messages.append({
                "champ": champ,
                "message": f"{libelle} « {entree['valeur']} » : date illisible, format non reconnu"
                           " — à ressaisir depuis le document",
            })
        elif entree["statut"] == IMPOSSIBLE:
            messages.append({
                "champ": champ,
                "message": f"{libelle} « {entree['valeur']} » : date impossible, hors calendrier ou hors"
                           f" {ANNEE_MIN}-{ANNEE_MAX} — à vérifier sur le document",
            })
        elif entree["statut"] == FUTURE:
            messages.append({
                "champ": champ,
                "message": f"{libelle} « {entree['date']} » : date dans le futur, invraisemblable sur une pièce"
                           " déjà délivrée — valeur conservée, à vérifier sur le document",
            })
    for avant, apres in ordre:
        a, b = controle[avant], controle[apres]
        if a["statut"] == INCOHERENTE and b["statut"] == INCOHERENTE:
            messages.append({
                "champ": avant,
                "message": f"Dates incohérentes : {libelles[avant]} « {a['date']} », {libelles[apres]}"
                           f" « {b['date']} » — la première ne peut pas suivre la seconde, l'une des deux"
                           " est mal lue — valeurs conservées, à vérifier sur le document",
            })
    return messages


__all__ = [
    "ABSENT",
    "NON_RECONNUE",
    "IMPOSSIBLE",
    "FUTURE",
    "INCOHERENTE",
    "PLAUSIBLE",
    "STATUTS",
    "date_du_jour",
    "controler_dates",
    "messages_dates",
]
