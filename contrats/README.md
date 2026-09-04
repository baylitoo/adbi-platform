# ADBI Contrats + ADBI Sign

Port **4100**. Node + Express, pdfkit, docx, sql.js (SQLite en WASM),
nodemailer. Génération et export de contrats, historique, signature
électronique par connecteurs API (Yousign / Zoho Sign).

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
reverse proxy. Rien de la génération de contrat, de la recherche d'entreprise
ni de l'analyse de pièces (OCR local, `lib/docanalyze.js`) ne part vers un
tiers — seules la recherche société optionnelle (Pappers/INSEE) et la
signature (Yousign/Zoho) sont des appels externes, tous deux à clé et
documentés.

Stocké dans `data/` (gitignoré, hors `referentiels.json`) :
- `contrats.sqlite` — historique des contrats et demandes de signature
- `referentiels.json` — clients/managers/signataires (**suivi en git**,
  référentiel partagé à l'équipe)
- `secrets.json` — clés API et réglages SMTP saisis dans Paramètres
- `contrats-generes/<contrat>/` — chaque export archivé horodaté

## Variables d'environnement

Voir [`.env.example`](.env.example) — recherche société (Pappers/INSEE), SMTP
et signature électronique (Yousign/Zoho) sont toutes configurables par
variable d'environnement. Sans elles, les mêmes réglages restent saisissables
depuis l'écran Paramètres (écrits dans `data/secrets.json`, hors git) ; une
variable d'environnement est toujours prioritaire.

## Démarrage

```bash
npm ci
node server.js       # → http://localhost:4100
```

### Docker

```bash
docker compose up -d --build   # démarrer (télécharge/construit l'image)
docker compose logs -f         # suivre les logs
docker compose down            # arrêter
```

`data/` est monté en volume (`./data:/app/data`) : `referentiels.json`,
`contrats.sqlite`, `secrets.json` survivent à la reconstruction du conteneur.
Port modifiable dans `docker-compose.yml` (`"4100:4100"` → `"8080:4100"`).
