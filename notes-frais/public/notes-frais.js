"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const LIBELLES_CATEGORIE = { repas: "Repas", transport: "Transport", hebergement: "Hébergement", carburant: "Carburant", fournitures: "Fournitures", autre: "Autre" };
  const LIBELLES_STATUT = { extraction: "Lecture…", a_valider: "À valider", validee: "Validée", echec: "Lecture impossible" };
  const INTERVALLE_SUIVI_MS = 2000;

  const etat = { moi: null, toutVoir: false, categories: Object.keys(LIBELLES_CATEGORIE), suivies: new Map() };

  async function api(chemin, options = {}) {
    const init = { credentials: "same-origin", ...options };
    if (options.corps !== undefined) {
      init.method = init.method || "POST";
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(options.corps);
    }
    const r = await fetch(chemin, init);
    let donnees = null;
    try { donnees = await r.json(); } catch { donnees = null; }
    if (r.status === 401) { window.location.reload(); throw new Error("Session expirée."); }
    if (!r.ok) throw new Error((donnees && (donnees.error || donnees.erreur)) || "Erreur " + r.status);
    return donnees;
  }

  const montantTexte = (n) => (n === null || n === undefined ? "" : n.toFixed(2).replace(".", ","));
  const nombre = (t) => {
    const s = String(t || "").replace(/[\s €]/g, "").replace(",", ".");
    return s && /^-?\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : null;
  };
  const libelleMois = (m) => {
    const [a, mo] = m.split("-").map(Number);
    return new Date(a, mo - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  };

  // ── Dépôt ──────────────────────────────────────────────────────────────
  function lireBase64(fichier) {
    return new Promise((resoudre, rejeter) => {
      const lecteur = new FileReader();
      lecteur.onload = () => resoudre(String(lecteur.result).split(",")[1] || "");
      lecteur.onerror = () => rejeter(new Error("Lecture du fichier impossible."));
      lecteur.readAsDataURL(fichier);
    });
  }

  function ligneEnvoi(nom) {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.className = "nom"; n.textContent = nom;
    const e = document.createElement("span");
    e.className = "etat"; e.textContent = "Envoi…";
    li.append(n, e);
    $("envois").hidden = false;
    $("envois").prepend(li);
    return { li, etat: e };
  }

  async function envoyer(fichiers) {
    for (const fichier of fichiers) {
      const vue = ligneEnvoi(fichier.name);
      try {
        if (fichier.size > 15 * 1024 * 1024) throw new Error("Fichier trop volumineux (15 Mo maximum).");
        const contenu = await lireBase64(fichier);
        const r = await api("api/notes", { corps: { fichier: { nom: fichier.name, contenu } } });
        vue.etat.textContent = r.tache ? "En file d'attente" : "File pleine : relisez plus tard depuis le tableau";
        if (r.tache) suivre(r.tache, vue);
        else vue.li.classList.add("erreur");
      } catch (e) {
        vue.li.classList.add("erreur");
        vue.etat.textContent = e.message;
      }
    }
    await rafraichir();
  }

  // ── Suivi des tâches d'extraction ──────────────────────────────────────
  function suivre(tache, vue) {
    if (etat.suivies.has(tache)) { if (vue) etat.suivies.get(tache).vues.push(vue); return; }
    etat.suivies.set(tache, { vues: vue ? [vue] : [] });
    const tour = async () => {
      let v;
      try { v = await api("api/taches/" + encodeURIComponent(tache)); } catch { v = null; }
      const suivi = etat.suivies.get(tache);
      if (!v || v.etat !== "en_cours") {
        etat.suivies.delete(tache);
        for (const vu of suivi.vues) {
          vu.li.classList.add(v && v.etat === "terminee" ? "ok" : "erreur");
          vu.etat.textContent = v && v.etat === "terminee" ? "Lu — à relire dans le tableau" : (v && v.erreur ? v.erreur.message : "Lecture terminée");
        }
        await rafraichir();
        return;
      }
      const texte = v.etape === "en_attente" ? "En file d'attente (position " + v.position + ")" : "Lecture en cours…";
      for (const vu of suivi.vues) vu.etat.textContent = texte;
      document.querySelectorAll('[data-tache="' + CSS.escape(tache) + '"]').forEach((el) => { el.textContent = texte; });
      setTimeout(tour, INTERVALLE_SUIVI_MS);
    };
    setTimeout(tour, 600);
  }

  // ── Tableau ────────────────────────────────────────────────────────────
  function ajouterLigneTva(conteneur, ligne) {
    const frag = $("modele-tva").content.cloneNode(true);
    const div = frag.querySelector(".tva-ligne");
    for (const cle of ["taux", "base", "montant"]) {
      const v = ligne ? ligne[cle] : null;
      div.querySelector('[data-tva="' + cle + '"]').value = v === null || v === undefined ? "" : (cle === "taux" ? String(v).replace(".", ",") : montantTexte(v));
    }
    conteneur.appendChild(div);
  }

  function lireLigne(tr) {
    const val = (c) => tr.querySelector('[data-champ="' + c + '"]').value;
    const tva = [...tr.querySelectorAll(".tva-ligne")].map((d) => ({
      taux: nombre(d.querySelector('[data-tva="taux"]').value),
      base: nombre(d.querySelector('[data-tva="base"]').value),
      montant: nombre(d.querySelector('[data-tva="montant"]').value),
    })).filter((l) => l.taux !== null || l.base !== null || l.montant !== null);
    return {
      date: val("date"), commercant: val("commercant"), categorie: val("categorie"), moyen_paiement: val("moyen_paiement"),
      devise: val("devise"), total_ht: nombre(val("total_ht")), total_ttc: nombre(val("total_ttc")), tva,
    };
  }

  function badge(texte, niveau, titre) {
    const s = document.createElement("span");
    s.className = "badge" + (niveau ? " " + niveau : "");
    s.textContent = texte;
    if (titre) s.title = titre;
    return s;
  }

  function correctif(texte, action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "lien"; b.textContent = texte;
    b.addEventListener("click", action);
    return b;
  }

  function construireLigne(note) {
    const tr = $("modele-ligne").content.firstElementChild.cloneNode(true);
    tr.dataset.id = note.id;
    const lien = tr.querySelector(".justificatif");
    lien.href = "api/notes/" + note.id + "/fichier";
    lien.textContent = note.fichier.nom || "justificatif";

    const select = tr.querySelector('[data-champ="categorie"]');
    for (const c of etat.categories) select.add(new Option(LIBELLES_CATEGORIE[c] || c, c));
    tr.querySelector('[data-champ="date"]').value = note.date || "";
    tr.querySelector('[data-champ="commercant"]').value = note.commercant || "";
    select.value = note.categorie || "autre";
    tr.querySelector('[data-champ="moyen_paiement"]').value = note.moyen_paiement || "";
    tr.querySelector('[data-champ="devise"]').value = note.devise || "EUR";
    tr.querySelector('[data-champ="total_ht"]').value = montantTexte(note.total_ht);
    tr.querySelector('[data-champ="total_ttc"]').value = montantTexte(note.total_ttc);
    const lignesTva = tr.querySelector(".tva-lignes");
    for (const l of note.tva) ajouterLigneTva(lignesTva, l);

    const ctrl = tr.querySelector(".controles");
    if (note.controles.some((c) => c.code === "ecart_ttc")) {
      const corr = document.createElement("div");
      corr.className = "correctifs";
      corr.append(
        correctif("TTC = HT + TVA", () => {
          const l = lireLigne(tr);
          const t = (l.total_ht ?? 0) + l.tva.reduce((s, x) => s + (x.montant ?? 0), 0);
          tr.querySelector('[data-champ="total_ttc"]').value = montantTexte(Math.round(t * 100) / 100);
          marquerModifiee(tr);
        }),
        correctif("HT = TTC − TVA", () => {
          const l = lireLigne(tr);
          const t = (l.total_ttc ?? 0) - l.tva.reduce((s, x) => s + (x.montant ?? 0), 0);
          tr.querySelector('[data-champ="total_ht"]').value = montantTexte(Math.round(t * 100) / 100);
          marquerModifiee(tr);
        }),
      );
      ctrl.appendChild(corr);
    }
    for (const c of note.controles) ctrl.appendChild(badge(c.libelle, c.niveau, c.detail));
    if (note.partiel && note.partiel.length) ctrl.appendChild(badge("Lecture partielle", "attention", "Champs à relire : " + note.partiel.map((p) => p.champ).join(", ")));
    if (!note.controles.length && note.statut !== "extraction" && note.statut !== "echec") ctrl.appendChild(badge("RAS", "ok"));

    const statut = tr.querySelector(".statut");
    if (note.statut === "extraction") {
      tr.classList.add("en-cours");
      const s = document.createElement("span");
      s.textContent = "Lecture…";
      if (note.tache) { s.dataset.tache = note.tache; suivre(note.tache); }
      const roue = document.createElement("span");
      roue.className = "tourne";
      statut.append(roue, s);
      tr.querySelectorAll("input, select, .actions button, .tva button").forEach((el) => { el.disabled = true; });
    } else {
      statut.appendChild(badge(LIBELLES_STATUT[note.statut] || note.statut, note.statut === "validee" ? "ok" : note.statut === "echec" ? "erreur" : ""));
      if (note.statut === "echec" && note.erreur) {
        const m = document.createElement("span");
        m.className = "message-ligne"; m.textContent = note.erreur.message + " Saisissez la note ou relancez la lecture.";
        statut.appendChild(m);
      }
      if (note.modele) statut.title = "Lu par : " + note.modele + (note.voie === "agent" ? " (image)" : " (texte du PDF)");
    }
    if (note.statut === "validee") {
      tr.classList.add("validee");
      tr.querySelector(".valider").disabled = true;
    }
    tr.querySelector(".enregistrer").disabled = true;
    return tr;
  }

  function marquerModifiee(tr) {
    tr.classList.add("modifiee");
    tr.classList.remove("validee");
    tr.querySelector(".enregistrer").disabled = false;
    tr.querySelector(".valider").disabled = false;
  }

  async function enregistrer(tr, valider) {
    const corps = { ...lireLigne(tr), valider };
    tr.querySelectorAll(".actions button").forEach((b) => { b.disabled = true; });
    try {
      await api("api/notes/" + tr.dataset.id, { method: "PATCH", corps });
      tr.classList.remove("modifiee");
      await rafraichir();
    } catch (e) {
      alert(e.message);
      marquerModifiee(tr);
      tr.querySelectorAll(".relancer, .supprimer").forEach((b) => { b.disabled = false; });
    }
  }

  function brancherTableau() {
    const groupes = $("groupes");
    groupes.addEventListener("input", (ev) => {
      const tr = ev.target.closest("tr.note");
      if (tr && ev.target.matches("input, select")) marquerModifiee(tr);
    });
    groupes.addEventListener("click", async (ev) => {
      const tr = ev.target.closest("tr.note");
      if (!tr) return;
      if (ev.target.closest(".ajouter-tva")) { ajouterLigneTva(tr.querySelector(".tva-lignes"), null); marquerModifiee(tr); }
      else if (ev.target.closest(".retirer-tva")) { ev.target.closest(".tva-ligne").remove(); marquerModifiee(tr); }
      else if (ev.target.closest(".enregistrer")) await enregistrer(tr, false);
      else if (ev.target.closest(".valider")) await enregistrer(tr, true);
      else if (ev.target.closest(".relancer")) {
        if (tr.classList.contains("modifiee") && !confirm("Relire le justificatif remplacera vos corrections non enregistrées. Continuer ?")) return;
        try {
          const r = await api("api/notes/" + tr.dataset.id + "/relancer", { corps: {} });
          tr.classList.remove("modifiee");
          if (r.tache) suivre(r.tache);
          await rafraichir();
        } catch (e) { alert(e.message); }
      } else if (ev.target.closest(".supprimer")) {
        if (!confirm("Supprimer cette note et son justificatif ?")) return;
        try { await api("api/notes/" + tr.dataset.id, { method: "DELETE" }); await rafraichir(); } catch (e) { alert(e.message); }
      }
    });
  }

  function afficher(notes) {
    const groupes = $("groupes");
    // Une ligne en cours de correction survit au rafraîchissement déclenché par une autre lecture.
    const enCours = new Map([...groupes.querySelectorAll("tr.note.modifiee")].map((tr) => [tr.dataset.id, tr]));
    groupes.replaceChildren();
    $("vide").hidden = notes.length > 0;
    const parUtilisateur = new Map();
    for (const n of notes) {
      if (!parUtilisateur.has(n.utilisateur.sub)) parUtilisateur.set(n.utilisateur.sub, []);
      parUtilisateur.get(n.utilisateur.sub).push(n);
    }
    let validees = 0;
    for (const lot of parUtilisateur.values()) {
      const frag = $("modele-groupe").content.cloneNode(true);
      const u = lot[0].utilisateur;
      frag.querySelector(".groupe-nom").textContent = u.nom || u.email || u.sub;
      frag.querySelector(".groupe-email").textContent = u.email || "";
      const ok = lot.filter((n) => n.statut === "validee");
      validees += ok.length;
      const total = ok.reduce((s, n) => s + (n.total_ttc ?? 0), 0);
      frag.querySelector(".groupe-total").textContent = lot.length + " note(s), " + ok.length + " validée(s) — " + montantTexte(total) + " TTC validés";
      const tbody = frag.querySelector("tbody");
      for (const n of lot) tbody.appendChild(enCours.get(String(n.id)) || construireLigne(n));
      groupes.appendChild(frag);
    }
    $("resume").textContent = notes.length ? notes.length + " note(s), dont " + validees + " validée(s)" : "";
  }

  function parametres() {
    const p = new URLSearchParams();
    if ($("filtre-mois").value) p.set("mois", $("filtre-mois").value);
    if (etat.toutVoir && $("filtre-utilisateur").value) p.set("utilisateur", $("filtre-utilisateur").value);
    return p.toString();
  }

  async function chargerMois() {
    const select = $("filtre-mois");
    const avant = select.value;
    const { mois } = await api("api/mois");
    select.replaceChildren(new Option("Tous les mois", ""));
    for (const m of mois) select.add(new Option(libelleMois(m.mois) + " (" + m.n + ")", m.mois));
    const courant = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");
    select.value = [...select.options].some((o) => o.value === avant) ? avant : (mois.some((m) => m.mois === courant) ? courant : "");
  }

  function majUtilisateurs(notes) {
    if (!etat.toutVoir) return;
    const select = $("filtre-utilisateur");
    const connus = new Map([...select.options].filter((o) => o.value).map((o) => [o.value, o.textContent]));
    for (const n of notes) connus.set(n.utilisateur.sub, n.utilisateur.nom || n.utilisateur.email || n.utilisateur.sub);
    const avant = select.value;
    select.replaceChildren(new Option("Tous", ""));
    for (const [sub, nom] of connus) select.add(new Option(nom, sub));
    select.value = avant;
  }

  let rafraichissement = null;
  function rafraichir() {
    if (!rafraichissement) {
      rafraichissement = (async () => {
        try {
          await chargerMois();
          const q = parametres();
          const { notes } = await api("api/notes" + (q ? "?" + q : ""));
          majUtilisateurs(notes);
          afficher(notes);
          $("export").href = "api/export.csv" + (q ? "?" + q : "");
        } catch (e) {
          $("resume").textContent = e.message;
        } finally {
          rafraichissement = null;
        }
      })();
    }
    return rafraichissement;
  }

  async function demarrer() {
    try {
      const moi = await api("api/moi");
      etat.moi = moi.utilisateur;
      etat.toutVoir = moi.toutVoir;
      if (Array.isArray(moi.categories) && moi.categories.length) etat.categories = moi.categories;
      $("moi").textContent = moi.utilisateur.full_name || moi.utilisateur.email || "";
      $("bloc-utilisateur").hidden = !moi.toutVoir;
    } catch (e) {
      $("resume").textContent = e.message;
    }
    $("fichiers").addEventListener("change", (ev) => { const f = [...ev.target.files]; ev.target.value = ""; envoyer(f); });
    const depot = $("depot");
    depot.addEventListener("dragover", (ev) => { ev.preventDefault(); depot.classList.add("survol"); });
    depot.addEventListener("dragleave", () => depot.classList.remove("survol"));
    depot.addEventListener("drop", (ev) => { ev.preventDefault(); depot.classList.remove("survol"); envoyer([...ev.dataTransfer.files]); });
    $("filtre-mois").addEventListener("change", rafraichir);
    $("filtre-utilisateur").addEventListener("change", rafraichir);
    brancherTableau();
    await rafraichir();
  }

  demarrer();
})();
