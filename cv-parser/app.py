import re
import sys
import uuid
import json
import os
import io
import traceback
import requests
import threading
import queue
from pathlib import Path
from datetime import datetime

# ── Sortie console en UTF-8 ──────────────────────────────────────────────────
# Lancé depuis un terminal, Python écrit en UTF-8 ; lancé par la Factory, sa
# sortie est un tube et Python retombe sur l'encodage local (cp1252 sur ce
# poste). Le moindre caractère hors latin-1 dans un print() — la flèche « → »
# d'une trace d'étape, par exemple — lève alors UnicodeEncodeError, et comme
# ces print() sont AU MILIEU du pipeline, l'exception fait échouer toute
# l'analyse du CV : la fiche ressortait vide sans que rien n'indique pourquoi.
# Une trace ne doit jamais pouvoir casser un traitement.
for _flux in (sys.stdout, sys.stderr):
    try:
        _flux.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from flask import Flask, request, jsonify, send_file, render_template, abort, redirect, g
from flask_cors import CORS
from werkzeug.exceptions import HTTPException
# Docling n'est volontairement PAS importé ici : cet import coûte à lui seul
# près d'une minute (mesuré : 59 s), et il bloquait le démarrage de Flask alors
# que le convertisseur est déjà construit en tâche de fond juste plus bas.
# Il est donc fait dans _init_converter(), qui tourne dans son propre thread :
# l'application répond en quelques secondes, et le premier CV déposé attend le
# convertisseur si celui-ci n'est pas encore prêt (voir _get_converter).
from skills_normalizer import normalize_skills, skills_to_flat, compute_skills_flat
# Appel LLM avec chaîne de secours : si un service est en panne ou à court de
# quota, le suivant prend le relais au lieu de faire échouer l'analyse.
import llm_cascade
from llm_cascade import chat as llm_chat, LLMIndisponible
# Dossier de compétences ADBI, en PDF et en Word.
import export_dossier
# Rapprochement fiche de poste → sélection de CV.
from core import rapprochement

# ── python-docx (Word export) — imported once at module level ─────────────────
try:
    from docx import Document as DocxDoc
    from docx.shared import Pt, RGBColor, Cm, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    _DOCX_AVAILABLE = True
except ImportError:
    _DOCX_AVAILABLE = False

# ── Config centralisée ────────────────────────────────────────────────────────
from config import (
    UPLOAD_DIR, MAX_LLM_CHARS,
    get_active_llm, set_active_llm,
)

# ── Auth ──────────────────────────────────────────────────────────────────────
from core.auth import (
    require_auth, require_superuser, get_current_user,
    verify_access_token, ensure_default_superuser,
    AUTH_ACTIVE,
)
# ── PostgreSQL (issue #15, PR B) ───────────────────────────────────────────────
# init_schema() crée toutes les tables (needs/matching_results/users/
# refresh_tokens/invites/activity/cvs) — un seul schema.sql pour tout, voir
# core/pg.py. cvstore_pg remplace les anciens load_db()/save_db() d'app.py
# (dict complet cv_database.json) par des lectures/écritures ligne à ligne ;
# importé en module (cvstore_pg.get_cv, ...) pour ne pas entrer en conflit
# avec les routes de ce fichier qui portent les mêmes noms
# (get_cv, list_cvs, delete_cv).
from core.pg import init_schema, ping as _pg_ping
from core.activity_pg import log_event as _log
from core import cvstore_pg

# ── Blueprints ────────────────────────────────────────────────────────────────
from api.auth_bp      import auth_bp
from api.needs_bp     import needs_bp
from api.matching_bp  import matching_bp
from api.settings_bp  import settings_bp

app = Flask(__name__)
CORS(app, supports_credentials=True)

# ── Plafond de taille de corps de requête ────────────────────────────────────
# Sans ceci, Flask/Werkzeug acceptent un corps de taille arbitraire : un CV de
# plusieurs Go déposé via /api/upload s'écrirait intégralement sous
# uploads/ (volume Docker persistant, docker-compose.yml) avant même d'être
# regardé. one-pager applique déjà un plafond équivalent sur sa route
# d'import de CV (express.json({ limit: "25mb" })) — même discipline ici.
# Un dépassement lève RequestEntityTooLarge (413), rattrapée par
# handle_exception ci-dessous qui répond en JSON comme le reste de l'API.
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 Mo

# ── Enregistrement des blueprints ─────────────────────────────────────────────
app.register_blueprint(auth_bp)
app.register_blueprint(needs_bp)
app.register_blueprint(matching_bp)
app.register_blueprint(settings_bp)

# ── Initialisation au chargement du module ────────────────────────────────────
# Faite ICI (pas seulement dans le bloc `if __name__ == "__main__":` plus bas)
# car Gunicorn importe ce fichier comme un module (`app:app`, voir Dockerfile
# et gunicorn.conf.py) et n'exécute jamais ce bloc : sans ce déplacement, le
# schéma PostgreSQL et le superuser par défaut n'auraient plus été créés du
# tout en conteneur. Les deux fonctions sont idempotentes (schema.sql en
# `CREATE TABLE IF NOT EXISTS`, superuser créé seulement si `list_users()` est
# vide) — sûres à appeler à chaque démarrage de processus, `python app.py`
# comme Gunicorn.
init_schema()                 # Crée les tables PostgreSQL si absentes (DATABASE_URL requise)
ensure_default_superuser()    # Crée admin@adbi.fr si aucun utilisateur

if not AUTH_ACTIVE:
    print("[AUTH] ⚠ Authentification DÉSACTIVÉE (ADBI_AUTH != on) — "
          "à réserver au poste local, jamais à un déploiement exposé.")

# ── Context processor Jinja2 ─────────────────────────────────────────────────
@app.context_processor
def inject_user():
    token = request.cookies.get("adbi_access")
    if token:
        payload = verify_access_token(token)
        if payload:
            return {"current_user": payload}
    return {"current_user": None}

@app.errorhandler(LLMIndisponible)
def handle_llm_indisponible(e):
    """
    Tous les services de la chaîne ont échoué.

    Ce n'est pas forcément une erreur du serveur : la passerelle interne peut
    être momentanément saturée ou hors ligne, ou n'être simplement pas encore
    configurée (ADBI_LLM_BASE_URL absente). Un « 500 Erreur interne » laissait
    croire à une panne de l'application et envoyait chercher le problème au
    mauvais endroit ; un 503 avec le motif exact évite ce détour.
    """
    print(f"[LLM] indisponible : {e}")
    return jsonify({
        "error": "Tous les services de langage sont momentanément indisponibles.",
        "detail": str(e),
        "conseil": ("Vérifiez que la passerelle d'inférence interne (ADBI_LLM_BASE_URL) "
                    "est configurée et joignable, ou réessayez dans quelques instants."),
    }), 503


@app.errorhandler(Exception)
def handle_exception(e):
    """
    Filet de sécurité pour les erreurs imprévues.

    Les erreurs HTTP normales — 404 sur une page inconnue, 403, 405 — passent
    telles quelles : les attraper ici transformait un simple « page
    introuvable » en « erreur serveur », y compris pour un `/favicon.ico`
    absent, et faisait chercher une panne là où il n'y en avait pas.
    """
    if isinstance(e, HTTPException):
        return jsonify({"error": e.description, "code": e.code}), e.code
    traceback.print_exc()
    return jsonify({"error": f"Erreur serveur : {str(e)}"}), 500

_converter      = None          # Singleton DocumentConverter (chargé une seule fois)
_converter_lock = threading.Lock()


# ── Pré-chargement de Docling en arrière-plan au démarrage ───────────────────
def _init_converter():
    global _converter
    try:
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.datamodel.base_models import InputFormat
        from docling.document_converter import DocumentConverter, PdfFormatOption

        # OCR ACTIVÉ : ce convertisseur n'est jamais utilisé pour les CVs
        # numériques (voir process_cv() — un CV avec couche texte passe par
        # _extract_text_fast()/pdfplumber et ne touche pas à Docling). Il ne
        # sert QUE de secours pour les PDF scannés/images, où l'OCR est la
        # seule façon d'obtenir du texte. Le désactiver ici revenait à couper
        # l'OCR sur le seul chemin qui en a besoin, et laissait un CV papier
        # scanné ressortir vide, marqué inexploitable (issue #63).
        opts = PdfPipelineOptions()
        opts.do_ocr = True
        opts.do_table_structure = False   # ralentit sans apporter grand-chose

        _converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
        )
        print("[INFO] DocumentConverter prêt (OCR activé, tables désactivées).")
    except Exception as e:
        print(f"[WARN] Impossible d'initialiser le convertisseur optimisé ({e}) — nouvelle tentative en options minimales.")
        try:
            # Deuxième tentative : options minimales, OCR conservé (voir
            # commentaire ci-dessus : c'est le seul chemin qui en a besoin).
            from docling.datamodel.pipeline_options import PdfPipelineOptions
            from docling.datamodel.base_models import InputFormat
            from docling.document_converter import DocumentConverter, PdfFormatOption
            opts2 = PdfPipelineOptions()
            opts2.do_ocr             = True
            opts2.do_table_structure = False
            _converter = DocumentConverter(
                format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts2)}
            )
            print("[INFO] DocumentConverter prêt (fallback, OCR activé).")
        except Exception as e2:
            print(f"[ERREUR] DocumentConverter inutilisable : {e2}")

threading.Thread(target=_init_converter, daemon=True).start()

def _get_converter() -> "DocumentConverter":   # annotation en texte : le type n'est importé qu'au chargement du thread
    """Retourne le convertisseur singleton (attend s'il est encore en cours d'init)."""
    if _converter is None:
        with _converter_lock:
            if _converter is None:
                _init_converter()
    return _converter

SECTION_MAP = {
    "experience": [
        "expérience", "experience", "emploi", "poste", "postes",
        "parcours professionnel", "carrière", "professional experience",
        "work experience", "expériences professionnelles", "expériences",
    ],
    "education": [
        "formation", "éducation", "education", "diplôme", "diplômes",
        "études", "cursus", "scolarité", "parcours académique",
        "academic", "formations",
    ],
    "skills": [
        "compétence", "competence", "skill", "technologie", "outil",
        "langage", "expertise", "stack", "maîtrise", "savoir",
        "technical", "informatique",
    ],
    "languages": ["langue", "language"],
    "projects": ["projet", "project", "réalisation", "travaux", "réalisations"],
    "certifications": [
        "certification", "certificat", "certificate", "accréditation",
    ],
    "interests": ["intérêt", "loisir", "hobby", "activité", "centre d'intérêt"],
}


def classify_header(text):
    """Return section key if text matches a known section keyword, else None."""
    t = text.lower().strip()
    # Strip HTML entities Docling sometimes produces
    t = re.sub(r"&\w+;", " ", t)
    for section, keywords in SECTION_MAP.items():
        if any(kw in t for kw in keywords):
            return section
    return None


def parse_markdown(md):
    """Split markdown into sections.

    Key insight from real Docling output:
    - H2 (##) is used for BOTH section headings AND entry headings inside a section.
    - Entry headings are H2 lines that do NOT match any section keyword.
    - The period for an entry often appears on the NEXT plain-text line.
    """
    sections = {}
    intro = []
    current_section = None
    current_lines = []

    for line in md.split("\n"):
        h_match = re.match(r"^(#{1,2})\s+(.+)$", line)
        if h_match:
            level = len(h_match.group(1))
            header_text = h_match.group(2).strip()
            classified = classify_header(header_text)

            if classified:
                # ── Known section keyword → flush and start new section ──
                if current_section:
                    sections.setdefault(current_section, []).extend(current_lines)
                elif current_lines:
                    intro.extend(current_lines)
                current_section = classified
                current_lines = []
            elif current_section is None:
                # ── Before any section → save to intro ──
                if current_lines:
                    intro.extend(current_lines)
                    current_lines = []
                if level == 1:
                    intro.append(f"__name__:{header_text}")
                else:
                    intro.append(f"__heading__:{header_text}")
            else:
                # ── Inside a section, non-classified H2 → it's an entry header ──
                current_lines.append(line)
        else:
            # H3+ or plain text → always content
            current_lines.append(line)

    if current_section and current_lines:
        sections.setdefault(current_section, []).extend(current_lines)
    elif current_lines:
        intro.extend(current_lines)

    sections["__intro__"] = intro
    return sections


def extract_contact(text: str) -> dict:
    emails = re.findall(r"[\w.+\-]+@[\w\-]+\.[\w.]+", text)
    phones = re.findall(
        r"(?:(?:\+33|0033)\s?|0)[1-9](?:[\s.\-]?\d{2}){4}", text
    )
    if not phones:
        phones = re.findall(r"(?:\+\d{1,3}[\s\-]?)?\d[\d\s.\-]{7,14}\d", text)
    linkedins = re.findall(r"linkedin\.com/in/[\w\-./]+", text, re.IGNORECASE)
    githubs = re.findall(r"github\.com/[\w\-./]+", text, re.IGNORECASE)
    cities = re.findall(
        r"\b(?:Paris|Lyon|Marseille|Bordeaux|Nantes|Toulouse|Strasbourg|Lille|"
        r"Rennes|Nice|Grenoble|Montpellier|Rouen|Toulon|Reims|Dijon|Caen|"
        r"Casablanca|Rabat|Tunis|Alger|Dakar|Abidjan|Genève|Bruxelles|"
        r"Montréal|Québec|Dubai|Londres|London)\b",
        text,
    )
    return {
        "email": emails[0] if emails else "",
        "phone": phones[0].strip() if phones else "",
        "linkedin": linkedins[0] if linkedins else "",
        "github": githubs[0] if githubs else "",
        "location": cities[0] if cities else "",
    }


def extract_name_title(sections, raw_text, contact=None):
    name, title = "", ""

    intro = sections.get("__intro__", [])
    for line in intro:
        if line.startswith("__name__:"):
            name = line[9:].strip()
        elif line.startswith("__heading__:"):
            # First unclassified H2 before any section = title/role
            if not title:
                title = line[12:].strip()
                # Strip HTML entities
                title = re.sub(r"&\w+;", "&", title).strip()

    # Fallback: first name-looking line in raw text
    if not name:
        for line in raw_text.strip().split("\n")[:15]:
            line = line.strip()
            if not line or re.search(r"@|http|linkedin|github", line, re.IGNORECASE):
                continue
            words = line.split()
            if 2 <= len(words) <= 5 and all(w[0:1].isupper() for w in words if w):
                if not any(kw in line.lower() for kw in ["curriculum", "vitae", "resume", "cv "]):
                    name = line
                    break

    # Last resort: derive name from email (e.g. amine.bounizel@ → "Amine Bounizel")
    if not name and contact:
        email = contact.get("email", "")
        if email and "@" in email:
            local = email.split("@")[0]
            parts = re.split(r"[._\-]", local)
            candidate = " ".join(p.capitalize() for p in parts if p and p.isalpha())
            if 2 <= len(candidate.split()) <= 4:
                name = candidate

    return name, title


