"""Server-side DocIE transport. No OCR, model runtime or remote writes.

Two entry points, one per DocIE surface, because the two surfaces are genuinely
different -- not because text is a "format" the first one could also take:

  extract_document(bytes, mime_type)  POST /v1/agents/<agent>/chat/completions
      The document travels as an `image_url` data URI and DocIE's OCR backends
      read it. Only what those backends read may be sent: PDF and images.

  extract_text(text)                  POST /v1/extract/text
      The text travels as `text` in the body, no data-URI wrapper, and DocIE
      blocks it itself. For a source that already HAS machine-readable text.

Routing rule, from DocIE's team (#180): use the structure the source actually
has. That is not "prefer the text path" -- a scanned PDF has no text at all, so
the file path stays its only option.

Keep the wire contract aligned with docie-bridge.js and tests/contract.json plus
tests/contract_text.json. Domain mapping belongs to the consuming application.
"""
import base64
import json
import math
import os
import re
import time
from urllib.parse import urlsplit

import requests

# Our own caps. DocIE's documented limits, per its team: 25 MB upload, 26 MB
# request body, 1,000,000 characters of text, 1,000 OCR blocks per document, 20,000 characters per block, 50 metadata entries, 8 pages (vision
# path only). Those are that service's DEFAULTS, not facts about the instance we
# call -- an operator sets them per deployment, and nothing DocIE exposes
# (/healthz, /readyz, /metrics, /v1/schemas) reports the values in force, so
# this copy can be wrong from a deployment's first day.
#
# The 1,000-block ceiling is the limit that bites first on a long document: a
# dense three-page PDF reaches it at a few megabytes, so MAX_DOCUMENT_BYTES
# guards the wrong dimension and no local check can see that failure coming. A
# document refused for it arrives here after the call, in one of three
# already-handled shapes: HTTP 413 -> code "limits" (below), `validation` errors
# (preserved verbatim in metadata, surfaced by the consumers), or a non-"stop"
# finish_reason -> code "incomplete". Which shape DocIE actually uses for the
# block ceiling is not recorded anywhere we can check; see #180.
#
# Plafond de la voie fichier (#190), calculé et non estimé. Le middleware DocIE
# (api.py, `enforce_request_content_length`) refuse en 413 tout corps dont
# l'en-tête Content-Length dépasse `max_request_body_mb` = 26 MiB (26*1024*1024,
# refus strict `>`), et aucun autre contrôle de taille ne s'applique au data URI
# de la voie agent. Or cette voie envoie le document en base64 (4*ceil(n/3)
# octets) dans une enveloppe JSON. Enveloppe MESURÉE en construisant la charge
# réelle, dans le pire cas autorisé ici (nom d'agent de 128 caractères,
# max_tokens 65536, `application/pdf`) : 445 octets avec `requests` (séparateurs
# ", " et ": "), 425 avec JSON.stringify côté Node. La plus grande des deux fixe
# la borne commune aux deux portages : floor((26 MiB - 445) / 4) * 3 =
# 20 446 896 octets bruts (~19,5 MiB ; 19,5 MiB pile dépasserait de 336
# octets). Au-delà, DocIE refuserait en 413 un document déjà transmis.
#
# La voie texte garde sa propre borne, inchangée : le texte n'y est pas encodé
# en base64 (`{text, schema_name, ...}`), et le plafond de 1 000 000 caractères
# de DocIE (défaut de déploiement, non vérifié ici) mord bien avant 20 MiB.
DOCIE_MAX_REQUEST_BODY_BYTES = 26 * 1024 * 1024
FILE_ENVELOPE_MAX_BYTES = 445
MAX_DOCUMENT_BYTES = (DOCIE_MAX_REQUEST_BODY_BYTES - FILE_ENVELOPE_MAX_BYTES) // 4 * 3
MAX_TEXT_BYTES = 20 * 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
# Corps d'erreur lu pour le seul classement, jamais recopié dans un message.
# DocIE tronque déjà le corps amont à 500 caractères : 64 KiB suffit largement.
MAX_ERROR_BYTES = 64 * 1024
# Dépassement de contexte du serveur de modèle (#190). Sur un profil à prompt
# « document entier », un document trop long fait refuser le prompt par
# llama-server (« request (N tokens) exceeds the available context size »,
# type `exceed_context_size_error`) ; DocIE (classify_response_error puis
# _openai_error) renvoie alors le statut amont avec error.type="upstream_error"
# et ce corps dans le message. Le statut exact est « lu, non tracé » de bout en
# bout, et 400 est aussi celui d'une requête invalide : on reconnaît donc le
# TEXTE, où qu'il soit dans le corps (JSON imbriqué échappé ou texte brut), et
# tout le reste retombe sur `upstream`.
CONTEXT_OVERFLOW = re.compile(r"exceeds the available context size|exceed_context_size_error", re.IGNORECASE)
# What the AGENT CHAT path accepts, which is not DocIE's upload allowlist.
# This transport posts the document as an `image_url` data URI to
# /v1/agents/<agent>/chat/completions, where DocIE OCRs it: liteparse renders
# PDF pages, tesseract and paddle take images. So the OCR backends, not
# `ALLOWED_UPLOAD_MIME_TYPES`, decide what may be sent here.
#
# `image/webp` was removed: DocIE's allowlist refuses it, so every WebP made a
# pointless round-trip before failing remotely. It now fails locally, named.
#
# `text/plain` and `image/tiff` are in DocIE's upload allowlist but are NOT
# added here. Text has no OCR backend behind the `image_url` wrapper: its path
# is extract_text() below, a different endpoint with a different request body --
# adding a MIME type to this set would send text through the OCR wrapper, which
# is precisely what does not work. TIFF is plausible through the wrapper but
# unverified, and acceptance depends on the deployment's OCR backend, not on the
# allowlist alone. Neither is added on a reading of someone else's
# configuration -- that is exactly how `image/webp` got here (#180).
MIME_TYPES = {"application/pdf", "image/png", "image/jpeg"}
SCHEMAS = {"resume": "adbi_resume", "contract": "contract", "kbis": "kbis", "urssaf": "urssaf"}
# A grounded field arrives as {value, ...} alongside at least one of these keys.
# The logprob key is in the set on purpose: DocIE's logprob confidence adds it as
# a fourth key, and an envelope test that ignores it lets a scalar reach the
# consumer as a dict ("Ada" becoming {"value": "Ada", ...}).
#
# BOTH logprob spellings are accepted. DocIE renamed `model_confidence` to
# `model_logprob` -- the value is a natural-log probability, not a 0-1 score, and
# the old name invited exactly that confusion -- but that rename ships in a PR
# that is not merged yet. Accepting both keeps unwrapping correct whichever side
# deploys first, and costs nothing once the rename lands.
#
# Only `confidence` is ever collected as a review signal. `model_logprob` is a
# natural-log probability (<= 0, closer to 0 = more confident), deliberately NOT
# renormalised upstream: comparing it against `confidence`'s 0-1 scale would flag
# every field carrying one, since -7.5 sits well below any 0-1 threshold. It
# ranks fields within one extraction; it is not a threshold input.
ENVELOPE_MARKERS = ("confidence", "evidence_ids", "model_confidence", "model_logprob")


