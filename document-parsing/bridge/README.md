# Bridge DocIE — contrat serveur partagé

Livrable #150 du milestone Bridge DocIE. Chaque branchement métier vit dans la
PR de son service (#151–#153) ; côté OnePager les deux voies sont branchées
derrière `DOCIE_EXTRACTION_ENABLED`. Deux transports (Python/requests et Node 22/fetch), mêmes vecteurs de contrat et
même résultat normalisé, sans nouveau service réseau intermédiaire.

## Configuration à l'exécution

Secrets fournis par l'interface de déploiement, jamais dans le navigateur :

```text
DOCIE_BASE_URL=https://docie.example.com
DOCIE_API_KEY=<clé serveur DocIE>
DOCIE_AGENT_RESUME=adbi_agent_1
DOCIE_AGENT_CONTRACT=<agent contrat à configurer côté DocIE>
DOCIE_AGENT_KBIS=<agent kbis à configurer côté DocIE>
DOCIE_TIMEOUT_SECONDS=360
DOCIE_MAX_TOKENS=8192
```

La base est la racine API, sans `/v1`. L'agent se sélectionne par type de document,
jamais via une URL fournie par le navigateur. HTTP n'est autorisé par défaut que
sur loopback ; `DOCIE_ALLOW_HTTP=true` est une dérogation explicite pour un réseau
privé de confiance. Elle ne chiffre pas les échanges. TLS n'est jamais désactivé.

## Contrat

Deux points d'entrée, un par **surface DocIE**. Ce ne sont pas deux formats d'une
même voie : ce sont deux endpoints, deux corps de requête, deux façons pour DocIE
de lire le document. La règle d'aiguillage vient de l'équipe DocIE (#180) :
**utiliser la structure que la source possède réellement**, et non « préférer la
voie texte » — un PDF scanné n'a aucun texte lisible par machine, la voie fichier
y reste la seule possible.

### Voie fichier — `/v1/agents/{agent}/chat/completions`

`extract_document(bytes, mime_type, kind="resume")` en Python et
`extractDocument(buffer, mimeType, {kind: "resume"})` en Node envoient un seul POST
à `/v1/agents/{agent}/chat/completions` avec `model={agent}`, document en data URI
dans `image_url`, **`parallel_extraction: true` et `stream: false`**, en-tête
`Authorization: Bearer`.

PDF et images PNG/JPEG sont acceptés, jusqu'à 20 MiB. Aucun OCR local,
enregistrement de schéma, création d'agent ni retry automatique. L'OCR et son cache
restent à DocIE. Un DOCX n'est pas envoyé ici : rien derrière l'enveloppe
`image_url` ne le lit.

### Voie texte — `/v1/extract/text`

`extract_text(text, kind="resume", dynamic_schema=None)` en Python et
`extractText(text, {kind: "resume", dynamicSchema})` en Node envoient un seul POST
à `/v1/extract/text` avec `{text, schema_name, schema_mode: "dynamic",
dynamic_schema}` et l'en-tête `x-api-key`. **Pas d'enveloppe data URI**, et rien
de la voie chat (`model`, `messages`, `max_tokens`) : rien ne montre que cet
endpoint les lise. C'est la forme portée depuis la seule requête dont ce dépôt
garde une réponse réelle réussie (`cv-parser/docie_client.py`, réponse obtenue
par `document-parsing/scripts/test_api.py` — le vecteur
`tests/contract_text.json` en est extrait).

Pour une source qui **possède déjà** du texte lisible par machine : un `.txt`,
les paragraphes d'un DOCX, la couche texte d'un PDF déjà lue. Jamais un repli
après un échec de la voie fichier.

Premier consommateur : `one-pager/lib/import-pipeline.js`. L'aiguillage y est
un prédicat de format, `lib/ingest.js#estTexteBrut`, posé à côté de `isPdf`
pour qu'il ne puisse pas diverger de ce que `ingest()` fait réellement du
fichier. Un PDF — scanné ou non — n'y entre jamais : il garde la voie fichier,
la seule qui déclenche l'OCR distant.

`dynamic_schema` y est chargé depuis `document-parsing/schemas/adbi_resume.schema.json`,
**à côté** de ce dossier et non dedans : un transport ne possède pas de schéma
métier, mais un schéma partagé par plusieurs services ne peut pas non plus
vivre dans un seul d'entre eux. `cv-parser/adbi_resume.schema.json` en garde
pour l'instant une copie, qu'un test compare à celle-ci.

`dynamic_schema` est le schéma de l'appelant et le reste : un transport ne
possède pas de schéma métier. Il n'est pas optionnel en pratique pour un schéma
**personnalisé** — `document-parsing/scripts/register_and_test.py` enregistre que
`schema_name` seul ne résout que le petit registre intégré de DocIE, donc
`adbi_resume` doit voyager avec sa définition —, mais son absence n'est pas
refusée : les noms intégrés existent.

`ocr_blocks` n'est **pas** envoyé. DocIE découpe le texte lui-même et, pour du
texte brut, nous n'avons rien de mieux à proposer que son propre découpage ; le
chemin DOCX de cv-parser envoie du texte sans lui depuis son écriture. Il
deviendra un argument optionnel transmis tel quel le jour où un appelant
démontrera de meilleures frontières (les paragraphes d'un DOCX, par exemple).

L'ancrage fonctionne **à l'identique** sur cette voie : le service découpe le
texte lui-même, donc chaque feuille revient en `{value, confidence,
evidence_ids}` et toute la chaîne de signaux de revue (#172/#173/#175) est
inchangée. Deux différences honnêtes, qui viennent de l'endpoint et non d'un
choix ici : `metadata.agent` vaut `null` (il n'y a pas d'agent sur cette voie),
et le code `incomplete` n'existe pas (il lit `finish_reason`, que cette réponse
n'a pas — une troncature s'y présente en erreurs de `validation` ou en HTTP 413
→ `limits`). Tout le reste du contrat de métadonnées est identique.

Cette liste est celle de la **voie agent/chat**, pas la liste d'upload de DocIE
(`ALLOWED_UPLOAD_MIME_TYPES`) : le document part en data URI `image_url` et c'est
l'OCR distant qui le lit (liteparse rend des pages PDF, tesseract et paddle
prennent des images). `image/webp` a été retiré — DocIE le refuse, donc chaque
WebP faisait un aller-retour réseau inutile avant d'échouer ; il échoue
maintenant localement, avec les types acceptés nommés. `text/plain` et
`image/tiff` figurent dans la liste d'upload DocIE mais **ne sont pas ajoutés
ici** : le texte n'a aucun backend OCR derrière l'enveloppe `image_url`, sa voie
est `extract_text` / `extractText` ci-dessous — un autre endpoint, pas un type
MIME à ajouter à cette liste ; le TIFF est plausible mais non vérifié, et son
acceptation dépend du backend OCR du déploiement, pas de la seule liste
d'upload. Voir #180.

Limites documentées par DocIE : 25 Mo d'upload, 26 Mo de corps, 1 000 000
caractères de texte, **1 000 blocs OCR par document**, 20 000 caractères par
bloc, 50 entrées de métadonnées, 8 pages (voie vision uniquement). Ce sont des
**valeurs par défaut, propres à chaque déploiement** : un opérateur les change et
rien côté DocIE (`/healthz`, `/readyz`, `/metrics`, `/v1/schemas`) ne publie
celles en vigueur. Notre plafond de 20 MiB tient — il est à l'intérieur du
leur — mais il surveille la mauvaise dimension : un PDF dense de trois pages
atteint 1 000 blocs à quelques mégaoctets, et aucun contrôle local ne peut le
voir venir. Un refus pour dépassement revient donc après l'appel, sous l'une des
formes déjà traitées : HTTP 413 → code `limits`, erreurs de `validation`
conservées verbatim, ou `finish_reason` non « stop » → code `incomplete`.

La difference qui compte pour choisir une voie n'est pas la vitesse mais la
RESOLUTION DU SCHEMA : sur la voie agent il est resolu PAR NOM et doit donc
exister cote Studio DocIE ; sur la voie texte, sa DEFINITION voyage dans la
requete et rien n'a a etre enregistre au prealable. C'est ce qui permet a un
service d'ajouter une piece sans action manuelle cote DocIE (cf. #170).

La regle de routage n'est donc pas « preferer la voie texte » mais « utiliser
la structure que la source a reellement » : un document scanne n'a pas de
texte a envoyer et reste du ressort de la voie fichier.

Sortie : `{schema_name, result, metadata}`. Les enveloppes de champs
`{value,confidence,evidence_ids}` sont déballées sans conversion arbitraire des
valeurs. `model_confidence` (confiance par logprob) compte aussi comme marqueur
d'enveloppe : l'ignorer laisserait un scalaire arriver au consommateur sous
forme de dict. Les mappings métier restent aux consommateurs. Les arrays/null
sont préservés. Une validation négative est conservée et doit déclencher une
revue côté application ; absence de validation ne signifie pas succès validé.

La confiance par champ n'est plus perdue au déballage : `metadata.field_confidence`
associe un chemin (`contact.email`, `experience[0].title`, `skills[1].items[2].item`)
à la confiance DocIE de ce champ. La carte `docie_agent.field_confidence` fait foi
quand l'agent l'émet ; sinon elle est reconstruite depuis les enveloppes. DocIE
plafonne à 0.5 la confiance d'un champ dont il a dû tronquer une liste qui
bouclait : `<= 0.5` est donc un critère sûr de « partiel, à faire relire ». Seule
`confidence` est collectée (`model_confidence` est une autre échelle). Le seuil
et la traduction vers les chemins de chaque application restent aux consommateurs.
`validation.warnings` / `validation.errors` sont des chaînes libres, sans format
stable : à afficher verbatim, jamais à analyser pour en déduire un nom de champ.

Les réponses aplaties de l'agent et les enveloppes `result` sont acceptées.
Le modèle retourné peut être le modèle de calcul, pas le nom d'agent. Les noms
de schéma et d'agent rapportés sont vérifiés lorsqu'ils sont présents. Si le
serveur n'expose pas de nom de schéma, `schema_reported=false` le signale : ce
transport ne prétend pas alors avoir vérifié le schéma distant. Les migrations
ajouteront la validation de structure propre à chaque modèle métier.

Les métadonnées conservent `usage`, `validation`, `request_id`, modèle et temps
total client. `queue_wait_ms`, `latency_ms`, `generation_ms` sont conservés
uniquement s'ils sont effectivement renvoyés (dans docie_agent, l'enveloppe
d'extraction ou la réponse chat). Zéro n'est pas inventé si absent. Le temps de
génération n'est pas déduit artificiellement du temps total.

Les erreurs exposent un code stable (`configuration`, `input`, `auth`,
`rate_limit`, `limits`, `upstream`, `timeout`, `network`, `response`,
`incomplete`, `schema`)
et éventuellement le statut HTTP, sans corps d'erreur distant ni clé. Une réponse
tronquée/raisonnement seul n'est pas acceptée comme une extraction. Les réponses
sont limitées à 8 MiB. Aucun suivi de redirection. Le timeout Node borne l'appel
entier ; requests utilise des timeouts connexion/lecture et un contrôle de durée
au fil de la lecture, pas une annulation du travail serveur. Après timeout, le
travail distant peut continuer : ne pas relancer aveuglément.

## Validation hors ligne

Depuis la racine du dépôt :

```text
python -m unittest discover -s document-parsing/bridge/tests -p test_*.py -v
node --test document-parsing/bridge/tests/bridge.test.js
```

Les tests HTTP démarrent un faux DocIE sur `127.0.0.1`, sans lire `.env.remote`.
Les tests live sont exécutés uniquement par l'utilisateur. Avant un benchmark :
vérifier la version DocIE déployée et `slot_count` observé. Le split requiert
`n_parallel >= 2` pour espérer un gain ; le multi-slot n'est pas configuré par
ce bridge. Pas de streaming/preview en split. Comparer cache OCR froid/chaud et
latences de file/génération ; aucun gain de débit n'est garanti par ces clients.

Le packaging Docker de chaque transport et les mappings applicatifs seront livrés
dans les PR consommateurs #151–#153. Ne pas copier manuellement ces fichiers dans
les modules : ils restent des sources partagées dans ce dossier.
