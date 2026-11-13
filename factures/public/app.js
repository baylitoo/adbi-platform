"use strict";

const $ = (id) => document.getElementById(id);
const STATUTS = { a_valider: "À valider", validee: "Validée", payee: "Payée" };
const NIVEAUX = { ok: "OK", attention: "À vérifier", erreur: "Écart", bloquant: "Bloquant", indisponible: "Indisponible" };
const EVENEMENTS = { depot: "Dépôt", extraction: "Extraction", modification: "Corrections", statut: "Statut", confirmation_iban: "Changement d'IBAN confirmé" };
const CHAMPS = ["fournisseur", "siren", "siret", "tva_intracom", "numero", "date_facture", "date_echeance", "devise", "iban", "bic", "total_ht", "total_tva", "total_ttc"];
const CHAMPS_LIGNE = ["designation", "quantite", "pu_ht", "taux_tva", "total_ht"];

const etat = { factures: [], courante: null, taches: new Map(), sondage: null };

function el(balise, { classe, texte, attrs } = {}, enfants = []) {
  const n = document.createElement(balise);
  if (classe) n.className = classe;
  if (texte !== undefined && texte !== null) n.textContent = String(texte);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  for (const e of enfants) if (e) n.appendChild(e);
  return n;
}

function euros(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" }) : "—";
}

function dateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? m[3] + "/" + m[2] + "/" + m[1] : "—";
}

function horodatage(v) {
  return new Date(v).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function message(texte, genre = "") {
  const m = $("message");
  m.textContent = texte || "";
  m.className = "bandeau" + (genre ? " " + genre : "");
  m.hidden = !texte;
}

async function api(chemin, options = {}) {
  const init = { ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) } };
  if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
  const r = await fetch(chemin, init);
  if (r.status === 401) {
    window.location.reload();
    throw new Error("Session expirée.");
  }
  const corps = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(corps.error || corps.erreur || "Erreur " + r.status);
    e.corps = corps;
    throw e;
  }
  return corps;
}

function statut(s) {
  return el("span", { classe: "statut statut-" + s, texte: STATUTS[s] || s });
}

function pastille(niveau, texte) {
  return el("span", { classe: "pastille niveau-" + niveau, texte });
}

// ---------- Navigation ----------
function afficherVue(nom) {
  for (const v of ["factures", "detail", "echeances", "journal"]) $("vue-" + v).hidden = v !== nom;
  for (const o of document.querySelectorAll(".onglet")) o.classList.toggle("actif", o.dataset.vue === nom || (nom === "detail" && o.dataset.vue === "factures"));
  if (nom !== "detail") arreterSondage();
  if (nom === "factures") chargerListe();
  if (nom === "echeances") chargerEcheances();
}

for (const o of document.querySelectorAll(".onglet")) o.addEventListener("click", () => afficherVue(o.dataset.vue));
$("retour").addEventListener("click", () => afficherVue("factures"));

// ---------- Liste ----------
function resumeControles(f) {
  const cellule = el("td");
  if (f.extraction.etat === "en_cours") cellule.appendChild(pastille("attention", "Extraction…"));
  else if (f.extraction.etat === "echec") cellule.appendChild(pastille("erreur", "Extraction en échec"));
  if (f.resume) {
    if (f.resume.fraude) cellule.appendChild(pastille("bloquant", "ALERTE IBAN"));
    else if (f.resume.bloquants) cellule.appendChild(pastille("bloquant", f.resume.bloquants + " bloquant(s)"));
    if (f.resume.erreurs) cellule.appendChild(pastille("erreur", f.resume.erreurs + " écart(s)"));
    if (!f.resume.bloquants && !f.resume.erreurs) cellule.appendChild(pastille("ok", "Contrôles OK"));
  }
  return cellule;
}

function afficherListe() {
  const filtre = $("filtre-statut").value;
  const corps = $("liste");
  corps.replaceChildren();
  const factures = etat.factures.filter((f) => !filtre || f.statut === filtre);
  for (const f of factures) {
    const d = f.donnees || {};
    const tr = el("tr", { classe: "cliquable" }, [
      el("td", { texte: f.id }),
      el("td", { texte: d.fournisseur || f.fichier.nom }),
      el("td", { texte: d.numero || "—" }),
      el("td", { texte: dateFr(d.date_facture) }),
      el("td", { texte: dateFr(d.date_echeance) }),
      el("td", { classe: "nombre", texte: euros(d.total_ttc) }),
      el("td", {}, [statut(f.statut)]),
      resumeControles(f),
    ]);
    tr.addEventListener("click", () => ouvrir(f.id));
    corps.appendChild(tr);
  }
  $("liste-vide").hidden = factures.length > 0;
}

