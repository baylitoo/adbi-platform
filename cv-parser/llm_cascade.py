"""
llm_cascade.py — un appel LLM qui ne tombe pas en panne pour un service.

Pourquoi : jusqu'ici chaque appel partait vers un seul fournisseur. Si sa clé
expirait, si son quota était atteint ou si le service répondait mal, l'analyse
échouait. Ici, on essaie plusieurs modèles à la suite et on renvoie la première
réponse obtenue.

L'ordre est le suivant :

1. Le fournisseur choisi dans l'écran Paramètres, s'il a une clé.
2. La chaîne OVHcloud — six modèles, sans clé ni inscription, hébergés en UE.

Le deuxième point mérite une explication : le quota d'OVHcloud se compte PAR
MODÈLE. Un modèle bloqué ne dit donc rien des cinq autres, et passer au suivant
débloque immédiatement. C'est ce qui rend la chaîne efficace plutôt que
redondante.

L'ordre des modèles vient d'un banc d'essai (extraction d'un CV, calcul,
rédaction) : les trois premiers ont réussi les trois épreuves sans faute, les
suivants ont réussi l'extraction. Aucun modèle n'y figure sans avoir été mesuré.

OVHcloud s'engage à ne pas utiliser les données pour entraîner ses modèles et à
ne rien conserver, ce qui en fait le seul de nos fournisseurs défendable pour
des CV — qui sont des données personnelles.
"""

import json
import re
import threading

import requests

from config import DATA_DIR, get_active_llm

OVH_URL = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions"

# Session partagée : les connexions TLS sont réutilisées entre les appels
# (sondage puis envoi réel vers le même hôte) au lieu d'être renégociées.
_session = requests.Session()

# Chaîne personnalisée par l'écran Paramètres. Tant que ce fichier n'existe pas,
# la chaîne par défaut ci-dessous s'applique : l'application marche sans qu'on
# ait rien à configurer.
CHAINE_FICHIER = DATA_DIR / "llm_chaine.json"
_chaine_verrou = threading.Lock()

# Dernier service ayant réellement répondu. Permet à l'interface d'annoncer le
# modèle « en cours » plutôt que le modèle « prévu » : avec une cascade, les
# deux diffèrent dès qu'un service a été sauté.
_dernier = {"service": None, "ms": None, "quand": None, "sautes": 0}


def dernier_service() -> dict:
    return dict(_dernier)

# Chaîne de secours, ordonnée POUR L'EXTRACTION DE CV — le travail réel de cette
# application. Les dix modèles mesurés ont tous extrait un CV sans erreur ; ce
# qui les départage ici est donc, dans l'ordre : la justesse sur les nombres
# (une extraction calcule l'ancienneté à partir des dates), la régularité du
# temps de réponse, puis la vitesse.
CHAINE_OVH = (
    # Extraction 100 en 2,3 s, et le seul aussi juste sur les calculs.
    "Mistral-Small-3.2-24B-Instruct-2506",
    # Extraction 100 en 2,9 s, juste partout lui aussi.
    "gpt-oss-20b",
    # Extraction 100 en 2,6 s.
    "Meta-Llama-3_3-70B-Instruct",
    # Le plus rapide en extraction (1,6 s) et juste sur les calculs, mais c'est
    # un modèle raisonneur : sur un CV touffu il peut passer à 15 s. D'où sa
    # place ici plutôt qu'en tête. Son brouillon <think> est retiré par _nettoyer.
    "Qwen3-32B",
    # Extraction 100, mais 8,5 s.
    "Qwen3.5-397B-A17B",
    # Extraction 100 en 1,8 s — sauf qu'il s'est trompé sur le calcul de marge
    # (12 410 € au lieu de 6 270). Sur un CV aux dates ambiguës, l'ancienneté
    # est donc à surveiller : dernier recours seulement.
    "Mistral-Nemo-Instruct-2407",
)

TIMEOUT_DEFAUT = 60


class LLMIndisponible(RuntimeError):
    """Aucun modèle de la chaîne n'a pu répondre."""


# ── Chaîne configurable ───────────────────────────────────────────────────────

def chaine_defaut() -> list:
    """
    Chaîne appliquée tant que rien n'a été configuré.

    Uniquement des modèles OVHcloud, dans l'ordre mesuré sur l'extraction.
    OpenAI et OpenRouter ont été retirés : hors UE, l'un facturé, et leurs clés
    vivaient en clair dans config.py — inacceptable pour traiter des CV, qui
    sont des données personnelles.

    L'ordre reste modifiable depuis l'écran Paramètres ; une fois la chaîne
    enregistrée, c'est le fichier qui fait foi.
    """
    return [{
        "actif": True, "nom": "OVHcloud", "url": OVH_URL,
        "modele": m, "cle": "",
    } for m in CHAINE_OVH]


