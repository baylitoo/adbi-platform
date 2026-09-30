CVthèque
========

La CVthèque (``cv-parser/``) importe et lit les CV, les rend recherchables,
les rapproche des besoins clients et produit le dossier de compétences au
format ADBI. Elle est aussi **l'émetteur de session** de toute la plateforme.

Caractéristiques
----------------

- Python 3.14, Flask, Gunicorn (un processus, quatre fils : les tâches vivent
  en mémoire de ce processus).
- Port interne 5000.
- Base PostgreSQL dédiée, dont pgvector ; fichiers déposés sur volume.

Fonctions
---------

**Import et lecture**
   Dépôt de PDF ou de DOCX, en lot. Extraction asynchrone avec suivi de
   progression, aiguillage par fichier (voir :doc:`../architecture/extraction`),
   normalisation (compétences canonisées, périodes de mission, niveaux de
   langue CECRL), revue des champs douteux, provenance champ par champ.

**Bibliothèque et fiche**
   Consultation, édition, ré-analyse avec un autre modèle, traduction en
   anglais, enrichissement et adaptation à une fiche de poste par
   l'assistant.

**Recherche**
   Classique (filtres : texte, technologies, lieu, expérience, séniorité) ou
   sémantique (vecteurs).

**Besoins et rapprochement**
   Un besoin client est noté contre la CVthèque sur six critères pondérés :

   .. list-table::
      :header-rows: 1
      :widths: 60 40

      * - Critère
        - Poids
      * - Compétences
        - 35
      * - Intitulé
        - 20
      * - Séniorité
        - 15
      * - Disponibilité
        - 10
      * - Missions
        - 10
      * - Bonus
        - 10

   L'intitulé et les missions sont notés par le reranker de la plateforme
   d'inférence s'il est prêt, sinon localement, ou par proximité vectorielle
   en mode sémantique. Pour une fiche de poste en texte libre, le besoin est
   d'abord extrait par l'IA, puis des avis qualitatifs de plusieurs modèles
   sont fusionnés par consensus.

**Exports**
   Dossier de compétences au format ADBI en PDF et en Word ; CV imprimable
   pour le client, anonymisable.

**Administration**
   Comptes, rôles, invitations (72 h, usage unique), journal d'activité,
   chaîne des modèles de chat.