async function chargerListe() {
  try {
    etat.factures = (await api("/api/factures")).factures;
    afficherListe();
    if (etat.factures.some((f) => f.extraction.etat === "en_cours") && !$("vue-factures").hidden) {
      clearTimeout(etat.listeMinuteur);
      etat.listeMinuteur = setTimeout(chargerListe, 4000);
    }
  } catch (e) { message(e.message, "erreur"); }
}

$("filtre-statut").addEventListener("change", afficherListe);

// ---------- Dépôt ----------
function lireBase64(fichier) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result).split(",")[1] || "");
    lecteur.onerror = () => reject(new Error("Lecture du fichier impossible."));
    lecteur.readAsDataURL(fichier);
  });
}

async function deposer(fichiers) {
  let deposes = 0;
  for (const fichier of fichiers) {
    try {
      message("Envoi de « " + fichier.name + " »…");
      const r = await api("/api/factures", { method: "POST", body: { nom: fichier.name, mimeType: fichier.type, dataBase64: await lireBase64(fichier) } });
      if (r.tache) etat.taches.set(r.id, r.tache);
      deposes++;
      if (r.memeFichier && r.memeFichier.length) message("« " + fichier.name + " » : fichier identique déjà déposé (facture n° " + r.memeFichier.join(", ") + ").", "attention");
    } catch (e) {
      message("« " + fichier.name + " » : " + e.message, "erreur");
    }
  }
  if (deposes && $("message").className === "bandeau") message(deposes + " facture(s) déposée(s) : extraction en cours.");
  chargerListe();
}

$("fichiers").addEventListener("change", (ev) => { deposer([...ev.target.files]); ev.target.value = ""; });
const depot = $("depot");
depot.addEventListener("dragover", (ev) => { ev.preventDefault(); depot.classList.add("survol"); });
depot.addEventListener("dragleave", () => depot.classList.remove("survol"));
depot.addEventListener("drop", (ev) => { ev.preventDefault(); depot.classList.remove("survol"); deposer([...ev.dataTransfer.files]); });

// ---------- Détail ----------
function arreterSondage() {
  clearTimeout(etat.sondage);
  etat.sondage = null;
}

async function texteExtraction(f) {
  if (f.extraction.etat === "echec") return { texte: "Extraction en échec : " + (f.extraction.erreur || "erreur inconnue") + " Saisissez les champs ou relancez l'extraction.", genre: "erreur" };
  if (f.extraction.etat !== "en_cours") {
    const e = f.extraction;
    const morceaux = ["Lu par la voie " + (e.voie === "agent" ? "image (scan)" : "texte")];
    if (e.modele) morceaux.push("modèle « " + e.modele.libelle + " »");
    let texte = morceaux.join(", ") + ". Les montants lus sont recoupés ci-contre : vérifiez-les sur le document.";
    if (e.avertissements && e.avertissements.length) texte += " " + e.avertissements.join(" ");
    return { texte, genre: "" };
  }
  const tache = etat.taches.get(f.id);
  if (tache) {
    try {
      const vue = await api("/api/taches/" + encodeURIComponent(tache));
      if (vue.etat === "en_cours" && vue.etape === "en_attente") return { texte: "Extraction en file d'attente : position " + vue.position + ".", genre: "attention" };
    } catch (e) { etat.taches.delete(f.id); }
  }
  return { texte: "Extraction en cours…", genre: "attention" };
}

function remplirFormulaire(d, modifiable) {
  const form = $("formulaire");
  for (const c of CHAMPS) {
    const champ = form.elements[c];
    const v = d[c];
    champ.value = v === null || v === undefined ? "" : String(v);
    champ.disabled = !modifiable;
  }
  const corps = $("lignes");
  corps.replaceChildren();
  for (const l of d.lignes || []) ajouterLigne(l, modifiable);
  $("ajouter-ligne").hidden = !modifiable;
}

