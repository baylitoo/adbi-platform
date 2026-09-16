"use strict";

// Server-side counterpart of docie_bridge.py. No browser API key, OCR or retries.
//
// Two entry points, one per DocIE surface, because the two surfaces are
// genuinely different -- not because text is a "format" the first could take:
//
//   extractDocument(buffer, mimeType)  POST /v1/agents/<agent>/chat/completions
//       The document travels as an `image_url` data URI and DocIE's OCR
//       backends read it. Only what those backends read may be sent.
//
//   extractText(text)                  POST /v1/extract/text
//       The text travels as `text` in the body, no data-URI wrapper, and DocIE
//       blocks it itself. For a source that already HAS readable text.
//
// Routing rule, from DocIE's team (#180): use the structure the source actually
// has. Not "prefer the text path" -- a scanned PDF has no text at all.
//
// Our own caps. DocIE's documented limits, per its team: 25 MB
// upload, 26 MB request body, 1,000,000 characters of text, 1,000 OCR blocks
// per document, 20,000 characters per block, 50 metadata entries, 8 pages
// (vision path only). Those are that service's DEFAULTS, not facts about the
// instance we call -- an operator sets them per deployment, and nothing DocIE
// exposes (/healthz, /readyz, /metrics, /v1/schemas) reports the values in
// force, so this copy can be wrong from a deployment's first day.
//
// The 1,000-block ceiling is the limit that bites first on a long document: a
// dense three-page PDF reaches it at a few megabytes, so MAX_DOCUMENT_BYTES
// guards the wrong dimension and no local check can see that failure coming.
// A document refused for it arrives here after the call, in one of three
// already-handled shapes: HTTP 413 -> code "limits" (below), `validation`
// errors (preserved verbatim in metadata, surfaced by the consumers), or a
// non-"stop" finish_reason -> code "incomplete". Which shape DocIE actually
// uses for the block ceiling is not recorded anywhere we can check; see #180.
//
// Plafond de la voie fichier (#190), calculé et non estimé. Le middleware DocIE
// (api.py, `enforce_request_content_length`) refuse en 413 tout corps dont
// l'en-tête Content-Length dépasse `max_request_body_mb` = 26 MiB (26*1024*1024,
// refus strict `>`), et aucun autre contrôle de taille ne s'applique au data URI
// de la voie agent. Or cette voie envoie le document en base64 (4*ceil(n/3)
// octets) dans une enveloppe JSON. Enveloppe MESURÉE en construisant la charge
// réelle, dans le pire cas autorisé ici (nom d'agent de 128 caractères,
// max_tokens 65536, `application/pdf`) : 398 octets avec JSON.stringify, 416
// avec `requests` côté Python (séparateurs ", " et ": "). La plus grande des deux
// fixe la borne commune aux deux portages : floor((26 MiB - 416) / 4) * 3 =
// 20 446 920 octets bruts (~19,5 MiB). Au-delà, DocIE refuserait en 413 un
// document déjà transmis.
//
// RE-MESURÉ en #251 : l'enveloppe valait 425 / 445 tant qu'elle portait
// `parallel_extraction`. Ce drapeau retiré, elle perd 27 octets (29 côté
// `requests`), donc la borne passe de 20 446 896 à 20 446 920. La marge était
// d'UN octet -- test_bridge.py vérifie que MAX+1 dépasse réellement la limite.
// Toute modification de l'enveloppe doit refaire cette mesure.
//
// La voie texte garde sa propre borne, inchangée : le texte n'y est pas encodé
// en base64 (`{text, schema_name, ...}`), et le plafond de 1 000 000 caractères
// de DocIE (défaut de déploiement, non vérifié ici) mord bien avant 20 MiB.
const DOCIE_MAX_REQUEST_BODY_BYTES = 26 * 1024 * 1024;
const FILE_ENVELOPE_MAX_BYTES = 416;
const MAX_DOCUMENT_BYTES = Math.floor((DOCIE_MAX_REQUEST_BODY_BYTES - FILE_ENVELOPE_MAX_BYTES) / 4) * 3;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Corps d'erreur lu pour le seul classement, jamais recopié dans un message.
// DocIE tronque déjà le corps amont à 500 caractères : 64 KiB suffit largement.
const MAX_ERROR_BYTES = 64 * 1024;
// Dépassement de contexte du serveur de modèle (#190). Sur un profil à prompt
// « document entier », un document trop long fait refuser le prompt par
// llama-server (« request (N tokens) exceeds the available context size »,
// type `exceed_context_size_error`).
//
// VOIE AGENT SEULEMENT. Là, le runtime emballe l'échec en
// `AgentError(status_code=…, error_type="upstream_error")` : le statut amont
// ressort et le corps amont est dans `message`, donc la regex ci-dessous le
// reconnaît. Le statut exact est « lu, non tracé » de bout en bout, et 400 est
// aussi celui d'une requête invalide : on reconnaît donc le TEXTE, où qu'il
// soit dans le corps (JSON imbriqué échappé ou texte brut).
//
// SUR /v1/extract/text, CETTE REGEX NE PEUT JAMAIS SE DÉCLENCHER, et ce n'est
// pas une fragilité de formulation : le message n'arrive pas du tout. Mesuré
// chez DocIE (exécution des pannes derrière la route, sans modèle ni réseau) :
// dépassement de contexte, 503 de chargement, 429, lecture expirée, file
// saturée, sortie tronquée, réponse non-JSON — TOUT ressort en HTTP 500 avec le
// corps en texte brut « Internal Server Error ». Pas de JSON, pas de type
// d'erreur, pas d'en-tête. La route appelle `extract_from_text` sans try/except,
// les erreurs de passerelle sont de simples RuntimeError et l'application n'a
// aucun gestionnaire d'exception : le 500 par défaut de FastAPI est tout ce qui
// reste, et le message amont est jeté avant de nous parvenir.
//
// Conséquence à connaître avant de s'y fier : sur la voie texte, un document
// trop long ressort en `upstream` (« le service a répondu en erreur ») et non en
// `context` (« document trop long »). `upstream` n'y est donc pas « tout le
// reste » mais « toute défaillance du modèle », indistinguables. Le correctif
// appartient à DocIE (mapper les erreurs de passerelle vers des statuts, comme
// le fait déjà la voie agent) ; rien ici ne peut le rattraper.
//
// Tout ce qui n'est pas reconnu retombe sur `upstream`.
const CONTEXT_OVERFLOW = /exceeds the available context size|exceed_context_size_error/i;
// Plafond silencieux de blocs de la voie texte (#190). Sans `ocr_blocks` fournis
// par l'appelant, DocIE (ocr/base.py, `text_to_blocks`) fait UN bloc par ligne
// non vide : `sum(1 for ligne in texte.splitlines() if ligne.strip())`, sans
// fenêtre de caractères. Tout profil à prompt générique ne garde ensuite que les
// 800 premiers (`render_ocr_blocks(blocks, max_blocks=800)`), en HTTP 200 et sans
// aucun avertissement. Le bridge ne connaît pas le profil servi : il rapporte un
// fait de transport, « a pu être tronqué », jamais « a été tronqué ».
//
// Compter TROP ne coûte qu'un « a pu » inutile ; compter TROP PEU donne un faux
// « non tronqué ». Deux pièges JS, mesurés contre CPython 3.14 (le test Python
// recalcule la règle à chaque exécution : une dérive de version casse un test) :
//   * `splitlines()` coupe aussi sur \v \f \x1c \x1d \x1e \x85 \u2028 \u2029 :
//     un `split(/\r\n|\r|\n/)` sous-compte ;
//   * `strip()` retire ce que `str.isspace()` reconnaît, qui n'est PAS l'ensemble
//     de `String.prototype.trim()` / `\s` : trim() retire \ufeff (BOM), que Python
//     garde (ligne « BOM seul » = un bloc, sous-compte), et garde \x1c-\x1f et \x85,
//     que Python retire. D'où une classe explicite, jamais trim() ni \s.
// Règle figée par document-parsing/fixtures/blocs_texte_docie.json (tests seuls).
const DOCIE_BLOCS_TEXTE_MAX = 800;
const SEPARATEURS_LIGNE_PYTHON = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;
// Blocs fournis par l'appelant (voie texte). Quand `ocr_blocks` voyage, DocIE ne
// d\u00e9coupe plus rien : `extract/service.py:357` fait
// `blocks = ocr_blocks if ocr_blocks is not None else text_to_blocks(text or "")`.
// Ce sont donc NOS blocs qui sont compt\u00e9s, mis dans le prompt et ancr\u00e9s, et nos
// `id` qui reviennent verbatim dans `evidence_ids` \u2014 un document dont le texte
// fait 2 000 lignes non vides tient en 300 blocs de paragraphes et cesse d'\u00eatre
// tronqu\u00e9. Les plafonds ci-dessous sont ceux d'`api.py::validate_text_request`,
// qui r\u00e9pond 413 : les v\u00e9rifier ici, c'est refuser avant l'aller-retour.
// Lecture du code DocIE (origin/dev-agents-milestone, pointe c8c010e) par la
// session DocIE le 2026-09-16 ; aucun appel distant depuis ce d\u00e9p\u00f4t.
const DOCIE_BLOCS_OCR_MAX = 1000;
const DOCIE_BLOC_CARACTERES_MAX = 20000;
const DOCIE_TEXTE_CARACTERES_MAX = 1000000;
// `OCRBlock` (schemas/common.py:16-24) n'a PAS `extra="forbid"` : une cl\u00e9
// inconnue \u2014 `pages` pour `page` \u2014 y serait silencieusement ignor\u00e9e et
// l'appelant croirait avoir pagin\u00e9. D'o\u00f9 une liste blanche et un refus nomm\u00e9.
const BLOC_CLES = new Set(["id", "text", "page", "bbox", "source", "confidence"]);
const BLOC_SOURCES = new Set(["pdf_text", "pdf_inspector", "tesseract", "paddleocr", "manual", "unknown"]);
const BBOX_CLES = ["x0", "y0", "x1", "y1"];
const LIGNE_BLANCHE_PYTHON = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;
const SCHEMAS = { resume: "adbi_resume", contract: "contract", kbis: "kbis", urssaf: "urssaf", rib: "rib" };
// What the AGENT CHAT path accepts, which is not DocIE's upload allowlist.
// This transport posts the document as an `image_url` data URI to
// /v1/agents/<agent>/chat/completions, where DocIE OCRs it: liteparse renders
// PDF pages, tesseract and paddle take images. So the OCR backends, not
// `ALLOWED_UPLOAD_MIME_TYPES`, decide what may be sent here.
//
// `image/webp` was removed: DocIE's allowlist refuses it, so every WebP made a
// pointless round-trip before failing remotely. It now fails locally, named.
//
// `text/plain` and `image/tiff` are in DocIE's upload allowlist but are NOT
// added here. Text has no OCR backend behind the `image_url` wrapper: its path
// is extractText() below, a different endpoint with a different request body
// -- adding a MIME type to this set would send text through the OCR wrapper,
// which is precisely what does not work. TIFF is plausible through the wrapper
// but unverified, and acceptance depends on the deployment's OCR backend, not
// on the allowlist alone. Neither is added on a reading of someone else's
// configuration -- that is exactly how `image/webp` got here (#180).
const MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);
// A grounded field arrives as {value, ...} alongside at least one of these keys.
// The logprob key is in the set on purpose: DocIE's logprob confidence adds it as
// a fourth key, and an envelope test that ignores it lets a scalar reach the
// consumer as a dict ("Ada" becoming {"value": "Ada", ...}).
//
// BOTH logprob spellings are accepted. DocIE renamed `model_confidence` to
// `model_logprob` -- the value is a natural-log probability, not a 0-1 score, and
// the old name invited exactly that confusion -- but that rename ships in a PR
// that is not merged yet. Accepting both keeps unwrapping correct whichever side
// deploys first, and costs nothing once the rename lands.
//
// Only `confidence` is ever collected as a review signal. `model_logprob` is a
// natural-log probability (<= 0, closer to 0 = more confident), deliberately NOT
// renormalised upstream: comparing it against `confidence`'s 0-1 scale would flag
// every field carrying one, since -7.5 sits well below any 0-1 threshold. It
// ranks fields within one extraction; it is not a threshold input.
const ENVELOPE_MARKERS = ["confidence", "evidence_ids", "model_confidence", "model_logprob"];

