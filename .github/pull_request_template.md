## Contexte

<!-- Issue liée, pourquoi ce changement est nécessaire. -->

Closes #

## Solution

<!-- Ce qui a été fait, et pourquoi cette approche plutôt qu'une autre
     (alternatives écartées si pertinent). -->

## Tests effectués

<!-- Étapes de reproduction / vérification. "Testé contre un vrai
     conteneur Postgres X" > "syntaxe vérifiée". Préciser explicitement
     ce qui N'A PAS été testé (ex : daemon Docker indisponible). -->

## Risques / impact

<!-- Rétrocompatibilité, migration de données, secrets, comportement en
     prod vs. dev. "Aucun" est une réponse valable si c'est vrai. -->

## Checklist

- [ ] Pas de secret / clé API en dur dans le diff
- [ ] `.env.example` à jour si une variable d'environnement est ajoutée/retirée
- [ ] Pas de changement de comportement non documenté pour les autres services
- [ ] Documentation (README / ARCHITECTURE.md) mise à jour si nécessaire
