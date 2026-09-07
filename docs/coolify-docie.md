# ADBI sur Coolify, DocIE comme passerelle

## État et limites

Configuration pour une **nouvelle installation** : `docker-compose.yml`.
Ne remplacez pas le compose d'une installation existante sans migrer ses données :
les nouveaux volumes nommés ne reprennent pas automatiquement les bind mounts.
Le déploiement distant n'a pas été effectué par ces changements.

L'extraction par défaut utilise `POST /v1/extract/text` avec `schema_mode=dynamic`
et le schéma complet `cv-parser/adbi_resume.schema.json` dans chaque requête.
Aucune inscription/modification de schéma distant. Les PDF texte sont lus par
pypdf, les DOCX par leur XML ; aucune dépendance Torch/Docling.
Une page PDF sans texte provoque une erreur explicite, y compris dans un PDF mixte.
**Les scans ne sont pas encore pris en charge dans ce mode.** La route distante
PDF ne propose pas de schéma inline dans le contrat inspecté. Une route LiteParse
vers texte/blocs reste à intégrer. `DOCIE_OCR_BACKEND` n'agit pas en mode inline.
Le mode historique `studio` nécessite un schéma stocké compatible et un serveur
capable de retourner les résultats ; il n'est pas activé dans ce compose.

## Préparer Coolify

1. Publier les changements vérifiés sur une branche du dépôt accessible à Coolify.
   Ne pas inclure `.env*`, CV personnels, sauvegardes ou résultats de tests locaux.
2. Nouvelle application depuis le dépôt Git, build pack **Docker Compose**.
   Sélectionner `master` et `/docker-compose.yml` (nom standard).
3. Configurer les variables ci-dessous dans Coolify. Les secrets sont des valeurs
   d'exécution, jamais des arguments de build. Ne pas coller `.env.remote` dans Git.
4. Attribuer les domaines HTTPS aux services avec le port cible indiqué :

| Service | Exemple de domaine Coolify | Variable URL utilisée par le hub |
|---|---|---|
| factory | `https://outils.example.com:4000` | — |
| one-pager | `https://onepager.example.com:4200` | `ADBI_ONEPAGER_URL=https://onepager.example.com` |
| contrats | `https://contrats.example.com:4100` | `ADBI_CONTRATS_URL=https://contrats.example.com` |
| coffre | `https://coffre.example.com:4300` | `ADBI_COFFRE_URL=https://coffre.example.com` |
| cv-parser | `https://parser.example.com:5000` | `ADBI_PARSER_URL=https://parser.example.com` |

Ne pas attribuer de domaine à Postgres. Aucun port hôte n'est publié par ce compose.
Les ports dans les domaines Coolify désignent les ports internes de routage ;
les URL publiques configurées dans ADBI n'ont pas ces ports.

## Variables d'exécution

```dotenv
POSTGRES_USER=adbi
POSTGRES_PASSWORD=<secret-aleatoire-hexadecimal>
ADBI_CODE_PARAMETRES=<secret-distinct>
ADBI_JWT_SECRET=<secret-aleatoire-long>
ADBI_SUPERUSER_EMAIL=<email-administrateur>
ADBI_SUPERUSER_PASSWORD=<mot-de-passe-fort>
DOCIE_BASE_URL=https://docie.example.com
DOCIE_CHAT_BASE_URL=https://docie.example.com/v1
DOCIE_API_KEY=<cle-DocIE-dediee-a-ADBI>
DOCIE_MODEL_PROFILE=lfm2.5-2.6b
DOCIE_CHAT_MODEL=lfm2.5-2.6b
DOCIE_TIMEOUT_SECONDS=360
```

Ajouter les quatre variables URL du tableau. Choisir un mot de passe Postgres
hexadécimal évite les caractères nécessitant un encodage dans DATABASE_URL.
Les variables d'intégrations contrats (SMTP, signature, etc.) restent optionnelles.
`.env.remote` sert aux tests locaux : Coolify ne le lit pas automatiquement.
Les réglages de chaîne LLM déjà sauvegardés dans le Parser peuvent prendre priorité
sur l'environnement : revenir aux réglages d'environnement dans son interface.

## Sécurité avant ouverture publique

- Activer TLS valide pour ADBI et DocIE. Ne pas envoyer de CV ou clés sur Internet
  en HTTP. Ne pas désactiver la vérification des certificats.
- Restreindre tous les modules à des utilisateurs autorisés via VPN ou passerelle
  d'accès authentifiée. Le Parser impose son authentification, mais le hub expose
  notamment un test LLM public ; le code paramètres de Contrats n'est pas une
  authentification globale. Vérifier aussi l'accès direct aux sous-domaines.
- Les clés de fournisseurs tiers restent **dans le déploiement DocIE**, en secrets
  d'exécution ou dans le mécanisme de secrets pris en charge par ce service. ADBI
  n'a que la clé de passerelle. Ne pas mettre de clé fournisseur dans le navigateur,
  un fichier versionné, les logs ou les arguments Docker de build.
- Configurer les profils fournisseur, quotas et droits côté DocIE après validation
  de son mécanisme réel ; ce changement n'ajoute aucun fournisseur ni clé distante.
  Un fournisseur tiers recevra les données routées vers lui : décider explicitement
  quels CV peuvent lui être transmis. Aucun basculement automatique ajouté ici.

## Déploiement et vérification

Déployer après protection des accès. Vérifier la santé des six conteneurs, ouvrir
le hub, tester chaque tuile et la connexion administrateur au Parser. Importer un
CV synthétique texte : la requête doit utiliser le profil choisi et `adbi_resume`.
Prévoir jusqu'à 360 secondes côté DocIE ; le budget de tokens se règle dans DocIE,
indépendamment du timeout ADBI. Le test précédent a pris environ 128 secondes.
Une erreur ou un timeout ne doit pas produire de CV inventé.

Les volumes `postgres-data`, `contrats-data`, `onepager-data`, `coffre-data`,
`parser-data`, `parser-uploads`, `parser-output` doivent être sauvegardés.
La perte de `coffre-data/cle-locale.bin` rend les documents protégés irrécupérables.
Tester restauration et persistance après redéploiement avant d'importer des données
réelles. Ne jamais utiliser `docker compose down -v` pour mettre à jour.

Références Coolify : [Compose](https://coolify.io/docs/knowledge-base/docker/compose),
[variables](https://coolify.io/docs/knowledge-base/environment-variables),
[domaines](https://coolify.io/docs/knowledge-base/domains).
