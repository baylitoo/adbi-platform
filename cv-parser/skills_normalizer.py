"""
skills_normalizer.py — ADBI CV Parser
======================================
Normalisation des compétences techniques pour la recherche et le filtrage.

- SYNONYMES        : synonymes stricts PARTAGÉS avec one-pager (fichier JSON)
- canonique()      : nom canonique d'un libellé de compétence (table partagée)
- cle_competence() : clé de dédoublonnage dans une catégorie (sans accent ni casse)
- ALIASES          : SYNONYMES + table locale de la recherche (skills_flat)
- normalize_one()   : normalise un skill isolé
- normalize_skills(): normalise une liste, élimine les doublons
- skills_to_flat()  : extrait la liste plate depuis la structure {category, items}
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Iterable

from periode_mission import sans_accents

# ---------------------------------------------------------------------------
# Synonymes stricts partagés avec one-pager (#177 lignes G et H)
# ---------------------------------------------------------------------------
# Deux tables disaient « ces libellés sont la même compétence » : ALIASES
# ci-dessous et one-pager/lib/taxonomy.js. Mesuré sur leurs 286 clés communes
# possibles : 166 d'accord, 32 en désaccord, 88 inconnues du JS. La part sur
# laquelle elles s'accordaient ET qui ne relève que de la graphie (k8s,
# postgres, nodejs…) vit désormais dans un seul fichier, lu par les deux
# services à l'exécution. Les familles que taxonomy.js regroupe pour le tri
# commercial (Keras sous TensorFlow, EKS sous Kubernetes) n'y sont PAS : les
# porter ici retirerait ces compétences de la CVthèque.
#
# Lu AU CHARGEMENT et sans garde : une table absente doit empêcher le service
# de démarrer, pas faire revenir la divergence en silence. Même chemin dans le
# dépôt et dans l'image (cv-parser/Dockerfile, `COPY --from=fixtures`) :
# /app/skills_normalizer.py -> /document-parsing/fixtures/.
SYNONYMES_CHEMIN = (Path(__file__).resolve().parents[1]
                    / "document-parsing" / "fixtures" / "competences_synonymes.json")
SYNONYMES: dict[str, list[str]] = json.loads(
    SYNONYMES_CHEMIN.read_text(encoding="utf-8"))["synonymes"]


def normaliser_libelle(terme) -> str:
    """Port de taxonomy.js::normalize — mêmes étapes, dans le même ordre.

    Sans accents, minuscules, apostrophes et tirets typographiques unifiés,
    soulignés en espaces, espaces réduits, ponctuation de bordure retirée.
    """
    if terme is None:
        return ""
    s = re.sub("[\u0300-\u036f]", "", unicodedata.normalize("NFD", str(terme))).lower()
    s = re.sub("[\u2018\u2019\u2032]", "'", s)
    s = re.sub("[\u2010-\u2015]", "-", s)
    s = re.sub(r"_+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^[.,;:!?]+", "", s)
    return re.sub(r"[.,;:!?]+$", "", s).strip()


def _compacter(normalise: str) -> str:
    """Port de taxonomy.js::compact : « power-bi » == « power bi » == « powerbi »."""
    return re.sub(r"[\s.\-/']", "", normalise)


# Index construits une fois, premier arrivé premier servi — comme buildIndexes.
_INDEX: dict[str, str] = {}
_INDEX_COMPACT: dict[str, str] = {}
for _nom, _variantes in SYNONYMES.items():
    for _cle in (_nom, *_variantes):
        _n = normaliser_libelle(_cle)
        if not _n:
            continue
        _INDEX.setdefault(_n, _nom)
        if len(_compacter(_n)) >= 3:
            _INDEX_COMPACT.setdefault(_compacter(_n), _nom)


def canonique(libelle) -> str:
    """Nom canonique d'après la table partagée, sinon le libellé nettoyé.

    Même contrat que taxonomy.js::canonical, restreint aux synonymes partagés.
    """
    n = normaliser_libelle(libelle)
    nom = _INDEX.get(n)
    if nom is None and len(_compacter(n)) >= 3:
        nom = _INDEX_COMPACT.get(_compacter(n))
    if nom is not None:
        return nom
    return "" if libelle is None else re.sub(r"\s+", " ", str(libelle)).strip()


def cle_competence(libelle) -> str:
    """Clé de doublon : le nom canonique sans accent ni casse.

    Celle de one-pager (lib/extract.js::dedupe sur taxo.canonical) :
    « Modélisation » et « Modelisation » ont la même clé.
    """
    return sans_accents(canonique(libelle)).lower()


# ---------------------------------------------------------------------------
# Table locale de la recherche (clé = lowercase normalisé → valeur = nom affiché)
# ---------------------------------------------------------------------------
# Ce que la table partagée ne porte pas : clés inconnues de one-pager (AWS
# Glue, Airflow…), noms qui diffèrent de ceux de taxonomy.js (« spark » ->
# « Apache Spark » ici, « Spark » là-bas — les changer renommerait les
# skills_flat déjà stockés), versions et déclinaisons. ALIASES, plus bas,
# réunit les deux ; une clé de la table partagée n'est jamais recopiée ici
# (tests/test_competences_synonymes.py le vérifie).
_ALIASES_LOCAUX: dict[str, str] = {

    # ── Python ──────────────────────────────────────────────────────────────
    "python3": "Python", "python 3": "Python",
    "python2": "Python", "python 2": "Python",

    # ── JavaScript ──────────────────────────────────────────────────────────
    "es6": "JavaScript", "es2015": "JavaScript",

    # ── Angular ─────────────────────────────────────────────────────────────
    "angularjs": "Angular",
    "angular.js": "Angular", "angular js": "Angular",

    # ── Vue ─────────────────────────────────────────────────────────────────
    "vue": "Vue.js",
    "nuxt": "Nuxt.js", "nuxtjs": "Nuxt.js",

    # ── C# / .NET ───────────────────────────────────────────────────────────
    "asp.net": "ASP.NET",
    "blazor": "Blazor",

    # ── C / C++ ─────────────────────────────────────────────────────────────
    "c/c++": "C/C++",

    # ── Databases relationnelles ─────────────────────────────────────────────
    "sqlite": "SQLite",
    "oracle": "Oracle DB", "oracle db": "Oracle DB",
    "oracle database": "Oracle DB",

    # ── Databases NoSQL ──────────────────────────────────────────────────────
    "elastic": "Elasticsearch",
    "hbase": "HBase",
    "amazon dynamodb": "DynamoDB",
    "couchdb": "CouchDB",

    # ── Cloud — AWS ──────────────────────────────────────────────────────────
    "amazon aws": "AWS",
    "s3": "AWS S3", "amazon s3": "AWS S3",
    "ec2": "AWS EC2", "amazon ec2": "AWS EC2",
    "emr": "AWS EMR",
    "aws glue": "AWS Glue", "glue": "AWS Glue",
    "athena": "Amazon Athena", "amazon athena": "Amazon Athena",
    "sagemaker": "SageMaker", "amazon sagemaker": "SageMaker",
    "step functions": "AWS Step Functions",
    "kinesis": "AWS Kinesis",
    "ecs": "AWS ECS", "eks": "AWS EKS",

    # ── Cloud — GCP ──────────────────────────────────────────────────────────
    "dataflow": "Google Dataflow", "google dataflow": "Google Dataflow",
    "pub/sub": "Pub/Sub", "pubsub": "Pub/Sub",
    "dataproc": "Dataproc", "google dataproc": "Dataproc",
    "cloud storage": "Google Cloud Storage",

    # ── Cloud — Azure ────────────────────────────────────────────────────────
    "azure synapse analytics": "Azure Synapse",
    "ado": "Azure DevOps",
    "fabric": "Microsoft Fabric", "microsoft fabric": "Microsoft Fabric",
    "azure ml": "Azure ML", "azure machine learning": "Azure ML",
    "azure databricks": "Databricks",
    "azure blob": "Azure Blob Storage", "blob storage": "Azure Blob Storage",
    "azure functions": "Azure Functions",
    "azure event hub": "Azure Event Hub", "event hub": "Azure Event Hub",
    "azure stream analytics": "Azure Stream Analytics",
    "azure logic apps": "Azure Logic Apps",
    "azure aks": "Azure AKS",

    # ── BI / Dataviz ─────────────────────────────────────────────────────────
    "ms bi": "Power BI",
    "power bi desktop": "Power BI", "power bi service": "Power BI",
    "power bi report server": "Power BI",
    "qlik": "QlikSense",
    "qliksense": "QlikSense", "qlik sense": "QlikSense",
    "metabase": "Metabase",
    "superset": "Apache Superset", "apache superset": "Apache Superset",
    "microstrategy": "MicroStrategy",

    # ── Big Data / Data Engineering ──────────────────────────────────────────
    "spark": "Apache Spark", "apache spark": "Apache Spark",
    "pyspark": "PySpark",
    "apache hadoop": "Hadoop",
    "kafka": "Apache Kafka", "apache kafka": "Apache Kafka",
    "airflow": "Apache Airflow", "apache airflow": "Apache Airflow",
    "dbt core": "dbt",
    "flink": "Apache Flink", "apache flink": "Apache Flink",
    "delta lake": "Delta Lake", "delta": "Delta Lake",
    "lakehouse": "Lakehouse",
    "data lake": "Data Lake", "datalake": "Data Lake",
    "data warehouse": "Data Warehouse", "datawarehouse": "Data Warehouse",
    "data mesh": "Data Mesh",

    # ── ML / IA ───────────────────────────────────────────────────────────────
    "ml": "Machine Learning",
    "dl": "Deep Learning",
    "computer vision": "Computer Vision",
    "tf": "TensorFlow",
    "keras": "Keras",
    "xgboost": "XGBoost",
    "lightgbm": "LightGBM",
    "huggingface": "Hugging Face", "hugging face": "Hugging Face",
    "openai": "OpenAI", "gpt": "GPT", "chatgpt": "ChatGPT",
    "mlflow": "MLflow",
    "generative ai": "GenAI", "gen ai": "GenAI", "genai": "GenAI",

    # ── DevOps / Infrastructure ──────────────────────────────────────────────
    "ci/cd": "CI/CD", "cicd": "CI/CD",
    "gitlab-ci": "GitLab CI/CD", "gitlab ci": "GitLab CI/CD",
    "bash": "Bash/Shell", "shell": "Bash/Shell",
    "shell scripting": "Bash/Shell", "bash scripting": "Bash/Shell",
    "elk": "ELK Stack",

    # ── Méthodologies ────────────────────────────────────────────────────────
    "scaled agile": "SAFe",
    "itil v4": "ITIL",
    "waterfall": "Cycle en V",

    # ── Versioning ───────────────────────────────────────────────────────────
    "bitbucket": "Bitbucket",

    # ── API / Architecture ───────────────────────────────────────────────────
    "api": "API",

    # ── Python libs ──────────────────────────────────────────────────────────
    "matplotlib": "Matplotlib",
    "seaborn": "Seaborn",
    "plotly": "Plotly",
    "celery": "Celery",
    "sqlalchemy": "SQLAlchemy",
    "pydantic": "Pydantic",

    # ── Java / JVM ───────────────────────────────────────────────────────────
    "jvm": "JVM",

    # ── Message Brokers ──────────────────────────────────────────────────────
    "nats": "NATS",
}

# ---------------------------------------------------------------------------
# Fonctions publiques
# ---------------------------------------------------------------------------

def _key(raw: str) -> str:
    """Normalise la clé de lookup (lowercase, espaces réduits)."""
    return re.sub(r"\s+", " ", raw.strip().lower())


# Table de la recherche = table locale + table partagée. Une même clé des deux
# côtés avec deux noms différents serait une divergence : le test l'interdit.
ALIASES: dict[str, str] = dict(_ALIASES_LOCAUX)
for _nom, _variantes in SYNONYMES.items():
    for _cle in (_nom, *_variantes):
        ALIASES[_key(_cle)] = _nom


def normalize_one(raw: str) -> str:
    """Retourne le nom canonique d'un skill (alias résolu ou original préservé)."""
    if not raw or not raw.strip():
        return ""
    return ALIASES.get(_key(raw), raw.strip())


