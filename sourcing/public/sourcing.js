/* ADBI Sourcing : collage, liste des opportunités et détail d'un élément ; tout texte reçu passe par textContent. */
(function () {
  "use strict";

  const LIBELLES_STATUTS = {
    en_attente: "En file", en_cours: "En cours", a_verifier: "À vérifier", a_valider: "À valider",
    valide: "Validé", ecarte: "Écarté", echec: "Échec",
  };
  const LIBELLES_ORIGINES = { collage: "Collage", navigateur: "Bouton navigateur", email: "E-mail", api: "API", linkedin_public: "LinkedIn (public)" };
  const LIBELLES_CHAMPS = {
    entreprise: "Entreprise", intitule: "Intitulé", competences: "Compétences (une par ligne)", localisation: "Localisation",
    type_contrat: "Type de contrat", seniorite: "Séniorité", date_debut: "Date de début (AAAA-MM-JJ)",
    contact_mentionne: "Contact mentionné", devise: "Devise (budget ou TJM)",
  };
  const LIBELLES_CONTRATS = { cdi: "CDI", cdd: "CDD", freelance: "Freelance", mission: "Mission", appel_offres: "Appel d'offres", inconnu: "Inconnu" };
  const LIBELLES_RAISONS = {
    type_inconnu: "type non reconnu", confiance_faible: "confiance du modèle faible",
    probabilites_proches: "deux types presque à égalité", methodes_en_desaccord: "les deux méthodes divergent",
  };
  const LIBELLES_EMPLOYEURS = { client_final: "Client final", esn_conseil: "ESN / conseil", recrutement: "Cabinet de recrutement", inconnu: "Employeur inconnu" };
  const OCCUPES = ["en_attente", "en_cours"];
  const SEUIL_ANCRAGE = 0.5;
  const ATTENTE_MS = 2500;

  let config = null;
  let minuteur = null;
  let courant = null;
  let avis = null;
  let reclasserArme = false;
  let offres = [];
  let profils = [];
  let profilEdite = null;
  let suppressionArmee = null;

  const $ = (id) => document.getElementById(id);
  const libelleType = (t) => (t ? (config.libelles_types[t] || t) : "Type inconnu");

  async function api(chemin, options = {}) {
    const r = await fetch(chemin, {
      ...options, credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    });
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    if (r.status === 401) { window.location.reload(); throw new Error("Session expirée."); }
    if (!r.ok) throw new Error((json && json.error) || "Erreur du serveur (HTTP " + r.status + ").");
    return json;
  }

  function message(el, texte, genre) {
    el.textContent = texte || "";
    el.className = "message" + (genre ? " " + genre : "");
    el.hidden = !texte;
  }

  function badgeType(el, type) {
    el.textContent = libelleType(type);
    el.className = "badge type-" + (type || "inconnu");
  }

  function badgeEmployeur(el, e) {
    const v = e.source_meta && e.source_meta.employeur;
    el.textContent = v && v !== "inconnu" ? LIBELLES_EMPLOYEURS[v] || v : "";
    el.className = "badge employeur-" + (v || "inconnu");
  }

  function badgeStatut(el, statut) {
    el.textContent = LIBELLES_STATUTS[statut] || statut || "";
    el.className = "badge statut-" + statut;
  }

  function titreElement(e) {
    const c = e.champs || {};
    const parts = [c.intitule, c.entreprise].filter(Boolean);
    if (parts.length) return parts.join(" — ");
    return e.texte.slice(0, 90).replace(/\s+/g, " ") + (e.texte.length > 90 ? "…" : "");
  }

  function metaElement(e) {
    const morceaux = [LIBELLES_ORIGINES[e.origine] || e.origine];
    if (e.auteur) morceaux.push(e.auteur);
    morceaux.push(new Date(e.capture_le || e.cree_le).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }));
    if (e.champs && e.champs.localisation) morceaux.push(e.champs.localisation);
    return morceaux.join(" · ");
  }

  function texteSuivi(e) {
    if (!OCCUPES.includes(e.statut) && !e.suivi) return "";
    const s = e.suivi;
    if (s && s.position) return "En file d'attente : position " + s.position + ".";
    if (s && s.etape === "extraction") return "Traitement en cours (classement, extraction, rapprochement)…";
    return OCCUPES.includes(e.statut) ? "Traitement en cours…" : "";
  }

  function remplirProfils(ol, rapprochement, limite) {
    ol.replaceChildren();
    const resultats = (rapprochement && rapprochement.resultats) || [];
    for (const p of resultats.slice(0, limite)) {
      const li = document.createElement("li");
      const nom = document.createElement("span");
      nom.className = "nom";
      nom.textContent = p.nom || p.profil_id;
      li.append(nom);
      if (typeof p.score === "number") {
        const s = document.createElement("span");
        s.className = "score";
        s.textContent = Math.round(p.score) + " / 100";
        li.append(s);
      }
      if (p.raisons && p.raisons.length) {
        const ul = document.createElement("ul");
        ul.className = "raisons";
        for (const r of p.raisons.slice(0, limite === 3 ? 2 : 6)) {
          const item = document.createElement("li");
          item.textContent = r;
          ul.append(item);
        }
        li.append(ul);
      }
      ol.append(li);
    }
    return resultats.length;
  }

  function texteRapprochement(r) {
    if (!r) return "Pas encore de rapprochement.";
    if (r.etat === "ok") return r.resultats.length ? "" : "Aucun consultant proposé par la CVthèque.";
    return r.message || "Rapprochement impossible.";
  }

  // ---------- Routage ----------

  function afficher(vue) {
    for (const v of ["coller", "linkedin", "profils", "liste", "detail"]) $("vue-" + v).hidden = v !== vue;
    for (const o of document.querySelectorAll(".onglet")) o.classList.toggle("actif", o.dataset.vue === vue);
  }

  function arreterAttente() {
    if (minuteur) clearTimeout(minuteur);
    minuteur = null;
  }

  function router() {
    arreterAttente();
    const h = window.location.hash;
    const m = h.match(/^#element\/(\d+)$/);
    if (m) { afficher("detail"); chargerDetail(Number(m[1])); return; }
    if (h === "#coller") { afficher("coller"); $("texte").focus(); return; }
    if (h === "#linkedin" && config.linkedin_public) { afficher("linkedin"); $("li-mots-cles").focus(); return; }
    if (h === "#profils") { afficher("profils"); chargerProfils(); return; }
    afficher("liste");
    chargerListe();
  }

  // ---------- Collage ----------

  function majCompteur() {
    const n = [...$("texte").value.trim()].length;
    const c = $("compteur");
    c.textContent = n + " caractère(s) — entre " + config.texte.min + " et " + config.texte.max;
    c.classList.toggle("hors-limites", n > 0 && (n < config.texte.min || n > config.texte.max));
  }

  async function envoyer(ev) {
    ev.preventDefault();
    const bouton = $("envoyer");
    bouton.disabled = true;
    message($("message-coller"), "");
    try {
      const r = await api("api/elements", {
        method: "POST",
        body: JSON.stringify({ texte: $("texte").value, url_source: $("url-source").value.trim(), origine: "collage" }),
      });
      $("form-coller").reset();
      majCompteur();
      avis = r.doublon ? "Cet élément avait déjà été collé : voici la fiche existante." : null;
      window.location.hash = "#element/" + r.element.id;
    } catch (e) {
      message($("message-coller"), e.message, "erreur");
    } finally {
      bouton.disabled = false;
    }
  }

  // ---------- Offres LinkedIn ----------

  async function chercherLinkedin(ev) {
    ev.preventDefault();
    const bouton = $("li-chercher");
    bouton.disabled = true;
    message($("li-message"), "");
    try {
      const params = new URLSearchParams({ mots_cles: $("li-mots-cles").value.trim(), lieu: $("li-lieu").value.trim() });
      if ($("li-jours").value) params.set("jours", $("li-jours").value);
      if ($("li-distance").value) params.set("distance", $("li-distance").value);
      const r = await api("api/linkedin/offres?" + params);
      offres = r.offres.map((o, rang) => ({ ...o, rang }));
      if (r.max_atteint) message($("li-message"), "LinkedIn ne montre que " + config.linkedin.max_offres + " offres par recherche sans compte : affinez par période, distance ou mots-clés pour voir les autres.");
      rendreOffres();
    } catch (e) {
      message($("li-message"), e.message, "erreur");
    } finally {
      bouton.disabled = false;
    }
  }

  function offresAffichees() {
    let liste = offres.filter((o) => !($("li-masquer-deja").checked && o.element_id));
    const tri = $("li-tri").value;
    if (tri === "pertinence") liste = [...liste].sort((a, b) => ((b.pertinence && b.pertinence.score) || 0) - ((a.pertinence && a.pertinence.score) || 0) || a.rang - b.rang);
    if (tri === "date") liste = [...liste].sort((a, b) => String(b.publie_le || "").localeCompare(String(a.publie_le || "")) || a.rang - b.rang);
    return liste;
  }

  function majSelection() {
    const n = document.querySelectorAll("#li-offres .choisir:checked").length;
    $("li-analyser").disabled = n === 0;
    $("li-analyser").textContent = n ? "Analyser la sélection (" + n + ")" : "Analyser la sélection";
  }

  function rendreOffres() {
    const liste = offresAffichees();
    const ul = $("li-offres");
    ul.replaceChildren();
    for (const o of liste) ul.append(carteOffre(o));
    $("li-barre").hidden = offres.length === 0;
    const deja = offres.filter((o) => o.element_id).length;
    $("li-resume").textContent = offres.length + " offre(s)" + (deja ? ", dont " + deja + " déjà analysée(s)" : "") + (liste.length !== offres.length ? " — " + liste.length + " affichée(s)" : "");
    majSelection();
  }

  function lienFiche(etat, id, texte) {
    const lien = document.createElement("a");
    lien.href = "#element/" + id;
    lien.textContent = texte;
    etat.replaceChildren(lien);
  }

  async function analyserOffre(o, carte) {
    const etat = carte.querySelector(".etat");
    const bouton = carte.querySelector(".analyser");
    bouton.disabled = true;
    etat.textContent = "Lecture de l'offre…";
    try {
      const r = await api("api/linkedin/offres/" + encodeURIComponent(o.id) + "/importer", { method: "POST", body: "{}" });
      o.element_id = r.element.id;
      carte.querySelector(".choisir").checked = false;
      carte.querySelector(".choisir").disabled = true;
      lienFiche(etat, r.element.id, r.doublon ? "Déjà analysée : ouvrir la fiche" : "Ouvrir la fiche" + (r.tronque ? " (texte coupé)" : ""));
      return true;
    } catch (e) {
      etat.textContent = e.message;
      bouton.disabled = false;
      return !/suspendue/.test(e.message);
    } finally {
      majSelection();
    }
  }

  function carteOffre(o) {
    const carte = $("modele-offre").content.firstElementChild.cloneNode(true);
    const titre = carte.querySelector(".titre");
    titre.textContent = o.intitule || "Offre " + o.id;
    titre.href = o.url;
    const date = o.publie_le ? new Date(o.publie_le).toLocaleDateString("fr-FR", { dateStyle: "medium" }) : "";
    carte.querySelector(".meta").textContent = [o.entreprise, o.localisation, date].filter(Boolean).join(" · ");
    const p = o.pertinence;
    carte.querySelector(".pertinence").textContent = p ? "Profil le plus proche : " + p.nom + " (" + p.score + " % de l'intitulé : " + p.mots.join(", ") + ")" : "";
    const choisir = carte.querySelector(".choisir");
    choisir.addEventListener("change", majSelection);
    carte.querySelector(".analyser").addEventListener("click", () => analyserOffre(o, carte));
    if (o.element_id) {
      choisir.disabled = true;
      carte.querySelector(".analyser").disabled = true;
      lienFiche(carte.querySelector(".etat"), o.element_id, "Déjà analysée : ouvrir la fiche");
    }
    carte.dataset.id = o.id;
    return carte;
  }

  // Une offre après l'autre : le serveur espace déjà les requêtes, et un refus de LinkedIn arrête le lot.
  async function analyserSelection() {
    const cartes = [...document.querySelectorAll("#li-offres li")].filter((c) => c.querySelector(".choisir:checked"));
    $("li-analyser").disabled = true;
    $("li-chercher").disabled = true;
    let faites = 0;
    for (const carte of cartes) {
      const o = offres.find((x) => x.id === carte.dataset.id);
      message($("li-message"), "Analyse " + (faites + 1) + " / " + cartes.length + " : lecture des offres une à une, quelques secondes chacune…");
      if (!(await analyserOffre(o, carte))) { message($("li-message"), "LinkedIn a refusé une requête : lot arrêté après " + faites + " offre(s).", "erreur"); break; }
      faites++;
    }
    if (faites === cartes.length) message($("li-message"), faites + " offre(s) envoyée(s) à l'analyse : suivez-les dans Opportunités.", "ok");
    $("li-chercher").disabled = false;
    majSelection();
  }

  // ---------- Profils ----------

  function ligneProfil(profil, { score = null, raisons = [], boutons = [] } = {}) {
    const li = $("modele-profil").content.firstElementChild.cloneNode(true);
    li.querySelector(".nom").textContent = profil.nom;
    li.querySelector(".score").textContent = typeof score === "number" ? score + " / 100" : "";
    li.querySelector(".meta").textContent = [profil.intitule, profil.seniorite, profil.localisation, profil.disponibilite && "dispo " + profil.disponibilite, profil.tjm && profil.tjm + " €/j"].filter(Boolean).join(" · ");
    const ul = li.querySelector(".raisons");
    for (const r of raisons) {
      const item = document.createElement("li");
      item.textContent = r;
      ul.append(item);
    }
    const actions = li.querySelector(".actions");
    for (const [texte, rappel, classe] of boutons) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn petit" + (classe ? " " + classe : "");
      b.textContent = texte;
      b.addEventListener("click", () => rappel(b));
      actions.append(b);
    }
    return li;
  }

  async function chargerProfils() {
    try {
      profils = (await api("api/profils")).profils;
    } catch (e) {
      message($("pf-message"), e.message, "erreur");
      return;
    }
    const ul = $("pf-liste");
    ul.replaceChildren();
    for (const p of profils) {
      const li = ligneProfil(p, {
        raisons: p.competences.length ? [p.competences.join(", ")] : [],
        boutons: [["Modifier", () => editerProfil(p)], ["Supprimer", (b) => supprimerProfil(p, b)]],
      });
      ul.append(li);
    }
    $("pf-vide").hidden = profils.length > 0;
    $("pf-resume").textContent = profils.length + " profil(s)";
  }

  function editerProfil(p) {
    profilEdite = p;
    const f = $("form-profil");
    for (const cle of ["nom", "intitule", "seniorite", "localisation", "disponibilite", "cvtheque_id", "notes"]) f.elements[cle].value = p[cle] || "";
    f.elements.competences.value = (p.competences || []).join("\n");
    f.elements.tjm.value = p.tjm === null || p.tjm === undefined ? "" : String(p.tjm);
    $("pf-titre-form").textContent = "Modifier « " + p.nom + " »";
    $("pf-enregistrer").textContent = "Enregistrer";
    $("pf-annuler").hidden = false;
    message($("pf-message"), "");
    f.elements.nom.focus();
  }

  function finEdition() {
    profilEdite = null;
    $("form-profil").reset();
    $("pf-titre-form").textContent = "Nouveau profil";
    $("pf-enregistrer").textContent = "Ajouter le profil";
    $("pf-annuler").hidden = true;
  }

  async function enregistrerProfil(ev) {
    ev.preventDefault();
    const f = $("form-profil");
    const corps = {};
    for (const cle of ["nom", "intitule", "seniorite", "localisation", "disponibilite", "cvtheque_id", "notes", "tjm"]) corps[cle] = f.elements[cle].value.trim();
    corps.competences = f.elements.competences.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    try {
      if (profilEdite) await api("api/profils/" + profilEdite.id, { method: "PUT", body: JSON.stringify(corps) });
      else await api("api/profils", { method: "POST", body: JSON.stringify(corps) });
      message($("pf-message"), profilEdite ? "Profil enregistré." : "Profil ajouté.", "ok");
      finEdition();
      chargerProfils();
    } catch (e) {
      message($("pf-message"), e.message, "erreur");
    }
  }

  // Deux clics : le premier arme la suppression, le second la confirme.
  async function supprimerProfil(p, bouton) {
    if (suppressionArmee !== p.id) {
      suppressionArmee = p.id;
      bouton.textContent = "Confirmer la suppression";
      return;
    }
    suppressionArmee = null;
    try {
      await api("api/profils/" + p.id, { method: "DELETE" });
      if (profilEdite && profilEdite.id === p.id) finEdition();
      chargerProfils();
    } catch (e) {
      message($("pf-message"), e.message, "erreur");
    }
  }

  async function chargerProfilsOffre(e) {
    const aide = $("d-pf-aide");
    let r;
    try {
      r = await api("api/elements/" + e.id + "/profils");
    } catch (err) {
      message($("d-pf-message"), err.message, "erreur");
      return;
    }
    if (!courant || courant.id !== e.id) return;
    aide.replaceChildren();
    if (r.referentiel_vide) {
      aide.append("Le référentiel est vide : ");
      const lien = document.createElement("a");
      lien.href = "#profils";
      lien.textContent = "ajoutez des profils";
      aide.append(lien, ".");
    } else {
      aide.textContent = "Score sur 100 : compétences 60, intitulé 25, séniorité 10, zone 5. Une indication pour trier, pas une décision.";
    }
    const associes = $("d-pf-associes");
    associes.replaceChildren();
    for (const a of r.associes) {
      associes.append(ligneProfil(a.profil, { score: a.score, raisons: a.raisons, boutons: [["Retirer", () => affecterProfil(e, a.profil.id, "DELETE")]] }));
    }
    $("d-pf-associes-vide").hidden = r.associes.length > 0;
    const sugg = $("d-pf-suggestions");
    sugg.replaceChildren();
    for (const s2 of r.suggestions) {
      sugg.append(ligneProfil(s2.profil, { score: s2.score, raisons: s2.raisons, boutons: [["Associer", () => affecterProfil(e, s2.profil.id, "PUT"), "primaire"]] }));
    }
    if (!r.suggestions.length && !r.referentiel_vide) {
      const li = document.createElement("li");
      li.className = "vide";
      li.textContent = e.type === "bruit" ? "Pas de suggestion pour un élément classé comme bruit." : "Aucun autre profil ne recoupe cette offre.";
      sugg.append(li);
    }
  }

  async function affecterProfil(e, profilId, methode) {
    message($("d-pf-message"), "");
    try {
      await api("api/elements/" + e.id + "/profils/" + profilId, { method: methode });
      chargerProfilsOffre(e);
    } catch (err) {
      message($("d-pf-message"), err.message, "erreur");
    }
  }

  // ---------- Liste ----------

  function remplirFiltres() {
    const ajouter = (select, valeurs, libelle) => {
      for (const v of valeurs) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = libelle(v);
        select.append(o);
      }
    };
    ajouter($("filtre-type"), config.types, libelleType);
    ajouter($("filtre-statut"), config.statuts, (s) => LIBELLES_STATUTS[s] || s);
    ajouter($("filtre-origine"), config.origines, (o) => LIBELLES_ORIGINES[o] || o);
    ajouter($("filtre-employeur"), config.employeurs, (o) => LIBELLES_EMPLOYEURS[o] || o);
    ajouter($("filtre-contrat"), config.types_contrat, (o) => LIBELLES_CONTRATS[o] || o);
    ajouter($("li-jours"), config.linkedin.periodes_jours, (j) => (j === 1 ? "24 heures" : j < 7 ? j + " jours" : j === 30 ? "1 mois" : j / 7 + " semaine" + (j > 7 ? "s" : "")));
    ajouter($("li-distance"), config.linkedin.distances_miles, (m) => Math.round(m * 1.609) + " km");
    ajouter($("d-choix-employeur"), config.employeurs, (o) => LIBELLES_EMPLOYEURS[o] || o);
  }

  async function chargerListe() {
    const params = new URLSearchParams();
    for (const [cle, id] of [["type", "filtre-type"], ["statut", "filtre-statut"], ["origine", "filtre-origine"], ["employeur", "filtre-employeur"], ["contrat", "filtre-contrat"]]) {
      if ($(id).value) params.set(cle, $(id).value);
    }
    let elements;
    try {
      elements = (await api("api/elements?" + params)).elements;
    } catch (e) {
      $("resume").textContent = e.message;
      return;
    }
    const ul = $("cartes");
    ul.replaceChildren();
    const modele = $("modele-carte");
    for (const e of elements) {
      const carte = modele.content.firstElementChild.cloneNode(true);
      badgeType(carte.querySelector(".b-type"), e.type);
      badgeStatut(carte.querySelector(".b-statut"), e.statut);
      badgeEmployeur(carte.querySelector(".b-employeur"), e);
      const titre = carte.querySelector(".titre");
      titre.textContent = titreElement(e);
      titre.href = "#element/" + e.id;
      carte.querySelector(".meta").textContent = [metaElement(e), e.profils_affectes ? e.profils_affectes + " profil(s) associé(s)" : "", texteSuivi(e)].filter(Boolean).join(" · ");
      const n = e.type === "bruit" ? 0 : remplirProfils(carte.querySelector(".profils"), e.rapprochement, 3);
      carte.querySelector(".profils").hidden = !n;
      const etat = carte.querySelector(".etat-rapprochement");
      etat.textContent = e.type === "bruit" || !e.champs ? "" : texteRapprochement(e.rapprochement);
      etat.hidden = !etat.textContent;
      const source = carte.querySelector(".lien-source");
      if (e.url_source) source.href = e.url_source; else source.hidden = true;
      ul.append(carte);
    }
    $("vide").hidden = elements.length > 0;
    $("resume").textContent = elements.length + " élément(s)";
    if (elements.some((e) => OCCUPES.includes(e.statut) || e.suivi)) minuteur = setTimeout(chargerListe, ATTENTE_MS);
  }

  // ---------- Détail ----------

  function rendreTexte(e) {
    const conteneur = $("d-texte");
    conteneur.replaceChildren();
    const preuves = new Set(Object.values(e.preuves || {}).flat());
    e.texte.split(/\r\n|\n|\r/).forEach((ligne, i) => {
      const div = document.createElement("div");
      div.className = "ligne" + (preuves.has(i) ? " preuve" : "");
      div.dataset.ligne = String(i);
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i + 1);
      const contenu = document.createElement("span");
      contenu.className = "contenu";
      contenu.textContent = ligne;
      div.append(num, contenu);
      conteneur.append(div);
    });
  }

  function surligner(lignes) {
    const actives = new Set(lignes || []);
    let premiere = null;
    for (const div of $("d-texte").children) {
      const on = actives.has(Number(div.dataset.ligne));
      div.classList.toggle("active", on);
      if (on && !premiere) premiere = div;
    }
    if (premiere) premiere.scrollIntoView({ block: "nearest" });
  }

  function rendreClassement(e) {
    const bloc = $("d-classement");
    bloc.replaceChildren();
    const c = e.classement;
    const p = (texte, classe) => {
      const el = document.createElement("p");
      el.className = classe || "";
      el.textContent = texte;
      bloc.append(el);
      return el;
    };
    if (!c) { p("Pas encore classé.", "note"); return; }
    const methode = c.methode === "decision" ? "modèle de décision" : "lecture générative";
    p("Type : " + libelleType(c.type) + " — " + methode + (c.repli ? " (repli : le modèle de décision n'a pas répondu, HTTP " + c.repli.statut_http + ")" : ""));
    if (c.probabilites) {
      for (const [type, v] of Object.entries(c.probabilites)) {
        const ligne = document.createElement("div");
        ligne.className = "ligne-proba";
        const nom = document.createElement("span");
        nom.textContent = libelleType(type);
        const jauge = document.createElement("meter");
        jauge.min = 0; jauge.max = 1; jauge.value = v;
        const val = document.createElement("span");
        val.textContent = v.toFixed(2);
        ligne.append(nom, jauge, val);
        bloc.append(ligne);
      }
      p("Probabilité du modèle, non calibrée sur nos données : un ordre de grandeur, pas une certitude.", "note");
    }
    if (c.raisons && c.raisons.length) p("À vérifier : " + c.raisons.map((r) => LIBELLES_RAISONS[r] || r).join(", ") + ".", "raison");
    if (c.correction) p("Corrigé à la main en « " + libelleType(c.correction.type) + " ».", "note");
  }

  function rendreChamps(e) {
    const conteneur = $("champs");
    conteneur.replaceChildren();
    const champs = e.champs;
    $("champs-vide").hidden = Boolean(champs);
    $("form-champs").hidden = !champs;
    if (!champs) return;
    for (const cle of Object.keys(LIBELLES_CHAMPS)) {
      const bloc = document.createElement("div");
      bloc.className = "champ-extrait";
      const id = "champ-" + cle;
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = LIBELLES_CHAMPS[cle];
      let saisie;
      if (cle === "type_contrat") {
        saisie = document.createElement("select");
        for (const t of config.types_contrat) {
          const o = document.createElement("option");
          o.value = t;
          o.textContent = LIBELLES_CONTRATS[t] || t;
          saisie.append(o);
        }
        saisie.value = champs.type_contrat || "inconnu";
      } else if (cle === "competences") {
        saisie = document.createElement("textarea");
        saisie.rows = 4;
        saisie.value = (champs.competences || []).join("\n");
      } else {
        saisie = document.createElement("input");
        saisie.type = "text";
        saisie.maxLength = 300;
        saisie.value = champs[cle] || "";
      }
      saisie.id = id;
      saisie.name = cle;
      bloc.append(label, saisie);
      const lignes = (e.preuves || {})[cle] || [];
      const vide = cle === "competences" ? !(champs.competences || []).length : !champs[cle] || champs[cle] === "inconnu";
      const ancrage = vide ? undefined : (e.confiances || {})[cle];
      const info = document.createElement("span");
      info.className = "ancrage" + (typeof ancrage === "number" && ancrage < SEUIL_ANCRAGE ? " faible" : "");
      const morceaux = [];
      if (lignes.length) morceaux.push("ligne" + (lignes.length > 1 ? "s " : " ") + lignes.map((l) => l + 1).join(", "));
      if (typeof ancrage === "number") morceaux.push("ancrage dans le texte " + ancrage.toFixed(2));
      info.textContent = vide ? "non trouvé dans le texte" : morceaux.join(" · ") || "aucune preuve dans le texte";
      bloc.append(info);
      const montrer = () => surligner(lignes);
      bloc.addEventListener("mouseenter", montrer);
      bloc.addEventListener("focusin", montrer);
      bloc.addEventListener("mouseleave", () => surligner([]));
      conteneur.append(bloc);
    }
  }

  function rendreDetail(e) {
    courant = e;
    badgeType($("d-type"), e.type);
    badgeStatut($("d-statut"), e.statut);
    badgeEmployeur($("d-employeur"), e);
    $("d-bloc-employeur").hidden = !e.source_meta;
    $("d-choix-employeur").value = (e.source_meta && e.source_meta.employeur) || "inconnu";
    $("d-choix-employeur").disabled = OCCUPES.includes(e.statut) || Boolean(e.suivi);
    $("d-titre").textContent = titreElement(e);
    $("d-meta").textContent = metaElement(e);
    const suivi = texteSuivi(e);
    $("d-suivi").textContent = suivi;
    $("d-suivi").hidden = !suivi;
    $("d-erreur").textContent = e.statut === "echec" && e.erreur ? e.erreur.message : "";
    $("d-erreur").hidden = !(e.statut === "echec" && e.erreur);
    const source = $("d-source");
    if (e.url_source) { source.href = e.url_source; source.hidden = false; } else source.hidden = true;
    const occupe = OCCUPES.includes(e.statut) || Boolean(e.suivi);
    for (const id of ["b-reclasser", "b-bruit", "b-valider", "b-enregistrer", "b-rapprocher"]) $(id).disabled = occupe;
    $("b-valider").disabled = occupe || e.statut === "valide" || !e.type;
    $("b-bruit").disabled = occupe || e.statut === "ecarte";
    $("b-rapprocher").disabled = occupe || !e.champs || e.type === "bruit";
    $("d-choix-type").value = e.type || "";
    $("d-choix-type").disabled = occupe;
    $("b-reclasser").textContent = "Re-classer";
    reclasserArme = false;
    rendreTexte(e);
    rendreClassement(e);
    rendreChamps(e);
    $("d-rapprochement").textContent = texteRapprochement(e.rapprochement);
    remplirProfils($("d-profils"), e.rapprochement, 10);
    if (!occupe) chargerProfilsOffre(e);
    if (occupe) minuteur = setTimeout(() => chargerDetail(e.id, true), ATTENTE_MS);
  }

  async function chargerDetail(id, silencieux) {
    if (!silencieux) message($("d-message"), "");
    try {
      rendreDetail((await api("api/elements/" + id)).element);
      if (avis) { message($("d-message"), avis); avis = null; }
    } catch (e) {
      message($("d-message"), e.message, "erreur");
    }
  }

  async function action(chemin, options, texteOk) {
    if (!courant) return;
    arreterAttente();
    message($("d-message"), "");
    try {
      const r = await api("api/elements/" + courant.id + chemin, { method: "POST", ...options });
      rendreDetail(r.element);
      if (texteOk) message($("d-message"), texteOk, "ok");
    } catch (e) {
      message($("d-message"), e.message, "erreur");
      chargerDetail(courant.id, true);
    }
  }

  function lireChamps() {
    const f = $("form-champs");
    const champs = {};
    for (const cle of Object.keys(LIBELLES_CHAMPS)) {
      const v = f.elements[cle].value;
      champs[cle] = cle === "competences" ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : v.trim();
    }
    return champs;
  }

  // ---------- Démarrage ----------

  async function demarrer() {
    try {
      config = await api("api/config");
      const moi = await api("api/moi");
      $("moi").textContent = moi.utilisateur.full_name || moi.utilisateur.email || "";
    } catch (e) {
      document.querySelector("main").textContent = e.message;
      return;
    }
    remplirFiltres();
    const choix = $("d-choix-type");
    const vide = document.createElement("option");
    vide.value = "";
    vide.textContent = "Type inconnu";
    vide.disabled = true;
    choix.append(vide);
    for (const t of config.types) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = libelleType(t);
      choix.append(o);
    }
    choix.addEventListener("change", async () => {
      if (!courant || !choix.value) return;
      try {
        const r = await api("api/elements/" + courant.id, { method: "PATCH", body: JSON.stringify({ type: choix.value }) });
        rendreDetail(r.element);
        message($("d-message"), "Type corrigé. Re-classez pour relancer l'extraction si besoin.", "ok");
      } catch (e) {
        message($("d-message"), e.message, "erreur");
      }
    });
    for (const id of ["filtre-type", "filtre-statut", "filtre-origine", "filtre-employeur", "filtre-contrat"]) $(id).addEventListener("change", () => { arreterAttente(); chargerListe(); });
    $("texte").addEventListener("input", majCompteur);
    $("form-coller").addEventListener("submit", envoyer);
    $("onglet-linkedin").hidden = !config.linkedin_public;
    $("form-linkedin").addEventListener("submit", chercherLinkedin);
    $("li-tri").addEventListener("change", rendreOffres);
    $("li-masquer-deja").addEventListener("change", rendreOffres);
    $("li-tout").addEventListener("click", () => {
      const cases = [...document.querySelectorAll("#li-offres .choisir:not(:disabled)")];
      const tout = cases.some((c) => !c.checked);
      for (const c of cases) c.checked = tout;
      majSelection();
    });
    $("li-analyser").addEventListener("click", analyserSelection);
    $("form-profil").addEventListener("submit", enregistrerProfil);
    $("pf-annuler").addEventListener("click", () => { finEdition(); message($("pf-message"), ""); });
    $("d-choix-employeur").addEventListener("change", async () => {
      if (!courant) return;
      try {
        const r = await api("api/elements/" + courant.id, { method: "PATCH", body: JSON.stringify({ employeur: $("d-choix-employeur").value }) });
        rendreDetail(r.element);
        message($("d-message"), "Nature de l'employeur corrigée.", "ok");
      } catch (e) {
        message($("d-message"), e.message, "erreur");
      }
    });
    $("b-reclasser").addEventListener("click", () => {
      if (courant && courant.champs && !reclasserArme) {
        reclasserArme = true;
        $("b-reclasser").textContent = "Confirmer : les champs corrigés seront remplacés";
        return;
      }
      action("/reclasser", {}, "Élément remis en file.");
    });
    $("b-bruit").addEventListener("click", () => action("/bruit", {}, "Élément marqué comme bruit."));
    $("b-valider").addEventListener("click", () => action("/valider", {}, "Élément validé."));
    $("b-rapprocher").addEventListener("click", () => action("/rapprocher", {}, "Rapprochement relancé."));
    $("form-champs").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!courant) return;
      message($("d-message"), "");
      try {
        const r = await api("api/elements/" + courant.id, { method: "PATCH", body: JSON.stringify({ champs: lireChamps() }) });
        rendreDetail(r.element);
        message($("d-message"), "Champs enregistrés. Relancez le rapprochement pour en tenir compte.", "ok");
      } catch (e) {
        message($("d-message"), e.message, "erreur");
      }
    });
    majCompteur();
    window.addEventListener("hashchange", router);
    router();
  }

  demarrer();
})();
