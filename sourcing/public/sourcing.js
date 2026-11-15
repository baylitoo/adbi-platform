/* ADBI Sourcing : collage, liste des opportunités et détail d'un élément ; tout texte reçu passe par textContent. */
(function () {
  "use strict";

  const LIBELLES_STATUTS = {
    en_attente: "En file", en_cours: "En cours", a_verifier: "À vérifier", a_valider: "À valider",
    valide: "Validé", ecarte: "Écarté", echec: "Échec",
  };
  const LIBELLES_ORIGINES = { collage: "Collage", navigateur: "Bouton navigateur", email: "E-mail", api: "API" };
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
  const OCCUPES = ["en_attente", "en_cours"];
  const SEUIL_ANCRAGE = 0.5;
  const ATTENTE_MS = 2500;

  let config = null;
  let minuteur = null;
  let courant = null;
  let avis = null;

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
    for (const v of ["coller", "liste", "detail"]) $("vue-" + v).hidden = v !== vue;
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
  }

  async function chargerListe() {
    const params = new URLSearchParams();
    for (const [cle, id] of [["type", "filtre-type"], ["statut", "filtre-statut"], ["origine", "filtre-origine"]]) {
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
      const titre = carte.querySelector(".titre");
      titre.textContent = titreElement(e);
      titre.href = "#element/" + e.id;
      carte.querySelector(".meta").textContent = [metaElement(e), texteSuivi(e)].filter(Boolean).join(" · ");
      const n = remplirProfils(carte.querySelector(".profils"), e.rapprochement, 3);
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
      const ancrage = (e.confiances || {})[cle];
      const info = document.createElement("span");
      info.className = "ancrage" + (typeof ancrage === "number" && ancrage < SEUIL_ANCRAGE ? " faible" : "");
      const morceaux = [];
      if (lignes.length) morceaux.push("ligne" + (lignes.length > 1 ? "s " : " ") + lignes.map((l) => l + 1).join(", "));
      if (typeof ancrage === "number") morceaux.push("ancrage dans le texte " + ancrage.toFixed(2));
      info.textContent = morceaux.join(" · ") || "aucune preuve dans le texte";
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
    rendreTexte(e);
    rendreClassement(e);
    rendreChamps(e);
    $("d-rapprochement").textContent = texteRapprochement(e.rapprochement);
    remplirProfils($("d-profils"), e.rapprochement, 10);
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
    for (const id of ["filtre-type", "filtre-statut", "filtre-origine"]) $(id).addEventListener("change", () => { arreterAttente(); chargerListe(); });
    $("texte").addEventListener("input", majCompteur);
    $("form-coller").addEventListener("submit", envoyer);
    $("b-reclasser").addEventListener("click", () => {
      if (courant && courant.champs && !window.confirm("Re-classer relance tout le traitement et remplace les champs corrigés. Continuer ?")) return;
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
