#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mrz.py -- controle des chiffres de la zone de lecture automatique (MRZ)
lue par DocIE sur une piece d'identite. Importe par cni_to_contrats.py.
Portage JS : contrats/lib/mrz.js.

POURQUOI, et ou c'est ecrit dans le depot : document-parsing/models/
catalogue.json, tache "cni" (cle `taches`), donne NuExtract3 par la voie vision avec pour
`prerequis` « Controle des chiffres de la MRZ. ». Ce module EST ce prerequis.
Meme conception que siren_siret.py (#201) et iban_bic.py (#209) : un validateur
par langage, importe par les mappings, jamais recopie.

Un numero de titre mal lu ressemble exactement a un numero juste -- c'est la
meme asymetrie que l'IBAN. La MRZ, elle, porte ses propres chiffres de
controle : les verifier transforme une lecture fausse en echec NOMME plutot
qu'en valeur qui passe pour une lecture precise.

FORMAT MODELISE : TD1, trois lignes de 30 caracteres, celui de la carte
nationale d'identite francaise depuis 2021. Ce module ne controle que les
LIGNES 1 ET 2 : elles portent la totalite des chiffres de controle (numero de
document, date de naissance, date d'expiration, composite). La ligne 3 ne
porte que les noms, deja demandes en clair par les champs `surname` et
`given_names` du schema (document-parsing/schemas/cni.schema.json) ; la lire
une seconde fois doublerait la surface de lecture fausse sans rien controler
de plus.
NON VERIFIE : « la carte francaise posterieure a 2021 est au format TD1 » est
cite de memoire, aucune source n'ayant pu etre consultee (travail hors reseau,
rien dans le depot). Si la carte recue n'est pas au format TD1, ses lignes ne
feront pas 30 caracteres et sortiront en « format_invalide » : faux positif
BRUYANT, jamais une perte de donnee. L'ancienne carte francaise (avant 2021)
porte une MRZ a deux lignes de 36 caracteres d'un format national different :
elle n'est PAS couverte ici, et sortira elle aussi en « format_invalide ».

REGLE DES CHIFFRES DE CONTROLE (ICAO 9303) :
  - chaque caractere vaut : 0-9 leur valeur, A=10 ... Z=35, « < » = 0 ;
  - les poids 7, 3, 1 se repetent sur la chaine controlee ;
  - le chiffre de controle est la somme ponderee modulo 10.
Quatre chiffres sont verifies :
  - numero de document : ligne 1, caracteres 6 a 14, chiffre en 15 ;
  - date de naissance  : ligne 2, caracteres 1 a 6, chiffre en 7 ;
  - date d'expiration  : ligne 2, caracteres 9 a 14, chiffre en 15 ;
  - composite          : voir _COMPOSITE ci-dessous, chiffre en ligne 2, 30.
(Positions comptees a partir de 1 dans ce commentaire ; le code compte a
partir de 0, comme Python et JS.)

CE QUI N'EST PAS CONTROLE, dit plutot que devine (voir aussi les notes de
document-parsing/fixtures/mrz.json) :
  - la concordance entre le numero lu DANS la MRZ et le champ
    `document_number` lu en clair : le champ TD1 du numero fait 9 caracteres,
    et le mecanisme de debordement d'un numero plus long vers les donnees
    optionnelles n'a pas pu etre relu. Comparer les deux produirait des
    discordances fausses sur les numeros longs ;
  - la concordance entre les dates de la MRZ (AAMMJJ, sans siecle) et les
    champs `birth_date` / `expiry_date` : la regle de siecle d'un AAMMJJ n'a
    pas pu etre relue, et la deviner ferait exactement ce que ce module doit
    empecher.

Echec : valeur CONSERVEE, jamais videe (un relecteur corrige un caractere en
le voyant), avertissement nomme distinct par panne, et `statut` lisible par
machine. Un consommateur n'utilise une valeur de la MRZ que si son statut vaut
exactement "valide".

