"use strict";

/**
 * taxonomy.js
 *
 * Referentiel de normalisation des technologies et competences pour le parseur
 * de CV (secteur ESN / IT francais). Module de donnees pures : aucune
 * dependance externe, aucun effet de bord.
 *
 * Il fournit :
 *   - CATEGORIES    : les categories canoniques, dans l'ordre d'affichage du CV one-page
 *   - TECHNOLOGIES  : le dictionnaire { forme canonique : { cat, aliases, weight } }
 *   - lookup()      : resolution d'un terme isole vers sa forme canonique
 *   - detect()      : extraction des technologies presentes dans un texte libre
 *   - categorize()  : regroupement d'une liste de competences par categorie
 *   - canonical()   : forme d'affichage d'un terme (jamais null)
 *
 * Le champ weight (1 a 5) exprime l'attractivite commerciale du skill :
 * 5 = rare et vendeur, 1 = banal. Il sert au tri des competences mises en avant.
 */

// ---------------------------------------------------------------------------
// Categories canoniques (l'ordre des cles = ordre d'affichage)
// ---------------------------------------------------------------------------

const CATEGORIES = {
  langages:       "Langages de programmation",
  frontend:       "Frameworks & Front-end",
  backend:        "Back-end & API",
  data:           "Data & BI",
  bases:          "Bases de données",
  cloud:          "Cloud & Conteneurisation",
  devops:         "DevOps & CI/CD",
  etl:            "ETL & Intégration",
  securite:       "Sécurité & Conformité",
  erp:            "ERP & Progiciels",
  sante:          "Santé & Interopérabilité",
  methodo:        "Méthodologies & Gestion de projet",
  outils:         "Outils & Collaboration",
  os:             "Environnements & OS",
};

// ---------------------------------------------------------------------------
// Dictionnaire des technologies
// Les alias sont en minuscules, sans accent ; ils reprennent les formes
// reellement rencontrees dans les CV francais.
// ---------------------------------------------------------------------------

