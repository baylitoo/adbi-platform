"""Dépôt de CV en tâche asynchrone (issue #196) : « démarrer -> interroger ».

Pourquoi : l'évaluation de prompt non cachée de LFM2.5-2.6B est mesurée à
60-73 jetons/s sur la machine DocIE (#194). Un grand CV (~14-16k jetons)
représente ~3,5-4 min avant le premier jeton de sortie. `POST /api/upload`
exécutait `process_cv` DANS le thread de la requête ; gunicorn tourne avec un
seul worker et `ADBI_GUNICORN_THREADS` threads (4 par défaut, gunicorn.conf.py) :
quatre extractions longues occupaient tous les threads, y compris ceux qui
servent le sondage de progression, la connexion et toutes les autres pages.

L'extraction tourne donc ici, sur des threads À PART des threads gunicorn, et
la route répond 202 aussitôt. Contrat (le même que one-pager #199 et contrats
#200, adapté à ce que cv-parser avait déjà) :

    POST /api/upload                        -> 202 { tache: "<jeton>" }
                                            -> 503 { error }   file pleine
    POST /api/cv/<id>/reanalyser            -> 202 { tache }, même file
                                            -> 409 { error }   fiche déjà en
                                               cours de ré-analyse
    GET  /api/upload/progression/<jeton>    -> 200 {
        pct, etape, detail,                  // libellés existants (widget)
        etat: "en_cours" | "terminee" | "echec",
        position?: number,                   // en attente (1 = la prochaine)
        resultat?: <ancienne réponse synchrone, clé pour clé>,   // terminee
        erreur?: { code, message, eta_seconds? },               // echec
        debut: ISO 8601, fin?: ISO 8601
    }
                                            -> 404 inconnue, expirée, ou
                                               tâche d'un autre utilisateur

L'identifiant de tâche EST le jeton de progression qui existait déjà : le
widget (static/conv_widget.js) interroge cette adresse depuis l'origine ; il
n'y a pas de second mécanisme. Écart au contrat : `etape` reste le libellé
français que le widget affiche (« Analyse du CV »), pas `en_attente` /
`extraction` ; l'attente se lit sur `position`.

Bornes (en mémoire, process unique — gunicorn.conf.py garde UN worker pour les
verrous de fiche ; cet état en dépend de la même façon) :
  - `ADBI_EXTRACTION_MAX_CONCURRENT` extractions à la fois (ancien nom
    `ADBI_UPLOAD_MAX_CONCURRENT` toujours lu), défaut 2 : les deux slots
    (`n_parallel`) de LFM2.5-2.6B, modèle CV par défaut (#194). Au-delà, les
    requêtes attendraient DANS llama-server et cette attente compterait dans
    le `timeout_seconds` de DocIE. À aligner sur le modèle servi ;
  - MAX_EN_ATTENTE (20) tâches en file, ordre d'arrivée ; au-delà, refus ;
  - une tâche finie est oubliée TTL_S (30 min) après sa fin. Purge paresseuse
    à chaque création / lecture : aucun minuteur, horloge injectable. Une
    tâche en cours ou en attente n'est JAMAIS purgée, quelle que soit sa durée.

Un redémarrage du process perd les tâches (threads démons) : le fichier déjà
écrit sous uploads/ reste, sans fiche ; l'utilisateur relance le dépôt.

Échouer bruyamment (#194) : aucune relance, aucun repli ICI. Une exception qui
sort du travail devient un code nommé et un message français constant ; le
texte amont n'est jamais recopié (il part au journal serveur). Le repli
existant du dépôt (fiche vide éditable + parse_warning quand process_cv
échoue) est dans le travail lui-même et n'est pas modifié par ce module : un
dépôt SANS choix de modèle dont DocIE échoue se termine donc `terminee` ; avec
un modèle explicitement choisi (#194, choix_modele.py), le repli ne s'applique
pas et la tâche finit `echec` au code nommé. La ré-analyse n'a jamais eu
ce repli (elle répondait 500) : son échec DocIE est un `echec` au code nommé.
"""
import math
import os
import re
import threading
import time
import traceback
import uuid
from collections import deque
from datetime import datetime, timezone