# Hôtes définitivement écartés. Le filtre porte sur l'URL et non sur le nom :
# une chaîne enregistrée avant leur retrait les ramènerait sinon en douce, et
# c'est justement le fichier qui fait foi sur le défaut.
HOTES_RETIRES = ("api.openai.com", "openrouter.ai")


def charger_chaine() -> list:
    if not CHAINE_FICHIER.exists():
        return chaine_defaut()
    try:
        entrees = json.loads(CHAINE_FICHIER.read_text(encoding="utf-8"))
        # Une liste VIDE enregistrée est un CHOIX (demande utilisateur 2026-09) :
        # aucun modèle, pas d'IA — l'application vit sur l'extraction locale et
        # les appels LLM répondent « Aucun service actif ». Pour retrouver les
        # modèles par défaut : bouton Réinitialiser (qui supprime ce fichier).
        if entrees == []:
            return []
        gardees = [
            e for e in entrees
            if e.get("url") and e.get("modele")
            and not any(h in e["url"] for h in HOTES_RETIRES)
        ]
        return gardees or chaine_defaut()
    except Exception:
        # Un fichier corrompu ne doit pas priver l'application de LLM.
        return chaine_defaut()


def enregistrer_chaine(entrees: list) -> list:
    propres = []
    for e in entrees:
        url    = (e.get("url") or "").strip()
        modele = (e.get("modele") or "").strip()
        if not url or not modele:
            continue
        if any(h in url for h in HOTES_RETIRES):
            continue        # ni réintroduits par l'interface
        propres.append({
            "actif":  bool(e.get("actif", True)),
            "nom":    (e.get("nom") or "Service").strip(),
            "url":    url,
            "modele": modele,
            "cle":    (e.get("cle") or "").strip(),
        })
    with _chaine_verrou:
        DATA_DIR.mkdir(exist_ok=True)
        CHAINE_FICHIER.write_text(
            json.dumps(propres, ensure_ascii=False, indent=2), encoding="utf-8")
    return propres


def reinitialiser_chaine() -> list:
    """Revient à la chaîne par défaut en supprimant la personnalisation."""
    with _chaine_verrou:
        if CHAINE_FICHIER.exists():
            CHAINE_FICHIER.unlink()
    return chaine_defaut()


def _nettoyer(texte: str) -> str:
    """
    Retire le brouillon des modèles « raisonneurs ».

    Certains écrivent leur réflexion au début de la réponse, entre balises
    <think>…</think>. Sans ce nettoyage, ce brouillon se retrouve collé dans le
    CV analysé — et fait échouer la recherche du JSON qui suit.
    """
    texte = re.sub(r"<think>[\s\S]*?</think>", "", texte, flags=re.I)
    texte = re.sub(r"^[\s\S]*?</think>", "", texte, count=1, flags=re.I)
    # Bloc de réflexion JAMAIS refermé : le modèle a été coupé par max_tokens
    # avant d'avoir fini de réfléchir. Tout ce qui suit est du brouillon, pas
    # une réponse. On le supprime : le contenu devient vide, _appel lève, et la
    # cascade passe au modèle suivant — au lieu de rendre à l'appelant le
    # monologue interne du modèle en le faisant passer pour un résultat.
    texte = re.sub(r"<think>[\s\S]*$", "", texte, flags=re.I)
    return texte.strip()


