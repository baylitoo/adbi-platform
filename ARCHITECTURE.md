# Architecture de la plateforme ADBI Factory

> Document de référence — de A à Z — des modules, de leurs schémas, de leurs choix
> techniques, et des pratiques de sécurité / fiabilité / évolutivité.
> Dernière mise à jour : 4 septembre 2026 — vue Signatures intégrée à ADBI
> Contrats, import de contrats existants (PDF signé), mention « signé » externe,
> mascotte 3D du hub, déploiement conteneurisé (Docker/Coolify + PostgreSQL)
> comme chemin recommandé.

---

## 1. Vue d'ensemble

La plateforme est une **suite d'outils internes ADBI**, chacun étant une application
web autonome, orchestrée par un hub central (**ADBI Factory**). Tout tourne **en
local** sur le poste : aucune donnée métier ne quitte la machine (sauf appels
explicitement documentés : annuaire public gouv.fr, passerelle d'inférence
interne ADBI, envoi SMTP).

```
                        ┌───────────────────────────────────────────┐
                        │       ADBI FACTORY  (hub, port 4000)      │
                        │  Node natif, zéro dépendance npm          │
                        │  • tuiles + rail + mascotte 3D            │
                        │  • démarre/arrête les modules — spawn en  │
                        │    local, ou attend le conteneur en       │
                        │    déploiement (modules.docker.json)      │
                        │  • préchauffage au démarrage              │
                        │  • sert la charte commune (theme/)        │
                        │  • voyant IA relayé vers la passerelle    │
                        └───────┬───────────────────────────────────┘
                                │  iframes + surveillance des ports
      ┌────────────────┬──────────────┼─────────────┬─────────────────┐
      ▼                ▼              ▼             ▼                 ▼
┌─────────────┐ ┌────────────┐ ┌───────────┐ ┌───────────┐ ┌──────────────┐
│    ADBI     │ │    ADBI    │ │   ADBI    │ │   ADBI    │ │     ADBI     │
│  Contrats   │ │  OnePager  │ │  Coffre   │ │  Parser   │ │  (supprimé)  │
│  Node 4100  │ │ Node 4200  │ │ Node 4300 │ │Flask 5000 │ │              │
│ (+ onglet ✍ │ │            │ │           │ │Python3.14 │ │              │
│  ADBI Sign) │ │            │ │           │ │           │ │              │
└──────┬──────┘ └──────┬─────┘ └───────────┘ └─────┬─────┘ └──────────────┘
       │               │                            │
       └───────────────┴─────────────┬──────────────┘
                                      ▼
                    ┌───────────────────────────────────┐
                    │  PostgreSQL (adbi-postgres)        │  une base par service :
                    │  adbi_contrats / adbi_cv_parser /  │  provisionnée (milestone 4),
                    │  adbi_one_pager                    │  migration en cours service
                    └───────────────────────────────────┘  par service — voir
                                                             docs/postgres-inventory.md
      +  ADBI Calculator : page statique servie par la Factory elle-même

      Passerelle d'inférence interne ADBI (hors plateforme, VM dédiée) : seul
      tiers réseau autorisé pour l'IA — Parser (extraction) et voyant IA du hub
      (`ADBI_LLM_BASE_URL`/`ADBI_LLM_API_KEY`, jamais exposée au navigateur).
```

| Module | Produit | Port | Stack | Dossier |
|---|---|---|---|---|
| Hub | **ADBI Factory** | 4000 | Node natif (http, net, child_process) | `factory/` |
| Contrats | **ADBI Contrats** | 4100 | Node + Express, pdfkit, docx, sql.js, nodemailer | `contrats/` |
| Signature | **ADBI Sign** | — | onglet « ✍ Signatures » d'ADBI Contrats (pas de tuile Factory) | — |
| One pager | **ADBI OnePager** | 4200 | Node + Express | `one-pager/` |
| Coffre | **ADBI Coffre** | 4300 | Node + Express, crypto natif | `coffre/` |
| Calculatrice | **ADBI Calculator** | — (statique) | HTML/JS servie par la Factory | `factory/public/modules` |
| CV Parser | **ADBI Parser** | 5000 | Python 3.14 + Flask + Docling | `cv-parser/` |

