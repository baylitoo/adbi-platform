"""Fabrique les `ocr_blocks` de la voie texte depuis les paragraphes et pages
d'un appelant.

Pourquoi ce module existe. DocIE ne découpe le texte lui-même que si personne ne
lui donne de blocs, et il en fait alors UNE LIGNE NON VIDE = UN BLOC
(ocr/base.py::text_to_blocks) dont seuls les 800 premiers entrent dans le prompt
(llm/prompts.py:134), en silence. Le plafond se compte donc en LIGNES, pas en
contenu : un contrat de 1 200 lignes est tronqué alors qu'il tient largement
dans le contexte du modèle. Nos deux rendus de DOCX produisent déjà une ligne
par paragraphe (cv-parser/docie_client.py::_blocs, one-pager/lib/ingest.js::
texteDocx), et la couche texte d'un PDF en produit bien plus.

Ce module n'invente aucune frontière : il regroupe des lignes consécutives, dans
l'ordre, sans jamais franchir une page. Le texte d'un bloc est exactement celui
de ses lignes, joint par "\\n".

Règle de conception, la seule qui compte ici : REGROUPER COÛTE DE LA PRÉCISION
D'ANCRAGE. Un `evidence_id` désigne un bloc ; un bloc de dix lignes est une
preuve dix fois plus grossière. On ne regroupe donc QUE lorsque l'alternative
est la troncature silencieuse — en dessous du plafond, une ligne reste un bloc.

Portage jumeau de blocs-ocr.js : mêmes noms, mêmes refus, mêmes identifiants.
Les plafonds et le validateur sont EMPRUNTÉS au transport, jamais recopiés.
"""
import hashlib

from docie_bridge import (DOCIE_BLOCS_TEXTE_MAX, DOCIE_BLOC_CARACTERES_MAX, valider_blocs_ocr,
                          DocIEBridgeError)


def _est_blanche(ligne):
    """Blanc au sens de `str.strip()` : c'est la règle de DocIE. Le portage JS
    ne peut pas utiliser trim(), qui efface \\ufeff là où Python le garde."""
    return not ligne.strip()


def _identifiant(page, index, texte):
    """Même forme que les identifiants fabriqués par DocIE quand c'est lui qui
    découpe (ocr/base.py:27, `f"b{page}_{index}_{sha256(...)[:12]}"`) : les
    nôtres partent verbatim et reviennent tels quels dans `evidence_ids`.
    Déterministe : le même document réimporté donne les mêmes identifiants."""
    graine = "{}:{}:{}".format(page, index, texte).encode("utf-8")
    return "b{}_{}_{}".format(page, index, hashlib.sha256(graine).hexdigest()[:12])


def _echouer(message):
    raise DocIEBridgeError("input", message)


def _normaliser(pages):
    """Pages normalisées : numéros entiers >= 1, lignes non blanches, pages
    vides écartées. L'ordre de lecture de l'appelant est conservé tel quel."""
    if not isinstance(pages, list) or not pages:
        _echouer("Pages must be a non-empty array of {page, lignes}.")
    propres = []
    for index, page in enumerate(pages):
        ou = " (pages[" + str(index) + "])"
        if not isinstance(page, dict):
            _echouer("Each page must be an object" + ou + ".")
        numero = page.get("page")
        if not isinstance(numero, int) or isinstance(numero, bool) or numero < 1:
            _echouer("Page number must be an integer >= 1" + ou + ".")
        lignes_page = page.get("lignes")
        if not isinstance(lignes_page, list):
            _echouer("Page lignes must be an array of strings" + ou + ".")
        gardees = []
        for ligne in lignes_page:
            if not isinstance(ligne, str):
                _echouer("Each line must be a string" + ou + ".")
            if not _est_blanche(ligne):
                gardees.append(ligne)
        if gardees:
            propres.append({"page": numero, "lignes": gardees})
    if not propres:
        _echouer("No non-blank line to send: DocIE would extract from nothing.")
    return propres


