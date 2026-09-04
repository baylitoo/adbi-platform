"use strict";

/**
 * matching.js — mise en relation d'une fiche de poste et du vivier.
 *
 * On colle une annonce en texte libre, le module classe les consultants et
 * explique chaque position. Aucun modele de langage : tout est deterministe et
 * hors ligne, adosse aux referentiels deja presents (taxonomy, fonctionnel).
 * Une note qu'on ne peut pas justifier ne sert a rien commercialement : chaque
 * point attribue produit une « raison » lisible, et chaque point perdu un
 * « manque » — c'est cette seconde liste qui prepare la reponse au client.
 *
 * ---------------------------------------------------------------- BAREME ---
 * Score sur 100, cinq axes :
 *
 *   Technologies .......... 40 pts
 *     Recouvrement pondere par le weight du referentiel (une techno rare et
 *     demandee pese plus qu'une banale) ET par la recence : une techno vue
 *     pour la derniere fois il y a 8 ans ne vaut plus que ~40 % de sa valeur.
 *     La couverture est adoucie (puissance 0,8) car aucune annonce n'est
 *     jamais couverte a 100 % : sans cela tout le vivier s'ecraserait en bas
 *     du classement et les ecarts deviendraient illisibles.
 *
 *   Competences fonctionnelles ... 20 pts
 *     Recouvrement via lib/fonctionnel. Indispensable : un profil AMOA ou
 *     chef de projet ne cite presque aucun outil, l'axe technique seul le
 *     classerait dernier sur une annonce ou il est pourtant le meilleur.
 *
 *   Seniorite ............. 15 pts
 *     Plein tarif des que le consultant atteint le nombre d'annees demande.
 *     En dessous : degressif (puissance 1,4, donc une annee manquante coute
 *     peu, trois annees coutent cher). Au-dessus : legere penalite de
 *     surqualification au-dela de 5 ans d'ecart, plancher a la moitie des
 *     points — un profil trop cher reste un profil qui sait faire.
 *
 *   Secteur / clients ..... 15 pts
 *     Secteurs cites dans l'annonce confrontes aux clients, contextes et
 *     missions du consultant. Les grands comptes connus sont rattaches a leur
 *     secteur (AP-HP -> sante, Urssaf -> public) : un CV dit rarement
 *     « secteur bancaire », il dit « Oney Bank ».
 *
 *   Intitule de poste ..... 10 pts
 *     Proximite de metier, pas de mots : un referentiel d'intitules regroupes
 *     par famille evite qu'un « Data Engineer » et un « Ingenieur donnees »
 *     soient consideres comme etrangers.
 *
 * Un axe que l'annonce ne renseigne pas vaut 0,5 (neutre) : une offre muette
 * sur le secteur ne doit ni avantager ni penaliser qui que ce soit. Une offre
 * entierement vide place donc tout le monde a 50.
 *
 * niveau : >= 75 « fort », >= 55 « bon », >= 35 « partiel », sinon « faible ».
 */

const N = require("./normalize");
const taxo = require("./taxonomy");
const fonc = require("./fonctionnel");

const POIDS = { techno: 40, fonctionnel: 20, seniorite: 15, secteur: 15, titre: 10 };

// ===========================================================================
// Referentiels propres au matching
// ===========================================================================

/**
 * Intitules de poste. La famille sert de repli : deux metiers differents d'une
 * meme famille (data engineer / data analyst) restent proches, deux metiers de
 * familles opposees (AMOA / devops) ne le sont pas.
 * Les motifs sont testes sur du texte desaccentue en minuscules.
 */
