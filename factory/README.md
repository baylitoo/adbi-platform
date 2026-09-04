# ADBI Factory — hub

Port **4000**. Node natif, zéro dépendance npm (http/net/fs). Page d'accueil
qui regroupe les outils ADBI derrière une seule page : tuiles, cycle de vie
des modules (démarre/arrête via `child_process.spawn`), charte graphique
commune.

## Modules

| Module | Port | Stack |
|---|---|---|
| ADBI OnePager | 4200 | Node |
| ADBI Contrats (+ ADBI Sign) | 4100 | Node |
| ADBI Coffre | 4300 | Node |
| ADBI Parser | 5000 | Python / Flask |
| ADBI Calculator | — | statique, servi par la Factory |

Les modules service sont des applications indépendantes : la Factory les
démarre automatiquement au premier clic sur leur tuile, puis les affiche en
iframe. Le CV Parser met ~30 s à démarrer (moteur Docling) — la Factory
patiente jusqu'à 90 s.

## Configuration — `modules.json`

Fichier **non suivi en git** (chemins spécifiques au poste/serveur — voir
`.gitignore`). Deux gabarits selon le mode de déploiement :

- **Poste ou serveur classique** (systemd, un seul hôte — Factory lance
  chaque module par `child_process.spawn`) : partir de
  [`modules.example.json`](modules.example.json).
  ```bash
  cp modules.example.json modules.json
  # adapter dossier/commande aux chemins réels, et le domaine pour "url"
  ```
- **Docker compose / Coolify** (chaque module est son propre conteneur,
  déjà démarré par docker-compose) : partir de
  [`modules.docker.json`](modules.docker.json) — copié en `modules.json` par
  défaut dans l'image (`Dockerfile`), à écraser par bind-mount pour changer
  domaines/noms de service sans reconstruire l'image (voir
  `docker-compose.yml` à la racine du dépôt).

| Champ | Rôle |
|---|---|
| `dossier` | chemin de l'application (mode spawn uniquement) |
| `port` | port d'écoute |
| `type` | `service` (démarrée par la Factory OU par son propre conteneur) / `statique` (page servie par la Factory) / `lien` (alias vers un autre module) / `bientot` (tuile grisée) |
| `entree` | fichier principal (`server.js`, `app.py`…) — mode spawn uniquement |
| `commande` | exécutable (absent = Node ; le CV Parser utilise l'interpréteur Python) — mode spawn uniquement |
| `arguments` | arguments passés à la commande (absent = `[entree]`) — mode spawn uniquement |
| `delai` | secondes d'attente avant d'abandonner (40 par défaut) |
| `url` | adresse **publique** donnée au navigateur (iframe) |
| `conteneur` | `true` : la Factory ne lance JAMAIS ce module (`spawn`), elle attend seulement qu'il réponde sur `hote:port` — son propre conteneur le démarre |
| `hote` | hôte réseau où la Factory joint le module en mode `conteneur` (nom du service docker-compose, résolu par le DNS interne du réseau compose) — 127.0.0.1 sinon |

En mode `conteneur`, `url` (public, via Coolify/reverse proxy) et `hote`
(interne, réseau compose) sont volontairement différents : le navigateur et
la Factory n'atteignent pas un module conteneurisé par le même chemin.

Après modification, relancer la Factory. Ajouter un module = un bloc dans
`modules.json` (+ une icône SVG dans `public/factory.js` si besoin) : aucun
code Factory à toucher.

## Thème clair/sombre

Ouverture en clair par défaut ; bouton du rail pour basculer, choix mémorisé
et transmis au module affiché en cadre. Chaque application tourne sur un port
différent (origine différente) : pas de stockage/cookie partagé — une
application ouverte seule garde le dernier thème choisi sur son propre port.

**Piège CSS à connaître** : le thème par défaut de la plateforme est le
*clair*, mais dans les feuilles de style c'est le *sombre* qui est le thème
« sans attribut » (le clair s'obtient par `data-theme="clair"` sur `<html>`).

## Charte graphique commune

Source unique : `theme/` (`adbi-theme.css` = les deux palettes, `adbi-theme.js`
= applique/mémorise/synchronise, `fonts/` = Poppins en local). Recopiée dans
chaque application par :

```bash
node scripts/sync-theme.js
```

Ne jamais éditer les copies dans chaque application — elles sont écrasées à
la synchronisation suivante ; les ajustements propres à une app vont dans son
fichier de surcharge (`adbi-<app>-sombre.css`, gère en réalité les deux
thèmes malgré le nom).

Trois jetons CSS à utiliser plutôt que du blanc/noir en dur sur un aplat de
couleur : `--adbi-sur-etat`, `--adbi-sur-accent`, `--adbi-sur-orange`.

Deux surfaces restent volontairement claires (documents destinés à
l'impression) : `one-pager/public/onepager.css` et
`cv-parser/templates/company_cv.html`.

## Authentification du CV Parser

**Désactivée en local** : l'application tourne en localhost et n'exige pas de
mot de passe. Le code d'authentification est toujours en place, simplement
court-circuité.

> ⚠️ **À réactiver avant toute exposition Internet** : variable
> d'environnement `ADBI_AUTH=on` (lue dans `cv-parser/core/auth.py`).

## Voyant IA

Le hub affiche un indicateur (chaîne de secours de la passerelle
d'inférence interne ADBI). `server.js` relaie les tests vers la passerelle
via `ADBI_LLM_BASE_URL` / `ADBI_LLM_API_KEY` / `ADBI_LLM_MODELS` (voir
[`.env.example`](.env.example)) : le navigateur ne parle qu'à `/api/llm/chaine`
et `/api/llm/tester`, jamais directement à la passerelle — la clé ne quitte
jamais le serveur. Sans ces variables, le voyant affiche « non configurée »
sans erreur.

## En cas de problème

- « Le module n'a pas démarré » → `logs/<module>.log` contient la sortie de
  l'application. Vérifier ses dépendances (`npm install`/`pip install`) et le
  chemin dans `modules.json`.
- « Application introuvable » → le chemin `modules.json` n'existe pas.
- Un module déjà lancé à la main est détecté : la Factory ne le relance pas.

## Démarrage

```bash
node server.js       # → http://localhost:4000
```

### Docker

```bash
docker build -t adbi-factory .
docker run -p 4000:4000 adbi-factory
```

Utilise `modules.docker.json` par défaut (mode `conteneur`, voir plus haut).
Plus simple pour la plateforme complète : `docker-compose.yml` à la racine du
dépôt, qui démarre la Factory et les 4 autres services ensemble.

Variables d'environnement : voir [`.env.example`](.env.example).
