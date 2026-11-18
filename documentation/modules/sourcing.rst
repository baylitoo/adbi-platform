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
     - ``collage``, ``navigateur``, ``email``, ``api`` (défaut) ; ``linkedin_public`` marque les offres importées par la recherche ci-dessous
   * - ``capture_le``
     - Facultatif, date ISO 8601
   * - ``auteur``
     - Facultatif, 200 caractères au plus

Le traitement est asynchrone : la réponse est immédiate (202) et la fiche
affiche la position dans la file. La file est celle de
``contrats/lib/taches-extraction.js``, copiée dans l'image sans modifier
``contrats/`` ; un traitement à la fois par défaut. Un redémarrage perd la file :
les éléments en cours passent en échec et se relancent par « Re-classer ».

Recherche LinkedIn publique
---------------------------

Désactivée par défaut ; ``SOURCING_LINKEDIN_PUBLIC=1`` l'active et ouvre
l'onglet « Offres LinkedIn ». Elle lit les pages publiques des offres
(``/jobs/search`` puis ``/jobs/view/<id>``), sans compte LinkedIn : aucun
compte de recruteur n'est exposé. Elle reste contraire aux conditions
d'utilisation de LinkedIn, dont le ``robots.txt`` interdit tout accès
automatisé ; l'activer est une décision de l'exploitant.

- ``GET /api/linkedin/offres?mots_cles=&lieu=&jours=&distance=`` rend au plus
  60 offres (intitulé, entreprise, lieu, date, lien) ; rien n'est enregistré.
  ``jours`` (1, 3, 7, 14, 21 ou 30) est transmis à LinkedIn puis vérifié sur la
  date de chaque carte ; ``distance`` est en miles, comme LinkedIn (5 à 100).
  Chaque offre porte ``element_id`` si elle a déjà été analysée et
  ``pertinence``, le profil du référentiel dont l'intitulé et les compétences
  couvrent le mieux les mots de son intitulé.
- La page publique ne dépasse pas 60 offres : au-delà, LinkedIn renvoie vers sa
  connexion. ``max_atteint`` le signale ; on affine alors par période, distance
  ou mots-clés. Le type de contrat n'est pas un filtre public : il est connu à
  l'analyse (critère « Type d'emploi » et champ extrait) et filtre la liste
  « Opportunités ».
- ``POST /api/linkedin/offres/<id>/importer`` lit la page de l'offre et la
  dépose comme un élément d'origine ``linkedin_public``, lien de l'offre en
  source et entreprise en auteur : classement, extraction et rapprochement
  suivent comme pour un collage. Une description plus longue que la limite de
  3 000 caractères est coupée à une fin de ligne, et la réponse le signale
  (``tronque``). L'interface analyse une sélection d'offres une à une et
  arrête le lot au premier refus de LinkedIn.
- Les critères de la page (niveau, type d'emploi, secteurs) sont gardés dans
  ``source_meta``, avec la nature de l'employeur déduite du secteur :
  ``client_final`` (un prospect), ``esn_conseil`` (concurrent ou partenaire),
  ``recrutement`` ou ``inconnu``. La règle est un simple filtre de mots sur le
  secteur LinkedIn : la fiche permet de la corriger, et la correction est
  marquée (``employeur_corrige``).

Garde-fous : le service s'annonce sous son propre nom (``adbi-sourcing/1.0``),
envoie ses requêtes une à une, à 3 secondes d'intervalle tous utilisateurs
confondus, et seulement sur action d'un utilisateur. Un refus (HTTP autre que
200), une page de vérification anti-robot ou un renvoi vers la connexion
suspendent la source 15 minutes ; il n'y a ni nouvel essai, ni navigateur
automatisé, ni changement d'identité ou d'adresse. Une page dont le format a
changé est signalée comme telle plutôt que lue de travers.

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

Référentiel de profils
----------------------

L'onglet « Profils » tient le référentiel des profils à placer : nom (seul
champ obligatoire), intitulé, compétences, séniorité, localisation,
disponibilité, TJM, notes et référence CVthèque (``cvtheque_id``, qui prépare
le lien avec la CVthèque). Le référentiel est partagé par toute l'instance,
c'est-à-dire par la société qui l'exploite : chacun le voit et le modifie, et
la fiche garde le nom de qui l'a ajoutée et de qui l'a modifiée en dernier.
Les offres restent propres à chaque utilisateur, et les associations entre un
profil et une offre aussi.

Chaque fiche d'offre propose les cinq profils les plus proches avec un score
sur 100 et ses raisons : compétences 60 (part des compétences demandées que le
profil couvre, plus ses compétences citées dans le texte), intitulé 25,
séniorité 10, zone 5. Le calcul est déterministe et ne passe par aucun modèle :
c'est un tri, pas une décision. Un profil peut être associé à une offre ou en
être retiré ; supprimer un profil supprime ses associations.

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Route
     - Rôle
   * - ``GET/POST /api/profils``, ``PUT/DELETE /api/profils/<id>``
     - Référentiel
   * - ``GET /api/elements/<id>/profils``
     - Profils associés et suggestions, avec scores et raisons
   * - ``PUT/DELETE /api/elements/<id>/profils/<pid>``
     - Associer ou retirer un profil

Revue
-----

La liste « Opportunités » filtre par type, statut, source, nature de
l'employeur et type de contrat extrait ; chaque carte
montre le type, l'entreprise, l'intitulé, les trois premiers consultants et le
lien vers la source. La fiche d'un élément montre le texte d'origine et ses
lignes de preuve, les champs extraits (modifiables), le classement et les
consultants proposés, avec les actions « Re-classer », « Marquer comme bruit »
et « Valider ».
