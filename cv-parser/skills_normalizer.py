"""
skills_normalizer.py — ADBI CV Parser
======================================
Normalisation des compétences techniques pour la recherche et le filtrage.

- ALIASES: table de correspondance variante → nom canonique
- normalize_one()   : normalise un skill isolé
- normalize_skills(): normalise une liste, élimine les doublons
- skills_to_flat()  : extrait la liste plate depuis la structure {category, items}
"""
from __future__ import annotations

import re
from typing import Iterable

# ---------------------------------------------------------------------------
# Table de correspondance  (clé = lowercase normalisé → valeur = nom affiché)
# ---------------------------------------------------------------------------
ALIASES: dict[str, str] = {

    # ── Python ──────────────────────────────────────────────────────────────
    "py": "Python", "python3": "Python", "python 3": "Python",
    "python2": "Python", "python 2": "Python",

    # ── JavaScript ──────────────────────────────────────────────────────────
    "js": "JavaScript", "javascript": "JavaScript",
    "ecmascript": "JavaScript", "es6": "JavaScript", "es2015": "JavaScript",

    # ── TypeScript ──────────────────────────────────────────────────────────
    "ts": "TypeScript", "typescript": "TypeScript",

    # ── Node.js ─────────────────────────────────────────────────────────────
    "node": "Node.js", "nodejs": "Node.js", "node.js": "Node.js",
    "node js": "Node.js",

    # ── React ───────────────────────────────────────────────────────────────
    "react": "React", "reactjs": "React", "react.js": "React",
    "react js": "React", "react native": "React Native",
    "reactnative": "React Native",

    # ── Angular ─────────────────────────────────────────────────────────────
    "angular": "Angular", "angularjs": "Angular",
    "angular.js": "Angular", "angular js": "Angular",

    # ── Vue ─────────────────────────────────────────────────────────────────
    "vue": "Vue.js", "vuejs": "Vue.js", "vue.js": "Vue.js",
    "vue js": "Vue.js", "nuxt": "Nuxt.js", "nuxtjs": "Nuxt.js",

    # ── C# / .NET ───────────────────────────────────────────────────────────
    "c#": "C#", "csharp": "C#", "c sharp": "C#",
    ".net": ".NET", "dotnet": ".NET", "asp.net": "ASP.NET",
    "blazor": "Blazor",

    # ── C / C++ ─────────────────────────────────────────────────────────────
    "c++": "C++", "cpp": "C++", "c/c++": "C/C++",

    # ── Go ──────────────────────────────────────────────────────────────────
    "go": "Go", "golang": "Go",

    # ── Rust ────────────────────────────────────────────────────────────────
    "rust": "Rust",

    # ── SQL ─────────────────────────────────────────────────────────────────
    "sql": "SQL", "t-sql": "T-SQL", "tsql": "T-SQL",
    "plsql": "PL/SQL", "pl/sql": "PL/SQL", "pl sql": "PL/SQL",
    "nosql": "NoSQL",

    # ── Databases relationnelles ─────────────────────────────────────────────
    "postgresql": "PostgreSQL", "postgres": "PostgreSQL", "psql": "PostgreSQL",
    "mysql": "MySQL",
    "mariadb": "MariaDB",
    "sqlite": "SQLite",
    "oracle": "Oracle DB", "oracle db": "Oracle DB",
    "oracle database": "Oracle DB",
    "mssql": "SQL Server", "sql server": "SQL Server",
    "sqlserver": "SQL Server", "microsoft sql server": "SQL Server",

    # ── Databases NoSQL ──────────────────────────────────────────────────────
    "mongodb": "MongoDB", "mongo": "MongoDB",
    "elasticsearch": "Elasticsearch", "elastic": "Elasticsearch",
    "redis": "Redis",
    "cassandra": "Cassandra", "apache cassandra": "Cassandra",
    "neo4j": "Neo4j",
    "hbase": "HBase",
    "dynamodb": "DynamoDB", "amazon dynamodb": "DynamoDB",
    "couchdb": "CouchDB",

    # ── Cloud — AWS ──────────────────────────────────────────────────────────
    "aws": "AWS", "amazon web services": "AWS", "amazon aws": "AWS",
    "aws lambda": "AWS Lambda",
    "s3": "AWS S3", "amazon s3": "AWS S3",
    "ec2": "AWS EC2", "amazon ec2": "AWS EC2",
    "emr": "AWS EMR",
    "redshift": "Redshift", "amazon redshift": "Redshift",
    "aws glue": "AWS Glue", "glue": "AWS Glue",
    "athena": "Amazon Athena", "amazon athena": "Amazon Athena",
    "sagemaker": "SageMaker", "amazon sagemaker": "SageMaker",
    "step functions": "AWS Step Functions",
    "kinesis": "AWS Kinesis",
    "ecs": "AWS ECS", "eks": "AWS EKS",

    # ── Cloud — GCP ──────────────────────────────────────────────────────────
    "gcp": "GCP", "google cloud": "GCP",
    "google cloud platform": "GCP",
    "bigquery": "BigQuery", "google bigquery": "BigQuery",
    "dataflow": "Google Dataflow", "google dataflow": "Google Dataflow",
    "pub/sub": "Pub/Sub", "pubsub": "Pub/Sub",
    "dataproc": "Dataproc", "google dataproc": "Dataproc",
    "cloud storage": "Google Cloud Storage",
    "looker": "Looker",

    # ── Cloud — Azure ────────────────────────────────────────────────────────
    "azure": "Azure", "microsoft azure": "Azure",
    "azure synapse": "Azure Synapse", "synapse": "Azure Synapse",
    "azure synapse analytics": "Azure Synapse",
    "azure devops": "Azure DevOps", "ado": "Azure DevOps",
    "azure data factory": "Azure Data Factory", "adf": "Azure Data Factory",
    "fabric": "Microsoft Fabric", "microsoft fabric": "Microsoft Fabric",
    "azure ml": "Azure ML", "azure machine learning": "Azure ML",
    "azure databricks": "Databricks",
    "azure blob": "Azure Blob Storage", "blob storage": "Azure Blob Storage",
    "azure functions": "Azure Functions",
    "azure event hub": "Azure Event Hub", "event hub": "Azure Event Hub",
    "azure stream analytics": "Azure Stream Analytics",
    "azure cosmos db": "Cosmos DB", "cosmos db": "Cosmos DB",
    "azure logic apps": "Azure Logic Apps",
    "azure aks": "Azure AKS",

    # ── BI / Dataviz ─────────────────────────────────────────────────────────
    "powerbi": "Power BI", "power bi": "Power BI",
    "ms bi": "Power BI", "pbi": "Power BI",
    "power bi desktop": "Power BI", "power bi service": "Power BI",
    "power bi report server": "Power BI",
    "tableau": "Tableau",
    "qlik": "QlikSense", "qlikview": "QlikView",
    "qliksense": "QlikSense", "qlik sense": "QlikSense",
    "qlik view": "QlikView",
    "metabase": "Metabase",
    "superset": "Apache Superset", "apache superset": "Apache Superset",
    "grafana": "Grafana",
    "kibana": "Kibana",
    "microstrategy": "MicroStrategy",
    "ssas": "SSAS", "ssrs": "SSRS", "ssis": "SSIS",

    # ── Big Data / Data Engineering ──────────────────────────────────────────
    "spark": "Apache Spark", "apache spark": "Apache Spark",
    "pyspark": "PySpark",
    "hadoop": "Hadoop", "apache hadoop": "Hadoop",
    "hive": "Hive", "apache hive": "Hive",
    "kafka": "Apache Kafka", "apache kafka": "Apache Kafka",
    "airflow": "Apache Airflow", "apache airflow": "Apache Airflow",
    "databricks": "Databricks",
    "snowflake": "Snowflake",
    "dbt": "dbt", "dbt core": "dbt",
    "talend": "Talend",
    "informatica": "Informatica",
    "nifi": "Apache NiFi", "apache nifi": "Apache NiFi",
    "flink": "Apache Flink", "apache flink": "Apache Flink",
    "delta lake": "Delta Lake", "delta": "Delta Lake",
    "lakehouse": "Lakehouse",
    "data lake": "Data Lake", "datalake": "Data Lake",
    "data warehouse": "Data Warehouse", "datawarehouse": "Data Warehouse",
    "data mesh": "Data Mesh",

    # ── ML / IA ───────────────────────────────────────────────────────────────
    "ml": "Machine Learning", "machine learning": "Machine Learning",
    "dl": "Deep Learning", "deep learning": "Deep Learning",
    "nlp": "NLP", "natural language processing": "NLP",
    "computer vision": "Computer Vision",
    "tensorflow": "TensorFlow", "tf": "TensorFlow",
    "pytorch": "PyTorch",
    "sklearn": "scikit-learn", "scikit learn": "scikit-learn",
    "scikit-learn": "scikit-learn",
    "keras": "Keras",
    "xgboost": "XGBoost",
    "lightgbm": "LightGBM",
    "huggingface": "Hugging Face", "hugging face": "Hugging Face",
    "langchain": "LangChain",
    "openai": "OpenAI", "gpt": "GPT", "chatgpt": "ChatGPT",
    "llm": "LLM", "large language model": "LLM",
    "mlflow": "MLflow",
    "generative ai": "GenAI", "gen ai": "GenAI", "genai": "GenAI",
    "rag": "RAG",

    # ── DevOps / Infrastructure ──────────────────────────────────────────────
    "docker": "Docker",
    "kubernetes": "Kubernetes", "k8s": "Kubernetes",
    "jenkins": "Jenkins",
    "ci/cd": "CI/CD", "cicd": "CI/CD",
    "gitlab-ci": "GitLab CI/CD", "gitlab ci": "GitLab CI/CD",
    "github actions": "GitHub Actions",
    "terraform": "Terraform",
    "ansible": "Ansible",
    "helm": "Helm",
    "linux": "Linux", "unix": "Unix",
    "bash": "Bash/Shell", "shell": "Bash/Shell",
    "shell scripting": "Bash/Shell", "bash scripting": "Bash/Shell",
    "prometheus": "Prometheus",
    "elk": "ELK Stack",
    "datadog": "Datadog",
    "openshift": "OpenShift",

    # ── Méthodologies ────────────────────────────────────────────────────────
    "agile": "Agile", "scrum": "Scrum", "kanban": "Kanban",
    "safe": "SAFe", "scaled agile": "SAFe",
    "devops": "DevOps",
    "itil": "ITIL", "itil v4": "ITIL",
    "waterfall": "Cycle en V", "cycle en v": "Cycle en V",
    "lean": "Lean",

    # ── Versioning ───────────────────────────────────────────────────────────
    "git": "Git",
    "github": "GitHub",
    "gitlab": "GitLab",
    "bitbucket": "Bitbucket",
    "svn": "SVN",

    # ── API / Architecture ───────────────────────────────────────────────────
    "rest": "REST API", "restful": "REST API", "rest api": "REST API",
    "graphql": "GraphQL",
    "microservices": "Microservices",
    "soap": "SOAP",
    "grpc": "gRPC",
    "api": "API",

    # ── Python libs ──────────────────────────────────────────────────────────
    "pandas": "Pandas",
    "numpy": "NumPy",
    "fastapi": "FastAPI",
    "flask": "Flask",
    "django": "Django",
    "matplotlib": "Matplotlib",
    "seaborn": "Seaborn",
    "plotly": "Plotly",
    "celery": "Celery",
    "sqlalchemy": "SQLAlchemy",
    "pydantic": "Pydantic",

    # ── Java / JVM ───────────────────────────────────────────────────────────
    "spring": "Spring", "spring boot": "Spring Boot",
    "spring framework": "Spring",
    "scala": "Scala", "kotlin": "Kotlin",
    "jvm": "JVM",
    "maven": "Maven", "gradle": "Gradle",

    # ── PHP ──────────────────────────────────────────────────────────────────
    "php": "PHP",
    "symfony": "Symfony",
    "laravel": "Laravel",

    # ── Message Brokers ──────────────────────────────────────────────────────
    "rabbitmq": "RabbitMQ",
    "activemq": "ActiveMQ",
    "nats": "NATS",
}

# ---------------------------------------------------------------------------
# Fonctions publiques
# ---------------------------------------------------------------------------

def _key(raw: str) -> str:
    """Normalise la clé de lookup (lowercase, espaces réduits)."""
    return re.sub(r"\s+", " ", raw.strip().lower())


def normalize_one(raw: str) -> str:
    """Retourne le nom canonique d'un skill (alias résolu ou original préservé)."""
    if not raw or not raw.strip():
        return ""
    return ALIASES.get(_key(raw), raw.strip())


def normalize_skills(raw_skills: Iterable[str]) -> list[str]:
    """
    Normalise une liste de skills bruts.
    - Résout les alias
    - Supprime les doublons (insensible à la casse)
    - Préserve l'ordre de première apparition
    """
    seen: dict[str, str] = {}   # lowercase → premier canonique rencontré
    for raw in raw_skills:
        if not raw or not raw.strip():
            continue
        canonical = normalize_one(raw)
        low = canonical.lower()
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
