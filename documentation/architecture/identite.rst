Identité et accès
=================

Un émetteur, des vérificateurs
------------------------------

La **CVthèque est le seul émetteur de session**. Les autres services ne font
que vérifier le jeton, localement, avec la bibliothèque partagée
``auth/auth-adbi.js`` : aucun appel entre services pour authentifier.

.. mermaid::

   sequenceDiagram
     participant N as Navigateur
     participant H as Hub
     participant C as CVthèque
     participant M as Module
     N->>H: ouvre une page
     H-->>N: redirection vers la connexion (+ page d'origine)
     N->>C: identifiants
     C-->>N: cookies d'accès (1 h) et de rafraîchissement (7 j)
     N->>H: retour à la page d'origine
     N->>M: requête avec le même cookie
     M-->>N: jeton vérifié localement

Le jeton
--------

- JWT signé en HS256 avec un secret partagé côté serveur (``ADBI_JWT_SECRET``).
- Cookie d'accès ``adbi_access`` : ``HttpOnly``, ``SameSite=Lax``, ``Secure``
  selon le schéma détecté, domaine partagé optionnel (``ADBI_COOKIE_DOMAIN``).
- Cookie de rafraîchissement limité à la route de rafraîchissement ; rotation
  à chaque usage, révocation à la déconnexion, invalidation de tous les
  jetons d'un compte au changement de mot de passe.
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