// `eta_seconds` : renseigné par `loading` (délai annoncé par DocIE dans
// `detail.eta_seconds`) et par `rate_limit` (en-tête `Retry-After`, quand DocIE
// l'émet) ; null partout ailleurs. Nombre fini >= 0. Même nom que côté Python.
//
// Les deux ne disent pas la même chose : `loading` annonce une estimation de
// chargement, `rate_limit` la LONGUEUR de la fenêtre de quota, qui ne décroît
// pas quand la fenêtre se vide. Un consommateur qui l'affiche doit le dire
// comme un ordre de grandeur, pas comme un compte à rebours.
class DocIEBridgeError extends Error {
  constructor(code, message, status = null, etaSeconds = null) {
    super(message); this.name = "DocIEBridgeError"; this.code = code; this.status = status; this.eta_seconds = etaSeconds;
  }
}
function fail(code, message, status, etaSeconds = null) { throw new DocIEBridgeError(code, message, status, etaSeconds); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

// API root, access key and timeout — what BOTH DocIE paths need. Split out of
// configuration() for extractText(): POST /v1/extract/text has no agent in its
// URL, so requiring DOCIE_AGENT_<KIND> there would refuse a text extraction
// over a setting that call never uses.
function connection(env) {
  const base = (env.DOCIE_BASE_URL || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(base); } catch { fail("configuration", "Invalid DocIE API root URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") {
    fail("configuration", "DOCIE_BASE_URL must be the API root without credentials or path.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && env.DOCIE_ALLOW_HTTP !== "true") {
    fail("configuration", "Use HTTPS or explicitly set DOCIE_ALLOW_HTTP=true for a trusted private network.");
  }
  const key = (env.DOCIE_API_KEY || "").trim();
  if (!key || /[\r\n]/.test(key)) fail("configuration", "Configure a valid DOCIE_API_KEY.");
  const timeout = Number(env.DOCIE_TIMEOUT_SECONDS ?? "360");
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) fail("configuration", "Invalid DocIE timeout or token budget.");
  return { base, key, timeout };
}

// Nom d'agent DocIE : une seule règle, pour DOCIE_AGENT_<KIND> comme pour
// l'option `agent` par appel (#194). Il entre tel quel dans le chemin d'URL.
const AGENT_NAME = /^[A-Za-z0-9_-]{1,128}$/;

// Choix par appel (#194) : identifiant de modèle (`modelProfile`, voie texte) ou
// agent (`agent`, voie agent) choisi par l'utilisateur pour CETTE action.
//
// Le bridge est un transport : il valide la FORME, jamais la politique. Aucune
// liste de modèles autorisés ici — ce qu'un utilisateur peut choisir est
// l'affaire du catalogue (#194 étape 2, côté consommateurs). Ne pas ajouter de
// liste au transport.
//
// Échec en `input`, comme `dynamicSchema`, sa voisine par appel : c'est la
// valeur de l'appelant qui est refusée. `configuration` reste aux variables
// d'environnement (cv-parser l'affiche comme « mal configuré côté serveur »).
//
// `modelProfile` : pas la règle AGENT_NAME, qui refuserait `store:lfm2.5-2.6b`
// (`:` et `.`), la seule forme qui déclenche le chargement à la demande. Règle
// de la clé d'accès (non vide après trim, sans retour ligne), étendue à tout
// caractère de contrôle, et plafond de 128 d'AGENT_NAME, compté en octets UTF-8
// pour que les deux portages bornent la même chose. Envoyé après trim, comme
// DOCIE_MODEL_PROFILE ; `store:<nom>` passe sans autre transformation.
function perCallAgent(value) {
  const agent = typeof value === "string" ? value.trim() : "";
  if (!AGENT_NAME.test(agent)) fail("input", "Invalid per-call DocIE agent name.");
  return agent;
}
// Code de langue envoyé à DocIE sur la voie texte (voir extractText).
//
// POURQUOI valider ici, et c'est le seul motif nécessaire : DocIE ne valide
// RIEN (`language: str | None`, schemas/api.py:26, aucun validateur) et la
// valeur entre VERBATIM dans un prompt. Vrai sans condition.
//
// CE QU'ELLE FAIT vraiment sur cette voie : des prompts, rien d'autre.
// `extract_from_text` (extract/service.py:344-384) découpe en blocs et extrait
// sans jamais instancier d'OCR. La fabrique `get_ocr_backend`
// (ocr/factory.py:32) et le raise de `PaddleOCRBackend(lang=...)` (:41-42) ne
// sont atteints que depuis `extract_from_file` (extract/service.py:452) et
// `_extract_pipeline` (:557), qui exigent un chemin de fichier. Sur
// /v1/extract/text un code mal formé est donc COSMÉTIQUE : une mauvaise ligne
// de prompt, pas une panne. Ne pas invoquer l'OCR pour justifier ce garde-fou.
//
// PORTÉE RÉELLE, à ne pas surestimer : la ligne « Language: ... »
// (llm/prompts.py:223) n'est rendue que par les profils de prompt GÉNÉRIQUES ;
// `nuextract3`, `nuextract_v1` et `document_only` n'en rendent AUCUNE. Le
// second site (llm/prompts.py:324, « Language hint ») appartient au proposeur
// de schéma, jamais atteint puisque ce pont envoie toujours `dynamic_schema`.
// La valeur n'est pas relue dans la réponse (`ExtractionResponse` n'a pas de
// champ langue).
//
// FORME seulement — lettres ASCII, tiret admis (« fr », « fr-FR ») — jamais une
// liste de langues autorisées : ce transport ne décide pas lesquelles existent,
// et un code exotique mais bien formé doit pouvoir passer. Le consommateur sait
// si son déploiement gère la langue. Refus en `input`, comme ses voisins par appel.
//
// Sources lues sur origin/dev-agents-milestone @ c8c010e ; aucun appel distant.
const CODE_LANGUE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
function codeLangue(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!CODE_LANGUE.test(code)) fail("input", "Invalid language code; use a form such as \"fr\" or \"fr-FR\".");
  return code;
}

function perCallModelProfile(value) {
  const profile = typeof value === "string" ? value.trim() : "";
  if (!profile || /[\u0000-\u001f\u007f]/.test(profile) || Buffer.byteLength(profile, "utf8") > 128) {
    fail("input", "Invalid per-call DocIE model profile.");
  }
  return profile;
}

// `agentOverride` : agent choisi pour cet appel ; DOCIE_AGENT_<KIND> n'est alors
// pas lu du tout (même raisonnement que connection() : ne pas exiger un réglage
// que l'appel n'utilise pas). L'URL, `model` et l'agent attendu dans la réponse
// viennent tous de la même variable.
function configuration(kind, env, agentOverride = null) {
  if (!Object.hasOwn(SCHEMAS, kind)) fail("configuration", "Unsupported document kind.");
  const { base, key, timeout } = connection(env);
  let agent;
  if (agentOverride != null) agent = perCallAgent(agentOverride);
  else {
    agent = (env["DOCIE_AGENT_" + kind.toUpperCase()] || "").trim();
    if (!AGENT_NAME.test(agent)) fail("configuration", "Configure the document kind's DocIE agent name.");
  }
  const tokens = Number(env.DOCIE_MAX_TOKENS ?? "8192");
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 65536) fail("configuration", "Invalid DocIE timeout or token budget.");
  return { endpoint: base + "/v1/agents/" + agent + "/chat/completions", key, agent, timeout, tokens };
}