const ROLES = {
  chef_projet: {
    label: "Chef de projet",
    famille: "pilotage",
    motifs: [/chef+e?\s+de\s+projet/, /cheffe\s+de\s+projet/, /directeur\s+de\s+projet/, /project\s+manager/, /pilote\s+de\s+projet/],
  },
  pmo: {
    label: "PMO / Direction de programme",
    famille: "pilotage",
    motifs: [/\bpmo\b/, /project\s+management\s+office/, /directeur\s+de\s+programme/, /program\s+manager/, /portfolio\s+manager/],
  },
  scrum: {
    label: "Scrum master / Coach agile",
    famille: "pilotage",
    motifs: [/scrum\s+master/, /coach\s+agile/, /agile\s+coach/],
  },
  amoa: {
    label: "AMOA / MOA",
    famille: "fonctionnel",
    motifs: [/\bamoa\b/, /\bmoa\b/, /assistance\s+a\s+(?:la\s+)?maitrise\s+d.?ouvrage/, /maitrise\s+d.?ouvrage/, /consultant\w*\s+fonctionnel/],
  },
  ba: {
    label: "Business analyst",
    famille: "fonctionnel",
    motifs: [/business\s+analyst/, /analyste\s+metier/],
  },
  po: {
    label: "Product owner",
    famille: "fonctionnel",
    motifs: [/product\s+owner/, /\bpo\b/, /product\s+manager/],
  },
  qa: {
    label: "Recette / QA",
    famille: "fonctionnel",
    motifs: [/testeur/, /\bqa\b/, /ingenieur\s+(?:de\s+)?tests?/, /charge\s+de\s+recette/],
  },
  data_engineer: {
    label: "Data engineer",
    famille: "data",
    motifs: [/data\s+engineer/, /ingenieur\s+(?:des?\s+)?donnees/, /ingenieur\s+data/, /\bdataops\b/, /developpeur\s+etl/, /data\s+platform/],
  },
  data_scientist: {
    label: "Data scientist",
    famille: "data",
    motifs: [/data\s+scientist/, /machine\s+learning\s+engineer/, /\bml\s+engineer/, /ingenieur\s+(?:en\s+)?ia\b/],
  },
  data_analyst: {
    label: "Data analyst / BI",
    famille: "data",
    motifs: [/data\s+analyst/, /analyste\s+(?:de\s+)?donnees/, /consultant\w*\s+bi\b/, /developpeur\s+bi\b/, /\bmsbi\b/, /business\s+intelligence/, /consultant\w*\s+(?:power\s?bi|decisionnel)/],
  },
  data_archi: {
    label: "Architecte data",
    famille: "data",
    motifs: [/architecte\s+(?:data|donnees|decisionnel|bi\b)/, /data\s+architect/],
  },
  developpeur: {
    label: "Developpeur",
    famille: "technique",
    motifs: [/developpeur/, /developpeuse/, /\bdeveloper\b/, /software\s+engineer/, /ingenieur\s+d.?etudes/, /ingenieur\s+developpement/, /full[\s-]?stack/, /back[\s-]?end/, /front[\s-]?end/],
  },
  techlead: {
    label: "Tech lead",
    famille: "technique",
    motifs: [/tech\s+lead/, /technical\s+lead/, /lead\s+(?:developpeur|technique|dev)/],
  },
  architecte: {
    label: "Architecte",
    famille: "technique",
    motifs: [/architecte\s+(?:technique|solution|logiciel|si\b|applicati\w+|systeme)/, /solution\s+architect/],
  },
  moe: {
    label: "MOE",
    famille: "technique",
    motifs: [/\bmoe\b/, /maitrise\s+d.?oeuvre/],
  },
  rpa: {
    label: "RPA / Automatisation",
    famille: "technique",
    motifs: [/\brpa\b/, /automation\s+engineer/, /developpeur\s+uipath/],
  },
  devops: {
    label: "DevOps / Cloud",
    famille: "infra",
    motifs: [/\bdevops\b/, /\bdevsecops\b/, /\bsre\b/, /site\s+reliability/, /ingenieur\s+cloud/, /cloud\s+engineer/, /platform\s+engineer/, /architecte\s+cloud/, /cloud\s+architect/],
  },
  infra: {
    label: "Infrastructure / Systeme & reseau",
    famille: "infra",
    motifs: [/ingenieur\s+(?:systeme|infrastructure|reseau|systemes)/, /administrateur\s+(?:systeme|reseau|infrastructure)/, /\bsysadmin\b/, /responsable\s+infrastructure/, /ingenieur\s+production/],
  },
  securite: {
    label: "Cybersecurite",
    famille: "infra",
    motifs: [/\brssi\b/, /cybersecurite/, /securite\s+(?:si|des\s+systemes)/, /analyste\s+soc/, /pentester/],
  },
  support: {
    label: "Support / Exploitation",
    famille: "infra",
    motifs: [/technicien\s+support/, /support\s+applicatif/, /help\s?desk/, /service\s+desk/, /technicien\s+informatique/],
  },
  direction: {
    label: "Direction / Management",
    famille: "direction",
    motifs: [/manager\s+de\s+transition/, /directeur\s+(?:general|de\s+la\s+transformation|transformation|digital|des\s+systemes|adjoint)/, /dir\.\s*transformation/, /directeur\s+de\s+business\s+unit/, /responsable\s+de\s+(?:service|departement)/],
  },
  // Volontairement « faible » : presque tous les CV d'ESN contiennent le mot.
  consultant: {
    label: "Consultant",
    famille: "conseil",
    faible: true,
    motifs: [/consultante?\b/, /\bconseil\b/],
  },
};

/**
 * Secteurs d'activite. `motifs` decrit le vocabulaire du secteur, `enseignes`
 * les grands comptes qui l'identifient a coup sur : un CV ecrit « AP-HP »,
 * jamais « secteur hospitalier public ».
 */