# Même nom de variable dans les trois services (one-pager, contrats, cv-parser,
# #196) ; le docker-compose.yml racine la remplit depuis
# CVPARSER_EXTRACTION_MAX_CONCURRENT.
VARIABLE_MAX_SIMULTANEES = "ADBI_EXTRACTION_MAX_CONCURRENT"
# Nom d'origine (PR #202), gardé comme alias : lu seulement quand la variable
# ci-dessus est absente ou vide, pour qu'un .env existant ne perde pas son
# réglage. Aucun fichier compose ne l'a jamais transmis.
VARIABLE_MAX_SIMULTANEES_ALIAS = "ADBI_UPLOAD_MAX_CONCURRENT"
# Défaut 2 : cv-parser extrait des CV, modèle par défaut LFM2.5-2.6B servi avec
# `n_parallel` 2 (liste retenue de #194). À baisser à 1 pour NuExtract3.
MAX_SIMULTANEES_DEFAUT = 2
# Borne haute : bien au-delà de tout `n_parallel` de #194 (1 ou 2) ; attrape une
# faute de frappe ou la confusion avec la taille de file (20).
MAX_SIMULTANEES_BORNE = 16
# File et conservation restent en dur : elles bornent la mémoire et le confort
# de l'utilisateur, pas les slots du modèle.
MAX_EN_ATTENTE = 20
TTL_S = 30 * 60

# Entier décimal ASCII seulement : int() accepterait aussi "+3", "1_0" ou des
# chiffres non ASCII. Même règle que les services Node.
_ENTIER_RE = re.compile(r"[0-9]+")

# Jeton proposé par le navigateur (crypto.randomUUID, ou son repli
# horodatage-aléatoire dans templates/index.html). Tout autre forme est
# remplacée par un identifiant du serveur.
_JETON_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

ETAPE_ATTENTE = "En attente d'une extraction libre"


class FileTachesPleine(RuntimeError):
    def __init__(self, maximum):
        super().__init__(
            f"Trop de CV en attente d'analyse ({maximum} maximum) : réessayez dans un instant.")


class TacheDejaEnCours(RuntimeError):
    def __init__(self):
        super().__init__("Une analyse de cette fiche est déjà en cours : attendez sa fin avant de la relancer.")


class ErreurTache(RuntimeError):
    """Erreur métier levée par un travail, au message écrit par nous (« CV
    introuvable ») : rendue telle quelle avec son code (`input` par défaut,
    comme l'erreur métier du contrat de #196)."""

    def __init__(self, message, code="input"):
        super().__init__(message)
        self.code = code


def max_simultanees_depuis_env(env=None) -> int:
    """Plafond d'extractions simultanées, lu dans l'environnement.

    ADBI_EXTRACTION_MAX_CONCURRENT, sinon l'alias ADBI_UPLOAD_MAX_CONCURRENT.
    Absentes, vides ou blanches -> défaut (2) : compose transmet une chaîne vide
    quand la variable racine n'est pas renseignée. Présente mais autre chose
    qu'un entier décimal entre 1 et MAX_SIMULTANEES_BORNE -> ValueError au
    démarrage (import d'app.py) : une faute de frappe ne doit pas passer pour
    « 2 ».
    """
    env = os.environ if env is None else env
    for variable in (VARIABLE_MAX_SIMULTANEES, VARIABLE_MAX_SIMULTANEES_ALIAS):
        brut = (env.get(variable) or "").strip()
        if brut:
            break
    else:
        return MAX_SIMULTANEES_DEFAUT
    valeur = int(brut) if _ENTIER_RE.fullmatch(brut) else 0
    if not 1 <= valeur <= MAX_SIMULTANEES_BORNE:
        raise ValueError(
            f"{variable} doit être un entier entre 1 et {MAX_SIMULTANEES_BORNE} (reçu : {brut!r}).")
    return valeur


# ── Correspondance des erreurs ───────────────────────────────────────────────

# Codes nommés du bridge (document-parsing/bridge/docie_bridge.py, appels
# fail("…") et table des statuts 401/403/413/429). Un code absent de cette
# table n'est PAS repris tel quel : il devient `interne`.
MESSAGES_BRIDGE = {
    "loading": "Modèle en cours de chargement, réessayez dans quelques instants.",
    "context": "Document trop long pour le modèle d'extraction.",
    "timeout": "L'extraction a dépassé le délai imparti.",
    "limits": "Document refusé par le service d'extraction : au-delà de ses limites (taille, pages ou blocs OCR).",
    "upstream": "Le service d'extraction a répondu en erreur.",
    "network": "Service d'extraction injoignable.",
    "input": "Document refusé par le service d'extraction.",
    "configuration": "Service d'extraction mal configuré.",
    "auth": "Accès au service d'extraction refusé (configuration).",
    "rate_limit": "Service d'extraction saturé, réessayez plus tard.",
    "response": "Réponse du service d'extraction invalide.",
    "incomplete": "Extraction inachevée par le service d'extraction.",
    "schema": "Le service d'extraction a renvoyé un autre type de document.",
}

MESSAGE_INTERNE = "Analyse impossible : erreur interne."

