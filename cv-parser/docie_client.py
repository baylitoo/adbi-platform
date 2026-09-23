"""Lecture locale du texte, projection du résultat DocIE et repli externe ; le transport est le pont partagé."""
import json
import math
import sys
from pathlib import Path
from zipfile import ZipFile, BadZipFile
from xml.etree import ElementTree


class DocIEError(RuntimeError):
    """Échec d'extraction, tel qu'il est montré à l'utilisateur.

    `code` : code STABLE de la cause quand on le connaît (codes du pont
    partagé : timeout, network, upstream…), None sinon. Il était jusqu'ici
    seulement interpolé dans le message ; le relire depuis de la prose pour
    décider d'un repli serait fragile. Le repli externe s'en sert pour NE PAS
    rejouer un travail qui peut encore tourner et être facturé (`timeout`).

    Reste une simple valeur portée par l'exception : les `raise DocIEError(...)`
    restent des appels directs, ce que la garde AST de
    tests/test_taches_upload.py exige pour continuer à les voir.
    """

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


# ── Texte d'un .docx pour /v1/extract/text ────────────────────────────────────
# Ce texte est la SEULE entrée de DocIE pour un .docx : ce qu'il perd n'entre
# pas dans la CVthèque. L'ancien rendu (`"".join(p.itertext())` sur chaque
# `.//w:p`) collait le texte autour des éléments vides `w:br`/`w:cr`/`w:tab`
# (`alice.dupont@example.com06 12 34 56 78Lille`), rendait les codes de champ
# et les révisions supprimées, et comptait quatre fois une zone de texte.
# Mesures et témoin : tests/test_texte_docx_docie.py. Même classe de défaut
# que mammoth.extractRawText côté one-pager (#188).
#
# DocIE découpe ce texte en blocs, une ligne non vide = un bloc, et n'en passe
# que 800 au modèle sur la plupart des profils : le nombre de lignes compte
# (#190). D'où une rangée de tableau simple sur UNE ligne.
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
# Le texte ne vient QUE de `w:t` : le code d'un champ (`w:instrText`,
# `HYPERLINK "mailto:..."`) et le texte supprimé (`w:delText`) ne sont donc
# jamais rendus ; le résultat affiché d'un champ, lui, est dans des `w:t`.
# Sous-arbres ignorés en entier : les propriétés (dont `w:pPr/w:tabs/w:tab`,
# des taquets de tabulation et non des caractères) et les révisions supprimées
# `w:del`, dont les `w:br`/`w:tab` supprimés ne doivent pas non plus compter.
# Non traité : `w:moveFrom` (origine d'un déplacement suivi).
_SANS_TEXTE = {_W + nom for nom in (
    "pPr", "rPr", "tblPr", "tblPrEx", "trPr", "tcPr", "sectPr", "tblGrid", "del",
)}
_SAUT = {_W + "br", _W + "cr"}


def _enfants(element):
    """Enfants porteurs de contenu, `mc:AlternateContent` résolu en UNE branche.

    On garde le premier `mc:Choice` : c'est ce que Word affiche (zone de texte
    DrawingML `wps`) ; `mc:Fallback` n'en est que la copie VML pour les
    lecteurs antérieurs à Word 2010, avec le même `w:txbxContent`. Lire les
    deux dupliquait le texte. Sans `mc:Choice`, on prend `mc:Fallback`."""
    for enfant in element:
        if enfant.tag == _MC + "AlternateContent":
            branche = enfant.find(_MC + "Choice")
            if branche is None:
                branche = enfant.find(_MC + "Fallback")
            if branche is not None:
                yield from _enfants(branche)
        elif enfant.tag not in _SANS_TEXTE:
            yield enfant


def _blocs(element):
    """Lignes d'un conteneur de blocs (corps, cellule, zone de texte), dans
    l'ordre du document. Les enveloppes (`w:sdt`, `w:customXml`...) sont
    traversées."""
    lignes = []
    for enfant in _enfants(element):
        if enfant.tag == _W + "p":
            lignes.append(_paragraphe(enfant))
        elif enfant.tag == _W + "tbl":
            lignes.extend(_tableau(enfant))
        else:
            lignes.extend(_blocs(enfant))
    return lignes