def parse_entries(lines):
    """Generic parser for experience / education / projects.

    Handles Docling markdown where:
    - Entry headers are H2 (##) lines inside a section
    - The period is often on the NEXT line (e.g. 'Jul 2024-Present')
    """
    entries = []
    current = None

    PERIOD_RE = re.compile(
        r"^("
        r"(?:jan|fév|feb|mar|avr|apr|mai|may|juin|jun|juil|jul|aoû|aug|sep|oct|nov|déc|dec)"
        r"\.?\s+\d{4}\s*[-–]\s*"
        r"(?:(?:jan|fév|feb|mar|avr|apr|mai|may|juin|jun|juil|jul|aoû|aug|sep|oct|nov|déc|dec)\.?\s+)?"
        r"(?:\d{4}|présent|present|aujourd'hui|current|maintenant|En cours|Aujourd'hui)"
        r"|"
        r"\d{4}\s*[-–]\s*(?:\d{4}|présent|present|aujourd'hui|current|maintenant|En cours)"
        r"|\d{4}\s*[-–]\s*\d{4}"
        r")$",
        re.IGNORECASE,
    )
    INLINE_PERIOD_RE = re.compile(
        r"\(([^)]*\d{4}[^)]*)\)"
        r"|(\d{4}\s*[-–]\s*(?:\d{4}|présent|present|aujourd'hui|current|maintenant|En cours))",
        re.IGNORECASE,
    )
    SEP_RE = re.compile(r"\s+[-–|@]\s+|\s+chez\s+|\s+at\s+|\s+pour\s+", re.IGNORECASE)

    awaiting_period = False   # True when we just started an entry and have no period yet

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped == "<!-- image -->":
            continue

        h_match = re.match(r"^#{1,3}\s+(.+)$", line)
        bold_match = re.match(r"^\*\*(.+?)\*\*", line)
        is_entry_header = h_match or (bold_match and re.search(r"\d{4}", line))

        if is_entry_header:
            if current:
                entries.append(current)

            raw = (h_match.group(1) if h_match else re.sub(r"\*+", "", stripped)).strip()
            raw = re.sub(r"&\w+;", " ", raw).strip()

            period = ""
            pm = INLINE_PERIOD_RE.search(raw)
            if pm:
                period = (pm.group(1) or pm.group(2) or "").strip()
                raw = raw[: pm.start()].rstrip("( ") + raw[pm.end() :].lstrip(") ")
                raw = raw.strip()

            parts = SEP_RE.split(raw, maxsplit=1)
            job_title = parts[0].strip()
            subtitle = parts[1].strip() if len(parts) > 1 else ""

            awaiting_period = not bool(period)
            current = {"title": job_title, "subtitle": subtitle, "period": period, "bullets": []}

        elif current:
            # Check if this standalone line is the period (e.g. "Jul 2024-Present")
            if awaiting_period and PERIOD_RE.match(stripped):
                current["period"] = stripped
                awaiting_period = False
            else:
                awaiting_period = False
                bullet = re.sub(r"^[-•*]\s+", "", stripped)
                if bullet and not re.match(r"^#{1,3}\s", line):
                    current["bullets"].append(bullet)

    if current:
        entries.append(current)

    for e in entries:
        split = split_bullets(e.pop("bullets"))
        e.update(split)

    return entries


def parse_skills(lines: list[str]) -> list[dict]:
    categories = []
    current_cat = ""
    current_items: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        h_match = re.match(r"^#{2,3}\s+(.+)$", line)
        bold_cat = re.match(r"^\*\*([^*]{1,40})\*\*\s*:?\s*(.*)$", stripped)
        colon_cat = re.match(r"^([A-ZÀ-Üa-zà-ü][^:]{1,35})\s*:\s*(.{3,})$", stripped)

        if h_match:
            if current_cat and current_items:
                categories.append({"category": current_cat, "items": current_items})
            current_cat = h_match.group(1).strip()
            current_items = []
        elif bold_cat:
            if current_cat and current_items:
                categories.append({"category": current_cat, "items": current_items})
            current_cat = bold_cat.group(1).strip()
            rest = bold_cat.group(2).strip()
            current_items = (
                [i.strip() for i in re.split(r"[,;|]", rest) if i.strip()]
                if rest
                else []
            )
        elif colon_cat:
            cat_name = colon_cat.group(1).strip()
            items = [
                i.strip()
                for i in re.split(r"[,;|/]", colon_cat.group(2))
                if i.strip()
            ]
            if items:
                if current_cat and current_items:
                    categories.append(
                        {"category": current_cat, "items": current_items}
                    )
                    current_items = []
                categories.append({"category": cat_name, "items": items})
                current_cat = ""
        else:
            clean = re.sub(r"^[-•*]\s+", "", stripped)
            items = [i.strip() for i in re.split(r"[,;|/]", clean) if i.strip()]
            if not current_cat:
                current_cat = "Compétences"
            current_items.extend(items)

    if current_cat and current_items:
        categories.append({"category": current_cat, "items": current_items})

    return categories


def parse_languages(lines: list[str]) -> list[dict]:
    langs = []
    LEVEL_RE = re.compile(
        r"natif|native|maternel(?:le)?|bilingue|bilingual|courant|fluent|"
        r"avancé|advanced|professionnel|professional|"
        r"intermédiaire|intermediate|débutant|beginner|notions?|basic|"
        r"[abc][12]|toeic[\s\d]*|toefl[\s\d]*|ielts[\s\d]*|delf|dalf",
        re.IGNORECASE,
    )
    for line in lines:
        clean = re.sub(r"^[-•*#]\s+", "", line.strip())
        if not clean:
            continue
        lm = LEVEL_RE.search(clean)
        level = lm.group(0).strip() if lm else ""
        lang_name = LEVEL_RE.sub("", clean).strip(":-() \t")
        lang_name = re.sub(r"\s+", " ", lang_name).strip()
        if lang_name and len(lang_name) < 40:
            langs.append({"language": lang_name, "level": level})
    return langs


def split_bullets(bullets: list[str]) -> dict:
    """Categorize experience bullets into company CV structured fields."""
    ENV_LABEL = re.compile(
        r"^(?:environnement\s+(?:technique|tech\.?)|stack\s+tech(?:nique)?|technologie[s]?|outil[s]?)\s*[:;]\s*",
        re.IGNORECASE,
    )
    METH_LABEL = re.compile(
        r"^(?:m[eé]thodologie|m[eé]thode|organisation(?:\s+du\s+travail)?)\s*[:;]\s*",
        re.IGNORECASE,
    )
    CTX_LABEL = re.compile(
        r"^(?:contexte|context|cadre|mission)\s*[:;]\s*",
        re.IGNORECASE,
    )
    OBJ_LABEL = re.compile(
        r"^(?:objectif[s]?|but[s]?|enjeu[x]?|r[eé]sultat[s]?)\s*[:;]\s*",
        re.IGNORECASE,
    )
    # Heuristic: comma-separated short tokens → tech stack
    TECH_HEURISTIC = re.compile(
        r"^[\w\s.\-+#()/]+(,\s*[\w\s.\-+#()/]+){4,}$",
    )
    METH_WORDS = re.compile(
        r"\b(?:agile|scrum|kanban|safe|cycle\s+en\s+v|devops|lean|itil|sprint|waterfall)\b",
        re.IGNORECASE,
    )

    contexte = ""
    objectifs = ""
    methodologie = ""
    env_technique = ""
    description = []

    for b in bullets:
        s = b.strip()
        if not s:
            continue
        env_m  = ENV_LABEL.match(s)
        meth_m = METH_LABEL.match(s)
        ctx_m  = CTX_LABEL.match(s)
        obj_m  = OBJ_LABEL.match(s)

        if env_m and not env_technique:
            env_technique = s[env_m.end():].strip()
        elif meth_m and not methodologie:
            methodologie = s[meth_m.end():].strip()
        elif ctx_m and not contexte:
            contexte = s[ctx_m.end():].strip()
        elif obj_m and not objectifs:
            objectifs = s[obj_m.end():].strip()
        elif not env_technique and TECH_HEURISTIC.match(s) and len(s) > 30:
            env_technique = s
        elif not methodologie and METH_WORDS.search(s) and len(s) < 100:
            methodologie = s
        elif not contexte and len(s) > 80:
            contexte = s
        else:
            description.append(s)

    return {
        "contexte":     contexte,
        "objectifs":    objectifs,
        "methodologie": methodologie,
        "env_technique":env_technique,
        "description":  " · ".join(description),
    }


def compute_years_experience(experience: list[dict]) -> int:
    """Estimate total years of experience from period strings."""
    YEAR_RE   = re.compile(r"\b(20\d{2}|19\d{2})\b")
    PRESENT_RE = re.compile(
        r"présent|present|aujourd'hui|current|maintenant|en\s+cours",
        re.IGNORECASE,
    )
    now_year = datetime.now().year
    total_months = 0
    for exp in experience:
        period = exp.get("period", "") or ""
        years = YEAR_RE.findall(period)
        if len(years) >= 1:
            start = int(years[0])
            end   = now_year if PRESENT_RE.search(period) else int(years[-1])
            total_months += max(0, end - start) * 12
        elif period:
            total_months += 12
    return max(0, round(total_months / 12))


def parse_certifications(lines: list[str]) -> list[dict]:
    certs = []
    for line in lines:
        clean = re.sub(r"^[-•*#]+\s*", "", line.strip())
        if not clean:
            continue
        year_m = re.search(r"(\d{4})", clean)
        certs.append({"name": clean, "year": year_m.group(1) if year_m else ""})
    return certs


def llm_enrich_experiences(experiences: list[dict]) -> list[dict]:
    """Call OpenRouter once to enrich all experience entries with structured fields."""
    if not experiences:
        return experiences

    entries_text = ""
    for i, exp in enumerate(experiences):
        raw = exp.get("description", "")
        entries_text += (
            f"\n### Expérience {i + 1}\n"
            f"Entreprise/Titre : {exp.get('title', '')}\n"
            f"Poste : {exp.get('subtitle', '')}\n"
            f"Période : {exp.get('period', '')}\n"
            f"Texte brut : {raw}\n"
        )

    prompt = (
        "Tu analyses des expériences professionnelles extraites d'un CV.\n\n"
        f"{entries_text}\n"
        "Pour chaque expérience, retourne un tableau JSON (même ordre) :\n"
        "[\n"
        "  {\n"
        '    "contexte": "Secteur, client, environnement métier de la mission",\n'
        '    "objectifs": "Objectifs, responsabilités et enjeux du poste",\n'
        '    "methodologie": "Méthode de travail (Agile, Scrum, Kanban, Cycle en V…)",\n'
        '    "env_technique": "Technologies, outils, langages (séparés par des virgules)",\n'
        '    "description": "Réalisations et tâches principales"\n'
        "  }\n"
        "]\n\n"
        "Règles :\n"
        "- Utilise UNIQUEMENT ce qui est dans le texte, n'invente rien.\n"
        '- Si une info est absente, laisse le champ à "".\n'
        "- Réponds UNIQUEMENT avec le JSON valide, sans aucun texte autour."
    )

    try:
        content, _service = llm_chat([{"role": "user", "content": prompt}],
                                     max_tokens=2000, temperature=0, timeout=60)
        json_match = re.search(r"\[[\s\S]*\]", content)
        if json_match:
            results = json.loads(json_match.group(0))
            for i, result in enumerate(results):
                if i < len(experiences):
                    for field in ("contexte", "objectifs", "methodologie", "env_technique", "description"):
                        val = (result.get(field) or "").strip()
                        if val:
                            experiences[i][field] = val
        else:
            print("[WARN] llm_enrich_experiences : aucun tableau JSON trouvé dans la réponse.")
    except LLMIndisponible as e:
        # Tous les services de la chaîne ont échoué : le CV reste exploitable,
        # seul l'enrichissement des expériences est ignoré.
        print(f"[WARN] llm_enrich_experiences : {e} — enrichissement ignoré.")
    except json.JSONDecodeError as e:
        print(f"[WARN] llm_enrich_experiences : JSON invalide — {e}")
    except Exception:
        traceback.print_exc()

    return experiences


def _extract_text_fast(file_path) -> str:
    """Extraction de texte rapide sans ML — < 0.5 seconde.
    Essaie pdfplumber puis pypdf pour les PDF, python-docx pour les DOCX.
    """
    ext = Path(file_path).suffix.lower()
    if ext == ".pdf":
        # Essai 1 : pdfplumber (meilleure qualité de mise en page)
        try:
            import pdfplumber
            with pdfplumber.open(str(file_path)) as pdf:
                pages = [p.extract_text(x_tolerance=3, y_tolerance=3) or "" for p in pdf.pages]
            text = "\n\n".join(p for p in pages if p.strip())
            if text.strip():
                print(f"[INFO] pdfplumber OK — {len(text)} chars extraits.")
                return text
        except ImportError:
            pass
        except Exception as e:
            print(f"[WARN] pdfplumber : {e}")
        # Essai 2 : pypdf (plus léger)
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(file_path))
            pages = [page.extract_text() or "" for page in reader.pages]
            text = "\n\n".join(p for p in pages if p.strip())
            if text.strip():
                print(f"[INFO] pypdf OK — {len(text)} chars extraits.")
                return text
        except ImportError:
            pass
        except Exception as e:
            print(f"[WARN] pypdf : {e}")
    elif ext == ".docx":
        try:
            from docx import Document as DocxDocument
            doc = DocxDocument(str(file_path))
            text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
            if text.strip():
                print(f"[INFO] python-docx OK — {len(text)} chars extraits.")
                return text
        except Exception as e:
            print(f"[WARN] python-docx : {e}")
    return ""


def clean_text_for_llm(text: str) -> str:
    """
    Nettoie et compacte le texte avant envoi au LLM.
    - Supprime les lignes vides, marqueurs image, séparateurs
    - Déduplique les lignes courtes répétées
    - Réduit la taille du contexte de 20-40 %
    """
    lines = text.split("\n")
    seen: set[str] = set()
    cleaned: list[str] = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        # Marqueurs Docling inutiles
        if s in ("<!-- image -->", "---", "===", "***", "___"):
            continue
        # Lignes composées d'un seul caractère répété (ex: ----------)
        if len(set(s)) <= 2 and len(s) > 5:
            continue
        # Déduplique les lignes très courtes répétées (en-têtes, footers, numéros de page…)
        if len(s) < 12 and s in seen:
            continue
        seen.add(s)
        cleaned.append(s)
    result = "\n".join(cleaned)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def _to_str(obj) -> str:
    """Safely convert any Docling export result to a plain string."""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj
    # Some Docling versions return an object with a .html / .text property
    for attr in ("html", "text", "content"):
        if hasattr(obj, attr):
            return str(getattr(obj, attr))
    return str(obj)


def _safe(fn, *args, default=None):
    """Call fn(*args) and return default on any exception (logs to stderr)."""
    try:
        return fn(*args)
    except Exception as exc:
        traceback.print_exc()
        return default if default is not None else {}


_CV_SYSTEM_PROMPT = """Tu es un expert en parsing de CVs professionnels.
Réponds UNIQUEMENT avec un objet JSON valide (pas de markdown, pas de ```json).
Structure exacte à respecter :
{"name":"","title":"","contact":{"email":"","phone":"","linkedin":"","github":"","location":""},"experience":[{"company":"","client":"","title":"","period":"","contexte":"","objectifs":"","methodologie":"","env_technique":"","description":""}],"education":[{"title":"","subtitle":"","period":"","description":""}],"skills":[{"category":"","items":[]}],"languages":[{"language":"","level":""}],"projects":[{"title":"","subtitle":"","period":"","description":""}],"certifications":[{"name":"","year":""}],"interests":[]}

Règles critiques :
- Extrais UNIQUEMENT ce qui est présent dans le CV, n'invente rien. Champs absents = "".
- Réalisations dans "description" séparées par ' · '.
- "skills" : remplis UNIQUEMENT depuis la section dédiée compétences/skills du CV (catégorie + outils listés). Ne recopie PAS les technologies des expériences dans skills.
- "env_technique" de chaque expérience : liste TOUTES les technologies, frameworks, outils, langages mentionnés dans cette mission spécifique (séparés par des virgules). Ce champ ne doit JAMAIS rester vide si des technologies sont citées dans la mission.
- Ne duplique PAS le même outil dans plusieurs catégories de skills."""


# Rubriques du dossier de compétences ADBI (templates/company_cv.html), dans
# l'ordre où elles y apparaissent. Sert à dire, juste après le parsing, ce que
# le document produit contiendra et ce qui y manquera.
_RUBRIQUES_ADBI = [
    ("name",             "Nom"),
    ("title",            "Titre / poste"),
    ("years_experience", "Années d'expérience"),
    ("contact",          "Contact"),
    ("skills",           "Compétences techniques"),
    ("experience",       "Expériences"),
    ("education",        "Formations"),
    ("certifications",   "Certifications"),
    ("languages",        "Langues"),
    ("interests",        "Centres d'intérêt"),
]