def normalize_skills(raw_skills: Iterable[str]) -> list[str]:
    """
    Normalise une liste de skills bruts.
    - Résout les alias
    - Supprime les doublons (insensibles à la casse et aux accents)
    - Préserve l'ordre de première apparition
    """
    seen: dict[str, str] = {}   # clé sans accent → premier canonique rencontré
    for raw in raw_skills:
        if not raw or not raw.strip():
            continue
        canonical = normalize_one(raw)
        # Sans accent aussi (#177 ligne G) : « Modélisation » et « Modelisation »
        # restaient deux entrées de skills_flat, donc de /api/skills et du
        # rapprochement. Même clé que cle_competence et que one-pager.
        low = sans_accents(canonical).lower()
        if low not in seen:
            seen[low] = canonical
    return list(seen.values())


def skills_to_flat(skills_structured: list[dict]) -> list[str]:
    """
    Aplatit la structure [{category, items}] en une liste de strings.
    Gère aussi les items contenant des virgules (ex: "Python, Pandas").
    """
    flat: list[str] = []
    for group in (skills_structured or []):
        for item in (group.get("items") or []):
            # Certains items sont encore des listes séparées par virgules
            for part in re.split(r"[,;/]", str(item)):
                part = part.strip()
                if part and len(part) > 1:
                    flat.append(part)
    return flat


def compute_skills_flat(cv: dict) -> list[str]:
    """
    Calcule skills_flat depuis le CV complet.
    Utilisé en rétrocompatibilité pour les CVs stockés avant l'ajout du champ.
    """
    raw = skills_to_flat(cv.get("skills") or [])
    return normalize_skills(raw)