function ajouterLigne(l = {}, modifiable = true) {
  const tr = el("tr");
  for (const c of CHAMPS_LIGNE) {
    const input = el("input", { attrs: { "data-champ": c, "aria-label": c } });
    if (c !== "designation") input.setAttribute("inputmode", "decimal");
    input.value = l[c] === null || l[c] === undefined ? "" : String(l[c]);
    input.disabled = !modifiable;
    tr.appendChild(el("td", { classe: c === "designation" ? "" : "nombre" }, [input]));
  }
  const suppr = el("button", { classe: "bouton secondaire icone", texte: "✕", attrs: { type: "button", "aria-label": "Supprimer la ligne" } });
  suppr.hidden = !modifiable;
  suppr.addEventListener("click", () => tr.remove());
  tr.appendChild(el("td", {}, [suppr]));
  $("lignes").appendChild(tr);
}

$("ajouter-ligne").addEventListener("click", () => ajouterLigne());

function lireFormulaire() {
  const form = $("formulaire");
  const d = {};
  for (const c of CHAMPS) d[c] = form.elements[c].value.trim();
  d.lignes = [...$("lignes").querySelectorAll("tr")].map((tr) => {
    const l = {};
    for (const input of tr.querySelectorAll("input")) l[input.dataset.champ] = input.value.trim();
    return l;
  });
  return d;
}

function afficherControles(controles) {
  const liste = $("controles");
  liste.replaceChildren();
  let confirmable = false;
  for (const c of controles) {
    if (c.confirmable) confirmable = true;
    liste.appendChild(el("li", { classe: "controle niveau-" + c.niveau }, [
      el("div", {}, [el("div", { classe: "controle-titre", texte: c.titre }), pastille(c.niveau, NIVEAUX[c.niveau] || c.niveau)]),
      el("div", { classe: "controle-message", texte: c.message }),
    ]));
  }
  $("confirmation-iban").hidden = !confirmable;
  $("case-iban").checked = false;
  $("confirmer-iban").disabled = true;
  const ecarts = new Set(controles.filter((c) => ["erreur", "bloquant"].includes(c.niveau)).map((c) => c.code));
  const form = $("formulaire");
  form.elements.total_ht.classList.toggle("ecart", ecarts.has("lignes") || ecarts.has("equilibre"));
  form.elements.total_tva.classList.toggle("ecart", ecarts.has("equilibre"));
  form.elements.total_ttc.classList.toggle("ecart", ecarts.has("equilibre"));
  form.elements.iban.classList.toggle("ecart", ecarts.has("fraude_iban") || ecarts.has("iban_bic"));
  form.elements.siren.classList.toggle("ecart", ecarts.has("siren_siret") || ecarts.has("doublon"));
  form.elements.numero.classList.toggle("ecart", ecarts.has("doublon"));
}

function afficherHistorique(evenements) {
  const liste = $("historique");
  liste.replaceChildren();
  for (const e of evenements.slice().reverse()) {
    let quoi = EVENEMENTS[e.type] || e.type;
    if (e.type === "statut") quoi += " : " + (STATUTS[e.de] || e.de) + " → " + (STATUTS[e.vers] || e.vers);
    else if (e.type === "extraction") quoi += " : " + e.vers;
    else if (e.type === "modification" && e.details && e.details.champs) quoi += " : " + e.details.champs.join(", ");
    else if (e.type === "confirmation_iban") quoi += " (" + e.details.ibanReference + " → " + e.details.iban + ")";
    liste.appendChild(el("li", {}, [el("strong", { texte: horodatage(e.le) }), document.createTextNode(" — " + quoi + " — " + (e.email || e.sub))]));
  }
}

