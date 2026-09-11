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
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    text = "\n".join("".join(p.itertext()) for p in root.findall(".//w:p", ns)).strip()
    if not text:
        raise DocIEError("Document Word sans texte lisible : exportez-le en PDF pour l'OCR DocIE.")
    return {"filename": path.name, "text": text}


# Clés qui signalent une enveloppe de champ ancré {value, ...}. La clé de logprob
# en fait partie : la confiance par logprob de DocIE l'ajoute comme quatrième clé,
# et une détection qui l'ignore laisse un scalaire arriver sous forme de dict —
# « Ada » devenant {"value": "Ada", ...} jusque dans la fiche.
#
# Les DEUX orthographes de la clé logprob sont acceptées : DocIE a renommé
# `model_confidence` en `model_logprob` (la valeur est une log-probabilité
# naturelle, pas un score 0-1 — l'ancien nom invitait précisément à cette
# confusion), mais ce renommage est dans une PR non mergée. Accepter les deux
# garde le déballage correct quel que soit le côté qui déploie en premier.
#
# Seul `confidence` sert de signal de revue. `model_logprob` est une
# log-probabilité (<= 0, plus proche de 0 = plus confiant), volontairement NON
# renormalisée en amont : la comparer au seuil 0-1 de `confidence` signalerait
# tous les champs qui en portent une (-7,5 est très en dessous de tout seuil
# 0-1). Elle classe les champs entre eux, elle n'alimente pas un seuil.
# Même liste que document-parsing/bridge/docie_bridge.py::ENVELOPE_MARKERS.
_MARQUEURS_ENVELOPPE = ("confidence", "evidence_ids", "model_confidence", "model_logprob")


def unwrap(value):
    """Strip evidence envelopes, preserving nested objects and lists."""
    if isinstance(value, dict):
        if "value" in value and any(cle in value for cle in _MARQUEURS_ENVELOPPE):
            return unwrap(value["value"])
        return {k: unwrap(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unwrap(v) for v in value]
    return value


def map_resume(response, expected_schema="resume"):
    if not isinstance(response, dict) or not isinstance(response.get("result"), dict):
        raise DocIEError("DocIE : résultat d'extraction absent ou invalide.")
    if response.get("schema_name") != expected_schema:
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
                          "validation": output.get("validation") or {}}
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
                                  "validation": output.get("validation") or {}}
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