class DocIEBridgeError(RuntimeError):
    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code = code
        self.status = status


def fail(code, message, status=None):
    raise DocIEBridgeError(code, message, status)


def connection(env):
    """API root, access key and timeout — what BOTH DocIE paths need.

    Split out of configuration() for extract_text(): POST /v1/extract/text has
    no agent in its URL, so requiring DOCIE_AGENT_<KIND> there would refuse a
    text extraction over a setting that call never uses.
    """
    base = env.get("DOCIE_BASE_URL", "").strip().rstrip("/")
    try:
        url = urlsplit(base)
        port = url.port
    except ValueError:
        fail("configuration", "Invalid DocIE API root URL.")
    if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ("", "/") or port == 0):
        fail("configuration", "DOCIE_BASE_URL must be the API root without credentials or path.")
    if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1") and env.get("DOCIE_ALLOW_HTTP") != "true":
        fail("configuration", "Use HTTPS or explicitly set DOCIE_ALLOW_HTTP=true for a trusted private network.")
    key = env.get("DOCIE_API_KEY", "").strip()
    if not key or "\r" in key or "\n" in key:
        fail("configuration", "Configure a valid DOCIE_API_KEY.")
    try:
        timeout = float(env.get("DOCIE_TIMEOUT_SECONDS", "360"))
        if not math.isfinite(timeout) or not 1 <= timeout <= 3600:
            raise ValueError()
    except (TypeError, ValueError):
        fail("configuration", "Invalid DocIE timeout or token budget.")
    return base, key, timeout