# Message de docie_client.message_chargement (#192), client historique sans
# code : seul signal de chargement de ce chemin. Un test vérifie que ce motif
# reconnaît bien ce que la fonction produit.
_CHARGEMENT_CLIENT_RE = re.compile(r"^DocIE : modèle en cours de chargement(?:, réessayez dans environ (\d+) s)?")

# Le seul message de DocIEError qui recopie un texte tiers (OSError, donc un
# chemin local) : docie_bridge_extraction.extract_resume. Tronqué à sa partie
# constante.
_PREFIXES_TRONQUES = ("Document introuvable ou illisible",)


def _message_chargement(eta):
    if isinstance(eta, (int, float)) and not isinstance(eta, bool) and math.isfinite(eta) and eta >= 0:
        n = math.ceil(eta)
        return {"code": "loading", "message": f"Modèle en cours de chargement, réessayez dans ~{n} s.",
                "eta_seconds": n}
    return {"code": "loading", "message": MESSAGES_BRIDGE["loading"]}


def mapper_erreur(e) -> dict:
    """Exception -> { code, message, eta_seconds? } présentable à l'utilisateur.

    - DocIEError levée depuis un DocIEBridgeError (`raise … from exc` dans
      docie_bridge_extraction) : code du bridge, message constant de la table ;
      `loading` porte `eta_seconds` (arrondi au-dessus) quand DocIE l'annonce ;
    - DocIEError du client historique (docie_client, sans code) : ses messages
      sont écrits par nous, en français -> code `extraction`, son message
      (`loading` reconnu à part) ;
    - ErreurTache (erreur métier écrite par nous) -> son code, son message ;
    - tout le reste -> `interne`, message constant.
    """
    if isinstance(e, ErreurTache):
        return {"code": e.code, "message": str(e)}
    cause = getattr(e, "__cause__", None)
    code = getattr(cause, "code", None)
    if type(cause).__name__ == "DocIEBridgeError" and isinstance(code, str):
        if code not in MESSAGES_BRIDGE:
            return {"code": "interne", "message": MESSAGE_INTERNE}
        if code == "loading":
            return _message_chargement(getattr(cause, "eta_seconds", None))
        return {"code": code, "message": MESSAGES_BRIDGE[code]}
    if type(e).__name__ == "DocIEError" and cause is None:
        message = str(e)
        chargement = _CHARGEMENT_CLIENT_RE.match(message)
        if chargement:
            return _message_chargement(int(chargement.group(1)) if chargement.group(1) else None)
        for prefixe in _PREFIXES_TRONQUES:
            if message.startswith(prefixe):
                return {"code": "extraction", "message": prefixe + "."}
        return {"code": "extraction", "message": message}
    return {"code": "interne", "message": MESSAGE_INTERNE}


# ── Gestionnaire ─────────────────────────────────────────────────────────────

def _lancer_thread(cible):
    # Démon : un arrêt de gunicorn n'attend pas une extraction de 15 min (il
    # tuerait le worker au `graceful_timeout` de toute façon). La tâche est
    # perdue, comme documenté.
    threading.Thread(target=cible, name="extraction-cv", daemon=True).start()


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")


