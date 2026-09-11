# Bridge DocIE — contrat serveur partagé

Livrable #150 du milestone Bridge DocIE. Ce module prépare les migrations :
il n'est pas encore branché sur les routes métier du Parser, OnePager ou Contrats.
Deux transports (Python/requests et Node 22/fetch), mêmes vecteurs de contrat et
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

`extract_document(bytes, mime_type, kind="resume")` en Python et
`extractDocument(buffer, mimeType, {kind: "resume"})` en Node envoient un seul POST
à `/v1/agents/{agent}/chat/completions` avec `model={agent}`, document en data URI
dans `image_url`, **`parallel_extraction: true` et `stream: false`**.

PDF et images PNG/JPEG/WebP sont acceptés, jusqu'à 20 MiB. Aucun OCR local,
enregistrement de schéma, création d'agent ni retry automatique. L'OCR et son cache
restent à DocIE. DOCX et texte ne sont pas envoyés avec un contrat inventé : leur
adaptation fait partie des migrations des consommateurs et doit être testée.

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
`rate_limit`, `upstream`, `timeout`, `network`, `response`, `incomplete`, `schema`)
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