---

## 2. ADBI Factory — le hub (port 4000)

### Rôle
- Page d'accueil : tuiles des modules (état en direct), rail de navigation,
  bascule clair/sombre, **mascotte 3D animée** (three.js local, `mascotte.glb`).
- **Cycle de vie** : démarre chaque module (`child_process.spawn`, journaux dans
  `logs/<id>.log`), surveille son port TCP, l'arrête à la fermeture de la Factory.
- **Préchauffage** : au lancement, tous les services démarrent en arrière-plan,
  échelonnés (800 ms), les plus rapides d'abord — au premier clic, tout est prêt.
  Désactivable : `ADBI_SANS_PRECHAUFFAGE=1` ou `"prechauffage": false`.
- Sert la **charte commune** (`theme/adbi-theme.css|js`) et ses polices.
- **Voyant IA** (`/api/llm/chaine`, `/api/llm/tester`) : relaie les tests vers
  la passerelle d'inférence interne ADBI pour le compte du navigateur — la clé
  (`ADBI_LLM_API_KEY`) reste côté serveur, jamais servie en JS.

### Registre des modules — `modules.json`
Quatre types d'entrées :

| type | comportement |
|---|---|
| `service` | app à part entière : `dossier`, `entree`, `port`, `commande`/`arguments` optionnels (Python…), `delai` d'attente. **Ou**, en déploiement conteneurisé, `conteneur: true` + `hote` (nom du service docker-compose) : la Factory ne lance alors jamais de processus, elle attend seulement que le module — démarré par son propre conteneur — réponde. Voir `factory/modules.docker.json` et `factory/README.md`. |
| `statique` | page servie par la Factory (`url` relative) — ex. ADBI Calculator |
| `lien` | **alias vers la vue d'un autre module** : `cible` + `chemin` (fragment ajouté à l'URL). État et démarrage délégués à la cible. Capacité disponible mais aucune tuile ne l'utilise actuellement (l'ex-tuile ADBI Sign a été retirée au profit de l'onglet interne) |
| `bientot` | tuile grisée d'annonce |

### Flux d'ouverture d'un module
```
clic tuile → /module.html?m=<id>
   │
   ├─ GET /api/modules  ────────── état (port ouvert ? processus vivant ?)
   ├─ si arrêté : POST /api/modules/<id>/demarrer
   │      └─ spawn + attendrePort (jusqu'à `delai` s) → journal si échec
   └─ iframe src = url#adbi-theme=<clair|sombre>   ← le thème voyage dans le
                                                     fragment, zéro clignotement
```

### Charte graphique (CYNOV, bleue)
- Source unique : `adbi-factory/theme/` → recopiée dans chaque app par
  `node scripts/sync-theme.js`. **Ne jamais éditer les copies.**
- Clair par défaut, sombre au bouton ; accent `#1665c1`, nuit `#0d3a8c`,
  orange `#f26522` réservé aux alertes. **Jamais de vert ni de rose.**

---

## 3. ADBI Contrats + ADBI Sign (port 4100)

Le module le plus riche : génération de contrats **et** signature électronique.

### Schéma interne
```
                       ┌──────────────────────── server.js (Express) ───────────────────────┐
                       │                                                                    │
  public/  (front)     │   lib/template.js ── source de vérité des modèles (256 blocs)      │
  ├─ index.html        │        │  + data/templates-perso.json (retouches Paramètres)       │
  ├─ app.js  (SPA)     │        ▼                                                           │
  ├─ signer.html ◄─────┼─ lib/templates-perso.js → templates EFFECTIFS partout              │
  └─ styles.css        │        │                                                           │
                       │        ├─► lib/render.js      (fill {{var}}, **gras**, runs)       │
   data/               │        ├─► public/app.js      (aperçu HTML live)                   │
   ├─ contrats.sqlite  │        ├─► lib/render-docx.js (export Word)                        │
   │   (sql.js WASM :  │        └─► lib/render-pdf.js  (export PDF + signatures apposées    │
   │    contrats,      │                                + paraphes + buildCertificatPdf)    │
   │    signatures)    │                                                                    │
   ├─ referentiels.json│   lib/signatures.js  (demandes, jetons, ordre séquentiel, délais)  │
   ├─ secrets.json     │   lib/mailer.js      (nodemailer + gabarits HTML brandés ADBI)     │
   ├─ templates-perso  │   lib/integrations.js(annuaire gouv.fr / Pappers / INSEE, secrets) │
   └─ contrats-generes/│   lib/docanalyze.js  (OCR local Kbis/URSSAF : pdf-parse+tesseract) │
       └─ <contrat>/   │                                                                    │
          (archives    └────────────────────────────────────────────────────────────────────┘
           horodatées)
```