def configuration(kind, env):
    if kind not in SCHEMAS:
        fail("configuration", "Unsupported document kind.")
    base, key, timeout = connection(env)
    agent = env.get("DOCIE_AGENT_" + kind.upper(), "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", agent):
        fail("configuration", "Configure the document kind's DocIE agent name.")
    try:
        tokens = int(env.get("DOCIE_MAX_TOKENS", "8192"))
        if not 1 <= tokens <= 65536:
            raise ValueError()
    except (TypeError, ValueError):
        fail("configuration", "Invalid DocIE timeout or token budget.")
    return base + "/v1/agents/" + agent + "/chat/completions", key, agent, timeout, tokens


def is_envelope(value):
    return isinstance(value, dict) and "value" in value and any(key in value for key in ENVELOPE_MARKERS)


def unwrap(value):
    if isinstance(value, dict):
        if is_envelope(value):
            return unwrap(value["value"])
        return {key: unwrap(item) for key, item in value.items()}
    if isinstance(value, list):
        return [unwrap(item) for item in value]
    return value


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def field_confidences(value, path="", into=None):
    """Per-field confidence, collected before unwrap() drops the envelopes.

    DocIE grounds every field as {value, confidence, evidence_ids} and caps a
    field's confidence when it had to truncate a repeated/looping list, so the
    number is the only per-field "this is partial, have a human read it" signal
    the agent emits. unwrap() keeps the values and threw the signal away;
    consumers were left re-deriving a weaker one from emptiness alone.

    Only `confidence` is collected. `model_confidence` is a logprob score on a
    different scale, and the "<= 0.5 means review me" rule holds for the former
    only; conflating them would invent review flags DocIE never raised.

    Keys are stable across both bridges: "contact.email", "experience[0].title",
    "skills[1].items[2].item". Transport only — the review threshold and the
    mapping to an application's own field paths belong to the consumer.
    """
    into = {} if into is None else into
    if isinstance(value, dict):
        if is_envelope(value):
            if path and number(value.get("confidence")):
                into[path] = value["confidence"]
            return field_confidences(value["value"], path, into)
        for key, item in value.items():
            field_confidences(item, (path + "." + key) if path else str(key), into)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            field_confidences(item, path + "[" + str(index) + "]", into)
    return into


def reported_field_confidence(meta):
    """`docie_agent.field_confidence` — {"experience[0].title": {"confidence": 0.5}}.

    DocIE's own per-field map, authoritative when the agent emits it: same dotted
    paths, and it survives an agent that flattens its result before answering
    (there are then no envelopes left for field_confidences to read). Returns
    None when absent or unusable, so the caller falls back to the envelopes
    rather than claiming DocIE reported nothing.
    """
    raw = meta.get("field_confidence")
    if not isinstance(raw, dict):
        return None
    reported = {}
    for path, entry in raw.items():
        confidence = entry.get("confidence") if isinstance(entry, dict) else entry
        if isinstance(path, str) and path and number(confidence):
            reported[path] = confidence
    return reported


def prompt_profile(meta):
    """`docie_agent.prompt_profile` (#190) : le prompt qui a servi.

    Seul indice que le plafond silencieux de 800 blocs OCR de DocIE a PU
    s'appliquer. Transport seulement : aucune règle ici sur les profils
    plafonnés -- elle est imprécise (surévalue les profils vision, `docie_agent`
    ne porte pas `vision`) et appartient aux consommateurs. Traité comme ses
    voisins facultatifs (`field_confidence`, durées) et non comme `validation` :
    une valeur absente, non textuelle ou vide donne None (« inconnu ») au lieu de
    refuser une extraction valide pour un indice illisible.
    """
    value = meta.get("prompt_profile")
    return value if isinstance(value, str) and value else None