def _paragraphe(p):
    morceaux = []

    def parcourir(element):
        for enfant in _enfants(element):
            if enfant.tag == _W + "t":
                morceaux.append(enfant.text or "")
            elif enfant.tag in _SAUT:
                morceaux.append("\n")
            elif enfant.tag == _W + "tab":
                morceaux.append("\t")
            elif enfant.tag == _W + "txbxContent":
                # Zone de texte ancrée dans ce paragraphe : ses paragraphes
                # sont des lignes à part, à l'endroit de l'ancre.
                morceaux.append("\n" + "\n".join(_blocs(enfant)) + "\n")
            else:
                parcourir(enfant)

    parcourir(p)
    return "".join(morceaux)


def _elements(element, tag):
    """`tag` parmi les enfants, à travers les enveloppes (`w:sdt`...)."""
    for enfant in _enfants(element):
        if enfant.tag == tag:
            yield enfant
        else:
            yield from _elements(enfant, tag)


def _tableau(tbl):
    """Une rangée SIMPLE (chaque cellule tient sur une ligne) donne une ligne,
    cellules jointes par `\\t` : `Langages\\tPython, SQL` garde le lien entre
    catégorie et éléments. Une rangée de MISE EN PAGE (une cellule sur
    plusieurs lignes : barre latérale, tableau imbriqué, retour manuel) est
    lue cellule par cellule, ligne par ligne — l'aplatir détruirait toutes ses
    frontières de paragraphe. Un tableau imbriqué suit les mêmes règles."""
    lignes = []
    for rangee in _elements(tbl, _W + "tr"):
        cellules = []
        for cellule in _elements(rangee, _W + "tc"):
            contenu = _blocs(cellule)
            while contenu and not contenu[-1].strip():
                contenu.pop()
            while contenu and not contenu[0].strip():
                contenu.pop(0)
            cellules.append("\n".join(contenu))
        if not any(c.strip() for c in cellules):
            continue
        if any("\n" in c for c in cellules):
            lignes.extend(c for c in cellules if c.strip())
        else:
            lignes.append("\t".join(cellules))
    return lignes


def document_payload(path):
    """Texte d'un DOCX pour la voie texte de DocIE : {filename, text}."""
    if path.suffix.lower() != ".docx":
        raise DocIEError("Document Word attendu.")
    try:
        with ZipFile(path) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 40 * 1024 * 1024:
                raise DocIEError("Document Word trop volumineux après décompression.")
            root = ElementTree.fromstring(archive.read(info))
    except (BadZipFile, KeyError, ElementTree.ParseError):
        raise DocIEError("Document Word invalide.") from None
    try:
        text = "\n".join(_blocs(root)).strip()
    except RecursionError:
        # Imbrication pathologique (le rendu est récursif) : même refus qu'un
        # XML illisible, plutôt qu'une exception brute.
        raise DocIEError("Document Word invalide.") from None
    if not text:
        raise DocIEError("Document Word sans texte lisible : exportez-le en PDF pour l'OCR DocIE.")
    return {"filename": path.name, "text": text}


# Clés qui font d'un objet une ENVELOPPE de preuve autour d'un scalaire, plutôt
# qu'un objet du schéma. Le test est « une clé `value` ET au moins un marqueur »
# (#171).
#
# Les deux derniers manquaient, et ce n'est pas théorique : DocIE renvoie
# `{value, model_confidence}` quand son `_flatten_agent_result` échoue à
# aplatir, et `{value, model_logprob}` depuis le renommage de la
# log-probabilité. Sans eux, `unwrap` rend le DICTIONNAIRE tel quel — et comme
# `map_resume` alimente `normalize_cv_data`, un `location` de cette forme
# n'explose pas : il entre dans la CVthèque et s'affiche
# « {'value': 'Lyon', 'model_confidence': 0.82} ». Même famille de perte
# silencieuse que #174, sur la même voie.
#
# Les deux ponts partagés (document-parsing/bridge/docie_bridge.py et
# docie-bridge.js) portent la même liste, écrite trois fois en tout. Elles ne
# doivent plus pouvoir diverger dans le sens dangereux : un pont qui connaît un
# marqueur que ce fichier ignore laisserait de nouveau passer un dictionnaire.
# tests/test_enveloppe_docie.py lit donc les marqueurs directement dans la
# source des deux ponts et exige que cette liste-ci les couvre tous.
ENVELOPE_MARKERS = ("confidence", "evidence_ids", "model_confidence", "model_logprob")


