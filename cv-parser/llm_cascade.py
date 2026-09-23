"""
llm_cascade.py — un appel LLM qui ne tombe pas en panne pour un service.

Pourquoi : jusqu'ici chaque appel partait vers un seul fournisseur. Si sa clé
expirait, si son quota était atteint ou si le service répondait mal, l'analyse
échouait. Ici, on essaie plusieurs modèles à la suite et on renvoie la première
réponse obtenue.

Fournisseur : la passerelle d'inférence auto-hébergée ADBI (base URL + clé
posées par ADBI_LLM_BASE_URL / ADBI_LLM_API_KEY, voir config.py), compatible
API OpenAI. OpenAI, OpenRouter puis OVHcloud AI Endpoints ont été utilisés
avant elle et sont tous retirés : aucun appel ne doit repartir vers un tiers
non identifié — un CV est une donnée personnelle.

La chaîne reste utile même avec un seul fournisseur : plusieurs modèles
(ADBI_LLM_MODELS, séparés par des virgules) peuvent être essayés dans l'ordre
si le premier échoue ou est à court de quota côté passerelle.
"""

import json
import os
import re
import threading

import requests

from config import DATA_DIR, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
from llm_url import chat_endpoint

# Session partagée : les connexions TLS sont réutilisées entre les appels.
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

TIMEOUT_DEFAUT = 60


class LLMIndisponible(RuntimeError):
    """Aucun modèle de la chaîne n'a pu répondre."""


# ── Chaîne configurable ───────────────────────────────────────────────────────

def candidats_chat() -> list:
    """Modèles de chat proposés maintenant : store DocIE (catalogue `chat` puis découverts), sinon ADBI_LLM_MODELS."""
    if not LLM_BASE_URL:
        return []
    try:
        import choix_modele
        from docie_bridge_extraction import _load_bridge
        offres = choix_modele.charger().modeles_chat(_load_bridge().store_utilisable())
    except Exception:
        offres = []
    if offres:
        return [{"modele": o["identifiant"], "nom": o["libelle"], "decouvert": o["decouvert"]} for o in offres]
    modeles = [m.strip() for m in os.environ.get("ADBI_LLM_MODELS", "").split(",") if m.strip()]
    if not modeles and LLM_MODEL:
        modeles = [LLM_MODEL]
    return [{"modele": m, "nom": "ADBI", "decouvert": False} for m in modeles]


def chaine_defaut() -> list:
    """
    Chaîne appliquée tant que rien n'a été enregistré : chaque modèle de chat
    proposé, dans l'ordre, sur la passerelle d'inférence ADBI (ADBI_LLM_BASE_URL
    / ADBI_LLM_API_KEY, config.py). Vide si ADBI_LLM_BASE_URL n'est pas posée :
    pas d'IA tant que ce n'est pas configuré, l'extraction locale reste là.

    URL et clé viennent TOUJOURS de l'environnement, jamais d'un navigateur :
    le fichier de la chaîne ne porte que l'ordre et l'activation des modèles.
    """
    return [{"actif": True, "url": LLM_BASE_URL, "cle": LLM_API_KEY, **c} for c in candidats_chat()]


def _nu(modele: str) -> str:
    return str(modele or "").strip().removeprefix("store:")


def charger_chaine() -> list:
    """Chaîne courante : ordre et activation enregistrés appliqués aux modèles proposés maintenant.

    Un modèle enregistré qui n'est plus proposé disparaît ; un modèle nouvellement
    prêt sur DocIE s'ajoute en fin, actif. Une liste VIDE enregistrée est un
    CHOIX (2026-09) : pas d'IA, « Revenir au défaut » supprime le fichier.
    """
    candidats = chaine_defaut()
    if not CHAINE_FICHIER.exists():
        return candidats
    try:
        enregistrees = json.loads(CHAINE_FICHIER.read_text(encoding="utf-8"))
    except Exception:
        # Un fichier corrompu ne doit pas priver l'application de LLM.
        return candidats
    if enregistrees == []:
        return []
    if not isinstance(enregistrees, list):
        return candidats
    par_modele = {_nu(c["modele"]): c for c in candidats}
    ordonnees = []
    for e in enregistrees:
        c = par_modele.pop(_nu(e.get("modele")), None) if isinstance(e, dict) else None
        if c:
            ordonnees.append({**c, "actif": bool(e.get("actif", True))})
    chaine = ordonnees + list(par_modele.values())
    # Fichier d'avant (URL et clé enregistrées depuis le navigateur) : réécrit sans, une fois ; vide = supprimé, jamais un « [] » qui vaudrait « pas d'IA ».
    if any(isinstance(e, dict) and ("cle" in e or "url" in e) for e in enregistrees):
        if chaine:
            enregistrer_chaine(chaine)
        else:
            reinitialiser_chaine()
    return chaine


def enregistrer_chaine(entrees: list) -> list:
    """N'enregistre que {modele, actif, nom} parmi les modèles proposés ; ValueError sur un modèle inconnu."""
    proposes = {_nu(c["modele"]): c for c in chaine_defaut()}
    propres = []
    for e in entrees:
        modele = _nu((e or {}).get("modele"))
        if not modele:
            continue
        if modele not in proposes:
            raise ValueError(f"Modèle non proposé par la passerelle : {modele}")
        propres.append({"actif": bool(e.get("actif", True)), "nom": proposes[modele]["nom"], "modele": proposes[modele]["modele"]})
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
    url = chat_endpoint(url)
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


def chat(messages, max_tokens=2000, temperature=0.0,
         timeout=TIMEOUT_DEFAUT, json_mode=False, valider=None,
         budget_s=None, progression=None):
    """
    Renvoie (contenu, modele_utilise) : les modèles actifs de la chaîne sont
    essayés dans l'ordre, le premier qui rend une réponse valide gagne.

    `valider(contenu)` refuse une réponse reçue mais inutilisable (JSON
    tronqué) : elle compte comme un échec de CE modèle, le suivant est essayé.
    `budget_s` borne la durée TOTALE de la cascade ; passé ce budget, on rend
    la main au repli local de l'appelant. `progression(texte)` tient
    l'interface au courant.

    Lève LLMIndisponible si TOUS les modèles ont échoué.
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

    for e in candidats:
        etiquette = f"{e['nom']}/{e['modele']}"
        timeout_effectif = timeout
        if echeance is not None:
            restant = echeance - time.monotonic()
            if restant < 5:
                tentatives.append("budget de temps épuisé")
                break
            timeout_effectif = max(5, min(timeout, restant))
        prevenir(f"{e['modele']} : analyse en cours…")
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
        reponse = _session.post(chat_endpoint(entree["url"]), headers=entetes, json=corps, timeout=timeout)
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
