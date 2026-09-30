Coffre
======

Le Coffre (``coffre/``) chiffre, protège et anonymise des documents, et tient
un registre de références.

Caractéristiques
----------------

- Node 22, module ``http`` natif, **aucune dépendance npm**.
- Port interne 4300.
- Aucune base : tout l'état est dans des fichiers chiffrés, sur volume.

Chiffrement
-----------

.. list-table::
   :header-rows: 1
   :widths: 35 65

   * - Élément
     - Choix
   * - Algorithme
     - AES-256-GCM, en-tête authentifié en données associées
   * - Mode mot de passe
     - clé dérivée par scrypt (N = 2¹⁷, r = 8, p = 1)
   * - Mode sans mot de passe
     - clé dérivée par HKDF-SHA256 d'une clé locale de 32 octets, générée au premier démarrage
   * - Nom d'origine
     - voyage à l'intérieur du contenu chiffré

.. warning::

   La perte de la clé locale rend irrécupérables tous les documents protégés
   en mode sans mot de passe. Sauvegardez le volume du coffre.

Protection et anonymisation
---------------------------

Des détecteurs d'informations sensibles (noms, photos, courriels, téléphones,
IBAN…) s'exécutent à l'identique dans le navigateur pour les PDF et côté
serveur, en bac à sable, pour les documents Word. Un document **protégé**
embarque son original chiffré et reste réversible ; un document
**anonymisé** ne le contient plus.

Registre de références
----------------------

Chaque document produit reçoit une référence courte et stable, attribuée par
empreinte de contenu. Le registre est chiffré et limité à 5 000 entrées ; le
document produit peut y être rattaché et consulté plus tard.

Archives
--------

Un fichier ou un dossier peut être emballé dans une archive ZIP chiffrée en
AES-256.