function envelope(value) { return object(value) && Object.hasOwn(value, "value") && ENVELOPE_MARKERS.some(key => Object.hasOwn(value, key)); }
function number(value) { return typeof value === "number" && Number.isFinite(value); }

// En-tête `Retry-After` -> secondes entières non négatives, sinon null.
//
// L'en-tête est une CHAÎNE quand il est là, absent sinon. La RFC autorise aussi
// une date HTTP ; DocIE n'en émet pas, et deviner un fuseau serait pire que ne
// rien dire — donc seules les secondes sont lues, tout le reste vaut null et
// laisse le message vague en place.
//
// `[0-9]` et non `\d` : côté Python `\d` et `str.isdigit()` acceptent aussi les
// chiffres arabes-indiens, pas JS (#179 ligne A15). Les deux portages doivent
// refuser « ٣٠ » de la même façon.
function entierPositif(valeur) {
  if (typeof valeur !== "string") return null;
  const texte = valeur.trim();
  if (!/^[0-9]+$/.test(texte)) return null;
  const n = Number(texte);
  return Number.isSafeInteger(n) ? n : null;
}

function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (!object(value)) return value;
  if (envelope(value)) return unwrap(value.value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
}

// Per-field confidence, collected before unwrap() drops the envelopes. DocIE
// caps a field's confidence when it had to truncate a repeated/looping list, so
// this is the only per-field "partial, have a human read it" signal it emits.
// Only `confidence` is collected: `model_confidence` is a logprob score on a
// different scale, and the "<= 0.5 means review me" rule holds for the former.
// Keys match docie_bridge.py::field_confidences exactly: "contact.email",
// "experience[0].title", "skills[1].items[2].item". Transport only: the review
// threshold and the mapping to application field paths belong to the consumer.
function fieldConfidences(value, path = "", into = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => fieldConfidences(item, path + "[" + index + "]", into));
  } else if (object(value)) {
    if (envelope(value)) {
      if (path && number(value.confidence)) into[path] = value.confidence;
      return fieldConfidences(value.value, path, into);
    }
    for (const [key, item] of Object.entries(value)) fieldConfidences(item, path ? path + "." + key : key, into);
  }
  return into;
}

