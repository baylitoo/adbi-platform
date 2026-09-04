# ADBI OnePager

Port **4200**. Node + Express. CV → dossier de compétences ADBI en une page,
extraction 100 % locale.

## Principe

1. **Import** — glissez un CV (`.pdf`, `.docx`, `.txt`, 20 Mo max). Un PDF
   scanné (image) ne peut pas être lu, le réexporter en PDF texte.
2. **Validation** — texte lu à gauche, champs extraits à droite, tout
   modifiable ; les champs incertains sont encadrés en orange.
3. **One-pager** — aperçu en temps réel :
   - anonymisation (trigramme, nom complet, ou code client imposé)
   - densité (compacte/normale/aérée), angle (neutre/technique/management)
   - nombre de missions affichées
   - « Cibler une offre » : coller une fiche de poste pour reclasser missions
     et réalisations selon le besoin client
   - exports : Imprimer/PDF (navigateur, paysage), PowerPoint (`.pptx`), JSON

Le panneau « Écarté du one-pager » liste ce qui a été retiré et pourquoi (clic
pour réintégrer).

## Historique

Chaque CV validé est enregistré (trigramme, titre, missions, fichier
d'origine) dans `data/cvs.sqlite` (gitignoré). Recherche plein texte, réouverture
directe à l'étape Validation.

## Confidentialité

Tout est local : aucun CV n'est envoyé sur Internet.

## Images (portrait, badges, vague, logo)

Gabarit extrait du livret PowerPoint ADBI, dans `public/assets/` (vague,
coin orange, logos, avatars, badges de certification). Pour ajouter une image
à demeure : déposer le fichier dans `public/assets/` (ou `public/assets/badges/`),
puis rafraîchir. Après ajout/remplacement d'un SVG, régénérer le PNG (requis
par l'export PowerPoint) :

```bash
node scripts/build-assets.js
```

L'export PowerPoint reprend le gabarit du livret ADBI au point près (slide
20×11,25 po, vagues pivotées 336°/146°, corps de police 27/21/18/15 pt) — ces
éléments sont fixes, indépendants des données du CV.

## Organisation du code

```
server.js              serveur web + points d'entrée API
lib/ingest.js           lecture PDF/DOCX/TXT, détection des colonnes
lib/layout.js           découpage en sections (profil, expériences...)
lib/extract.js          extraction des champs -> cv_master
lib/normalize.js        dates, téléphones, niveaux de langue
lib/taxonomy.js         référentiel de 312 technologies et leurs alias
lib/score.js            priorisation des missions et des réalisations
lib/onepager.js         réduction à une page (budgets, gabarit)
lib/render-pptx.js      export PowerPoint
lib/db.js               base locale SQLite
public/                 interface (index.html, app.js, styles.css,
                         onepager.css = le gabarit imprimé)
```

Deux niveaux de données volontairement séparés : `cv_master` (extraction
complète, sans perte, éditable) et `cv_onepager` (projection réduite,
recalculée à chaque affichage) — changer de gabarit ou de cible ne nécessite
jamais de réimporter.

## Démarrage

```bash
npm ci
node server.js       # → http://localhost:4200
```

### Docker

```bash
docker build -t adbi-onepager .
docker run -p 4200:4200 -v "$(pwd)/data:/app/data" adbi-onepager
```

Variables d'environnement : voir [`.env.example`](.env.example).
