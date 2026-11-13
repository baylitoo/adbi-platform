Notes de frais
==============

Notes de frais (``notes-frais/``) lit les justificatifs de dépense (tickets
photographiés, factures PDF), laisse l'utilisateur corriger et valider chaque
ligne, puis exporte les lignes validées pour la comptabilité.

Caractéristiques
----------------

- Node 22 et Express, port interne 4400.
- PostgreSQL partagé : tables préfixées ``ndf_`` dans la base par défaut de
  l'instance, créées au démarrage.
- Justificatifs sur un volume nommé (``/app/data/recus``).
- Contrôle d'accès par ``auth/auth-adbi.js``, comme Contrats ; ``/api/sante``
  reste publique.

Parcours
--------

1. Dépôt d'un ou plusieurs fichiers : JPEG, PNG ou PDF, 15 Mo au plus. Le type
   est lu sur les premiers octets ; une photo HEIC est refusée avec un message
   qui explique comment obtenir un JPEG.
2. Chaque fichier devient une note et une tâche d'extraction asynchrone, sur
   le contrat de ``contrats/lib/taches-extraction.js`` (file bornée, position
   d'attente affichée).
3. Le tableau, groupé par mois puis par collaborateur, présente les champs lus :
   date, commerçant, lignes de TVA (taux, base, montant), totaux HT et TTC,
   devise, moyen de paiement et catégorie.
4. L'utilisateur corrige, enregistre, puis valide la ligne.
5. L'export CSV ne reprend que les lignes validées.

Extraction
----------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Fichier reçu
     - Voie
   * - PDF dont chaque page porte du texte
     - voie texte du pont, schéma ``document-parsing/schemas/recu.schema.json``
       envoyé dans la requête
   * - Photo, scan ou PDF avec une page muette
     - voie agent du pont, agent ``DOCIE_AGENT_RECU`` (``adbi_recu`` par défaut)
       qui applique le schéma Studio ``adbi_recu``

Le modèle vient de la tâche ``recu`` du catalogue
(``document-parsing/models/catalogue.json``) quand une variable le configure,
sinon du défaut d'environnement du pont. Le choix reste provisoire : aucun banc
d'essai sur des reçus n'existe encore.

Les valeurs lues sont normalisées côté ADBI : date en ISO, montants en nombres,
devise en code ISO (EUR par défaut), catégorie ramenée à l'une des six valeurs
(repas, transport, hébergement, carburant, fournitures, autre), ``autre`` si elle
n'est pas reconnue.

Contrôles
---------

Chaque ligne porte des badges recalculés à l'affichage :

- **Doublon possible** : même collaborateur, même date, même commerçant et même TTC ;
- **HT + TVA ≠ TTC** : écart de plus de 0,02, avec deux correctifs en un clic ;
- **Taux de TVA inconnu** : taux autre que 20, 10, 5,5 ou 2,1 % ;
- **Date invraisemblable** : dans le futur, ou de plus d'un an.

Visibilité
----------

L'identité vient du jeton vérifié (``sub``, ``email``, ``full_name``). Chaque
collaborateur voit ses notes ; un superutilisateur voit celles de tous et peut
filtrer par collaborateur.

Export
------

CSV en UTF-8 avec BOM, séparateur ``;``, virgule décimale, une colonne de base
et une de montant par taux français connu, plus les autres taux, le total de
TVA et le total TTC. Un texte qui commence comme une formule de tableur est
neutralisé.
