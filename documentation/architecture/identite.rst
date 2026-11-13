Identité et accès
=================

Un émetteur, des vérificateurs
------------------------------

L'identité vient du **compte Cynov** (serveur d'authentification de
Facturation) : aucun mot de passe n'est gardé par ADBI. La **CVthèque est le
seul émetteur de session** : elle n'en émet une qu'après que Cynov a accepté
les identifiants. Les autres services ne font que vérifier le jeton,
localement, avec la bibliothèque partagée ``auth/auth-adbi.js`` : aucun appel
entre services pour authentifier.

.. mermaid::

   sequenceDiagram
     participant N as Navigateur
     participant H as Hub
     participant C as CVthèque
     participant Y as Cynov
     participant M as Module
     N->>H: ouvre une page
     H-->>N: redirection vers la connexion (+ page d'origine)
     N->>C: identifiant et mot de passe Cynov
     C->>Y: /auth/login
     Y-->>C: paire de jetons Cynov
     C-->>N: cookies d'accès (1 h) et de rafraîchissement (7 j), paire Cynov en cookies réservés
     N->>H: retour à la page d'origine
     N->>M: requête avec le même cookie
     M-->>N: jeton vérifié localement

Connexion par Cynov
-------------------

- La CVthèque relaie la connexion à ``CYNOV_AUTH_BASE_URL`` (racine de l'API,
  préfixe d'application et version compris) : ``/auth/login``,
  ``/auth/refresh``, ``/auth/logout`` et ``/auth/change-password`` (première
  connexion, depuis la page de connexion). Le navigateur ne parle jamais à
  Cynov : aucune règle CORS à ouvrir chez lui.
- Un compte Cynov valide n'entre que s'il est **autorisé** sur ADBI :
  l'administrateur ajoute son identifiant Cynov et son rôle (Paramètres →
  Utilisateurs). Sinon : refus explicite, et la session Cynov ouverte est
  aussitôt fermée.
- Cynov ne publie ni clé ni point d'introspection : la preuve qu'une session
  vit encore est que Cynov accepte son jeton de rafraîchissement. Chaque
  rafraîchissement de la session ADBI en passe par là ; un compte désactivé
  chez Cynov perd donc l'accès au plus tard à l'expiration du jeton d'accès
  ADBI (1 h).
- La paire Cynov vit dans deux cookies ``HttpOnly`` limités à ``/api/auth``
  sur l'hôte de la CVthèque : ni les modules ni le script de la page ne les
  voient. Cynov fait tourner le jeton de rafraîchissement à chaque usage ; le
  nouveau remplace toujours l'ancien.
- Le jeton de rafraîchissement ADBI est lié à l'identifiant que porte la
  session Cynov : une session Cynov d'un autre compte est refusée.
- La page de connexion tente d'abord un rafraîchissement : tant que la session
  Cynov vit, l'expiration du jeton d'accès ne redemande pas le mot de passe.

Le jeton
--------

- JWT signé en HS256 avec un secret partagé côté serveur (``ADBI_JWT_SECRET``).
- Cookie d'accès ``adbi_access`` : ``HttpOnly``, ``SameSite=Lax``, ``Secure``
  selon le schéma détecté, domaine partagé optionnel (``ADBI_COOKIE_DOMAIN``).
- Cookie de rafraîchissement limité à la route de rafraîchissement ; rotation
  à chaque usage, révocation à la déconnexion (ADBI et Cynov).
- Vérification côté services : algorithme imposé, comparaison à temps
  constant, contrôle du type, de l'expiration et du sujet. Secret absent :
  accès refusé (échec fermé).

Retour après connexion
----------------------

La page d'origine n'est acceptée que si elle vise l'hôte courant, le hub
(``ADBI_FACTORY_URL``) ou le domaine du cookie ; toute URL portant des
identifiants, des barres obliques inverses ou des caractères de contrôle est
refusée. Sans adresse de hub configurée, le hub transmet sa propre origine.

Rôles
-----

- **Utilisateur** et **super-utilisateur**. Le rôle et l'état actif sont relus
  en base à chaque requête, jamais tirés du seul jeton.
- Un besoin client n'est visible que de son créateur, sauf pour un
  super-utilisateur.
- Le détail des services d'IA (chaîne de modèles, temps de réponse) n'est
  montré qu'au super-utilisateur ; les autres voient « IA disponible » ou
  « IA indisponible ».
- Les paramètres des contrats sont en plus protégés par un code
  (``ADBI_CODE_PARAMETRES``).

Surface publique
----------------

Sans session, seuls répondent : la santé (``/api/sante``, sans détail
technique), la charte (thème et polices, pour que la page de reconnexion
s'affiche correctement), les webhooks de signature (authentifiés par HMAC),
et deux routes plafonnées (recherche d'entreprise, test d'un modèle du voyant
IA). Une page protégée renvoie une page de reconnexion à la charte.

Mode poste local
----------------

Sans ``ADBI_AUTH=on``, les services acceptent tout visiteur sous une identité
locale de super-utilisateur, et le signalent au démarrage. Ce mode est réservé
au développement.
