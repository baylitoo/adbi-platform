Factures fournisseurs
=====================

Le module Factures (``factures/``) reçoit les factures des fournisseurs, en
extrait les données par la plateforme d'inférence interne, les contrôle, suit
leur validation puis leur paiement et produit le journal des achats.

Caractéristiques
----------------

- Node 22 et Express, port interne 4500.
- PostgreSQL partagé : tables préfixées ``fac_`` dans la base par défaut de la
  plateforme (``fac_factures``, ``fac_evenements``).
- Fichiers déposés sur un volume nommé (``factures-data``).
- Réutilise sans les modifier les bibliothèques de ``contrats/lib`` : file
  d'extraction asynchrone, contrôles SIREN/SIRET et IBAN/BIC, recherche
  d'entreprise, lecture de la couche texte et des dates.

Extraction
----------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Document
     - Voie
   * - PDF avec couche texte
     - voie texte, schéma ``document-parsing/schemas/facture.schema.json``
       envoyé dans la requête
   * - Scan ou photo
     - voie agent, schéma Studio ``adbi_facture`` (agent ``DOCIE_AGENT_FACTURE``
       ou découvert sur DocIE)

Le modèle suit la tâche ``facture`` du catalogue (provisoire, configurable par
l'environnement). Une seule extraction à la fois par défaut
(``FACTURES_EXTRACTION_MAX_CONCURRENT``) ; la position dans la file est
affichée. Les dates sont ramenées au format ISO côté ADBI ; les montants ne
sont jamais recalculés à l'extraction.

Contrôles
---------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Contrôle
     - Règle
   * - Changement d'IBAN
     - IBAN différent de celui de la dernière facture validée du même SIREN :
       **alerte fraude**, validation bloquée jusqu'à une confirmation explicite,
       journalisée avec l'utilisateur et la date.
   * - Doublon
     - même SIREN et même numéro de facture.
   * - Totaux
     - somme des lignes égale au total HT, et HT + TVA = TTC, à 0,02 près.
       Un TTC déséquilibré bloque la validation.
   * - SIREN / SIRET
     - clés de contrôle (Luhn) et cohérence du SIRET avec le SIREN.
   * - Société
     - existence et nom par la recherche publique d'entreprises, sans clé,
       avec cache ; « vérification indisponible » si le service ne répond pas.
   * - IBAN / BIC
     - modulo 97 et format du BIC.

Statuts
-------

``a_valider`` → ``validee`` → ``payee``. Chaque changement est enregistré dans
``fac_evenements`` avec l'identité du jeton ``adbi_access`` vérifié (``sub``,
``email``). La vue Échéances liste les factures non payées en retard et celles
à payer sous sept jours.

Journal des achats
------------------

Export CSV séparé par des points-virgules, décimales à virgule, colonnes
date, journal (``ACH``), compte, libellé, débit, crédit. Une écriture par
facture validée ou payée :

- débit du compte de charge (``607`` par défaut, ``FACTURES_COMPTE_CHARGE`` ou
  choisi à l'export) pour le total HT ;
- débit de la TVA déductible ``44566`` pour TTC − HT ;
- crédit du compte fournisseur ``401`` suivi du SIREN pour le total TTC.
