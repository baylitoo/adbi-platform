Parcours d'une extraction
=========================

Du dépôt au résultat
--------------------

.. mermaid::

   flowchart TB
     dep["Dépôt d'un document<br/>+ modèle choisi"] --> tache["Tâche asynchrone<br/><small>file bornée, progression</small>"]
     tache --> ext{"Modèle<br/>externe ?"}
     ext -- oui --> oai["OpenAI<br/><small>texte seul, store:false</small>"]
     ext -- non --> txt{"Couche texte<br/>sur chaque page ?"}
     txt -- "oui, et modèle servi en texte" --> vt["Voie texte<br/><small>blocs paginés → preuves</small>"]
     txt -- non --> va["Voie agent<br/><small>OCR ou vision</small>"]
     vt --> res["Résultat normalisé"]
     va --> res
     oai --> res

Trois règles
------------

**Employer la structure que le document a réellement**
   Un DOCX ou un PDF à couche texte part en voie texte : pas d'encodage
   inutile, pas d'OCR distant, et des preuves ancrées sur un texte connu. Un
   scan part en voie agent, la seule qui lise une image. Le serveur tranche
   sur le fichier réel ; le navigateur ne peut pas connaître la couche texte.

**Échouer bruyamment**
   Un modèle choisi n'est jamais remplacé. S'il ne convient pas --- limite de
   lignes, scan pour un modèle qui ne lit que du texte --- l'utilisateur lit
   pourquoi.

**Dire ce qui a servi**
   La fiche affiche le modèle réellement utilisé, les champs incomplets et,
   champ par champ, la page et l'extrait d'où la valeur a été lue.

Tâches asynchrones
------------------

Les trois services qui extraient (CVthèque, Contrats, One-pager) partagent le
même contrat :

1. ``POST`` du document : réponse ``202`` avec un identifiant de tâche.
2. Interrogation de la tâche : état, progression, étape, position dans la
   file, puis résultat ou erreur nommée.

.. list-table::
   :header-rows: 1
   :widths: 40 60

   * - Paramètre
     - Valeur
   * - Concurrence
     - réglable de 1 à 16 (``*_EXTRACTION_MAX_CONCURRENT``)
   * - File d'attente
     - 20 tâches ; au-delà, refus explicite
   * - Conservation du résultat
     - 30 minutes
   * - Doublon
     - une seule tâche en cours par fiche

Les tâches vivent en mémoire : un redémarrage les perd (voir :doc:`../evolutions`).

Repli externe
-------------

Dans la CVthèque, l'utilisateur peut demander qu'un échec de l'inférence
interne soit rejoué chez le fournisseur externe. Le repli n'a jamais lieu
après un dépassement de délai ou une entrée invalide : il facturerait deux
fois ou renverrait un contenu inexploitable.
