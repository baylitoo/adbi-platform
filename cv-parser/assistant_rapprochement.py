"""Assistant du rapprochement : conversation avec un modèle choisi sur les profils les mieux classés, contexte reconstruit côté serveur."""
import choix_modele
import docie_client
import llm_cascade
from config import LLM_API_KEY, LLM_BASE_URL
from core import cvstore_pg
from core.matcher import run_matching
from core.rapprochement import _resume_candidat

TACHE = "rapprochement"
PROFILS_MAX = 5
MESSAGES_MAX = 20
MESSAGE_MAX = 4000
FICHE_MAX = 4000
REPONSE_MAX_TOKENS = 1500
DELAI_S = 120

CONSIGNES = """Tu es l'assistant de recrutement d'ADBI, une entreprise de services numériques. Tu aides un recruteur à discuter des profils classés face à une fiche de poste.
Règles :
- Réponds en français, avec le vouvoiement, de façon concise et concrète.
- Appuie-toi UNIQUEMENT sur la fiche et les profils fournis ci-dessous ; n'invente aucune compétence, expérience ni disponibilité.
- Le score sur 100 vient d'un moteur de règles ADBI (compétences, titre, séniorité, missions, disponibilité, bonus) : ne le recalcule pas, explique-le si on te le demande.
- Désigne chaque candidat par son nom ; si une information manque au profil, dis-le.
- Pour un argumentaire client, rédige un texte prêt à envoyer, sans coordonnées personnelles."""


class AssistantIndisponible(RuntimeError):
    """Échec de l'assistant ; `public` est un message français constant, montrable tel quel."""

    def __init__(self, code, public):
        super().__init__(public)
        self.code = code
        self.public = public


def offres():
    """Modèles proposés pour l'assistant, défaut d'abord ; liste vide si aucun."""
    try:
        catalogue = choix_modele.charger()
        proposes = catalogue.modeles_offerts(TACHE, "chat", externes=True, store=choix_modele.store_pret())
    except Exception:
        return []
    return [{"id": o["id"], "libelle": o["libelle"], "description": o["description"], "role": o["role"],
             "experimental": o.get("experimental") is True, "externe": bool(o.get("fournisseur"))}
            for o in proposes]


def _critere(besoin):
    morceaux = [f"Intitulé : {besoin.get('title') or '—'}"]
    if besoin.get("required_skills"):
        morceaux.append("Compétences exigées : " + ", ".join(str(s) for s in besoin["required_skills"]))
    for cle, nom in (("seniority", "Séniorité"), ("min_years", "Années minimum"), ("location", "Lieu"),
                     ("contract_type", "Contrat"), ("remote", "Télétravail")):
        if besoin.get(cle):
            morceaux.append(f"{nom} : {besoin[cle]}")
    return "\n".join(morceaux)


def _bloc_profil(resultat, cv):
    sc = resultat.get("score") or {}
    ex = resultat.get("explanation") or {}
    lignes = [f"nom: {resultat.get('candidate_name') or 'sans nom'}", _resume_candidat(resultat, cv),
              f"  score règles: {sc.get('total', 0)}/100 (compétences {sc.get('skills', 0)}/35, titre {sc.get('title', 0)}/20, "
              f"séniorité {sc.get('seniority', 0)}/15, missions {sc.get('missions', 0)}/10, "
              f"disponibilité {sc.get('availability', 0)}/10, bonus {sc.get('bonus', 0)}/10)"]
    if ex.get("missing_skills"):
        lignes.append("  compétences exigées absentes du profil: " + ", ".join(ex["missing_skills"]))
    return "\n".join(lignes)


def consignes(besoin, description, cv_ids):
    """Consignes système : règles, fiche, et les profils (au plus PROFILS_MAX) relus en base et re-notés."""
    ids = [str(i) for i in cv_ids][:PROFILS_MAX]
    if not ids:
        raise AssistantIndisponible("input", "Aucun profil à discuter : lancez d'abord le classement.")
    cvs = {i: cvstore_pg.get_cv(i) for i in ids}
    cvs = {i: cv for i, cv in cvs.items() if cv}
    if not cvs:
        raise AssistantIndisponible("input", "Les profils demandés n'existent plus dans la CVthèque.")
    resultats = run_matching(besoin, limit=len(cvs), ids=list(cvs))
    resultats.sort(key=lambda r: r["score"]["total"], reverse=True)
    profils = "\n\n".join(_bloc_profil(r, cvs[r["candidate_id"]]) for r in resultats if r["candidate_id"] in cvs)
    return (f"{CONSIGNES}\n\nFICHE DE POSTE (critères retenus) :\n{_critere(besoin)}\n\n"
            f"FICHE DE POSTE (texte) :\n---\n{str(description or '')[:FICHE_MAX]}\n---\n\n"
            f"PROFILS CLASSÉS ({len(resultats)}) :\n{profils}")


def _messages(messages):
    propres = []
    for m in (messages or [])[-MESSAGES_MAX:]:
        role = m.get("role") if isinstance(m, dict) else None
        texte = str(m.get("content") or "").strip()[:MESSAGE_MAX] if isinstance(m, dict) else ""
        if role in ("user", "assistant") and texte:
            propres.append({"role": role, "content": texte})
    if not propres or propres[-1]["role"] != "user":
        raise AssistantIndisponible("input", "Posez une question à l'assistant.")
    return propres


def repondre(modele, besoin, description, cv_ids, messages):
    """(réponse, libellé du modèle) ; AssistantIndisponible sinon, jamais un autre modèle que celui choisi."""
    historique = _messages(messages)
    catalogue = choix_modele.charger()
    try:
        offre = catalogue.choisir_modele(TACHE, "chat", modele or (offres() or [{}])[0].get("id") or "",
                                         externes=True, store=choix_modele.store_pret())
    except catalogue.CatalogueError as exc:
        raise AssistantIndisponible(exc.code, str(exc)) from None
    systeme = consignes(besoin if isinstance(besoin, dict) else {}, description, cv_ids)
    if offre.get("fournisseur"):
        openai_responses = docie_client._charger_openai()
        try:
            sortie = openai_responses.converser_via_openai(systeme, historique, mode=offre["mode"])
        except Exception as exc:
            code = getattr(exc, "code", None) or "inconnu"
            raise AssistantIndisponible(code, "Service externe (hors ADBI) : "
                                        + docie_client._MESSAGES_EXTERNE.get(code, "échec de la réponse.")) from None
        return sortie["texte"], offre["libelle"]
    if not LLM_BASE_URL:
        raise AssistantIndisponible("configuration", "Passerelle de chat non configurée côté serveur.")
    try:
        texte = llm_cascade._appel(LLM_BASE_URL, LLM_API_KEY, offre["identifiant"],
                                   [{"role": "system", "content": systeme}, *historique],
                                   REPONSE_MAX_TOKENS, 0.2, DELAI_S, False)
    except Exception as exc:
        print(f"[ASSISTANT] {offre['libelle']} sans réponse : {type(exc).__name__}")
        raise AssistantIndisponible("upstream", f"{offre['libelle']} n'a pas répondu ; réessayez dans un instant.") from None
    return texte, offre["libelle"]
