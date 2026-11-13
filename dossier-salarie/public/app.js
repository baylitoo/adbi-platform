"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const etat = { config: null, dossiers: [], courant: null, vue: null, suivis: new Map() };

  const LIBELLES_ETAT = {
    recu: "Reçu", manquant: "Manquant", expire: "Expiré", invalide: "Invalide", a_verifier: "À vérifier", en_cours: "En cours",
  };
  const LIBELLES_STATUT = {
    en_attente: "En file", extraction: "Lecture en cours", extrait: "Lu", echec: "Échec", a_classer: "Type à choisir", a_saisir: "À saisir",
  };
  const LIBELLES_CLASSEMENT = { indices: "indices du document", nom_fichier: "nom du fichier", docie: "DocIE", manuel: "choix manuel", aucune: "" };

  function el(tag, attrs, ...enfants) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const e of enfants.flat()) if (e !== null && e !== undefined) n.append(e.nodeType ? e : String(e));
    return n;
  }

  function afficherErreur(message) {
    const z = $("erreur");
    z.textContent = message || "";
    z.hidden = !message;
  }

  async function api(methode, url, corps) {
    const r = await fetch(url, {
      method: methode, credentials: "same-origin",
      headers: corps ? { "Content-Type": "application/json" } : {},
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (r.status === 401) { window.location.reload(); throw new Error("Session expirée."); }
    const donnees = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(donnees.erreur || donnees.error || "Erreur " + r.status);
    return donnees;
  }

  function dateFr(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
  }

  function remplirSelect(select, options, vide) {
    select.replaceChildren(...(vide ? [el("option", { value: "" }, vide)] : []), ...options.map(([v, t]) => el("option", { value: v }, t)));
  }

  // ---------- Liste ----------

  async function chargerListe() {
    etat.dossiers = (await api("GET", "api/dossiers")).dossiers;
    const ul = $("dossiers");
    ul.replaceChildren(...etat.dossiers.map((d) => el("li", null, el("button", {
      type: "button", class: d.id === etat.courant ? "actif" : null, onclick: () => ouvrir(d.id),
    }, el("span", { class: "nom" }, d.nom + (d.prenoms ? " " + d.prenoms : "")),
    el("span", { class: "meta" }, [d.typeContrat, d.dateEmbauche ? "embauche le " + dateFr(d.dateEmbauche) : "", d.nbPieces + " pièce(s)"].filter(Boolean).join(" · "))))));
    $("dossiers-vide").hidden = etat.dossiers.length > 0;
  }

  // ---------- Dossier ----------

  async function ouvrir(id) {
    afficherErreur("");
    etat.courant = id;
    try {
      afficherDossier(await api("GET", "api/dossiers/" + id));
      chargerListe().catch(() => {});
    } catch (e) { afficherErreur(e.message); }
  }

  function afficherDossier(vue) {
    etat.vue = vue;
    const d = vue.dossier;
    $("accueil").hidden = true;
    $("vue-dossier").hidden = false;
    $("titre-dossier").textContent = d.nom + (d.prenoms ? " " + d.prenoms : "");
    $("titre-impression").textContent = "Fiche d'entrée — " + d.nom + (d.prenoms ? " " + d.prenoms : "");
    const f = $("form-dossier");
    f.nom.value = d.nom; f.prenoms.value = d.prenoms; f.dateEmbauche.value = d.dateEmbauche || ""; f.typeContrat.value = d.typeContrat || "";
    $("cree-par").textContent = "Créé le " + dateFr(d.creeLe) + (d.creePar.email ? " par " + d.creePar.email : "");
    $("attendus").replaceChildren(...Object.entries(etat.config.types).map(([id, t]) => el("label", null,
      el("input", { type: "checkbox", name: "attendu", value: id, checked: d.attendus.includes(id) }), t.libelle)));
    afficherCompletude(vue.completude);
    afficherPieces(vue);
    afficherFiche(vue.fiche);
    $("export-csv").href = "api/dossiers/" + d.id + "/fiche.csv";
    for (const p of vue.pieces) if (p.tache && ["en_attente", "extraction"].includes(p.statut)) suivre(p.tache, d.id);
  }

  function afficherCompletude(c) {
    const g = $("etat-global");
    g.className = "pastille " + (c.complet ? "recu" : "a_verifier");
    g.textContent = c.complet ? "Complet" : "Incomplet";
    $("completude").replaceChildren(...c.lignes.map((l) => {
      const constats = l.pieces.flatMap((id) => c.parPiece[id].problemes.map((p) => p.message));
      return el("tr", null, el("td", null, l.libelle),
        el("td", null, el("span", { class: "pastille " + l.statut }, LIBELLES_ETAT[l.statut] || l.statut)),
        el("td", null, constats.length ? el("ul", null, constats.map((m) => el("li", null, m))) : ""));
    }));
  }

  function optionsTypes(vide) {
    return [...(vide ? [["", vide]] : []), ...Object.entries(etat.config.types).map(([id, t]) => [id, t.libelle])];
  }

  function afficherPieces(vue) {
    const dossierId = vue.dossier.id;
    $("pieces").replaceChildren(...vue.pieces.map((p) => {
      const controle = vue.completude.parPiece[p.id] || { statut: "", problemes: [] };
      const type = p.typePiece ? etat.config.types[p.typePiece] : null;
      const enCours = ["en_attente", "extraction"].includes(p.statut);
      const etiquette = el("span", { class: "pastille " + (enCours ? "en_cours" : controle.statut), id: "statut-" + p.id },
        enCours ? el("span", { class: "tourne" }) : null, LIBELLES_STATUT[p.statut] || p.statut);
      const tete = el("div", { class: "tete" },
        el("span", { class: "nom" }, type ? type.libelle : "Pièce non classée"),
        el("span", { class: "meta" }, [p.nomOrigine, dateFr(p.deposeLe),
          p.classement && LIBELLES_CLASSEMENT[p.classement] ? "classée par " + LIBELLES_CLASSEMENT[p.classement] : ""].filter(Boolean).join(" · ")),
        etiquette);
      const constats = [
        ...controle.problemes.map((x) => [x.gravite, x.message]),
        ...((p.analyse && p.analyse.constats) || []).map((m) => ["", m]),
        ...(p.erreur ? [["invalide", p.erreur.message]] : []),
      ];
      const choixType = el("select", { onchange: (e) => changerType(dossierId, p.id, e.target.value), disabled: enCours });
      remplirSelect(choixType, optionsTypes(), p.typePiece ? null : "Choisir le type…");
      choixType.value = p.typePiece || "";
      const actions = el("div", { class: "actions" },
        el("label", { class: "champ" }, el("span", null, "Type"), choixType),
        el("a", { class: "btn petit", href: "api/dossiers/" + dossierId + "/pieces/" + p.id + "/fichier" }, "Télécharger"),
        etat.config.coffreUrl ? el("a", { class: "btn petit", href: etat.config.coffreUrl, target: "_top", title: "Ouvre ADBI Coffre : déposez-y la pièce téléchargée pour la masquer." }, "Protéger dans Coffre") : null,
        p.typePiece && !enCours ? el("button", { class: "btn petit", type: "button", onclick: () => relancer(dossierId, p.id) }, "Relire") : null,
        el("button", { class: "btn petit fantome danger", type: "button", onclick: () => supprimerPiece(dossierId, p.id) }, "Supprimer"));
      const li = el("li", null, tete,
        constats.length ? el("ul", { class: "constats" }, constats.map(([g, m]) => el("li", { class: g || null }, m))) : null,
        actions);
      if (type) li.append(formulaireValeurs(dossierId, p, type, enCours));
      return li;
    }));
  }

  function formulaireValeurs(dossierId, p, type, enCours) {
    const form = el("form", { autocomplete: "off" });
    form.append(el("div", { class: "grille" }, type.champs.map((c) => el("label", { class: "champ" }, el("span", null, c.libelle),
      el("input", { name: c.cle, type: c.nature === "date" ? "date" : "text", value: (p.valeurs || {})[c.cle] || "", disabled: enCours })))));
    form.append(el("div", { class: "actions" }, el("button", { class: "btn petit", type: "submit", disabled: enCours }, "Enregistrer les valeurs")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const valeurs = Object.fromEntries(type.champs.map((c) => [c.cle, form.elements[c.cle].value]));
      try { afficherDossier(await api("PUT", "api/dossiers/" + dossierId + "/pieces/" + p.id, { valeurs })); } catch (er) { afficherErreur(er.message); }
    });
    return el("details", { open: p.statut === "a_saisir" || null }, el("summary", null, "Valeurs lues (modifiables)"), form);
  }

  function afficherFiche(champs) {
    $("fiche").replaceChildren(...champs.map((c) => el("label", { class: "champ" }, el("span", null, c.libelle),
      el("input", { name: c.cle, value: c.valeur, type: c.cle === "dateEmbauche" || c.cle === "dateNaissance" ? "date" : c.cle === "heureEmbauche" ? "time" : "text" }),
      el("span", { class: "source" }, c.source ? "Source : " + c.source : "À compléter"))));
  }

  // ---------- Suivi des extractions ----------

  function suivre(tache, dossierId) {
    if (etat.suivis.has(tache)) return;
    etat.suivis.set(tache, true);
    const tour = async () => {
      if (etat.courant !== dossierId) { etat.suivis.delete(tache); return; }
      let vue;
      try { vue = await api("GET", "api/taches/" + encodeURIComponent(tache)); } catch (e) { vue = null; }
      if (!vue || vue.etat !== "en_cours") {
        etat.suivis.delete(tache);
        if (etat.courant === dossierId) ouvrir(dossierId);
        return;
      }
      const piece = etat.vue && etat.vue.pieces.find((p) => p.tache === tache);
      const marque = piece && $("statut-" + piece.id);
      if (marque) {
        marque.replaceChildren(el("span", { class: "tourne" }),
          vue.etape === "en_attente" ? "En file" + (vue.position ? " (position " + vue.position + ")" : "") : "Lecture en cours");
      }
      setTimeout(tour, 2000);
    };
    setTimeout(tour, 1000);
  }

  // ---------- Actions ----------

  function lireFichier(fichier) {
    return new Promise((ok, ko) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1] || "");
      r.onerror = () => ko(new Error("Lecture du fichier impossible."));
      r.readAsDataURL(fichier);
    });
  }

  async function deposer(fichiers) {
    const dossierId = etat.courant;
    if (!dossierId) return;
    afficherErreur("");
    const typePiece = $("type-depot").value || null;
    for (const f of fichiers) {
      if (f.size > etat.config.tailleMax) { afficherErreur("« " + f.name + " » dépasse 19 Mo."); continue; }
      try {
        const dataBase64 = await lireFichier(f);
        const r = await api("POST", "api/dossiers/" + dossierId + "/pieces", { nom: f.name, mime: f.type, dataBase64, typePiece });
        suivre(r.tache, dossierId);
      } catch (e) { afficherErreur(e.message); }
    }
    ouvrir(dossierId);
  }

  async function changerType(dossierId, pieceId, typePiece) {
    if (!typePiece) return;
    try {
      const r = await api("PUT", "api/dossiers/" + dossierId + "/pieces/" + pieceId, { typePiece });
      if (r.tache) suivre(r.tache, dossierId);
      ouvrir(dossierId);
    } catch (e) { afficherErreur(e.message); }
  }

  async function relancer(dossierId, pieceId) {
    try {
      const r = await api("POST", "api/dossiers/" + dossierId + "/pieces/" + pieceId + "/relancer");
      suivre(r.tache, dossierId);
      ouvrir(dossierId);
    } catch (e) { afficherErreur(e.message); }
  }

  async function supprimerPiece(dossierId, pieceId) {
    if (!window.confirm("Supprimer définitivement cette pièce et son fichier ?")) return;
    try { afficherDossier(await api("DELETE", "api/dossiers/" + dossierId + "/pieces/" + pieceId)); chargerListe(); } catch (e) { afficherErreur(e.message); }
  }

  function brancher() {
    remplirSelect($("types-contrat"), etat.config.typesContrat.map((t) => [t, t]), "—");
    remplirSelect($("types-contrat-dossier"), etat.config.typesContrat.map((t) => [t, t]), "—");
    remplirSelect($("type-depot"), optionsTypes("Détection automatique"));
    $("sans-extraction").hidden = etat.config.extraction;
    $("utilisateur").textContent = etat.config.utilisateur.email || "";

    $("form-nouveau").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const { dossier } = await api("POST", "api/dossiers", {
          nom: f.nom.value, prenoms: f.prenoms.value, dateEmbauche: f.dateEmbauche.value, typeContrat: f.typeContrat.value,
        });
        f.reset();
        await ouvrir(dossier.id);
      } catch (er) { afficherErreur(er.message); }
    });

    $("form-dossier").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const attendus = [...f.querySelectorAll("input[name=attendu]:checked")].map((c) => c.value);
      try {
        afficherDossier(await api("PUT", "api/dossiers/" + etat.courant, {
          nom: f.nom.value, prenoms: f.prenoms.value, dateEmbauche: f.dateEmbauche.value, typeContrat: f.typeContrat.value, attendus,
        }));
        chargerListe();
      } catch (er) { afficherErreur(er.message); }
    });

    $("supprimer-dossier").addEventListener("click", async () => {
      if (!window.confirm("Supprimer ce dossier, toutes ses pièces et leurs fichiers ? Cette action est définitive.")) return;
      try {
        await api("DELETE", "api/dossiers/" + etat.courant);
        etat.courant = null;
        $("vue-dossier").hidden = true;
        $("accueil").hidden = false;
        chargerListe();
      } catch (er) { afficherErreur(er.message); }
    });

    $("form-fiche").addEventListener("submit", async (e) => {
      e.preventDefault();
      const saisie = Object.fromEntries(etat.vue.fiche.map((c) => [c.cle, e.target.elements[c.cle].value]));
      const proposes = Object.fromEntries(etat.vue.fiche.filter((c) => c.source !== "Saisie").map((c) => [c.cle, c.valeur]));
      const fiche = Object.fromEntries(Object.entries(saisie).filter(([k, v]) => v !== (proposes[k] ?? null)));
      try { afficherDossier(await api("PUT", "api/dossiers/" + etat.courant, { fiche })); } catch (er) { afficherErreur(er.message); }
    });

    $("imprimer").addEventListener("click", () => window.print());
    $("parcourir").addEventListener("click", () => $("fichiers").click());
    $("fichiers").addEventListener("change", (e) => { deposer([...e.target.files]); e.target.value = ""; });
    const depot = $("depot");
    depot.addEventListener("dragover", (e) => { e.preventDefault(); depot.classList.add("survol"); });
    depot.addEventListener("dragleave", () => depot.classList.remove("survol"));
    depot.addEventListener("drop", (e) => { e.preventDefault(); depot.classList.remove("survol"); deposer([...e.dataTransfer.files]); });
  }

  api("GET", "api/config")
    .then((config) => { etat.config = config; brancher(); return chargerListe(); })
    .catch((e) => afficherErreur(e.message));
})();
