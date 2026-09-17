# ADBI Contrats + ADBI Sign

Port **4100**. Node + Express, pdfkit, docx, PostgreSQL (`pg`), nodemailer.
Génération et export de contrats, historique, signature électronique par
connecteurs API (Yousign / Zoho Sign).

## Utilisation

- Choisissez le type de contrat dans la barre de gauche. Seule la
  « Convention de sous-traitance » est active à ce jour ; CDI et CDD sont
  prévus (modèles à transmettre — mêmes variables, aperçu, export, checklist).
- Remplissez le formulaire (parties, intervenant, mission, conditions
  financières, suivi, clauses) ; l'aperçu à droite se met à jour en direct.
- Checklist documents (K-bis, URSSAF, assurance, RIB, CNI…) au fur et à mesure
  de la réception des pièces du sous-traitant.
- Export : PDF, Word (.docx), ZIP complet (PDF + Word + checklist), ou
  Enregistrer dans l'Historique.
- Onglet **Historique** : centre de pilotage — accordéon par entreprise,
  avenants imbriqués, alertes de fin de mission, corbeille avec restauration.
- Onglet **✍ Signatures** : suivi des demandes de signature, statistiques,
  import d'un contrat déjà signé, marquage « signé hors application ».

> Le modèle de sous-traitance reprend la Convention ADBI avec quelques
> corrections de cohérence. **Faites relire le modèle par votre service
> juridique avant tout usage contractuel réel.**

## Signature électronique (ADBI Sign)

La signature passe exclusivement par des tiers de confiance via
`lib/fournisseurs/` : **Yousign** (eIDAS 🇫🇷, UE — défaut) et **Zoho Sign**
(région UE). Ordre séquentiel, relances automatiques, dossier de preuve
archivé. Détails, endpoints, checklist RGPD/eIDAS et comparatif fournisseurs :
[`docs/INTEGRATION-SIGNATURE.md`](docs/INTEGRATION-SIGNATURE.md).

Le flux de signature local historique (page `/signer`, jetons, invitations
SMTP) a été retiré au profit de ces connecteurs.

## Données et confidentialité

Tout est local : le serveur n'écoute que sur `127.0.0.1:4100` en dehors d'un
reverse proxy. Rien de la génération de contrat ni de la recherche d'entreprise
ne part vers un tiers. L'analyse de pièces (OCR local, `lib/docanalyze.js`)
reste elle aussi 100% locale par défaut — seules la recherche société
optionnelle (Pappers/INSEE) et la signature (Yousign/Zoho) sont des appels
externes, tous deux à clé et documentés.