def bilan_adbi(cv: dict) -> dict:
    """
    État de remplissage du dossier ADBI, rubrique par rubrique.

    Un CV parsé peut être « réussi » techniquement et rester inexploitable pour
    le dossier de compétences s'il manque les expériences ou les compétences.
    Ce bilan le dit tout de suite, au lieu de le laisser découvrir à l'ouverture
    du document.
    """
    rempli, manquant = {}, []
    for cle, libelle in _RUBRIQUES_ADBI:
        valeur = cv.get(cle)
        if isinstance(valeur, list):
            compte = len(valeur)
        elif isinstance(valeur, dict):
            compte = sum(1 for v in valeur.values() if str(v or "").strip())
        elif cle == "years_experience":
            compte = int(valeur or 0)
        else:
            compte = 1 if str(valeur or "").strip() else 0
        rempli[libelle] = compte
        if not compte:
            manquant.append(libelle)

    essentielles = {"Nom", "Expériences", "Compétences techniques"}
    return {
        "rubriques": rempli,
        "manquantes": manquant,
        "exploitable": not (essentielles & set(manquant)),
    }


def _json_du_cv(content: str) -> dict:
    """
    Extrait l'objet JSON de la réponse d'un modèle.

    Sert deux fois : comme validateur passé à la cascade — une réponse
    inexploitable disqualifie alors le modèle et on passe au suivant — puis
    pour lire le résultat retenu. Lève ValueError si rien n'est récupérable,
    typiquement quand la réponse a été coupée par la limite de jetons.
    """
    propre = (content or "").strip()
    if propre.startswith("```"):
        lignes = propre.split("\n")
        if lignes[0].startswith("```"):
            lignes = lignes[1:]
        if lignes and lignes[-1].startswith("```"):
            lignes = lignes[:-1]
        propre = "\n".join(lignes).strip()

    try:
        return json.loads(propre)
    except json.JSONDecodeError:
        pass

    trouve = re.search(r"\{[\s\S]*\}", propre)
    if trouve:
        try:
            return json.loads(trouve.group(0))
        except json.JSONDecodeError:
            pass

    tronquee = not propre.rstrip().endswith("}")
    raise ValueError(
        ("réponse tronquée par la limite de jetons" if tronquee else "réponse non JSON")
        + f" : {propre[:200]}"
    )


def llm_parse_cv(md_content: str, txt_content: str, progression=None) -> dict:
    """Parse le CV via LLM. Retourne un dict avec timing inclus."""
    import time
    t0 = time.perf_counter()

    input_chars = len(md_content)
    print(f"[PERF] llm_parse_cv — {input_chars} chars input")

    try:
        t_req = time.perf_counter()
        content, service = llm_chat(
            [
                {"role": "system", "content": _CV_SYSTEM_PROMPT},
                {"role": "user",   "content": f"CV à analyser :\n---\n{md_content}\n---"},
            ],
            # 2 500 jetons ne suffisaient pas : sur un CV riche, le JSON était
            # coupé en plein milieu d'une valeur, devenait illisible, et toute
            # la fiche ressortait vide. Un modèle « raisonneur » aggrave le cas
            # en consommant une partie du budget avant d'écrire la réponse.
            max_tokens=7000,
            temperature=0,
            # 35 s par modèle : au-delà, un des cinq autres fera mieux. Et un
            # budget TOTAL de 75 s pour toute la cascade — passé ce délai,
            # l'extraction locale de secours prend la main : mesuré, la
            # cascade saturée retenait l'analyse 97 s pour finir en repli
            # local de toute façon.
            timeout=35,
            budget_s=75,
            progression=progression,
            # Impose un objet JSON : évite le texte d'introduction et le
            # brouillon de réflexion, donc du budget gagné pour la réponse.
            json_mode=True,
            # Le CV est le plus gros envoi de l'application : on s'assure
            # d'abord qu'un modèle répond, plutôt que d'expédier le document
            # vers un service hors service ou à court de quota.
            verifier=True,
            # Une réponse tronquée compte comme un échec de CE modèle : la
            # cascade en essaie un autre au lieu de rendre une fiche vide.
            valider=_json_du_cv,
        )
        elapsed_req = time.perf_counter() - t_req
    except LLMIndisponible as e:
        # Tous les services ont échoué : là, l'analyse ne peut pas aboutir.
        raise RuntimeError(str(e))

    t_total = time.perf_counter() - t0
    print(f"[PERF] LLM terminé en {elapsed_req:.1f}s (total {t_total:.1f}s) via {service}")

    return _json_du_cv(content)


def normalize_cv_data(data: dict, html_content: str = "") -> dict:
    normalized = {
        "name": str(data.get("name") or "").strip(),
        "title": str(data.get("title") or "").strip(),
        "years_experience": 0,
        "contact": {},
        "experience": [],
        "education": [],
        "skills": [],
        "languages": [],
        "projects": [],
        "certifications": [],
        "interests": [],
        "html_content": html_content
    }
    
    contact_src = data.get("contact") or {}
    normalized["contact"] = {
        "email": str(contact_src.get("email") or "").strip(),
        "phone": str(contact_src.get("phone") or "").strip(),
        "linkedin": str(contact_src.get("linkedin") or "").strip(),
        "github": str(contact_src.get("github") or "").strip(),
        "location": str(contact_src.get("location") or "").strip(),
    }
    
    for exp in (data.get("experience") or []):
        normalized["experience"].append({
            "company": str(exp.get("company") or exp.get("entreprise") or "").strip(),
            "client": str(exp.get("client") or "").strip(),
            "title": str(exp.get("title") or exp.get("poste") or "").strip(),
            "period": str(exp.get("period") or exp.get("periode") or "").strip(),
            "contexte": str(exp.get("contexte") or "").strip(),
            "objectifs": str(exp.get("objectifs") or "").strip(),
            "methodologie": str(exp.get("methodologie") or "").strip(),
            "env_technique": str(exp.get("env_technique") or "").strip(),
            "description": str(exp.get("description") or "").strip(),
        })
        
    for edu in (data.get("education") or data.get("formation") or []):
        normalized["education"].append({
            "title": str(edu.get("title") or edu.get("diplome") or "").strip(),
            "subtitle": str(edu.get("subtitle") or edu.get("etablissement") or "").strip(),
            "period": str(edu.get("period") or edu.get("periode") or "").strip(),
            "description": str(edu.get("description") or "").strip(),
        })
        
    _seen_items_global: set[str] = set()   # dedup across all categories
    for sk in (data.get("skills") or data.get("competences") or []):
        category = str(sk.get("category") or sk.get("categorie") or "").strip()
        items_src = sk.get("items") or sk.get("competences") or []
        if isinstance(items_src, str):
            raw_items = [items_src]
        else:
            raw_items = [str(it).strip() for it in items_src if str(it).strip()]
        # Deduplicate: within category (case-insensitive) AND across categories
        items: list[str] = []
        seen_local: set[str] = set()
        for it in raw_items:
            key = it.lower()
            if key not in seen_local and key not in _seen_items_global:
                items.append(it)
                seen_local.add(key)
                _seen_items_global.add(key)
        if category and items:
            normalized["skills"].append({
                "category": category,
                "items": items
            })
            
    for lang in (data.get("languages") or data.get("langues") or []):
        language = str(lang.get("language") or lang.get("langue") or "").strip()
        level = str(lang.get("level") or lang.get("niveau") or "").strip()
        if language:
            normalized["languages"].append({
                "language": language,
                "level": level
            })
            
    for proj in (data.get("projects") or data.get("projets") or []):
        normalized["projects"].append({
            "title": str(proj.get("title") or "").strip(),
            "subtitle": str(proj.get("subtitle") or "").strip(),
            "period": str(proj.get("period") or "").strip(),
            "description": str(proj.get("description") or "").strip(),
        })
        
    for cert in (data.get("certifications") or []):
        normalized["certifications"].append({
            "name": str(cert.get("name") or "").strip(),
            "year": str(cert.get("year") or "").strip(),
        })
        
    for val in (data.get("interests") or data.get("centres_interet") or []):
        if str(val).strip():
            normalized["interests"].append(str(val).strip())
            
    normalized["years_experience"] = compute_years_experience(normalized["experience"])

    # Compétences absentes : on les reconstruit depuis l'environnement technique
    # des missions.
    #
    # Le modèle a pour consigne de ne remplir « skills » que depuis une section
    # dédiée, et de NE PAS y recopier les technologies des expériences — règle
    # utile, qui évite les doublons. Mais quand le CV n'a pas de telle section,
    # le dossier ADBI se retrouve sans son bloc « Compétences techniques »,
    # c'est-à-dire sans ce qu'un commercial regarde en premier. Mesuré sur 14
    # documents : 2 parsings pourtant réussis étaient inexploitables pour cette
    # seule raison. Mieux vaut une liste tirée des missions qu'un bloc vide.
    if not normalized["skills"]:
        vues, technologies = set(), []
        for exp in normalized["experience"]:
            for brut in re.split(r"[,;/•|]", str(exp.get("env_technique") or "")):
                tech = brut.strip(" .-—")
                cle = tech.lower()
                if 1 < len(tech) < 45 and cle not in vues:
                    vues.add(cle)
                    technologies.append(tech)
        if technologies:
            normalized["skills"] = [{
                "category": "Technologies des missions",
                "items": technologies[:45],
            }]
            print(f"[INFO] Aucune section compétences — {len(technologies)} technologies "
                  "reprises des missions.")

    # ── Compétences plates + normalisées (pour la recherche et le filtrage) ──
    raw_flat = skills_to_flat(normalized["skills"])
    normalized["skills_flat"]       = normalize_skills(raw_flat)   # noms canoniques
    normalized["skills_raw_flat"]   = raw_flat                     # brut avant normalisation

    return normalized


_MOTS_METIER = {
    "chef", "de", "du", "des", "projet", "projets", "consultant", "consultante",
    "data", "bi", "moa", "moe", "mdm", "ingenieur", "ingénieur", "developpeur",
    "développeur", "manager", "analyste", "analyst", "expert", "experte",
    "architecte", "lead", "senior", "junior", "scientist", "engineer", "eng",
    "cv", "document", "dossier", "competences", "compétences", "profil",
    # Ajoutés après le banc d'essai : « document-consultant-data-quality-master-
    # data-management-… » donnait « Quality Master » comme nom de personne.
    "quality", "master", "management", "analytics", "fullstack", "full", "stack",
    "backend", "back", "frontend", "front", "web", "mobile", "software", "sante",
    "santé", "freelance", "php", "symfony", "java", "python", "it", "ml", "annees",
    "années", "dexperience", "expérience", "experience", "et",
}


def nom_depuis_fichier(chemin) -> str:
    """
    Déduit le nom de la personne du nom du fichier.

    Un dossier de compétences anonymisé ne porte plus l'identité dans son
    contenu — seulement des initiales — mais le nom du fichier l'a souvent
    conservée : « document-youssef-harrach-chef-de-projet-data-….pdf ».
    Le modèle ne peut rien inventer et laisse le champ vide à juste titre ;
    autant récupérer ici ce qui est disponible, quitte à être corrigé.

    On s'arrête au premier mot de métier : tout ce qui suit décrit le poste,
    pas la personne.
    """
    tige = Path(chemin).stem.lower()
    tige = re.sub(r"\(\d+\)$", "", tige).strip()          # « (1) » d'un doublon
    tige = re.sub(r"[-_][0-9a-f]{6,}$", "", tige)         # empreinte de fin

    mots = []
    for brut in re.split(r"[-_\s]+", tige):
        # Un fragment contenant un chiffre n'est pas un nom : sans cette règle,
        # un fichier nommé « a16d655b-2fb9-4f11-… » donnait « Adb Fb ».
        if re.search(r"\d", brut):
            if mots:
                break
            continue
        mot = re.sub(r"[^a-zàâäçéèêëîïôöùûüÿ'-]", "", brut)
        if not mot:
            continue
        if mot in _MOTS_METIER:
            if mots:
                break          # le nom précédait, la description commence
            continue           # préfixe « document- », « cv- » : on saute
        if len(mot) < 3 or len(mots) >= 3:
            break
        mots.append(mot)

    if not (2 <= len(mots) <= 3):
        return ""
    return " ".join(m.capitalize() if "-" not in m
                    else "-".join(p.capitalize() for p in m.split("-")) for m in mots)


def _sections_structurees(lignes: list[str]) -> dict:
    """
    Lit la structure d'un dossier de compétences ADBI, sans LLM.

    Ces documents — ceux que produit One pager, et ceux que reçoit l'agence —
    suivent des conventions stables : « Rôle : », « Contexte: », « Objectifs: »,
    « Environnement technique », « FORMATION », « Langues : »,
    « COMPETENCES … ». Là où un CV libre exige un modèle de langage, ce format
    se lit à la règle. Quand aucun service ne répond, c'est la différence entre
    une fiche vide et une fiche presque complète.
    """
    experiences, formations, langues, competences = [], [], [], []
    courante = None          # expérience en cours de lecture
    attente_env = False      # la ligne suivante porte l'environnement technique
    rubrique = None          # "formation" | "langues" | nom de famille de compétences

    def cloturer():
        nonlocal courante
        if courante:
            # Un « Rôle : » sans intitulé ni contenu ne produit pas d'expérience :
            # les documents OCRisés en génèrent régulièrement.
            if courante["title"].strip() or courante["_lignes"]:
                courante["description"] = " · ".join(courante.pop("_lignes", []))
                experiences.append(courante)
            courante = None

    for ligne in lignes:
        # Les puces d'un Word converti arrivent en Wingdings, dans la zone à
        # usage privé d'Unicode (U+F0B7…) : invisibles à l'écran mais bien
        # présentes dans le texte, elles se retrouvaient collées devant chaque
        # compétence.
        nu = re.sub('[\ue000-\uf8ff]', ' ', ligne).lstrip('-•–—▪◦ \t').strip()
        if not nu:
            continue

        if re.match(r"(?i)^r[ôo]les?\s*:", nu):
            cloturer()
            courante = {"company": "", "client": "", "period": "",
                        "title": re.sub(r"(?i)^r[ôo]les?\s*:\s*", "", nu),
                        "contexte": "", "objectifs": "", "methodologie": "",
                        "env_technique": "", "_lignes": []}
            attente_env = False
            continue

        if re.match(r"(?i)^contexte\s*:", nu) and courante:
            courante["contexte"] = re.sub(r"(?i)^contexte\s*:\s*", "", nu)
            continue
        if re.match(r"(?i)^objectifs?\s*:", nu) and courante:
            courante["objectifs"] = re.sub(r"(?i)^objectifs?\s*:\s*", "", nu)
            continue

        # « Environnement technique » est un intitulé seul : le contenu suit.
        if re.match(r"(?i)^environnement\s+technique\s*:?$", nu):
            attente_env = True
            continue
        if attente_env:
            attente_env = False
            if courante:
                courante["env_technique"] = nu
            competences.extend(p.strip() for p in re.split(r"[,;]", nu) if p.strip())
            continue

        if re.match(r"(?i)^formations?\s*:?$", nu):
            rubrique, _ = "formation", cloturer()
            continue
        if re.match(r"(?i)^langues?\s*:?$", nu):
            rubrique, _ = "langues", cloturer()
            continue
        m = re.match(r"(?i)^comp[ée]tences?\s+(.+?)\s*:?$", nu)
        if m and len(nu) < 60:
            rubrique, _ = ("comp:" + m.group(1).strip()), cloturer()
            continue
        if re.match(r"(?i)^(projets?|exp[ée]riences?\s+professionnelles?)\s*:?$", nu):
            rubrique = None
            continue

        if rubrique == "formation":
            # « 2005 : Diplôme… » comme « 2005 ; DEST… » : l'OCR confond les
            # deux ponctuations, et le tiret de liste laisse parfois un espace.
            annee = re.match(r"^(\d{4})\s*[:;.,-]\s*(.+)$", nu)
            if annee:
                formations.append({"period": annee.group(1), "title": annee.group(2),
                                   "subtitle": "", "description": ""})
            elif len(nu) > 8:
                formations.append({"period": "", "title": nu, "subtitle": "", "description": ""})
            continue

        if rubrique == "langues":
            paire = re.match(r"^([A-Za-zÀ-ÿ' -]{3,20})\s*:\s*(.+)$", nu)
            if paire:
                langues.append({"language": paire.group(1).strip(),
                                "level": paire.group(2).strip()})
            continue

        if rubrique and rubrique.startswith("comp:"):
            competences.append(nu)
            continue

        if courante:
            courante["_lignes"].append(nu)

    cloturer()
    return {"experiences": experiences, "formations": formations,
            "langues": langues, "competences": competences}


