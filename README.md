# Plateforme ADBI

Suite d'outils internes ADBI : un **hub** ouvre quatre services qui partagent
une seule identité, un seul pont vers la plateforme d'inférence interne, un
seul catalogue de modèles et une seule charte graphique.

| Dossier | Module | Port |
|---|---|---|
| `factory/` | **Hub** — tuiles, cadre des modules, voyant IA, charte | 4000 |
| `cv-parser/` | **CVthèque** — import et lecture de CV, recherche, rapprochement, dossier de compétences ; émet la session | 5000 |
| `contrats/` | **Contrats** — génération, contrôle des pièces, pré-remplissage, signature électronique | 4100 |
| `one-pager/` | **One-pager** — dossier d'une page, livret, classement contre une offre | 4200 |
| `coffre/` | **Coffre** — chiffrement, protection et anonymisation de documents | 4300 |
| `document-parsing/`, `auth/` | Socle partagé : pont d'inférence, catalogue, schémas, contrôles, identité | — |

## Documentation

La documentation complète (architecture, modules, démarrage, déploiement,
configuration, sécurité, décisions) est publiée à chaque poussée sur `master` :
**https://baylitoo.github.io/adbi-platform/**

Sources : site Sphinx dans `documentation/`. Pour la générer en local :

```bash
pip install -r documentation/requirements.txt
sphinx-build -b html documentation documentation/_build/html
```

Puis ouvrir `documentation/_build/html/index.html`.

## Démarrage rapide

```bash
cp .env.example .env      # renseigner les variables REQUIS
docker compose -f docker-compose.local.yml up -d --build
# → hub sur http://localhost:4000
```

Contact fonctionnel : Amine OUKLI (ADBI).
