# Plateforme ADBI — dépôt de déploiement

Suite d'outils internes ADBI, orchestrée par **ADBI Factory** :

| Dossier | Module | Port |
|---|---|---|
| `factory/` | ADBI Factory — hub, tuiles, cycle de vie des modules | 4000 |
| `contrats/` | ADBI Contrats + ADBI Sign — génération de contrats, signature par connecteurs API (Yousign / Zoho Sign) | 4100 |
| `one-pager/` | ADBI OnePager — CV → dossier de compétences | 4200 |
| `coffre/` | ADBI Coffre — protection / anonymisation de documents | 4300 |
| `cv-parser/` | ADBI Parser — extraction structurée de CV (Python/Flask) | 5000 |

Le module **ADBI Gestion n'est pas dans ce dépôt** (outil interne, non déployé).

## Déployer

**Suivre le guide : [`ADBI-Deploiement-Serveur.docx`](ADBI-Deploiement-Serveur.docx)**
(prérequis, installation, Caddy/HTTPS, systemd, pare-feu, sauvegardes, recette).

Résumé du chemin :

```bash
# sur le serveur (Ubuntu 22.04/24.04)
sudo git clone <URL_DE_CE_DEPOT> /opt/adbi
cd /opt/adbi
# puis dérouler le guide à partir de la section 5 :
#  - npm ci dans contrats/, one-pager/, coffre/  (factory : aucune dépendance)
#  - venv + pip install -r cv-parser/requirements.txt
#  - factory/modules.json.serveur-exemple → adapter le domaine → renommer en modules.json
#  - Caddyfile (section 7), systemd (section 8), UFW (section 9)
```

> ⚠️ Le guide utilise `/opt/adbi/factory`, `/opt/adbi/contrats`, etc. — la
> structure de ce dépôt correspond exactement : cloner dans `/opt/adbi` suffit.

## Ce que git ne contient pas (voulu — voir `.gitignore`)

- **Secrets** : clés API (saisies dans l'interface après déploiement), code
  d'accès des Paramètres (créé au premier démarrage, défaut `ADbi2027@@`,
  modifiable dans `contrats/data/code-parametres.txt`), clé du Coffre.
- **Données de travail** : bases, CV, documents, archives de contrats — la
  plateforme démarre à vide et le serveur garde ses données hors git
  (les mises à jour par `git pull` ne toucheront jamais aux données).

## Mettre à jour le serveur

```bash
cd /opt/adbi && sudo -u adbi git pull && sudo systemctl restart adbi-factory
```

## Documents

- `ADBI-Deploiement-Serveur.docx` — le guide de déploiement pas à pas
- `ARCHITECTURE.md` — architecture interne, sécurité, évolutivité
- `contrats/docs/INTEGRATION-SIGNATURE.md` — connecteurs de signature (Yousign / Zoho), conformité RGPD/eIDAS
- `LISEZMOI.txt` — contenu du paquet et rappels

Contact fonctionnel : Amine OUKLI (ADBI).