def extraction_locale(txt: str) -> dict:
    """
    Extraction de repli, sans aucun appel réseau.

    Deux niveaux : les repères sûrs d'abord (e-mail, téléphone, nom en tête),
    puis la structure du dossier de compétences ADBI si le document en suit les
    conventions. Le texte intégral est conservé pour que la fiche reste
    corrigeable. Mieux vaut un dossier presque complet qu'une fiche vide
    portant le nom du fichier.
    """
    lignes = [l.strip() for l in (txt or "").splitlines() if l.strip()]

    email = ""
    m = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", txt or "")
    if m:
        email = m.group(0)

    telephone = ""
    m = re.search(r"(?:\+33|0)\s?[1-9](?:[ .-]?\d{2}){4}", txt or "")
    if m:
        telephone = m.group(0).strip()

    # Le nom est presque toujours sur l'une des premières lignes. Le critère
    # décisif n'est pas la longueur mais la CAPITALISATION : dans un nom, chaque
    # mot commence par une majuscule, hors particules. Sans cette règle, une
    # ligne comme « Contexte: Mission de renfort » passait pour un nom.
    PARTICULES = {"de", "du", "des", "d'", "la", "le", "van", "von", "ben",
                  "el", "al", "di", "da", "dos", "y"}
    nom = ""
    for ligne in lignes[:6]:
        # La virgule exclut les énumérations : « Python, SQL » est une liste de
        # technologies, pas une identité — et cette ligne suit justement le
        # titre de rubrique qu'on vient d'écarter.
        if len(ligne) > 45 or re.search(r"[\d@:;•|/\\,]", ligne):
            continue
        # Le « s » du pluriel manquait : « COMPÉTENCES CLÉS » passait donc le
        # filtre et devenait un nom de personne.
        if re.search(r"(?i)\b(cv|curriculum|vitae|profils?|contacts?|exp[ée]riences?|missions?|"
                     r"contextes?|objectifs?|comp[ée]tences?|dossiers?|clients?|postes?|"
                     r"formations?|langues?|certifications?|projets?|r[ée]f[ée]rences?)\b", ligne):
            continue
        mots = ligne.split()
        if not (2 <= len(mots) <= 4):
            continue
        # Une initiale seule ne fait pas un nom : « Caleb T » venait de là.
        if any(len(m.strip(".")) < 2 for m in mots):
            continue
        if all(m[0].isupper() or m.lower().rstrip(".") in PARTICULES for m in mots):
            nom = ligne
            break

    s = _sections_structurees(lignes)

    # Les technologies relevées sont regroupées sous une seule famille : sans
    # modèle, on ne sait pas les classer, et une famille honnête vaut mieux
    # qu'un classement inventé.
    competences = []
    if s["competences"]:
        vues, propres = set(), []
        for item in s["competences"]:
            cle = item.lower()
            if cle not in vues and 1 < len(item) < 80:
                vues.add(cle)
                propres.append(item)
        competences = [{"category": "Compétences relevées", "items": propres[:60]}]

    return {
        "name": nom,
        # À défaut de titre déclaré, le rôle de la mission la plus récente.
        "title": (s["experiences"][0]["title"] if s["experiences"] else ""),
        "years_experience": 0,
        "contact": {"email": email, "phone": telephone,
                    "linkedin": "", "github": "", "location": ""},
        "experience": s["experiences"],
        "education": s["formations"],
        "skills": competences,
        "languages": s["langues"],
        "projects": [],
        "certifications": [],
        "interests": [],
        # Le texte est conservé : c'est lui qui rend la fiche corrigeable, et
        # il évite d'avoir à redéposer le fichier après une nouvelle analyse.
        "raw_text": (txt or "")[:20000],
    }


def extraction_suffisante(data: dict):
    """Vérifie que l'extraction par bibliothèques a récupéré l'essentiel.

    Préférence de l'utilisateur (2026-09) : les règles locales passent en
    premier, l'IA n'est appelée QUE si la fiche est incomplète. Le critère
    reflète ce qu'une fiche exploitable exige : une identité, un titre, un
    parcours et des compétences.
    """
    manques = []
    if not (data.get("name") or "").strip():
        manques.append("nom")
    if not (data.get("title") or "").strip():
        manques.append("titre")
    if len(data.get("experience") or []) < 2:
        manques.append("expériences")
    nb_competences = sum(len(c.get("items", [])) for c in (data.get("skills") or []))
    if nb_competences < 5:
        manques.append("compétences")
    return (not manques), manques


def process_cv(file_path, jeton=None) -> dict:
    """Pipeline CV : extraction → nettoyage → LLM → normalisation.
    Chaque étape est chronométrée et les durées sont retournées dans cv_data['_timing'].
    """
    import time
    T = {}
    file_path = Path(file_path)
    html_content = ""

    # ── Étape 1 : extraction texte rapide ───────────────────────────────────
    t0 = time.perf_counter()
    noter_progression(jeton, 8, "Lecture du document")
    txt = _extract_text_fast(file_path)
    T["extract_s"] = round(time.perf_counter() - t0, 3)
    is_digital = bool(txt.strip())

    if is_digital:
        print(f"[PERF] Étape 1 extract    : {T['extract_s']:.2f}s — {len(txt)} chars (digital)")
    else:
        # ── Étape 2 : Docling fallback (PDF scanné) ───────────────────────
        print("[INFO] PDF scanné — fallback Docling/OCR")
        noter_progression(jeton, 22, "Document scanné : reconnaissance de texte (OCR)",
                          "l'étape la plus longue, ~30 s")
        t1 = time.perf_counter()
        try:
            converter = _get_converter()
            if converter:
                result = converter.convert(str(file_path))
                try:
                    txt = _to_str(result.document.export_to_text())
                except Exception:
                    pass
                try:
                    html_content = _to_str(result.document.export_to_html())
                except Exception:
                    pass
        except Exception as e:
            print(f"[WARN] Docling échoué : {e}")
        T["docling_s"] = round(time.perf_counter() - t1, 3)
        print(f"[PERF] Étape 2 docling    : {T['docling_s']:.2f}s — {len(txt)} chars")

    # ── Étape 3 : nettoyage + troncature ────────────────────────────────────
    t2 = time.perf_counter()
    content_for_llm = clean_text_for_llm(txt)[:MAX_LLM_CHARS]
    T["clean_s"] = round(time.perf_counter() - t2, 3)
    print(f"[PERF] Étape 3 clean      : {T['clean_s']:.3f}s — {len(content_for_llm)} chars → LLM")
    noter_progression(jeton, 55, "Analyse IA", "recherche d'un service disponible…")

    # ── Étape 4 : LLM ────────────────────────────────────────────────────────
    #
    # Si aucun service ne répond, on NE PERD PAS le travail déjà fait. Avant
    # cette reprise, l'échec du LLM faisait échouer tout le pipeline et le CV
    # était enregistré vide, avec le nom du fichier en guise de nom — alors que
    # le texte venait d'être extrait correctement. L'utilisateur se retrouvait
    # devant une fiche à ressaisir entièrement, sans comprendre pourquoi.
    # Bibliothèques d'abord : les règles locales lisent le document sans un
    # seul appel réseau. On VÉRIFIE ensuite ce qu'elles ont récupéré ; l'IA
    # n'est sollicitée que si la fiche est incomplète — un CV bien structuré
    # ressort ainsi en ~2 s, et aucun document ne part vers un service
    # externe sans nécessité.
    t3 = time.perf_counter()
    llm_ok = False
    raw_data = extraction_locale(txt)
    suffisante, manques = extraction_suffisante(raw_data)
    if suffisante:
        print("[PERF] Étape 4 locale     : extraction par bibliothèques suffisante — IA non sollicitée")
        noter_progression(jeton, 88, "Extraction par bibliothèques complète", "IA non sollicitée")
    else:
        print(f"[INFO] extraction locale incomplète ({', '.join(manques)}) — appel IA.")
        noter_progression(jeton, 58, "Analyse IA",
                          "les bibliothèques n'ont pas tout : " + ", ".join(manques))
        try:
            raw_data = llm_parse_cv(
                content_for_llm, txt,
                progression=lambda texte: noter_progression(jeton, 62, "Analyse IA", texte),
            )
            llm_ok = True
        except (LLMIndisponible, RuntimeError) as exc:
            print(f"[WARN] LLM indisponible ({exc}) — on garde l'extraction par bibliothèques.")
            noter_progression(jeton, 88, "Services IA indisponibles",
                              "fiche issue des bibliothèques, à compléter à la main")
    T["llm_s"] = round(time.perf_counter() - t3, 3)
    print(f"[PERF] Étape 4 analyse    : {T['llm_s']:.2f}s ({'IA' if llm_ok else 'bibliothèques'})")

    # ── Étape 5 : normalisation ──────────────────────────────────────────────
    t4 = time.perf_counter()
    noter_progression(jeton, 93, "Finalisation de la fiche")
    cv_data = normalize_cv_data(raw_data, html_content)
    T["normalize_s"] = round(time.perf_counter() - t4, 3)
    T["total_s"] = round(time.perf_counter() - t0, 3)
    print(f"[PERF] Étape 5 normalize  : {T['normalize_s']:.3f}s")
    print(f"[PERF] ─── TOTAL pipeline : {T['total_s']:.2f}s ({'LLM=%d%%' % round(T['llm_s']/T['total_s']*100)})")

    # Extraction insuffisante ET aucun service IA n'a pu compenser : c'est un
    # échec réel (ex. PDF scanné dont même l'OCR ne récupère rien), pas un CV
    # anonymisé — voir juste en dessous, cette distinction conditionne le
    # secours par nom de fichier.
    extraction_a_echoue = (not suffisante) and (not llm_ok)

    # Dernier recours pour le nom : le nom du fichier — réservé aux documents
    # dont l'extraction a par ailleurs réussi mais qui ne déclarent simplement
    # aucune identité (dossier anonymisé, par exemple). Une extraction qui a
    # échoué dans son ensemble ne doit PAS se voir attribuer un nom tiré du
    # fichier : ça ressemble à une vraie donnée et masque silencieusement
    # l'échec (une fiche à « Nom : Compare Scanné » a l'air normale, alors que
    # rien n'a pu être lu dans le document).
    if not cv_data.get("name") and not extraction_a_echoue:
        depuis_fichier = nom_depuis_fichier(file_path)
        if depuis_fichier:
            cv_data["name"] = depuis_fichier
            cv_data["name_source"] = "nom du fichier"
            print(f"[INFO] Nom absent du document — repris du nom de fichier : {depuis_fichier}")

    cv_data["llm_parsed"]    = llm_ok
    cv_data["docling_used"]  = not is_digital
    cv_data["parsing_mode"]  = "digital" if is_digital else "scanned"
    cv_data["_timing"]       = T
    # Quel service a réellement traité ce fichier — seulement si l'IA a servi :
    # sinon on afficherait le service d'une analyse précédente.
    cv_data["llm_service"]   = ((llm_cascade.dernier_service() or {}).get("service") or "") if llm_ok else ""
    cv_data["extraction"]    = "ia" if llm_ok else "bibliothèques"
    cv_data["bilan_adbi"]    = bilan_adbi(cv_data)
    # Avertir SEULEMENT si la fiche est incomplète ET que l'IA n'a pas pu
    # compléter : des bibliothèques qui suffisent sont le cas nominal, pas
    # une anomalie.
    if extraction_a_echoue:
        cv_data["parse_warning"] = (
            "L'extraction par bibliothèques est incomplète ("
            + ", ".join(manques) +
            ") et aucun service IA n'a répondu. Relancez l'analyse depuis la "
            "fiche quand un service répond, ou complétez à la main."
        )
    return cv_data


# load_db()/save_db() ont été retirées (issue #15, PR B) : la CVthèque vit
# désormais dans PostgreSQL (table cvs, core/cvstore_pg.py) et chaque route
# lit/écrit une fiche à la fois — plus de dict complet chargé/réécrit en
# mémoire à chaque appel. cvstore_pg.list_cvs() reste disponible pour les
# écrans qui listent/recherchent toute la CVthèque (pas un cache : chaque
# appel relit la table).

# ── Verrou par fiche (issue #53) ─────────────────────────────────────────────
# Plusieurs routes font get_cv -> traitement (souvent un appel LLM de
# plusieurs dizaines de secondes) -> save_cv, et save_cv remplace la fiche
# entière (core/cvstore_pg.py) : deux écritures concurrentes sur la même
# fiche se traduisaient par un "lost update" silencieux, la plus lente à
# finir écrasant l'autre avec une copie lue avant elle. Le process reste
# mono-instance mais multi-thread — que ce soit le serveur de dev Flask
# (`app.run(..., threaded=True)`, plus bas, `python app.py` en local) ou
# Gunicorn en conteneur (`gunicorn.conf.py` : un seul worker, plusieurs
# threads `gthread` — précisément pour garder ce verrou en mémoire valable ;
# plusieurs workers Gunicorn, processus séparés sans mémoire partagée,
# réintroduiraient le même lost update entre deux workers) —, donc un verrou
# en mémoire par cv_id suffit à sérialiser ces sections critiques sans avoir
# besoin d'un verrou au niveau de la base.
_verrous_cv: dict[str, threading.Lock] = {}
_verrous_cv_meta = threading.Lock()


def _verrou_cv(cv_id: str) -> threading.Lock:
    with _verrous_cv_meta:
        verrou = _verrous_cv.get(cv_id)
        if verrou is None:
            verrou = _verrous_cv[cv_id] = threading.Lock()
        return verrou


def _enrich_cv_background(cv_id: str) -> None:
    """Background thread: call LLM and update the stored CV without blocking upload.

    Tout le cycle lecture -> appel LLM -> écriture est protégé par le verrou
    de la fiche (issue #53) : sans lui, une modification faite par
    l'utilisateur (PATCH, "Enrichir", "Adapter au poste") pendant que ce
    thread attend le LLM était silencieusement écrasée à la sauvegarde
    finale, celle-ci partant d'une copie lue avant l'appel LLM.
    """
    try:
        with _verrou_cv(cv_id):
            cv = cvstore_pg.get_cv(cv_id)
            if cv is None:
                print(f"[WARN] _enrich_cv_background : CV {cv_id} introuvable.")
                return
            experience = cv.get("experience", [])
            if not experience:
                cv["llm_enriched"] = True
                cvstore_pg.save_cv(cv_id, cv)
                return
            cv["experience"] = llm_enrich_experiences(experience)
            cv["llm_enriched"] = True
            cvstore_pg.save_cv(cv_id, cv)
    except Exception:
        traceback.print_exc()


def _message_erreur_llm(resp) -> str:
    """
    Extrait le message d'erreur renvoye par le fournisseur.

    OpenAI et OpenRouter repondent tous deux {"error": {"message": ...}}, mais
    pas toujours : on retombe sur le corps brut plutot que de ne rien dire.
    Sans cela, l'interface n'affichait qu'un code HTTP nu, impossible a
    interpreter (c'est ce qui a rendu la panne de modele si difficile a voir).
    """
    try:
        donnees = resp.json()
        erreur = donnees.get("error", donnees)
        if isinstance(erreur, dict):
            return str(erreur.get("message") or erreur)[:300]
        return str(erreur)[:300]
    except Exception:
        return (resp.text or "")[:300]


