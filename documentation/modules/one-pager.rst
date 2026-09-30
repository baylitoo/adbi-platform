One-pager
=========

Le One-pager (``one-pager/``) transforme un CV en dossier d'une page, prêt à
présenter à un client.

Caractéristiques
----------------

- Node 22, Express ; port interne 4200.
- Base PostgreSQL dédiée : fiches maîtres, recherche plein texte par trigrammes.

Fonctions
---------

**Import**
   Fichier, texte, extraction (plateforme d'inférence, locale, ou modèle
   externe sur choix), normalisation, fiche maître. Extraction asynchrone
   avec suivi de progression.

**One-pager et livret**
   Construction de la page à partir de la fiche maître et d'un gabarit,
   rendu PowerPoint ; livret de plusieurs profils (200 au plus).

**Badges**
   Bibliothèque d'images de certifications, par éditeur.

**Classement contre une offre**
   Le vivier est classé contre le texte d'une offre, par détection des
   technologies qu'elle cite.

**Historique**
   Recherche et réouverture des fiches déjà importées.