const SECTEURS = {
  banque: {
    label: "Banque & Finance",
    motifs: [/\bbanque/, /bancaire/, /\bfintech\b/, /moyens\s+de\s+paiement/, /marches?\s+financiers?/, /credit\s+(?:conso|immobilier|a\s+la)/, /\bsepa\b/, /\bdsp2\b/, /\blcb[\s-]?ft\b/, /\bbale\s+(?:ii|iii)\b/],
    enseignes: [/societe\s+generale/, /\bbnp\b/, /paribas/, /credit\s+agricole/, /\bbpce\b/, /banque\s+populaire/, /caisse\s+d.?epargne/, /\blcl\b/, /oney/, /\bcic\b/, /natixis/, /boursorama/, /\bhsbc\b/, /credit\s+mutuel/],
  },
  assurance: {
    label: "Assurance & Protection sociale",
    motifs: [/assurance/, /assureur/, /mutuelle/, /prevoyance/, /\biard\b/, /courtage/, /complementaire\s+sante/, /retraite\s+complementaire/, /gestion\s+de\s+sinistres?/],
    enseignes: [/\baxa\b/, /allianz/, /\bmma\b/, /generali/, /aviva/, /abeille/, /macif/, /\bmaif\b/, /matmut/, /harmonie/, /malakoff/, /\bag2r\b/, /klesia/, /\buneo\b/, /\bcarac\b/, /april\b/, /groupama/, /carte\s+blanche/],
  },
  sante: {
    label: "Sante & Medico-social",
    motifs: [/\bsante\b/, /hopital/, /hospitalier/, /\bchu\b/, /\bchr\b/, /clinique/, /medico[\s-]?social/, /\behpad\b/, /\bpatient/, /medical/, /pharmaceutique/, /\bsih\b/, /dossier\s+patient/, /\bdpi\b/, /biologie\s+medicale/, /\bars\b/],
    enseignes: [/ap[\s-]?hp/, /assistance\s+publique/, /\bcnam\b/, /\bcpam\b/, /inserm/, /sanofi/, /servier/, /\bopco\s+sante/, /unicancer/, /\bghu\b/, /\bght\b/],
  },
  public: {
    label: "Secteur public & Collectivites",
    motifs: [/secteur\s+public/, /service\s+public/, /administration\s+(?:publique|centrale|d.?etat)/, /ministere/, /collectivite/, /fonction\s+publique/, /\bepic\b/, /operateur\s+de\s+l.?etat/, /marches?\s+publics?/, /\bopco\b/],
    enseignes: [/urssaf/, /\bcnaf\b/, /pole\s+emploi/, /france\s+travail/, /\bdgfip\b/, /\binsee\b/, /prefecture/, /conseil\s+(?:regional|departemental)/, /mairie\s+de/, /\bcnil\b/, /\bonisep\b/],
  },
  industrie: {
    label: "Industrie & Aeronautique",
    motifs: [/industrie/, /industriel/, /manufactur/, /\busine/, /production\s+industrielle/, /aeronautique/, /automobile/, /\bmes\b/, /supply\s+chain\s+industrielle/, /\bbtp\b/, /construction/, /chimie/],
    enseignes: [/airbus/, /safran/, /thales/, /dassault/, /renault/, /stellantis/, /michelin/, /schneider\s+electric/, /saint[\s-]?gobain/, /\bvinci\b/, /bouygues/, /arcelor/, /\bsamat\b/],
  },
  retail: {
    label: "Retail & Distribution",
    motifs: [/\bretail\b/, /grande\s+distribution/, /distribution\s+specialisee/, /\be[\s-]?commerce\b/, /point\s+de\s+vente/, /magasins?\b/, /\bomnicanal/, /\bcaisse\b.*magasin/, /produits?\s+de\s+grande\s+consommation/, /\bpgc\b/],
    enseignes: [/carrefour/, /auchan/, /leclerc/, /intermarche/, /casino/, /decathlon/, /bricorama/, /leroy\s+merlin/, /fnac/, /darty/, /monoprix/, /\bikea\b/, /lvmh/, /l.?oreal/, /danone/],
  },
  telecom: {
    label: "Telecom & Medias",
    motifs: [/telecom/, /operateur\s+(?:mobile|telecom)/, /\bfibre\b/, /\b(?:4g|5g)\b/, /reseau\s+mobile/, /\bmedias?\b/, /audiovisuel/, /\bbroadcast\b/, /\bott\b/],
    enseignes: [/\borange\b/, /\bsfr\b/, /bouygues\s+telecom/, /\bfree\b/, /\btdf\b/, /canal\+/, /\btf1\b/, /france\s+televisions/, /\bm6\b/, /ubisoft/],
  },
  energie: {
    label: "Energie & Utilities",
    motifs: [/\benergie\b/, /energetique/, /electricite/, /\bgaz\b/, /nucleaire/, /\butilities\b/, /reseau\s+de\s+distribution\s+d.?electricite/, /transition\s+energetique/, /\beau\s+et\s+assainissement/],
    enseignes: [/\bedf\b/, /\bengie\b/, /\btotal/, /\brte\b/, /enedis/, /\bgrdf\b/, /veolia/, /suez/, /teksial/, /\bareva\b/, /orano/],
  },
  transport: {
    label: "Transport & Logistique",
    // « entrepot » seul est piegeux : dans une annonce data il designe un
    // datawarehouse, pas une plateforme logistique.
    motifs: [/transport/, /logistique/, /ferroviaire/, /\baerien\b/, /\bfret\b/, /supply\s+chain/, /entrepots?\s+(?:logistique|de\s+stockage)/, /\bwms\b/, /\btms\b/, /mobilite/],
    enseignes: [/\bsncf\b/, /\bratp\b/, /\badp\b/, /air\s+france/, /geodis/, /\bdhl\b/, /\bups\b/, /la\s+poste/, /keolis/, /transdev/, /jungheinrich/],
  },
  immobilier: {
    label: "Immobilier & Construction",
    motifs: [/immobilier/, /fonciere/, /bailleur\s+social/, /gestion\s+locative/, /promotion\s+immobiliere/, /\bhlm\b/],
    enseignes: [/nexity/, /icade/, /gecina/, /unibail/, /foncia/],
  },
  formation: {
    label: "Formation & Education",
    motifs: [/formation\s+professionnelle/, /\bopca\b/, /organisme\s+de\s+formation/, /education\s+nationale/, /enseignement\s+superieur/, /\bapprentissage\b.*\bcontrat/, /\bedtech\b/],
    enseignes: [/\bafpa\b/, /\bcnam\b/, /\bopco\b/, /universite\s+de/, /rectorat/],
  },
  luxe: {
    label: "Luxe & Mode",
    motifs: [/\bluxe\b/, /maroquinerie/, /haute\s+couture/, /joaillerie/, /parfum/, /cosmetique/],
    enseignes: [/chanel/, /hermes/, /dior/, /louis\s+vuitton/, /kering/, /cartier/, /clarins/],
  },
};