def parse_response(body, expected_schema, agent):
    if not isinstance(body, dict):
        fail("response", "Invalid DocIE chat envelope.")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        fail("response", "Missing DocIE completion.")
    choice = choices[0]
    if choice.get("finish_reason") != "stop":
        fail("incomplete", "DocIE did not finish extraction successfully.")
    message = choice.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        fail("response", "DocIE returned no final extraction JSON.")
    content = content.strip()
    if content.startswith("```") and content.endswith("```"):
        content = "\n".join(content.splitlines()[1:-1])
    try:
        extracted = json.loads(content)
    except ValueError:
        fail("response", "DocIE returned invalid extraction JSON.")
    if not isinstance(extracted, dict):
        fail("response", "DocIE extraction must be an object.")
    result = extracted.get("result", extracted)
    if not isinstance(result, dict) or not result:
        fail("response", "DocIE returned an empty or malformed result.")
    meta = body.get("docie_agent")
    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        fail("response", "Invalid DocIE agent metadata.")
    if meta.get("agent") is not None and meta["agent"] != agent:
        fail("schema", "DocIE responded from an unexpected agent.")
    reported = [extracted.get("schema_name"), result.get("document_type"), meta.get("schema_name")]
    if any(item is not None and item != expected_schema for item in reported):
        fail("schema", "DocIE returned an unexpected document schema.")
    validation = meta.get("validation", extracted.get("validation"))
    if validation is not None and not isinstance(validation, dict):
        fail("response", "Invalid DocIE validation metadata.")
    # No synthetic confidence/validation success when the agent omits metadata.
    confidence = reported_field_confidence(meta)
    metadata = {"request_id": body.get("id"), "agent": agent, "model": body.get("model"),
                "validation": validation, "usage": body.get("usage"),
                "field_confidence": field_confidences(result) if confidence is None else confidence,
                "prompt_profile": prompt_profile(meta),
                "schema_reported": any(item is not None for item in reported)}
    for name in ("queue_wait_ms", "latency_ms", "generation_ms"):
        value = meta.get(name, extracted.get(name, body.get(name)))
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            metadata[name] = value
    return {"schema_name": expected_schema, "result": unwrap(result), "metadata": metadata}


def parse_text_response(body, expected_schema):
    """POST /v1/extract/text answers FLAT — no `choices`, no `finish_reason`.

    A real recorded answer (document-parsing/scripts/test_api.py against the
    deployment) carries: request_id, schema_name, model_profile, document_hash,
    result, validation, usage, latency_ms, dynamic_schema, routing,
    response_format_style. The service blocks the text itself, so `result` is
    grounded exactly like the chat path's -- {value, confidence, evidence_ids}
    per leaf -- and every review signal built on that keeps working unchanged.

    Same metadata contract as parse_response, same stable error codes, with two
    honest differences that come from the endpoint, not from a choice here:
      * `agent` is None. There is no agent on this path; claiming one would
        name a component that took no part in the extraction.
      * no `incomplete` code. That code reads `finish_reason`, which a chat
        completion has and this response does not. A truncation shows up here
        as `validation` errors or an HTTP 413 -> `limits`, both already handled.
      * `prompt_profile` is None. DocIE's ExtractionResponse (extra="forbid")
        carries `model_profile` only; None here means "not reported", never
        "not capped" (#190).
    """
    if not isinstance(body, dict):
        fail("response", "Invalid DocIE extraction response.")
    result = body.get("result")
    if not isinstance(result, dict) or not result:
        fail("response", "DocIE returned an empty or malformed result.")
    # Same arbitration as the chat path: a NAMED and wrong schema is refused, a
    # SILENT one is accepted and reported as unverified (schema_reported).
    reported = [body.get("schema_name"), result.get("document_type")]
    if any(item is not None and item != expected_schema for item in reported):
        fail("schema", "DocIE returned an unexpected document schema.")
    validation = body.get("validation")
    if validation is not None and not isinstance(validation, dict):
        fail("response", "Invalid DocIE validation metadata.")
    confidence = reported_field_confidence(body)
    metadata = {"request_id": body.get("request_id"), "agent": None,
                "model": body.get("model_profile"), "validation": validation,
                "usage": body.get("usage"),
                "field_confidence": field_confidences(result) if confidence is None else confidence,
                "prompt_profile": None,
                "schema_reported": any(item is not None for item in reported)}
    for name in ("queue_wait_ms", "latency_ms", "generation_ms"):
        value = body.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            metadata[name] = value
    return {"schema_name": expected_schema, "result": unwrap(result), "metadata": metadata}


