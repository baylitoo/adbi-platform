"""Server-side DocIE agent transport. No OCR, model runtime or remote writes.

Keep the wire contract aligned with docie-bridge.js and tests/contract.json.
Domain mapping belongs to the consuming application, not this transport.
"""
import base64
import json
import math
import os
import re
import time
from urllib.parse import urlsplit

import requests

MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MIME_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/webp"}
SCHEMAS = {"resume": "adbi_resume", "contract": "contract", "kbis": "kbis"}
# A grounded field arrives as {value, ...} alongside at least one of these keys.
# `model_confidence` is part of the set on purpose: DocIE's logprob confidence
# adds it as a fourth key, and an envelope test that ignores it lets a scalar
# reach the consumer as a dict ("Ada" becoming {"value": "Ada", ...}).
ENVELOPE_MARKERS = ("confidence", "evidence_ids", "model_confidence")


class DocIEBridgeError(RuntimeError):
    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code = code
        self.status = status


def fail(code, message, status=None):
    raise DocIEBridgeError(code, message, status)


def configuration(kind, env):
    if kind not in SCHEMAS:
        fail("configuration", "Unsupported document kind.")
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
    agent = env.get("DOCIE_AGENT_" + kind.upper(), "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", agent):
        fail("configuration", "Configure the document kind's DocIE agent name.")
    try:
        timeout = float(env.get("DOCIE_TIMEOUT_SECONDS", "360"))
        tokens = int(env.get("DOCIE_MAX_TOKENS", "8192"))
        if not math.isfinite(timeout) or not 1 <= timeout <= 3600 or not 1 <= tokens <= 65536:
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
                "schema_reported": any(item is not None for item in reported)}
    for name in ("queue_wait_ms", "latency_ms", "generation_ms"):
        value = meta.get(name, extracted.get(name, body.get(name)))
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            metadata[name] = value
    return {"schema_name": expected_schema, "result": unwrap(result), "metadata": metadata}


def extract_document(content, mime_type, *, kind="resume", env=None, session=None):
    """Send one PDF/image to the configured agent; never retry billable work.

    Caller must authorize access to the document. DOCX/text conversion is a
    consumer responsibility until a verified DocIE text-agent contract exists.
    """
    env = os.environ if env is None else env
    endpoint, key, agent, timeout, tokens = configuration(kind, env)
    if not isinstance(content, bytes) or not 0 < len(content) <= MAX_DOCUMENT_BYTES:
        fail("input", "Document must contain between 1 byte and 20 MiB.")
    if mime_type not in MIME_TYPES:
        fail("input", "Unsupported document MIME type; use PDF, PNG, JPEG or WebP.")
    payload = {"model": agent, "parallel_extraction": True, "stream": False, "max_tokens": tokens,
               "messages": [{"role": "user", "content": [
                   {"type": "text", "text": "Extract the document using your configured schema. Do not invent missing information."},
                   {"type": "image_url", "image_url": {"url": "data:" + mime_type + ";base64," + base64.b64encode(content).decode("ascii")}},
               ]}]}
    own_session = session is None
    session = session or requests.Session()
    started = time.monotonic()
    try:
        with session.post(endpoint, headers={"Authorization": "Bearer " + key}, json=payload,
                          timeout=(min(10, timeout), timeout), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                code = {401: "auth", 403: "auth", 429: "rate_limit"}.get(response.status_code, "upstream")
                fail(code, "DocIE request failed (HTTP " + str(response.status_code) + ").", response.status_code)
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
                result = parse_response(json.loads(raw), SCHEMAS[kind], agent)
            except (ValueError, UnicodeError):
                fail("response", "DocIE returned invalid JSON.")
            result["metadata"]["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            return result
    except requests.Timeout:
        fail("timeout", "DocIE timeout; remote processing may continue.")
    except requests.RequestException:
        fail("network", "DocIE network or TLS failure.")
    finally:
        if own_session:
            session.close()