const LANGUES = {
  "Anglais": [/\banglais\b/, /\benglish\b/],
  "Français": [/\bfrancais\b/, /\bfrench\b/],
  "Allemand": [/\ballemand\b/, /\bgerman\b/],
  "Espagnol": [/\bespagnol\b/, /\bspanish\b/],
  "Italien": [/\bitalien\b/],
  "Arabe": [/\barabe\b/],
  "Portugais": [/\bportugais\b/],
  "Néerlandais": [/\bneerlandais\b/, /\bdutch\b/],
  "Chinois": [/\bchinois\b/, /\bmandarin\b/],
};

// Mots trop courants pour porter du sens dans une annonce.
const STOP = new Set([
  "notre", "votre", "nous", "vous", "leur", "cette", "dans", "pour", "avec", "sans", "sous", "vers", "chez", "elle", "sera", "sont", "etre", "avoir", "plus", "tout", "tous", "toute", "meme", "aussi", "ainsi", "entre", "afin", "donc", "mais", "leurs", "cela",
  "poste", "mission", "missions", "profil", "profils", "equipe", "equipes", "client", "clients", "entreprise", "societe", "candidat", "candidate", "candidature", "experience", "experiences", "annee", "annees", "recherche", "recherchons", "competences", "competence",
  "travail", "cadre", "seront", "serez", "aurez", "pourrez", "rejoindre", "contexte", "description", "offre", "emploi", "contrat", "salaire", "teletravail", "remuneration", "environnement", "besoin", "besoins", "activites", "activite", "assurer", "participer",
  "realiser", "mettre", "place", "charge", "chargee", "vous", "notamment", "bonne", "bonnes", "solide", "solides", "capacite", "qualites", "maitrise", "connaissance", "connaissances", "niveau", "requis", "souhaite", "apprecie", "atout", "atouts", "type", "jour",
]);

// ===========================================================================
// Analyse de la fiche de poste
// ===========================================================================

/**
 * Nombre d'annees d'experience demande.
 * Les formulations chiffrees priment sur les qualificatifs : « senior » est
 * une etiquette, « 5 ans » est un critere. Parmi les nombres, ceux qui sont
 * accroches au mot « experience » priment sur les autres (« 3 ans sur
 * Snowflake » n'est pas l'anciennete demandee).
 */
