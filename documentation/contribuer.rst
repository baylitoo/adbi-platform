Contribuer
==========

Flux
----

1. Une branche par sujet, à partir de ``master``.
2. Une proposition de changement par sujet, avec une description en français :
   le problème, le choix retenu, ce qui a été vérifié.
3. L'intégration continue doit être verte (voir :doc:`exploitation/tests`).
4. Le responsable du dépôt relit et fusionne ; personne ne fusionne sa propre
   proposition.

Règles de code
--------------

- **Commentaires d'une ligne au plus.** Le raisonnement va dans le message de
  commit et la description de la proposition.
- **Jumeaux alignés.** Toute règle du socle existe en JavaScript et en
  Python ; une modification touche les deux et les jeux d'essai communs.
- **Pas de nouveau client d'inférence.** Tout appel passe par le pont partagé
  de ``document-parsing/``.
- **Charte graphique.** Jetons CSS et classes existantes ; ni style en ligne
  ni couleur en dur (le thème sombre en dépend).
- **Messages en français, constants.** Aucune erreur technique brute à
  l'écran.
- **Aucune donnée d'infrastructure** (adresse, nom d'hôte, clé) dans un
  commit, une proposition ou un ticket.

Prouver un changement
---------------------

Chaque changement se démontre par une sonde jetable (script hors dépôt) qui
exerce le comportement, puis par une mutation : casser volontairement la
règle doit faire échouer la sonde. Les suites existantes ne sont modifiées que
si le changement rend un de leurs cas faux.

Documentation
-------------

Cette documentation vit dans ``documentation/`` (Sphinx, thème Furo,
diagrammes Mermaid). Toute évolution d'architecture, de configuration ou
d'exploitation met à jour la page concernée dans la même proposition.
