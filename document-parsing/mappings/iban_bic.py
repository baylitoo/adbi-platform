#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""iban_bic.py -- controle de l'IBAN et du BIC lus par DocIE sur un RIB.
Importe par rib_to_contrats.py. Portage JS : contrats/lib/iban-bic.js.

Pourquoi (#194, liste retenue, ligne RIB, regle « echouer bruyamment ») :
LFM2.5-350M n'est propose pour le RIB que « derriere IBAN mod-97 + format
BIC ». Un IBAN mal lu d'un seul caractere ressemble exactement a un IBAN
juste ; sans controle, il partirait tel quel vers la facturation. Meme
conception que siren_siret.py (PR #201) : un validateur par langage, importe
par les mappings, jamais recopie.

Regle PARTAGEE : document-parsing/fixtures/iban_bic.json, executee cas par
cas par les tests des deux langages, messages exacts compris. Ce fichier n'est
lu QUE par les tests : l'algorithme vit ici, dans le code.

Controles :
  - IBAN (ISO 13616) : separateurs retires et lettres ASCII mises en
    majuscules POUR LE CONTROLE SEULEMENT ; 2 lettres de pays, 2 chiffres de
    cle, 1 a 30 lettres ou chiffres ; longueur exacte pour les pays de
    LONGUEURS_IBAN (FR seulement, voir `_longueurs` dans la fixture) ; puis cle
    ISO 7064 MOD 97-10 : les 4 premiers caracteres passent a la fin, chaque
    lettre devient un nombre (A=10 ... Z=35), le reste de la division par 97
    doit valoir 1.
  - BIC (ISO 9362) : 4 lettres de banque, 2 lettres de pays, 2 lettres ou
    chiffres d'emplacement, et 3 lettres ou chiffres de succursale facultatifs
    (8 ou 11 caracteres).
  - Pays : un BIC dont le pays differe de celui d'un IBAN VALIDE passe en
    "pays_discordant". Le statut est porte par le BIC seul : le code pays de
    l'IBAN est couvert par sa cle (un pays mal lu fait echouer le modulo 97),
    alors qu'un BIC n'a aucune cle. L'IBAN garde donc "valide".

Cle RIB francaise (banque/guichet/compte/cle) : NON implementee. Aucune norme
qui la definit n'a pu etre consultee (travail hors reseau, rien dans le
depot) ; la deviner serait exactement ce que ce module doit empecher. Voir
`_cle_rib` dans la fixture : la cle RIB fait partie du BBAN sur lequel la cle
IBAN est calculee, donc un chiffre mal lu dans la cle RIB est deja attrape par
le modulo 97 (mesure exhaustive dans les tests).

Echec : valeur CONSERVEE, jamais videe (un relecteur corrige un caractere en
le voyant), avertissement nomme distinct par panne, et `statut` lisible par
machine. Un consommateur n'utilise un IBAN ou un BIC que si son statut vaut
exactement "valide".
"""

from __future__ import annotations

import re
from typing import Any

# Statuts possibles d'un champ. Un consommateur teste l'egalite a VALIDE,
# jamais l'absence d'un probleme : un statut ajoute plus tard ne pourra pas
# passer pour une valeur propre.
ABSENT = "absent"
FORMAT_INVALIDE = "format_invalide"
CLE_INVALIDE = "cle_invalide"
PAYS_DISCORDANT = "pays_discordant"
VALIDE = "valide"
STATUTS = (ABSENT, FORMAT_INVALIDE, CLE_INVALIDE, PAYS_DISCORDANT, VALIDE)

# Separateurs retires AVANT le controle, et seulement pour lui. Motif PARTAGE,
# identique caractere pour caractere au litteral JS et au champ
# `motif_separateurs` de la fixture. Caracteres enumeres plutot que \s, que
# Python et JS ne definissent pas pareil. Pas de point : un IBAN ne s'ecrit pas
# groupe par points.
MOTIF_SEPARATEURS = r"[ \t\n\r\u00a0\u202f\-]"
_SEPARATEURS_RE = re.compile(MOTIF_SEPARATEURS)
# Majuscules ASCII seulement : str.upper() transforme aussi « ı » (i sans
# point) en « I » et « ß » en « SS », ce qui ferait passer un caractere
# etranger pour une lettre valide.
_MINUSCULES_ASCII_RE = re.compile(r"[a-z]")
# [0-9] / [A-Z] et non \d / \w : memes verdicts que JS sur les caracteres non
# ASCII. fullmatch et non ^...$ : en Python, $ accepte un saut de ligne final.
_IBAN_RE = re.compile(r"[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}")
_BIC_RE = re.compile(r"[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?")

# Longueur exacte par pays. FR seulement : c'est la seule longueur dont le
# depot a besoin, et les autres ne sont pas recopiees de memoire (voir
# `_longueurs` dans la fixture). Un IBAN d'un autre pays passe le format
# generique puis la cle.
LONGUEURS_IBAN = {"FR": 27}


def _texte(brut: Any) -> str | None:
    if brut is None:
        return None
    # Meme regle que siren_siret.py : un flottant entier vaut l'entier cote JS.
    if isinstance(brut, float) and brut.is_integer():
        brut = int(brut)
    return str(brut)


def _compacter(texte: str) -> str:
    return _MINUSCULES_ASCII_RE.sub(lambda m: m.group(0).upper(), _SEPARATEURS_RE.sub("", texte))


def _modulo_97(compact: str) -> int:
    """Reste ISO 7064 MOD 97-10 de l'IBAN reordonne, calcule caractere par
    caractere pour ne jamais construire le grand entier (meme calcul en JS)."""
    reste = 0
    for caractere in compact[4:] + compact[:4]:
        code = ord(caractere)
        if 48 <= code <= 57:
            reste = (reste * 10 + (code - 48)) % 97
        else:
            reste = (reste * 100 + (code - 55)) % 97
    return reste


def _controler_iban(brut: Any) -> dict[str, Any]:
    texte = _texte(brut)
    if texte is None:
        return {"valeur": "", "compact": None, "pays": None, "statut": ABSENT}
    compact = _compacter(texte)
    if compact == "":
        # « Champ vu, rien trouve » : meme regle que les nombres et les dates.
        return {"valeur": texte, "compact": None, "pays": None, "statut": ABSENT}
    if not _IBAN_RE.fullmatch(compact):
        return {"valeur": texte, "compact": None, "pays": None, "statut": FORMAT_INVALIDE}
    pays = compact[:2]
    if pays in LONGUEURS_IBAN and len(compact) != LONGUEURS_IBAN[pays]:
        return {"valeur": texte, "compact": None, "pays": pays, "statut": FORMAT_INVALIDE}
    statut = VALIDE if _modulo_97(compact) == 1 else CLE_INVALIDE
    return {"valeur": texte, "compact": compact, "pays": pays, "statut": statut}


def _controler_bic(brut: Any) -> dict[str, Any]:
    texte = _texte(brut)
    if texte is None:
        return {"valeur": "", "compact": None, "pays": None, "statut": ABSENT}
    compact = _compacter(texte)
    if compact == "":
        return {"valeur": texte, "compact": None, "pays": None, "statut": ABSENT}
    if not _BIC_RE.fullmatch(compact):
        return {"valeur": texte, "compact": None, "pays": None, "statut": FORMAT_INVALIDE}
    return {"valeur": texte, "compact": compact, "pays": compact[4:6], "statut": VALIDE}


def controler_iban_bic(iban_brut: Any, bic_brut: Any) -> dict[str, dict[str, Any]]:
    """Controle un IBAN et un BIC lus sur le meme RIB. Rend
    {"iban": {...}, "bic": {...}}, chaque entree portant `valeur` (le texte lu,
    jamais modifie), `compact` (sans separateurs, en majuscules, ou None si le
    format est invalide ou le champ absent), `pays` (code pays lu, ou None) et
    `statut` (voir STATUTS).

    Discordance de pays : evaluee seulement si l'IBAN est "valide" et le BIC
    bien forme. Elle n'est portee que par le BIC (voir l'en-tete)."""
    iban = _controler_iban(iban_brut)
    bic = _controler_bic(bic_brut)
    if iban["statut"] == VALIDE and bic["statut"] == VALIDE and bic["pays"] != iban["pays"]:
        bic["statut"] = PAYS_DISCORDANT
    return {"iban": iban, "bic": bic}


_FIN = " — valeur conservée, à vérifier sur le document"


def messages_iban_bic(controle: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """Messages destines au relecteur, identiques au caractere pres dans les
    deux langages (la fixture les compare). `champ` vaut "iban" ou "bic".
    Chaque panne a son libelle : un format invalide (le modele n'a pas lu un
    IBAN), une cle invalide (il a lu un IBAN faux d'au moins un caractere) et
    un pays discordant ne se corrigent pas de la meme facon."""
    messages: list[dict[str, str]] = []
    iban = controle["iban"]
    if iban["statut"] == FORMAT_INVALIDE:
        if iban["pays"] in LONGUEURS_IBAN:
            detail = f"{LONGUEURS_IBAN[iban['pays']]} caractères attendus pour un IBAN {iban['pays']}"
        else:
            detail = "2 lettres de pays, 2 chiffres de clé puis 1 à 30 lettres ou chiffres attendus"
        messages.append({"champ": "iban", "message": f"IBAN « {iban['valeur']} » : format invalide, {detail}{_FIN}"})
    elif iban["statut"] == CLE_INVALIDE:
        messages.append({
            "champ": "iban",
            "message": f"IBAN « {iban['valeur']} » : clé de contrôle invalide (modulo 97), caractère probablement mal lu{_FIN}",
        })
    bic = controle["bic"]
    if bic["statut"] == FORMAT_INVALIDE:
        messages.append({
            "champ": "bic",
            "message": f"BIC « {bic['valeur']} » : format invalide, 8 ou 11 caractères attendus"
                       f" (6 lettres puis 2 ou 5 lettres ou chiffres){_FIN}",
        })
    elif bic["statut"] == PAYS_DISCORDANT:
        messages.append({
            "champ": "bic",
            "message": f"BIC « {bic['valeur']} » : pays {bic['pays']} différent du pays {iban['pays']} de l'IBAN"
                       f" « {iban['valeur']} », dont la clé est valide — BIC probablement mal lu{_FIN}",
        })
    return messages


__all__ = [
    "ABSENT",
    "FORMAT_INVALIDE",
    "CLE_INVALIDE",
    "PAYS_DISCORDANT",
    "VALIDE",
    "STATUTS",
    "MOTIF_SEPARATEURS",
    "LONGUEURS_IBAN",
    "controler_iban_bic",
    "messages_iban_bic",
]
