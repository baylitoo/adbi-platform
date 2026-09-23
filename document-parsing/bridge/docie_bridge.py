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
import sys
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
# type `exceed_context_size_error`).
#
# VOIE AGENT SEULEMENT. Là, le runtime emballe l'échec en
# `AgentError(status_code=…, error_type="upstream_error")` : le statut amont
# ressort et le corps amont est dans `message`, donc la regex ci-dessous le
# reconnaît. Le statut exact est « lu, non tracé » de bout en bout, et 400 est
# aussi celui d'une requête invalide : on reconnaît donc le TEXTE, où qu'il soit
# dans le corps (JSON imbriqué échappé ou texte brut).
#
# SUR /v1/extract/text, CETTE REGEX NE PEUT JAMAIS SE DÉCLENCHER, et ce n'est
# pas une fragilité de formulation : le message n'arrive pas du tout. Mesuré chez
# DocIE (exécution des pannes derrière la route, sans modèle ni réseau) :
# dépassement de contexte, 503 de chargement, 429, lecture expirée, file saturée,
# sortie tronquée, réponse non-JSON — TOUT ressort en HTTP 500 avec le corps en
# texte brut « Internal Server Error ». Pas de JSON, pas de type d'erreur, pas
# d'en-tête. La route appelle `extract_from_text` sans try/except, les erreurs de
# passerelle sont de simples RuntimeError et l'application n'a aucun gestionnaire
# d'exception : le 500 par défaut de FastAPI est tout ce qui reste, et le message
# amont est jeté avant de nous parvenir.
#
# Conséquence à connaître avant de s'y fier : sur la voie texte, un document trop
# long ressort en `upstream` (« le service a répondu en erreur ») et non en
# `context` (« document trop long »). `upstream` n'y est donc pas « tout le
# reste » mais « toute défaillance du modèle », indistinguables. Le correctif
# appartient à DocIE (mapper les erreurs de passerelle vers des statuts, comme le
# fait déjà la voie agent) ; rien ici ne peut le rattraper.
#
# Tout ce qui n'est pas reconnu retombe sur `upstream`.
CONTEXT_OVERFLOW = re.compile(r"exceeds the available context size|exceed_context_size_error", re.IGNORECASE)
# Plafond silencieux de blocs de la voie texte (#190). Sans `ocr_blocks` fournis
# par l'appelant, DocIE (ocr/base.py, `text_to_blocks`) fait UN bloc par ligne
# non vide : `sum(1 for ligne in texte.splitlines() if ligne.strip())`, sans
# fenêtre de caractères. Tout profil à prompt générique ne garde ensuite que les
# 800 premiers (`render_ocr_blocks(blocks, max_blocks=800)`), en HTTP 200 et sans
# aucun avertissement. Le bridge ne connaît pas le profil servi : il rapporte un
# fait de transport, « a pu être tronqué », jamais « a été tronqué ». Ce portage
# reprend la règle DocIE à la lettre ; le portage JS la recopie avec une classe
# explicite (voir docie-bridge.js), et
# document-parsing/fixtures/blocs_texte_docie.json (tests seuls) fige les deux.
DOCIE_BLOCS_TEXTE_MAX = 800
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
SCHEMAS = {"resume": "adbi_resume", "contract": "contract", "kbis": "kbis", "urssaf": "urssaf", "rib": "rib"}
# Blocs fournis par l'appelant (voie texte). Quand `ocr_blocks` voyage, DocIE ne
# découpe plus rien : `extract/service.py:357` fait
# `blocks = ocr_blocks if ocr_blocks is not None else text_to_blocks(text or "")`.
# Ce sont donc NOS blocs qui sont comptés, mis dans le prompt et ancrés, et nos
# `id` qui reviennent verbatim dans `evidence_ids` — un document dont le texte
# fait 2 000 lignes non vides tient en 300 blocs de paragraphes et cesse d'être
# tronqué. Les plafonds ci-dessous sont ceux d'`api.py::validate_text_request`,
# qui répond 413 : les vérifier ici, c'est refuser avant l'aller-retour.
# Lecture du code DocIE (origin/dev-agents-milestone, pointe c8c010e) par la
# session DocIE le 2026-09-16 ; aucun appel distant depuis ce dépôt.
DOCIE_BLOCS_OCR_MAX = 1000
DOCIE_BLOC_CARACTERES_MAX = 20000
DOCIE_TEXTE_CARACTERES_MAX = 1000000
# `OCRBlock` (schemas/common.py:16-24) n'a PAS `extra="forbid"` : une clé
# inconnue — `pages` pour `page` — y serait silencieusement ignorée et
# l'appelant croirait avoir paginé. D'où une liste blanche et un refus nommé.
BLOC_CLES = frozenset(("id", "text", "page", "bbox", "source", "confidence"))
BLOC_SOURCES = ("pdf_text", "pdf_inspector", "tesseract", "paddleocr", "manual", "unknown")
BBOX_CLES = ("x0", "y0", "x1", "y1")
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
    # `eta_seconds` : renseigné par `loading` (délai annoncé par DocIE dans
    # `detail.eta_seconds`) et par `rate_limit` (en-tête `Retry-After`, quand
    # DocIE l'émet) ; None partout ailleurs. Nombre fini >= 0. Même nom que
    # côté Node.
    #
    # Les deux ne disent pas la même chose : `loading` annonce une estimation de
    # chargement, `rate_limit` la LONGUEUR de la fenêtre de quota, qui ne décroît
    # pas quand la fenêtre se vide. Un consommateur qui l'affiche doit le dire
    # comme un ordre de grandeur, pas comme un compte à rebours.
    def __init__(self, code, message, status=None, eta_seconds=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.eta_seconds = eta_seconds


def fail(code, message, status=None, eta_seconds=None):
    raise DocIEBridgeError(code, message, status, eta_seconds)


def rediger(valeur, key):
    """Retire la clé de toute VALEUR texte d'un corps JSON déjà lu ; les noms de champs ne sont jamais réécrits."""
    if isinstance(valeur, str):
        return valeur.replace(key, "[REDACTED]") if key else valeur
    if isinstance(valeur, list):
        return [rediger(v, key) for v in valeur]
    if isinstance(valeur, dict):
        return {k: rediger(v, key) for k, v in valeur.items()}
    return valeur


# Message français par code stable, la seule table de la plateforme ; le texte anglais du pont ne s'affiche jamais.
MESSAGES_ERREUR = {
    "loading": "Modèle en cours de chargement, réessayez dans quelques instants.",
    "context": "Document trop long pour le modèle d'extraction.",
    "timeout": "L'extraction a dépassé le délai imparti.",
    "limits": "Document refusé par le service d'extraction : au-delà de ses limites (taille, pages ou blocs OCR).",
    "upstream": "Le service d'extraction a répondu en erreur.",
    "network": "Service d'extraction injoignable.",
    "input": "Document refusé par le service d'extraction.",
    "configuration": "Service d'extraction mal configuré.",
    "auth": "Accès au service d'extraction refusé (configuration).",
    "rate_limit": "Service d'extraction saturé, réessayez plus tard.",
    "response": "Réponse du service d'extraction invalide.",
    "incomplete": "Extraction inachevée par le service d'extraction.",
    "schema": "Le service d'extraction a renvoyé un autre type de document.",
}


def message_erreur(exc):
    """{code, message, eta_seconds?} présentable pour une erreur du pont (objet à `code`, `eta_seconds`) ; code inconnu : None."""
    code = getattr(exc, "code", None)
    if not isinstance(code, str) or code not in MESSAGES_ERREUR:
        return None
    if code == "loading":
        eta = getattr(exc, "eta_seconds", None)
        if isinstance(eta, (int, float)) and not isinstance(eta, bool) and math.isfinite(eta) and eta >= 0:
            n = math.ceil(eta)
            return {"code": code, "message": f"Modèle en cours de chargement, réessayez dans ~{n} s.", "eta_seconds": n}
    return {"code": code, "message": MESSAGES_ERREUR[code]}


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


# Nom d'agent DocIE : une seule règle, pour DOCIE_AGENT_<KIND> comme pour
# l'option `agent` par appel (#194). Il entre tel quel dans le chemin d'URL.
AGENT_NAME = re.compile(r"[A-Za-z0-9_-]{1,128}")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")


# Choix par appel (#194) : identifiant de modèle (`model_profile`, voie texte) ou
# agent (`agent`, voie agent) choisi par l'utilisateur pour CETTE action.
#
# Le bridge est un transport : il valide la FORME, jamais la politique. Aucune
# liste de modèles autorisés ici -- ce qu'un utilisateur peut choisir est
# l'affaire du catalogue (#194 étape 2, côté consommateurs). Ne pas ajouter de
# liste au transport.
#
# Échec en `input`, comme `dynamic_schema`, sa voisine par appel : c'est la
# valeur de l'appelant qui est refusée. `configuration` reste aux variables
# d'environnement (cv-parser l'affiche comme « mal configuré côté serveur »).
#
# `model_profile` : pas la règle AGENT_NAME, qui refuserait `store:lfm2.5-2.6b`
# (`:` et `.`), la seule forme qui déclenche le chargement à la demande. Règle
# de la clé d'accès (non vide après strip, sans retour ligne), étendue à tout
# caractère de contrôle, et plafond de 128 d'AGENT_NAME, compté en octets UTF-8
# pour que les deux portages bornent la même chose. Envoyé après strip, comme
# DOCIE_MODEL_PROFILE ; `store:<nom>` passe sans autre transformation.
def per_call_agent(value):
    agent = value.strip() if isinstance(value, str) else ""
    if not AGENT_NAME.fullmatch(agent):
        fail("input", "Invalid per-call DocIE agent name.")
    return agent


# Code de langue envoyé à DocIE sur la voie texte (voir extract_text).
#
# POURQUOI valider ici, et c'est le seul motif nécessaire : DocIE ne valide RIEN
# (`language: str | None`, schemas/api.py:26, aucun validateur) et la valeur
# entre VERBATIM dans un prompt. Vrai sans condition.
#
# CE QU'ELLE FAIT vraiment sur cette voie : des prompts, rien d'autre.
# `extract_from_text` (extract/service.py:344-384) découpe en blocs et extrait
# sans jamais instancier d'OCR. La fabrique `get_ocr_backend` (ocr/factory.py:32)
# et le raise de `PaddleOCRBackend(lang=...)` (:41-42) ne sont atteints que
# depuis `extract_from_file` (extract/service.py:452) et `_extract_pipeline`
# (:557), qui exigent un chemin de fichier. Sur /v1/extract/text un code mal
# formé est donc COSMÉTIQUE : une mauvaise ligne de prompt, pas une panne.
# Ne pas invoquer l'OCR pour justifier ce garde-fou.
#
# PORTÉE RÉELLE, à ne pas surestimer : la ligne « Language: ... »
# (llm/prompts.py:223) n'est rendue que par les profils de prompt GÉNÉRIQUES ;
# `nuextract3`, `nuextract_v1` et `document_only` n'en rendent AUCUNE. Le second
# site (llm/prompts.py:324) appartient au proposeur de schéma, jamais atteint
# puisque ce pont envoie toujours `dynamic_schema`. La valeur n'est pas relue
# dans la réponse.
#
# FORME seulement -- lettres ASCII, tiret admis (« fr », « fr-FR ») -- jamais une
# liste de langues autorisées : ce transport ne décide pas lesquelles existent.
#
# Sources lues sur origin/dev-agents-milestone @ c8c010e ; aucun appel distant.
CODE_LANGUE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$")


def code_langue(value):
    code = value.strip() if isinstance(value, str) else ""
    if not CODE_LANGUE.fullmatch(code):
        fail("input", 'Invalid language code; use a form such as "fr" or "fr-FR".')
    return code


def per_call_model_profile(value):
    profile = value.strip() if isinstance(value, str) else ""
    if not profile or CONTROL_CHARACTERS.search(profile) or len(profile.encode("utf-8")) > 128:
        fail("input", "Invalid per-call DocIE model profile.")
    return profile


def configuration(kind, env, agent_override=None):
    """`agent_override` : agent choisi pour cet appel.

    DOCIE_AGENT_<KIND> n'est alors pas lu du tout (même raisonnement que
    connection() : ne pas exiger un réglage que l'appel n'utilise pas). L'URL,
    `model` et l'agent attendu dans la réponse viennent de la même variable.
    """
    if kind not in SCHEMAS:
        fail("configuration", "Unsupported document kind.")
    base, key, timeout = connection(env)
    if agent_override is not None:
        agent = per_call_agent(agent_override)
    else:
        agent = env.get("DOCIE_AGENT_" + kind.upper(), "").strip()
        if not AGENT_NAME.fullmatch(agent):
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


ENTIER_DECIMAL = re.compile(r"[0-9]+")


def entier_positif(valeur):
    """En-tete `Retry-After` -> secondes entieres non negatives, sinon None.

    L'en-tete est une CHAINE quand il est la, absent sinon. La RFC autorise
    aussi une date HTTP ; DocIE n'en emet pas, et deviner un fuseau serait pire
    que ne rien dire -- donc seules les secondes sont lues, tout le reste vaut
    None et laisse le message vague en place.

    `[0-9]` et non `\\d` ni `str.isdigit()` : ces deux-la acceptent aussi les
    chiffres arabes-indiens, pas le `[0-9]` de JS (#179 ligne A15). Les deux
    portages doivent refuser « ٣٠ » de la meme facon.
    """
    if not isinstance(valeur, str):
        return None
    texte = valeur.strip()
    if not ENTIER_DECIMAL.fullmatch(texte):
        return None
    n = int(texte)
    return n if n <= 2 ** 53 - 1 else None


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


def field_evidence(value, path="", into=None):
    """Identifiants de preuve par champ, relevés avant que unwrap() ne jette les enveloppes ; mêmes clés que field_confidences."""
    into = {} if into is None else into
    if isinstance(value, dict):
        if is_envelope(value):
            ids = value.get("evidence_ids")
            if path and isinstance(ids, list):
                propres = [i for i in ids if isinstance(i, str) and i]
                if propres:
                    into[path] = propres
            return field_evidence(value["value"], path, into)
        for key, item in value.items():
            field_evidence(item, (path + "." + key) if path else str(key), into)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            field_evidence(item, path + "[" + str(index) + "]", into)
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


def compter_blocs_texte(text):
    """Nombre de blocs que DocIE fera de `text` (voir DOCIE_BLOCS_TEXTE_MAX)."""
    return sum(1 for ligne in text.splitlines() if ligne.strip())


def valider_blocs_ocr(blocs):
    """Valide les `ocr_blocks` de l'appelant et rend la copie exacte à envoyer.

    Le pont reste un transport : il ne FABRIQUE aucun bloc (découper un DOCX ou
    une couche texte de PDF demande de connaître le document, ce qui appartient
    au consommateur), il vérifie la forme et les plafonds pour que l'échec soit
    local et nommé plutôt qu'un 413 ou un 422 après l'appel.

    Copie plutôt que passe-plat : seules les six clés du modèle DocIE partent,
    ce qui garantit qu'aucune donnée voisine de l'appelant ne fuit dans la
    requête.

    Règle figée par document-parsing/fixtures/blocs_ocr_docie.json (tests
    seuls), où chaque refus porte sa `preuve` -- fichier:ligne côté DocIE, ou
    [J] quand c'est notre jugement et non une contrainte de leur côté.

    Rend (blocs_propres, octets) ; les caractères sont comptés ici, en points de
    code comme `len()` côté DocIE (le portage JS doit éviter `.length`).
    """
    if not isinstance(blocs, list):
        fail("input", "ocr_blocks must be an array of OCR blocks.")
    # `[]` n'est PAS un repli sur `text` : `[] is not None`, donc DocIE extrait
    # de rien et répond 200 avec un résultat vide (extract/service.py:357).
    if not blocs:
        fail("input", "ocr_blocks must not be empty: DocIE then extracts from no block at all instead of falling back to the text.")
    if len(blocs) > DOCIE_BLOCS_OCR_MAX:
        fail("input", "ocr_blocks holds " + str(len(blocs)) + " blocks, beyond DocIE's " + str(DOCIE_BLOCS_OCR_MAX) + " per document.")
    vus = set()
    propres = []
    caracteres = 0
    octets = 0
    for index, bloc in enumerate(blocs):
        ou = " (ocr_blocks[" + str(index) + "])"
        if not isinstance(bloc, dict):
            fail("input", "Each OCR block must be an object" + ou + ".")
        for cle in bloc:
            if cle not in BLOC_CLES:
                fail("input", 'Unknown OCR block key "' + str(cle) + '"' + ou + "; DocIE would drop it silently.")
        identifiant = bloc.get("id")
        if not isinstance(identifiant, str) or not identifiant:
            fail("input", "Each OCR block needs a non-empty string id" + ou + "; it comes back verbatim in evidence_ids.")
        if identifiant in vus:
            fail("input", 'Duplicate OCR block id "' + identifiant + '"' + ou + "; an evidence id must name exactly one block.")
        vus.add(identifiant)
        texte = bloc.get("text")
        if not isinstance(texte, str):
            fail("input", "Each OCR block needs a string text" + ou + ".")
        # Blanc au sens de `str.strip()`, la règle DocIE elle-même : un bloc
        # blanc est écarté du prompt (llm/prompts.py:139) APRÈS que la tranche
        # des 800 premiers l'a compté (`blocks[:max_blocks]`), donc il coûte une
        # place et n'ancre rien. Le refuser garde `blocs_texte` égal aux blocs
        # utiles. Le portage JS ne peut pas utiliser trim() ici (﻿).
        if not texte.strip():
            fail("input", "Blank OCR block text" + ou + "; DocIE drops it from the prompt after it has taken one of its " + str(DOCIE_BLOCS_TEXTE_MAX) + " slots.")
        if len(texte) > DOCIE_BLOC_CARACTERES_MAX:
            fail("input", "OCR block text of " + str(len(texte)) + " characters" + ou + ", beyond DocIE's " + str(DOCIE_BLOC_CARACTERES_MAX) + ".")
        caracteres += len(texte)
        octets += len(texte.encode("utf-8"))
        propre = {"id": identifiant, "text": texte}
        if "page" in bloc:
            page = bloc["page"]
            # DocIE accepte n'importe quel entier ; une page < 1 ne désigne
            # aucune page et rendrait impossible le filtrage des evidence_ids.
            if not isinstance(page, int) or isinstance(page, bool) or page < 1:
                fail("input", "OCR block page must be an integer >= 1" + ou + ".")
            propre["page"] = page
        if "source" in bloc:
            if bloc["source"] not in BLOC_SOURCES:
                fail("input", "Unknown OCR block source" + ou + "; DocIE accepts " + ", ".join(BLOC_SOURCES) + ".")
            propre["source"] = bloc["source"]
        if "confidence" in bloc:
            if not number(bloc["confidence"]) or not 0 <= bloc["confidence"] <= 1:
                fail("input", "OCR block confidence must be a number between 0 and 1" + ou + ".")
            propre["confidence"] = bloc["confidence"]
        if "bbox" in bloc:
            boite = bloc["bbox"]
            if (not isinstance(boite, dict) or len(boite) != len(BBOX_CLES)
                    or not all(number(boite.get(cle)) for cle in BBOX_CLES)):
                fail("input", "OCR block bbox must carry the four finite numbers x0, y0, x1, y1" + ou + ".")
            propre["bbox"] = {cle: boite[cle] for cle in BBOX_CLES}
        propres.append(propre)
    if caracteres > DOCIE_TEXTE_CARACTERES_MAX:
        fail("input", "ocr_blocks total " + str(caracteres) + " characters, beyond DocIE's " + str(DOCIE_TEXTE_CARACTERES_MAX) + ".")
    return propres, octets


# Résultat partiel (#194, « échouer bruyamment »). DocIE ne signale une valeur
# perdue que par des AVERTISSEMENTS, avec `validation.valid` toujours vrai :
# sans ce relevé, une extraction partielle ressemble à une extraction complète.
# `metadata["partiel"] = [{champ, raison}]` les rend lisibles par machine ; le
# bridge ne décide rien (refuser, signaler : c'est aux consommateurs).
#
# ATTENTION : ces libellés sont des chaînes lisibles tirées du code DocIE (lu
# par l'équipe DocIE, jamais exécuté sur notre déploiement), PAS un contrat
# versionné. Ils sont figés par document-parsing/fixtures/avertissements_docie.json
# (tests seuls) : si DocIE change un libellé, un test doit casser, plutôt que la
# règle s'affaiblir en silence. Un avertissement inconnu est ignoré pour
# `partiel` (jamais deviné) ; tous restent intacts dans `validation`.
#
# Le champ est ce qui précède le premier ": " -- un chemin sans blanc ni ":"
# (`skills`, `experience[0].end_date`), sinon l'avertissement est ignoré.
# Classes et motifs identiques caractère pour caractère à docie-bridge.js.
RAISONS_PARTIEL = ("boucle", "valeur_abandonnee", "forme_invalide", "feuille_abandonnee", "liste_plafonnee_possible")
CHAMP_AVERTISSEMENT = re.compile(r"[^\t\n\v\f\r :]+")
# Boucle (PR DocIE #485) : "<champ>: model output repeated itself (<motif>);
# list truncated at the loop start, remaining items dropped; confidence capped
# to 0.5 as a review flag". Reconnue à sa sous-chaîne stable, AVANT les autres
# formes : le motif répété peut contenir ": " ou "; dropped".
AVERTISSEMENT_BOUCLE = ": model output repeated itself ("
MOTIFS_AVERTISSEMENT = (
    # "<nom>: <brut> is not a number; value dropped" / "... is not a currency; value dropped"
    (re.compile(r"([^\t\n\v\f\r :]+): [\s\S]* is not a (?:number|currency); value dropped"), "valeur_abandonnee"),
    # "<chemin>: the model wrote <texte> in a shape this field cannot hold; nothing was kept"
    (re.compile(r"([^\t\n\v\f\r :]+): the model wrote [\s\S]* in a shape this field cannot hold; nothing was kept"),
     "forme_invalide"),
    # "<chemin>: <message pydantic>; dropped" (une feuille invalide abandonnée par passe)
    (re.compile(r"([^\t\n\v\f\r :]+): [\s\S]+; dropped"), "feuille_abandonnee"),
)
# Plafond `maxItems: 100` des listes contraintes par grammaire : AUCUNE trace
# côté DocIE. Une liste d'exactement 100 éléments « a pu » être plafonnée ;
# 101 n'est pas ce plafond (NuExtract3, sans grammaire, n'en a pas).
DOCIE_LISTE_MAX = 100


def reconnaitre_avertissement(texte):
    if not isinstance(texte, str):
        return None
    boucle = texte.find(AVERTISSEMENT_BOUCLE)
    if boucle >= 0:
        champ = texte[:boucle]
        return {"champ": champ, "raison": "boucle"} if CHAMP_AVERTISSEMENT.fullmatch(champ) else None
    for motif, raison in MOTIFS_AVERTISSEMENT:
        trouve = motif.fullmatch(texte)
        if trouve:
            return {"champ": trouve.group(1), "raison": raison}
    return None


def resultat_partiel(validation, result):
    """Un seul endroit pour les deux voies.

    `result` est DÉJÀ déballé (une liste dans une enveloppe ancrée compte comme
    liste). Sources : `validation.warnings` et `result.extraction_notes` (la
    voie texte y recopie la même chaîne) ; une paire (champ, raison) n'apparaît
    qu'une fois. Entrées non textuelles ignorées.
    """
    partiel, vus = [], set()

    def ajouter(champ, raison):
        if (champ, raison) not in vus:
            vus.add((champ, raison))
            partiel.append({"champ": champ, "raison": raison})

    sources = (validation.get("warnings") if isinstance(validation, dict) else None,
               result.get("extraction_notes") if isinstance(result, dict) else None)
    for source in sources:
        if not isinstance(source, list):
            continue
        for texte in source:
            reconnu = reconnaitre_avertissement(texte)
            if reconnu:
                ajouter(reconnu["champ"], reconnu["raison"])

    def parcourir(value, path):
        if isinstance(value, list):
            if len(value) == DOCIE_LISTE_MAX:
                ajouter(path, "liste_plafonnee_possible")
            for index, item in enumerate(value):
                parcourir(item, path + "[" + str(index) + "]")
        elif isinstance(value, dict):
            for key, item in value.items():
                parcourir(item, (path + "." + str(key)) if path else str(key))

    parcourir(result, "")
    return partiel


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
    unwrapped = unwrap(result)
    # `blocs_texte` / `troncature_possible` / `blocs_fournis` : None sur cette voie, « non
    # mesurable » et non « non tronqué » -- c'est l'OCR distant qui fait les blocs.
    metadata = {"request_id": body.get("id"), "agent": agent, "model": body.get("model"),
                "validation": validation, "usage": body.get("usage"),
                "field_confidence": field_confidences(result) if confidence is None else confidence,
                "evidence": field_evidence(result),
                "prompt_profile": prompt_profile(meta),
                "partiel": resultat_partiel(validation, unwrapped),
                "blocs_texte": None, "troncature_possible": None, "blocs_fournis": None,
                "schema_reported": any(item is not None for item in reported)}
    for name in ("queue_wait_ms", "latency_ms", "generation_ms"):
        value = meta.get(name, extracted.get(name, body.get(name)))
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            metadata[name] = value
    return {"schema_name": expected_schema, "result": unwrapped, "metadata": metadata}


def loading_detail(body):
    """Démarrage à froid sur la voie texte (#194).

    Un `model_profile` `store:<nom>` dont le modèle n'est pas encore chargé :
    `api.resolve_profile` de DocIE déclenche le chargement et lève
    HTTPException(status_code=202) SANS mettre la requête en file -- corps
    `{"detail": {"status": "loading", "deployment", "eta_seconds", "message"}}`,
    aucun `result`. Code `loading`, délai annoncé porté par
    DocIEBridgeError.eta_seconds, message constant : le `message` amont n'est
    jamais recopié (même garantie sur la clé que `context`). Pas de relance
    automatique, décision « échouer bruyamment » de #194 : le consommateur
    affiche le délai, l'utilisateur relance.
    """
    if not isinstance(body, dict):
        return None
    # Routeur chat (rerank, chat) : corps PLAT `{"status": "loading", …}`, sans `detail`.
    if body.get("status") == "loading":
        return body
    detail = body.get("detail")
    return detail if isinstance(detail, dict) and detail.get("status") == "loading" else None


def fail_loading(detail, status):
    eta = detail.get("eta_seconds") if detail else None
    fail("loading", "DocIE is still loading the requested model; retry later (no automatic retry).", status,
         eta if number(eta) and eta >= 0 else None)


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
    loading = loading_detail(body)
    if loading:
        fail_loading(loading, None)
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
    unwrapped = unwrap(result)
    # `blocs_texte` / `troncature_possible` / `blocs_fournis` : ni le texte ni
    # les blocs envoyés ne sont dans la réponse ; extract_text() les renseigne,
    # un appel direct les laisse à None (« inconnu », jamais « aucun bloc »).
    metadata = {"request_id": body.get("request_id"), "agent": None,
                "model": body.get("model_profile"), "validation": validation,
                "usage": body.get("usage"),
                "field_confidence": field_confidences(result) if confidence is None else confidence,
                "evidence": field_evidence(result),
                "prompt_profile": None,
                "partiel": resultat_partiel(validation, unwrapped),
                "blocs_texte": None, "troncature_possible": None, "blocs_fournis": None,
                "schema_reported": any(item is not None for item in reported)}
    for name in ("queue_wait_ms", "latency_ms", "generation_ms"):
        value = body.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
            metadata[name] = value
    return {"schema_name": expected_schema, "result": unwrapped, "metadata": metadata}


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


def post_json(endpoint, headers, payload, key, timeout, session, *, loading=False):
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
                    # `Retry-After` sur 429 : DocIE l'emet sur le quota par
                    # fenetre et sur le blocage d'IP apres echecs
                    # d'authentification, PAS sur la limite de concurrence du
                    # locataire -- mesure chez eux (security.py:178, 188-194,
                    # 223-225). Absent, illisible ou negatif : on garde le
                    # message vague, qui reste la regle et non l'exception.
                    #
                    # La valeur est la LONGUEUR de la fenetre, pas un delai
                    # calcule : elle ne decroit pas quand la fenetre se vide.
                    #
                    # Lue sur l'en-tete, jamais sur le corps : un corps amont ne
                    # sert ici qu'a classer, jamais a informer.
                    #
                    # Secondes uniquement. La RFC autorise aussi une date HTTP ;
                    # DocIE n'en emet pas, et deviner un fuseau serait pire que
                    # ne rien dire.
                    retry = entier_positif(response.headers.get("Retry-After")) if status == 429 else None
                    message = ("DocIE refused the document as beyond its configured limits (size, OCR blocks or pages)."
                               if status == 413 else "DocIE request failed (HTTP " + str(status) + ").")
                    fail(code, message, status, retry)
                text = read_error_text(response, key)
                # `loading` : voie texte seulement (voir loading_detail). Un
                # 202, ou un corps `detail.status == "loading"` sous un autre
                # statut.
                if loading:
                    try:
                        parsed = json.loads(text)
                    except ValueError:
                        parsed = None
                    detail = loading_detail(parsed)
                    if status == 202 or detail:
                        fail_loading(detail, status)
                # Message constant : le corps amont sert à classer, jamais à
                # informer -- c'est ce qui garantit qu'une clé réfléchie ne sort
                # pas d'ici.
                if CONTEXT_OVERFLOW.search(text):
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
                body = rediger(json.loads(b"".join(chunks).decode("utf-8")), key)
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


def extract_document(content, mime_type, *, kind="resume", agent=None, env=None, session=None):
    """Send one PDF/image to the configured agent; never retry billable work.

    Caller must authorize access to the document. DOCX and text are not sent
    here: the `image_url` wrapper feeds DocIE's OCR backends, which read PDF and
    images only. A source that already carries machine-readable text goes to
    extract_text() instead -- a different endpoint, not a MIME type to add here.

    `agent` (#194) : agent DocIE choisi pour CET appel, prioritaire sur
    DOCIE_AGENT_<KIND> pour cet appel seulement. Sur cette voie le modèle est
    figé par la spec de l'agent (le runtime DocIE écrase `model`) : choisir un
    modèle, c'est choisir un agent. Aucun champ `model` supplémentaire n'est donc
    envoyé. `metadata["agent"]` nomme l'agent réellement appelé. Pas de liste
    d'agents autorisés ici : voir per_call_agent().
    """
    env = os.environ if env is None else env
    endpoint, key, agent, timeout, tokens = configuration(kind, env, agent)
    if not isinstance(content, bytes) or not 0 < len(content) <= MAX_DOCUMENT_BYTES:
        fail("input", "Document must contain between 1 byte and " + str(MAX_DOCUMENT_BYTES)
             + " bytes (DocIE's 26 MiB request body, base64 included).")
    if mime_type not in MIME_TYPES:
        fail("input", "Unsupported document MIME type; use PDF, PNG or JPEG.")
    payload = file_payload(content, mime_type, agent, tokens)
    # Pas de `loading` ici : sur la voie agent, un modèle `store:` froid ne
    # répond pas 202 mais une 500 non rattrapée côté DocIE (#194). Un 202 y reste
    # un échec `upstream`.
    body, elapsed = post_json(endpoint, {"Authorization": "Bearer " + key}, payload, key, timeout, session)
    result = parse_response(body, SCHEMAS[kind], agent)
    result["metadata"]["elapsed_ms"] = elapsed
    return result


STORE_MAX_BYTES = 1024 * 1024


def get_json(endpoint, headers, key, timeout, session):
    """Un GET, jamais de relance ; même classement de statut, même plafond, même rédaction de clé que post_json."""
    own_session = session is None
    session = session or requests.Session()
    chunks, size = [], 0
    try:
        with session.get(endpoint, headers=headers, timeout=(min(10, timeout), timeout),
                         allow_redirects=False, stream=True) as response:
            status = response.status_code
            if status != 200:
                fail({401: "auth", 403: "auth", 429: "rate_limit"}.get(status, "upstream"),
                     "DocIE request failed (HTTP " + str(status) + ").", status)
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > STORE_MAX_BYTES:
                    fail("response", "DocIE response exceeded the size ceiling.")
                chunks.append(chunk)
    except requests.Timeout:
        fail("timeout", "DocIE timeout.")
    except requests.RequestException:
        fail("network", "DocIE network or TLS failure.")
    finally:
        if own_session:
            session.close()
    try:
        return rediger(json.loads(b"".join(chunks).decode("utf-8", "replace")), key)
    except ValueError:
        fail("response", "DocIE returned invalid JSON.")


def projeter_store(entree):
    """Projection d'une entrée de GET /v1/serving/store : clés stables seulement, jamais endpoint ni chemin."""
    placement = entree.get("placement") if isinstance(entree.get("placement"), dict) else {}
    etat = placement.get("state")
    endpoint = placement.get("endpoint")
    debit = placement.get("tokens_per_second")
    slots = placement.get("slot_count")

    def chaine(valeur):
        return valeur if isinstance(valeur, str) else None

    def drapeau(cle):
        return entree.get(cle) is True

    # Aptitudes par exclusion (contrat DocIE) : embedding/reranker ne répondent jamais en chat ni en extraction.
    return {
        "nom": chaine(entree.get("name")),
        "famille": chaine(entree.get("family")),
        "etat": etat if isinstance(etat, str) else "inconnu",
        "phase": chaine(placement.get("phase")),
        "utilisable": etat == "ready" and isinstance(endpoint, str) and bool(endpoint),
        "tokens_par_seconde": debit if isinstance(debit, (int, float)) and not isinstance(debit, bool) and math.isfinite(debit) else None,
        "slots": slots if isinstance(slots, int) and not isinstance(slots, bool) else None,
        "chat": not drapeau("embedding") and not drapeau("reranker") and not drapeau("analyzer"),
        "extraction": not drapeau("embedding") and not drapeau("reranker") and (not drapeau("analyzer") or drapeau("structured_extraction")),
        "vision": drapeau("vision"),
        "reranker": drapeau("reranker"),
    }


def list_store(*, env=None, session=None, timeout=None):
    """GET /v1/serving/store : ce qui EST déployé, et s'il est prêt (placement.state "ready" + endpoint)."""
    env = os.environ if env is None else env
    base, key, delai = connection(env)
    body = get_json(base + "/v1/serving/store", {"x-api-key": key}, key, min(delai, timeout or 30), session)
    if not isinstance(body, list):
        fail("response", "DocIE returned an invalid store listing.")
    return [projeter_store(e) for e in body if isinstance(e, dict)]


STORE_CACHE_S = 300
STORE_TIMEOUT_S = 5
_store_cache = {"quand": None, "modeles": []}


def store_utilisable(*, env=None, session=None, maintenant=None):
    """Modèles prêts du store (cache 5 min par processus) ; DocIE injoignable ou non configuré : dernier relevé, sinon []."""
    env = os.environ if env is None else env
    maintenant = time.monotonic() if maintenant is None else maintenant
    if _store_cache["quand"] is not None and maintenant - _store_cache["quand"] < STORE_CACHE_S:
        return list(_store_cache["modeles"])
    if not str(env.get("DOCIE_BASE_URL") or "").strip():
        return list(_store_cache["modeles"])
    try:
        modeles = [m for m in list_store(env=env, session=session, timeout=STORE_TIMEOUT_S) if m["utilisable"]]
    except DocIEBridgeError as exc:
        print("[docie_bridge] store DocIE non relu (%s) : dernier relevé conservé" % exc.code, file=sys.stderr)
        _store_cache["quand"] = maintenant
        return list(_store_cache["modeles"])
    _store_cache.update(quand=maintenant, modeles=modeles)
    return list(modeles)


def nom_store(selecteur):
    """Nom de store visé par un sélecteur de modèle DocIE (`store:<nom>` ou nom nu) ; None sinon."""
    if not isinstance(selecteur, str) or not selecteur.strip():
        return None
    selecteur = selecteur.strip()
    if selecteur.startswith("policy:"):
        return None
    return selecteur[len("store:"):] if selecteur.startswith("store:") else selecteur


def projeter_agent(entree):
    """Projection d'une entrée de GET /v1/agents : clés stables, jamais le prompt système ni les options brutes."""
    options = entree.get("options") if isinstance(entree.get("options"), dict) else {}
    kind = entree.get("kind") if isinstance(entree.get("kind"), str) else None
    mode = options.get("mode")
    # `mode` absent (agent d'avant le champ) : `extractor` présent vaut ocr_extract, sinon ocr.
    if not isinstance(mode, str):
        mode = "ocr_extract" if options.get("extractor") else "ocr"
    if kind == "ocr":
        selecteur = options.get("vision_model") if mode == "vision" else options.get("extractor") if mode == "ocr_extract" else None
    else:
        selecteur = entree.get("model_profile")
    schema = options.get("schema") if isinstance(options.get("schema"), str) and options.get("schema").strip() else None
    return {
        "nom": entree.get("name") if isinstance(entree.get("name"), str) else None,
        "kind": kind,
        "mode": mode if kind == "ocr" else None,
        "actif": entree.get("enabled") is not False,
        "schema": schema,
        "modele_store": nom_store(selecteur),
        "extraction": kind == "ocr" and mode in ("ocr_extract", "vision") and schema is not None,
        "vision": kind == "ocr" and mode == "vision",
    }


def list_agents(*, env=None, session=None, timeout=None):
    """GET /v1/agents : les agents enregistrés, projetés ; l'aptitude « prêt » se déduit du store, pas d'ici."""
    env = os.environ if env is None else env
    base, key, delai = connection(env)
    body = get_json(base + "/v1/agents", {"x-api-key": key}, key, min(delai, timeout or 30), session)
    if not isinstance(body, list):
        fail("response", "DocIE returned an invalid agent listing.")
    return [projeter_agent(e) for e in body if isinstance(e, dict)]


_agents_cache = {"quand": None, "agents": []}


def agents_utilisables(*, env=None, session=None, maintenant=None):
    """Agents d'extraction actifs dont le modèle est prêt sur le store (cache 5 min) ; DocIE muet : dernier relevé, sinon []."""
    env = os.environ if env is None else env
    maintenant = time.monotonic() if maintenant is None else maintenant
    if _agents_cache["quand"] is not None and maintenant - _agents_cache["quand"] < STORE_CACHE_S:
        return list(_agents_cache["agents"])
    if not str(env.get("DOCIE_BASE_URL") or "").strip():
        return list(_agents_cache["agents"])
    prets = {m["nom"] for m in store_utilisable(env=env, session=session, maintenant=maintenant)}
    try:
        agents = [a for a in list_agents(env=env, session=session, timeout=STORE_TIMEOUT_S)
                  if a["actif"] and a["extraction"] and a["nom"] and a["modele_store"] in prets]
    except DocIEBridgeError as exc:
        print("[docie_bridge] agents DocIE non relus (%s) : dernier relevé conservé" % exc.code, file=sys.stderr)
        _agents_cache["quand"] = maintenant
        return list(_agents_cache["agents"])
    _agents_cache.update(quand=maintenant, agents=agents)
    return list(agents)


RERANK_DOCUMENTS_MAX = 500


def reranker_pret(*, env=None, session=None):
    """Sélecteur `store:<nom>` du premier reranker prêt sur le store (relevé en cache), sinon None."""
    for m in store_utilisable(env=env, session=session):
        if m.get("reranker") and m.get("nom"):
            return "store:" + m["nom"]
    return None


def rerank(query, documents, *, modele, top_n=None, env=None, session=None):
    """POST /v1/rerank : [{index, score}] trié décroissant ; textes seuls, scores comparables dans UN appel seulement."""
    env = os.environ if env is None else env
    base, key, timeout = connection(env)
    if not isinstance(query, str) or not query.strip():
        fail("input", "Rerank query must not be empty.")
    if not isinstance(documents, list) or not documents or not all(isinstance(d, str) and d.strip() for d in documents):
        fail("input", "Rerank documents must be a non-empty list of non-empty strings.")
    if len(documents) > RERANK_DOCUMENTS_MAX:
        fail("input", "Too many documents to rerank in one call.")
    payload = {"model": per_call_model_profile(modele), "query": query, "documents": documents}
    if isinstance(top_n, int) and not isinstance(top_n, bool) and top_n >= 1:
        payload["top_n"] = top_n
    body, _elapsed = post_json(base + "/v1/rerank", {"x-api-key": key}, payload, key, timeout, session, loading=True)
    resultats = body.get("results") if isinstance(body, dict) else None
    if not isinstance(resultats, list):
        fail("response", "Invalid DocIE rerank response.")
    sortie = []
    for r in resultats:
        index = r.get("index") if isinstance(r, dict) else None
        score = r.get("relevance_score") if isinstance(r, dict) else None
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(documents) \
                or not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
            fail("response", "Invalid DocIE rerank result entry.")
        sortie.append({"index": index, "score": float(score)})
    sortie.sort(key=lambda r: -r["score"])
    return sortie


def extract_text(text, *, kind="resume", dynamic_schema=None, ocr_blocks=None, model_profile=None, langue=None, env=None, session=None):
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

    `ocr_blocks` : blocs de l'appelant, facultatifs. Absents, DocIE découpe
    `text` lui-même, une ligne non vide par bloc, et il n'y a rien de mieux à
    proposer pour du texte brut. Fournis, ils REMPLACENT ce découpage : `text`
    n'est plus ni redécoupé ni ancré (extract/service.py:357), les plafonds
    comptent NOS blocs, et nos `id` reviennent tels quels dans `evidence_ids`.
    C'est ce qui rend leur envoi utile là où l'appelant connaît de vraies
    frontières -- les paragraphes d'un DOCX, les pages d'une couche texte de
    PDF : un document de 2 000 lignes non vides tient alors en quelques
    centaines de blocs et cesse d'être tronqué en silence par le plafond de 800.

    `text` part quand même : DocIE ne le redécoupe pas, mais il en tire le
    `document_hash` quand l'appelant n'en fournit pas -- l'envoyer garde ce
    hachage stable d'une extraction à l'autre.

    Le pont ne FABRIQUE pas de blocs : les frontières dépendent du document,
    donc du consommateur. Il valide leur forme et les plafonds
    (valider_blocs_ocr).

    `model_profile` (#194) : modèle choisi pour CET appel (`store:<nom>` de
    préférence, seule forme qui déclenche le chargement à la demande -> code
    `loading`), prioritaire sur DOCIE_MODEL_PROFILE pour cet appel seulement.
    Absent : comportement inchangé. `metadata["model"]` reste celui que la
    RÉPONSE rapporte (`model_profile`), pas celui demandé. Pas de liste de
    modèles autorisés ici : voir per_call_model_profile().

    `langue` : code de langue du document, FACULTATIF et SANS DÉFAUT ici. Omis,
    le prompt de DocIE lit « Language: unknown » -- ce qui est VRAI. Aucun défaut
    dans ce transport, délibérément : « ce document est en français » est une
    connaissance MÉTIER que le pont n'a pas. Le consommateur qui la sait l'envoie ;
    celui qui ne la sait pas s'abstient -- un CV de langue inconnue annoncé « fr »
    serait une AFFIRMATION FAUSSE au modèle là où « unknown » est vraie. Forme
    validée, portée réelle selon le profil de prompt, et sources DocIE : voir
    code_langue().

    Volontairement ABSENT de la voie agent : ce corps-là ne lit pas `language`,
    le runtime ne le prend que sur la SPEC de l'agent (agents/runtime.py:550).
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
    # DocIE borne `text` SEUL en caractères : `len(payload.text) >
    # settings.max_text_chars` -> 413 « Text content exceeds configured limit »
    # (api.py:343-344, premier contrôle de POST /v1/extract/text).
    #
    # Ce plafond est INDÉPENDANT de celui qui porte sur la somme des caractères
    # des blocs (api.py:350) : 900 000 caractères de `text` ET 900 000 dans les
    # blocs passent chez DocIE, chacun sous son propre plafond. Ne PAS borner
    # leur somme ici -- ce serait refuser localement ce que DocIE accepte. La
    # borne commune en OCTETS plus bas est une autre règle, sur le corps.
    #
    # `len()` sur une `str` compte les points de code : c'est exactement la
    # règle de DocIE, et celle que le portage JS reproduit à la main.
    # Comparaison STRICTE : 1 000 000 passe, 1 000 001 échoue.
    if len(text) > DOCIE_TEXTE_CARACTERES_MAX:
        fail("input", "Document text of " + str(len(text)) + " characters, beyond DocIE's "
             + str(DOCIE_TEXTE_CARACTERES_MAX) + ".")
    payload = {"text": text, "schema_name": schema}
    if dynamic_schema is not None:
        if not isinstance(dynamic_schema, dict) or not dynamic_schema:
            fail("input", "dynamic_schema must be a non-empty schema object.")
        declared = dynamic_schema.get("document_type")
        if declared is not None and declared != schema:
            fail("input", "dynamic_schema describes another document type.")
        payload["schema_mode"] = "dynamic"
        payload["dynamic_schema"] = dynamic_schema
    if langue is not None:
        payload["language"] = code_langue(langue)
    # Blocs fournis : le même plafond d'octets borne le corps entier. `text` et
    # les blocs voyagent ensemble, donc la seule borne honnête porte sur leur
    # somme -- sans quoi un texte de 20 Mio doublé par ses blocs ferait un corps
    # de 40 Mio, refusé par DocIE après coup alors que c'est mesurable ici.
    blocs_fournis = ocr_blocks is not None
    if blocs_fournis:
        propres, octets = valider_blocs_ocr(ocr_blocks)
        if len(text.encode("utf-8")) + octets > MAX_TEXT_BYTES:
            fail("input", "Text and ocr_blocks together must stay under " + str(MAX_TEXT_BYTES) + " bytes.")
        payload["ocr_blocks"] = propres
        blocs = len(propres)
    else:
        blocs = compter_blocs_texte(text)
    if model_profile is not None:
        profile = per_call_model_profile(model_profile)
    else:
        profile = env.get("DOCIE_MODEL_PROFILE", "").strip()
    if profile:
        payload["model_profile"] = profile
    # `x-api-key`, not `Authorization: Bearer`: that is the header every
    # recorded success on this endpoint used (cv-parser/docie_client.py, the
    # response saved by document-parsing/scripts/test_api.py). The chat path
    # keeps its own header, equally by measurement.
    # Compté sur ce qui est exactement envoyé (#190). Fait de transport
    # seulement : `troncature_possible` = au-delà de 800 blocs, un profil
    # générique a PU tronquer ; False est une garantie contre ce plafond-là (pas
    # contre la taille de contexte, dont le dépassement est bruyant : code
    # `context`). Sans blocs fournis, `blocs_texte` PRÉDIT le découpage de
    # DocIE ; avec eux, il le CONSTATE -- c'est le nombre de blocs partis, et
    # `blocs_fournis` dit laquelle des deux lectures s'applique.
    body, elapsed = post_json(base + "/v1/extract/text", {"x-api-key": key}, payload, key, timeout, session, loading=True)
    result = parse_text_response(body, schema)
    result["metadata"]["blocs_texte"] = blocs
    result["metadata"]["troncature_possible"] = blocs > DOCIE_BLOCS_TEXTE_MAX
    result["metadata"]["blocs_fournis"] = blocs_fournis
    result["metadata"]["elapsed_ms"] = elapsed
    return result