def read_error_text(response, key):
    """Lecture bornée d'un corps d'erreur, pour le seul classement.

    Un corps illisible (flux coupé, délai) vaut "" : l'échec reste classé par
    statut.
    """
    chunks, size = [], 0
    try:
        for chunk in response.iter_content(65536):
            chunks.append(chunk)
            size += len(chunk)
            if size >= MAX_ERROR_BYTES:
                break
    except requests.RequestException:
        pass
    return b"".join(chunks)[:MAX_ERROR_BYTES].decode("utf-8", "replace").replace(key, "[REDACTED]")


def post_json(endpoint, headers, payload, key, timeout, session):
    """One POST, never a retry: DocIE work is potentially billable.

    Shared by both entry points on purpose. Status classification, the response
    ceiling, the duration guard and the reflected-key redaction are the same
    guarantees whichever DocIE surface is called, and a second copy of them is
    exactly the drift this module exists to prevent.
    """
    own_session = session is None
    session = session or requests.Session()
    started = time.monotonic()
    try:
        with session.post(endpoint, headers=headers, json=payload,
                          timeout=(min(10, timeout), timeout), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                # 413 gets its own code: DocIE refuses a document that is beyond
                # the limits its deployment configures, and a named failure
                # beats a generic upstream one for the only limit we cannot
                # measure before sending.
                status = response.status_code
                code = {401: "auth", 403: "auth", 413: "limits", 429: "rate_limit"}.get(status)
                if code:
                    message = ("DocIE refused the document as beyond its configured limits (size, OCR blocks or pages)."
                               if status == 413 else "DocIE request failed (HTTP " + str(status) + ").")
                    fail(code, message, status)
                # Message constant : le corps amont sert à classer, jamais à
                # informer -- c'est ce qui garantit qu'une clé réfléchie ne sort
                # pas d'ici.
                if CONTEXT_OVERFLOW.search(read_error_text(response, key)):
                    fail("context", "DocIE's model server refused the prompt as beyond its context size: "
                                    "the document is too long for this profile.", status)
                fail("upstream", "DocIE request failed (HTTP " + str(status) + ").", status)
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    fail("response", "DocIE response exceeded 8 MiB.")
                if time.monotonic() - started > timeout:
                    fail("timeout", "DocIE timeout; remote processing may continue.")
                chunks.append(chunk)
            try:
                # Never propagate a reflected access key to app logs or a browser.
                raw = b"".join(chunks).decode("utf-8").replace(key, "[REDACTED]")
                body = json.loads(raw)
            except (ValueError, UnicodeError):
                fail("response", "DocIE returned invalid JSON.")
            return body, round((time.monotonic() - started) * 1000)
    except requests.Timeout:
        fail("timeout", "DocIE timeout; remote processing may continue.")
    except requests.RequestException:
        fail("network", "DocIE network or TLS failure.")
    finally:
        if own_session:
            session.close()


def file_payload(content, mime_type, agent, tokens):
    """Corps de la voie fichier.

    Isolé pour que le test de borne mesure la charge réellement envoyée : toute
    modification de l'enveloppe (texte d'instruction, nouveau champ) doit
    repasser sous FILE_ENVELOPE_MAX_BYTES, sinon ce test casse.
    """
    return {"model": agent, "parallel_extraction": True, "stream": False, "max_tokens": tokens,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "Extract the document using your configured schema. Do not invent missing information."},
                {"type": "image_url", "image_url": {"url": "data:" + mime_type + ";base64," + base64.b64encode(content).decode("ascii")}},
            ]}]}