function extraireSeniorite(t) {
  const chiffres = [];
  const contextuels = [];

  const push = (arr, v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 30) arr.push(n);
  };

  // « 5 ans d'experience », « 5 annees d'experience minimum »
  let m;
  const reExp = /(\d{1,2})\s*(?:\+)?\s*(?:ans?|annees?)\s*(?:minimum|min\.?|au\s+moins)?\s*(?:d[e']\s*)?exp/gi;
  while ((m = reExp.exec(t))) push(contextuels, m[1]);

  // « minimum 5 ans », « au moins 5 annees », « plus de 5 ans »
  const reAvant = /(?:minimum|min\.?|au\s+moins|a\s+minima|plus\s+de|au\s+minimum|justifiant\s+de)\s*(\d{1,2})\s*(?:ans?|annees?)/gi;
  while ((m = reAvant.exec(t))) push(contextuels, m[1]);

  // « 5+ ans », « 5 ans+ »
  const rePlus = /(\d{1,2})\s*\+\s*(?:ans?|annees?)|(\d{1,2})\s*(?:ans?|annees?)\s*\+/gi;
  while ((m = rePlus.exec(t))) push(contextuels, m[1] || m[2]);

  // « 5 a 7 ans » : on retient la borne basse, c'est le seuil d'entree.
  const reFourchette = /(\d{1,2})\s*(?:a|-|\/)\s*(\d{1,2})\s*(?:ans?|annees?)/gi;
  while ((m = reFourchette.exec(t))) push(contextuels, m[1]);

  // Repli : n'importe quel « N ans » de la fiche.
  const reNu = /\b(\d{1,2})\s*(?:ans?|annees?)\b/gi;
  while ((m = reNu.exec(t))) push(chiffres, m[1]);

  if (contextuels.length) return Math.max(...contextuels);
  if (chiffres.length) return Math.max(...chiffres);

  // Qualificatifs, par ordre de force decroissante.
  if (/\bexpert\b|\bexpertise\s+confirmee\b/.test(t)) return 10;
  if (/\bsenior\b|\bexperimente/.test(t)) return 7;
  if (/\bconfirme/.test(t)) return 5;
  if (/\bjunior\b|\bdebutant/.test(t)) return 2;
  return null;
}

function detecterRoles(texteDesaccentue) {
  const out = new Set();
  for (const [cle, r] of Object.entries(ROLES)) {
    if (r.motifs.some((re) => re.test(texteDesaccentue))) out.add(cle);
  }
  return out;
}

function detecterSecteurs(texteDesaccentue) {
  const out = new Set();
  for (const [cle, s] of Object.entries(SECTEURS)) {
    const motifs = s.motifs.concat(s.enseignes);
    if (motifs.some((re) => re.test(texteDesaccentue))) out.add(cle);
  }
  return out;
}

function detecterLangues(texteDesaccentue) {
  const out = [];
  for (const [nom, motifs] of Object.entries(LANGUES)) {
    if (motifs.some((re) => re.test(texteDesaccentue))) out.push(nom);
  }
  return out;
}

function motsSignifiants(texteDesaccentue, max) {
  const mots = texteDesaccentue.match(/\b[a-z][a-z-]{3,}\b/g) || [];
  const vus = new Set();
  const out = [];
  for (const mot of mots) {
    if (STOP.has(mot) || vus.has(mot)) continue;
    vus.add(mot);
    out.push(mot);
    if (out.length >= (max || 60)) break;
  }
  return out;
}

// Une annonce hierarchise ses exigences. On lit cette hierarchie plutot que de
// traiter « maitrise imperative de dbt » et « Terraform est un plus » a egalite.
const IMPERATIF = /imperati(?:f|ve)|indispensable|obligatoire|\bexige|\brequis|incontournable|maitrise\s+(?:parfaite|solide|imperative|approfondie)|solide\s+(?:experience|maitrise)|expertise\s+(?:confirmee|avancee)/;
const OPTIONNEL = /(?:est|serai?t?|constitue)\s+un\s+(?:plus|atout)|un\s+atout|appreci|idealement|\bbonus\b|nice\s+to\s+have|optionnel|de\s+preference|serait\s+appreciee?/;

/** Decoupe grossiere en phrases : une exigence tient rarement sur deux lignes. */
function segmenter(texte) {
  return String(texte).split(/[\n\r]+|[.;]\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Ponderation contextuelle des technologies de l'annonce : x1,5 si la phrase
 * les presente comme imperatives, x0,6 si elles n'apparaissent QUE dans des
 * phrases du type « serait un plus ». Le facteur le plus fort l'emporte, une
 * techno citee ailleurs sans reserve retrouvant donc son poids nominal.
 */
function ponderer(brut, technologies) {
  if (!technologies.length) return technologies;
  const facteurs = new Map();

  for (const seg of segmenter(brut)) {
    const plat = N.deaccent(seg).toLowerCase();
    const f = IMPERATIF.test(plat) ? 1.5 : OPTIONNEL.test(plat) ? 0.6 : 1;
    for (const t of taxo.detect(seg)) {
      facteurs.set(t.name, Math.max(facteurs.get(t.name) || 0, f));
    }
  }

  for (const t of technologies) {
    const f = facteurs.get(t.name) || 1;
    if (f !== 1) t.weight = Math.round(t.weight * f * 10) / 10;
  }
  return technologies;
}

/** Analyse une fiche de poste en besoin structure. */
function analyserOffre(texte) {
  const brut = typeof texte === "string" ? texte : "";
  const plat = N.deaccent(brut).toLowerCase();

  const technologies = ponderer(brut, taxo.detect(brut).map((t) => ({ name: t.name, cat: t.cat, weight: t.weight })))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

  return {
    technologies,
    fonctionnels: fonc.detectFlat(brut),
    seniorite: plat ? extraireSeniorite(plat) : null,
    secteurs: [...detecterSecteurs(plat)],
    langues: detecterLangues(plat),
    motsCles: motsSignifiants(plat, 60),
    brut,
    // Champ derive, prefixe pour signaler qu'il n'appartient pas au contrat.
    _roles: [...detecterRoles(plat)],
  };
}

// ===========================================================================
// Profil consultant (derive du cv_master, mis en cache)
// ===========================================================================

const CACHE = new WeakMap();

function texteExperience(exp) {
  return [
    exp.role, exp.mission, exp.company, exp.end_client, exp.context,
    (exp.tech_stack || []).join(", "),
    (exp.highlights || []).map((h) => (h && h.text) || "").join(" "),
  ].filter(Boolean).join(" \n ");
}

function anneeDe(exp, anneeCourante) {
  if (exp.is_current) return anneeCourante;
  const d = exp.end_date || exp.start_date;
  const y = Number(String(d || "").slice(0, 4));
  return Number.isFinite(y) && y > 1970 ? y : null;
}

/**
 * Consolide ce dont le matching a besoin : technologies datees, competences
 * fonctionnelles, roles, secteurs, et le texte complet du CV.
 * Le calcul est mis en cache car classer() rappelle evaluer() sur le meme
 * objet pour chaque offre.
 */
function profil(cv) {
  if (!cv || typeof cv !== "object") {
    return { technos: new Map(), fonctionnels: new Set(), roles: new Set(), secteurs: new Set(), langues: [], seniorite: 0, titre: "", plat: "" };
  }
  const cached = CACHE.get(cv);
  if (cached) return cached;

  const identity = cv.identity || {};
  const experiences = Array.isArray(cv.experiences) ? cv.experiences : [];
  const anneeCourante = Number(N.isoNow().slice(0, 4)) || new Date().getFullYear();

  // --- Technologies datees -------------------------------------------------
  // La date de derniere utilisation est rarement renseignee dans cv_master :
  // on la reconstruit en cherchant chaque techno dans le texte des missions,
  // dont on connait les dates. C'est ce qui permet de distinguer un Talend de
  // 2012 d'un Talend de 2025.
  const technos = new Map();
  const poser = (t, annee) => {
    const cur = technos.get(t.name);
    if (!cur) {
      technos.set(t.name, { name: t.name, cat: t.cat, weight: t.weight, annee: annee || null });
    } else if (annee && (!cur.annee || annee > cur.annee)) {
      cur.annee = annee;
    }
  };

  for (const t of Array.isArray(cv.technologies) ? cv.technologies : []) {
    if (t && t.name) poser(t, Number(t.last_used) || null);
  }
  for (const exp of experiences) {
    const annee = anneeDe(exp, anneeCourante);
    const txt = texteExperience(exp);
    for (const t of taxo.detect(txt)) poser(t, annee);
    for (const brut of exp.tech_stack || []) {
      const c = taxo.lookup(brut);
      if (c) poser(c, annee);
    }
  }
  // Les rubriques « Compétences » du CV : souvent la liste la plus complete.
  for (const groupe of Array.isArray(cv.skills) ? cv.skills : []) {
    for (const item of (groupe && groupe.items) || []) {
      const c = taxo.lookup(item);
      if (c) poser(c, null);
    }
  }

  // --- Texte complet -------------------------------------------------------
  const morceaux = [
    identity.title || "",
    (cv.summary && cv.summary.raw) || "",
    experiences.map(texteExperience).join(" \n "),
    (Array.isArray(cv.skills) ? cv.skills : []).map((g) => `${g.label} : ${(g.items || []).join(", ")}`).join(" \n "),
    (Array.isArray(cv.certifications) ? cv.certifications : []).map((c) => (c && c.name) || c).join(", "),
    (Array.isArray(cv.education) ? cv.education : []).map((e) => [e && e.degree, e && e.institution].filter(Boolean).join(" ")).join(", "),
  ];
  const texte = morceaux.filter(Boolean).join(" \n ");
  const plat = N.deaccent(texte).toLowerCase();

  // --- Roles : le titre pese plus que les intitules de mission -------------
  const titre = String(identity.title || "");
  const platTitre = N.deaccent(titre).toLowerCase();
  const platRoles = N.deaccent(experiences.map((e) => e.role || "").join(" \n ")).toLowerCase();

  const p = {
    technos,
    fonctionnels: new Set(fonc.detectFlat(texte)),
    roles: detecterRoles(platTitre),
    rolesMissions: detecterRoles(platRoles),
    secteurs: detecterSecteurs(plat),
    langues: (Array.isArray(cv.languages) ? cv.languages : []).map((l) => (l && (l.name || l.label)) || l).filter(Boolean),
    seniorite: Number(identity.seniority_years) || 0,
    titre,
    platTitre,
    plat,
  };
  CACHE.set(cv, p);
  return p;
}

// ===========================================================================
// Axes de notation — chacun rend un ratio 0..1
// ===========================================================================

/** 1 pour une techno fraiche, ~0,4 pour une techno vue il y a huit ans. */
function recence(annee, anneeCourante) {
  if (!annee) return 0.7; // date inconnue : ni recompense ni sanction franche
  const ecart = anneeCourante - annee;
  if (ecart <= 2) return 1;
  return Math.max(0.4, Math.exp(-(ecart - 2) / 7));
}

/**
 * « ITIL » et « ITIL v4 » sont deux entrees distinctes du referentiel mais une
 * seule competence : sans cela l'annonce compterait un manque imaginaire. On
 * n'accepte que le suffixe de version — « Azure » et « Azure DevOps », eux,
 * restent deux choses differentes.
 */
function variante(nomOffre, technos) {
  for (const nom of technos.keys()) {
    const [court, long] = nomOffre.length <= nom.length ? [nomOffre, nom] : [nom, nomOffre];
    if (long.length <= court.length) continue;
    if (long.slice(0, court.length).toLowerCase() !== court.toLowerCase()) continue;
    const suite = long.slice(court.length).trim();
    if (/^v?\d/i.test(suite)) return technos.get(nom);
  }
  return null;
}

function axeTechno(p, besoin, anneeCourante) {
  const demandees = besoin.technologies || [];
  if (!demandees.length) return { ratio: 0.5, neutre: true, communes: [], manquantes: [] };

  let total = 0;
  let obtenu = 0;
  const communes = [];
  const manquantes = [];

  for (const t of demandees) {
    const poids = Number(t.weight) || 2;
    total += poids;
    const exact = p.technos.get(t.name);
    const chez = exact || variante(t.name, p.technos);
    if (chez) {
      // Une version voisine vaut presque, mais pas tout a fait, la techno exacte.
      obtenu += poids * recence(chez.annee, anneeCourante) * (exact ? 1 : 0.85);
      communes.push({ name: exact ? t.name : chez.name, weight: poids, annee: chez.annee });
    } else {
      manquantes.push({ name: t.name, weight: poids });
    }
  }

  const brut = total ? obtenu / total : 0;
  communes.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  manquantes.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  // Adoucissement : personne ne coche jamais toute une annonce.
  return { ratio: Math.pow(Math.min(1, brut), 0.8), communes, manquantes };
}

function axeFonctionnel(p, besoin) {
  const demandes = besoin.fonctionnels || [];
  if (!demandes.length) return { ratio: 0.5, neutre: true, communs: [], manquants: [] };

  const communs = demandes.filter((f) => p.fonctionnels.has(f));
  const manquants = demandes.filter((f) => !p.fonctionnels.has(f));
  return { ratio: Math.pow(communs.length / demandes.length, 0.8), communs, manquants };
}

function axeSeniorite(p, besoin) {
  const demande = besoin.seniorite;
  const acquise = p.seniorite || 0;
  if (!demande) return { ratio: 0.5, neutre: true, demande: null, acquise };

  if (acquise >= demande) {
    const exces = acquise - demande;
    // Surqualification : on ne descend jamais sous la moitie des points.
    const ratio = exces <= 5 ? 1 : Math.max(0.5, 1 - (exces - 5) * 0.05);
    return { ratio, demande, acquise, exces };
  }
  return { ratio: Math.pow(Math.max(0, acquise) / demande, 1.4), demande, acquise, defaut: demande - acquise };
}

function axeSecteur(p, besoin) {
  const demandes = besoin.secteurs || [];
  if (!demandes.length) return { ratio: 0.5, neutre: true, communs: [], manquants: [] };

  const communs = demandes.filter((s) => p.secteurs.has(s));
  const manquants = demandes.filter((s) => !p.secteurs.has(s));
  return { ratio: Math.pow(communs.length / demandes.length, 0.8), communs, manquants };
}

/**
 * Proximite d'intitule. On compare des metiers, pas des chaines : un role
 * identique vaut plein pot, un role de la meme famille vaut 0,6, sinon on
 * retombe sur le recouvrement de vocabulaire du titre.
 */
function axeTitre(p, besoin) {
  const attendus = besoin._roles || [];
  if (!attendus.length) return { ratio: 0.5, neutre: true, communs: [] };

  const fort = (cle) => !ROLES[cle].faible;
  const partages = attendus.filter((r) => p.roles.has(r));
  const partagesForts = partages.filter(fort);
  if (partagesForts.length) {
    return { ratio: 1, communs: partagesForts.map((r) => ROLES[r].label), exact: true };
  }

  // Meme metier, mais rencontre en mission plutot qu'affiche en titre.
  const enMission = attendus.filter((r) => fort(r) && p.rolesMissions.has(r));
  if (enMission.length) return { ratio: 0.85, communs: enMission.map((r) => ROLES[r].label), mission: true };

  const famillesOffre = new Set(attendus.filter(fort).map((r) => ROLES[r].famille));
  const famillesCv = new Set([...p.roles, ...p.rolesMissions].filter(fort).map((r) => ROLES[r].famille));
  const famillesCommunes = [...famillesOffre].filter((f) => famillesCv.has(f));
  if (famillesCommunes.length) return { ratio: 0.6, communs: famillesCommunes, famille: true };

  if (partages.length) return { ratio: 0.45, communs: partages.map((r) => ROLES[r].label) };

  // Dernier repli : recouvrement lexical brut entre les deux intitules.
  const motsOffre = new Set(besoin.motsCles || []);
  const motsCv = new Set(motsSignifiants(p.platTitre || "", 25));
  let inter = 0;
  for (const m of motsCv) if (motsOffre.has(m)) inter++;
  const lex = motsCv.size ? Math.min(1, inter / Math.max(3, motsCv.size)) : 0;
  return { ratio: 0.1 + lex * 0.3, communs: [] };
}

// ===========================================================================
// Evaluation
// ===========================================================================

function niveauDe(score) {
  if (score >= 75) return "fort";
  if (score >= 55) return "bon";
  if (score >= 35) return "partiel";
  return "faible";
}

function liste(noms, max) {
  const n = noms.slice(0, max);
  const reste = noms.length - n.length;
  return n.join(", ") + (reste > 0 ? ` (+${reste})` : "");
}

function pluriel(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

/** Confronte un cv_master au besoin. */
function evaluer(cvMaster, besoin) {
  let b = typeof besoin === "string" ? analyserOffre(besoin) : (besoin && typeof besoin === "object" ? besoin : analyserOffre(""));
  // Besoin reconstruit a la main (ou revenu d'un aller-retour JSON tronque) :
  // on redetecte les intitules plutot que de neutraliser l'axe en silence.
  if (!b._roles) b = { ...b, _roles: [...detecterRoles(N.deaccent(b.brut || "").toLowerCase())] };
  const p = profil(cvMaster);
  const anneeCourante = Number(N.isoNow().slice(0, 4)) || new Date().getFullYear();

  const tech = axeTechno(p, b, anneeCourante);
  const fnc = axeFonctionnel(p, b);
  const sen = axeSeniorite(p, b);
  const sec = axeSecteur(p, b);
  const tit = axeTitre(p, b);

  const points = {
    techno: tech.ratio * POIDS.techno,
    fonctionnel: fnc.ratio * POIDS.fonctionnel,
    seniorite: sen.ratio * POIDS.seniorite,
    secteur: sec.ratio * POIDS.secteur,
    titre: tit.ratio * POIDS.titre,
  };
  const score = Math.round(Object.values(points).reduce((s, v) => s + v, 0));

  // --- Raisons -------------------------------------------------------------
  const raisons = [];
  const arrondi = (v) => Math.round(v * 10) / 10;

  if (!tech.neutre && tech.communes.length) {
    const anciennes = tech.communes.filter((t) => t.annee && anneeCourante - t.annee > 6);
    raisons.push({
      type: "techno",
      label: `${pluriel(tech.communes.length, "technologie")} en commun sur ${b.technologies.length} demandées`,
      detail: liste(tech.communes.map((t) => t.name), 8) + (anciennes.length ? ` — dont ${liste(anciennes.map((t) => `${t.name} (${t.annee})`), 3)} peu récent${anciennes.length > 1 ? "s" : ""}` : ""),
      poids: arrondi(points.techno),
    });
  }
  if (!fnc.neutre && fnc.communs.length) {
    raisons.push({
      type: "fonctionnel",
      label: `${pluriel(fnc.communs.length, "compétence")} fonctionnelle${fnc.communs.length > 1 ? "s" : ""} attendue${fnc.communs.length > 1 ? "s" : ""}`,
      detail: liste(fnc.communs, 6),
      poids: arrondi(points.fonctionnel),
    });
  }
  if (!sen.neutre) {
    const label = sen.acquise >= sen.demande
      ? (sen.exces > 5 ? `${sen.acquise} ans d'expérience pour ${sen.demande} demandés (profil très senior)` : `${sen.acquise} ans d'expérience, ${sen.demande} demandés`)
      : `${sen.acquise} ans d'expérience sur ${sen.demande} demandés`;
    raisons.push({
      type: "seniorite",
      label,
      detail: sen.acquise >= sen.demande ? "Séniorité conforme au besoin." : `Il manque ${pluriel(sen.defaut, "an")} d'ancienneté.`,
      poids: arrondi(points.seniorite),
    });
  }
  if (!sec.neutre && sec.communs.length) {
    raisons.push({
      type: "secteur",
      label: `Expérience du secteur : ${sec.communs.map((s) => SECTEURS[s].label).join(", ")}`,
      detail: liste(indicesSecteur(cvMaster, sec.communs), 4) || "Vocabulaire du secteur présent dans les missions.",
      poids: arrondi(points.secteur),
    });
  }
  if (!tit.neutre && tit.communs.length) {
    raisons.push({
      type: "titre",
      label: tit.exact ? `Intitulé identique : ${tit.communs.join(", ")}`
        : tit.mission ? `Métier exercé en mission : ${tit.communs.join(", ")}`
        : `Métier voisin (même famille)`,
      detail: p.titre || "—",
      poids: arrondi(points.titre),
    });
  }
  raisons.sort((a, b2) => b2.poids - a.poids);

  // --- Manques -------------------------------------------------------------
  const manques = [];
  for (const t of (tech.manquantes || []).slice(0, 8)) manques.push({ type: "techno", label: t.name });
  for (const f of (fnc.manquants || []).slice(0, 6)) manques.push({ type: "fonctionnel", label: f });
  if (!sen.neutre && sen.acquise < sen.demande) {
    manques.push({ type: "seniorite", label: `${sen.demande} ans demandés, ${sen.acquise} au compteur` });
  }
  for (const s of sec.manquants || []) manques.push({ type: "secteur", label: SECTEURS[s].label });
  if (!tit.neutre && tit.ratio < 0.6) {
    const attendus = (b._roles || []).filter((r) => !ROLES[r].faible).map((r) => ROLES[r].label);
    if (attendus.length) manques.push({ type: "titre", label: `Intitulé attendu : ${attendus.join(" / ")}` });
  }
  for (const l of b.langues || []) {
    const su = p.langues.some((x) => N.deaccent(String(x)).toLowerCase().includes(N.deaccent(l).toLowerCase()));
    if (!su && !p.plat.includes(N.deaccent(l).toLowerCase())) manques.push({ type: "langue", label: l });
  }

  return {
    score,
    niveau: niveauDe(score),
    raisons,
    manques,
    technosCommunes: (tech.communes || []).map((t) => t.name),
    seniorite: p.seniorite,
    // Detail des axes : utile a l'affichage et au debogage du barème.
    detail: {
      points: {
        techno: arrondi(points.techno),
        fonctionnel: arrondi(points.fonctionnel),
        seniorite: arrondi(points.seniorite),
        secteur: arrondi(points.secteur),
        titre: arrondi(points.titre),
      },
      max: POIDS,
    },
  };
}

/** Clients ou contextes du CV qui justifient un secteur — la preuve, pas l'etiquette. */
function indicesSecteur(cv, cles) {
  const experiences = (cv && Array.isArray(cv.experiences) ? cv.experiences : []);
  const noms = [];
  const vus = new Set();
  for (const exp of experiences) {
    const nom = (exp.end_client || exp.company || "").trim();
    if (!nom || nom.length > 60) continue;
    const plat = N.deaccent(`${nom} ${exp.context || ""} ${exp.mission || ""}`).toLowerCase();
    const touche = cles.some((c) => SECTEURS[c] && SECTEURS[c].motifs.concat(SECTEURS[c].enseignes).some((re) => re.test(plat)));
    if (touche && !vus.has(nom.toLowerCase())) {
      vus.add(nom.toLowerCase());
      noms.push(nom);
    }
  }
  return noms;
}

/** Classe tout un vivier. */
function classer(listeCvMaster, texteOffre) {
  const besoin = analyserOffre(texteOffre);
  const cvs = Array.isArray(listeCvMaster) ? listeCvMaster.filter((c) => c && typeof c === "object") : [];

  const resultats = cvs
    .map((cv) => ({ cv, ...evaluer(cv, besoin) }))
    // A score egal, le profil le plus experimente passe devant ; le nom
    // departage en dernier ressort pour que le classement soit stable.
    .sort((a, b) => b.score - a.score || b.seniorite - a.seniorite ||
      String((a.cv.identity || {}).full_name || "").localeCompare(String((b.cv.identity || {}).full_name || "")));

  return { besoin, resultats };
}

module.exports = { analyserOffre, evaluer, classer, POIDS, ROLES, SECTEURS };
