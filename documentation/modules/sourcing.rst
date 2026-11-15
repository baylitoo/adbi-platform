Sourcing
========

ADBI Sourcing (``sourcing/``) est la couche de collecte d'un futur copilote de
recrutement : il reçoit des « éléments » (un post LinkedIn, une offre d'emploi,
un court texte), les classe, en extrait les informations utiles et propose des
consultants de la CVthèque.

Caractéristiques
----------------

- Node 22 et Express, port interne 4700.
- Tables préfixées ``src_`` dans la base par défaut de l'instance PostgreSQL
  partagée, créées au démarrage.
- Interface en français, utilisable seule ou dans le cadre du hub, thèmes clair
  et sombre de la charte.

Isolation des éléments
----------------------

Chaque élément appartient à l'utilisateur qui l'a déposé, identifié par le
``sub`` du jeton ``adbi_access`` vérifié (``auth/auth-adbi.js``). Toute lecture
et toute écriture sont bornées à ce ``sub`` : un utilisateur ne voit ni ne
traite que ses propres éléments, superutilisateur compris. L'identifiant d'un
élément d'autrui répond 404.

Entrée
------

``POST /api/elements`` reçoit ``{texte, url_source, origine, capture_le?, auteur?}``.
La route est indépendante du canal : le formulaire « Coller un élément » est le
seul canal de cette version ; un bouton de navigateur, l'e-mail ou une API
suivront avec les origines ``navigateur``, ``email`` et ``api``.

.. list-table::
   :header-rows: 1
   :widths: 25 75

   * - Champ
     - Règle
   * - ``texte``
     - 200 à 3 000 caractères ; un texte déjà déposé par le même utilisateur renvoie la fiche existante
   * - ``url_source``
     - Facultatif ; adresse ``http`` ou ``https`` sans identifiants
   * - ``origine``
     - ``collage``, ``navigateur``, ``email`` ou ``api`` (défaut)
   * - ``capture_le``
     - Facultatif, date ISO 8601
   * - ``auteur``
     - Facultatif, 200 caractères au plus

Le traitement est asynchrone : la réponse est immédiate (202) et la fiche
affiche la position dans la file. La file est celle de
``contrats/lib/taches-extraction.js``, copiée dans l'image sans modifier
``contrats/`` ; un traitement à la fois par défaut. Un redémarrage perd la file :
les éléments en cours passent en échec et se relancent par « Re-classer ».

Classement
----------

Une seule interface, ``classer(texte)``, rend
``{type, probabilites, confiance, methode}`` avec ``type`` parmi
``offre_emploi``, ``post_opportunite`` et ``bruit``.

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Mode
     - Fonctionnement
   * - ``generatif``
     - Défaut. Voie texte DocIE par le pont partagé, schéma ``adbi_classement_post`` à un seul champ ``type`` ; la valeur est contrôlée côté ADBI. Aucune confiance n'est demandée au modèle : ``confiance`` reste vide.
   * - ``decision``
     - Modèle de décision DocIE (``POST /v1/systemone``, fonction ``decide`` du pont) : une probabilité par type. Repli sur ``generatif`` si DocIE répond 404 ou 501, raison consignée.
   * - ``double``
     - Les deux ; l'élément passe « à vérifier » s'ils divergent.

Un élément est « à vérifier » quand son type est inconnu, quand la confiance du
modèle de décision est sous ``SOURCING_DECISION_SEUIL`` ou quand ses deux
premières probabilités sont à moins de ``SOURCING_DECISION_ECART``. Ces
probabilités sont stockées brutes et affichées comme « probabilité du
modèle » : elles ne sont pas calibrées sur nos données.

.. warning::

   La route ``/v1/systemone`` dépend de la PR DocIE #660, non fusionnée.
   Laissez ``SOURCING_CLASSEMENT=generatif`` tant qu'elle ne l'est pas.

Extraction
----------

Seulement si le type n'est pas ``bruit``. Schéma ``adbi_opportunite`` :
entreprise, intitulé, compétences, localisation, type de contrat, séniorité,
date de début, contact mentionné et devise (seulement si un budget ou un TJM
est cité). Le type de contrat est contrôlé côté ADBI (``cdi``, ``cdd``,
``freelance``, ``mission``, ``appel_offres``, ``inconnu``) et la date ramenée
au format ISO.

Le texte part en blocs d'une ligne : chaque preuve (``evidence_ids``) renvoyée
par DocIE désigne une ligne du texte d'origine, surlignée dans la fiche. La
confiance d'ancrage de DocIE (correspondance de la valeur avec le texte, de 0
à 1) est conservée par champ. Aucune voie externe n'est proposée : un post peut
nommer des personnes.

Rapprochement
-------------

Une seule interface, ``rapprocher(opportunite, session)``, rend
``[{profil_id, nom, score, raisons}]``. L'adaptateur est choisi par
``SOURCING_RAPPROCHEUR``.

- ``cvtheque`` (défaut) : appel serveur à serveur vers cv-parser, avec le jeton
  ``adbi_access`` de l'utilisateur relayé en ``Authorization: Bearer``. Un
  besoin est créé une fois par élément (``POST /api/needs``), mis à jour ensuite,
  puis rapproché (``POST /api/needs/<id>/match?limit=10``). Ni courriel ni
  téléphone des consultants ne sont conservés.
- ``crm`` : emplacement réservé, pas encore écrit ; il refuse tout rapprochement.

Revue
-----

La liste « Opportunités » filtre par type, statut et source ; chaque carte
montre le type, l'entreprise, l'intitulé, les trois premiers consultants et le
lien vers la source. La fiche d'un élément montre le texte d'origine et ses
lignes de preuve, les champs extraits (modifiables), le classement et les
consultants proposés, avec les actions « Re-classer », « Marquer comme bruit »
et « Valider ».