class GestionnaireTaches:
    """File bornée d'extractions, séparée des threads de requête.

    `lancer(cible)` exécute `cible` ailleurs (un thread démon par défaut) ;
    les tests passent un lanceur qui garde les cibles pour les jouer à la main.
    Chaque cible exécute UNE tâche puis libère son créneau.
    """

    def __init__(self, max_simultanees=MAX_SIMULTANEES_DEFAUT, max_en_attente=MAX_EN_ATTENTE,
                 ttl_s=TTL_S, maintenant=time.time, lancer=_lancer_thread, journal=None):
        if int(max_simultanees) < 1:
            raise ValueError("max_simultanees doit être >= 1")
        self.max_simultanees = int(max_simultanees)
        self.max_en_attente = int(max_en_attente)
        self.ttl_s = ttl_s
        self._maintenant = maintenant
        self._lancer = lancer
        self._journal = journal or (lambda e: traceback.print_exception(e))
        self._verrou = threading.Lock()
        self._taches = {}          # jeton -> tâche (en attente, en cours, finie non expirée)
        self._file = deque()       # tâches en attente, ordre d'arrivée
        self._en_cours = 0

    # -- interne (verrou tenu) --
    def _purger(self):
        t = self._maintenant()
        for jeton in [j for j, tache in self._taches.items()
                      if tache["fin"] is not None and t - tache["fin"] >= self.ttl_s]:
            del self._taches[jeton]

    def _prendre_suivantes(self):
        a_lancer = []
        while self._en_cours < self.max_simultanees and self._file:
            tache = self._file.popleft()
            travail, tache["travail"] = tache["travail"], None
            self._en_cours += 1
            a_lancer.append((tache, travail))
        return a_lancer

    def _demarrer(self, a_lancer):
        # Hors verrou : un lanceur synchrone rappellerait le gestionnaire.
        for tache, travail in a_lancer:
            try:
                self._lancer(lambda tache=tache, travail=travail: self._executer(tache, travail))
            except Exception as e:           # thread impossible à créer
                self._journal(e)
                self._finir(tache, erreur=mapper_erreur(e))

    def _executer(self, tache, travail):
        # BaseException aussi : quoi qu'il arrive au travail, le créneau est
        # rendu — sinon la file se bloquerait pour de bon.
        try:
            resultat = travail(tache["id"])
        except BaseException as e:
            self._journal(e)
            self._finir(tache, erreur=mapper_erreur(e))
        else:
            self._finir(tache, resultat=resultat)

    def _finir(self, tache, resultat=None, erreur=None):
        with self._verrou:
            if erreur is None:
                tache["etat"], tache["resultat"] = "terminee", resultat
            else:
                tache["etat"], tache["erreur"] = "echec", erreur
            tache["fin"] = self._maintenant()
            self._en_cours -= 1
            a_lancer = self._prendre_suivantes()
        self._demarrer(a_lancer)

    # -- public --
    def creer(self, travail, proprietaire, jeton=None, cle=None) -> str:
        """Met `travail(jeton)` en file et rend le jeton sans l'attendre.

        `jeton` proposé par le client : repris s'il est bien formé et libre,
        sinon remplacé par un identifiant du serveur. `cle` (facultative) : une
        seule tâche inachevée (en attente ou en cours) par clé, quel qu'en soit
        l'auteur — la ré-analyse d'une fiche déjà en cours de ré-analyse lève
        TacheDejaEnCours. Lève FileTachesPleine.
        """
        if not isinstance(proprietaire, str) or not proprietaire:
            raise ValueError("proprietaire requis")
        with self._verrou:
            self._purger()
            if cle is not None and any(t["cle"] == cle and t["etat"] == "en_cours"
                                       for t in self._taches.values()):
                raise TacheDejaEnCours()
            if len(self._file) >= self.max_en_attente:
                raise FileTachesPleine(self.max_en_attente)
            if not (isinstance(jeton, str) and _JETON_RE.match(jeton)) or jeton in self._taches:
                jeton = str(uuid.uuid4())
            tache = {
                "id": jeton, "proprietaire": proprietaire, "travail": travail, "cle": cle,
                "etat": "en_cours", "pct": 0, "etape": "Démarrage", "detail": "",
                "resultat": None, "erreur": None, "debut": self._maintenant(), "fin": None,
            }
            self._taches[jeton] = tache
            self._file.append(tache)
            a_lancer = self._prendre_suivantes()
        self._demarrer(a_lancer)
        return jeton

    def noter(self, jeton, pct, etape, detail="") -> bool:
        """Range un libellé de progression dans la tâche (fusion : l'état, le
        propriétaire et le résultat restent). False si ce n'est pas une tâche."""
        with self._verrou:
            tache = self._taches.get(jeton)
            if tache is None:
                return False
            if tache["etat"] == "en_cours":
                tache.update(pct=pct, etape=etape, detail=detail)
            return True

    def obtenir(self, jeton, proprietaire):
        """Vue publique, ou None si inconnue, expirée ou d'un autre utilisateur
        (même réponse dans les trois cas : l'existence n'est pas confirmée)."""
        with self._verrou:
            self._purger()
            tache = self._taches.get(jeton) if isinstance(jeton, str) else None
            if tache is None or not proprietaire or tache["proprietaire"] != proprietaire:
                return None
            vue = {"etat": tache["etat"], "pct": tache["pct"],
                   "etape": tache["etape"], "detail": tache["detail"]}
            if tache["etat"] == "en_cours" and tache["travail"] is not None:
                position = self._file.index(tache) + 1
                vue.update(position=position, etape=ETAPE_ATTENTE, detail=f"position {position}")
            elif tache["etat"] == "terminee":
                vue.update(pct=100, etape="Terminé", detail="", resultat=tache["resultat"])
            elif tache["etat"] == "echec":
                vue.update(etape="Échec", detail="", erreur=dict(tache["erreur"]))
            vue["debut"] = _iso(tache["debut"])
            if tache["fin"] is not None:
                vue["fin"] = _iso(tache["fin"])
            return vue

    def statistiques(self) -> dict:
        with self._verrou:
            return {"en_cours": self._en_cours, "en_attente": len(self._file),
                    "conservees": len(self._taches)}