// `docie_agent.field_confidence` — {"experience[0].title": {"confidence": 0.5}}.
// DocIE's own per-field map, authoritative when the agent emits it: same dotted
// paths, and it survives an agent that flattens its result before answering
// (there are then no envelopes left for fieldConfidences to read). Returns null
// when absent or unusable, so the caller falls back to the envelopes rather than
// claiming DocIE reported nothing.
function reportedFieldConfidence(meta) {
  const raw = meta.field_confidence;
  if (!object(raw)) return null;
  const reported = {};
  for (const [path, entry] of Object.entries(raw)) {
    const confidence = object(entry) ? entry.confidence : entry;
    if (path && number(confidence)) reported[path] = confidence;
  }
  return reported;
}

// `docie_agent.prompt_profile` (#190) : le prompt qui a servi, seul indice que
// le plafond silencieux de 800 blocs OCR de DocIE a PU s'appliquer. Transport
// seulement : aucune règle ici sur les profils plafonnés — elle est imprécise
// (surévalue les profils vision, `docie_agent` ne porte pas `vision`) et
// appartient aux consommateurs. Traité comme ses voisins facultatifs
// (`field_confidence`, durées) et non comme `validation` : une valeur absente,
// non textuelle ou vide donne null (« inconnu ») au lieu de refuser une
// extraction valide pour un indice illisible.
function promptProfile(meta) {
  return typeof meta.prompt_profile === "string" && meta.prompt_profile ? meta.prompt_profile : null;
}

// Nombre de blocs que DocIE fera de `text` (voir DOCIE_BLOCS_TEXTE_MAX).
function compterBlocsTexte(text) {
  let blocs = 0;
  for (const ligne of text.split(SEPARATEURS_LIGNE_PYTHON)) if (!LIGNE_BLANCHE_PYTHON.test(ligne)) blocs++;
  return blocs;
}

// Points de code, jamais `String.prototype.length` : DocIE compte `len(b.text)`
// en Python, donc en points de code. Sur un texte à caractères astraux (emoji,
// CJK rare), `.length` compte double et ferait refuser ici un bloc que DocIE
// accepte. Figé par blocs_ocr_docie.json (cas `caracteres_comptes_en_points_de_code`).
function pointsDeCode(text) {
  let total = 0;
  for (const _ of text) total++;
  return total;
}

/**
 * Valide les `ocr_blocks` de l'appelant et rend la copie exacte à envoyer.
 *
 * Le pont reste un transport : il ne FABRIQUE aucun bloc (découper un DOCX ou
 * une couche texte de PDF demande de connaître le document, ce qui appartient au
 * consommateur), il vérifie la forme et les plafonds pour que l'échec soit local
 * et nommé plutôt qu'un 413 ou un 422 après l'appel.
 *
 * Copie plutôt que passe-plat : seules les six clés du modèle DocIE partent, ce
 * qui garantit qu'aucune donnée voisine de l'appelant ne fuit dans la requête.
 *
 * Règle figée par document-parsing/fixtures/blocs_ocr_docie.json (tests seuls),
 * où chaque refus porte sa `preuve` — fichier:ligne côté DocIE, ou [J] quand
 * c'est notre jugement et non une contrainte de leur côté.
 */
function validerBlocsOcr(blocs) {
  if (!Array.isArray(blocs)) fail("input", "ocr_blocks must be an array of OCR blocks.");
  // `[]` n'est PAS un repli sur `text` : `[] is not None`, donc DocIE extrait de
  // rien et répond 200 avec un résultat vide (extract/service.py:357).
  if (!blocs.length) fail("input", "ocr_blocks must not be empty: DocIE then extracts from no block at all instead of falling back to the text.");
  if (blocs.length > DOCIE_BLOCS_OCR_MAX) {
    fail("input", "ocr_blocks holds " + blocs.length + " blocks, beyond DocIE's " + DOCIE_BLOCS_OCR_MAX + " per document.");
  }
  const vus = new Set();
  const propres = [];
  let caracteres = 0, octets = 0;
  for (const [index, bloc] of blocs.entries()) {
    const ou = " (ocr_blocks[" + index + "])";
    if (!object(bloc)) fail("input", "Each OCR block must be an object" + ou + ".");
    for (const cle of Object.keys(bloc)) {
      if (!BLOC_CLES.has(cle)) fail("input", "Unknown OCR block key \"" + cle + "\"" + ou + "; DocIE would drop it silently.");
    }
    if (typeof bloc.id !== "string" || !bloc.id) fail("input", "Each OCR block needs a non-empty string id" + ou + "; it comes back verbatim in evidence_ids.");
    if (vus.has(bloc.id)) fail("input", "Duplicate OCR block id \"" + bloc.id + "\"" + ou + "; an evidence id must name exactly one block.");
    vus.add(bloc.id);
    if (typeof bloc.text !== "string") fail("input", "Each OCR block needs a string text" + ou + ".");
    // Blanc au sens de `str.strip()` de Python, pas de `trim()` : DocIE écarte un
    // bloc blanc du prompt (llm/prompts.py:139) APRÈS que la tranche des 800
    // premiers l'a compté (`blocks[:max_blocks]`), donc il coûte une place et
    // n'ancre rien. Le refuser garde `blocs_texte` égal aux blocs utiles.
    if (LIGNE_BLANCHE_PYTHON.test(bloc.text)) fail("input", "Blank OCR block text" + ou + "; DocIE drops it from the prompt after it has taken one of its " + DOCIE_BLOCS_TEXTE_MAX + " slots.");
    const taille = pointsDeCode(bloc.text);
    if (taille > DOCIE_BLOC_CARACTERES_MAX) fail("input", "OCR block text of " + taille + " characters" + ou + ", beyond DocIE's " + DOCIE_BLOC_CARACTERES_MAX + ".");
    caracteres += taille;
    octets += Buffer.byteLength(bloc.text, "utf8");
    const propre = { id: bloc.id, text: bloc.text };
    if (Object.hasOwn(bloc, "page")) {
      // DocIE accepte n'importe quel entier ; une page < 1 ne désigne aucune
      // page et rendrait impossible le filtrage des evidence_ids par page.
      if (!Number.isInteger(bloc.page) || bloc.page < 1) fail("input", "OCR block page must be an integer >= 1" + ou + ".");
      propre.page = bloc.page;
    }
    if (Object.hasOwn(bloc, "source")) {
      if (!BLOC_SOURCES.has(bloc.source)) fail("input", "Unknown OCR block source" + ou + "; DocIE accepts " + [...BLOC_SOURCES].join(", ") + ".");
      propre.source = bloc.source;
    }
    if (Object.hasOwn(bloc, "confidence")) {
      if (!number(bloc.confidence) || bloc.confidence < 0 || bloc.confidence > 1) fail("input", "OCR block confidence must be a number between 0 and 1" + ou + ".");
      propre.confidence = bloc.confidence;
    }
    if (Object.hasOwn(bloc, "bbox")) {
      const boite = bloc.bbox;
      if (!object(boite) || Object.keys(boite).length !== BBOX_CLES.length || !BBOX_CLES.every(cle => number(boite[cle]))) {
        fail("input", "OCR block bbox must carry the four finite numbers x0, y0, x1, y1" + ou + ".");
      }
      propre.bbox = { x0: boite.x0, y0: boite.y0, x1: boite.x1, y1: boite.y1 };
    }
    propres.push(propre);
  }
  if (caracteres > DOCIE_TEXTE_CARACTERES_MAX) {
    fail("input", "ocr_blocks total " + caracteres + " characters, beyond DocIE's " + DOCIE_TEXTE_CARACTERES_MAX + ".");
  }
  return { blocs: propres, octets };
}

