Socle partagé
=============

``document-parsing/`` est la source unique de tout ce que les applications
partagent autour de l'inférence. Il est copié dans chaque image au build ;
aucune application n'en garde de copie.

.. mermaid::

   flowchart LR
     cat["Catalogue<br/><small>modèles par tâche et par voie</small>"] -->|choisit| pont["Pont DocIE<br/><small>JS ↔ Python</small>"]
     cat -->|choisit| oai["Transport OpenAI<br/><small>JS ↔ Python</small>"]
     pont --> sch["Schémas dynamiques"]
     oai --> sch
     map["Mappings et contrôles<br/><small>SIREN/SIRET, IBAN/BIC, MRZ, dates</small>"] --- fix["Jeux d'essai partagés"]

Les jumeaux
-----------

Chaque composant du socle existe **en JavaScript et en Python**, avec des
sorties identiques octet pour octet. Des jeux d'essai communs
(``fixtures/``) sont exécutés par les deux suites de tests : une divergence
entre les deux langages casse la CI.

Pont DocIE
----------

``bridge/docie-bridge.js`` et ``bridge/docie_bridge.py``.

**Voie texte** --- ``POST /v1/extract/text``
   Le texte du document, un schéma dynamique et, si disponibles, des blocs
   paginés qui ancrent les preuves. Utilisée pour les DOCX et les PDF à
   couche texte.

**Voie agent** --- ``POST /v1/agents/{agent}/chat/completions``
   Le document lui-même (PDF, PNG, JPEG) en data URI ; l'agent l'OCRise ou le
   lit en vision. Utilisée pour les scans et les images.

**Découverte**
   Relevé du store (``/v1/serving/store``) et des agents (``/v1/agents``),
   gardé en cache cinq minutes ; en cas d'échec, le dernier relevé est
   conservé.

**Recherche et notation**
   Embeddings (``/v1/embeddings``) et reranker (``/v1/rerank``).

**Preuves et résultat partiel**
   Les confiances et les blocs sources de chaque champ sont extraits avant de
   simplifier le résultat ; les champs perdus ou tronqués sont signalés.

**Erreurs**
   Codes stables (``loading``, ``context``, ``timeout``, ``limits``,
   ``upstream``, ``network``, ``input``, ``configuration``, ``auth``,
   ``rate_limit``, ``response``, ``incomplete``, ``schema``) traduits par une
   table française unique. La clé d'accès est caviardée de toute réponse
   avant journalisation.

Limites locales
^^^^^^^^^^^^^^^

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Élément
     - Limite
   * - Document (voie agent)
     - environ 19,5 Mio, déduits du plafond de requête de DocIE
   * - Texte (voie texte)
     - 20 Mio et 1 000 000 caractères
   * - Blocs OCR
     - 1 000 blocs, 20 000 caractères par bloc
   * - Blocs lus par les profils génériques
     - 800 ; au-delà, la troncature est signalée
   * - Embeddings
     - 64 textes par lot, 8 000 caractères par texte
   * - Reranker
     - 500 documents

Catalogue des modèles
---------------------

``models/catalogue.json``, lu par ``catalogue.js`` et ``catalogue.py``.

Pour chaque **tâche** (CV, contrat, Kbis, URSSAF, attestation fiscale, RIB,
CNI, remplissage, rapprochement, copilote, traduction) et chaque **voie**
(texte, agent, chat), il déclare le modèle par défaut, l'alternative et les
modèles externes admis, avec leurs limites.

.. list-table::
   :header-rows: 1
   :widths: 30 40 30

   * - Libellé présenté
     - Description
     - Limite
   * - Modèle rapide
     - Bon équilibre entre vitesse et précision
     - 800 lignes non vides
   * - Modèle précis
     - Plus lent --- plusieurs minutes
     - 8 pages en vision
   * - Modèle très rapide
     - Documents simples uniquement
     - 800 lignes non vides
   * - Modèle externe (hors ADBI)
     - OpenAI, résultat assuré, quatre niveaux de raisonnement
     - texte seul

Les identifiants réels viennent de variables (``DOCIE_MODELE_*``,
``DOCIE_AGENT_*``) ou de la découverte du store et des agents. Un choix
explicite est vérifié sur le document réel ; s'il ne convient pas, l'erreur
est nommée --- jamais remplacée par un autre modèle.

Transport OpenAI
----------------

``bridge/openai-responses.js`` et ``bridge/openai_responses.py``.

- Un appel unique à ``/v1/responses``, sans relance.
- Modèle ``gpt-6-luna`` ; quatre modes : sans raisonnement, léger, moyen, poussé.
- ``store: false`` : rien n'est conservé chez le fournisseur.
- Sortie structurée stricte, dérivée du schéma dynamique.
- Vérification que le modèle servi est bien celui demandé.
- Même modèle d'erreur que le pont.

Schémas et contrôles
--------------------

Sept schémas dynamiques décrivent ce que l'extraction doit produire : CV,
contrat, Kbis, URSSAF, attestation fiscale, RIB, CNI. Les contrôles partagés
valident ce qui a été lu : clé de Luhn du SIREN/SIRET, IBAN (mod 97) et BIC,
chiffres de contrôle de la MRZ, plausibilité des dates.