def _appel(url, cle, modele, messages, max_tokens, temperature, timeout, json_mode):
    corps = {
        "model": modele,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        corps["response_format"] = {"type": "json_object"}

    entetes = {"Content-Type": "application/json"}
    if cle:
        entetes["Authorization"] = f"Bearer {cle}"

    reponse = _session.post(url, headers=entetes, json=corps, timeout=timeout)
    # Tous les modèles n'acceptent pas response_format : plutôt que de perdre
    # un service pour cette seule raison, on réessaie sans la contrainte.
    if json_mode and reponse.status_code == 400 and "response_format" in reponse.text:
        corps.pop("response_format", None)
        reponse = _session.post(url, headers=entetes, json=corps, timeout=timeout)
    reponse.raise_for_status()

    message = reponse.json()["choices"][0]["message"]
    contenu = _nettoyer(message.get("content") or "")
    if not contenu:
        # Réponse vide : le modèle a épuisé son budget de jetons en raisonnant.
        raise ValueError("réponse vide")
    return contenu


TIMEOUT_SONDAGE = 6


TAILLE_VAGUE = 3


def sonder(candidats):
    """
    Cherche, maintenant, le premier service qui répond.

    Le sondage est refait à chaque appel, sans mémoire : un verdict vieux d'une
    minute ne dit rien de l'instant présent — le quota d'OVHcloud se compte par
    minute et par modèle, si bien qu'un service disponible il y a trente
    secondes peut être bloqué à l'appel suivant. Un cache faisait justement
    choisir un modèle déjà à court de quota.

    Il se fait par VAGUES parallèles de trois : en séquentiel, six services
    saturés coûtaient jusqu'à 60 s de sondage avant même le premier envoi
    (mesuré sur un dépôt réel). La vague borne l'attente à ~6 s par groupe,
    au prix de deux mini-sondages de plus au pire — 8 jetons chacun, sur des
    quotas comptés PAR MODÈLE : le surcoût est négligeable, le gain constant.
    En cas de plusieurs réponses dans la vague, l'ordre de la chaîne tranche.

    Renvoie (candidats réordonnés, service retenu ou None).
    """
    for depart in range(0, len(candidats), TAILLE_VAGUE):
        vague = candidats[depart:depart + TAILLE_VAGUE]
        verdicts = [False] * len(vague)

        def tester(rang, entree):
            verdicts[rang] = tester_entree(entree, timeout=TIMEOUT_SONDAGE)["ok"]

        fils = [threading.Thread(target=tester, args=(rang, entree), daemon=True)
                for rang, entree in enumerate(vague)]
        for f in fils:
            f.start()
        for f in fils:
            f.join(TIMEOUT_SONDAGE + 2)

        for rang, entree in enumerate(vague):
            if verdicts[rang]:
                i = depart + rang
                # Le service retenu passe en tête ; les autres gardent leur
                # ordre derrière lui, utilisables si le vrai appel échoue.
                return [entree] + candidats[:i] + candidats[i + 1:], entree
    return candidats, None


ATTENTE_QUOTA = 15          # secondes avant de retenter quand tout est saturé


def chat(messages, max_tokens=2000, temperature=0.0,
         timeout=TIMEOUT_DEFAUT, json_mode=False, verifier=True, valider=None,
         reprises=1, budget_s=None, progression=None):
    """
    Renvoie (contenu, modele_utilise).

    Par défaut, la chaîne est sondée juste avant l'envoi et le service retenu
    est celui qui répond à cet instant — pas celui qui répondait tout à l'heure.
    Le sondage coûte un petit appel ; en échange, le document n'est jamais
    expédié vers un service hors ligne ou à court de quota.

    Si aucun ne répond au sondage, on tente quand même la chaîne dans l'ordre :
    un sondage peut échouer là où le vrai appel passerait, et mieux vaut
    essayer que renoncer.

    `valider(contenu)` permet à l'appelant de refuser une réponse formellement
    reçue mais inutilisable — typiquement un JSON tronqué parce que le modèle a
    atteint sa limite de jetons. Elle compte alors comme un échec de CE modèle,
    et la cascade passe au suivant : sans cela, une réponse coupée en deux
    arrêtait tout, alors qu'un autre modèle aurait pu répondre entièrement.

    Lève LLMIndisponible seulement si TOUS les modèles ont échoué ; les appelants
    peuvent donc traiter cette exception comme « le service est hors ligne »
    plutôt que comme un incident ponctuel.

    `budget_s` borne la durée TOTALE (sondage + cascade + reprises) : passé ce
    budget, on abandonne pour laisser la main au repli local de l'appelant —
    l'utilisateur préfère une fiche « extraction locale » en une minute qu'une
    fiche parfaite en trois. `progression(texte)` tient l'interface au courant.
    """
    import time
    echeance = None if budget_s is None else time.monotonic() + budget_s

    def prevenir(texte):
        if progression:
            try:
                progression(texte)
            except Exception:
                pass

    tentatives = []
    candidats = [e for e in charger_chaine() if e.get("actif", True)]
    if not candidats:
        raise LLMIndisponible("Aucun service actif dans la chaîne (voir Paramètres).")

    if verifier:
        prevenir("recherche d'un service disponible…")
        candidats, retenu = sonder(candidats)
        if retenu:
            print(f"[LLM] sondage : {retenu['nom']}/{retenu['modele']} répond, c'est lui qui traite.")
            prevenir(f"{retenu['modele']} répond, analyse en cours…")
        else:
            print(f"[LLM] sondage : aucun des {len(candidats)} services ne répond, on tente quand même.")
            prevenir("services saturés, on insiste…")

    for e in candidats:
        etiquette = f"{e['nom']}/{e['modele']}"
        timeout_effectif = timeout
        if echeance is not None:
            restant = echeance - time.monotonic()
            if restant < 5:
                tentatives.append("budget de temps épuisé")
                break
            timeout_effectif = max(5, min(timeout, restant))
        debut = time.perf_counter()
        try:
            contenu = _appel(e["url"], e.get("cle"), e["modele"], messages,
                             max_tokens, temperature, timeout_effectif, json_mode)
            if valider is not None:
                valider(contenu)          # lève si la réponse est inexploitable
            if tentatives:
                print(f"[LLM] {etiquette} a pris le relais après "
                      f"{len(tentatives)} échec(s).")
            _dernier.update(service=etiquette, sautes=len(tentatives),
                            ms=round((time.perf_counter() - debut) * 1000),
                            quand=time.strftime("%H:%M:%S"))
            return contenu, etiquette
        except requests.exceptions.HTTPError as err:
            code = err.response.status_code if err.response is not None else "?"
            tentatives.append(f"{etiquette} : HTTP {code}")
        except requests.exceptions.Timeout:
            tentatives.append(f"{etiquette} : délai dépassé ({round(timeout_effectif)}s)")
        except Exception as err:                            # réseau, JSON, réponse vide
            tentatives.append(f"{etiquette} : {err}")

    # Toute la chaîne en quota dépassé : ce n'est pas une panne, c'est une
    # attente. Le palier gratuit se réarme à la minute ; abandonner ici rendait
    # une fiche vide alors qu'une pause suffisait. Mesuré sur 14 dépôts : 5
    # échecs de ce type, tous récupérables.
    quota_partout = tentatives and all(
        ("429" in t) or ("quota" in t.lower()) for t in tentatives
    )
    # La reprise n'a de sens que si le budget de temps la permet encore.
    budget_permet = echeance is None or (echeance - time.monotonic()) > ATTENTE_QUOTA + 10
    if quota_partout and reprises > 0 and budget_permet:
        print(f"[LLM] les {len(tentatives)} services sont en quota — "
              f"nouvelle tentative dans {ATTENTE_QUOTA} s.")
        prevenir(f"tous les services en quota, nouvel essai dans {ATTENTE_QUOTA} s…")
        time.sleep(ATTENTE_QUOTA)
        budget_restant = None if echeance is None else max(5, echeance - time.monotonic())
        return chat(messages, max_tokens=max_tokens, temperature=temperature,
                    timeout=timeout, json_mode=json_mode, verifier=verifier,
                    valider=valider, reprises=reprises - 1,
                    budget_s=budget_restant, progression=progression)

    raise LLMIndisponible(
        f"Les {len(candidats)} services essayés ont échoué — " + " | ".join(tentatives)
    )


def chat_plusieurs(messages, nombre=3, max_tokens=2000, temperature=0.0,
                   timeout=TIMEOUT_DEFAUT, json_mode=False, valider=None):
    """
    Pose la MÊME question à plusieurs modèles différents, en parallèle.

    Renvoie [(contenu, etiquette), …] : au plus `nombre` réponses, autant que
    de modèles ayant effectivement répondu.

    Pourquoi plusieurs plutôt qu'un : mesuré sur ce projet, un même modèle note
    le même candidat 77 puis 66 sur la même fiche de poste. Tant que la note
    n'est qu'indicative, l'écart se tolère ; dès qu'un seuil décide qui est
    présenté au client, il change le verdict. Recouper plusieurs modèles réduit
    cette variance et rend visible un désaccord réel.

    Le coût en attente est nul : les appels partent ensemble, et le quota du
    palier gratuit d'OVHcloud se compte PAR MODÈLE et par minute — trois
    modèles distincts consomment trois quotas distincts, pas trois fois un.

    Contrairement à `chat`, aucun sondage préalable : sonder puis appeler
    doublerait les requêtes sur chaque modèle. Un modèle qui échoue est
    simplement remplacé par le suivant de la chaîne.
    """
    candidats = [e for e in charger_chaine() if e.get("actif", True)]
    if not candidats:
        raise LLMIndisponible("Aucun service actif dans la chaîne (voir Paramètres).")

    verrou = threading.Lock()
    a_essayer, reponses, echecs = list(candidats), [], []

    def travailler():
        while True:
            with verrou:
                if len(reponses) >= nombre or not a_essayer:
                    return
                e = a_essayer.pop(0)
            etiquette = f"{e['nom']}/{e['modele']}"
            try:
                contenu = _appel(e["url"], e.get("cle"), e["modele"], messages,
                                 max_tokens, temperature, timeout, json_mode)
                if valider is not None:
                    valider(contenu)
                with verrou:
                    if len(reponses) < nombre:
                        reponses.append((contenu, etiquette))
                print(f"[LLM] {etiquette} a rendu son avis.")
            except Exception as err:
                with verrou:
                    echecs.append(f"{etiquette} : {err}")
                print(f"[LLM] {etiquette} écarté : {err}")

    fils = [threading.Thread(target=travailler, daemon=True)
            for _ in range(min(nombre, len(candidats)))]
    for f in fils:
        f.start()

    # Un modèle lent ne doit pas retenir tout le monde : mesuré, trois avis en
    # parallèle ont pris 124 s là où deux suffisaient en 41 s, l'écart venant
    # d'un seul traînard. Dès qu'on tient le quorum, les retardataires ont un
    # délai de grâce, puis on repart avec ce qu'on a.
    import time
    quorum, grace = max(2, nombre - 1), 20
    debut, quorum_a = time.monotonic(), None
    while any(f.is_alive() for f in fils):
        with verrou:
            n = len(reponses)
        ecoule = time.monotonic() - debut
        if n >= nombre or ecoule > timeout + 20:
            break
        if n >= quorum:
            if quorum_a is None:
                quorum_a = ecoule
            elif ecoule - quorum_a > grace:
                print(f"[LLM] {n} avis obtenus, on n'attend pas les retardataires.")
                break
        time.sleep(0.25)

    with verrou:
        obtenues = list(reponses)
    if not obtenues:
        raise LLMIndisponible(
            f"Aucun des {len(candidats)} services n'a répondu — " + " | ".join(echecs))
    return obtenues


def tester_entree(entree: dict, timeout: int = 20) -> dict:
    """
    Vérifie qu'un service répond. Renvoie {ok, detail, ms}.

    On ne passe PAS par _appel : celui-ci exige un contenu utilisable, ce qui
    est une exigence de production, pas de diagnostic. Un modèle raisonneur
    interrogé sur 8 jetons les consomme tous à réfléchir et rend un contenu
    vide — il était alors déclaré en panne alors qu'il répondait parfaitement.
    Ce qu'on veut savoir ici tient en une question : le service accepte-t-il la
    requête ? Un HTTP 200 y répond.
    """
    import time
    debut = time.perf_counter()
    try:
        corps = {"model": entree["modele"], "max_tokens": 8, "temperature": 0.0,
                 "messages": [{"role": "user", "content": "ping"}]}
        entetes = {"Content-Type": "application/json"}
        if entree.get("cle"):
            entetes["Authorization"] = f"Bearer {entree['cle']}"
        reponse = _session.post(entree["url"], headers=entetes, json=corps, timeout=timeout)
        reponse.raise_for_status()
        return {"ok": True, "detail": "répond",
                "ms": round((time.perf_counter() - debut) * 1000)}
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response is not None else "?"
        # Un 429 n'est pas une panne : le quota se compte par modèle et se
        # réarme seul. Le distinguer évite d'aller débrancher un service sain.
        detail = ("quota atteint sur ce modèle" if code == 429
                  else "clé refusée" if code in (401, 403)
                  else f"HTTP {code}")
        return {"ok": False, "detail": detail, "ms": None}
    except requests.exceptions.Timeout:
        return {"ok": False, "detail": f"délai dépassé ({timeout}s)", "ms": None}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:120], "ms": None}


def etat() -> dict:
    """
    Diagnostic pour l'écran Paramètres : premier service qui répond, et son rang.

    On s'arrête au premier succès afin de ne pas consommer inutilement le quota
    des suivants.
    """
    entrees = [e for e in charger_chaine() if e.get("actif", True)]
    for rang, e in enumerate(entrees, start=1):
        if tester_entree(e)["ok"]:
            return {"ok": True, "service": f"{e['nom']}/{e['modele']}",
                    "rang": rang, "total": len(entrees)}
    return {"ok": False, "service": None, "rang": None, "total": len(entrees)}