### Fonctionnalités clés
- **Éditeur assistant** par étapes (9 onglets), aperçu fidèle en direct, recherche
  société par nom/SIREN (annuaire public), référentiels (clients enrichis,
  managers, signataires, **sous-traitants complets** via « ＋ Ajouter »).
- **Historique = centre de pilotage** : accordéon par entreprise (fiche annuaire
  au clic), avenants imbriqués sous leur contrat parent, alertes rouges de fin de
  mission (« créer l'avenant » pré-rempli / « clôturer »), sélection groupée,
  filtre, mode modification (plus de doublons), badges de signature intégrés.
- **Stockage** : chaque export (PDF/Word/ZIP) archivé horodaté dans
  `data/contrats-generes/<contrat>/` — rien n'est écrasé.
- **Éditeur de modèles** (Paramètres) : le texte des 245 blocs + titres/en-tête/
  pied modifiables ; retouches par-dessus le modèle d'origine, réversibles,
  ignorées si le modèle de base a changé à cet endroit (anti-décalage).

### Registre complet des contrats (créés, importés, signés)
- **Vue « Signatures » dans l'application** (nav ✍, pastille « à vous de signer ») :
  statistiques (orange = en attente, vert = signées), toutes les demandes avec
  leurs actions. **ADBI Sign vit UNIQUEMENT ici** (la tuile Factory a été retirée
  le 2026-09-04) ; le lien direct `http://localhost:4100/#signatures` reste valable.
- **Import d'un contrat existant** (créé hors application) : bouton « ⬆ Importer »
  — PDF (souvent déjà signé) + infos clés (n°, sous-traitant, client final,
  consultant, TJM, dates début/fin, date de signature). La ligne rejoint
  l'historique et alimente alertes de fin, fiche entreprise et récaps d'avenant
  comme un contrat créé ici (`POST /api/contracts/importer`, PDF archivé
  `__SIGNE-IMPORTE.pdf` dans le dossier du contrat).
- **Signature EXTERNE** : un contrat signé hors application (papier, autre
  outil) se marque « ✔ signé » (menu ⋮ → « Marquer signé (hors app) ») avec la
  date et le PDF signé en pièce jointe, archivé dans le dossier (colonne
  `signe`, `POST/DELETE /api/contracts/:id/signe`). Badge VERT cliquable →
  fichiers du contrat.
- **Code couleur signatures** : VERT = signé (`#1a9e57`), ORANGE = en attente
  (`#f26522`) — exception assumée à la charte « sans vert », limitée à ces statuts.
- **Corbeille** (fiabilité) : toute suppression (contrat, demande de signature)
  passe par une **double confirmation insistante** puis part dans la table
  `corbeille` au lieu d'être perdue. Paramètres → « 🗑 Corbeille » : liste à
  cases, **restauration sélective** (une demande restaurée réactive ses liens
  d'origine), purge définitive elle-même doublement confirmée.
  Routes : `GET /api/corbeille`, `POST /api/corbeille/restaurer|purger`.

### ADBI Sign — signature par CONNECTEURS API (depuis le 4 sept. 2026)

**Le flux de signature local (page /signer, jetons, invitations SMTP) a été
RETIRÉ** : la signature passe exclusivement par des tiers de confiance via
l'abstraction `lib/fournisseurs/` (interface : `verifier`, `creerEnveloppe`,
`statutEnveloppe`, `telechargerSigne`, `telechargerPreuve`).

- Connecteurs livrés : **Yousign** (eIDAS 🇫🇷, données UE — défaut ; sandbox
  gratuite puis production, OTP e-mail) et **Zoho Sign** (région UE
  `sign.zoho.eu` ; OAuth2 automatisé — l'échange du code self-client se fait
  depuis les Paramètres, le refresh token est géré côté serveur). Dans les deux
  cas : ordre séquentiel, relances automatiques, champs posés aux coordonnées
  réelles du cadre « Signature » du PDF, dossier de preuve archivé.
- Suivi : `POST /api/signatures/:id/synchroniser` (polling) et
  `POST /webhooks/signature` (HMAC vérifié, contenu jamais cru — l'API est
  relue) ; à la complétion, **PDF signé + dossier de preuve archivés** dans le
  dossier du contrat.
- Demandes locales signées avant la bascule : toujours lisibles (PDF/certificat
  maison régénérés). Détails, endpoints, checklist RGPD/eIDAS et comparatif
  fournisseurs : `adbi-contrats/docs/INTEGRATION-SIGNATURE.md`.

### Ancien flux local (retiré — mémo historique)
```
« Envoyer en signature »
   │  fige le payload, archive __POUR-SIGNATURE.pdf, empreinte SHA-256,
   │  jeton 48 hex/partie, ancre le contrat dans l'historique s'il n'y est pas
   ▼
 e-mail AUTO au 1er signataire (co-contractant)          [SMTP des Paramètres ;
   │   page /signer/<jeton> : parcours ①Relire ②Signer    sans SMTP : liens +
   │   ③Terminé, dessin / nom manuscrit (Great Vibes) /   brouillons mailto]
   │   image, initiales (paraphe), cachet, « Lu et
   │   approuvé », délai à respecter (prolongeable)
   ▼
 signature 1 posée ──► e-mail AUTO au 2e (ADBI) « à votre tour » + pastille
   ▼                                                      dans l'application
 signature 2 posée ──► PDF FINAL (signatures + paraphes chaque page + cachets)
                       + CERTIFICAT SÉPARÉ (référence, horodatages, empreinte,
                       mention eIDAS) → archivés, envoyés aux DEUX parties en
                       pièces jointes
```
Règles : ordre **séquentiel strict** (le 2e est bloqué tant que le 1er n'a pas
signé), délai bloquant après échéance (prolongation en un clic), suppression
d'une demande = liens morts immédiatement.

---

## 4. ADBI Parser (port 5000)

Extraction structurée de CV, **bibliothèques d'abord, IA seulement si besoin**.

```
dépôt CV ──► empreinte SHA-256 ── déjà connue ? ──► fiche reprise (~0,5 s)
                │ non
                ▼
        extraction LOCALE (Docling, OCR désactivé, singleton préchargé)
                │
        extraction_suffisante ? (nom, titre, ≥2 exp, ≥5 compétences)
                │ oui → fiche servie sans IA
                │ non
                ▼
        Passerelle d'inférence interne ADBI UNIQUEMENT (choix documenté dans
        llm_cascade.py — ne jamais réintroduire OpenAI/OpenRouter/OVHcloud) :
        sondage par vagues de 3, budget temps global, progression réelle par
        jeton (plus de faux 88 %)
```
- Import par lot : 2 envois parallèles. Bouton « Relancer l'analyse » par fiche.
- Base locale + dossiers de compétences générés.

## 5. ADBI OnePager (port 4200)
CV → dossier de compétences ADBI en une page. Extraction 100 % locale.

## 6. ADBI Coffre (port 4300)
Protection de documents, tout en local :
- **Détection** d'informations sensibles (noms, e-mails, téléphones, IBAN,
  photos) partagée navigateur/serveur (`detecteurs.js`).