def _conseil_erreur(code: int, provider: str) -> str:
    """Traduit les erreurs frequentes en action concrete."""
    if code == 401:
        return f"La cle API {provider} est invalide ou revoquee. Regenerez-la et collez-la dans Parametres."
    if code == 404:
        return "Le modele demande n'existe pas chez ce fournisseur."
    if code == 429:
        return "Quota ou limite de debit atteinte chez le fournisseur."
    if code == 400:
        return "Requete refusee : le plus souvent un modele inconnu de ce fournisseur."
    if code and code >= 500:
        return "Panne cote fournisseur : reessayez plus tard."
    return ""


@app.route("/api/sante")
def api_sante():
    """
    PostgreSQL répond-il réellement ?

    Interrogée par le HEALTHCHECK Docker (voir Dockerfile) — auparavant sur
    /api/status, qui ne vérifie que la chaîne de passerelles LLM (voir
    api_status ci-dessous), jamais la base. Sans ce contrôle, un Postgres
    injoignable (partition réseau, conteneur OOM-killed puis en
    redémarrage) laissait le HEALTHCHECK toujours vert tant que gunicorn
    restait vivant, alors que /api/cvs et consorts échouaient déjà tous.
    Pas de @require_auth : le HEALTHCHECK Docker n'a pas de session, comme
    /api/status.
    """
    try:
        _pg_ping()
        return jsonify({"etat": "pret", "base": "ok"})
    except Exception as e:
        return jsonify({"etat": "indisponible", "base": "ko", "erreur": str(e)}), 503


@app.route("/api/status")
def api_status():
    """
    Le service de langage répond-il ?

    La question porte sur la CHAÎNE, pas sur un fournisseur unique : un modèle
    de la passerelle interne à court de quota ou en panne ne dit rien des
    autres. On interroge donc la chaîne, en s'arrêtant au premier service
    disponible.
    """
    etat = llm_cascade.etat()
    if etat.get("ok"):
        return jsonify({
            "api_ok": True,
            "provider": "interne",
            "model": (etat.get("service") or "").split("/")[-1],
            "service": etat.get("service"),
            "rang": etat.get("rang"),
            "total": etat.get("total"),
        })
    # 503, pas 200 : le corps distinguait déjà api_ok true/false, mais le code
    # HTTP restait toujours un succès — un appelant qui ne lit que le code
    # (supervision externe, `curl -f`, etc.) voyait une chaîne LLM en panne
    # comme un service sain. Les deux seuls lecteurs internes de cette route
    # (templates/index.html, templates/cv_detail.html) font
    # `fetch(...).then(r => r.json())` sans jamais tester `r.ok` : ils ne sont
    # pas affectés, `fetch().json()` ne rejette pas sur 4xx/5xx. Voir issue #90.
    return jsonify({
        "api_ok": False,
        "provider": "interne",
        "model": "",
        "total": etat.get("total"),
        "error": f"Aucun des {etat.get('total')} services de la chaîne ne répond",
        "conseil": ("Vérifiez que la passerelle d'inférence interne (ADBI_LLM_BASE_URL) "
                    "est configurée et joignable."),
    }), 503


@app.url_defaults
def _versionner_statiques(endpoint, valeurs):
    """
    Ajoute `?v=<date de modification>` à toute adresse de fichier statique.

    Sans cela, le navigateur garde sa copie des feuilles de style : une
    correction de charte ne se voyait qu'après un vidage manuel du cache, et
    l'écran gardait par exemple sa barre haute d'avant. La date de
    modification change à chaque enregistrement du fichier, donc l'adresse
    change avec lui — et seulement avec lui.
    """
    if endpoint != "static" or "filename" not in valeurs:
        return
    try:
        valeurs["v"] = int((Path(app.static_folder) / valeurs["filename"]).stat().st_mtime)
    except OSError:
        pass                                    # fichier absent : on laisse tel quel


@app.route("/login")
def login_page():
    # Mode local (ADBI_AUTH non posee) : pas de page de connexion.
    if not AUTH_ACTIVE:
        return redirect("/")
    token = request.cookies.get("adbi_access")
    if token and verify_access_token(token):
        return redirect("/")
    return render_template("login.html")


@app.route("/")
@require_auth
def accueil():
    """
    La racine ouvre directement la bibliothèque de CV.

    C'est l'écran de travail : on arrive dans l'application pour déposer ou
    retrouver un CV. Le tableau de bord ne faisait que proposer des liens que
    la barre de navigation porte déjà — il reste accessible sur /dashboard.
    """
    return redirect("/app")


@app.route("/dashboard")
@require_auth
def dashboard():
    return render_template("dashboard.html")


@app.route("/app")
@require_auth
def index():
    return render_template("index.html")


@app.route("/needs")
@require_auth
def needs_page():
    return render_template("needs.html")


@app.route("/matching")
@require_auth
def matching_page():
    """
    Ancien écran de matching — remplacé par le Rapprochement.

    La route est conservée en redirection plutôt que supprimée : l'écran des
    besoins y renvoie après avoir lancé un rapprochement, et des liens
    existent dans les favoris. `need_id` est transmis pour que la fiche de
    poste soit pré-remplie.
    """
    need_id = request.args.get("need_id", "")
    return redirect(f"/rapprochement?need_id={need_id}" if need_id else "/rapprochement")


@app.route("/settings")
@require_auth
def settings_page():
    return render_template("settings.html")


@app.route("/invite/<token>")
def invite_page(token):
    return render_template("invite.html", token=token)


# ── Progression d'analyse en temps réel ──────────────────────────────────────
# La barre du widget n'est plus simulée : le pipeline note ici où il en est,
# et le navigateur vient lire pendant que son POST /api/upload est en vol.
PROGRESSION_ANALYSES: dict = {}
_progression_verrou = threading.Lock()


def noter_progression(jeton, pct, etape, detail=""):
    if not jeton:
        return
    import time as _t
    with _progression_verrou:
        maintenant = _t.time()
        PROGRESSION_ANALYSES[jeton] = {
            "pct": pct, "etape": etape, "detail": detail, "quand": maintenant,
        }
        # Ménage : une entrée de plus de dix minutes ne sera plus consultée.
        for cle in [c for c, v in PROGRESSION_ANALYSES.items()
                    if maintenant - v["quand"] > 600]:
            PROGRESSION_ANALYSES.pop(cle, None)


@app.route("/api/upload/progression/<jeton>")
@require_auth
def progression_analyse(jeton):
    with _progression_verrou:
        etat = PROGRESSION_ANALYSES.get(jeton)
    return jsonify(etat or {"pct": 0, "etape": "Démarrage", "detail": ""})


@app.route("/api/upload", methods=["POST"])
@require_auth
def upload_cv():
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Aucun fichier sélectionné"}), 400

    ext = Path(file.filename).suffix.lower()
    if ext not in [".pdf", ".docx"]:
        return jsonify({"error": "Format non supporté (PDF et DOCX uniquement — convertis les .doc en .docx)"}), 400

    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{file_id}{ext}"
    file.save(file_path)

    jeton = (request.form.get("jeton") or "").strip()[:64]

    # ── Cache par empreinte : un fichier DÉJÀ analysé ne repasse pas par le
    # pipeline (doublons de candidats, re-dépôts) — sa fiche est reprise
    # telle quelle, instantanément. On ne réutilise qu'une analyse RICHE :
    # une fiche restée incomplète mérite une nouvelle chance.
    import hashlib
    hacheur = hashlib.sha256()
    with open(file_path, "rb") as _f:
        # Lecture par blocs plutôt que read_bytes() : même sous le plafond de
        # MAX_CONTENT_LENGTH, un fichier de plusieurs dizaines de Mo n'a pas
        # besoin d'être entièrement dupliqué en mémoire pour être haché.
        for bloc in iter(lambda: _f.read(1 << 20), b""):
            hacheur.update(bloc)
    empreinte = hacheur.hexdigest()
    source_cache = None
    try:
        for existante in cvstore_pg.list_cvs().values():
            if existante.get("empreinte") != empreinte:
                continue
            if existante.get("llm_enriched") or (existante.get("bilan_adbi") or {}).get("exploitable"):
                source_cache = existante
                break
    except Exception:
        source_cache = None

    parse_warning = None
    if source_cache is not None:
        cv_data = {k: v for k, v in source_cache.items()
                   if k not in ("id", "filename", "ext", "uploaded_at",
                                "stored_at", "parse_summary", "parse_warning")}
        cv_data["llm_parsed"] = bool(source_cache.get("llm_enriched"))
        cv_data["extraction"] = "cache"
        cv_data["copie_de"] = source_cache.get("id", "")
        noter_progression(jeton, 100, "Déjà analysé", "fiche reprise du document identique")
        print(f"[PERF] cache d'empreinte : fiche reprise de {source_cache.get('id', '?')} — 0 s")
    else:
      try:
        cv_data = process_cv(file_path, jeton=jeton)
      except Exception as exc:
        traceback.print_exc()
        parse_warning = str(exc)
        print(f"[ERREUR] process_cv échoué pour {file.filename} : {exc}")
        # Fallback minimal — le fichier est stocké, l'utilisateur peut éditer manuellement
        cv_data = {
            # Le nom brut du fichier serait « document-youssef-harrach-chef-de-
            # projet-… » : on en tire l'identité plutôt que de l'afficher tel quel.
            "name": nom_depuis_fichier(file.filename) or Path(file.filename).stem,
            "title": "",
            "years_experience": 0,
            "contact": {"email": "", "phone": "", "linkedin": "", "github": "", "location": ""},
            "experience": [],
            "education": [],
            "skills": [],
            "languages": [],
            "projects": [],
            "certifications": [],
            "interests": [],
            "html_content": "",
        }

    # Le nom d'origine n'est connu qu'ici : process_cv ne voit que le fichier
    # stocké, nommé par identifiant. Un dossier anonymisé ne portant pas
    # d'identité dans son contenu, c'est la dernière source disponible — mais
    # seulement si l'extraction a par ailleurs réussi (pas de parse_warning) :
    # sinon ce serait la même invention de fausse donnée que dans process_cv()
    # (voir son commentaire), pour une fiche dont l'extraction a échoué.
    if not cv_data.get("name") and not cv_data.get("parse_warning"):
        depuis_fichier = nom_depuis_fichier(file.filename)
        if depuis_fichier:
            cv_data["name"] = depuis_fichier
            cv_data["name_source"] = "nom du fichier"
            print(f"[INFO] Nom absent du document — repris du fichier : {depuis_fichier}")

    now = datetime.now().isoformat()
    llm_parsed = cv_data.pop("llm_parsed", False)
    cv_data.update({
        "id": file_id,
        "filename": file.filename,
        "ext": ext,
        "uploaded_at": now,
        "stored_at": now,
        "empreinte": empreinte,
        "llm_enriched": llm_parsed,
    })
    if parse_warning:
        cv_data["parse_warning"] = parse_warning

    # Store immediately so the detail page is available right away
    try:
        cvstore_pg.save_cv(file_id, cv_data)
    except Exception as e:
        traceback.print_exc()
        print(f"[ERREUR] Impossible de sauvegarder le CV {file_id} : {e}")

    # LLM enrichment runs in the background — does not block the response if not already parsed
    if not llm_parsed and cv_data.get("experience") and cv_data.get("extraction") != "cache":
        threading.Thread(target=_enrich_cv_background, args=(file_id,), daemon=True).start()
    else:
        try:
            cv = cvstore_pg.get_cv(file_id)
            if cv is not None:
                cv["llm_enriched"] = True
                cvstore_pg.save_cv(file_id, cv)
        except Exception:
            pass

    # ── Résumé de parsing pour le frontend (non stocké en DB) ──────────────
    _timing = cv_data.pop("_timing", {})
    # Recalculé après la reprise du nom : le bilan doit refléter la fiche
    # réellement enregistrée, pas son état avant complément.
    bilan = bilan_adbi(cv_data)
    cv_data["bilan_adbi"] = bilan
    parse_summary = {
        "mode":        cv_data.get("parsing_mode", "unknown"),
        "experiences": len(cv_data.get("experience") or []),
        "skills":      len(cv_data.get("skills_flat") or []),
        "education":   len(cv_data.get("education") or []),
        "name":        cv_data.get("name", ""),
        "timing":      _timing,   # durées par étape en secondes
        # Quel service a traité le fichier, et ce que le dossier ADBI aura de
        # rempli : sans cela, une fiche incomplète ne se découvre qu'à
        # l'ouverture du document.
        "service":     cv_data.get("llm_service", ""),
        "llm_parsed":  llm_parsed,
        "adbi":        bilan,
        "avertissement": cv_data.get("parse_warning", ""),
    }
    response_data = dict(cv_data)
    response_data["parse_summary"] = parse_summary

    # Trace activité
    try:
        u = get_current_user()
        if u:
            _log("cv_upload", u["sub"], u.get("email",""),
                 {"cv_id": file_id, "name": cv_data.get("name","")})
    except Exception:
        pass

    noter_progression(jeton, 100, "Terminé")
    return jsonify(response_data)


@app.route("/api/cv/<file_id>/reanalyser", methods=["POST"])
@require_auth
def reanalyser_cv(file_id):
    """Relance l'analyse d'une fiche depuis le fichier d'origine.

    Utile quand les services IA étaient saturés au dépôt : la fiche issue des
    bibliothèques peut être complétée plus tard, en un clic, sans re-déposer
    le document. La progression passe par le même jeton que le dépôt.
    """
    with _verrou_cv(file_id):
        fiche = cvstore_pg.get_cv(file_id)
        if not fiche:
            return jsonify({"error": "CV introuvable"}), 404

        ext = fiche.get("ext") or Path(fiche.get("filename", "")).suffix or ".pdf"
        file_path = UPLOAD_DIR / f"{file_id}{ext}"
        if not file_path.exists():
            return jsonify({"error": "Fichier d'origine absent du poste : re-déposez le document."}), 404

        jeton = (request.form.get("jeton") or "").strip()[:64]
        try:
            cv_data = process_cv(file_path, jeton=jeton)
        except Exception as exc:
            traceback.print_exc()
            return jsonify({"error": f"Ré-analyse impossible : {exc}"}), 500

        llm_parsed = cv_data.pop("llm_parsed", False)
        # L'identité de la fiche ne change pas : id, fichier, dates, empreinte.
        for cle in ("id", "filename", "ext", "uploaded_at", "empreinte"):
            if fiche.get(cle) is not None:
                cv_data[cle] = fiche[cle]
        if not cv_data.get("name"):
            cv_data["name"] = fiche.get("name", "")
        cv_data["stored_at"] = datetime.now().isoformat()
        cv_data["llm_enriched"] = llm_parsed
        cv_data["bilan_adbi"] = bilan_adbi(cv_data)
        cv_data.pop("_timing", None)

        cvstore_pg.save_cv(file_id, cv_data)
    noter_progression(jeton, 100, "Terminé")
    return jsonify({
        "ok": True,
        "extraction": cv_data.get("extraction", ""),
        "service": cv_data.get("llm_service", ""),
        "bilan_adbi": cv_data.get("bilan_adbi"),
        "avertissement": cv_data.get("parse_warning", ""),
    })


@app.route("/api/file/<file_id>")
@require_auth
def serve_file(file_id):
    for ext in [".pdf", ".doc", ".docx"]:
        fp = UPLOAD_DIR / f"{file_id}{ext}"
        if fp.exists():
            return send_file(fp)
    abort(404)


@app.route("/api/cvs", methods=["GET"])
@require_auth
def list_cvs():
    db = cvstore_pg.list_cvs()
    summary = []
    for cid, cv in db.items():
        # Rétrocompatibilité : calcule skills_flat si absent (anciens CVs)
        sf = cv.get("skills_flat")
        if sf is None:
            sf = compute_skills_flat(cv)
        summary.append({
            "id":               cid,
            "name":             cv.get("name", "—"),
            "title":            cv.get("title", ""),
            "filename":         cv.get("filename", ""),
            "stored_at":        cv.get("stored_at", "") or "",
            "years_experience": int(cv.get("years_experience") or 0),
            "location":         (cv.get("contact") or {}).get("location", ""),
            "language":         cv.get("language", "fr"),
            "source_cv_id":     cv.get("source_cv_id", ""),
            "skills_flat":      sf,
            "parsing_mode":     cv.get("parsing_mode", ""),
        })
    summary.sort(key=lambda x: x["stored_at"], reverse=True)
    return jsonify(summary)