// Résultat partiel (#194, « échouer bruyamment »). DocIE ne signale une valeur
// perdue que par des AVERTISSEMENTS, avec `validation.valid` toujours vrai :
// sans ce relevé, une extraction partielle ressemble à une extraction complète.
// `metadata.partiel = [{champ, raison}]` les rend lisibles par machine ; le
// bridge ne décide rien (refuser, signaler : c'est aux consommateurs).
//
// ATTENTION : ces libellés sont des chaînes lisibles tirées du code DocIE (lu
// par l'équipe DocIE, jamais exécuté sur notre déploiement), PAS un contrat
// versionné. Ils sont figés par document-parsing/fixtures/avertissements_docie.json
// (tests seuls) : si DocIE change un libellé, un test doit casser, plutôt que la
// règle s'affaiblir en silence. Un avertissement inconnu est ignoré pour
// `partiel` (jamais deviné) ; tous restent intacts dans `validation`.
//
// Le champ est ce qui précède le premier ": " — un chemin sans blanc ni ":"
// (`skills`, `experience[0].end_date`), sinon l'avertissement est ignoré.
const RAISONS_PARTIEL = ["boucle", "valeur_abandonnee", "forme_invalide", "feuille_abandonnee", "liste_plafonnee_possible"];
const CHAMP_AVERTISSEMENT = /^[^\t\n\v\f\r :]+$/;
// Boucle (PR DocIE #485) : "<champ>: model output repeated itself (<motif>);
// list truncated at the loop start, remaining items dropped; confidence capped
// to 0.5 as a review flag". Reconnue à sa sous-chaîne stable, AVANT les autres
// formes : le motif répété peut contenir ": " ou "; dropped".
const AVERTISSEMENT_BOUCLE = ": model output repeated itself (";
const MOTIFS_AVERTISSEMENT = [
  // "<nom>: <brut> is not a number; value dropped" / "... is not a currency; value dropped"
  [/^([^\t\n\v\f\r :]+): [\s\S]* is not a (?:number|currency); value dropped$/, "valeur_abandonnee"],
  // "<chemin>: the model wrote <texte> in a shape this field cannot hold; nothing was kept"
  [/^([^\t\n\v\f\r :]+): the model wrote [\s\S]* in a shape this field cannot hold; nothing was kept$/, "forme_invalide"],
  // "<chemin>: <message pydantic>; dropped" (une feuille invalide abandonnée par passe)
  [/^([^\t\n\v\f\r :]+): [\s\S]+; dropped$/, "feuille_abandonnee"],
];
// Plafond `maxItems: 100` des listes contraintes par grammaire : AUCUNE trace
// côté DocIE. Une liste d'exactement 100 éléments « a pu » être plafonnée ;
// 101 n'est pas ce plafond (NuExtract3, sans grammaire, n'en a pas).
const DOCIE_LISTE_MAX = 100;

function reconnaitreAvertissement(texte) {
  if (typeof texte !== "string") return null;
  const boucle = texte.indexOf(AVERTISSEMENT_BOUCLE);
  if (boucle >= 0) {
    const champ = texte.slice(0, boucle);
    return CHAMP_AVERTISSEMENT.test(champ) ? { champ, raison: "boucle" } : null;
  }
  for (const [motif, raison] of MOTIFS_AVERTISSEMENT) {
    const trouve = motif.exec(texte);
    if (trouve) return { champ: trouve[1], raison };
  }
  return null;
}

// Un seul endroit pour les deux voies. `result` est DÉJÀ déballé (une liste dans
// une enveloppe ancrée compte comme liste). Sources : `validation.warnings` et
// `result.extraction_notes` (la voie texte y recopie la même chaîne) ; une paire
// (champ, raison) n'apparaît qu'une fois. Entrées non textuelles ignorées.
function resultatPartiel(validation, result) {
  const partiel = [], vus = new Set();
  const ajouter = (champ, raison) => {
    const cle = JSON.stringify([champ, raison]);
    if (!vus.has(cle)) { vus.add(cle); partiel.push({ champ, raison }); }
  };
  for (const source of [object(validation) ? validation.warnings : null, object(result) ? result.extraction_notes : null]) {
    if (!Array.isArray(source)) continue;
    for (const texte of source) {
      const reconnu = reconnaitreAvertissement(texte);
      if (reconnu) ajouter(reconnu.champ, reconnu.raison);
    }
  }
  const parcourir = (value, path) => {
    if (Array.isArray(value)) {
      if (value.length === DOCIE_LISTE_MAX) ajouter(path, "liste_plafonnee_possible");
      value.forEach((item, index) => parcourir(item, path + "[" + index + "]"));
    } else if (object(value)) {
      for (const [key, item] of Object.entries(value)) parcourir(item, path ? path + "." + key : key);
    }
  };
  parcourir(result, "");
  return partiel;
}

