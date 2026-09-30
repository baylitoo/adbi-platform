Vue d'ensemble
==============

Principes
---------

La plateforme repose sur cinq principes, qui expliquent la plupart des choix
décrits dans cette documentation.

**Souveraineté par défaut**
   L'inférence se fait sur la plateforme interne (DocIE). Un envoi vers un
   fournisseur externe n'arrive que sur un choix explicite de l'utilisateur,
   averti au moment du choix.

**Utiliser la plateforme d'inférence sans la reconfigurer**
   Une capacité disponible sur DocIE --- modèle prêt, agent, embeddings,
   reranker, preuves --- est proposée d'elle-même aux applications.

**Une seule implémentation par règle**
   Toute règle partagée vit dans le socle (``document-parsing/``, ``auth/``)
   et les applications la consomment ; jamais l'inverse.

**Échouer bruyamment**
   Un modèle choisi n'est jamais remplacé par un autre ; un résultat n'est
   jamais attribué à un modèle qui ne l'a pas produit ; un échec se lit en
   français.

**Aucun secret côté navigateur**
   Clés d'API, secrets de connecteurs et clé de session restent côté serveur.

Contexte
--------

.. mermaid::

   flowchart TB
     util["Utilisateurs<br/><small>recruteurs, commerciaux, ADV</small>"] --> plat
     admin["Administrateurs<br/><small>comptes, IA, paramètres</small>"] --> plat
     plat["Plateforme ADBI"]
     plat --> docie["Inférence interne (DocIE)<br/><small>extraction, store, agents,<br/>embeddings, reranker</small>"]
     plat -. "texte seul, sur choix" .-> oai["OpenAI"]
     plat -.-> sign["Signature<br/><small>Yousign, Zoho Sign</small>"]
     plat -.-> reg["Registres d'entreprises<br/><small>annuaire public, Pappers, INSEE</small>"]
     plat -.-> smtp["SMTP"]

Conteneurs
----------

.. list-table::
   :header-rows: 1
   :widths: 14 24 24 38

   * - Conteneur
     - Technologie
     - Persistance
     - Rôle
   * - Hub
     - Node 22, module ``http`` natif, sans dépendance
     - Aucune
     - Point d'entrée, cadre des modules, voyant IA, charte graphique
   * - CVthèque
     - Python 3.14, Flask, Gunicorn
     - Base dédiée (dont pgvector), fichiers déposés
     - Identité, CV, recherche, besoins, rapprochement, IA conversationnelle, exports
   * - Contrats
     - Node 22, Express
     - Base dédiée, référentiels et fichiers générés
     - Contrats, pièces, pré-remplissage, signature
   * - One-pager
     - Node 22, Express
     - Base dédiée
     - One-pager, livret, classement contre une offre
   * - Coffre
     - Node 22, module ``http`` natif, sans dépendance
     - Fichiers chiffrés
     - Chiffrement, protection, anonymisation, références
   * - PostgreSQL
     - 17 (Alpine) avec pgvector 0.8.0
     - Volume dédié
     - Une base par service

Le socle ``document-parsing/`` et la bibliothèque ``auth/`` ne sont pas des
conteneurs : ils sont **copiés dans chaque image au build**, depuis leur
source unique. Voir :doc:`socle`.

Ce qui a changé depuis la première version
------------------------------------------

La première version était une collection d'outils indépendants : chaque
application parlait à l'IA à sa manière, se protégeait (ou non) à sa manière,
et affichait ses erreurs telles qu'elles tombaient. La clé d'un fournisseur
LLM était saisie dans le navigateur. La version actuelle en a fait une
plateforme : un pont partagé, une identité unique, un catalogue commun, des
messages d'erreur maîtrisés, une charte appliquée partout et une intégration
continue sur six suites.
