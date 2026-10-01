Hub
===

Le hub (``factory/``) est le point d'entrée de la plateforme : il présente les
modules sous forme de tuiles, les affiche dans son cadre et redirige vers la
connexion tout visiteur sans session.

Caractéristiques
----------------

- Node 22, module ``http`` natif, **aucune dépendance npm** --- surface
  d'audit minimale.
- Port interne 4000.
- Aucune base : le registre des modules est un fichier (``modules*.json``),
  avec une variante par mode de déploiement (poste local, conteneurs).

Registre des modules
--------------------

Chaque tuile est un **service** (une application), un **lien** (une vue d'un
autre module) ou un **outil statique** (par exemple la calculatrice de TJM).
En poste local, le hub démarre et arrête lui-même les applications ; en
conteneurs, il se contente de vérifier qu'elles répondent.

Voyant IA
---------

Une pastille dans l'en-tête indique si le service d'IA répond :
« IA disponible », « IA indisponible ». La chaîne de modèles vient du store
de la plateforme d'inférence. Le détail --- modèles, temps de réponse,
modèles déployés --- ne s'ouvre que pour un super-utilisateur.

Charte graphique
----------------

Le hub est la source de la charte : thème (``adbi-theme.css``,
``adbi-theme.js``) et polices. Les autres services en reçoivent une copie
synchronisée.