- **Masquage** au choix (XXXX) : *protégé* (l'original chiffré AES-256-GCM est
  embarqué dans le fichier de sortie, même format que l'entrée, déchiffrable sur
  ce poste via la clé locale `data/cle-locale.bin` — **à sauvegarder**) ou
  *anonymisé* (définitif, marqueurs dédiés).
- **Archives ZIP à clé** (AES-256, WinZip AE-2) pour fichiers/dossiers.

## 7. ADBI Calculator (statique)
Simulation TJM/CJM : marge, coût, point mort. Une page, zéro serveur.

## 8. ADBI Gestion — SUPPRIMÉ

Le module de pilotage ESN (Django, port 4400) a été retiré de la plateforme le
4 septembre 2026 puis **supprimé définitivement du poste** le même jour, sur
confirmation explicite de l'utilisateur. Il n'a jamais été déployé.


---

## 9. Sécurité — état des lieux et règles

### En place
| Mesure | Où |
|---|---|
| Tout en local, bind principal 127.0.0.1 (Factory) | hub |
| Aucune clé/API dans le code : variables d'environnement, repli sur `data/secrets.json` (gitignoré) | Contrats |
| Mots de passe SMTP jamais renvoyés au front (`settingsStatus` expose des booléens) | Contrats |
| Jetons de signature aléatoires forts (`crypto.randomBytes(24)`, 48 hex) + validation stricte (`/^[a-f0-9]{48}$/`) — flux local historique, conservé en lecture seule | Sign |
| Anti-traversée de chemin : `path.basename` sur les téléchargements, garde `startsWith(PUBLIC)` | Contrats, Factory |
| Entrées SQL : identifiants passés par `parseInt`, valeurs par requêtes paramétrées (`db.run(sql, [...])`) | Contrats |
| Échappement HTML systématique côté front (`escapeHtml` sur toute donnée affichée) | tous |
| Uploads bornés (JSON 15 Mo ; images de signature 4 Mo, re-encodées en PNG via canvas — jamais insérées telles quelles) | Contrats |
| Chiffrement AES-256-GCM avec AAD, clé locale hors dépôt | Coffre |
| IA : passerelle d'inférence interne ADBI uniquement (aucun tiers), OCR pièces 100 % local | Parser, Contrats |
| Voyant IA du hub : appels à la passerelle relayés côté serveur (`/api/llm/*`), clé jamais exposée au navigateur | Factory |
| Frame-ancestors restreint à la Factory (à la place du clickjacking Django par défaut) | Gestion |
| Erreurs jamais fatales côté serveurs (garde-fous `uncaughtException`) : rester en ligne | Contrats, Factory |

