# ADBI Coffre — protection locale de documents

Port **4300**. Node + Express, aucune dépendance npm (crypto/zlib/zip natifs ;
pdfjs et pdf-lib embarqués en local dans `public/lib`, aucun CDN — fonctionne
hors ligne).

## Le principe

Trois onglets :

1. **Protéger un document** : déposez un PDF ou un Word (.docx). L'application
   l'analyse sur ce poste/serveur et détecte les informations sensibles ; vous
   cochez ce qui doit être masqué — les zones sont recouvertes de caches
   « XXXX ». Le fichier produit garde son format, en deux modes :
   - **PROTÉGÉ** (réversible) : l'original complet, chiffré, est embarqué dans
     le fichier ; déchiffrable via la clé locale, sans mot de passe.
   - **ANONYMISÉ** (définitif) : aucun original embarqué — les informations
     masquées sont supprimées pour toujours. Anonymisation au sens RGPD.
2. **Fichier / dossier à clé** : n'importe quel fichier, ou un dossier entier,
   devient une archive ZIP chiffrée en AES-256 (WinZip AE-2). À l'ouverture
   (7-Zip, WinRAR…), la clé est demandée.
3. **Déchiffrer** : déposez un document protégé, il redevient l'original
   exact, à l'octet près. Un document anonymisé est refusé — il n'y a rien à
   récupérer, c'est le but.

## La clé locale (au lieu d'un mot de passe)

Le chiffrement utilise une clé créée au premier lancement dans
`data/cle-locale.bin` (gitignoré). Conséquences :
- Le déchiffrement se fait sur une instance détenant cette clé. Un
  destinataire du fichier protégé lit la version masquée, mais ne peut pas
  récupérer l'original.
- Pour qu'une autre instance ADBI puisse déchiffrer : copier
  `data/cle-locale.bin` au même endroit.
- **Sauvegardez cette clé** : la perdre rend tous les originaux embarqués
  définitivement irrécupérables. Aucune récupération possible.
- Toute personne ayant accès au serveur peut déchiffrer : la protection vaut
  ce que vaut l'accès à la machine.

## Ce qui est détecté automatiquement

Avec validation arithmétique quand elle existe (clé IBAN, formule de Luhn, clé
du n° de sécurité sociale, clé de TVA) pour éviter les fausses alertes :
- noms et prénoms (dictionnaire, civilités, étiquettes, motif « Prénom
  NOMENMAJUSCULES », en-tête de document, prénoms composés, particules)
- photos et images (photo d'identité, tampon, signature scannée — remplacées
  par un pavé gris dans l'archive)
- e-mails, téléphones, IBAN, cartes bancaires, SIREN/SIRET, n° TVA
  intracommunautaire, numéros de sécurité sociale
- adresses postales, codes postaux + villes, dates, montants, plaques
  d'immatriculation, profils en ligne (LinkedIn, GitHub…)

La détection des noms reste heuristique. Dans un PDF, cliquez une zone pour la
basculer, ou surlignez n'importe quel texte pour un masquage manuel. Dans un
Word, cochez dans la liste.

## Le fichier protégé

- PDF : pages ré-imagées — le texte masqué est réellement absent (aucun texte
  extractible), caches aux couleurs ADBI.
- Word : les valeurs choisies sont remplacées par des ▓ dans le texte (mise en
  page préservée).
- Dans les deux cas : l'original chiffré (AES-256-GCM) voyage dans le fichier.
- « Masquer tout le document » remplace le contenu par une page neutre,
  l'original chiffré toujours embarqué.

## Limites connues

- PDF déjà verrouillés par mot de passe et documents de plus de 60 pages :
  refusés. PDF scannés : pas de texte détectable, « Masquer tout » possible.
- Autres formats (Excel, images…) : pas encore gérés en « même format ».
- Taille maximale : 512 Mo.

## Sous le capot (pour audit)

- AES-256-GCM ; clé de fichier dérivée de la clé locale par HKDF-SHA256 avec
  sel unique par fichier (format ADBIC2). L'ancien mode mot de passe (ADBIC1,
  scrypt N=2^17) reste lisible et disponible par l'API.
- Conteneur chiffré : magic + paramètres + sel + IV en en-tête authentifié
  (AAD), données, étiquette GCM ; le nom d'origine est dans la partie chiffrée.
- Analyse/rendu PDF : pdfjs ; assemblage PDF : pdf-lib ; Word : lecture et
  écriture ZIP maison (zlib natif) + réécriture des `w:t`, dans `docx.js`.

## API locale (pour les autres applications ADBI)

En-têtes : `X-Nom-Fichier` (encodeURIComponent) ; `X-Cle` facultatif (sans
lui, clé locale ; avec lui, mot de passe scrypt).

```
POST /api/chiffrer        corps = fichier brut  → conteneur chiffré
POST /api/dechiffrer      corps = conteneur, PDF ou Word protégé → original
POST /api/docx/analyser   corps = .docx → { detections: [...] }
POST /api/docx/proteger   corps = .docx, X-Zones="1,4" | "toutes" | X-Tout=1
GET  /api/sante
```

## Démarrage

```bash
npm ci
node server.js       # → http://localhost:4300
```

Variables d'environnement : voir [`.env.example`](.env.example).
