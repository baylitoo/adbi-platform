Risques et évolutions
=====================

Registre des risques
--------------------

.. list-table::
   :header-rows: 1
   :widths: 30 10 60

   * - Risque
     - Niveau
     - Traitement
   * - Identifiants par défaut laissés en place
     - Élevé
     - Procédure de déploiement : remplacement obligatoire avant ouverture
   * - Perte de la clé du coffre
     - Élevé
     - Sauvegarde du volume du coffre
   * - Tâches perdues au redémarrage
     - Moyen
     - Accepté ; l'utilisateur relance l'import
   * - Variables requises absentes de ``.env.example`` (URL publiques, chat)
     - Moyen
     - Compléter le modèle de configuration
   * - Plafonds de la plateforme d'inférence figés côté client
     - Moyen
     - Les lire depuis la plateforme quand elle les exposera
   * - Reconnaissance de caractères en anglais par défaut
     - Moyen
     - Transmettre la langue du document
   * - Processus Gunicorn unique pour la CVthèque
     - Faible
     - Suffisant au volume actuel ; à revoir avec la charge
   * - Pas d'index vectoriel approché
     - Faible
     - Ajouter un index quand le nombre de profils le justifie
   * - Journaux non structurés
     - Faible
     - Format structuré et corrélation des requêtes

Feuille de route
----------------

- Domaine et HTTPS de bout en bout pour la mise en production.
- File de tâches persistante, pour survivre aux redémarrages.
- Journaux structurés et indicateurs de service.
- Plafonds et langue de lecture négociés avec la plateforme d'inférence.