### Secrets par variable d'environnement

Chaque service documente ses variables dans son `<service>/.env.example`.
Convention commune : une variable d'environnement est **toujours prioritaire**
sur le fichier local qu'elle remplace (`data/secrets.json`, `code-parametres.txt`…) —
un déploiement peut donc tourner sans jamais écrire de secret sur disque.

| Service | Variables clé | Repli si absentes |
|---|---|---|
| contrats | `PAPPERS_API_KEY`, `INSEE_API_KEY`, `SMTP_*`, `YOUSIGN_*`, `ZOHO_*`, `ADBI_CODE_PARAMETRES` | `data/secrets.json` / `data/code-parametres.txt` (écran Paramètres) |
| cv-parser | `ADBI_JWT_SECRET`, `ADBI_AUTH`, `ADBI_SUPERUSER_EMAIL`, `ADBI_SUPERUSER_PASSWORD` | `data/jwt_secret.txt` généré ; superuser par défaut `admin@adbi.fr` (dev uniquement) |
| coffre | — (pas de clé API) | `data/cle-locale.bin`, générée au 1er lancement — **pas de repli possible, à sauvegarder** |
| factory | `ADBI_PORT`, `ADBI_SANS_PRECHAUFFAGE` | valeurs par défaut (4000, préchauffage actif) |
| one-pager | `PORT` | 4200 |

### Injection des secrets sous Coolify

- Toutes les variables ci-dessus se posent comme **variables d'environnement
  natives Coolify** par service (pas de fichier `.env` à committer ni à copier
  à la main).
- `coffre/data/cle-locale.bin` n'est **pas** un secret injectable par variable
  (généré au 1er démarrage, doit persister) : monter `coffre/data/` en volume
  Coolify et le sauvegarder comme n'importe quelle donnée applicative — sa
  perte rend irrécupérables tous les documents « protégés » émis.