function parseResponse(body, expectedSchema, agent) {
  if (!object(body)) fail("response", "Invalid DocIE chat envelope.");
  const choice = Array.isArray(body.choices) && body.choices[0];
  if (!object(choice)) fail("response", "Missing DocIE completion.");
  if (choice.finish_reason !== "stop") fail("incomplete", "DocIE did not finish extraction successfully.");
  let content = choice.message?.content;
  if (typeof content !== "string" || !content.trim()) fail("response", "DocIE returned no final extraction JSON.");
  content = content.trim();
  if (content.startsWith("```") && content.endsWith("```")) content = content.split(/\r?\n/).slice(1, -1).join("\n");
  let extracted;
  try { extracted = JSON.parse(content); } catch { fail("response", "DocIE returned invalid extraction JSON."); }
  if (!object(extracted)) fail("response", "DocIE extraction must be an object.");
  const result = Object.hasOwn(extracted, "result") ? extracted.result : extracted;
  if (!object(result) || !Object.keys(result).length) fail("response", "DocIE returned an empty or malformed result.");
  const meta = body.docie_agent ?? {};
  if (!object(meta)) fail("response", "Invalid DocIE agent metadata.");
  if (meta.agent != null && meta.agent !== agent) fail("schema", "DocIE responded from an unexpected agent.");
  const reported = [extracted.schema_name, result.document_type, meta.schema_name];
  if (reported.some(item => item != null && item !== expectedSchema)) fail("schema", "DocIE returned an unexpected document schema.");
  const validation = Object.hasOwn(meta, "validation") ? meta.validation : (extracted.validation ?? null);
  if (validation != null && !object(validation)) fail("response", "Invalid DocIE validation metadata.");
  const confidence = reportedFieldConfidence(meta);
  const unwrapped = unwrap(result);
  // `blocs_texte` / `troncature_possible` / `blocs_fournis` : null sur cette voie, « non
  // mesurable » et non « non tronqué » — c'est l'OCR distant qui fait les blocs.
  const metadata = { request_id: body.id ?? null, agent, model: body.model ?? null,
    validation, usage: body.usage ?? null, field_confidence: confidence ?? fieldConfidences(result),
    prompt_profile: promptProfile(meta), partiel: resultatPartiel(validation, unwrapped),
    blocs_texte: null, troncature_possible: null, blocs_fournis: null,
    schema_reported: reported.some(item => item != null) };
  for (const name of ["queue_wait_ms", "latency_ms", "generation_ms"]) {
    const value = Object.hasOwn(meta, name) ? meta[name] : (Object.hasOwn(extracted, name) ? extracted[name] : body[name]);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metadata[name] = value;
  }
  return { schema_name: expectedSchema, result: unwrapped, metadata };
}

// Démarrage à froid sur la voie texte (#194). Un `model_profile` `store:<nom>`
// dont le modèle n'est pas encore chargé : `api.resolve_profile` de DocIE
// déclenche le chargement et lève HTTPException(status_code=202) SANS mettre la
// requête en file — corps `{"detail": {"status": "loading", "deployment",
// "eta_seconds", "message"}}`, aucun `result`. Code `loading`, délai annoncé
// porté par error.eta_seconds, message constant : le `message` amont n'est
// jamais recopié (même garantie sur la clé que `context`). Pas de relance
// automatique, décision « échouer bruyamment » de #194 : le consommateur affiche
// le délai, l'utilisateur relance.
function loadingDetail(body) {
  return object(body) && object(body.detail) && body.detail.status === "loading" ? body.detail : null;
}
function failLoading(detail, status) {
  const eta = detail ? detail.eta_seconds : null;
  fail("loading", "DocIE is still loading the requested model; retry later (no automatic retry).", status,
    number(eta) && eta >= 0 ? eta : null);
}

// POST /v1/extract/text answers FLAT — no `choices`, no `finish_reason`. A real
// recorded answer (document-parsing/scripts/test_api.py against the deployment)
// carries: request_id, schema_name, model_profile, document_hash, result,
// validation, usage, latency_ms, dynamic_schema, routing, response_format_style.
// The service blocks the text itself, so `result` is grounded exactly like the
// chat path's — {value, confidence, evidence_ids} per leaf — and every review
// signal built on that keeps working unchanged.
//
// Same metadata contract as parseResponse, same stable error codes, with two
// honest differences that come from the endpoint, not from a choice here:
//   * `agent` is null. There is no agent on this path; claiming one would name
//     a component that took no part in the extraction.
//   * no `incomplete` code. That code reads `finish_reason`, which a chat
//     completion has and this response does not. A truncation shows up here as
//     `validation` errors or an HTTP 413 -> `limits`, both already handled.
//   * `prompt_profile` is null. DocIE's ExtractionResponse (extra="forbid")
//     carries `model_profile` only; null here means "not reported", never
//     "not capped" (#190).
function parseTextResponse(body, expectedSchema) {
  if (!object(body)) fail("response", "Invalid DocIE extraction response.");
  const loading = loadingDetail(body);
  if (loading) failLoading(loading, null);
  const result = body.result;
  if (!object(result) || !Object.keys(result).length) fail("response", "DocIE returned an empty or malformed result.");
  // Same arbitration as the chat path: a NAMED and wrong schema is refused, a
  // SILENT one is accepted and reported as unverified (schema_reported).
  const reported = [body.schema_name, result.document_type];
  if (reported.some(item => item != null && item !== expectedSchema)) fail("schema", "DocIE returned an unexpected document schema.");
  const validation = body.validation ?? null;
  if (validation != null && !object(validation)) fail("response", "Invalid DocIE validation metadata.");
  const confidence = reportedFieldConfidence(body);
  const unwrapped = unwrap(result);
  // `blocs_texte` / `troncature_possible` / `blocs_fournis` : ni le texte ni les
  // blocs envoyés ne sont dans la réponse ; extractText() les renseigne, un
  // appel direct les laisse à null (« inconnu », jamais « aucun bloc fourni »).
  const metadata = { request_id: body.request_id ?? null, agent: null, model: body.model_profile ?? null,
    validation, usage: body.usage ?? null, field_confidence: confidence ?? fieldConfidences(result),
    prompt_profile: null, partiel: resultatPartiel(validation, unwrapped),
    blocs_texte: null, troncature_possible: null, blocs_fournis: null,
    schema_reported: reported.some(item => item != null) };
  for (const name of ["queue_wait_ms", "latency_ms", "generation_ms"]) {
    const value = body[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metadata[name] = value;
  }
  return { schema_name: expectedSchema, result: unwrapped, metadata };
}

// Lecture bornée d'un corps d'erreur, pour le seul classement. Un corps
// illisible (flux coupé, délai) vaut "" : l'échec reste classé par statut.
async function readErrorText(response, key) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (size < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength; chunks.push(Buffer.from(value));
    }
  } catch {} finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BYTES).toString("utf8").split(key).join("[REDACTED]");
}