def unwrap(value):
    """Strip evidence envelopes, preserving nested objects and lists."""
    if isinstance(value, dict):
        if "value" in value and any(k in value for k in ENVELOPE_MARKERS):
            return unwrap(value["value"])
        return {k: unwrap(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unwrap(v) for v in value]
    return value


def schema_rapporte(response):
    """DocIE a-t-il NOMMÉ le schéma de sa réponse ? (#177 ligne 21)

    Même question, même réponse que le bridge partagé
    (document-parsing/bridge/docie_bridge.py::parse_response, qui la pose sur
    trois sources et en fait `metadata.schema_reported`) : un schéma tu n'est
    pas un schéma vérifié, et c'est au relecteur de le savoir — pas au client
    de refuser le document pour autant.
    """
    return isinstance(response, dict) and response.get("schema_name") is not None


def map_resume(response, expected_schema="resume"):
    if not isinstance(response, dict) or not isinstance(response.get("result"), dict):
        raise DocIEError("DocIE : résultat d'extraction absent ou invalide.")
    # #177 ligne 21 : un schéma NOMMÉ et faux est refusé, un schéma TU est
    # accepté — exactement l'arbitrage des deux ports du bridge
    # (`any(item is not None and item != expected_schema ...)`), et donc le
    # même document traité par les deux services.
    #
    # Refuser l'absence coûtait une disponibilité sans rien garantir de plus :
    # la réponse est déjà corrélée à la requête (une réponse synchrone pour
    # /v1/extract/text, un event_id que nous avons reçu pour /v1/studio/runs),
    # et une réponse d'un AUTRE schéma ne survit de toute façon pas aux
    # contrôles de structure ci-dessous — un kbis n'a ni name, ni title, ni
    # experience, ni education, ni skills, donc « DocIE n'a extrait aucune
    # donnée du CV ». Le seul cas réellement perdu est un document dont le
    # schéma n'est pas nommé ET dont la forme est celle d'un CV.
    #
    # La tolérance n'est PAS un silence : `extract_resume` rend
    # `schema_reported`, que `docie_review` (PR #176) transforme en
    # avertissement `docie_schema_non_verifie`, le même code que one-pager.
    if response.get("schema_name") not in (None, expected_schema):
        raise DocIEError("DocIE : le schéma du résultat ne correspond pas au schéma demandé.")
    data = unwrap(response["result"])
    for key in ("experience", "education", "skills", "languages", "projects", "certifications"):
        rows = data.get(key) or []
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise DocIEError(f"DocIE : champ {key} invalide.")
        data[key] = rows
    if not isinstance(data.get("contact") or {}, dict):
        raise DocIEError("DocIE : coordonnées invalides.")
    for row in data["experience"]:
        row["period"] = row.get("period") or " – ".join(
            str(row[k]) for k in ("start_date", "end_date") if row.get(k)
        )
    for row in data["education"]:
        row["title"] = row.get("title") or row.get("degree") or ""
        row["subtitle"] = row.get("subtitle") or row.get("institution") or ""
        row["period"] = row.get("period") or row.get("year") or ""
    for row in data["skills"]:
        items = row.get("items") or []
        if isinstance(items, str):
            items = [items]
        if not isinstance(items, list):
            raise DocIEError("DocIE : liste de compétences invalide.")
        row["items"] = [str(v.get("item") or "") if isinstance(v, dict) else str(v)
                        for v in items if v is not None]
    interests = data.get("interests") or []
    if not isinstance(interests, list):
        raise DocIEError("DocIE : centres d'intérêt invalides.")
    data["interests"] = [str(v.get("interest") or "") if isinstance(v, dict) else str(v)
                         for v in interests if v is not None]
    if not any(data.get(k) for k in ("name", "title", "experience", "education", "skills")):
        raise DocIEError("DocIE n'a extrait aucune donnée du CV. Vérifiez le modèle et l'OCR.")
    return data


def message_chargement(eta):
    """Message pour l'utilisateur, qui relance lui-même (« échouer
    bruyamment », #194). Le `message` amont n'est jamais recopié ; le délai
    (`eta_seconds` porté par le pont) n'est cité que s'il est un nombre fini et positif ou nul."""
    if isinstance(eta, (int, float)) and not isinstance(eta, bool) and math.isfinite(eta) and eta >= 0:
        return f"DocIE : modèle en cours de chargement, réessayez dans environ {math.ceil(eta)} s."
    return "DocIE : modèle en cours de chargement, réessayez dans quelques instants."


# Codes d'échec DocIE qu'un repli externe ne doit JAMAIS rejouer.
#
# `timeout` : DocIE peut encore être en train de traiter le document — et de le
# facturer. Relancer ailleurs paie deux fois le même travail ; c'est exactement
# ce que le README du pont interdit (« ne jamais rejouer aveuglément un travail
# DocIE potentiellement facturé »).
# `input` : le document lui-même est inutilisable (vide, trop gros, binaire).
# Le fournisseur externe le refuserait pour la même raison : un second appel ne
# ferait que coûter un aller-retour de plus.
_CODES_SANS_REPLI = frozenset({"timeout", "input"})

# Messages FR par code stable du transport externe
# (document-parsing/bridge/openai_responses.py::fail). Le texte de l'exception
# elle-même n'est JAMAIS recopié dans `erreur.message` : il peut porter un corps
# de réponse amont, un chemin, voire la clé. Même arbitrage que
# docie_bridge_extraction._ERROR_MESSAGES, pour la même raison.
_MESSAGES_EXTERNE = {
    "configuration": "service mal configuré côté serveur (clé ou URL).",
    "input": "document refusé (texte vide, trop volumineux ou binaire).",
    "auth": "accès refusé. Vérifiez OPENAI_API_KEY.",
    "rate_limit": "limite de débit atteinte, réessayez plus tard.",
    "limits": "document trop volumineux pour le service.",
    "context": "document au-delà de la fenêtre de contexte du modèle.",
    "refusal": "le modèle a refusé d'extraire ce document.",
    "incomplete": "extraction non terminée par le service.",
    "upstream": "erreur côté service externe.",
    "timeout": "délai dépassé. Le traitement distant peut continuer et être facturé.",
    "network": "service externe injoignable ou échec TLS.",
    "response": "réponse invalide du service externe.",
    "schema": "réponse hors du schéma demandé.",
}


def _charger_openai():
    """Importe document-parsing/bridge/openai_responses.py à la demande.

    Même paresse que docie_bridge_extraction._load_bridge : sans modèle externe
    choisi, ce fichier n'a pas besoin d'exister. En conteneur, le Dockerfile le
    copie à côté de celui-ci ; hors conteneur (tests, checkout), il est lu
    depuis sa source unique.
    """
    try:
        import openai_responses
    except ImportError:
        pont = Path(__file__).resolve().parents[1] / "document-parsing" / "bridge"
        if str(pont) not in sys.path:
            sys.path.insert(0, str(pont))
        import openai_responses
    return openai_responses


def extraire_par_externe(texte, mode_transport, schema, progress=None, session=None):
    """Extraction par un fournisseur HORS ADBI (#194). Un appel, aucun repli.

    Le texte du CV — donnée personnelle d'un CANDIDAT — quitte ADBI ici, et
    seulement sur choix explicite d'un utilisateur averti (voir
    choix_modele.EXTERNES et templates/index.html). Jamais de second essai par
    un autre transport après un échec : rejouer un travail potentiellement
    facturé est exactement ce que le README du pont interdit.

    La réponse a la MÊME forme que celle de DocIE ({schema_name, result,
    metadata}), donc `map_resume` s'applique sans adaptateur.
    """
    openai_responses = _charger_openai()
    if progress:
        progress("Envoi du texte au service externe (hors ADBI)")
    try:
        sortie = openai_responses.extraire_via_openai(
            texte, mode=mode_transport, dynamic_schema=schema, session=session)
    except Exception as exc:
        code = getattr(exc, "code", None)
        message = _MESSAGES_EXTERNE.get(code, "échec de l'extraction.")
        raise DocIEError(f"Service externe (hors ADBI) : {message} [{code or 'inconnu'}]") from exc
    data = map_resume(sortie, "adbi_resume")
    meta = sortie.get("metadata") or {}
    return data, {
        # `transport` et `voie` : sans eux, app.py::process_cv retombait sur son
        # défaut "docie" et étiquetait la fiche « DocIE / gpt-4.1-nano » — une
        # lecture EXTERNE attribuée à DocIE, qui n'y était pour rien. Même
        # famille de fausse attribution que les avertissements DocIE tus par
        # `sans_preuve`, un étage plus haut.
        "transport": "openai",
        "voie": "texte",
        "event_id": meta.get("request_id") or "",
        "model_profile": meta.get("model") or "",
        # Ni `validation` ni confiance par champ : le transport n'ancre rien et
        # ne prétend pas le contraire. `sans_preuve` porte ce fait UNE fois, et
        # docie_review s'en sert pour taire les deux avertissements DocIE, qui
        # nommeraient sinon un service qui n'a pas participé.
        "validation": None,
        "schema_reported": meta.get("schema_reported"),
        "sans_preuve": True,
        "fournisseur": meta.get("fournisseur"),
        "mode": meta.get("mode"),
        "field_confidence": None,
        "partiel": meta.get("partiel") or [],
        "blocs_texte": None,
        "troncature_possible": meta.get("troncature_possible"),
    }


def texte_document(path):
    """Texte local d'un PDF ou d'un DOCX, pour la voie TEXTE de DocIE.

    Renvoie `(texte, raison)` :
      * `(texte, None)` — le document porte sa couche texte, exploitable ;
      * `(None, "page_sans_texte")` — au moins une page sans texte. Ce n'est
        pas une erreur en soi, c'est un FAIT sur la source : à l'appelant d'en
        décider. La voie texte refuse (aucun OCR) ; le pont actif route les
        PDF vers la voie agent, qui OCRise.

    Lève DocIEError pour ce qui est réellement illisible (PDF protégé, DOCX
    invalide) et pour un suffixe qu'aucune voie texte ne sait lire.

    Extrait d'extract_resume (#151) pour que les DEUX chemins d'extraction
    lisent le même texte par la même règle : pypdf et le rendu DOCX restent
    ici, rien n'est recopié dans docie_bridge_extraction.
    """
    suffixe = path.suffix.lower()
    if suffixe == ".pdf":
        from pypdf import PdfReader
        try:
            pages = [page.extract_text() or "" for page in PdfReader(path).pages]
        except Exception:
            raise DocIEError("PDF illisible ou protégé. Fournissez un PDF texte ou un DOCX.") from None
        if any(not page.strip() for page in pages):
            return None, "page_sans_texte"
        return "\n".join(pages), None
    if suffixe == ".docx":
        return document_payload(path)["text"], None
    raise DocIEError("La voie texte accepte PDF texte et DOCX uniquement.")


def repli_possible(exc):
    """Un échec DocIE autorise-t-il un second essai chez un fournisseur externe ?

    Faux pour les codes de `_CODES_SANS_REPLI`. Un échec sans code connu
    (client historique, cause locale) est réputé rejouable : il n'a, lui, rien
    laissé tourner à distance.
    """
    return getattr(exc, "code", None) not in _CODES_SANS_REPLI


def repli_openai(file_path, mode_transport="rapide", progress=None, session=None):
    """Second essai EXPLICITE chez un fournisseur externe, après un échec DocIE.

    N'est appelé que si l'utilisateur a coché le repli au dépôt : le texte du CV
    — donnée personnelle d'un CANDIDAT — quitte ADBI ici, et ce consentement est
    donné AVANT l'envoi, pour ce dépôt-là.

    Le texte est relu LOCALEMENT (`texte_document`, même règle que la voie texte
    de DocIE) : rien n'est redemandé au service qui vient d'échouer, et le PDF
    lui-même ne part jamais — seul son texte déjà extrait ici part.

    Un document sans couche texte (scan) ne peut pas être secouru : il n'y a
    rien à envoyer. L'échec le dit au lieu de laisser croire que le repli a été
    tenté.
    """
    path = Path(file_path)
    texte, raison = texte_document(path)
    if raison == "page_sans_texte" or not (texte or "").strip():
        raise DocIEError(
            "Repli externe impossible : ce document n'a pas de couche texte "
            "(scan ou page muette), il n'y a rien à envoyer.", "sans_texte")
    schema = json.loads(Path(__file__).with_name("adbi_resume.schema.json").read_text(encoding="utf-8"))
    return extraire_par_externe(texte, mode_transport, schema, progress=progress, session=session)


def lister_modeles_store(session=None):
    """Modèles du store DocIE via le pont partagé (GET /v1/serving/store) ; échec traduit en DocIEError nommée."""
    import docie_bridge_extraction as dbe
    pont = dbe._load_bridge()
    try:
        return pont.list_store(session=session)
    except pont.DocIEBridgeError as exc:
        dbe._echouer_pont(exc)


def extract_resume(file_path, progress=None, *, session=None, choix=None):
    """Voie texte via le pont partagé (docie_bridge_extraction.extraire_texte) ; même contrat (data, metadata)."""
    import docie_bridge_extraction
    return docie_bridge_extraction.extraire_texte(file_path, progress, session=session, choix=choix)
