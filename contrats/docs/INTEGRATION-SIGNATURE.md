# Signature électronique par connecteurs API — architecture & conformité

> ADBI Contrats signe **exclusivement via des connecteurs API** de tiers de
> confiance (l'ancien flux de signature local a été retiré le 4 septembre 2026).
> Connecteurs livrés : **Yousign** (eIDAS, France — défaut) et **Zoho Sign**
> (région UE possible). Ce document couvre l'architecture, les endpoints, la
> configuration, la conformité RGPD/eIDAS et le comparatif des fournisseurs.

---

## 1. Architecture

```
 Navigateur (public/app.js)                    ADBI Contrats (server.js, port 4100)
 ───────────────────────────                   ──────────────────────────────────────
 « ✍ Signature » (éditeur)  ── POST /api/signatures ──►  1. buildPdf() + positions des
 onglet ✍ Signatures                                        cadres de signature capturées
 (statuts, synchroniser,                                  2. demande figée (empreinte
 PDF signé, preuve)                                          SHA-256, journal, corbeille…)
                                                          3. connecteur.creerEnveloppe()
                                                                       │
                              PostgreSQL (table signatures)            ▼
                              (demandes + journal)          FOURNISSEUR DE SIGNATURE
                              data/contrats-generes/        (Yousign — api[-sandbox].yousign.app/v3)
                              (PDF pour-signature,          • invitations + relances e-mail
                               signé, dossier de preuve)    • page de signature + OTP e-mail
                                                            • ordre séquentiel, expiration
                                        ▲                   • dossier de preuve (audit trail)
                                        │                              │
      POST /api/signatures/:id/synchroniser  ◄── polling ──────────────┤
      POST /webhooks/signature               ◄── webhook (HMAC) ───────┘
      (statuts signataires ; à la fin : téléchargement du PDF signé
       + du dossier de preuve → archivés dans le dossier du contrat)
```

**Responsabilités** : le NAVIGATEUR ne voit jamais de clé ni n'appelle le
fournisseur — il ne parle qu'au backend. Le BACKEND détient les secrets
(`data/secrets.json`), construit le PDF, pilote le connecteur, archive les
documents. Le FOURNISSEUR détient l'expérience de signature et la preuve.

## 2. L'abstraction « FournisseurSignature »

`lib/fournisseurs/index.js` expose `fournisseurActif()` + le registre `EXTERNES`.
Chaque connecteur (ex. `lib/fournisseurs/yousign.js`) implémente :

| Méthode | Rôle |
|---|---|
| `verifier()` | test de la clé/du mode (bouton « Tester » des Paramètres) |
| `creerEnveloppe({pdf, nomFichier, titre, numero, echeance, signataires, positions})` | crée la demande + document + signataires **dans l'ordre** + activation ; renvoie `{idExterne, signataires:[{email, url}]}` |
| `statutEnveloppe(idExterne)` | `{statut: envoyee\|complete\|annulee, signataires:[{email, statut, signeLe}]}` |
| `telechargerSigne(idExterne)` | Buffer du PDF signé |
| `telechargerPreuve(idExterne)` | Buffer du dossier de preuve (ou `null`) |

**Ajouter un connecteur** (DocuSign, SignWell…) = écrire ce fichier, le déclarer
dans `EXTERNES`, ajouter l'option dans Paramètres. Rien d'autre ne change :
routes, interface, archivage et suivi sont déjà génériques. Les champs de
signature sont posés **aux coordonnées réelles** du cadre « Signature : » du PDF
(capturées par `render-pdf.js` via `sortiePositions` : page + x/y haut-gauche).

## 3. Endpoints backend

| Méthode & route | Rôle | Corps attendu → réponse |
|---|---|---|
| `POST /api/signatures` | créer l'enveloppe chez le connecteur | payload contrat + `signataires{partie1,partie2}` + `echeance` → `{ok, demande, envoiAuto}` ; 400 si connecteur non configuré, 502 si l'API échoue |
| `GET /api/signatures` | suivi de toutes les demandes | → `[vueDemande]` (fournisseur, tour, statuts, liens fournisseur) |
| `POST /api/signatures/:id/synchroniser` | relire le statut chez le fournisseur ; à la complétion : télécharge + archive PDF signé et preuve | → `{ok, demande}` |
| `POST /webhooks/signature` | notification du fournisseur (répond 200 immédiatement, vérifie l'HMAC si secret configuré, puis re-lit l'API — le contenu du webhook n'est jamais cru sur parole) | corps Yousign → 200 |
| `GET /api/signatures/:id/pdf` | PDF signé (archive fournisseur ; legacy local : régénéré) | → PDF |
| `GET /api/signatures/:id/certificat` | dossier de preuve fournisseur (legacy local : certificat maison) | → PDF |
| `DELETE /api/signatures/:id` | suppression (double confirmation → corbeille) | → `{ok}` |
| `GET /api/test/yousign` | test de connexion du connecteur | → `{ok, message}` |

## 4. Configuration (Paramètres → Signature électronique)

1. Crée un compte sur **yousign.com** → espace développeur → **clé API sandbox**
   (gratuite, documents SANS valeur légale — parfaite pour tout tester).
2. Colle la clé, mode **Sandbox**, « Enregistrer les clés », puis **Tester**.
3. Envoie un contrat en signature vers tes propres adresses : invitation reçue,
   OTP, signature — puis « Synchroniser » → PDF signé + preuve dans le dossier.
4. **Webhook** (optionnel, sinon le bouton Synchroniser suffit) : dans l'app
   Yousign, déclarer `https://<ton-domaine>/webhooks/signature` (nécessite le
   déploiement OVH — en local, pas d'URL joignable) + coller le **secret** dans
   Paramètres : l'app vérifie chaque notification par HMAC-SHA256.
5. Passage en **production** : souscrire une offre API Yousign, générer la clé
   production, basculer le mode. Les clés vivent dans `data/secrets.json`
   (jamais envoyées au navigateur, champ « •••••• » en Paramètres).

### Configuration Zoho Sign (connecteur alternatif)

Zoho utilise **OAuth2** (pas de simple clé API) — l'application automatise le
plus pénible (l'échange de code) :

1. Choisis le connecteur **Zoho Sign** + la **région Europe** (`sign.zoho.eu`,
   données UE — le compte Zoho doit être dans la même région).
2. Sur **api-console.zoho.eu** → *Add Client* → **Self Client** → recopie le
   **Client ID** et le **Client Secret** dans Paramètres → **Enregistrer les clés**.
3. Toujours dans l'API console, onglet *Generate Code* : portée
   **`ZohoSign.documents.ALL`**, durée 10 min → génère le code, colle-le dans
   « Code d'autorisation » → bouton **« Échanger le code »**. L'application
   récupère et stocke le **refresh token** (l'access token, valable 1 h, sera
   rafraîchi automatiquement à chaque usage).
4. **Tester**, puis envoie un contrat vers tes propres adresses.
5. Notes : ordre séquentiel et rappels automatiques activés ; l'expiration est
   convertie en jours ; le « certificat de complétion » Zoho est archivé comme
   dossier de preuve (`__PREUVE-ZOHO.pdf`). Le webhook `/webhooks/signature`
   comprend aussi le format Zoho (configuration côté Zoho Sign → Settings →
   Webhooks, une fois l'application déployée).

## 5. Checklist conformité & sécurité (RGPD / eIDAS)

**Valeur probante**
- [x] Empreinte SHA-256 du PDF transmis, figée dans la demande.
- [x] Journal d'événements horodaté par demande (création, enveloppe, signatures,
      complétion) — consultable, conservé en base.
- [x] Dossier de preuve du fournisseur (OTP, IP, horodatage qualifié) archivé
      à côté du PDF signé dans `data/contrats-generes/<contrat>/`.
- [x] Signature électronique **simple à avancée** selon l'offre Yousign
      (`signature_level: electronic_signature`, OTP e-mail activé).

**Sécurité applicative**
- [x] Clés API et secrets **côté backend uniquement** (`data/secrets.json`,
      gitignoré) ; l'interface n'expose que des booléens « configuré ».
- [x] Webhook : réponse 200 immédiate, **vérification HMAC** (timingSafeEqual)
      si secret configuré, et re-lecture de l'API — jamais de confiance au corps.
- [x] Sandbox et production strictement séparés (URL + clé par mode).
- [ ] Avant exposition Internet : HTTPS (Caddy), authentification sur tout sauf
      `/webhooks/signature`, journaux serveur, sauvegardes de `data/`.

**RGPD**
- Finalité : gestion contractuelle (art. 6.1.b — exécution d'un contrat).
- Minimisation : seuls nom, e-mail et documents contractuels partent chez le
  fournisseur ; Yousign est français, données hébergées en **UE**.
- Conservation : contrats signés + preuves = durée légale contractuelle
  (5 à 10 ans) ; purger les demandes annulées via la corbeille.
- Droits des personnes : les archives par contrat rendent l'accès/export trivial
  (dossier `contrats-generes/<contrat>/`).
- Sous-traitant : signer le **DPA de Yousign** (proposé à la souscription) et
  mentionner le fournisseur dans le registre des traitements ADBI.

## 6. Comparatif des fournisseurs (contexte : ESN française, ~10-50 contrats/mois)

| Fournisseur | Pour | Contre | Verdict |
|---|---|---|---|
| **Yousign** 🇫🇷 | eIDAS natif, données UE, API v3 propre (clé simple), sandbox gratuite, DPA français | embedded/iframe selon offre | ✅ **Recommandé** — connecteur livré, défaut |
| **Zoho Sign** 🇮🇳/🇪🇺 | région UE (`sign.zoho.eu`), inclus/abordable dans l'écosystème Zoho, rappels natifs, certificat de complétion | OAuth2 plus lourd (géré par l'app), TSP moins « qualifié eIDAS FR » que Yousign | ✅ **Connecteur livré** — pertinent si ADBI utilise déjà Zoho |
| DocuSign 🇺🇸 | leader mondial, très riche (modèles, routage complexe), SDKs partout | plus cher, données/US (offre UE à négocier), API plus lourde (OAuth JWT) | pour un futur besoin grands comptes |
| SignWell 🇺🇸 | API simple, pas cher | US, pas d'ancrage eIDAS français | budget serré hors exigence eIDAS |
| PandaDoc 🇺🇸 | édition de documents intégrée | on n'en a pas besoin (génération déjà ici), US | sans objet pour ADBI |

## 7. Ce qui a été retiré (septembre 2026)

Page locale `/signer/<jeton>` et ses API, jetons par signataire, apposition
locale des signatures/paraphes/cachets, invitations et relances SMTP,
prolongation locale des délais. Les demandes locales signées AVANT la bascule
restent lisibles : leur PDF et leur certificat maison se régénèrent depuis les
données conservées. `lib/mailer.js` reste disponible (non branché) pour de
futurs e-mails applicatifs.
