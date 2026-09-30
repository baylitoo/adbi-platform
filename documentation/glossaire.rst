Glossaire
=========

.. glossary::
   :sorted:

   Hub
      Page d'accueil de la plateforme (service ``factory``) : liste des
      modules, état des services, préférences.

   CVthèque
      Module de gestion des CV (service ``cv-parser``) ; émet aussi les
      sessions de toute la plateforme.

   Coffre
      Module de protection chiffrée et d'anonymisation des documents.

   One-pager
      Module de fiche de présentation d'un consultant sur une page.

   Socle
      Code partagé de ``document-parsing/`` : pont, transport externe,
      catalogue, schémas, contrôles.

   Jumeaux
      Paires de modules JavaScript et Python au comportement identique,
      vérifié par des jeux d'essai communs.

   Pont
      Client unique de la plateforme d'inférence interne.

   Plateforme d'inférence interne
      Service ADBI qui héberge les modèles de lecture et d'extraction.

   Store
      Registre des modèles prêts, publié par la plateforme d'inférence.

   Voie
      Chemin d'extraction : *texte* (texte déjà lu), *agent* (image ou scan),
      *chat* (conversation).

   Modèle externe
      Modèle hébergé hors ADBI, proposé en dernier et seulement si une clé est
      configurée.

   Preuve
      Passage du document d'où provient une valeur extraite.

   Tâche
      Extraction asynchrone : réponse 202, puis interrogation jusqu'au résultat.

   Mutation
      Modification volontaire d'une règle pour vérifier que sa sonde échoue.
