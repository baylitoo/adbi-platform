"use strict";
// Rapprochement derrière une seule interface : rapprocher(opportunite, session) -> [{ profil_id, nom, score, raisons[] }].

const COURT_MAX = 300;
const TEXTE_MAX = 20000;
const LISTE_MAX = 60;
const ENTREE_MAX = 100;
const LIMITE = 10;
const DELAI_MS = 90 * 1000;

class ErreurRapprochement extends Error {
  constructor(code, message, statut = null) {
    super(message);
    this.name = "ErreurRapprochement";
    this.code = code;
    this.statut = statut;
  }
}

const court = (v) => (typeof v === "string" ? v.trim().slice(0, COURT_MAX) : "");

// Corps d'un besoin cv-parser (api/needs_bp.py), borné à ses plafonds ; `title` y est obligatoire.
function besoinDepuisOpportunite(o, texteSource) {
  const c = o || {};
  const competences = (Array.isArray(c.competences) ? c.competences : [])
    .map((s) => String(s).trim().slice(0, ENTREE_MAX)).filter(Boolean).slice(0, LISTE_MAX);
  const corps = {
    title: court(c.intitule) || (court(c.entreprise) ? "Opportunité " + court(c.entreprise) : "Opportunité sourcing").slice(0, COURT_MAX),
    required_skills: competences,
    context: String(texteSource || "").slice(0, TEXTE_MAX),
    client: court(c.client_final) || court(c.entreprise),
    location: court(c.localisation),
    seniority: court(c.seniorite),
    contract_type: c.type_contrat && c.type_contrat !== "inconnu" ? court(c.type_contrat) : "",
    start_date: court(c.date_debut || ""),
  };
  return Object.fromEntries(Object.entries(corps).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
}

// Résultat cv-parser (core/matcher.py) -> forme commune ; ni courriel ni téléphone ne sont conservés.
function resultatCommun(r) {
  const e = (r && r.explanation) || {};
  const raisons = [...(Array.isArray(e.strengths) ? e.strengths : []), ...(e.summary ? [e.summary] : [])]
    .filter((x) => typeof x === "string" && x.trim()).slice(0, 6);
  const total = r && r.score && typeof r.score.total === "number" ? r.score.total : null;
  return {
    profil_id: String((r && r.candidate_id) || ""), nom: String((r && r.candidate_name) || ""),
    titre: String((r && r.candidate_title) || ""), score: total, raisons,
  };
}

class RapprocheurCvtheque {
  constructor({ baseUrl, fetchImpl = fetch, delaiMs = DELAI_MS } = {}) {
    this.nom = "cvtheque";
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.delaiMs = delaiMs;
  }

  async appeler(methode, chemin, jeton, corps) {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.delaiMs);
    let reponse;
    try {
      reponse = await this.fetchImpl(this.baseUrl + chemin, {
        method: methode, redirect: "manual", signal: controleur.signal,
        headers: { Authorization: "Bearer " + jeton, "Content-Type": "application/json", Accept: "application/json" },
        body: corps === undefined ? undefined : JSON.stringify(corps),
      });
    } catch {
      throw new ErreurRapprochement(controleur.signal.aborted ? "delai" : "injoignable",
        controleur.signal.aborted ? "La CVthèque n'a pas répondu à temps." : "CVthèque injoignable.");
    } finally {
      clearTimeout(minuteur);
    }
    let json = null;
    try { json = await reponse.json(); } catch { json = null; }
    return { statut: reponse.status, json };
  }

  // `session.jeton` : l'adbi_access de l'utilisateur, relayé tel quel ; `session.besoin_id` : besoin déjà créé pour cet élément.
  async rapprocher(opportunite, session) {
    if (!this.baseUrl) throw new ErreurRapprochement("configuration", "Adresse de la CVthèque non configurée (SOURCING_CVTHEQUE_URL).");
    if (!session || !session.jeton) throw new ErreurRapprochement("session", "Session absente : relancez le rapprochement depuis la plateforme.");
    const corps = besoinDepuisOpportunite(opportunite, session.texte);
    let besoinId = session.besoin_id || null;
    if (besoinId) {
      const maj = await this.appeler("PATCH", "/api/needs/" + encodeURIComponent(besoinId), session.jeton, corps);
      if (maj.statut === 404) besoinId = null;
      else this.verifier(maj);
    }
    if (!besoinId) {
      const cree = await this.appeler("POST", "/api/needs", session.jeton, corps);
      this.verifier(cree, 201);
      besoinId = cree.json && cree.json.id ? String(cree.json.id) : null;
      if (!besoinId) throw new ErreurRapprochement("reponse", "Réponse de la CVthèque invalide.");
    }
    session.besoin_id = besoinId;
    const match = await this.appeler("POST", "/api/needs/" + encodeURIComponent(besoinId) + "/match?limit=" + LIMITE, session.jeton);
    this.verifier(match);
    const resultats = match.json && Array.isArray(match.json.results) ? match.json.results : null;
    if (!resultats) throw new ErreurRapprochement("reponse", "Réponse de la CVthèque invalide.");
    return resultats.slice(0, LIMITE).map(resultatCommun);
  }

  verifier({ statut, json }, attendu = 200) {
    if (statut === attendu || (attendu === 200 && statut === 201)) return;
    if (statut === 401 || statut === 403) throw new ErreurRapprochement("session", "Session refusée par la CVthèque : rouvrez la plateforme puis relancez le rapprochement.", statut);
    if (statut === 503) throw new ErreurRapprochement("occupe", "CVthèque occupée : relancez le rapprochement dans quelques secondes.", statut);
    if (statut === 400) throw new ErreurRapprochement("refus", "Besoin refusé par la CVthèque" + (json && typeof json.error === "string" ? " : " + json.error.slice(0, 200) : "."), statut);
    throw new ErreurRapprochement("amont", "La CVthèque a répondu en erreur (HTTP " + statut + ").", statut);
  }
}

// Emplacement réservé au futur adaptateur CRM : choisi par SOURCING_RAPPROCHEUR=crm, il refuse tant qu'il n'est pas écrit.
class RapprocheurCrm {
  constructor() { this.nom = "crm"; }
  async rapprocher() {
    throw new ErreurRapprochement("non_disponible", "Rapprochement CRM pas encore disponible.");
  }
}

const ADAPTATEURS = Object.freeze({ cvtheque: RapprocheurCvtheque, crm: RapprocheurCrm });

function rapprocheurDepuisEnv(env = process.env, deps = {}) {
  const nom = String(env.SOURCING_RAPPROCHEUR || "").trim().toLowerCase() || "cvtheque";
  const Classe = Object.hasOwn(ADAPTATEURS, nom) ? ADAPTATEURS[nom] : null;
  if (!Classe) throw new Error(`SOURCING_RAPPROCHEUR doit valoir ${Object.keys(ADAPTATEURS).join(" ou ")} (reçu : ${JSON.stringify(nom)}).`);
  return new Classe({ baseUrl: env.SOURCING_CVTHEQUE_URL, ...deps });
}

module.exports = { rapprocheurDepuisEnv, RapprocheurCvtheque, RapprocheurCrm, ErreurRapprochement, besoinDepuisOpportunite, resultatCommun, ADAPTATEURS };