def extract_document(content, mime_type, *, kind="resume", env=None, session=None):
    """Send one PDF/image to the configured agent; never retry billable work.

    Caller must authorize access to the document. DOCX and text are not sent
    here: the `image_url` wrapper feeds DocIE's OCR backends, which read PDF and
    images only. A source that already carries machine-readable text goes to
    extract_text() instead -- a different endpoint, not a MIME type to add here.
    """
    env = os.environ if env is None else env
    endpoint, key, agent, timeout, tokens = configuration(kind, env)
    if not isinstance(content, bytes) or not 0 < len(content) <= MAX_DOCUMENT_BYTES:
        fail("input", "Document must contain between 1 byte and " + str(MAX_DOCUMENT_BYTES)
             + " bytes (DocIE's 26 MiB request body, base64 included).")
    if mime_type not in MIME_TYPES:
        fail("input", "Unsupported document MIME type; use PDF, PNG or JPEG.")
    payload = file_payload(content, mime_type, agent, tokens)
    body, elapsed = post_json(endpoint, {"Authorization": "Bearer " + key}, payload, key, timeout, session)
    result = parse_response(body, SCHEMAS[kind], agent)
    result["metadata"]["elapsed_ms"] = elapsed
    return result


def extract_text(text, *, kind="resume", dynamic_schema=None, env=None, session=None):
    """Send already-readable text to POST /v1/extract/text. One call, no retry.

    For a source that HAS machine-readable text -- a .txt, a DOCX's paragraphs,
    a PDF whose text layer was already read. Not a fallback for the file path:
    a scanned document has no text to send and belongs to extract_document().

    Request body, ported from the one shape with a recorded successful grounded
    answer in this repo (cv-parser/docie_client.py L169 and
    document-parsing/scripts/test_api.py, whose response is the fixture behind
    tests/contract_text.json): {text, schema_name, schema_mode, dynamic_schema}.
    Nothing from the chat path is sent -- no `model`, `messages` or `max_tokens`
    -- because nothing shows this endpoint reads them.

    `dynamic_schema` is the caller's JSON schema and stays the caller's: a
    transport does not own a business schema. It is not optional in practice for
    a CUSTOM schema -- register_and_test.py records that `schema_name` alone
    resolves only DocIE's small built-in registry, so `adbi_resume` needs its
    definition in the request -- but omitting it is allowed for the built-in
    names rather than refused on an assumption about someone's deployment.

    `ocr_blocks` is deliberately absent. DocIE splits the text itself, and for
    plain text there is nothing better to offer; cv-parser's DOCX path has sent
    text without it since it was written. It becomes an optional argument passed
    straight through the day a caller can prove better segmentation.
    """
    env = os.environ if env is None else env
    if kind not in SCHEMAS:
        fail("configuration", "Unsupported document kind.")
    base, key, timeout = connection(env)
    schema = SCHEMAS[kind]
    if not isinstance(text, str) or not text.strip():
        fail("input", "Document text must not be empty.")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        fail("input", "Document must contain between 1 byte and 20 MiB.")
    payload = {"text": text, "schema_name": schema}
    if dynamic_schema is not None:
        if not isinstance(dynamic_schema, dict) or not dynamic_schema:
            fail("input", "dynamic_schema must be a non-empty schema object.")
        declared = dynamic_schema.get("document_type")
        if declared is not None and declared != schema:
            fail("input", "dynamic_schema describes another document type.")
        payload["schema_mode"] = "dynamic"
        payload["dynamic_schema"] = dynamic_schema
    profile = env.get("DOCIE_MODEL_PROFILE", "").strip()
    if profile:
        payload["model_profile"] = profile
    # `x-api-key`, not `Authorization: Bearer`: that is the header every
    # recorded success on this endpoint used (cv-parser/docie_client.py, the
    # response saved by document-parsing/scripts/test_api.py). The chat path
    # keeps its own header, equally by measurement.
    body, elapsed = post_json(base + "/v1/extract/text", {"x-api-key": key}, payload, key, timeout, session)
    result = parse_text_response(body, schema)
    result["metadata"]["elapsed_ms"] = elapsed
    return result