def _empaqueter(pages, budget):
    """Remplissage glouton par budget de caractères, page par page.

    Un bloc se ferme quand la ligne suivante le ferait dépasser le budget,
    jamais au milieu d'une ligne, et jamais d'une page à l'autre. Une ligne plus
    longue que le plafond DocIE par bloc reste seule dans son bloc : la découper
    inventerait une frontière que le document n'a pas, et `valider_blocs_ocr`
    refusera bruyamment."""
    blocs = []
    for page in pages:
        courant, taille, index = [], 0, 0

        def fermer(courant, taille, index):
            if not courant:
                return courant, taille, index
            texte = "\n".join(courant)
            blocs.append({"id": _identifiant(page["page"], index, texte), "text": texte,
                          "page": page["page"], "source": "manual"})
            return [], 0, index + 1

        for ligne in page["lignes"]:
            cout = len(ligne)
            if courant and (taille + 1 + cout > budget or taille + 1 + cout > DOCIE_BLOC_CARACTERES_MAX):
                courant, taille, index = fermer(courant, taille, index)
            courant.append(ligne)
            taille += (1 if taille else 0) + cout
        fermer(courant, taille, index)
    return blocs


def blocs_depuis_pages(pages, *, max_blocs=DOCIE_BLOCS_TEXTE_MAX):
    """Blocs d'un document dont on connaît les pages.

    `pages` : liste de {"page": n, "lignes": [str]}, dans l'ordre de lecture de
    l'appelant. `max_blocs` : nombre de blocs visé, par défaut le plafond de
    prompt de DocIE (800) ; descendre plus bas n'a d'intérêt que pour
    `parallel_extraction`, où le document est évalué une fois par groupe.

    Rend (blocs, resume) où `resume["groupees"]` dit si le regroupement a eu
    lieu, donc si l'ancrage est plus grossier qu'une ligne.
    """
    if not isinstance(max_blocs, int) or isinstance(max_blocs, bool) or not 1 <= max_blocs <= DOCIE_BLOCS_TEXTE_MAX:
        _echouer("max must be an integer between 1 and " + str(DOCIE_BLOCS_TEXTE_MAX) + ".")
    propres = _normaliser(pages)
    lignes = sum(len(p["lignes"]) for p in propres)
    caracteres = sum(len(ligne) for p in propres for ligne in p["lignes"])
    # Sous le plafond : une ligne = un bloc, l'ancrage reste au plus fin. C'est
    # le cas courant (un CV, un Kbis) et il ne paie rien pour un problème qu'il
    # n'a pas.
    blocs = _empaqueter(propres, 0)
    if len(blocs) > max_blocs:
        # Chaque page finit sur un bloc partiel, donc un budget ne garantit pas
        # à lui seul le compte visé : on resserre jusqu'à y être. Convergence :
        # le budget croît strictement, et un budget supérieur au total des
        # caractères donne un bloc par page, soit au plus `len(propres)` blocs.
        budget = max(1, -(-caracteres // max_blocs))
        essai = 0
        while essai < 40 and len(blocs) > max_blocs:
            blocs = _empaqueter(propres, budget)
            budget = -(-budget * 5 // 4) + 1
            essai += 1
        if len(blocs) > max_blocs:
            _echouer("Cannot pack " + str(lignes) + " lines into " + str(max_blocs) + " blocks: "
                     + str(len(propres)) + " pages, and a block never spans two pages.")
    # Le validateur du transport a le dernier mot : ce module ne réimplémente
    # aucune de ses règles, il doit simplement produire ce qu'il accepte.
    valides, _ = valider_blocs_ocr(blocs)
    return valides, {"lignes": lignes, "blocs": len(valides), "caracteres": caracteres,
                     "groupees": len(valides) < lignes}


def blocs_depuis_lignes(lignes, *, page=1, max_blocs=DOCIE_BLOCS_TEXTE_MAX):
    """Blocs d'un document sans pagination connue — les paragraphes d'un DOCX,
    un .txt. Tout est rattaché à `page`, 1 par défaut : DocIE n'émet alors aucun
    marqueur `[page N]` (llm/prompts.py:136-146), ce qui est exact — nous
    n'avons pas cette information à lui donner."""
    return blocs_depuis_pages([{"page": page, "lignes": lignes}], max_blocs=max_blocs)