@app.route("/api/skills")
@require_auth
def list_all_skills():
    """Retourne toutes les compétences uniques + leur fréquence pour la sidebar."""
    db = cvstore_pg.list_cvs()
    counter: dict[str, int] = {}
    for cv in db.values():
        sf = cv.get("skills_flat") or compute_skills_flat(cv)
        for sk in sf:
            counter[sk] = counter.get(sk, 0) + 1
    sorted_skills = sorted(counter.items(), key=lambda x: (-x[1], x[0].lower()))
    return jsonify([{"skill": s, "count": c} for s, c in sorted_skills])


@app.route("/api/search")
@require_auth
def search_cvs():
    """
    Recherche filtrée côté serveur.
    Paramètres :
      q         — texte libre (nom, titre, techno)
      tech      — compétence(s) séparées par virgule  (ex: Python,Spark)
      location  — ville / région (partiel)
      min_exp   — années d'expérience minimales (int)
      seniority — junior | mid | senior | expert
    """
    db = cvstore_pg.list_cvs()
    q         = request.args.get("q", "").strip().lower()
    tech_raw  = request.args.get("tech", "").strip()
    location  = request.args.get("location", "").strip().lower()
    min_exp   = request.args.get("min_exp", 0, type=int)
    seniority = request.args.get("seniority", "").strip().lower()

    tech_filters = [t.strip().lower() for t in tech_raw.split(",") if t.strip()] \
                   if tech_raw else []

    SENIORITY_RANGES = {
        "junior": (0, 2), "mid": (3, 5), "senior": (6, 9), "expert": (10, 99),
    }

    results = []
    for cid, cv in db.items():
        sf   = cv.get("skills_flat") or compute_skills_flat(cv)
        yrs  = int(cv.get("years_experience") or 0)
        loc  = (cv.get("contact") or {}).get("location", "").lower()
        name = cv.get("name", "")
        title = cv.get("title", "")

        # ── Filtre texte libre ──────────────────────────────────────────────
        if q:
            haystack = f"{name} {title} {' '.join(sf)} {loc}".lower()
            if q not in haystack:
                continue

        # ── Filtre technos (toutes les techs demandées doivent matcher) ─────
        if tech_filters:
            sf_lower = [s.lower() for s in sf]
            if not all(
                any(tf in s for s in sf_lower)
                for tf in tech_filters
            ):
                continue

        # ── Filtre localisation ─────────────────────────────────────────────
        if location and location not in loc:
            continue

        # ── Filtre expérience minimale ──────────────────────────────────────
        if yrs < min_exp:
            continue

        # ── Filtre séniorité ────────────────────────────────────────────────
        if seniority and seniority in SENIORITY_RANGES:
            lo, hi = SENIORITY_RANGES[seniority]
            if not (lo <= yrs <= hi):
                continue

        results.append({
            "id":               cid,
            "name":             name,
            "title":            title,
            "stored_at":        cv.get("stored_at", "") or "",
            "years_experience": yrs,
            "location":         loc,
            "language":         cv.get("language", "fr"),
            "source_cv_id":     cv.get("source_cv_id", ""),
            "skills_flat":      sf,
            "parsing_mode":     cv.get("parsing_mode", ""),
        })

    results.sort(key=lambda x: x["stored_at"], reverse=True)
    return jsonify(results)


@app.route("/api/cvs", methods=["POST"])
@require_auth
def store_cv():
    data = request.json
    if not data:
        return jsonify({"error": "Aucune donnée"}), 400
    cid = data.get("id") or str(uuid.uuid4())
    data["stored_at"] = datetime.now().isoformat()
    cvstore_pg.save_cv(cid, data)
    return jsonify({"success": True, "id": cid})


@app.route("/api/cvs/<cv_id>", methods=["GET"])
@require_auth
def get_cv(cv_id):
    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        abort(404)
    return jsonify(cv)


@app.route("/cv/<cv_id>")
@require_auth
def cv_detail(cv_id):
    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        abort(404)
    # Collect all linked versions (translations / original)
    linked_cvs = []
    src_id = cv.get("source_cv_id", "")
    if src_id:
        src = cvstore_pg.get_cv(src_id)
        if src is not None:
            lang = src.get("language", "fr")
            linked_cvs.append({"id": src_id, "language": lang,
                                "label": "🇫🇷 FR" if lang == "fr" else f"🌐 {lang.upper()}"})
    # Recherche inverse (autres fiches dérivées de celle-ci) : nécessite un
    # scan de toute la CVthèque, pas d'index sur source_cv_id.
    for cid, other in cvstore_pg.list_cvs().items():
        if cid != cv_id and other.get("source_cv_id") == cv_id:
            lang = other.get("language", "en")
            flag = {"en": "🇬🇧", "fr": "🇫🇷"}.get(lang, "🌐")
            linked_cvs.append({"id": cid, "language": lang, "label": f"{flag} {lang.upper()}"})
    return render_template("cv_detail.html", cv=cv, linked_cvs=linked_cvs)


# Champs que l'écran d'édition (cv_detail.html::collectData) envoie réellement.
# Tout le reste (empreinte, llm_enriched, id, filename...) est un champ géré par
# le serveur : le laisser passer permettait à un PATCH quelconque d'écraser ces
# champs internes avec une valeur arbitraire — notamment `empreinte`, utilisée
# telle quelle par le cache de déduplication à l'upload (une fiche fabriquée
# aurait alors été servie pour un futur dépôt du document dont on connaît le
# SHA-256), ou de changer le TYPE d'un champ (ex. "experience" en chaîne au
# lieu d'une liste), ce qui fait planter sans filet les routes qui itèrent
# dessus (GET /cv/<id>/adbi, /api/cvs/<id>/dossier.<format>).
CHAMPS_MODIFIABLES_CV = {
    "name", "title", "years_experience", "contact",
    "experience", "education", "skills", "languages",
    "interests", "certifications",
}
# Champs dont la forme attendue est une liste d'objets : une chaîne ou un
# nombre glissé ici casserait tout code qui fait `for x in champ: x.get(...)`.
LISTES_DE_DICTS_CV = {"experience", "education", "skills", "languages", "certifications"}


@app.route("/api/cvs/<cv_id>", methods=["PATCH"])
@require_auth
def update_cv(cv_id):
    brut = request.json or {}
    # Liste blanche + contrôle de type minimal — volontairement PAS
    # normalize_cv_data() : celle-ci recalcule/laisse tomber des champs et
    # changerait la sémantique d'une simple édition manuelle depuis l'écran.
    updates = {k: v for k, v in brut.items() if k in CHAMPS_MODIFIABLES_CV}
    if "years_experience" in updates:
        try:
            updates["years_experience"] = int(updates["years_experience"])
        except (ValueError, TypeError):
            updates["years_experience"] = 0
    if "contact" in updates and not isinstance(updates["contact"], dict):
        del updates["contact"]
    if "interests" in updates:
        valeur = updates["interests"]
        if not isinstance(valeur, list) or not all(isinstance(x, str) for x in valeur):
            del updates["interests"]
    for champ in LISTES_DE_DICTS_CV:
        if champ in updates:
            valeur = updates[champ]
            if not isinstance(valeur, list) or not all(isinstance(x, dict) for x in valeur):
                del updates[champ]
    with _verrou_cv(cv_id):
        cv = cvstore_pg.get_cv(cv_id)
        if cv is None:
            abort(404)
        for key, val in updates.items():
            cv[key] = val
        cv["updated_at"] = datetime.now().isoformat()
        cvstore_pg.save_cv(cv_id, cv)
    return jsonify({"success": True})


@app.route("/api/cvs/<cv_id>", methods=["DELETE"])
@require_auth
def delete_cv(cv_id):
    # Le verrou de la fiche (issue #53) protège aussi ceci : sans lui, un
    # enrich/adapt/translate déjà en cours (get_cv fait avant ce DELETE) peut
    # sauver sa copie APRÈS la suppression et ressusciter la ligne — dont le
    # fichier sur disque vient d'être supprimé, laissant la fiche "vivante"
    # 404 sur la visionneuse (route /upload/<file_id>).
    with _verrou_cv(cv_id):
        cv = cvstore_pg.get_cv(cv_id)
        if cv is None:
            # Idempotent : suppression d'un id déjà absent, pas d'erreur.
            return jsonify({"success": True})
        ext = cv.get("ext", "")
        cvstore_pg.delete_cv(cv_id)
        # Le fichier uploadé (uploads/<id><ext>, volume Docker persistant)
        # n'était jamais nettoyé : chaque suppression de fiche laissait le
        # document original s'accumuler indéfiniment sur disque. `ext` vient
        # de la fiche en base (jamais du PATCH — absent de
        # CHAMPS_MODIFIABLES_CV) donc pas de traversée de chemin possible ;
        # on ne supprime que si le nom obtenu reste bien dans UPLOAD_DIR.
        if ext:
            fichier = (UPLOAD_DIR / f"{cv_id}{ext}").resolve()
            try:
                if fichier.parent == UPLOAD_DIR.resolve() and fichier.is_file():
                    fichier.unlink()
            except OSError as exc:
                # Best-effort : la fiche est déjà supprimée en base, un échec
                # de nettoyage disque ne doit pas faire échouer la requête
                # (comportement identique à avant ce correctif, au pire).
                print(f"[WARN] delete_cv({cv_id}) : échec suppression fichier {fichier} : {exc}")
    return jsonify({"success": True})


@app.route("/api/cvs/<cv_id>/copilot", methods=["POST"])
@require_auth
def cv_copilot(cv_id):
    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        return jsonify({"error": "CV introuvable"}), 404

    req_data = request.json or {}
    user_message = req_data.get("message", "")
    current_cv = req_data.get("cv", cv)
    
    if not user_message:
        return jsonify({"error": "Message vide"}), 400
        
    prompt = f"""Tu es un assistant IA spécialisé dans l'édition et l'amélioration de CVs.
Tu as accès au CV actuel de l'utilisateur sous format JSON ci-dessous.

L'utilisateur te demande : "{user_message}"

Tu as deux façons de répondre :
1. Si l'utilisateur demande une modification du CV (ex: traduire le CV, ajouter une compétence, reformuler une mission, rédiger une accroche, etc.), tu dois mettre à jour le JSON du CV en conséquence ET expliquer brièvement tes modifications.
2. Si l'utilisateur pose simplement une question ou demande des suggestions sans modifier directement le CV, réponds-lui de manière amicale et professionnelle.

Format de réponse attendu :
Ta réponse doit être structurée avec deux parties distinctes séparées par la ligne "---JSON_START---".
La première partie est ton message destiné à l'utilisateur (en français, clair, concis, max 3-4 phrases).
La seconde partie (après la ligne "---JSON_START---") est l'objet JSON complet du CV (conforme au schéma d'origine) mis à jour, si applicable. Si aucune modification du CV n'est nécessaire ou si c'est une simple question, ne mets rien après "---JSON_START---".

Voici le JSON du CV actuel :
{json.dumps(current_cv, ensure_ascii=False, indent=2)}

Réponds selon les consignes. N'ajoute pas de blabla inutile, sois professionnel.
"""

    try:
        content, _service = llm_chat([{"role": "user", "content": prompt}],
                                     max_tokens=2000, temperature=0, timeout=90)

        parts = content.split("---JSON_START---")
        message_text = parts[0].strip()
        updated_cv = None
        
        if len(parts) > 1 and parts[1].strip():
            json_str = parts[1].strip()
            if json_str.startswith("```"):
                lines = json_str.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                json_str = "\n".join(lines).strip()
            try:
                raw_json = json.loads(json_str)
                updated_cv = normalize_cv_data(raw_json, html_content=current_cv.get("html_content", ""))
            except Exception as e:
                print("Error parsing updated CV JSON from Copilot:", e)
                
        return jsonify({
            "message": message_text,
            "updated_cv": updated_cv
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"Erreur lors de l'appel à l'IA : {str(e)}"}), 500


@app.route("/api/cvs/<cv_id>/export")
@require_auth
def export_company_cv(cv_id):
    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        abort(404)
    anon  = request.args.get("anon",  "false").lower() == "true"
    color = request.args.get("color", "orange").lower()
    return render_template("company_cv.html", cv=cv, anon=anon, color=color)


# Technologies dont le nom est trop court pour porter une voyelle. Sans cette
# liste, exiger une voyelle écarterait « R », « C# » ou « SQL » ; sans la règle
# de la voyelle, des fragments d'OCR comme « RQ » deviennent des pastilles.
_SIGLES_CONNUS = {
    "r", "c", "c#", "c++", "go", "js", "ts", "sql", "aws", "gcp", "php", "css",
    "xml", "xsl", "sap", "erp", "crm", "bi", "ml", "ia", "ai", "api", "rest",
    "dbt", "ssis", "ssas", "ssrs", "dax", "kql", "hdfs", "jwt", "s3", "vba",
}


def _pastille_plausible(nom: str) -> bool:
    """Écarte les fragments illisibles laissés par l'OCR.

    Un nom de technologie contient une voyelle, sauf s'il s'agit d'un sigle
    connu. « RQ », relevé sur un CV scanné, passait sinon en pastille.
    """
    n = nom.strip().lower()
    if n in _SIGLES_CONNUS:
        return True
    return bool(re.search(r"[aeiouyàâäéèêëîïôöùûü]", n))


def _pastilles_adbi(cv: dict, nombre: int = 4) -> list:
    """
    Les quatre étiquettes orange du haut de page.

    Elles mettent en avant les TECHNOLOGIES qui caractérisent le profil —
    « TALEND », « SQL », « BI », « CLOUD » — et non les intitulés de familles de
    compétences, qui donnaient un affichage sans relief (« MÉTHODOLOGIE,
    OUTILS, LANGAGES, FRAMEWORKS ») identique d'un candidat à l'autre.

    Le classement suit ce qui fait le poids d'une techno dans un parcours :
    figurer dans l'intitulé du poste, puis revenir souvent dans les
    environnements techniques des missions.
    """
    def normaliser(t):
        # « Talend 8.0.1 », « Oracle 12c », « SQL Server (2019) » désignent la
        # même compétence que leur nom nu : la version n'apporte rien sur une
        # pastille et empêcherait de compter les occurrences ensemble.
        t = re.sub(r"\([^)]*\)", " ", str(t or ""))
        t = re.sub(r"[\d.,/]+\s*$", "", t.strip())
        return re.sub(r"\s{2,}", " ", t).strip(" -–—:")

    titre = (cv.get("title") or "").lower()
    corpus = " ".join(
        str(e.get("env_technique") or "") + " " + str(e.get("title") or "")
        for e in (cv.get("experience") or [])
    ).lower()

    # Familles qui ne décrivent pas un savoir-faire technique : un CV listant
    # ses secteurs d'intervention affichait « PRESSE, ÉNERGIE, TÉLÉCOM » sur
    # des pastilles censées annoncer une expertise.
    HORS_TECHNIQUE = re.compile(
        r"(?i)secteur|domaine|m[ée]tier|fonctionnel|soft|langue|savoir|qualit[ée]s|"
        r"m[ée]thodologie|gestion de projet|transverse"
    )

    candidats = {}
    for famille in (cv.get("skills") or []):
        # Écartée, pas seulement dépréciée : un secteur d'activité n'est jamais
        # une compétence technique. Sur un CV dont c'est la seule rubrique aux
        # libellés courts, une simple pénalité laissait « PRESSE, ÉNERGIE,
        # TÉLÉCOM, DÉFENSE » gagner faute de concurrent.
        if HORS_TECHNIQUE.search(str(famille.get("category") or "")):
            continue
        penalite = 0
        for brut in (famille.get("items") or []):
            nom = normaliser(brut)
            if len(nom) <= 1 or not _pastille_plausible(nom):
                continue
            cle = nom.lower()
            if cle in candidats:
                continue
            poids = corpus.count(cle) - penalite
            if cle in titre:
                poids += 10          # nommé dans le poste : c'est la spécialité
            if len(nom) > 14:
                poids -= 2           # trop long pour la pastille, sans l'exclure
            candidats[cle] = (poids, nom)

    classees = sorted(candidats.values(), key=lambda x: (-x[0], len(x[1])))
    retenues = []
    for _, nom in classees:
        if len(nom) <= 14 and nom.upper() not in retenues:
            retenues.append(nom.upper())
        if len(retenues) == nombre:
            return retenues

    # Certains CV décrivent leurs compétences par des phrases d'activité
    # (« Architecture BI et Data », « Étude de faisabilité »). Les tronquer
    # donnait des pastilles illisibles coupées en plein mot : on va plutôt
    # chercher les technologies là où elles sont nommées, dans l'environnement
    # technique des missions.
    depuis_missions = {}
    for exp in (cv.get("experience") or []):
        for brut in re.split(r"[,;/•|]", str(exp.get("env_technique") or "")):
            tech = normaliser(brut)
            if 1 < len(tech) <= 14:
                depuis_missions[tech.lower()] = depuis_missions.get(tech.lower(), 0) + 1
    for cle in sorted(depuis_missions, key=lambda c: -depuis_missions[c]):
        etiquette = cle.upper()
        if etiquette not in retenues:
            retenues.append(etiquette)
        if len(retenues) == nombre:
            break

    # Moins de quatre pastilles vaut mieux qu'un mot coupé au milieu.
    return retenues