Regle PARTAGEE : document-parsing/fixtures/mrz.json, executee cas par cas par
les tests des deux langages, messages exacts compris. Ce fichier n'est lu QUE
par les tests : l'algorithme vit ici, dans le code.
"""

from __future__ import annotations

import re
from typing import Any

# Statuts possibles. Un consommateur teste l'egalite a VALIDE, jamais l'absence
# d'un probleme : un statut ajoute plus tard ne pourra pas passer pour une
# valeur propre.
ABSENT = "absent"
FORMAT_INVALIDE = "format_invalide"
NON_CONTROLE = "non_controle"
CLE_INVALIDE = "cle_invalide"
VALIDE = "valide"
STATUTS = (ABSENT, FORMAT_INVALIDE, NON_CONTROLE, CLE_INVALIDE, VALIDE)

# Separateurs retires AVANT le controle, et seulement pour lui. Motif PARTAGE,
# identique caractere pour caractere au litteral JS et au champ
# `motif_separateurs` de la fixture. Caracteres enumeres plutot que \s, que
# Python et JS ne definissent pas pareil. PAS de tiret, a la difference de
# iban_bic.py : « - » n'est pas un caractere de MRZ ni un separateur de
# groupement, le retirer masquerait une lecture fausse.
MOTIF_SEPARATEURS = r"[ \t\n\r\u00a0\u202f]"
_SEPARATEURS_RE = re.compile(MOTIF_SEPARATEURS)
# Majuscules ASCII seulement : str.upper() transforme aussi « ı » (i sans
# point) en « I » et « ß » en « SS », ce qui ferait passer un caractere
# etranger pour une lettre de MRZ valide.
_MINUSCULES_ASCII_RE = re.compile(r"[a-z]")

# Longueur d'une ligne TD1. fullmatch et non ^...$ : en Python, $ accepte un
# saut de ligne final.
LONGUEUR_LIGNE = 30
_LIGNE_RE = re.compile(r"[A-Z0-9<]{%d}" % LONGUEUR_LIGNE)

# Poids ICAO 9303, repetes sur la chaine controlee.
POIDS = (7, 3, 1)

# Tranches controlees, comptees a partir de 0. Les trois premieres se lisent
# directement dans le tableau TD1 ; le composite est l'assemblage decrit par
# ICAO 9303 partie 5, CITE DE MEMOIRE et non relu (voir `_composite` dans la
# fixture) : donnees de la ligne 1 apres le code d'Etat, puis date de naissance
# et son chiffre, date d'expiration et son chiffre, puis donnees optionnelles
# de la ligne 2.
_NUMERO = ("ligne1", 5, 14, 14)          # (ligne, debut, fin, position du chiffre)
_NAISSANCE = ("ligne2", 0, 6, 6)
_EXPIRATION = ("ligne2", 8, 14, 14)
_COMPOSITE = (((1, 5, 30), (2, 0, 7), (2, 8, 15), (2, 18, 29)), 29)

# Nom du champ DocIE (schema "cni") qui porte chaque ligne : c'est lui qui
# nomme l'avertissement, comme `siren` / `siret` pour le Kbis.
CHAMPS: dict[str, str] = {"ligne1": "mrz_line1", "ligne2": "mrz_line2"}


def _texte(brut: Any) -> str | None:
    if brut is None:
        return None
    # Meme regle que iban_bic.py : un flottant entier vaut l'entier cote JS.
    if isinstance(brut, float) and brut.is_integer():
        brut = int(brut)
    return str(brut)


def _compacter(texte: str) -> str:
    return _MINUSCULES_ASCII_RE.sub(lambda m: m.group(0).upper(), _SEPARATEURS_RE.sub("", texte))


def valeur_caractere(caractere: str) -> int:
    """Valeur ICAO 9303 d'un caractere de MRZ : « < » vaut 0, un chiffre sa
    valeur, une lettre A=10 ... Z=35."""
    if caractere == "<":
        return 0
    code = ord(caractere)
    if 48 <= code <= 57:
        return code - 48
    return code - 55


def chiffre_controle(chaine: str) -> str:
    """Chiffre de controle ICAO 9303 d'une chaine deja compactee : somme des
    valeurs ponderees par 7, 3, 1 repetes, modulo 10."""
    somme = 0
    for index, caractere in enumerate(chaine):
        somme += valeur_caractere(caractere) * POIDS[index % 3]
    return str(somme % 10)


def _controler_ligne(brut: Any) -> dict[str, Any]:
    texte = _texte(brut)
    if texte is None:
        return {"valeur": "", "compact": None, "statut": ABSENT}
    compact = _compacter(texte)
    if compact == "":
        # « Champ vu, rien trouve » : meme regle que les nombres et les dates.
        return {"valeur": texte, "compact": None, "statut": ABSENT}
    if not _LIGNE_RE.fullmatch(compact):
        return {"valeur": texte, "compact": None, "statut": FORMAT_INVALIDE}
    return {"valeur": texte, "compact": compact, "statut": VALIDE}


def _statut_hote(*lignes: dict[str, Any]) -> str | None:
    """Statut a donner a un chiffre de controle dont la ou les lignes ne sont
    pas exploitables : ABSENT si aucune n'a ete lue (rien a controler),
    NON_CONTROLE si l'une a ete lue mais mal formee (son propre avertissement
    nomme deja la cause). None si tout est exploitable."""
    if all(ligne["statut"] == ABSENT for ligne in lignes):
        return ABSENT
    if any(ligne["statut"] != VALIDE for ligne in lignes):
        return NON_CONTROLE
    return None


def _controler_chiffre(ligne: dict[str, Any], debut: int, fin: int, position: int) -> dict[str, Any]:
    indisponible = _statut_hote(ligne)
    if indisponible is not None:
        return {"valeur": "", "cle_lue": None, "cle_calculee": None, "statut": indisponible}
    compact = ligne["compact"]
    valeur = compact[debut:fin]
    lue = compact[position]
    calculee = chiffre_controle(valeur)
    return {
        "valeur": valeur,
        "cle_lue": lue,
        "cle_calculee": calculee,
        "statut": VALIDE if lue == calculee else CLE_INVALIDE,
    }


def _controler_composite(ligne1: dict[str, Any], ligne2: dict[str, Any]) -> dict[str, Any]:
    indisponible = _statut_hote(ligne1, ligne2)
    if indisponible is not None:
        return {"valeur": "", "cle_lue": None, "cle_calculee": None, "statut": indisponible}
    compacts = {1: ligne1["compact"], 2: ligne2["compact"]}
    tranches, position = _COMPOSITE
    valeur = "".join(compacts[numero][debut:fin] for numero, debut, fin in tranches)
    lue = compacts[2][position]
    calculee = chiffre_controle(valeur)
    return {
        "valeur": valeur,
        "cle_lue": lue,
        "cle_calculee": calculee,
        "statut": VALIDE if lue == calculee else CLE_INVALIDE,
    }


def controler_mrz(ligne1_brut: Any, ligne2_brut: Any) -> dict[str, dict[str, Any]]:
    """Controle les deux lignes de MRZ lues sur la meme piece.

    Rend un dict a six entrees, dans cet ordre : `ligne1` et `ligne2`
    ({valeur, compact, statut}), puis `numero_document`, `date_naissance`,
    `date_expiration` et `composite` ({valeur, cle_lue, cle_calculee,
    statut}). `valeur` est toujours le texte lu, jamais modifie ("" quand il
    n'y a rien) ; `compact` est la ligne sans separateurs et en majuscules, ou
    None si la ligne est absente ou mal formee."""
    ligne1 = _controler_ligne(ligne1_brut)
    ligne2 = _controler_ligne(ligne2_brut)
    lignes = {"ligne1": ligne1, "ligne2": ligne2}
    controle: dict[str, dict[str, Any]] = {"ligne1": ligne1, "ligne2": ligne2}
    for nom, (ligne, debut, fin, position) in (
        ("numero_document", _NUMERO),
        ("date_naissance", _NAISSANCE),
        ("date_expiration", _EXPIRATION),
    ):
        controle[nom] = _controler_chiffre(lignes[ligne], debut, fin, position)
    controle["composite"] = _controler_composite(ligne1, ligne2)
    return controle


_FIN = " — valeur conservée, à vérifier sur le document"

# Libelle de chaque chiffre controle et ligne qui le porte.
_LIBELLES: dict[str, tuple[str, str]] = {
    "numero_document": ("Numéro de document", "ligne1"),
    "date_naissance": ("Date de naissance", "ligne2"),
    "date_expiration": ("Date d'expiration", "ligne2"),
}


def messages_mrz(controle: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """Messages destines au relecteur, identiques au caractere pres dans les
    deux langages (la fixture les compare). `champ` vaut le nom DocIE de la
    ligne en cause ("mrz_line1" ou "mrz_line2").

    Un statut NON_CONTROLE ne produit AUCUN message : la ligne qui le cause a
    deja le sien (« format invalide »), et repeter la meme panne quatre fois
    noierait les vraies. Un statut ABSENT n'en produit pas non plus : c'est au
    mapping de dire si l'absence de MRZ est un probleme."""
    messages: list[dict[str, str]] = []
    for nom in ("ligne1", "ligne2"):
        ligne = controle[nom]
        if ligne["statut"] == FORMAT_INVALIDE:
            messages.append({
                "champ": CHAMPS[nom],
                "message": f"MRZ ligne {nom[-1]} « {ligne['valeur']} » : format invalide,"
                           f" {LONGUEUR_LIGNE} caractères A-Z, 0-9 ou « < » attendus (format TD1){_FIN}",
            })
    for nom, (libelle, ligne) in _LIBELLES.items():
        entree = controle[nom]
        if entree["statut"] == CLE_INVALIDE:
            messages.append({
                "champ": CHAMPS[ligne],
                "message": f"{libelle} « {entree['valeur']} » de la MRZ : chiffre de contrôle invalide"
                           f" (lu {entree['cle_lue']}, calculé {entree['cle_calculee']}),"
                           f" caractère probablement mal lu{_FIN}",
            })
    composite = controle["composite"]
    if composite["statut"] == CLE_INVALIDE:
        messages.append({
            "champ": CHAMPS["ligne2"],
            "message": f"Chiffre de contrôle composite de la MRZ invalide (lu {composite['cle_lue']},"
                       f" calculé {composite['cle_calculee']}) : au moins un caractère des lignes 1 et 2"
                       f" est mal lu{_FIN}",
        })
    return messages


__all__ = [
    "ABSENT",
    "FORMAT_INVALIDE",
    "NON_CONTROLE",
    "CLE_INVALIDE",
    "VALIDE",
    "STATUTS",
    "MOTIF_SEPARATEURS",
    "LONGUEUR_LIGNE",
    "POIDS",
    "CHAMPS",
    "valeur_caractere",
    "chiffre_controle",
    "controler_mrz",
    "messages_mrz",
]
