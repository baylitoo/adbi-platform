Dossier salarié
===============

Le Dossier salarié (``dossier-salarie/``) rassemble les pièces d'un nouvel
embauché, contrôle leur complétude et pré-remplit la fiche d'entrée reprenant
les champs de la DPAE.

Caractéristiques
----------------

- Node 22, Express, port interne 4600.
- PostgreSQL partagé : base créée par ``POSTGRES_DB``, tables préfixées
  ``dsal_`` (``dsal_dossiers``, ``dsal_pieces``).
- Fichiers déposés sur un volume nommé (``dossier-salarie-data``), jamais dans
  les journaux.
- Contrôle d'accès identique à Contrats ; ``/api/sante`` reste public. Chaque
  dossier garde l'identifiant et l'adresse de son créateur, lus dans le jeton
  vérifié.
- Réutilise ``contrats/lib`` sans le modifier : l'image le copie dans
  ``/contrats/lib``.

Parcours
--------

1. Créer un dossier : nom, prénoms, date d'embauche, type de contrat.
2. Choisir les pièces attendues. Par défaut : pièce d'identité (CNI ou
   passeport), RIB, carte Vitale, justificatif de domicile, diplôme(s).
3. Déposer les pièces. Chaque fichier est classé, puis lu en tâche de fond ;
   la position dans la file s'affiche pendant l'attente.
4. Suivre la complétude, corriger les valeurs lues, compléter la fiche
   d'entrée, l'exporter en CSV ou l'imprimer.
5. Masquer une pièce : le bouton « Protéger dans Coffre » ouvre le Coffre dans
   le hub, où l'on dépose la pièce téléchargée.

Classement et lecture
---------------------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Étape
     - Règle
   * - Classement
     - Indices locaux d'abord (MRZ, IBAN valide, mots-clés, nom du fichier),
       puis schéma DocIE ``adbi_type_piece`` à un champ, validé contre la
       liste des types ; sinon la pièce attend un choix manuel.
   * - PDF à couche texte
     - Voie texte, schéma envoyé dans la requête
       (``document-parsing/schemas/<type>.schema.json``).
   * - Photo ou scan
     - Voie agent (vision), schéma enregistré dans le Studio DocIE et résolu
       par nom : ``cni``, ``rib``, ``adbi_carte_vitale``,
       ``adbi_justificatif_domicile``, ``adbi_diplome``.
   * - Modèle
     - Provisoire : tâche du catalogue, puis variables d'environnement. Aucun
       modèle externe pour ces pièces.

Contrôles
---------

- Pièce d'identité expirée.
- Justificatif de domicile de plus de trois mois.
- IBAN dont la clé (modulo 97) est fausse.
- NIR dont la clé est fausse : 97 − (n mod 97) sur les 13 premiers caractères,
  2A et 2B remplacés par 19 et 18.
- Nom différent d'une pièce à l'autre, sans tenir compte des accents ni de la
  casse.

Suppression
-----------

Supprimer un dossier supprime ses lignes et ses fichiers.

Configuration
-------------

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Variable
     - Rôle
   * - ``ADBI_DOSSIERSALARIE_URL``
     - URL publique du module, exigée par le hub
   * - ``DOSSIERSALARIE_DOCIE_EXTRACTION_ENABLED``
     - active la lecture par DocIE (``false`` par défaut)
   * - ``DOCIE_AGENT_CNI``, ``DOCIE_AGENT_RIB``, ``DOCIE_AGENT_CARTE_VITALE``,
       ``DOCIE_AGENT_JUSTIFICATIF_DOMICILE``, ``DOCIE_AGENT_DIPLOME``
     - agents de la voie vision
   * - ``DOCIE_AGENT_TYPE_PIECE``
     - agent de classement des photos (facultatif)
   * - ``DOSSIERSALARIE_EXTRACTION_MAX_CONCURRENT``
     - lectures simultanées, 1 par défaut (slot DocIE partagé avec Contrats)
