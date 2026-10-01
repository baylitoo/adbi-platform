Contrats
========

Le module Contrats (``contrats/``) génère les contrats de sous-traitance et
leurs avenants, contrôle les pièces administratives du sous-traitant et fait
signer par un tiers de confiance.

Caractéristiques
----------------

- Node 22, Express ; port interne 4100.
- Base PostgreSQL dédiée ; référentiels et fichiers générés sur volume.

Génération
----------

Cinq gabarits : sous-traitance, avenant, CDS, CDI, CDD. Le texte des modèles
peut être retouché par instance, bloc par bloc et de façon réversible. Les
exports sont produits côté serveur en PDF, Word ou archive ZIP, pour un rendu
identique à l'aperçu.

Checklist des pièces
--------------------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Pièce
     - Contrôle
   * - Kbis
     - Société, SIREN/SIRET (clé de Luhn), validité de 6 mois ; proposition des valeurs lues à reporter dans le contrat
   * - Attestation URSSAF
     - Société, SIREN/SIRET, date de délivrance, validité de 6 mois
   * - Attestation fiscale
     - Société, SIREN/SIRET, service des impôts, mention de régularité ; pas de verdict de validité à 6 mois
   * - RIB
     - Titulaire, IBAN (mod 97), BIC
   * - Pièce d'identité
     - Lecture en vision, chiffres de contrôle de la MRZ
   * - Coordonnées, informations spécifiques
     - Saisie

Chaque pièce se lit en trois niveaux : localement (texte et OCR, sans envoi),
par la plateforme d'inférence, ou par le modèle externe sur choix. Un modèle
choisi qui échoue ne retombe jamais sur l'analyse locale.

Pré-remplissage
---------------

Un contrat existant en PDF peut pré-remplir le formulaire : les valeurs lues
sont proposées, jamais enregistrées sans relecture.

Signature électronique
----------------------

La signature passe exclusivement par un tiers de confiance, derrière une
interface commune : Yousign ou Zoho Sign.

.. mermaid::

   sequenceDiagram
     participant C as Contrats
     participant T as Tiers de signature
     C->>T: création de l'enveloppe, invitations
     T-->>C: webhook de statut (HMAC)
     C->>T: synchronisation manuelle (au besoin)
     C->>T: téléchargement du signé et du dossier de preuve

Le fournisseur d'un webhook se déduit de la forme du corps, ce qui empêche
l'usurpation croisée. Un traitement de webhook échoué est rejoué toutes les
cinq minutes, pendant environ 24 heures.

Historique et corbeille
-----------------------

Les contrats enregistrés forment un historique avec avenants rattachés,
clôture et mention « signé ». Une suppression passe par la corbeille, d'où
l'élément se restaure ; la purge est définitive et demande une double
confirmation.

Recherche d'entreprise
----------------------

Par SIREN, SIRET ou nom : annuaire public par défaut, Pappers ou INSEE si une
clé est configurée. Résultats mis en cache, appels identiques regroupés,
débit plafonné ; le SIREN est validé avant tout appel.
