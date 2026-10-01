Décisions d'architecture
========================

Chaque décision indique le contexte, le choix et sa conséquence principale.

.. list-table::
   :header-rows: 1
   :widths: 5 25 35 35

   * - N°
     - Décision
     - Contexte
     - Conséquence
   * - 1
     - Pont d'inférence partagé, en jumeaux JS/Python
     - Trois clients divergents, chacun avec ses bogues
     - Une seule règle par comportement ; parité imposée par les jeux d'essai
   * - 2
     - Catalogue de modèles unique
     - Listes de modèles recopiées dans chaque service
     - Tâches, voies et libellés au même endroit pour tous
   * - 3
     - Découverte par le store de la plateforme
     - Identifiants de modèles figés dans la configuration
     - Seuls les modèles prêts sont proposés ; les variables ne servent qu'à forcer
   * - 4
     - Choix explicite, sans substitution
     - Repli silencieux sur un autre modèle
     - Un modèle indisponible produit une erreur claire, jamais un résultat d'un autre modèle
   * - 5
     - Routage par fichier côté serveur
     - Choix de voie fait par le navigateur
     - Texte, image ou scan : la voie est décidée par le contenu réel
   * - 6
     - Fournisseur externe borné
     - Besoin d'un résultat assuré hors inférence interne
     - Désactivé sans clé, toujours après les modèles internes, avertissement et aucune conservation
   * - 7
     - CVthèque seule émettrice des sessions
     - Une connexion par module
     - Connexion unique ; les autres services vérifient seulement
   * - 8
     - Tâches asynchrones en mémoire
     - Requêtes longues coupées par les proxys
     - 202 puis interrogation ; tâches perdues au redémarrage (risque accepté)
   * - 9
     - pgvector dans la base existante
     - Recherche sémantique des profils
     - Aucune nouvelle brique ; pas d'index approché tant que le volume reste faible
   * - 10
     - Messages d'erreur constants
     - Traces techniques affichées aux utilisateurs
     - Table française partagée ; le détail reste dans les journaux
   * - 11
     - Aucune clé dans le navigateur
     - Clés exposées côté client
     - Tous les appels tiers passent par le serveur
   * - 12
     - Preuve par sondes et mutations
     - Changements acceptés sur la foi d'une relecture
     - Chaque règle est démontrée, et sa sonde échoue quand la règle est cassée
