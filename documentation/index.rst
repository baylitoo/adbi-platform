Plateforme ADBI
===============

La plateforme ADBI outille les métiers d'une entreprise de services
numériques : lire et rapprocher des CV, produire des dossiers de compétences,
générer et faire signer des contrats, protéger des documents.

Un **hub** ouvre quatre services qui partagent une seule identité, un seul
pont vers la plateforme d'inférence interne, un seul catalogue de modèles et
une seule charte graphique.

.. raw:: html

   <div class="adbi-cartes">
     <div class="adbi-carte"><strong>CVthèque</strong>Import et lecture de CV, recherche classique et sémantique, rapprochement avec un besoin, dossier de compétences.</div>
     <div class="adbi-carte"><strong>Contrats</strong>Génération, contrôle des pièces du sous-traitant, pré-remplissage depuis un PDF, signature électronique.</div>
     <div class="adbi-carte"><strong>One-pager</strong>Dossier d'une page en PowerPoint, livret multi-profils, classement d'un vivier contre une offre.</div>
     <div class="adbi-carte"><strong>Coffre</strong>Chiffrement, protection et anonymisation de documents, registre de références.</div>
   </div>

.. mermaid::

   flowchart LR
     nav["Navigateur<br/><small>aucun secret</small>"] --> hub["Hub"]
     hub --> cv["CVthèque"] & ct["Contrats"] & op["One-pager"] & cf["Coffre"]
     cv & ct & op & cf --> socle["Socle partagé<br/><small>pont, catalogue, identité</small>"]
     socle --> docie["Inférence interne<br/>(DocIE)"]
     socle -. "choix explicite, hors ADBI" .-> oai["OpenAI"]
     cv & ct & op --> pg[("PostgreSQL + pgvector")]

Par où commencer
----------------

- Vous découvrez la plateforme : :doc:`architecture/vue-ensemble`.
- Vous installez un poste de développement : :doc:`exploitation/demarrer`.
- Vous déployez : :doc:`exploitation/deploiement` puis :doc:`exploitation/configuration`.
- Vous contribuez : :doc:`contribuer`.

.. toctree::
   :caption: Architecture
   :maxdepth: 2
   :hidden:

   architecture/vue-ensemble
   architecture/identite
   architecture/socle
   architecture/extraction
   architecture/donnees

.. toctree::
   :caption: Modules
   :maxdepth: 2
   :hidden:

   modules/hub
   modules/cvtheque
   modules/contrats
   modules/one-pager
   modules/coffre

.. toctree::
   :caption: Exploitation
   :maxdepth: 2
   :hidden:

   exploitation/demarrer
   exploitation/deploiement
   exploitation/configuration
   exploitation/securite
   exploitation/tests

.. toctree::
   :caption: Référence
   :maxdepth: 2
   :hidden:

   contribuer
   decisions
   evolutions
   glossaire
