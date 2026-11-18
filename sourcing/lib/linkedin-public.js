"use strict";
// Recherche d'offres sur les pages publiques LinkedIn, sans compte ; tout blocage arrête la source, sans contournement.

const BASE = "https://www.linkedin.com";
const AGENT = "adbi-sourcing/1.0";
const DELAI_MS = 15000;
const INTERVALLE_MS = 3000;
const PAUSE_BLOCAGE_MS = 15 * 60 * 1000;
const MAX_OFFRES = 60;
const PERIODES_JOURS = Object.freeze([1, 3, 7, 14, 21, 30]);
const DISTANCES_MILES = Object.freeze([5, 10, 25, 50, 100]);
const ID_OFFRE = /^\d{6,20}$/;

class ErreurSource extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ErreurSource";
    this.code = code;
  }
}

const ENTITES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decoder(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITES[e.toLowerCase()] ?? m;
  });
}

const texteBrut = (html) => decoder(String(html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// Le HTML de la description devient des lignes : DocIE cite ses preuves ligne par ligne.
function texteEnLignes(html) {
  const s = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decoder(s).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
}

function classe(html, nom) {
  const m = html.match(new RegExp(`<([a-z0-9]+)[^>]*class="[^"]*\\b${nom}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, "i"));
  return m ? m[2] : "";
}

const urlOffre = (id) => `${BASE}/jobs/view/${id}`;

function lireCartes(html) {
  const offres = [];
  const vus = new Set();
  for (const bloc of html.split(/<li\b/i).slice(1)) {
    const urn = bloc.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    if (!urn || vus.has(urn[1])) continue;
    vus.add(urn[1]);
    const date = bloc.match(/<time[^>]*class="[^"]*job-search-card__listdate[^"]*"[^>]*datetime="([\d-]+)"/i);
    offres.push({
      id: urn[1], url: urlOffre(urn[1]),
      intitule: texteBrut(classe(bloc, "base-search-card__title")),
      entreprise: texteBrut(classe(bloc, "base-search-card__subtitle")),
      localisation: texteBrut(classe(bloc, "job-search-card__location")),
      publie_le: date ? date[1] : null,
    });
    if (offres.length >= MAX_OFFRES) break;
  }
  return offres;
}

// Page de défi anti-robot : rafraîchissement vers l'accueil et script masqué.
const estDefi = (html) => /http-equiv="refresh"[^>]*url=https:\/\/www\.linkedin\.com/i.test(html) || /var _0x[0-9a-f]+=/i.test(html);

function creerSourceLinkedin({ fetchImpl = globalThis.fetch, horloge = Date.now, attendre = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let file = Promise.resolve();
  let dernier = 0;
  let bloqueJusqua = 0;

  function bloquer(code, message) {
    bloqueJusqua = horloge() + PAUSE_BLOCAGE_MS;
    return new ErreurSource(code, message);
  }

  async function lire(url) {
    if (horloge() < bloqueJusqua) {
      const minutes = Math.ceil((bloqueJusqua - horloge()) / 60000);
      throw new ErreurSource("pause", `LinkedIn a refusé une requête récente : source suspendue encore ${minutes} min.`);
    }
    const reste = dernier + INTERVALLE_MS - horloge();
    if (reste > 0) await attendre(reste);
    dernier = horloge();
    let r;
    try {
      r = await fetchImpl(url, { headers: { "User-Agent": AGENT, "Accept-Language": "fr-FR,fr;q=0.9" }, signal: AbortSignal.timeout(DELAI_MS) });
    } catch (e) {
      throw new ErreurSource("injoignable", "LinkedIn ne répond pas.");
    }
    if (/\/(authwall|login|checkpoint)\b/i.test(r.url || "")) throw bloquer("connexion", "LinkedIn exige une connexion : source suspendue 15 min.");
    if (r.status === 404 || r.status === 410) throw new ErreurSource("introuvable", "Offre introuvable ou retirée.");
    if (r.status !== 200) throw bloquer("refus", `LinkedIn a refusé la requête (HTTP ${r.status}) : source suspendue 15 min.`);
    const html = await r.text();
    if (estDefi(html)) throw bloquer("defi", "LinkedIn demande une vérification anti-robot : source suspendue 15 min.");
    return html;
  }

  // Requêtes à la suite, jamais en parallèle, quel que soit le nombre d'utilisateurs.
  function enFile(travail) {
    const suite = file.then(travail, travail);
    file = suite.catch(() => {});
    return suite;
  }

  // La page publique rend 60 offres au plus et renvoie vers la connexion au-delà : pas de pagination.
  async function rechercher({ motsCles, lieu, jours = null, distance = null }) {
    const p = new URLSearchParams({ keywords: motsCles });
    if (lieu) p.set("location", lieu);
    if (jours) p.set("f_TPR", "r" + jours * 86400);
    if (distance && lieu) p.set("distance", String(distance));
    const html = await enFile(() => lire(`${BASE}/jobs/search?${p}`));
    let offres = lireCartes(html);
    if (!offres.length && !/jobs-search__results-list|no-results/i.test(html)) {
      throw new ErreurSource("format", "Page de résultats LinkedIn méconnaissable : la source a peut-être changé de format.");
    }
    if (jours) {
      const depuis = new Date(horloge() - jours * 86400000).toISOString().slice(0, 10);
      offres = offres.filter((o) => !o.publie_le || o.publie_le >= depuis);
    }
    return offres;
  }

  async function detail(id) {
    if (!ID_OFFRE.test(String(id))) throw new ErreurSource("introuvable", "Identifiant d'offre invalide.");
    const html = await enFile(() => lire(urlOffre(id)));
    const description = texteEnLignes(classe(html, "show-more-less-html__markup"));
    if (!description) throw new ErreurSource("format", "Description de l'offre absente : la page LinkedIn a peut-être changé de format.");
    const criteres = [];
    const secteurs = [];
    for (const m of html.matchAll(/<li[^>]*class="[^"]*description__job-criteria-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
      const nom = texteBrut(classe(m[1], "description__job-criteria-subheader"));
      const valeur = texteBrut(classe(m[1], "description__job-criteria-text"));
      if (nom && valeur) criteres.push(`${nom} : ${valeur}`);
      if (/secteur|industr/i.test(nom) && valeur) secteurs.push(valeur);
    }
    return {
      id: String(id), url: urlOffre(id),
      intitule: texteBrut(classe(html, "top-card-layout__title")),
      entreprise: texteBrut(classe(html, "topcard__org-name-link")),
      localisation: texteBrut((html.match(/<span class="topcard__flavor topcard__flavor--bullet">([\s\S]*?)<\/span>/i) || [])[1]),
      criteres, secteurs: secteurs.join(", "), employeur: employeurDepuisSecteurs(secteurs.join(", ")), description,
    };
  }

  return { rechercher, detail };
}

// Nature de l'employeur d'après le secteur LinkedIn : un client final est un prospect, une ESN un concurrent ou un partenaire.
function employeurDepuisSecteurs(secteurs) {
  const t = String(secteurs || "").toLowerCase();
  if (!t) return "inconnu";
  if (/recrutement|ressources humaines|staffing|recruit|int[ée]rim|placement/.test(t)) return "recrutement";
  if (/conseil|consulting|services informatiques|it services|technologies et services de l.information|esn|ssii/.test(t)) return "esn_conseil";
  return "client_final";
}

// Texte de l'élément : en-tête puis description, coupé à une fin de ligne quand il dépasse la limite du module.
function texteDeLOffre(o, max) {
  const entete = [o.intitule, [o.entreprise, o.localisation].filter(Boolean).join(" — "), ...o.criteres].filter(Boolean);
  const complet = [...entete, "", o.description].join("\n");
  if ([...complet].length <= max) return { texte: complet, tronque: false };
  const coupe = [...complet].slice(0, max).join("");
  const fin = coupe.lastIndexOf("\n");
  return { texte: fin > max / 2 ? coupe.slice(0, fin) : coupe, tronque: true };
}

const sourceActive = (env = process.env) => ["1", "true", "oui"].includes(String(env.SOURCING_LINKEDIN_PUBLIC || "").trim().toLowerCase());

module.exports = {
  creerSourceLinkedin, texteDeLOffre, sourceActive, urlOffre, employeurDepuisSecteurs, ErreurSource, lireCartes,
  MAX_OFFRES, PERIODES_JOURS, DISTANCES_MILES,
};