async function ouvrir(id, { garderApercu = false } = {}) {
  try {
    const { facture: f, controles, bloquants, historique } = await api("/api/factures/" + id);
    etat.courante = f;
    afficherVue("detail");
    $("detail-titre").textContent = "Facture n° " + f.id + (f.donnees.fournisseur ? " — " + f.donnees.fournisseur : "");
    const s = $("detail-statut");
    s.textContent = STATUTS[f.statut];
    s.className = "statut statut-" + f.statut;
    if (!garderApercu) {
      const pdf = f.fichier.mime === "application/pdf";
      $("apercu-pdf").hidden = !pdf;
      $("apercu-image").hidden = pdf;
      const src = "/api/factures/" + f.id + "/fichier";
      if (pdf) $("apercu-pdf").src = src; else $("apercu-image").src = src;
    }
    const modifiable = f.statut === "a_valider" && f.extraction.etat !== "en_cours";
    remplirFormulaire(f.donnees || {}, modifiable);
    afficherControles(f.extraction.etat === "en_cours" ? [] : controles);
    afficherHistorique(historique);
    const bandeau = await texteExtraction(f);
    const b = $("detail-extraction");
    b.textContent = bandeau.texte;
    b.className = "bandeau" + (bandeau.genre ? " " + bandeau.genre : "");
    b.hidden = false;
    $("enregistrer").hidden = !modifiable;
    $("reverifier").hidden = !modifiable;
    $("relancer").hidden = f.statut !== "a_valider" || f.extraction.etat === "en_cours";
    $("valider").hidden = f.statut !== "a_valider";
    $("valider").disabled = !modifiable || bloquants.length > 0;
    $("valider").title = bloquants.length ? "Validation bloquée : " + controles.filter((c) => c.niveau === "bloquant").map((c) => c.titre).join(", ") : "";
    $("payer").hidden = f.statut !== "validee";
    arreterSondage();
    if (f.extraction.etat === "en_cours") etat.sondage = setTimeout(() => ouvrir(f.id, { garderApercu: true }), 3000);
  } catch (e) { message(e.message, "erreur"); }
}

async function action(promesse, succes) {
  try {
    await promesse;
    message(succes);
    await ouvrir(etat.courante.id, { garderApercu: true });
  } catch (e) { message(e.message, "erreur"); }
}

$("formulaire").addEventListener("submit", (ev) => {
  ev.preventDefault();
  action(api("/api/factures/" + etat.courante.id, { method: "PUT", body: { donnees: lireFormulaire() } }), "Corrections enregistrées.");
});
$("relancer").addEventListener("click", async () => {
  try {
    const r = await api("/api/factures/" + etat.courante.id + "/extraire", { method: "POST", body: {} });
    if (r.tache) etat.taches.set(r.id, r.tache);
    message("Extraction relancée.");
    ouvrir(r.id, { garderApercu: true });
  } catch (e) { message(e.message, "erreur"); }
});
$("reverifier").addEventListener("click", () => action(api("/api/factures/" + etat.courante.id + "/verifier-societe", { method: "POST", body: {} }), "Société revérifiée."));
$("valider").addEventListener("click", () => action(api("/api/factures/" + etat.courante.id + "/statut", { method: "POST", body: { statut: "validee" } }), "Facture validée."));
$("payer").addEventListener("click", () => action(api("/api/factures/" + etat.courante.id + "/statut", { method: "POST", body: { statut: "payee" } }), "Facture marquée payée."));
$("case-iban").addEventListener("change", (ev) => { $("confirmer-iban").disabled = !ev.target.checked; });
$("confirmer-iban").addEventListener("click", () => action(api("/api/factures/" + etat.courante.id + "/confirmer-iban", { method: "POST", body: { confirme: true } }), "Changement d'IBAN confirmé et journalisé."));

// ---------- Échéances ----------
function remplirEcheances(idCorps, idVide, factures) {
  const corps = $(idCorps);
  corps.replaceChildren();
  for (const f of factures) {
    const tr = el("tr", { classe: "cliquable" }, [
      el("td", { texte: f.donnees.fournisseur || f.fichier.nom }),
      el("td", { texte: f.donnees.numero || "—" }),
      el("td", { texte: dateFr(f.donnees.date_echeance) }),
      el("td", { classe: "nombre", texte: euros(f.donnees.total_ttc) }),
      el("td", {}, [statut(f.statut)]),
    ]);
    tr.addEventListener("click", () => ouvrir(f.id));
    corps.appendChild(tr);
  }
  $(idVide).hidden = factures.length > 0;
}

async function chargerEcheances() {
  try {
    const r = await api("/api/echeances");
    remplirEcheances("en-retard", "en-retard-vide", r.enRetard);
    remplirEcheances("sous-7", "sous-7-vide", r.sousSeptJours);
  } catch (e) { message(e.message, "erreur"); }
}

// ---------- Journal ----------
$("form-journal").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(ev.target)) if (String(v).trim()) params.set(k, String(v).trim());
  window.location.href = "/api/journal.csv?" + params.toString();
});

(async function demarrer() {
  try {
    const moi = await api("/api/moi");
    $("moi").textContent = moi.email || moi.nom || moi.sub;
    $("compte-charge").value = moi.compteCharge;
  } catch (e) { message(e.message, "erreur"); }
  chargerListe();
})();