const TECHNOLOGIES = {
  // --- Langages -----------------------------------------------------------
  "JavaScript":       { cat: "langages", aliases: ["js", "javascript", "java script", "ecmascript", "es6", "es2015", "vanilla js"], weight: 2 },
  "TypeScript":       { cat: "langages", aliases: ["ts", "typescript", "type script"], weight: 3 },
  "Java":             { cat: "langages", aliases: ["java", "java 8", "java 11", "java 17", "java 21", "j2ee", "jee", "java ee", "jakarta ee", "jdk"], weight: 3 },
  "Python":           { cat: "langages", aliases: ["python", "python 3", "python3", "py"], weight: 4 },
  "C#":               { cat: "langages", aliases: ["c#", "csharp", "c sharp"], weight: 3 },
  "C++":              { cat: "langages", aliases: ["c++", "cpp", "c plus plus"], weight: 3 },
  "C":                { cat: "langages", aliases: ["c", "langage c", "ansi c"], weight: 2 },
  "Go":               { cat: "langages", aliases: ["go", "golang", "langage go"], weight: 4 },
  "Rust":             { cat: "langages", aliases: ["rust", "langage rust"], weight: 5 },
  "PHP":              { cat: "langages", aliases: ["php", "php 7", "php 8", "php7", "php8"], weight: 2 },
  "Ruby":             { cat: "langages", aliases: ["ruby"], weight: 3 },
  "Swift":            { cat: "langages", aliases: ["swift", "swiftui"], weight: 4 },
  "Kotlin":           { cat: "langages", aliases: ["kotlin"], weight: 4 },
  "Scala":            { cat: "langages", aliases: ["scala"], weight: 4 },
  "R":                { cat: "langages", aliases: ["r", "langage r", "r studio", "rstudio"], weight: 3 },
  "SQL":              { cat: "langages", aliases: ["sql", "langage sql", "requetes sql"], weight: 2 },
  "PL/SQL":           { cat: "langages", aliases: ["pl/sql", "plsql", "pl sql"], weight: 3 },
  "T-SQL":            { cat: "langages", aliases: ["t-sql", "tsql", "transact-sql", "transact sql"], weight: 3 },
  "Shell/Bash":       { cat: "langages", aliases: ["bash", "shell", "shell script", "scripting shell", "ksh", "sh unix", "script bash"], weight: 2 },
  "PowerShell":       { cat: "langages", aliases: ["powershell", "power shell", "ps1"], weight: 3 },
  "VBA":              { cat: "langages", aliases: ["vba", "visual basic for applications", "macro vba", "macros vba"], weight: 2 },
  "COBOL":            { cat: "langages", aliases: ["cobol"], weight: 3 },
  "ABAP":             { cat: "langages", aliases: ["abap", "abap oo", "abap objet"], weight: 4 },
  "Perl":             { cat: "langages", aliases: ["perl"], weight: 2 },
  "Groovy":           { cat: "langages", aliases: ["groovy"], weight: 3 },
  "Dart":             { cat: "langages", aliases: ["dart"], weight: 3 },
  "SAS":              { cat: "langages", aliases: ["sas", "sas base", "sas eg", "sas enterprise guide"], weight: 3 },

  // --- Front-end ----------------------------------------------------------
  "React":            { cat: "frontend", aliases: ["react", "react.js", "reactjs", "react js", "react 18"], weight: 4 },
  "Angular":          { cat: "frontend", aliases: ["angular", "angular 2+", "angular 2", "angular 8", "angular 12", "angular 14", "angular 15", "angular 16", "angular 17"], weight: 4 },
  "AngularJS":        { cat: "frontend", aliases: ["angularjs", "angular.js", "angular 1", "angular js"], weight: 2 },
  "Vue.js":           { cat: "frontend", aliases: ["vue.js", "vuejs", "vue js", "vue 2", "vue 3", "vue3"], weight: 4 },
  "Next.js":          { cat: "frontend", aliases: ["next.js", "nextjs", "next js"], weight: 4 },
  "Svelte":           { cat: "frontend", aliases: ["svelte", "sveltekit"], weight: 4 },
  "React Native":     { cat: "frontend", aliases: ["react native", "react-native"], weight: 4 },
  "Flutter":          { cat: "frontend", aliases: ["flutter"], weight: 4 },
  "jQuery":           { cat: "frontend", aliases: ["jquery", "jquery ui"], weight: 1 },
  "Bootstrap":        { cat: "frontend", aliases: ["bootstrap", "bootstrap 5"], weight: 1 },
  "Tailwind CSS":     { cat: "frontend", aliases: ["tailwind", "tailwind css", "tailwindcss"], weight: 3 },
  "HTML5":            { cat: "frontend", aliases: ["html5", "html 5", "html"], weight: 1 },
  "CSS3":             { cat: "frontend", aliases: ["css3", "css 3", "css"], weight: 1 },
  "SASS":             { cat: "frontend", aliases: ["sass", "scss"], weight: 2 },
  "Webpack":          { cat: "frontend", aliases: ["webpack"], weight: 2 },
  "Redux":            { cat: "frontend", aliases: ["redux", "redux toolkit", "ngrx"], weight: 3 },

  // --- Back-end & API -----------------------------------------------------
  "Node.js":          { cat: "backend", aliases: ["node.js", "nodejs", "node js", "node", "node 18", "node 20"], weight: 4 },
  "Express":          { cat: "backend", aliases: ["express", "express.js", "expressjs"], weight: 3 },
  "NestJS":           { cat: "backend", aliases: ["nestjs", "nest.js", "nest js"], weight: 4 },
  "Spring Boot":      { cat: "backend", aliases: ["spring boot", "springboot", "spring-boot"], weight: 4 },
  "Spring":           { cat: "backend", aliases: ["spring", "spring framework", "spring mvc", "spring batch", "spring security", "spring cloud"], weight: 3 },
  "Hibernate":        { cat: "backend", aliases: ["hibernate", "jpa", "hibernate orm"], weight: 3 },
  ".NET":             { cat: "backend", aliases: [".net", "dotnet", "dot net", ".net core", "net core", ".net 6", ".net 8", ".net framework", "asp.net", "asp .net", "aspnet", "asp.net core", "asp.net mvc"], weight: 3 },
  "Django":           { cat: "backend", aliases: ["django", "django rest framework", "drf"], weight: 4 },
  "Flask":            { cat: "backend", aliases: ["flask"], weight: 3 },
  "FastAPI":          { cat: "backend", aliases: ["fastapi", "fast api"], weight: 4 },
  "Laravel":          { cat: "backend", aliases: ["laravel"], weight: 3 },
  "Symfony":          { cat: "backend", aliases: ["symfony", "symfony 6"], weight: 3 },
  "Quarkus":          { cat: "backend", aliases: ["quarkus"], weight: 5 },
  "REST API":         { cat: "backend", aliases: ["rest api", "api rest", "apis rest", "restful", "rest", "services rest", "web services rest"], weight: 2 },
  "GraphQL":          { cat: "backend", aliases: ["graphql", "graph ql", "apollo graphql"], weight: 4 },
  "gRPC":             { cat: "backend", aliases: ["grpc", "g-rpc"], weight: 4 },
  "SOAP":             { cat: "backend", aliases: ["soap", "web services soap", "wsdl"], weight: 2 },
  "Swagger/OpenAPI":  { cat: "backend", aliases: ["swagger", "openapi", "open api", "swagger ui", "specification openapi"], weight: 3 },
  "Microservices":    { cat: "backend", aliases: ["microservices", "micro-services", "micro services", "architecture microservices"], weight: 4 },
  "API Management":   { cat: "backend", aliases: ["api management", "apim", "gestion des api", "plateforme api"], weight: 4 },
  "Gravitee":         { cat: "backend", aliases: ["gravitee", "gravitee.io", "graviteeio"], weight: 5 },
  "Apigee":           { cat: "backend", aliases: ["apigee", "google apigee"], weight: 5 },
  "Kong":             { cat: "backend", aliases: ["kong", "kong gateway"], weight: 4 },
  "Axway":            { cat: "backend", aliases: ["axway", "axway api gateway", "amplify axway"], weight: 4 },
  "MuleSoft":         { cat: "backend", aliases: ["mulesoft", "mule esb", "anypoint", "anypoint platform"], weight: 5 },
  "WSO2":             { cat: "backend", aliases: ["wso2", "wso2 esb"], weight: 4 },
  "Kafka":            { cat: "backend", aliases: ["kafka", "apache kafka", "confluent kafka", "kafka connect", "kafka streams"], weight: 5 },
  "RabbitMQ":         { cat: "backend", aliases: ["rabbitmq", "rabbit mq"], weight: 4 },
  "ActiveMQ":         { cat: "backend", aliases: ["activemq", "active mq", "artemis"], weight: 3 },

  // --- Data & BI ----------------------------------------------------------
  "Power BI":         { cat: "data", aliases: ["power bi", "powerbi", "pbi", "power-bi", "ms power bi", "microsoft power bi", "power bi desktop", "power bi service", "power bi report server"], weight: 4 },
  "Tableau":          { cat: "data", aliases: ["tableau", "tableau software", "tableau desktop", "tableau server"], weight: 4 },
  "Qlik":             { cat: "data", aliases: ["qlik", "qliktech"], weight: 3 },
  "QlikView":         { cat: "data", aliases: ["qlikview", "qlik view"], weight: 3 },
  "Qlik Sense":       { cat: "data", aliases: ["qlik sense", "qliksense"], weight: 4 },
  "Looker":           { cat: "data", aliases: ["looker", "looker studio", "google data studio", "data studio"], weight: 4 },
  "SSRS":             { cat: "data", aliases: ["ssrs", "sql server reporting services", "reporting services"], weight: 2 },
  "SSAS":             { cat: "data", aliases: ["ssas", "sql server analysis services", "analysis services", "cube ssas"], weight: 3 },
  "SAP BusinessObjects": { cat: "data", aliases: ["sap bo", "businessobjects", "business objects", "sap businessobjects", "webi", "web intelligence"], weight: 3 },
  "Snowflake":        { cat: "data", aliases: ["snowflake"], weight: 5 },
  "Databricks":       { cat: "data", aliases: ["databricks", "azure databricks", "delta lake", "unity catalog"], weight: 5 },
  "Spark":            { cat: "data", aliases: ["spark", "apache spark", "pyspark", "spark streaming", "spark sql"], weight: 5 },
  "Hadoop":           { cat: "data", aliases: ["hadoop", "ecosysteme hadoop", "map reduce", "mapreduce"], weight: 3 },
  "HDFS":             { cat: "data", aliases: ["hdfs"], weight: 3 },
  "Hive":             { cat: "data", aliases: ["hive", "apache hive", "hiveql"], weight: 3 },
  "Impala":           { cat: "data", aliases: ["impala"], weight: 3 },
  "Airflow":          { cat: "data", aliases: ["airflow", "apache airflow", "dags airflow"], weight: 5 },
  "dbt":              { cat: "data", aliases: ["dbt", "data build tool", "dbt core", "dbt cloud"], weight: 5 },
  "BigQuery":         { cat: "data", aliases: ["bigquery", "big query", "google bigquery"], weight: 4 },
  "Redshift":         { cat: "data", aliases: ["redshift", "amazon redshift", "aws redshift"], weight: 4 },
  "Azure Synapse":    { cat: "data", aliases: ["synapse", "azure synapse", "synapse analytics"], weight: 4 },
  "Machine Learning": { cat: "data", aliases: ["machine learning", "apprentissage automatique", "modeles predictifs", "modelisation predictive"], weight: 4 },
  "Deep Learning":    { cat: "data", aliases: ["deep learning", "apprentissage profond", "reseaux de neurones"], weight: 4 },
  "TensorFlow":       { cat: "data", aliases: ["tensorflow", "tensor flow", "keras"], weight: 4 },
  "PyTorch":          { cat: "data", aliases: ["pytorch", "py torch"], weight: 4 },
  "scikit-learn":     { cat: "data", aliases: ["scikit-learn", "scikit learn", "sklearn"], weight: 4 },
  "Pandas":           { cat: "data", aliases: ["pandas"], weight: 3 },
  "NumPy":            { cat: "data", aliases: ["numpy"], weight: 3 },
  "NLP":              { cat: "data", aliases: ["nlp", "traitement du langage naturel", "natural language processing"], weight: 5 },
  "MLOps":            { cat: "data", aliases: ["mlops", "ml ops", "mlflow"], weight: 5 },
  "LLM":              { cat: "data", aliases: ["llm", "llms", "large language model", "grands modeles de langage"], weight: 5 },
  "RAG":              { cat: "data", aliases: ["rag", "retrieval augmented generation", "retrieval-augmented generation"], weight: 5 },
  "IA générative":    { cat: "data", aliases: ["ia generative", "genai", "gen ai", "generative ai", "intelligence artificielle generative"], weight: 5 },
  "LangChain":        { cat: "data", aliases: ["langchain", "lang chain", "llamaindex"], weight: 5 },
  "Dataiku":          { cat: "data", aliases: ["dataiku", "dataiku dss"], weight: 4 },
  "DAX":              { cat: "data", aliases: ["dax", "langage dax", "mesures dax"], weight: 4 },
  "Power Query":      { cat: "data", aliases: ["power query", "powerquery", "langage m"], weight: 3 },

  // --- ETL & Intégration --------------------------------------------------
  "Talend":           { cat: "etl", aliases: ["talend", "talend open studio", "tos"], weight: 4 },
  "Talend DI":        { cat: "etl", aliases: ["talend di", "talend data integration", "talend studio di"], weight: 4 },
  "Talend ESB":       { cat: "etl", aliases: ["talend esb"], weight: 4 },
  "Talend Cloud":     { cat: "etl", aliases: ["talend cloud", "talend management console", "tmc"], weight: 5 },
  "Talend MDM":       { cat: "etl", aliases: ["talend mdm"], weight: 4 },
  "Informatica":      { cat: "etl", aliases: ["informatica", "informatica powercenter", "powercenter", "informatica idq", "iics"], weight: 4 },
  "SSIS":             { cat: "etl", aliases: ["ssis", "sql server integration services", "integration services"], weight: 3 },
  "DataStage":        { cat: "etl", aliases: ["datastage", "data stage", "ibm datastage"], weight: 3 },
  "Pentaho":          { cat: "etl", aliases: ["pentaho", "kettle", "pentaho di", "spoon pentaho"], weight: 3 },
  "Matillion":        { cat: "etl", aliases: ["matillion"], weight: 5 },
  "Fivetran":         { cat: "etl", aliases: ["fivetran"], weight: 5 },
  "Stambia":          { cat: "etl", aliases: ["stambia", "semarchy", "semarchy xdi", "semarchy xdm"], weight: 4 },
  "Oracle Data Integrator": { cat: "etl", aliases: ["odi", "oracle data integrator", "oracle odi"], weight: 4 },
  "Azure Data Factory": { cat: "etl", aliases: ["azure data factory", "data factory", "adf"], weight: 4 },
  "Apache NiFi":      { cat: "etl", aliases: ["nifi", "apache nifi"], weight: 4 },
  "Boomi":            { cat: "etl", aliases: ["boomi", "dell boomi"], weight: 4 },

  // --- Bases de données ---------------------------------------------------
  "Oracle":           { cat: "bases", aliases: ["oracle", "oracle db", "oracle database", "bdd oracle", "base de donnees oracle", "oracle 11g", "oracle 12c", "oracle 19c", "oracle rac"], weight: 3 },
  "SQL Server":       { cat: "bases", aliases: ["sql server", "sqlserver", "ms sql", "mssql", "microsoft sql server", "sql server 2019", "ssms"], weight: 3 },
  "PostgreSQL":       { cat: "bases", aliases: ["postgresql", "postgres", "postgre", "psql", "pgsql", "postgre sql"], weight: 4 },
  "MySQL":            { cat: "bases", aliases: ["mysql", "my sql"], weight: 2 },
  "MariaDB":          { cat: "bases", aliases: ["mariadb", "maria db"], weight: 2 },
  "MongoDB":          { cat: "bases", aliases: ["mongodb", "mongo", "mongo db", "mongo atlas"], weight: 4 },
  "Cassandra":        { cat: "bases", aliases: ["cassandra", "apache cassandra", "scylladb"], weight: 4 },
  "Redis":            { cat: "bases", aliases: ["redis"], weight: 4 },
  "Elasticsearch":    { cat: "bases", aliases: ["elasticsearch", "elastic search", "opensearch"], weight: 4 },
  "DB2":              { cat: "bases", aliases: ["db2", "ibm db2", "db2 400"], weight: 2 },
  "Sybase":           { cat: "bases", aliases: ["sybase", "sap ase"], weight: 2 },
  "Neo4j":            { cat: "bases", aliases: ["neo4j", "cypher", "base graphe", "base de donnees graphe"], weight: 5 },
  "DynamoDB":         { cat: "bases", aliases: ["dynamodb", "dynamo db"], weight: 4 },
  "Firebase":         { cat: "bases", aliases: ["firebase", "firestore"], weight: 3 },
  "Teradata":         { cat: "bases", aliases: ["teradata"], weight: 3 },
  "SAP HANA":         { cat: "bases", aliases: ["sap hana", "hana", "hana db", "hana studio"], weight: 4 },
  "Cosmos DB":        { cat: "bases", aliases: ["cosmos db", "cosmosdb", "azure cosmos db"], weight: 4 },
  "NoSQL":            { cat: "bases", aliases: ["nosql", "no sql", "bases nosql"], weight: 3 },

  // --- Cloud & Conteneurisation -------------------------------------------
  "AWS":              { cat: "cloud", aliases: ["aws", "amazon web services", "cloud aws"], weight: 4 },
  "Azure":            { cat: "cloud", aliases: ["azure", "microsoft azure", "cloud azure"], weight: 4 },
  "GCP":              { cat: "cloud", aliases: ["gcp", "google cloud", "google cloud platform"], weight: 4 },
  "OVHcloud":         { cat: "cloud", aliases: ["ovh", "ovhcloud", "ovh cloud"], weight: 2 },
  "Scaleway":         { cat: "cloud", aliases: ["scaleway", "online.net"], weight: 3 },
  "Docker":           { cat: "cloud", aliases: ["docker", "dockerfile", "docker compose", "docker-compose", "conteneurisation", "containerisation"], weight: 4 },
  "Kubernetes":       { cat: "cloud", aliases: ["kubernetes", "k8s", "kube", "aks", "eks", "gke", "kubectl"], weight: 5 },
  "OpenShift":        { cat: "cloud", aliases: ["openshift", "open shift", "red hat openshift"], weight: 5 },
  "Rancher":          { cat: "cloud", aliases: ["rancher"], weight: 4 },
  "Helm":             { cat: "cloud", aliases: ["helm", "helm charts"], weight: 4 },
  "Serverless":       { cat: "cloud", aliases: ["serverless", "sans serveur", "faas"], weight: 4 },
  "AWS Lambda":       { cat: "cloud", aliases: ["aws lambda", "lambda aws", "fonctions lambda"], weight: 4 },
  "Amazon S3":        { cat: "cloud", aliases: ["s3", "amazon s3", "aws s3", "bucket s3"], weight: 3 },
  "Terraform":        { cat: "cloud", aliases: ["terraform", "terraform cloud", "iac terraform"], weight: 5 },

  // --- DevOps & CI/CD -----------------------------------------------------
  "Ansible":          { cat: "devops", aliases: ["ansible", "ansible tower", "awx"], weight: 4 },
  "Puppet":           { cat: "devops", aliases: ["puppet"], weight: 3 },
  "Chef":             { cat: "devops", aliases: ["chef infra", "chef automate", "opscode chef"], weight: 3 },
  "Jenkins":          { cat: "devops", aliases: ["jenkins", "jenkinsfile", "jenkins pipeline"], weight: 3 },
  "GitLab CI":        { cat: "devops", aliases: ["gitlab ci", "gitlab-ci", "gitlab ci/cd", "gitlab runner", "pipelines gitlab"], weight: 4 },
  "GitHub Actions":   { cat: "devops", aliases: ["github actions", "github action", "workflows github"], weight: 4 },
  "Azure DevOps":     { cat: "devops", aliases: ["azure devops", "vsts", "tfs", "azure pipelines", "team foundation server", "ado pipelines"], weight: 4 },
  "ArgoCD":           { cat: "devops", aliases: ["argocd", "argo cd", "gitops argo"], weight: 5 },
  "HashiCorp Vault":  { cat: "devops", aliases: ["vault", "hashicorp vault"], weight: 4 },
  "Prometheus":       { cat: "devops", aliases: ["prometheus"], weight: 4 },
  "Grafana":          { cat: "devops", aliases: ["grafana", "dashboards grafana"], weight: 4 },
  "Datadog":          { cat: "devops", aliases: ["datadog", "data dog"], weight: 4 },
  "Splunk":           { cat: "devops", aliases: ["splunk"], weight: 4 },
  "ELK":              { cat: "devops", aliases: ["elk", "stack elk", "elk stack", "elastic stack"], weight: 4 },
  "Kibana":           { cat: "devops", aliases: ["kibana"], weight: 3 },
  "Dynatrace":        { cat: "devops", aliases: ["dynatrace"], weight: 4 },
  "Git":              { cat: "devops", aliases: ["git", "git flow", "gitflow", "versioning git"], weight: 2 },
  "GitLab":           { cat: "devops", aliases: ["gitlab", "git lab"], weight: 3 },
  "GitHub":           { cat: "devops", aliases: ["github", "git hub"], weight: 3 },
  "SVN":              { cat: "devops", aliases: ["svn", "subversion", "tortoise svn"], weight: 1 },
  "Nexus":            { cat: "devops", aliases: ["nexus", "nexus repository", "sonatype nexus"], weight: 3 },
  "SonarQube":        { cat: "devops", aliases: ["sonarqube", "sonar", "sonar qube", "sonarlint"], weight: 3 },
  "Maven":            { cat: "devops", aliases: ["maven", "apache maven", "mvn"], weight: 2 },
  "Gradle":           { cat: "devops", aliases: ["gradle"], weight: 3 },

  // --- Sécurité & Conformité ---------------------------------------------
  "RGPD":             { cat: "securite", aliases: ["rgpd", "gdpr", "reglement general sur la protection des donnees", "conformite rgpd"], weight: 4 },
  "PCI-DSS":          { cat: "securite", aliases: ["pci-dss", "pci dss", "pcidss"], weight: 5 },
  "DSP2":             { cat: "securite", aliases: ["dsp2", "dsp 2", "psd2", "directive dsp2"], weight: 5 },
  "ISO 27001":        { cat: "securite", aliases: ["iso 27001", "iso27001", "iso/iec 27001", "iso 27 001"], weight: 4 },
  "OAuth2":           { cat: "securite", aliases: ["oauth2", "oauth 2", "oauth", "oauth 2.0"], weight: 4 },
  "SAML":             { cat: "securite", aliases: ["saml", "saml 2.0", "saml v2"], weight: 4 },
  "SSO":              { cat: "securite", aliases: ["sso", "single sign on", "single sign-on", "authentification unique"], weight: 3 },
  "OpenID Connect":   { cat: "securite", aliases: ["openid connect", "oidc", "openid"], weight: 4 },
  "Keycloak":         { cat: "securite", aliases: ["keycloak", "red hat sso"], weight: 4 },
  "IAM":              { cat: "securite", aliases: ["iam", "identity and access management", "gestion des identites", "gestion des identites et des acces"], weight: 4 },
  "PKI":              { cat: "securite", aliases: ["pki", "infrastructure a cles publiques", "certificats x509"], weight: 4 },
  "KYC":              { cat: "securite", aliases: ["kyc", "know your customer", "connaissance client"], weight: 4 },
  "LCB-FT":           { cat: "securite", aliases: ["lcb-ft", "lcb ft", "lutte contre le blanchiment", "aml", "anti money laundering"], weight: 5 },
  "SOC 2":            { cat: "securite", aliases: ["soc 2", "soc2", "soc ii"], weight: 4 },
  "NIS2":             { cat: "securite", aliases: ["nis2", "nis 2", "directive nis2"], weight: 5 },
  "DORA":             { cat: "securite", aliases: ["dora", "reglement dora", "digital operational resilience act"], weight: 5 },
  "Pentest":          { cat: "securite", aliases: ["pentest", "pentesting", "test d'intrusion", "tests d'intrusion", "penetration testing"], weight: 5 },
  "SIEM":             { cat: "securite", aliases: ["siem", "soc siem", "qradar", "sentinel siem"], weight: 4 },
  "EBIOS RM":         { cat: "securite", aliases: ["ebios", "ebios rm", "analyse de risques ebios"], weight: 4 },
  "OWASP":            { cat: "securite", aliases: ["owasp", "owasp top 10"], weight: 4 },
  "Active Directory": { cat: "securite", aliases: ["active directory", "ad ds", "annuaire ad", "ldap"], weight: 2 },
  "Azure AD / Entra ID": { cat: "securite", aliases: ["azure ad", "azure active directory", "entra id", "microsoft entra"], weight: 4 },
  "CyberArk":         { cat: "securite", aliases: ["cyberark", "cyber ark"], weight: 4 },
  "Okta":             { cat: "securite", aliases: ["okta", "auth0"], weight: 4 },

  // --- ERP & Progiciels ---------------------------------------------------
  "SAP":              { cat: "erp", aliases: ["sap", "sap ecc", "sap r/3", "sap erp"], weight: 4 },
  "SAP S/4HANA":      { cat: "erp", aliases: ["sap s/4hana", "s/4hana", "s4hana", "s4 hana", "s/4 hana", "sap s4hana", "sap s/4"], weight: 5 },
  "SAP FI-CO":        { cat: "erp", aliases: ["sap fi-co", "sap fico", "fi-co", "fico", "sap fi/co", "module fi co"], weight: 4 },
  "SAP MM":           { cat: "erp", aliases: ["sap mm", "module mm", "sap materials management"], weight: 4 },
  "SAP SD":           { cat: "erp", aliases: ["sap sd", "module sd", "sap sales and distribution"], weight: 4 },
  "SAP BW":           { cat: "erp", aliases: ["sap bw", "sap bw/4hana", "bw/4hana", "sap bi/bw"], weight: 4 },
  "SAP SuccessFactors": { cat: "erp", aliases: ["successfactors", "sap successfactors"], weight: 4 },
  "SAP Ariba":        { cat: "erp", aliases: ["ariba", "sap ariba"], weight: 4 },
  "SAP PI/PO":        { cat: "erp", aliases: ["sap pi/po", "sap pi", "sap po", "sap netweaver", "sap cpi"], weight: 4 },
  "Salesforce":       { cat: "erp", aliases: ["salesforce", "sfdc", "salesforce crm", "sales cloud", "service cloud", "apex salesforce"], weight: 4 },
  "Dynamics 365":     { cat: "erp", aliases: ["dynamics 365", "d365", "microsoft dynamics", "dynamics crm", "dynamics nav", "dynamics ax", "business central"], weight: 4 },
  "ServiceNow":       { cat: "erp", aliases: ["servicenow", "service now", "itsm servicenow"], weight: 4 },
  "Sage":             { cat: "erp", aliases: ["sage", "sage x3", "sage 100", "sage 1000"], weight: 2 },
  "Cegid":            { cat: "erp", aliases: ["cegid", "cegid xrp", "cegid yourcegid"], weight: 3 },
  "Oracle EBS":       { cat: "erp", aliases: ["oracle ebs", "ebs", "e-business suite", "oracle e-business suite", "oracle fusion"], weight: 4 },
  "Workday":          { cat: "erp", aliases: ["workday"], weight: 4 },
  "SharePoint":       { cat: "erp", aliases: ["sharepoint", "share point", "sharepoint online"], weight: 2 },
  "Sitecore":         { cat: "erp", aliases: ["sitecore"], weight: 4 },
  "Adobe Experience Manager": { cat: "erp", aliases: ["aem", "adobe experience manager", "adobe aem"], weight: 4 },
  "JD Edwards":       { cat: "erp", aliases: ["jd edwards", "jde", "jdedwards"], weight: 3 },

  // --- Santé & Interopérabilité -------------------------------------------
  "FHIR":             { cat: "sante", aliases: ["fhir", "hl7 fhir", "fhir r4", "ressources fhir"], weight: 5 },
  "HAPI-FHIR":        { cat: "sante", aliases: ["hapi-fhir", "hapi fhir", "hapifhir", "serveur hapi"], weight: 5 },
  "HL7":              { cat: "sante", aliases: ["hl7", "hl7 v2", "hl7v2", "messages hl7"], weight: 5 },
  "DICOM":            { cat: "sante", aliases: ["dicom", "dicomweb", "images dicom"], weight: 5 },
  "SIH":              { cat: "sante", aliases: ["sih", "systeme d'information hospitalier", "systemes d'information hospitaliers"], weight: 4 },
  "DMP":              { cat: "sante", aliases: ["dmp", "dossier medical partage"], weight: 4 },
  "PMSI":             { cat: "sante", aliases: ["pmsi", "codage pmsi", "rss pmsi"], weight: 4 },
  "CIM-10":           { cat: "sante", aliases: ["cim-10", "cim 10", "cim10", "icd-10"], weight: 4 },
  "CCAM":             { cat: "sante", aliases: ["ccam", "nomenclature ccam", "ngap ccam"], weight: 4 },
  "ORBIS":            { cat: "sante", aliases: ["orbis", "dedalus orbis"], weight: 5 },
  "RIS":              { cat: "sante", aliases: ["ris", "radiology information system", "ris pacs"], weight: 4 },
  "PACS":             { cat: "sante", aliases: ["pacs", "archivage pacs"], weight: 4 },
  "Mon Espace Santé": { cat: "sante", aliases: ["mon espace sante", "monespacesante", "mon espace-sante"], weight: 5 },
  "INS":              { cat: "sante", aliases: ["ins", "identite nationale de sante", "teleservice ins"], weight: 5 },
  "Ségur":            { cat: "sante", aliases: ["segur", "segur du numerique", "segur numerique", "segur de la sante"], weight: 5 },
  "HDS":              { cat: "sante", aliases: ["hds", "hebergeur de donnees de sante", "hebergement de donnees de sante", "certification hds"], weight: 5 },
  "DPI":              { cat: "sante", aliases: ["dpi", "dossier patient informatise"], weight: 4 },
  "T2A":              { cat: "sante", aliases: ["t2a", "tarification a l'activite"], weight: 4 },
  "MSSanté":          { cat: "sante", aliases: ["mssante", "ms sante", "messagerie securisee de sante"], weight: 5 },
  "Pro Santé Connect": { cat: "sante", aliases: ["pro sante connect", "psc sante", "e-cps"], weight: 5 },
  "IHE":              { cat: "sante", aliases: ["ihe", "profils ihe", "ihe xds", "xds.b"], weight: 5 },
  "SNOMED CT":        { cat: "sante", aliases: ["snomed", "snomed ct"], weight: 5 },
  "LOINC":            { cat: "sante", aliases: ["loinc"], weight: 5 },
  "GHT":              { cat: "sante", aliases: ["ght", "groupement hospitalier de territoire"], weight: 4 },
  "Cerner":           { cat: "sante", aliases: ["cerner", "cerner millenium", "oracle health"], weight: 4 },

  // --- Méthodologies & Gestion de projet ----------------------------------
  "Agile":            { cat: "methodo", aliases: ["agile", "agilite", "methode agile", "methodes agiles", "mode agile"], weight: 3 },
  "Scrum":            { cat: "methodo", aliases: ["scrum", "sprints scrum", "ceremonies scrum"], weight: 3 },
  "SAFe":             { cat: "methodo", aliases: ["safe", "scaled agile framework", "safe 5", "safe 6", "agile a l'echelle"], weight: 5 },
  "Kanban":           { cat: "methodo", aliases: ["kanban", "tableau kanban"], weight: 2 },
  "Cycle en V":       { cat: "methodo", aliases: ["cycle en v", "cycle-v", "cycle v", "methode cycle en v", "modele en v"], weight: 2 },
  "ITIL":             { cat: "methodo", aliases: ["itil", "processus itil"], weight: 3 },
  "ITIL v4":          { cat: "methodo", aliases: ["itil v4", "itil 4", "itilv4", "certification itil v4"], weight: 4 },
  "DevOps":           { cat: "methodo", aliases: ["devops", "dev ops", "culture devops", "demarche devops"], weight: 4 },
  "Lean":             { cat: "methodo", aliases: ["lean", "lean management", "lean startup"], weight: 3 },
  "Six Sigma":        { cat: "methodo", aliases: ["six sigma", "6 sigma", "lean six sigma", "green belt"], weight: 4 },
  "PRINCE2":          { cat: "methodo", aliases: ["prince2", "prince 2"], weight: 4 },
  "PMP":              { cat: "methodo", aliases: ["pmp", "project management professional", "pmi pmp"], weight: 4 },
  "Design Thinking":  { cat: "methodo", aliases: ["design thinking", "atelier design thinking"], weight: 3 },
  "TDD":              { cat: "methodo", aliases: ["tdd", "test driven development", "test-driven development"], weight: 4 },
  "BDD":              { cat: "methodo", aliases: ["behavior driven development", "behaviour driven development", "specification par l'exemple"], weight: 4 },
  "UML":              { cat: "methodo", aliases: ["uml", "diagrammes uml", "modelisation uml"], weight: 2 },
  "Merise":           { cat: "methodo", aliases: ["merise", "mcd merise", "methode merise"], weight: 2 },
  "TOGAF":            { cat: "methodo", aliases: ["togaf", "togaf 9", "certification togaf"], weight: 5 },
  "ArchiMate":        { cat: "methodo", aliases: ["archimate", "archi mate"], weight: 5 },
  "BPMN":             { cat: "methodo", aliases: ["bpmn", "bpmn 2.0", "modelisation bpmn"], weight: 4 },
  "Domain Driven Design": { cat: "methodo", aliases: ["ddd", "domain driven design", "domain-driven design"], weight: 4 },
  "eXtreme Programming": { cat: "methodo", aliases: ["extreme programming", "pair programming", "programmation en binome"], weight: 3 },
  "AMOA":             { cat: "methodo", aliases: ["amoa", "assistance a maitrise d'ouvrage", "maitrise d'ouvrage", "moa"], weight: 3 },
  "Conduite du changement": { cat: "methodo", aliases: ["conduite du changement", "change management", "accompagnement au changement"], weight: 3 },

  // --- Outils & Collaboration ---------------------------------------------
  "Jira":             { cat: "outils", aliases: ["jira", "jira software", "jira align"], weight: 2 },
  "Confluence":       { cat: "outils", aliases: ["confluence", "atlassian confluence"], weight: 2 },
  "MS Project":       { cat: "outils", aliases: ["ms project", "microsoft project", "msproject"], weight: 2 },
  "Trello":           { cat: "outils", aliases: ["trello"], weight: 1 },
  "Notion":           { cat: "outils", aliases: ["notion", "notion.so"], weight: 2 },
  "Miro":             { cat: "outils", aliases: ["miro", "mural"], weight: 2 },
  "Slack":            { cat: "outils", aliases: ["slack"], weight: 1 },
  "Microsoft Teams":  { cat: "outils", aliases: ["teams", "ms teams", "microsoft teams"], weight: 1 },
  "Mantis":           { cat: "outils", aliases: ["mantis", "mantisbt", "mantis bt"], weight: 1 },
  "Redmine":          { cat: "outils", aliases: ["redmine"], weight: 1 },
  "Postman":          { cat: "outils", aliases: ["postman", "insomnia rest"], weight: 2 },
  "Figma":            { cat: "outils", aliases: ["figma"], weight: 3 },
  "Pack Office":      { cat: "outils", aliases: ["pack office", "ms office", "microsoft office", "office 365", "o365", "suite office"], weight: 1 },
  "Excel":            { cat: "outils", aliases: ["excel", "ms excel", "microsoft excel", "tableur excel"], weight: 1 },
  "Word":             { cat: "outils", aliases: ["word", "ms word", "microsoft word"], weight: 1 },
  "PowerPoint":       { cat: "outils", aliases: ["powerpoint", "power point", "ppt"], weight: 1 },
  "Visio":            { cat: "outils", aliases: ["ms visio", "microsoft visio", "visio pro"], weight: 1 },
  "HP ALM":           { cat: "outils", aliases: ["hp alm", "hp quality center", "quality center", "micro focus alm", "alm octane"], weight: 3 },
  "Squash TM":        { cat: "outils", aliases: ["squash tm", "squashtm", "squash ta"], weight: 3 },
  "Selenium":         { cat: "outils", aliases: ["selenium", "selenium webdriver", "selenium grid"], weight: 3 },
  "Cypress":          { cat: "outils", aliases: ["cypress", "cypress.io"], weight: 4 },
  "Playwright":       { cat: "outils", aliases: ["playwright"], weight: 4 },
  "JUnit":            { cat: "outils", aliases: ["junit", "junit 5", "testng", "mockito"], weight: 2 },
  "Cucumber":         { cat: "outils", aliases: ["cucumber", "gherkin", "specflow"], weight: 3 },
  "JMeter":           { cat: "outils", aliases: ["jmeter", "apache jmeter", "gatling", "loadrunner"], weight: 3 },

  // --- Environnements & OS ------------------------------------------------
  "Linux":            { cat: "os", aliases: ["linux", "environnement linux", "systeme linux"], weight: 2 },
  "Unix":             { cat: "os", aliases: ["unix", "systeme unix"], weight: 2 },
  "RedHat":           { cat: "os", aliases: ["redhat", "red hat", "rhel"], weight: 3 },
  "Ubuntu":           { cat: "os", aliases: ["ubuntu"], weight: 2 },
  "Debian":           { cat: "os", aliases: ["debian"], weight: 2 },
  "Windows":          { cat: "os", aliases: ["windows", "windows 10", "windows 11"], weight: 1 },
  "Windows Server":   { cat: "os", aliases: ["windows server", "windows serveur", "windows server 2019", "windows server 2022"], weight: 2 },
  "z/OS":             { cat: "os", aliases: ["z/os", "zos", "mainframe", "grand systeme"], weight: 3 },
  "AS/400":           { cat: "os", aliases: ["as/400", "as400", "iseries", "ibm i"], weight: 3 },
  "Android":          { cat: "os", aliases: ["android", "android studio"], weight: 3 },
  "iOS":              { cat: "os", aliases: ["ios", "xcode"], weight: 3 },
  "VMware":           { cat: "os", aliases: ["vmware", "vsphere", "esxi", "vcenter"], weight: 3 },
  "Citrix":           { cat: "os", aliases: ["citrix", "citrix xenapp", "citrix vdi"], weight: 3 },
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const DIACRITICS = /[\u0300-\u036f]/g;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** Minuscules, sans accents, separateurs et ponctuation de bordure unifies. */
function normalize(term) {
  if (term === null || term === undefined) return "";
  return String(term)
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.,;:!?]+/, "")
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

