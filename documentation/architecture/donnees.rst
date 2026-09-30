Données
=======

Une base par service
--------------------

PostgreSQL 17 héberge une base par service, créées au premier démarrage. Le
coffre n'utilise pas de base.

.. list-table::
   :header-rows: 1
   :widths: 16 30 54

   * - Service
     - Tables
     - Contenu
   * - CVthèque
     - ``cvs``
     - Fiche CV complète (identité, expériences, compétences, revue, provenance, modèle servi)
   * -
     - ``cv_embeddings``
     - Vecteur par CV et par modèle, empreinte du texte indexé ; supprimé avec le CV
   * -
     - ``needs``, ``matching_results``
     - Besoins clients (prix d'achat et de vente) et scores détaillés par candidat
   * -
     - ``users``, ``refresh_tokens``, ``invites``
     - Comptes, jetons de rafraîchissement révocables, invitations à usage unique (72 h)
   * -
     - ``activity``
     - Journal d'activité : connexions, imports, rapprochements
   * - Contrats
     - ``contrats``, ``signatures``, ``corbeille``, ``templates_perso``
     - Contrats, demandes de signature, éléments supprimés restaurables, gabarits personnalisés
   * - One-pager
     - ``cvs``
     - Fiche maître et options de mise en page, index trigramme pour la recherche
   * - Coffre
     - (fichiers)
     - Clé locale, registre de références chiffré, documents produits chiffrés

Recherche sémantique
--------------------

Les CV sont indexés sous forme de vecteurs, calculés par la plateforme
d'inférence et stockés dans PostgreSQL grâce à pgvector. Un CV n'est
réindexé que si son texte a changé. La recherche mesure la proximité
cosinus ; l'utilisateur choisit entre recherche classique et sémantique.

Données personnelles
--------------------

**CV de candidats**
   Restent dans la CVthèque et le one-pager. Transitent vers l'inférence
   interne pour l'extraction et les embeddings. Ne partent vers OpenAI que
   sur choix explicite de l'utilisateur, averti au moment du choix, sous
   forme de texte, sans conservation chez le fournisseur.

**Pièces et contrats d'entreprise**
   Mêmes règles ; ils ne partent chez le tiers de signature que lors d'un
   envoi pour signature.

**Secrets**
   En variables d'environnement côté serveur. Les secrets de connecteurs
   saisis dans l'interface des contrats restent côté serveur ; le navigateur
   ne reçoit que des indicateurs « configuré / non configuré ».
