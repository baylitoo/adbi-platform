"""DocIE Studio extraction client; no local OCR or model runtime."""
import base64
import json
import os
import time
from pathlib import Path
from urllib.parse import quote, urlsplit
from zipfile import ZipFile, BadZipFile
from xml.etree import ElementTree

import requests


class DocIEError(RuntimeError):
    pass


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
# Sous-arbres sans contenu : propriétés (dont `w:pPr/w:tabs/w:tab`, des taquets
# de tabulation et non des caractères), code des champs (le résultat du champ,
# lui, est dans des `w:t` ordinaires), révisions supprimées.
_SANS_TEXTE = {_W + nom for nom in (
    "pPr", "rPr", "tblPr", "tblPrEx", "trPr", "tcPr", "sectPr", "tblGrid",
    "instrText", "delInstrText", "del", "delText",
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
    """DocIE's file endpoint accepts PDF/images; DOCX uses its text input."""
    if path.suffix.lower() != ".docx":
        return {"filename": path.name, "content_b64": base64.b64encode(path.read_bytes()).decode("ascii")}
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


def extract_resume(file_path, progress=None, *, session=None):
    base = os.environ.get("DOCIE_BASE_URL", "").strip().rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise DocIEError("Configurez DOCIE_BASE_URL avec l'URL racine du service DocIE.")
    try:
        budget = float(os.environ.get("DOCIE_TIMEOUT_SECONDS", "900"))
        if not 1 <= budget <= 3600:
            raise ValueError()
    except ValueError:
        raise DocIEError("DOCIE_TIMEOUT_SECONDS doit être compris entre 1 et 3600.") from None
    path = Path(file_path)
    mode = os.environ.get("DOCIE_EXTRACTION_MODE", "inline")
    if mode not in ("inline", "studio"):
        raise DocIEError("DOCIE_EXTRACTION_MODE doit être inline ou studio.")
    payload = document_payload(path)
    if mode == "inline":
        if path.suffix.lower() == ".pdf":
            from pypdf import PdfReader
            try:
                pages = [page.extract_text() or "" for page in PdfReader(path).pages]
            except Exception:
                raise DocIEError("PDF illisible ou protégé. Fournissez un PDF texte ou un DOCX.") from None
            if any(not page.strip() for page in pages):
                raise DocIEError("PDF contenant une page sans texte : OCR requis (scan ou page vide).")
            text = "\n".join(pages)
        elif path.suffix.lower() == ".docx":
            text = payload["text"]
        else:
            raise DocIEError("Le mode inline accepte PDF texte et DOCX uniquement.")
        if not text.strip():
            raise DocIEError("PDF sans texte : OCR requis. Le mode inline ne traite pas encore les scans.")
        schema = json.loads(Path(__file__).with_name("adbi_resume.schema.json").read_text(encoding="utf-8"))
        payload = {"text": text, "schema_mode": "dynamic", "schema_name": "adbi_resume",
                   "dynamic_schema": schema}
    if mode == "studio":
        payload["dynamic_schema_name"] = os.environ.get("DOCIE_SCHEMA_NAME", "resume")
    for env, field in (("DOCIE_MODEL_PROFILE", "model_profile"), ("DOCIE_OCR_BACKEND", "ocr_backend")):
        if os.environ.get(env, "").strip() and (field != "ocr_backend" or mode == "studio"):
            payload[field] = os.environ[env].strip()
    headers = {}
    key = os.environ.get("DOCIE_API_KEY", "").strip()
    if key:
        headers["x-api-key"] = key
    deadline = time.monotonic() + budget
    owned = session is None
    session = session or requests.Session()

    def call(method, route, **kwargs):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DocIEError("DocIE : délai d'extraction dépassé. Le traitement distant peut continuer.")
        try:
            response = session.request(method, base + route, headers=headers,
                                       timeout=(min(10, remaining), remaining if mode == "inline" else min(30, remaining)), allow_redirects=False, **kwargs)
        except requests.RequestException:
            raise DocIEError("DocIE injoignable ou délai réseau dépassé. Vérifiez la connexion.") from None
        if response.status_code in (401, 403):
            raise DocIEError("DocIE : accès refusé. Vérifiez DOCIE_API_KEY.")
        if not 200 <= response.status_code < 300:
            raise DocIEError(f"DocIE : erreur HTTP {response.status_code}. Vérifiez le schéma et le service.")
        try:
            return response.json()
        except ValueError:
            raise DocIEError("DocIE : réponse JSON invalide.") from None

    try:
        if progress:
            progress("Envoi du document à DocIE")
        if mode == "inline":
            output = call("POST", "/v1/extract/text", json=payload)
            data = map_resume(output, "adbi_resume")
            return data, {"event_id": output.get("request_id", ""),
                          "model_profile": output.get("model_profile", ""),
                          "validation": output.get("validation") or {},
                          "schema_reported": schema_rapporte(output)}
        trigger = call("POST", "/v1/studio/extract", json=payload)
        ids = trigger.get("event_ids") if isinstance(trigger, dict) else None
        if not isinstance(ids, list) or not ids or not isinstance(ids[0], str) or not ids[0]:
            raise DocIEError("DocIE : identifiant de traitement absent.")
        event_id = ids[0]
        while True:
            result = call("GET", "/v1/studio/runs/" + quote(event_id, safe=""))
            rows = result.get("data", []) if isinstance(result, dict) else result
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise DocIEError("DocIE : état de traitement invalide.")
            for row in rows:
                status = str(row.get("status") or "").lower()
                # A proxy row with no ended_at is interim, even if Inngest
                # labels a failed/retried step Failed. Await the durable outcome.
                terminal = not isinstance(result, dict) or bool(row.get("ended_at"))
                if status in ("cancelled", "canceled") or (terminal and status in ("failed", "error")):
                    raise DocIEError("DocIE : extraction échouée ou annulée. Consultez le traitement dans DocIE.")
                if row.get("output") is not None:
                    output = row["output"]
                    data = map_resume(output, payload["dynamic_schema_name"])
                    return data, {"event_id": event_id, "model_profile": output.get("model_profile", ""),
                                  "validation": output.get("validation") or {},
                                  "schema_reported": schema_rapporte(output)}
                # Inngest's interim proxy can report Completed for a step while
                # the extraction is still running. Only the durable list is
                # authoritative; keep polling the wrapped {data: [...]} shape.
                if not isinstance(result, dict) and status in ("completed", "success", "succeeded"):
                    raise DocIEError("DocIE : traitement terminé sans résultat. Une version avec résultats persistés est requise.")
            if progress:
                progress("Extraction et reconnaissance de texte dans DocIE")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DocIEError("DocIE : délai d'extraction dépassé. Le traitement distant peut continuer.")
            time.sleep(min(2, remaining))
    finally:
        if owned:
            session.close()