// One POST, never a retry: DocIE work is potentially billable. Shared by both
// entry points on purpose — status classification, the response ceiling, the
// timeout and the reflected-key redaction are the same guarantees whichever
// DocIE surface is called, and a second copy of them is exactly the drift this
// module exists to prevent.
async function postJson(endpoint, headers, payload, key, timeout, fetchImpl, { loading = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  const started = performance.now();
  let reader;
  try {
    const response = await fetchImpl(endpoint, { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status !== 200) {
      // 413 gets its own code: DocIE refuses a document that is beyond the
      // limits its deployment configures, and a named failure beats a generic
      // upstream one for the only limit we cannot measure before sending.
      const mapped = ({ 401: "auth", 403: "auth", 413: "limits", 429: "rate_limit" })[response.status];
      if (mapped) {
        // `Retry-After` sur 429 : DocIE l'émet sur le quota par fenêtre et sur
        // le blocage d'IP après échecs d'authentification, PAS sur la limite de
        // concurrence du locataire — mesuré chez eux (security.py:178,188-194,
        // 223-225). Absent, illisible ou négatif : on garde le message vague,
        // qui reste donc la règle et non l'exception.
        //
        // La valeur est la LONGUEUR de la fenêtre, pas un délai calculé : elle
        // ne décroît pas à mesure que la fenêtre se vide. On la transporte telle
        // quelle, sans promettre une précision qu'elle n'a pas.
        //
        // Lue sur l'en-tête, jamais sur le corps : celui-ci est annulé juste
        // au-dessous, et un corps amont ne sert ici qu'à classer, jamais à
        // informer (une clé réfléchie ne doit pas ressortir).
        //
        // Secondes uniquement. La RFC autorise aussi une date HTTP ; DocIE
        // n'en émet pas, et deviner un fuseau serait pire que ne rien dire.
        const retry = response.status === 429 ? entierPositif(response.headers?.get?.("retry-after")) : null;
        await response.body?.cancel();
        fail(mapped, response.status === 413
          ? "DocIE refused the document as beyond its configured limits (size, OCR blocks or pages)."
          : "DocIE request failed (HTTP " + response.status + ").", response.status, retry);
      }
      const text = await readErrorText(response, key);
      // `loading` : voie texte seulement (voir loadingDetail). Un 202, ou un
      // corps `detail.status == "loading"` sous un autre statut.
      if (loading) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        const detail = loadingDetail(parsed);
        if (response.status === 202 || detail) failLoading(detail, response.status);
      }
      // Message constant : le corps amont sert à classer, jamais à informer —
      // c'est ce qui garantit qu'une clé réfléchie ne sort pas d'ici.
      if (CONTEXT_OVERFLOW.test(text)) {
        fail("context", "DocIE's model server refused the prompt as beyond its context size: the document is too long for this profile.", response.status);
      }
      fail("upstream", "DocIE request failed (HTTP " + response.status + ").", response.status);
    }
    if (!response.body) fail("response", "DocIE returned an empty response.");
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("response", "DocIE response exceeded 8 MiB.");
      chunks.push(Buffer.from(value));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8").split(key).join("[REDACTED]")); }
    catch { fail("response", "DocIE returned invalid JSON."); }
    return { body, elapsed: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof DocIEBridgeError) throw error;
    if (controller.signal.aborted) fail("timeout", "DocIE timeout; remote processing may continue.");
    fail("network", "DocIE network or TLS failure.");
  } finally {
    clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
}

// Corps de la voie fichier. Isolé pour que le test de borne mesure la charge
// réellement envoyée : toute modification de l'enveloppe (texte d'instruction,
// nouveau champ) doit repasser sous FILE_ENVELOPE_MAX_BYTES, sinon ce test casse.
function filePayload(content, mimeType, agent, tokens) {
  // `parallel_extraction` n'est plus envoye. Il l'etait en dur, "au cas ou",
  // et rien ici n'a jamais mesure qu'il aidait.
  //
  // Mecanisme, lu dans le code DocIE (extract/service.py) et confirme par la
  // session qui tient ce depot : sur un profil NOMME de models.yaml,
  // `deployment_slot_count` vaut None, donc `_split_schema_into_groups` recoit
  // `max_groups=None` et produit la decoupe NATURELLE -- un groupe par champ
  // `list`, plus un groupe de base. Mais le semaphore de fan-out est un
  // Semaphore(1) : les groupes s'executent l'un APRES l'autre, chacun
  // renvoyant le document ENTIER et payant sa propre evaluation de prompt.
  // Ce depot l'avait deja note de son cote (fixtures/blocs_ocr_docie.json) :
  // le decoupage ne porte QUE sur le schema aplati, chaque groupe recevant la
  // liste de blocs entiere (`blocks=blocks`, jamais une tranche).
  //
  // Portee reelle : un seul de nos sept schemas porte des `list` --
  // adbi_resume, et il en porte SIX. L'import de CV sur la voie agent devenait
  // donc SEPT evaluations sequentielles du document complet au lieu d'une.
  // Les six pieces de contrats sont plates : le drapeau y etait inerte.
  //
  // Ne rien envoyer rend la main au defaut de DocIE (extraction non decoupee),
  // qui est precisement ce qu'on veut sur un profil nomme. Le remettre
  // demanderait une condition qu'on ne peut pas evaluer d'ici (nombre de slots
  // observes du deploiement) et une mesure que personne n'a faite.
  return { model: agent, stream: false, max_tokens: tokens,
    messages: [{ role: "user", content: [
      { type: "text", text: "Extract the document using your configured schema. Do not invent missing information." },
      { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + content.toString("base64") } },
    ] }] };
}

// Send one PDF/image to the configured agent. DOCX and text are not sent here:
// the `image_url` wrapper feeds DocIE's OCR backends, which read PDF and images
// only. A source that already carries machine-readable text goes to
// extractText() instead — a different endpoint, not a MIME type to add above.
//
// `agent` (#194) : agent DocIE choisi pour CET appel, prioritaire sur
// DOCIE_AGENT_<KIND> pour cet appel seulement. Sur cette voie le modèle est figé
// par la spec de l'agent (le runtime DocIE écrase `model`) : choisir un modèle,
// c'est choisir un agent. Aucun champ `model` supplémentaire n'est donc envoyé.
// `metadata.agent` nomme l'agent réellement appelé. Pas de liste d'agents
// autorisés ici : voir perCallAgent().
async function extractDocument(content, mimeType, { kind = "resume", agent: agentOverride = null, env = process.env, fetchImpl = fetch } = {}) {
  const { endpoint, key, agent, timeout, tokens } = configuration(kind, env, agentOverride);
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_DOCUMENT_BYTES) {
    fail("input", "Document must contain between 1 byte and " + MAX_DOCUMENT_BYTES + " bytes (DocIE's 26 MiB request body, base64 included).");
  }
  if (!MIME_TYPES.has(mimeType)) fail("input", "Unsupported document MIME type; use PDF, PNG or JPEG.");
  const payload = filePayload(content, mimeType, agent, tokens);
  // Pas de `loading` ici : sur la voie agent, un modèle `store:` froid ne
  // répond pas 202 mais une 500 non rattrapée côté DocIE (#194). Un 202 y reste
  // un échec `upstream`.
  const { body, elapsed } = await postJson(endpoint, { Authorization: "Bearer " + key }, payload, key, timeout, fetchImpl);
  const result = parseResponse(body, SCHEMAS[kind], agent);
  result.metadata.elapsed_ms = elapsed;
  return result;
}