def _savoir_faire_adbi(cv: dict, maximum: int = 10) -> list:
    """Puces « Compétences technico-fonctionnelles ».

    Le parsing ne produit pas cette rubrique telle quelle : on la compose à
    partir des réalisations des missions, en écartant les doublons. Mieux vaut
    une synthèse tirée du parcours qu'une rubrique vide.
    """
    vues, lignes = set(), []
    for exp in (cv.get("experience") or []):
        for brut in str(exp.get("description") or "").split(" · "):
            phrase = brut.strip(" ·-–—")
            cle = phrase.lower()[:60]
            if 12 < len(phrase) < 200 and cle not in vues:
                vues.add(cle)
                lignes.append(phrase)
            if len(lignes) >= maximum:
                return lignes
    return lignes


@app.route("/cv/<cv_id>/adbi")
@require_auth
def apercu_adbi(cv_id):
    """
    Dossier ADBI à l'écran, prêt à imprimer en PDF.

    Reproduit `NH_ADBI.pdf` : mêmes bandeaux (extraits du PDF d'origine, pas
    réinventés), mêmes positions au point près, mêmes couleurs — orange
    #ff6600, violet #7030a0.
    """
    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        abort(404)
    return render_template(
        "adbi_cv.html",
        cv=cv,
        # Le dossier porte le trigramme, pas le nom : il se diffuse sans
        # révéler l'identité du consultant.
        trigramme=export_dossier.trigramme(cv.get("name")),
        pastilles=_pastilles_adbi(cv),
        savoir_faire=_savoir_faire_adbi(cv),
        # Sept familles au plus, comme sur les documents téléchargés : au-delà,
        # le dossier perd sa lisibilité de synthèse.
        max_familles=export_dossier.MAX_FAMILLES,
    )


@app.route("/rapprochement")
@require_auth
def page_rapprochement():
    """
    Écran « fiche de poste → classement des CV choisis ».

    `?need_id=` pré-remplit la fiche depuis un besoin enregistré : c'est ce qui
    permet à l'écran des besoins de continuer à fonctionner après le retrait de
    l'ancien matching.
    """
    besoin = None
    need_id = request.args.get("need_id", "").strip()
    if need_id:
        try:
            from core.database_pg import get_need
            besoin = get_need(need_id)
        except Exception:
            besoin = None
    return render_template("rapprochement.html", besoin_prerempli=besoin)


@app.route("/api/rapprochement", methods=["POST"])
@require_auth
def api_rapprochement():
    """
    Classe une sélection de CV face à une fiche de poste collée à l'écran.

    Diffère du matching existant sur deux points : l'entrée est un texte libre
    plutôt qu'un besoin enregistré, et la comparaison porte sur les CV choisis
    plutôt que sur toute la CVthèque.
    """
    data = request.json or {}
    description = str(data.get("description") or "").strip()
    identifiants = [str(i) for i in (data.get("cv_ids") or [])]

    if len(description) < 30:
        return jsonify({"error": "Fiche de poste trop courte pour être exploitée."}), 400
    if not identifiants:
        return jsonify({"error": "Sélectionnez au moins un CV à comparer."}), 400

    try:
        sortie = rapprochement.classer(description, identifiants, appel_llm=llm_chat,
                                       appels_llm=llm_cascade.chat_plusieurs)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"Rapprochement impossible : {e}"}), 500

    return jsonify(sortie)


@app.route("/api/rapprochement/flux", methods=["POST"])
@require_auth
def api_rapprochement_flux():
    """
    Le même classement, diffusé étape par étape.

    Deux appels au modèle s'enchaînent ici : près d'une minute pendant laquelle
    une requête classique ne renvoie rien. On émet donc une ligne JSON à chaque
    étape franchie, la dernière portant le résultat complet — l'écran peut
    ainsi dire ce qu'il fait au lieu de faire tourner une roue dans le vide.

    Le classement tourne dans un fil séparé et dépose ses étapes dans une file :
    un générateur ne peut pas produire depuis une fonction de rappel.
    """
    data = request.json or {}
    description = str(data.get("description") or "").strip()
    identifiants = [str(i) for i in (data.get("cv_ids") or [])]

    if len(description) < 30:
        return jsonify({"error": "Fiche de poste trop courte pour être exploitée."}), 400
    if not identifiants:
        return jsonify({"error": "Sélectionnez au moins un CV à comparer."}), 400

    file_etapes = queue.Queue()

    def travailler():
        try:
            sortie = rapprochement.classer(
                description, identifiants, appel_llm=llm_chat,
                appels_llm=llm_cascade.chat_plusieurs,
                progression=lambda etape, detail="": file_etapes.put(
                    {"etape": etape, "detail": detail}),
            )
            file_etapes.put({"fini": True, "resultat": sortie})
        except Exception as e:
            traceback.print_exc()
            file_etapes.put({"erreur": f"Rapprochement impossible : {e}"})

    threading.Thread(target=travailler, daemon=True).start()

    def diffuser():
        while True:
            try:
                message = file_etapes.get(timeout=180)
            except queue.Empty:
                yield json.dumps({"erreur": "Délai dépassé."}) + "\n"
                return
            yield json.dumps(message, ensure_ascii=False) + "\n"
            if "fini" in message or "erreur" in message:
                return

    return app.response_class(
        diffuser(), mimetype="application/x-ndjson",
        # Sans cet en-tête, un proxy peut retenir le flux jusqu'à la fin et
        # réduire à néant l'intérêt de la diffusion.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/cvs/<cv_id>/dossier.<format_sortie>")
@require_auth
def telecharger_dossier(cv_id, format_sortie):
    """
    Dossier de compétences ADBI, en PDF ou en Word.

    Même gabarit, même contenu, deux formats : le PDF pour envoyer au client,
    le Word pour retoucher avant envoi.
    """
    if format_sortie not in ("pdf", "docx"):
        abort(404)
    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        abort(404)

    pastilles = _pastilles_adbi(cv)
    savoir = _savoir_faire_adbi(cv)
    try:
        if format_sortie == "pdf":
            flux = export_dossier.en_pdf(cv, pastilles, savoir)
            type_mime = "application/pdf"
        else:
            flux = export_dossier.en_word(cv, pastilles, savoir)
            type_mime = ("application/vnd.openxmlformats-officedocument"
                         ".wordprocessingml.document")
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"Génération du dossier impossible : {e}"}), 500

    return send_file(flux, mimetype=type_mime, as_attachment=True,
                     download_name=export_dossier.nom_fichier(cv, "." + format_sortie))