/** Variante « compacte » : sert de filet de securite (powerbi == power bi == power-bi). */
function compact(normalized) {
  return normalized.replace(/[\s.\-\/']/g, "");
}

// ---------------------------------------------------------------------------
// Index inverses, construits une seule fois au chargement du module
// ---------------------------------------------------------------------------

const INDEX = new Map();          // cle normalisee exacte -> entree
const COMPACT_INDEX = new Map();  // cle compactee        -> entree
const PATTERNS = [];              // motifs de detection, tries par longueur decroissante

(function buildIndexes() {
  const seen = new Set();

  for (const name of Object.keys(TECHNOLOGIES)) {
    const def = TECHNOLOGIES[name];
    const entry = { name: name, cat: def.cat, weight: def.weight };
    const keys = [name].concat(def.aliases || []);

    for (const key of keys) {
      const nk = normalize(key);
      if (!nk) continue;

      if (!INDEX.has(nk)) INDEX.set(nk, entry);

      const ck = compact(nk);
      if (ck.length >= 3 && !COMPACT_INDEX.has(ck)) COMPACT_INDEX.set(ck, entry);

      // Un meme libelle ne peut appartenir qu'a une seule techno : premier arrive, premier servi.
      if (!seen.has(nk)) {
        seen.add(nk);
        PATTERNS.push({ key: nk, entry: entry, re: buildPattern(nk) });
      }
    }
  }

  // Le plus long d'abord : « talend cloud » l'emporte sur « talend », « mysql » sur « sql ».
  PATTERNS.sort(function (a, b) {
    return b.key.length - a.key.length || a.key.localeCompare(b.key);
  });
})();

/**
 * Motif de detection avec frontieres de mot.
 * Les alias de 1 a 2 caracteres (r, c, go, js...) exigent des frontieres
 * strictement non alphanumeriques des deux cotes, sinon « R » matcherait dans
 * « Redaction » et « C » dans « C++ ».
 */
function buildPattern(nk) {
  const escaped = nk.replace(REGEX_SPECIALS, "\\$&");
  const short = nk.length <= 2;
  const alnum = "a-z0-9\\u00c0-\\u024f";
  const left = short ? "(?<![" + alnum + "_+#.])" : "(?<![" + alnum + "_])";

  let rightClass = short ? alnum + "_+#." : alnum + "_";
  if (!short && nk.charAt(nk.length - 1) === "+") rightClass += "+";
  if (!short && nk.charAt(nk.length - 1) === "#") rightClass += "#";

  return new RegExp(left + escaped + "(?![" + rightClass + "])", "g");
}

/**
 * Contextes qui invalident un match, meme si les frontieres sont bonnes.
 * Indispensable pour les termes homonymes de mots courants du francais
 * (« Go/No-Go », « tableau de bord », « notions de », « R&D »...).
 */
const CONTEXT_VETOS = {
  "go":      [/\bno\s*[-\/]?\s*go\b/, /\bgo\s*[-\/]\s*no\b/, /\bgo\s+no\s+go\b/],
  "r":       [/\br\s*&\s*d\b/, /\br\s+et\s+d\b/],
  "c":       [/\bc\s*\+\s*\+/, /\bc\s*#/],
  "notion":  [/\bnotions?\s+(?:de|des|d'|en|sur)\b/],
  "tableau": [/\btableau\s+(?:de|des|du|croise|croises|recapitulatif|comparatif|synthese|excel)\b/, /\btableaux\b/],
  "scrum":   [/\bscrum\s*master/],
  "sas":     [/\bsas\s+au\s+capital\b/],
  "word":    [/\bword\s*press\b/],
  // « Chef de projet », « chef d'équipe » : le mot francais, pas l'outil.
  "chef":    [/\bchefs?\s+(?:de|des|du|d['’]?)\b/, /\bchefs?\s+d\s/],
};

const VETO_WINDOW = 18;

function isVetoed(key, text, start, end) {
  const vetos = CONTEXT_VETOS[key];
  if (!vetos) return false;
  const window = text.slice(Math.max(0, start - VETO_WINDOW), Math.min(text.length, end + VETO_WINDOW));
  for (let i = 0; i < vetos.length; i++) {
    if (vetos[i].test(window)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/** Resout un terme isole vers { name, cat, weight }, ou null si inconnu. */
function lookup(term) {
  const nk = normalize(term);
  if (!nk) return null;

  let entry = INDEX.get(nk);
  if (!entry) {
    const ck = compact(nk);
    if (ck.length >= 3) entry = COMPACT_INDEX.get(ck);
  }
  if (!entry) return null;

  return { name: entry.name, cat: entry.cat, weight: entry.weight };
}

/**
 * Detecte les technologies citees dans un texte libre.
 * Les zones deja consommees par un motif plus long sont neutralisees :
 * « Talend Cloud » ne produit donc pas aussi « Talend ».
 * Tri : weight decroissant, puis occurrences decroissantes.
 */
function detect(text) {
  if (!text) return [];

  const norm = normalize(text);
  if (!norm) return [];

  const taken = new Uint8Array(norm.length);
  const found = new Map();

  for (let p = 0; p < PATTERNS.length; p++) {
    const pattern = PATTERNS[p];
    const re = pattern.re;
    re.lastIndex = 0;

    let match;
    while ((match = re.exec(norm)) !== null) {
      if (match[0].length === 0) { re.lastIndex++; continue; }

      const start = match.index;
      const end = start + match[0].length;

      let overlap = false;
      for (let i = start; i < end; i++) {
        if (taken[i]) { overlap = true; break; }
      }
      if (overlap) continue;
      if (isVetoed(pattern.key, norm, start, end)) continue;

      for (let i = start; i < end; i++) taken[i] = 1;

      const hit = found.get(pattern.entry.name);
      if (hit) {
        hit.occurrences++;
      } else {
        found.set(pattern.entry.name, {
          name: pattern.entry.name,
          cat: pattern.entry.cat,
          weight: pattern.entry.weight,
          occurrences: 1,
        });
      }
    }
  }

  return Array.from(found.values()).sort(function (a, b) {
    return b.weight - a.weight || b.occurrences - a.occurrences || a.name.localeCompare(b.name);
  });
}

/**
 * Regroupe des noms de competences par categorie, dans l'ordre de CATEGORIES.
 * Les categories vides sont omises ; les termes inconnus terminent dans
 * « Autres compétences ».
 */
function categorize(names) {
  const list = Array.isArray(names) ? names : (names ? [names] : []);
  const buckets = new Map();
  const autres = [];
  const autresSeen = new Set();

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (raw === null || raw === undefined) continue;

    const hit = lookup(raw);
    if (hit) {
      if (!buckets.has(hit.cat)) buckets.set(hit.cat, []);
      const bucket = buckets.get(hit.cat);
      if (bucket.indexOf(hit.name) === -1) bucket.push(hit.name);
    } else {
      const cleaned = String(raw).replace(/\s+/g, " ").trim();
      const key = cleaned.toLowerCase();
      if (cleaned && !autresSeen.has(key)) {
        autresSeen.add(key);
        autres.push(cleaned);
      }
    }
  }

  const out = [];
  const keys = Object.keys(CATEGORIES);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const items = buckets.get(key);
    if (items && items.length) out.push({ key: key, label: CATEGORIES[key], items: items });
  }
  if (autres.length) out.push({ key: "autres", label: "Autres compétences", items: autres });

  return out;
}

/** Forme d'affichage d'un terme : sa forme canonique, sinon le terme nettoye. */
function canonical(term) {
  const hit = lookup(term);
  if (hit) return hit.name;
  return term === null || term === undefined ? "" : String(term).replace(/\s+/g, " ").trim();
}

module.exports = { CATEGORIES, TECHNOLOGIES, lookup, detect, categorize, canonical };