- `ADBI_CODE_PARAMETRES` et `ADBI_SUPERUSER_PASSWORD` sont à générer (pas de
  valeur réutilisée d'un autre environnement) et à poser **avant** le premier
  démarrage du service concerné — les valeurs par défaut du code ne doivent
  jamais atteindre un environnement exposé.
- `ADBI_AUTH=on` est **obligatoire** dès que cv-parser n'est plus derrière la
  Factory en localhost (voir factory/README.md).

### Avant toute exposition Internet (déploiement)
1. **Reverse proxy HTTPS** devant chaque service.
2. Tous les secrets ci-dessus posés par variable d'environnement (aucune
   valeur par défaut du code en production).
3. `ADBI_AUTH=on` sur cv-parser.
4. Sauvegardes régulières des volumes `data/` (et, une fois la migration
   faite, de l'instance PostgreSQL — milestone 4).
5. Ne déployer que Contrats/Sign, OnePager, Coffre, Calculator, Parser
   (ADBI Gestion n'a jamais fait partie de ce dépôt).

## 10. Fiabilité
- **Préchauffage** : tout est prêt ~3 s après l'ouverture (90 s pour Parser).
- **Journaux** par module (`adbi-factory/logs/<id>.log`) ; en cas d'échec de
  démarrage, la Factory remonte les 6 dernières lignes dans l'interface.
- **Archivage systématique** des contrats générés (rien d'écrasé, horodatage).
- **SQLite en WASM** (sql.js) : aucun binaire natif, portable partout ; écriture
  atomique par ré-export du fichier.
- Les échecs optionnels sont silencieux et n'abîment jamais le cœur : mascotte
  3D, enrichissement annuaire, envoi SMTP (repli sur mailto), fiche entreprise.

## 11. Évolutivité
- **Ajouter un module** = 1 entrée dans `modules.json` (aucun code Factory).
- **Ajouter un type de contrat** = 1 template dans `lib/template.js` + champs
  dans `lib/fields.js` (les 3 rendus HTML/PDF/DOCX consomment les mêmes blocs).
- **Personnalisation sans code** : textes des modèles (Paramètres), référentiels,
  seuils métier (Gestion : `config/settings.py`, constantes commentées).
- Volumes : sql.js et JSON conviennent à l'échelle d'une ESN (centaines de
  contrats). Au-delà de ~10 000 lignes ou multi-utilisateurs simultanés :
  passer à SQLite natif (better-sqlite3) ou PostgreSQL — l'accès est déjà isolé
  derrière quelques fonctions (`chargerDemandes`, `persist`…).

## 12. Démarrage & exploitation

### Déploiement (Coolify / tout hôte Docker) — chemin recommandé

```bash
git clone <dépôt> adbi-platform && cd adbi-platform
cp .env.example .env      # renseigner les variables REQUIS
docker compose up -d --build
```

`docker-compose.yml` construit et lance les 5 services + PostgreSQL (une base
par service). Sous Coolify : importer comme *docker-compose resource*, un
domaine par service, secrets posés comme variables d'environnement natives
(jamais de fichier `.env` committé) — détail complet dans le
[`README.md`](README.md) et la §9 ci-dessus. C'est le chemin qui remplace
l'ancien guide `ADBI-Deploiement-Serveur.docx` (systemd, un seul hôte) pour
tout nouveau déploiement ; le `.docx` reste valable pour un hôte sans Docker
mais n'est plus le chemin recommandé.

### Développement local (poste de dev, sans Docker)

```bash
cd factory && node server.js
# → http://localhost:4000   (fermer la fenêtre = tout s'arrête proprement)
```
- Raccourcis bureau : « ADBI Factory », « ADBI - Contrats ».
- Sauvegardes à faire régulièrement : les dossiers `data/` de chaque module
  (bases, référentiels, clé du Coffre, contrats générés) — et, une fois la
  migration PostgreSQL faite service par service (milestone 4), le volume
  `postgres-data` du conteneur `postgres`.