@app.route("/api/cvs/<cv_id>/export/word")
@require_auth
def export_word(cv_id):
    """Generate a .docx Word export — ADBI branded, matching the reference template exactly.

    Layout (mirrors ABC_ADBI reference .docx):
      • Table 0  — header: name/title/exp left | ADBI logo right  (white bg)
      • Table 1  — black separator line
      • Table 2  — 2-col skills / formations / languages
      • Paragraph "Projets" (once)
      • Per experience: 2-col company|period table + narrative paragraphs
    """
    if not _DOCX_AVAILABLE:
        return jsonify({"error": "python-docx non installé"}), 500

    cv = cvstore_pg.get_cv(cv_id)
    if cv is None:
        abort(404)
    c         = cv.get("contact") or {}
    name      = cv.get("name") or "Candidat"
    title_str = cv.get("title") or ""
    years_raw = cv.get("years_experience")
    try:
        years = int(years_raw) if years_raw else 0
    except (ValueError, TypeError):
        years = 0
    color_key = request.args.get("color", "orange").lower()

    # ── Primary & secondary colors per theme ─────────────────────────────
    _PRI = {
        "orange": RGBColor(0xFF, 0x66, 0x00),   # #FF6600 — matches reference
        "blue":   RGBColor(0x1B, 0x4D, 0x8C),
        "green":  RGBColor(0x15, 0x80, 0x3D),
        "grey":   RGBColor(0x4B, 0x55, 0x63),
    }
    _SEC = {
        "orange": RGBColor(0xF0, 0x70, 0x40),
        "blue":   RGBColor(0x3A, 0x82, 0xE6),
        "green":  RGBColor(0x22, 0xC5, 0x5E),
        "grey":   RGBColor(0x9C, 0xA3, 0xAF),
    }
    COL1   = _PRI.get(color_key, _PRI["orange"])
    COL2   = _SEC.get(color_key, _SEC["orange"])
    PURPLE = RGBColor(0x70, 0x30, 0xA0)   # years-of-experience accent (ref template)
    DARK   = RGBColor(0x1A, 0x1A, 0x1A)

    # ── Low-level XML helpers ─────────────────────────────────────────────
    def _run(para, text, color=DARK, bold=False, italic=False, size_pt=None):
        """Add a styled run to *para*."""
        r = para.add_run(text)
        r.font.color.rgb = color
        r.bold   = bold
        r.italic = italic
        if size_pt:
            r.font.size = Pt(size_pt)
        return r

    def _get_tblPr(tbl):
        """Find or create w:tblPr on a CT_Tbl element."""
        el = tbl._tbl
        tblPr = el.find(qn("w:tblPr"))
        if tblPr is None:
            tblPr = OxmlElement("w:tblPr")
            el.insert(0, tblPr)
        return tblPr

    def _remove_table_borders(tbl):
        """Strip all visible borders from a table (invisible layout table)."""
        tblPr = _get_tblPr(tbl)
        # Remove any existing tblBorders element first
        for old in tblPr.findall(qn("w:tblBorders")):
            tblPr.remove(old)
        bdr = OxmlElement("w:tblBorders")
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            b = OxmlElement(f"w:{side}")
            b.set(qn("w:val"),   "none")
            b.set(qn("w:sz"),    "0")
            b.set(qn("w:space"), "0")
            b.set(qn("w:color"), "auto")
            bdr.append(b)
        tblPr.append(bdr)

    def _separator_table_border(tbl):
        """Apply a single solid black top-border to simulate a horizontal rule."""
        tblPr = _get_tblPr(tbl)
        for old in tblPr.findall(qn("w:tblBorders")):
            tblPr.remove(old)
        bdr = OxmlElement("w:tblBorders")
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            b = OxmlElement(f"w:{side}")
            if side == "top":
                b.set(qn("w:val"),   "single")
                b.set(qn("w:sz"),    "8")
                b.set(qn("w:space"), "0")
                b.set(qn("w:color"), "000000")
            else:
                b.set(qn("w:val"),   "none")
                b.set(qn("w:sz"),    "0")
                b.set(qn("w:space"), "0")
                b.set(qn("w:color"), "auto")
            bdr.append(b)
        tblPr.append(bdr)

    def _cell_margins(cell, top=60, bottom=60, left=80, right=80):
        """Set inner padding (twips) on a table cell."""
        tcPr  = cell._tc.get_or_add_tcPr()
        tcMar = OxmlElement("w:tcMar")
        for side, val in (("top", top), ("bottom", bottom),
                          ("left", left), ("right", right)):
            m = OxmlElement(f"w:{side}")
            m.set(qn("w:w"),    str(val))
            m.set(qn("w:type"), "dxa")
            tcMar.append(m)
        tcPr.append(tcMar)

    def _merged_section_header(tbl, text):
        """Append a full-width merged row bearing a coloured section heading."""
        row = tbl.add_row()
        merged = row.cells[0].merge(row.cells[1])
        p = merged.paragraphs[0]
        p.paragraph_format.space_before = Pt(8)
        p.paragraph_format.space_after  = Pt(3)
        _run(p, text, COL1, bold=True, size_pt=12)

    # ── Document setup ────────────────────────────────────────────────────
    doc = DocxDoc()
    for sec in doc.sections:
        sec.page_height     = Cm(29.7)
        sec.page_width      = Cm(21.0)
        sec.top_margin      = Cm(0)       # content starts at very top
        sec.bottom_margin   = Cm(1.47)
        sec.left_margin     = Cm(2.0)
        sec.right_margin    = Cm(1.25)
        sec.header_distance = Cm(0)
    doc.styles["Normal"].font.name = "Calibri"
    doc.styles["Normal"].font.size = Pt(10)

    # Usable content width: 21.0 − 2.0 − 1.25 = 17.75 cm
    W_TOTAL   = Cm(17.75)
    W_HDR_L   = Cm(10.32)
    W_HDR_R   = Cm(17.75 - 10.32)   # ≈ 7.43 cm
    W_DATE    = Cm(2.52)
    W_CONTENT = Cm(17.75 - 2.52)    # ≈ 15.23 cm
    W_EXP_L   = Cm(12.75)
    W_EXP_R   = Cm(17.75 - 12.75)   # = 5.00 cm

    # ═══════════════════════════════════════════════════════════════════════
    # TABLE 0 — Header  (white background, orange text)
    # ═══════════════════════════════════════════════════════════════════════
    hdr = doc.add_table(rows=1, cols=2)
    hdr.columns[0].width = W_HDR_L
    hdr.columns[1].width = W_HDR_R

    cl = hdr.rows[0].cells[0]
    cr = hdr.rows[0].cells[1]
    _cell_margins(cl, top=140, bottom=100, left=0, right=60)
    _cell_margins(cr, top=140, bottom=100, left=60, right=0)

    # Left: name, title, years, contact
    p_name = cl.paragraphs[0]
    p_name.paragraph_format.space_after = Pt(1)
    _run(p_name, name, COL1, bold=True, size_pt=16)

    if title_str:
        pt = cl.add_paragraph()
        pt.paragraph_format.space_after = Pt(1)
        _run(pt, title_str, DARK, bold=True, size_pt=11)

    if years:
        pe = cl.add_paragraph()
        pe.paragraph_format.space_after = Pt(5)
        _run(pe, f"{years} ans d'expérience", PURPLE, bold=True, size_pt=10)

    contact_parts = []
    if c.get("location"): contact_parts.append(f"  {c['location']}")
    if c.get("email"):    contact_parts.append(f"  {c['email']}")
    if c.get("phone"):    contact_parts.append(f"  {c['phone']}")
    if contact_parts:
        pc = cl.add_paragraph()
        pc.paragraph_format.space_after = Pt(4)
        _run(pc, "   ·   ".join(contact_parts), DARK, size_pt=8.5)

    # Right: ADBI logo (italic bold, large)
    p_logo = cr.paragraphs[0]
    p_logo.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    _run(p_logo, "adbi", COL1, bold=True, italic=True, size_pt=32)
    _run(p_logo, "●",   COL2, bold=True, size_pt=18)

    _remove_table_borders(hdr)

    # ═══════════════════════════════════════════════════════════════════════
    # TABLE 1 — Separator  (single black horizontal rule)
    # ═══════════════════════════════════════════════════════════════════════
    sep = doc.add_table(rows=1, cols=1)
    sep.columns[0].width = W_TOTAL
    _cell_margins(sep.rows[0].cells[0], top=0, bottom=0, left=0, right=0)
    sep.rows[0].cells[0].paragraphs[0].paragraph_format.space_before = Pt(0)
    sep.rows[0].cells[0].paragraphs[0].paragraph_format.space_after  = Pt(0)
    _separator_table_border(sep)

    sp = doc.add_paragraph()
    sp.paragraph_format.space_after = Pt(6)

    # ═══════════════════════════════════════════════════════════════════════
    # TABLE 2 — Skills / Formations / Languages  (2 cols: date | content)
    # ═══════════════════════════════════════════════════════════════════════
    skills    = cv.get("skills")         or []
    interests = cv.get("interests")      or []
    edus      = cv.get("education")      or []
    certs     = cv.get("certifications") or []
    languages = cv.get("languages")      or []

    if skills or interests or edus or certs or languages:
        ct = doc.add_table(rows=0, cols=2)
        ct.columns[0].width = W_DATE
        ct.columns[1].width = W_CONTENT
        _remove_table_borders(ct)

        # — Compétences techniques —
        if skills:
            _merged_section_header(ct, "Compétences techniques")
            for sk in skills:
                row = ct.add_row()
                p0 = row.cells[0].paragraphs[0]
                p1 = row.cells[1].paragraphs[0]
                p0.paragraph_format.space_after = Pt(1)
                p1.paragraph_format.space_after = Pt(1)
                _run(p0, sk.get("category", ""), DARK, bold=True, size_pt=9.5)
                _run(p1, ", ".join(sk.get("items") or []), DARK, size_pt=9.5)

        # — Compétences technico-fonctionnelles —
        if interests:
            _merged_section_header(ct, "Compétences technico-fonctionnelles")
            row = ct.add_row()
            mc = row.cells[0].merge(row.cells[1])
            first_p = mc.paragraphs[0]
            first_p.paragraph_format.space_after = Pt(1)
            _run(first_p, interests[0], DARK, size_pt=9.5)
            for item in interests[1:]:
                p = mc.add_paragraph()
                p.paragraph_format.space_after = Pt(1)
                _run(p, item, DARK, size_pt=9.5)

        # — Formations & Certifications —
        if edus or certs:
            _merged_section_header(ct, "Formations & Certifications")
            for edu in edus:
                row = ct.add_row()
                p0 = row.cells[0].paragraphs[0]
                p1 = row.cells[1].paragraphs[0]
                p0.paragraph_format.space_after = Pt(1)
                p1.paragraph_format.space_after = Pt(1)
                _run(p0, edu.get("period") or "", DARK, bold=True, size_pt=9.5)
                txt = edu.get("title") or ""
                if edu.get("subtitle"):
                    txt += f" — {edu['subtitle']}"
                _run(p1, txt, DARK, size_pt=9.5)
            for cert in certs:
                row = ct.add_row()
                p0 = row.cells[0].paragraphs[0]
                p1 = row.cells[1].paragraphs[0]
                p0.paragraph_format.space_after = Pt(1)
                p1.paragraph_format.space_after = Pt(1)
                _run(p0, cert.get("year") or "", DARK, bold=True, size_pt=9.5)
                _run(p1, cert.get("name") or "", DARK, size_pt=9.5)

        # — Langues —
        if languages:
            _merged_section_header(ct, "Langues")
            for lang in languages:
                row = ct.add_row()
                p0 = row.cells[0].paragraphs[0]
                p1 = row.cells[1].paragraphs[0]
                p0.paragraph_format.space_after = Pt(1)
                p1.paragraph_format.space_after = Pt(1)
                _run(p0, lang.get("language") or "", DARK, bold=True, size_pt=9.5)
                _run(p1, lang.get("level")    or "", DARK, size_pt=9.5)

    # ═══════════════════════════════════════════════════════════════════════
    # EXPÉRIENCES — "Projets" heading once, then all missions in sequence
    # ═══════════════════════════════════════════════════════════════════════
    experiences = cv.get("experience") or []
    if experiences:
        # "Projets" — appears exactly once, before all experiences
        pp = doc.add_paragraph()
        pp.paragraph_format.space_before = Pt(16)
        pp.paragraph_format.space_after  = Pt(8)
        _run(pp, "Projets", COL1, bold=True, size_pt=16)

        for exp in experiences:
            company = exp.get("company") or exp.get("title") or ""
            role    = exp.get("title") if exp.get("company") else (exp.get("subtitle") or "")
            period  = exp.get("period") or ""
            client  = exp.get("client") or ""

            # ── 2-col row: company name (left) | period (right) ──────────
            et = doc.add_table(rows=1, cols=2)
            et.columns[0].width = W_EXP_L
            et.columns[1].width = W_EXP_R
            _remove_table_borders(et)

            lp = et.rows[0].cells[0].paragraphs[0]
            lp.paragraph_format.space_before = Pt(10)
            lp.paragraph_format.space_after  = Pt(2)
            _run(lp, company, COL1, bold=True, size_pt=12)
            if client:
                _run(lp, f"  —  {client}", COL1, italic=True, size_pt=10)

            rp = et.rows[0].cells[1].paragraphs[0]
            rp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            rp.paragraph_format.space_before = Pt(10)
            rp.paragraph_format.space_after  = Pt(2)
            _run(rp, period, COL1, bold=True, size_pt=12)

            # ── Rôle ─────────────────────────────────────────────────────
            if role:
                p = doc.add_paragraph()
                p.paragraph_format.space_after = Pt(3)
                _run(p, "Rôle : ", DARK, bold=True, size_pt=10)
                _run(p, role, DARK, italic=True, size_pt=10)

            # ── Contexte / Mission / Méthodologie ─────────────────────────
            for label, field in [("Contexte : ",      "contexte"),
                                  ("Mission : ",       "objectifs"),
                                  ("Méthodologie : ",  "methodologie")]:
                if exp.get(field):
                    p = doc.add_paragraph()
                    p.paragraph_format.space_after = Pt(3)
                    _run(p, label,      DARK, bold=True, size_pt=9.5)
                    _run(p, exp[field], DARK, size_pt=9.5)

            # ── Réalisations (bullet list) ────────────────────────────────
            if exp.get("description"):
                bullets = [b.strip() for b in exp["description"].split(" · ") if b.strip()]
                if bullets:
                    for b in bullets:
                        bp = doc.add_paragraph(style="List Bullet")
                        _run(bp, b, DARK, size_pt=9.5)
                        bp.paragraph_format.space_after = Pt(2)

            # ── Environnement technique ───────────────────────────────────
            if exp.get("env_technique"):
                p = doc.add_paragraph()
                p.paragraph_format.space_before = Pt(4)
                p.paragraph_format.space_after  = Pt(10)
                _run(p, "Environnement technique : ", DARK, bold=True, size_pt=9.5)
                _run(p, exp["env_technique"],         DARK, size_pt=9.5)

    # ── Save & stream ─────────────────────────────────────────────────────
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    safe_name = re.sub(r"[^\w\s-]", "", name).strip().replace(" ", "_")
    return send_file(
        buf,
        as_attachment=True,
        download_name=f"CV_ADBI_{safe_name}.docx",
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


@app.route("/api/cvs/<cv_id>/translate", methods=["POST"])
@require_auth
def translate_cv(cv_id):
    """Translate a CV to English and store it as a NEW linked entry (original untouched)."""
    import shutil
    original = cvstore_pg.get_cv(cv_id)
    if original is None:
        abort(404)
    target    = (request.json or {}).get("target", "en")
    lang_name = "English" if target == "en" else "French"

    payload = {k: original.get(k) for k in
               ("name", "title", "experience", "education", "skills", "interests", "certifications", "languages")}
    prompt = (
        f"Translate the following CV JSON values from French to {lang_name}. "
        "Keep ALL field NAMES exactly as-is (they are already in English). "
        "Only translate the string VALUES (descriptions, titles, categories, items, levels…). "
        "Return ONLY a valid JSON object with the same structure, no extra text.\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )
    try:
        content, _service = llm_chat([{"role": "user", "content": prompt}],
                                     max_tokens=3500, temperature=0, timeout=90)
        content = content.strip()
        if content.startswith("```"):
            content = "\n".join(l for l in content.split("\n") if not l.startswith("```")).strip()
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            raise RuntimeError("No JSON object found in LLM response")
        translated = json.loads(m.group(0))
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    # ── Create a new DB entry (copy of original) with translated content ──
    new_id = str(uuid.uuid4())
    new_cv = dict(original)          # shallow copy of all fields
    new_cv["id"]            = new_id
    new_cv["source_cv_id"]  = cv_id  # link to original
    new_cv["language"]      = target
    new_cv["stored_at"]     = datetime.now().isoformat()
    new_cv["llm_enriched"]  = True
    new_cv["years_experience"] = int(original.get("years_experience") or 0)

    # Apply translated fields
    for k in ("name", "title", "experience", "education", "skills", "interests", "certifications", "languages"):
        if translated.get(k):
            new_cv[k] = translated[k]

    # Append language tag to name so it's distinguishable in the list
    suffix = " (EN)" if target == "en" else " (FR)"
    if not new_cv.get("name", "").endswith(suffix):
        new_cv["name"] = new_cv.get("name", original.get("name", "")) + suffix

    # Copy the original uploaded file so the PDF viewer still works
    orig_ext = original.get("ext", ".pdf")
    src_file = UPLOAD_DIR / f"{cv_id}{orig_ext}"
    if src_file.exists():
        dst_file = UPLOAD_DIR / f"{new_id}{orig_ext}"
        shutil.copy2(src_file, dst_file)
        new_cv["ext"]      = orig_ext
        new_cv["filename"] = Path(original.get("filename", "")).stem + f"_{target.upper()}{orig_ext}"

    cvstore_pg.save_cv(new_id, new_cv)
    return jsonify({"success": True, "new_id": new_id})


@app.route("/api/cvs/<cv_id>/enrich", methods=["POST"])
@require_auth
def enrich_cv_endpoint(cv_id):
    """Enrich CV bullet points and descriptions using LLM."""
    with _verrou_cv(cv_id):
        cv = cvstore_pg.get_cv(cv_id)
        if cv is None:
            abort(404)

        snippet = json.dumps({k: cv.get(k) for k in ("title", "experience", "skills", "interests")},
                             ensure_ascii=False, indent=2)[:8000]
        prompt = (
            "Tu es un expert en rédaction de CVs professionnels.\n"
            "Améliore ce CV en :\n"
            "1. Rendant les descriptions plus percutantes (verbes d'action forts)\n"
            "2. Quantifiant les réalisations si possible (ex: 'réduction de 30 %')\n"
            "3. Ajoutant des mots-clés métier pertinents dans les compétences\n"
            "4. Complétant les champs vides si tu peux les inférer du contexte\n"
            "N'invente pas d'entreprises ni de dates.\n"
            "Retourne UNIQUEMENT l'objet JSON avec les mêmes clés, aucun texte autour.\n\n"
            + snippet
        )
        try:
            content, _service = llm_chat([{"role": "user", "content": prompt}],
                                         max_tokens=3000, temperature=0.3, timeout=90)
            content = content.strip()
            if content.startswith("```"):
                content = "\n".join(l for l in content.split("\n") if not l.startswith("```")).strip()
            enriched = json.loads(re.search(r"\{[\s\S]*\}", content).group(0))
            for k in ("title", "experience", "skills", "interests"):
                if enriched.get(k):
                    cv[k] = enriched[k]
            cv["enriched"] = True
            cvstore_pg.save_cv(cv_id, cv)
            return jsonify({"success": True})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500


@app.route("/api/cvs/<cv_id>/adapt", methods=["POST"])
@require_auth
def adapt_cv(cv_id):
    """Adapt CV to a given job posting using LLM. Saves result directly."""
    job_posting = (request.json or {}).get("job_posting", "").strip()
    if not job_posting:
        return jsonify({"error": "Fiche de poste manquante"}), 400

    with _verrou_cv(cv_id):
        cv = cvstore_pg.get_cv(cv_id)
        if cv is None:
            abort(404)

        cv_snippet = json.dumps({k: cv.get(k) for k in ("title", "experience", "skills", "interests", "education")},
                                ensure_ascii=False, indent=2)[:6000]
        prompt = (
            "Tu es un expert en recrutement et en optimisation de CVs.\n"
            "Adapte ce CV pour le poste décrit dans la fiche ci-dessous :\n"
            "- Réorganise et reformule les compétences pour matcher les mots-clés du poste\n"
            "- Mets en avant les expériences les plus pertinentes\n"
            "- Adapte le titre professionnel si nécessaire\n"
            "- N'invente aucune expérience ni compétence absente du CV original\n"
            "Retourne UNIQUEMENT l'objet JSON adapté, même structure, aucun texte autour.\n\n"
            f"FICHE DE POSTE :\n{job_posting[:3000]}\n\n"
            f"CV ACTUEL :\n{cv_snippet}"
        )
        try:
            content, _service = llm_chat([{"role": "user", "content": prompt}],
                                         max_tokens=3000, temperature=0.2, timeout=90)
            content = content.strip()
            if content.startswith("```"):
                content = "\n".join(l for l in content.split("\n") if not l.startswith("```")).strip()
            adapted = json.loads(re.search(r"\{[\s\S]*\}", content).group(0))
            for k in ("title", "experience", "skills", "interests"):
                if adapted.get(k):
                    cv[k] = adapted[k]
            cv["adapted_to_job"] = True
            cvstore_pg.save_cv(cv_id, cv)
            return jsonify({"success": True})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # ── Lancement local uniquement ────────────────────────────────────────────
    # `python app.py` reste le chemin de développement (serveur de dev Flask,
    # confortable pour le rechargement et le débogueur local). L'image Docker
    # ne passe plus par ici : son CMD lance Gunicorn directement sur le module
    # `app` (voir Dockerfile et gunicorn.conf.py), donc ce bloc n'y est jamais
    # exécuté — init_schema()/ensure_default_superuser() ont donc été déplacés
    # plus haut, au chargement du module, pour tourner dans les deux cas.

    # Rechargement automatique DÉSACTIVÉ par défaut. Le veilleur de Werkzeug
    # surveillait aussi site-packages : torch, torchvision et jusqu'aux modules
    # d'encodage de Python déclenchaient des redémarrages — trois pendant un
    # seul dépôt de CV lors du dernier essai — et chaque redémarrage tue la
    # requête en cours (« connexion fermée » côté navigateur, analyse perdue
    # après une minute d'OCR).
    # Pour retrouver le rechargement pendant un développement : ADBI_RELOAD=on.
    recharger = os.environ.get("ADBI_RELOAD", "").lower() in ("1", "on", "true")
    # Débogueur Werkzeug DÉSACTIVÉ par défaut : en conteneur/déploiement, un
    # débogueur interactif accessible depuis le réseau permet l'exécution de
    # code arbitraire (CVE connues sur Werkzeug). ADBI_DEBUG=on pour le
    # retrouver en développement local uniquement.
    debogage = os.environ.get("ADBI_DEBUG", "").lower() in ("1", "on", "true")
    # 127.0.0.1 par défaut (comme avant, poste local derrière la Factory) ;
    # ADBI_HOTE=0.0.0.0 est nécessaire en conteneur, où 127.0.0.1 ne serait
    # pas joignable depuis l'hôte via le mappage de port Docker (posé dans le
    # Dockerfile de l'image, pas ici).
    hote = os.environ.get("ADBI_HOTE", "127.0.0.1")
    port = int(os.environ.get("PORT", 5000))
    app.run(host=hote, port=port, debug=debogage, threaded=True, use_reloader=recharger)