/**
 * Send already-readable text to POST /v1/extract/text. One call, no retry.
 *
 * For a source that HAS machine-readable text — a .txt, a DOCX's paragraphs, a
 * PDF whose text layer was already read. Not a fallback for the file path: a
 * scanned document has no text to send and belongs to extractDocument().
 *
 * Request body, ported from the one shape with a recorded successful grounded
 * answer in this repo (cv-parser/docie_client.py L169 and document-parsing/
 * scripts/test_api.py, whose response is the fixture behind
 * tests/contract_text.json): {text, schema_name, schema_mode, dynamic_schema}.
 * Nothing from the chat path is sent — no `model`, `messages` or `max_tokens` —
 * because nothing shows this endpoint reads them.
 *
 * `dynamicSchema` is the caller's JSON schema and stays the caller's: a
 * transport does not own a business schema. It is not optional in practice for
 * a CUSTOM schema — register_and_test.py records that `schema_name` alone
 * resolves only DocIE's small built-in registry, so `adbi_resume` needs its
 * definition in the request — but omitting it is allowed for the built-in names
 * rather than refused on an assumption about someone's deployment.
 *
 * `ocrBlocks` : blocs de l'appelant, facultatifs. Absents, DocIE découpe `text`
 * lui-même, une ligne non vide par bloc, et il n'y a rien de mieux à proposer
 * pour du texte brut. Fournis, ils REMPLACENT ce découpage : `text` n'est plus
 * ni redécoupé ni ancré (extract/service.py:357), les plafonds comptent NOS
 * blocs, et nos `id` reviennent tels quels dans `evidence_ids`. C'est ce qui
 * rend leur envoi utile là où l'appelant connaît de vraies frontières — les
 * paragraphes d'un DOCX, les pages d'une couche texte de PDF : un document de
 * 2 000 lignes non vides tient alors en quelques centaines de blocs et cesse
 * d'être tronqué en silence par le plafond de 800.
 *
 * `text` part quand même : DocIE ne le redécoupe pas, mais il en tire le
 * `document_hash` quand l'appelant n'en fournit pas — l'envoyer garde ce hachage
 * stable d'une extraction à l'autre.
 *
 * Le pont ne FABRIQUE pas de blocs : les frontières dépendent du document, donc
 * du consommateur. Il valide leur forme et les plafonds (validerBlocsOcr).
 *
 * `modelProfile` (#194) : modèle choisi pour CET appel (`store:<nom>` de
 * préférence, seule forme qui déclenche le chargement à la demande → code
 * `loading`), prioritaire sur DOCIE_MODEL_PROFILE pour cet appel seulement.
 * Absent : comportement inchangé. `metadata.model` reste celui que la RÉPONSE
 * rapporte (`model_profile`), pas celui demandé. Pas de liste de modèles
 * autorisés ici : voir perCallModelProfile().
 *
 * `langue` : code de langue du document, FACULTATIF et SANS DÉFAUT ici. Omis,
 * le prompt de DocIE lit « Language: unknown » — ce qui est VRAI. Aucun défaut
 * dans ce transport, délibérément : « ce document est en français » est une
 * connaissance MÉTIER que le pont n'a pas. Le consommateur qui la sait l'envoie
 * (les pièces d'affaires françaises) ; celui qui ne la sait pas s'abstient — un
 * CV de langue inconnue annoncé « fr » serait une AFFIRMATION FAUSSE au modèle
 * là où « unknown » est vraie. Forme validée, portée réelle selon le profil de
 * prompt, et sources DocIE : voir codeLangue().
 *
 * Volontairement ABSENT de la voie agent : ce corps-là ne lit pas `language`,
 * le runtime ne le prend que sur la SPEC de l'agent (agents/runtime.py:550,
 * 594, 639). L'y ajouter serait ignoré en silence.
 */
async function extractText(text, { kind = "resume", dynamicSchema = null, ocrBlocks = null, modelProfile = null, langue = null, env = process.env, fetchImpl = fetch } = {}) {
  if (!Object.hasOwn(SCHEMAS, kind)) fail("configuration", "Unsupported document kind.");
  const { base, key, timeout } = connection(env);
  const schema = SCHEMAS[kind];
  if (typeof text !== "string" || !text.trim()) fail("input", "Document text must not be empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) fail("input", "Document must contain between 1 byte and 20 MiB.");
  const payload = { text, schema_name: schema };
  if (dynamicSchema != null) {
    if (!object(dynamicSchema) || !Object.keys(dynamicSchema).length) fail("input", "dynamic_schema must be a non-empty schema object.");
    if (dynamicSchema.document_type != null && dynamicSchema.document_type !== schema) fail("input", "dynamic_schema describes another document type.");
    payload.schema_mode = "dynamic";
    payload.dynamic_schema = dynamicSchema;
  }
  if (langue != null) payload.language = codeLangue(langue);
  // Blocs fournis : le même plafond d'octets borne le corps entier. `text` et
  // les blocs voyagent ensemble, donc la seule borne honnête porte sur leur
  // somme — sans quoi un texte de 20 Mio doublé par ses blocs ferait un corps de
  // 40 Mio, refusé par DocIE après coup alors que c'est mesurable ici.
  let blocs, blocsFournis = false;
  if (ocrBlocks != null) {
    const valides = validerBlocsOcr(ocrBlocks);
    if (Buffer.byteLength(text, "utf8") + valides.octets > MAX_TEXT_BYTES) {
      fail("input", "Text and ocr_blocks together must stay under " + MAX_TEXT_BYTES + " bytes.");
    }
    payload.ocr_blocks = valides.blocs;
    blocs = valides.blocs.length;
    blocsFournis = true;
  } else {
    blocs = compterBlocsTexte(text);
  }
  const profile = modelProfile != null ? perCallModelProfile(modelProfile) : (env.DOCIE_MODEL_PROFILE || "").trim();
  if (profile) payload.model_profile = profile;
  // `x-api-key`, not `Authorization: Bearer`: that is the header every recorded
  // success on this endpoint used (cv-parser/docie_client.py, the response saved
  // by document-parsing/scripts/test_api.py). The chat path keeps its own
  // header, equally by measurement.
  // Compté sur ce qui est exactement envoyé (#190). Fait de transport seulement :
  // `troncature_possible` = au-delà de 800 blocs, un profil générique a PU
  // tronquer ; `false` est une garantie contre ce plafond-là (pas contre la
  // taille de contexte, dont le dépassement est bruyant : code `context`).
  // Sans blocs fournis, `blocs_texte` PRÉDIT le découpage de DocIE ; avec eux,
  // il le CONSTATE — c'est le nombre de blocs partis, et `blocs_fournis` dit
  // laquelle des deux lectures s'applique.
  const { body, elapsed } = await postJson(base + "/v1/extract/text", { "x-api-key": key }, payload, key, timeout, fetchImpl, { loading: true });
  const result = parseTextResponse(body, schema);
  result.metadata.blocs_texte = blocs;
  result.metadata.troncature_possible = blocs > DOCIE_BLOCS_TEXTE_MAX;
  result.metadata.blocs_fournis = blocsFournis;
  result.metadata.elapsed_ms = elapsed;
  return result;
}

module.exports = { extractDocument, extractText, parseResponse, parseTextResponse, configuration, filePayload,
  compterBlocsTexte, DOCIE_BLOCS_TEXTE_MAX, validerBlocsOcr, DOCIE_BLOCS_OCR_MAX, DOCIE_BLOC_CARACTERES_MAX,
  DOCIE_TEXTE_CARACTERES_MAX, BLOC_CLES, BLOC_SOURCES, reconnaitreAvertissement, resultatPartiel, RAISONS_PARTIEL,
  MAX_DOCUMENT_BYTES, MAX_TEXT_BYTES, DocIEBridgeError };
