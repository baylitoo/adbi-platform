#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""siren_siret.py -- controle de la cle de Luhn du SIREN et du SIRET lus par
DocIE, commun aux deux mappings Python qui les lisent :
kbis_to_contrats.py (`siren`, `siret_siege`) et contract_to_contrats.py
(`st_siren`, `st_siret`). Portage JS : contrats/lib/siren-siret.js.

Pourquoi (#194, liste retenue, regle « echouer bruyamment ») : jusqu'ici le
SIREN et le SIRET n'etaient controles nulle part cote mapping, et seulement
en FORMAT dans contrats/lib/integrations.js::normalizeSiren (« 9 ou 14
chiffres »). Un seul chiffre mal lu -- l'erreur typique d'un OCR ou d'un
modele -- passait, arrivait dans le contrat et alimentait la recherche de
fiche societe par SIREN : on pouvait ouvrir la mauvaise societe sans que rien
ne le signale. Les deux numeros portent une cle de Luhn.

Regle PARTAGEE : document-parsing/fixtures/siren_siret.json, que les tests
des deux langages (validateur ET quatre mappings) executent cas par cas, avec
les messages exacts. Ce fichier n'est lu QUE par les tests : l'algorithme vit
ici, dans le code, pour que rien ne manque dans l'image Docker de contrats
(qui ne copie que des fixtures nommees une a une).

Comportement en cas d'echec -- valeur CONSERVEE, jamais videe :
  - un SIREN est un champ texte, qu'un relecteur corrige d'un chiffre en le
    voyant ; le vider transformerait « mal lu » en « pas trouve » ;
  - cote Kbis, vider le SIREN et le SIRET ferait basculer un Kbis lisible dans
    la branche « Document illisible » (nom, SIREN et SIRET tous absents),
    exactement le defaut B1 de #179 ;
  - l'echec est donc rendu VISIBLE (avertissement nomme, distinct du format)
    et LISIBLE PAR MACHINE (`statut` par champ) : un consommateur n'utilise
    un numero que si son statut vaut exactement "valide".

La Poste : INSEE aurait une regle particuliere pour les SIRET de La Poste
(SIREN 356000000). Aucune source n'en est disponible dans le depot ni hors
reseau : elle n'est PAS implementee. Un SIRET de La Poste qui ne passe pas
Luhn sort donc en "cle_invalide" -- faux positif BRUYANT, jamais une perte
de donnee puisque la valeur est conservee. Voir `_la_poste` dans la fixture.
"""

from __future__ import annotations

import re
from typing import Any

# Statuts possibles d'un champ, du plus grave au plus sain. Un consommateur
# teste l'egalite a VALIDE, jamais l'absence d'un probleme : un statut ajoute
# plus tard ne pourra alors pas passer pour une valeur propre.
ABSENT = "absent"
FORMAT_INVALIDE = "format_invalide"
CLE_INVALIDE = "cle_invalide"
DISCORDANT = "discordant"
VALIDE = "valide"
STATUTS = (ABSENT, FORMAT_INVALIDE, CLE_INVALIDE, DISCORDANT, VALIDE)

# Separateurs retires AVANT le controle, et seulement pour lui : la valeur
# rendue au formulaire reste celle du document. Motif PARTAGE, identique
# caractere pour caractere au litteral JS et au champ `motif_separateurs` de
# la fixture. Les mappings ne normalisaient aucun champ texte jusqu'ici --
# il n'y avait pas de normalisation existante a reutiliser -- et celle de
# integrations.js (\D) est trop large pour un controle : elle efface les
# lettres, donc « 941O91316 » (O lu pour 0) y deviendrait un SIREN de 8
# chiffres au lieu d'un format invalide nomme. Caracteres enumeres plutot que
# \s, que Python et JS ne definissent pas pareil.
MOTIF_SEPARATEURS = r"[ \t\n\r\u00a0\u202f.\-]"
_SEPARATEURS_RE = re.compile(MOTIF_SEPARATEURS)
# [0-9] et non \d : \d reconnait aussi les chiffres arabes-indiens en Python
# et pas en JS (meme piege que MOTIF_NOMBRE). fullmatch et non ^...$ : en
# Python, $ accepte un saut de ligne final.
_CHIFFRES_RE = {9: re.compile(r"[0-9]{9}"), 14: re.compile(r"[0-9]{14}")}


def _luhn_valide(chiffres: str) -> bool:
    """Formule de Luhn : en partant de la droite, un chiffre sur deux est
    double (et diminue de 9 s'il depasse 9) ; la somme doit etre multiple
    de 10."""
    somme = 0
    for rang, caractere in enumerate(reversed(chiffres)):
        chiffre = ord(caractere) - 48
        if rang % 2 == 1:
            chiffre *= 2
            if chiffre > 9:
                chiffre -= 9
        somme += chiffre
    return somme % 10 == 0


def _texte(brut: Any) -> str | None:
    if brut is None:
        return None
    # Le modele peut rendre un champ `string` en NOMBRE (#179 A14). Un
    # flottant entier (941091316.0 dans le JSON) vaut 941091316 cote JS, ou
    # String() ne garde pas la decimale : Python doit rendre le meme texte.
    if isinstance(brut, float) and brut.is_integer():
        brut = int(brut)
    return str(brut)


def _controler_un(brut: Any, longueur: int) -> dict[str, Any]:
    texte = _texte(brut)
    if texte is None:
        return {"valeur": "", "chiffres": None, "statut": ABSENT}
    compact = _SEPARATEURS_RE.sub("", texte)
    if compact == "":
        # « Champ vu, rien trouve » : meme regle que les nombres et les dates.
        return {"valeur": texte, "chiffres": None, "statut": ABSENT}
    if not _CHIFFRES_RE[longueur].fullmatch(compact):
        return {"valeur": texte, "chiffres": None, "statut": FORMAT_INVALIDE}
    cle_ok = _luhn_valide(compact)
    if longueur == 14:
        # Un SIRET est un SIREN suivi du NIC : ses 9 premiers chiffres portent
        # donc eux aussi une cle de Luhn. Sans ce second controle, un SIRET
        # dont la cle a 14 chiffres tombe juste par hasard malgre un SIREN
        # faux passerait (voir le cas 12345678900007 de la fixture).
        cle_ok = cle_ok and _luhn_valide(compact[:9])
    return {"valeur": texte, "chiffres": compact, "statut": VALIDE if cle_ok else CLE_INVALIDE}


def controler_siren_siret(siren_brut: Any, siret_brut: Any) -> dict[str, dict[str, Any]]:
    """Controle un SIREN et un SIRET lus sur le meme document. Rend
    {"siren": {...}, "siret": {...}}, chaque entree portant `valeur` (le texte
    lu, jamais modifie), `chiffres` (les chiffres sans separateurs, ou None si
    le format est invalide ou le champ absent) et `statut` (voir STATUTS).

    Discordance : si les deux numeros sont valides chacun de son cote mais
    que le SIRET ne commence pas par le SIREN, l'un des deux est mal lu sans
    qu'on sache lequel -- les DEUX passent en "discordant". Elle n'est pas
    evaluee quand l'un des deux a deja une cle invalide : l'ecart est alors
    attendu, et c'est ce defaut-la qui est nomme."""
    siren = _controler_un(siren_brut, 9)
    siret = _controler_un(siret_brut, 14)
    if siren["statut"] == VALIDE and siret["statut"] == VALIDE and siret["chiffres"][:9] != siren["chiffres"]:
        siren["statut"] = DISCORDANT
        siret["statut"] = DISCORDANT
    return {"siren": siren, "siret": siret}


def messages_siren_siret(controle: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """Messages destines au relecteur, identiques au caractere pres dans les
    deux langages (la fixture les compare). `champ` vaut "siren" ou "siret" :
    le mapping le traduit en nom de champ DocIE pour ses avertissements.
    Chaque statut a son libelle : « format invalide » (le modele n'a pas lu
    un numero), « cle de controle invalide » (il a lu un numero, faux d'au
    moins un chiffre) et « discordant » (deux numeros justes chacun, mais qui
    ne vont pas ensemble) ne se corrigent pas de la meme facon."""
    messages: list[dict[str, str]] = []
    for champ, libelle, longueur in (("siren", "SIREN", 9), ("siret", "SIRET", 14)):
        entree = controle[champ]
        if entree["statut"] == FORMAT_INVALIDE:
            messages.append({
                "champ": champ,
                "message": f"{libelle} « {entree['valeur']} » : format invalide, {longueur} chiffres attendus"
                           " — valeur conservée, à vérifier sur le document",
            })
        elif entree["statut"] == CLE_INVALIDE:
            messages.append({
                "champ": champ,
                "message": f"{libelle} « {entree['valeur']} » : clé de contrôle invalide, chiffre probablement mal lu"
                           " — valeur conservée, à vérifier sur le document",
            })
    if controle["siret"]["statut"] == DISCORDANT:
        messages.append({
            "champ": "siret",
            "message": f"SIRET « {controle['siret']['valeur']} » discordant du SIREN « {controle['siren']['valeur']} » :"
                       " ses 9 premiers chiffres devraient être ce SIREN, l'un des deux est mal lu"
                       " — valeurs conservées, à vérifier sur le document",
        })
    return messages


__all__ = [
    "ABSENT",
    "FORMAT_INVALIDE",
    "CLE_INVALIDE",
    "DISCORDANT",
    "VALIDE",
    "STATUTS",
    "MOTIF_SEPARATEURS",
    "controler_siren_siret",
    "messages_siren_siret",
]