Exception opt-in (`DOCIE_EXTRACTION_ENABLED=true`, désactivée par défaut,
issues #153 et #170) : trois pièces de la checklist sont alors envoyées au
service DocIE configuré via le bridge partagé `document-parsing/bridge/`, par
deux voies différentes — voir `lib/docie-extraction.js`.

- **Kbis** — voie agent (`DOCIE_BASE_URL`/`DOCIE_API_KEY`/`DOCIE_AGENT_KBIS`) :
  le PDF ou l'image part entier, les backends OCR de DocIE le lisent, et
  l'agent résout son schéma **par nom** — ce schéma doit donc exister côté
  Studio DocIE. Dès qu'un modèle du catalogue est configuré (#194), le Kbis est
  **choisi par type d'entrée** : un PDF à couche texte complète passe par la voie
  texte (`document-parsing/schemas/kbis.schema.json`, LFM2.5 2.6B par défaut),
  une photo ou un scan par NuExtract3 en vision (`DOCIE_AGENT_KBIS_NUEXTRACT3`,
  8 pages au plus). Même analyse sur les deux voies.
- **Attestation de vigilance URSSAF** — voie texte : la couche texte du PDF est
  lue localement, puis envoyée avec la **définition du schéma dans le corps de
  la requête** (`document-parsing/schemas/urssaf.schema.json`). Aucun
  enregistrement préalable côté Studio, et donc aucun agent à configurer. La
  date de délivrance extraite alimente la validité 6 mois affichée par la
  checklist, à la place de la devinette par regex de l'analyse locale. Le choix
  de la voie se fait **à l'exécution sur le document reçu** : une attestation
  scannée (image, ou PDF dont une page est sans texte) n'est jamais envoyée —
  elle retombe sur l'analyse locale, exactement comme avant, avec un
  avertissement nommant la cause. Sauf si un modèle est choisi (#194, voir
  ci-dessous) : elle est alors refusée, sans analyse locale.
- **RIB** — voie texte, même mécanique (`document-parsing/schemas/rib.schema.json`) :
  titulaire, IBAN, BIC et banque. L'IBAN (clé modulo 97) et le BIC (format)
  sont contrôlés (`lib/iban-bic.js`) ; une valeur douteuse est conservée et
  signalée, jamais vidée.

- **Attestation de régularité fiscale** — voie texte, même mécanique
  (`document-parsing/schemas/fiscale.schema.json`, #215) : dénomination, SIREN,
  SIRET, service des impôts, date de délivrance et mention de régularité. Le
  schéma et la paire de mapping existaient depuis #215 mais n'étaient reliés à
  rien ; ce câblage les rend atteignables. Pas de sélecteur de modèle : la pièce
  reste hors de `lib/choix-modele.js::TACHES` et est lue par le profil DocIE par
  défaut. **La checklist n'offre pas encore de bouton d'analyse pour elle** — le
  bouton OCR est posé sous `dateField`, or une attestation fiscale ne se
  renouvelle pas tous les 6 mois et n'en a pas. Elle n'est donc atteignable que
  par `POST /api/document/analyze`, comme le RIB avant son propre bouton.

Les trois autres pièces restent toujours analysées localement, flag ou pas, et
pas pour la même raison. Coordonnées et informations spécifiques n'ont ni schéma
ni mapping : ce sont des champs de saisie, pas des documents. La **CNI**, elle,
a bien un schéma (`cni.schema.json`) et une paire de mapping (`lib/cni-mapping.js`,
`cni_to_contrats.py`) — elle n'est pas routée ici parce que le catalogue la donne
par la voie **vision** (tâche `cni`), avec le contrôle des chiffres de la MRZ
pour prérequis (`lib/mrz.js`). Sur échec DocIE (config manquante, timeout,
erreur), repli automatique sur l'analyse locale — sauf pour un modèle choisi
(#194) : l'erreur nommée s'affiche, sans repli.

Même flag, autre usage : le pré-remplissage de l'import de contrat depuis un
PDF (`POST /api/contracts/importer/extraire`, bouton « Pré-remplir depuis le
PDF » de la modale d'import) utilise le même bridge avec `DOCIE_AGENT_CONTRACT`
— voir `lib/docie-contract-import.js`. Si des modèles du catalogue sont
configurés (`DOCIE_MODELE_*`, #194, `lib/choix-modele.js`), un sélecteur les
propose et le contrat passe par la voie texte avec le modèle choisi ; un contrat
scanné est alors refusé. Pas de repli local ici (aucune analyse
locale équivalente à 19 champs structurés) : flag off ou agent non configuré
= fonctionnalité simplement absente, saisie manuelle comme avant.

Stocké en **PostgreSQL** (`DATABASE_URL`, requise — voir `lib/schema.sql`) :
historique des contrats, demandes de signature (+ journal), corbeille et
personnalisation des modèles (`templates_perso`). Une instance déjà en place
avec des données sql.js (`data/contrats.sqlite`) se migre avec
`npm run migrer-vers-postgres` (voir `scripts/migrer-vers-postgres.js`) avant
de démarrer le serveur sur cette version.

Stocké dans `data/` (gitignoré, hors `referentiels.json`) :
- `referentiels.json` — clients/managers/signataires (**suivi en git**,
  référentiel partagé à l'équipe)
- `secrets.json` — clés API et réglages SMTP saisis dans Paramètres
- `contrats-generes/<contrat>/` — chaque export archivé horodaté

## Variables d'environnement

Voir [`.env.example`](.env.example) — `DATABASE_URL` (connexion PostgreSQL)
est **requise** au démarrage. Recherche société (Pappers/INSEE), SMTP
et signature électronique (Yousign/Zoho) sont toutes configurables par
variable d'environnement. Sans elles, les mêmes réglages restent saisissables
depuis l'écran Paramètres (écrits dans `data/secrets.json`, hors git) ; une
variable d'environnement est toujours prioritaire.

## Démarrage

```bash
npm ci
DATABASE_URL=postgresql://... node server.js       # → http://localhost:4100
```

Le schéma (`lib/schema.sql`) est appliqué automatiquement au démarrage
(`CREATE TABLE IF NOT EXISTS`, idempotent) — pas de migration manuelle requise
sur une base vierge.

### Docker

```bash
docker compose up -d --build   # démarrer (télécharge/construit l'image)
docker compose logs -f         # suivre les logs
docker compose down            # arrêter
```

Le `docker-compose.yml` de ce dossier lance uniquement le service `contrats` :
il attend une base PostgreSQL déjà joignable via `DATABASE_URL` (typiquement
celle provisionnée par le `docker-compose.yml` racine du dépôt, qui démarre
`postgres` + tous les services ADBI ensemble — voir ce fichier plutôt que
celui-ci pour un lancement complet). `data/` est monté en volume
(`./data:/app/data`) : `referentiels.json`, `secrets.json` survivent à la
reconstruction du conteneur. Port modifiable dans `docker-compose.yml`
(`"4100:4100"` → `"8080:4100"`).
