/* ADBI - Générateur de contrats - logique frontend (vanilla JS, aucun build).
   Miroir de lib/render.js pour l'aperçu live ; les exports (PDF/Word/ZIP)
   sont produits côté serveur pour garantir un rendu identique. */

"use strict";

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */
const state = {
  type: "sous-traitance",
  titre: "",
  stub: false,
  blocks: [],
  fields: [],
  options: [],
  checklistDef: [],
  values: {},      // { cle: valeur }
  optionState: {}, // { optKey: bool }
  checkState: {},  // { itemId: bool }
  docState: {},    // { itemId: resultatAnalyseIA }
  dateState: {},   // { itemId: dateDelivranceISO } (Kbis / URSSAF)
  ref: { clients: [], managers: [], signataires: [] }, // référentiels (clients/valideurs/lieux, managers, signataires)
  activeStep: 0,   // étape active du formulaire (assistant par onglets)
  editing: null,   // { id, numero } : contrat de l'historique ouvert en modification
  avenantParent: null, // infos du contrat initial (récap informatif de l'avenant + signataires)
};

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);

// Profils Business Manager ADBI (sélection rapide dans le groupe Suivi).
const BM_PROFILES = [
  { nom: "M. Amine OUKLI", email: "aoukli@adbi.fr", tel: "06 69 15 97 25" },
  { nom: "Mme Kahina MAKHLOUFI", email: "kmakhloufi@adbi.fr", tel: "06 69 15 97 51" },
  { nom: "Mme Sonia BOULABAS", email: "sboulabas@adbi.fr", tel: "+33 (0)6 60 70 96 76" },
];
const PLACEHOLDER = "\u2026\u2026\u2026\u2026"; // ……… (champ non renseigné)

// Icônes SVG modernes (trait fin, couleur héritée) — remplacent les emojis
// dans l'historique, les badges et les menus. Usage : ico("immeuble").
const ICONES = {
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  avenant: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  immeuble: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 21v-4h6v4"/><path d="M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01M8 15h.01M16 15h.01"/>',
  loupe: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  cadenas: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  cadenasOuvert: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  plume: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  horloge: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  coche: '<polyline points="20 6 9 17 4 12"/>',
  dossier: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  corbeille: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  certificat: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13 17 22l-5-3-5 3 1.5-9"/>',
  courrier: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/>',
};
function ico(nom, taille) {
  return '<svg class="ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
    (taille ? ' style="width:' + taille + 'px;height:' + taille + 'px"' : "") + ">" + (ICONES[nom] || "") + "</svg>";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Dates : le calendrier (input type=date) travaille en ISO aaaa-mm-jj,
   mais le contrat doit afficher une date française « 1 juin 2026 ». */
const FR_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function frDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return iso || "";
  return parseInt(m[3], 10) + " " + FR_MONTHS[parseInt(m[2], 10) - 1] + " " + m[1];
}

// Reconvertit une valeur stockée (ISO, jj/mm/aaaa ou « 1 juin 2026 ») en ISO pour le calendrier.
function isoFromAny(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  m = /^(\d{1,2})\s+([^\s]+)\s+(\d{4})$/.exec(s);
  if (m) {
    const i = FR_MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (i >= 0) return m[3] + "-" + String(i + 1).padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }
  return "";
}

// Remplit les {{cle}} ; vide -> placeholder. Miroir de lib/render.js#fill.
function fill(text, values) {
  if (text == null) return "";
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = values[k];
    if (v === undefined || v === null || v === "") return /Clause$/.test(k) ? "" : PLACEHOLDER;
    return String(v);
  });
}

// Comme fill(), mais met les valeurs des variables en gras. Miroir de lib/render.js#fillBold.
function fillBold(text, values) {
  if (text == null) return "";
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = values[k];
    if (v === undefined || v === null || v === "") return /Clause$/.test(k) ? "" : PLACEHOLDER;
    return "**" + String(v) + "**";
  });
}

// Découpe **gras** en HTML échappé. Miroir de lib/render.js#runs.
function runsHtml(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith("**") && p.endsWith("**")) out += "<strong>" + escapeHtml(p.slice(2, -2)) + "</strong>";
    else out += escapeHtml(p);
  }
  return out;
}

// Filtre les blocs selon les options actives. Miroir de lib/render.js#activeBlocks.
function activeBlocks(blocks, options) {
  return blocks.filter((b) => !b.opt || options[b.opt]);
}

function setStatus(msg, kind) {
  const el = $("#status");
  el.textContent = msg || "";
  el.style.color = kind === "ok" ? "var(--ok)" : kind === "err" ? "var(--accent)" : "var(--muted)";
}

/* ------------------------------------------------------------------ */
/* Appels API                                                          */
/* ------------------------------------------------------------------ */
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function payload() {
  return { type: state.type, values: state.values, options: state.optionState, checklist: state.checkState, docs: state.docState, dates: state.dateState };
}

// Verifie les champs obligatoires avant un export. Surligne les manquants,
// place le focus sur le premier, et renvoie true si tout est rempli.
function validateRequired() {
  const missing = state.fields.filter(
    (f) => f.required && !String(state.values[f.key] || "").trim()
  );
  document.querySelectorAll(".field input.invalid, .field textarea.invalid")
    .forEach((el) => el.classList.remove("invalid"));
  if (!missing.length) return true;
  missing.forEach((f) => {
    const el = document.getElementById("f_" + f.key);
    if (el) el.classList.add("invalid");
  });
  const first = document.getElementById("f_" + missing[0].key);
  if (first) { first.focus(); first.scrollIntoView({ block: "center", behavior: "smooth" }); }
  setStatus("Champs obligatoires manquants : " + missing.map((f) => f.label).join(", "), "err");
  return false;
}

async function exportBlob(endpoint, fallbackName) {
  setStatus("Génération en cours\u2026");
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload()),
  });
  if (!r.ok) {
    let msg = "Erreur " + r.status;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  const cd = r.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="?([^"]+)"?/);
  const name = m ? m[1] : fallbackName;
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return name;
}

/* ------------------------------------------------------------------ */
/* Construction du formulaire                                          */
/* ------------------------------------------------------------------ */
function buildTypeButtons(types) {
  const box = $("#typeButtons");
  box.innerHTML = "";
  types.forEach((t) => {
    const b = document.createElement("button");
    b.className = "type-btn" + (t.id === state.type ? " active" : "");
    b.textContent = t.titre.length > 34 ? t.id.toUpperCase() : t.titre;
    b.title = t.titre + (t.stub ? " (modèle à venir)" : "");
    b.dataset.type = t.id;
    b.addEventListener("click", () => loadType(t.id));
    box.appendChild(b);
  });
}

/* Icônes minimalistes (trait fin) associées à chaque étape. */
const STEP_ICONS = {
  "Contrat": '<path d="M6 2h8l4 4v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v4h4"/><path d="M8 13h8M8 17h6"/>',
  "ADBI (Client)": '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16"/><path d="M14 9h5a1 1 0 0 1 1 1v11"/><path d="M8 8h2M8 12h2M8 16h2"/><path d="M3 21h18"/>',
  "Sous-Traitant": '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>',
  "Intervenant": '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
  "Mission": '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  "Conditions financières": '<circle cx="12" cy="12" r="9"/><path d="M15.5 9.5a4 4 0 1 0 0 5"/><path d="M7 11h5M7 13.5h5"/>',
  "Suivi": '<path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/>',
  "Clauses": '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
};
function stepIco(name) {
  const p = STEP_ICONS[name] || STEP_ICONS["Contrat"];
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";
}

/* Construit un champ (libellé + info + saisie) — mutualisé par les étapes. */
function buildFieldEl(f) {
  const wrap = document.createElement("div");
  wrap.className = "field" + (f.full || f.textarea ? " full" : "");
  const label = document.createElement("label");
  label.textContent = f.label;
  if (f.required) {
    const req = document.createElement("span");
    req.className = "req";
    req.textContent = " *";
    req.title = "Champ obligatoire";
    label.appendChild(req);
  }
  // Icône d'information sur le côté du libellé (exemple au survol), au lieu d'un texte dans le champ.
  const hintText = [f.placeholder, f.help].filter(Boolean).join(" — ");
  if (hintText) {
    const info = document.createElement("span");
    info.className = "info-i";
    info.textContent = "i";
    info.title = hintText;
    label.appendChild(info);
  }
  label.htmlFor = "f_" + f.key;

  let input;
  const isDate = f.type === "date";
  if (f.type === "select") {
    input = document.createElement("select");
    (f.options || []).forEach((o) => {
      const op = document.createElement("option");
      op.value = o.value; op.textContent = o.label;
      input.appendChild(op);
    });
  } else if (f.textarea || f.type === "textarea") {
    input = document.createElement("textarea");
    input.rows = 2;
  } else {
    input = document.createElement("input");
    input.type = isDate ? "date" : f.type === "number" ? "number" : "text";
  }
  input.id = "f_" + f.key;
  input.dataset.key = f.key;
  input.value = isDate ? isoFromAny(state.values[f.key])
    : (state.values[f.key] != null ? state.values[f.key] : (f.default || ""));
  const onChange = () => {
    state.values[f.key] = isDate ? (input.value ? frDate(input.value) : "") : input.value;
    if (String(input.value).trim()) input.classList.remove("invalid");
    renderPreview();
    updateWizardProgress();
    if (f.key === "clientFinal") onClientChange();
  };
  input.addEventListener("input", onChange);
  if (f.type === "select") input.addEventListener("change", onChange);
  wrap.appendChild(label);
  wrap.appendChild(input);
  if (REF_FIELDS[f.key]) attachRefAutocomplete(input, wrap, f.key);
  return wrap;
}

/* Formulaire en ASSISTANT PAR ÉTAPES (onglets) : au lieu d'une longue page,
   chaque groupe devient un onglet ; une barre 0→100 % avance au remplissage. */
function buildForm() {
  const host = $("#formGroups");
  host.innerHTML = "";

  // Regroupe par "group" en conservant l'ordre d'apparition.
  const groups = new Map();
  state.fields.forEach((f) => {
    const g = f.group || "Divers";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  });
  const names = [...groups.keys()];
  if (!names.length) return;
  if (state.activeStep == null || state.activeStep >= names.length) state.activeStep = 0;

  const wiz = document.createElement("div");
  wiz.className = "wizard";

  // Barre de progression 0 → 100 %
  const prog = document.createElement("div");
  prog.className = "wiz-progress";
  prog.innerHTML = '<div class="wiz-track"><i id="wizBar"></i></div><span class="wiz-pct" id="wizPct">0 %</span>';
  wiz.appendChild(prog);

  // Onglets (étapes) avec icône + coche de complétion
  const steps = document.createElement("div");
  steps.className = "wiz-steps";
  names.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wiz-step";
    btn.dataset.step = String(i);
    const ico = document.createElement("span"); ico.className = "wiz-ico"; ico.innerHTML = stepIco(name);
    const txt = document.createElement("span"); txt.className = "wiz-txt"; txt.textContent = (i + 1) + ". " + name;
    const chk = document.createElement("span"); chk.className = "wiz-chk"; chk.textContent = "✓";
    btn.append(ico, txt, chk);
    btn.addEventListener("click", () => setStep(i));
    steps.appendChild(btn);
  });
  wiz.appendChild(steps);

  // Corps : un panneau par étape (seul l'actif est visible)
  const body = document.createElement("div");
  body.className = "wiz-body";
  names.forEach((name, i) => {
    const panel = document.createElement("div");
    panel.className = "wiz-panel";
    panel.dataset.step = String(i);

    const ptitle = document.createElement("div");
    ptitle.className = "wiz-panel-title";
    const pico = document.createElement("span"); pico.className = "wiz-ico"; pico.innerHTML = stepIco(name);
    const ptxt = document.createElement("span"); ptxt.textContent = name;
    ptitle.append(pico, ptxt);
    panel.appendChild(ptitle);

    if (name === "Avenant") {
      panel.appendChild(buildContractRefBar());
      // Récap du contrat initial « à titre informatif » (cadre double, emojis) :
      // repris automatiquement, les champs restent modifiables si ça a changé.
      if (state.avenantParent) panel.appendChild(buildRecapAvenant());
    }
    if (name === "Sous-Traitant") {
      panel.appendChild(buildLookupBar(LOOKUP_PROFILES.soustraitant));
      panel.appendChild(buildSoustraitantProfiles());
    }
    if (name === "Client") panel.appendChild(buildLookupBar(LOOKUP_PROFILES.client));
    if (name === "Signataire") panel.appendChild(buildSignataireProfiles());
    if (name === "Suivi") panel.appendChild(buildBmProfiles());

    const grid = document.createElement("div");
    grid.className = "fields";
    groups.get(name).forEach((f) => grid.appendChild(buildFieldEl(f)));
    panel.appendChild(grid);
    body.appendChild(panel);
  });
  wiz.appendChild(body);

  // Navigation Précédent / Suivant
  const nav = document.createElement("div");
  nav.className = "wiz-nav";
  nav.innerHTML =
    '<button type="button" class="btn btn-ghost" id="wizPrev">‹ Précédent</button>' +
    '<span class="wiz-dots" id="wizDots"></span>' +
    '<button type="button" class="btn btn-primary" id="wizNext">Suivant ›</button>';
  wiz.appendChild(nav);

  host.appendChild(wiz);

  $("#wizPrev").addEventListener("click", () => setStep(state.activeStep - 1));
  $("#wizNext").addEventListener("click", () => setStep(state.activeStep + 1));

  setStep(state.activeStep);
  updateWizardProgress();
}

/* Affiche l'étape i (onglet + panneau), gère les boutons Précédent/Suivant. */
function setStep(i) {
  const steps = document.querySelectorAll("#formGroups .wiz-step");
  const panels = document.querySelectorAll("#formGroups .wiz-panel");
  if (!steps.length) return;
  i = Math.max(0, Math.min(i, steps.length - 1));
  state.activeStep = i;
  steps.forEach((s, k) => s.classList.toggle("active", k === i));
  panels.forEach((p, k) => p.classList.toggle("active", k === i));
  const prev = $("#wizPrev"), next = $("#wizNext"), dots = $("#wizDots");
  if (prev) prev.disabled = (i === 0);
  if (next) next.classList.toggle("hidden", i === steps.length - 1);
  if (dots) dots.textContent = "Étape " + (i + 1) + " / " + steps.length;
}

/* Recalcule la progression (0→100 %) et coche les étapes complétées. */
function updateWizardProgress() {
  if (!state.fields.length) return;
  let filled = 0;
  state.fields.forEach((f) => {
    const v = state.values[f.key];
    if (v != null && String(v).trim() !== "") filled++;
  });
  const pct = Math.round((filled / state.fields.length) * 100);
  const bar = $("#wizBar"), pctEl = $("#wizPct");
  if (bar) bar.style.width = pct + "%";
  if (pctEl) pctEl.textContent = pct + " %";

  // Complétion par étape : coche verte quand les champs requis (ou tous) sont remplis.
  const groups = new Map();
  state.fields.forEach((f) => {
    const g = f.group || "Divers";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  });
  const names = [...groups.keys()];
  document.querySelectorAll("#formGroups .wiz-step").forEach((s, k) => {
    const fs = groups.get(names[k]) || [];
    const req = fs.filter((f) => f.required);
    const check = req.length ? req : fs;
    const done = check.length > 0 && check.every((f) => {
      const v = state.values[f.key];
      return v != null && String(v).trim() !== "";
    });
    s.classList.toggle("done", done);
  });
}

function buildOptions() {
  const host = $("#optionsList");
  host.innerHTML = "";
  const panel = $("#optionsPanel");
  if (!state.options.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  state.options.forEach((op) => {
    const lab = document.createElement("label");
    lab.className = "opt";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!state.optionState[op.key];
    cb.addEventListener("change", () => {
      state.optionState[op.key] = cb.checked;
      renderPreview();
    });
    const span = document.createElement("span");
    span.textContent = op.label;
    lab.appendChild(cb);
    lab.appendChild(span);
    host.appendChild(lab);
  });
}

function buildChecklist() {
  const host = $("#checklist");
  host.innerHTML = "";
  const panel = $("#checklistPanel");
  if (!state.checklistDef.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  state.checklistDef.forEach((it) => {
    const item = document.createElement("div");
    item.className = "chk-item";
    const lab = document.createElement("label");
    lab.className = "chk";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!state.checkState[it.id];
    cb.addEventListener("change", () => {
      state.checkState[it.id] = cb.checked;
      updateCheckCount();
    });
    const body = document.createElement("div");
    const t = document.createElement("div");
    t.textContent = it.label;
    body.appendChild(t);
    const meta = [];
    if (it.art) meta.push(it.art);
    if (it.recurrent) meta.push(it.recurrent);
    if (meta.length) {
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = meta.join(" \u00B7 ");
      body.appendChild(m);
    }
    lab.appendChild(cb);
    lab.appendChild(body);
    item.appendChild(lab);

    // V\u00E9rification de validit\u00E9 (6 mois) \u00E0 partir d'une date saisie \u00E0 la main \u2014 Kbis / URSSAF.
    if (it.dateField) {
      const drow = document.createElement("div");
      drow.className = "chk-date";
      const status = document.createElement("div");
      status.className = "chk-doc-status";
      // OCR (Kbis / URSSAF) : lit automatiquement la date de délivrance via l'IA.
      const ufile = document.createElement("input");
      ufile.type = "file";
      ufile.accept = "image/*,application/pdf";
      ufile.style.display = "none";
      const ubtn = document.createElement("button");
      ubtn.type = "button";
      ubtn.className = "btn-up";
      ubtn.textContent = "📎 Analyser le document (OCR)";
      ubtn.title = "Analyse le document et remplit la date de délivrance";
      ubtn.addEventListener("click", () => ufile.click());
      ufile.addEventListener("change", () => { if (ufile.files[0]) analyzeChecklistDoc(it, ufile.files[0], status, ubtn); ufile.value = ""; });
      drow.appendChild(ubtn);
      drow.appendChild(ufile);
      item.appendChild(drow);
      item.appendChild(status);
      const saved = state.dateState[it.id];
      if (saved && typeof saved === "object") renderChecklistDocResult(status, saved);
    }

    host.appendChild(item);
  });
  updateCheckCount();
}

function isoOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}


// Analyse OCR d'une pièce (Kbis / URSSAF) : vérifie la société puis la validité (6 mois).
async function analyzeChecklistDoc(it, fileObj, statusEl, btn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Analyse…";
  statusEl.textContent = "🔎 Analyse du document…";
  statusEl.className = "chk-doc-status";
  try {
    const dataBase64 = await fileToBase64(fileObj);
    const r = await fetch("/api/document/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mimeType: fileObj.type || "application/octet-stream",
        dataBase64,
        items: [{ id: it.id, label: it.label }],
        expectedName: state.values.stNom || "",
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    const res = { issuedDate: d.issuedDate || "", companyName: d.companyName || "", nameMatches: d.nameMatches, fileName: fileObj.name };
    state.dateState[it.id] = res;
    renderChecklistDocResult(statusEl, res);
  } catch (e) {
    statusEl.textContent = "Erreur : " + e.message;
    statusEl.className = "chk-doc-status err";
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

// (1) vérifie que la société du document = sous-traitant saisi ; (2) validité 6 mois.
function renderChecklistDocResult(el, res) {
  const sousTraitant = state.values.stNom || "";
  if (res.nameMatches === false) {
    el.className = "chk-doc-status err";
    el.textContent = "⛔ Document au nom de « " + (res.companyName || "?") + " » — ce n'est PAS le sous-traitant saisi (« " + sousTraitant + " »)";
    return;
  }
  const societe = res.companyName ? "Société : " + res.companyName + (res.nameMatches === true ? " ✓" : "") + " — " : "";
  if (!res.issuedDate) {
    el.className = "chk-doc-status warn";
    el.textContent = "⚠️ " + societe + "date de délivrance non lue sur le document";
    return;
  }
  const dd = new Date(res.issuedDate);
  if (isNaN(dd)) { el.className = "chk-doc-status warn"; el.textContent = "⚠️ " + societe + "date illisible"; return; }
  const limit = new Date(dd); limit.setMonth(limit.getMonth() + 6);
  const days = Math.round((limit - new Date()) / 86400000);
  const dlv = "délivré le " + frDate(res.issuedDate);
  if (days < 0) {
    el.className = "chk-doc-status err";
    el.textContent = "⛔ " + societe + "PÉRIMÉ (plus de 6 mois) — " + dlv + ", à renouveler";
  } else if (days <= 30) {
    el.className = "chk-doc-status warn";
    el.textContent = "⚠️ " + societe + "bientôt périmé — " + dlv + ", valable jusqu'au " + frDate(isoOf(limit));
  } else {
    el.className = "chk-doc-status ok";
    el.textContent = "✅ " + societe + dlv + ", valable jusqu'au " + frDate(isoOf(limit));
  }
}

/* ------------------------------------------------------------------ */
/* Mail de demande de documents                                        */
/* ------------------------------------------------------------------ */
function recipientName() {
  const n = String(state.values.consultantNom || "").replace(/^\s*(M\.|Mr|Monsieur|Mme|Madame|Mlle)\s+/i, "").trim();
  return n || "X";
}

function buildMail() {
  const items = [
    "Fournir une copie \u00e0 jour du Kbis de la soci\u00e9t\u00e9.",
    "Fournir l'attestation de r\u00e9gularit\u00e9 fiscale.",
    "Fournir l'attestation de vigilance URSSAF.",
    "Communiquer un RIB.",
    "Communiquer les coordonn\u00e9es compl\u00e8tes pour le contrat (adresse, repr\u00e9sentant l\u00e9gal, etc.).",
    "Transmettre la pi\u00e8ce d'identit\u00e9 du consultant afin de cr\u00e9er ses acc\u00e8s.",
    "Pr\u00e9ciser toute information sp\u00e9cifique \u00e0 inclure dans le contrat (clauses particuli\u00e8res, confidentialit\u00e9, propri\u00e9t\u00e9 intellectuelle, etc.).",
  ];
  const L = [];
  L.push("Bonjour,");
  L.push("");
  L.push("Dans le cadre de la pr\u00e9paration du contrat, nous aurions besoin des documents suivants afin de finaliser la r\u00e9daction :");
  L.push("");
  items.forEach((i) => L.push("- " + i));
  L.push("");
  L.push("Dans l'attente de votre retour afin d'avancer rapidement sur la contractualisation.");
  L.push("");
  L.push("Cordialement,");
  if (state.values.bmNom) L.push(state.values.bmNom);
  if (state.values.bmEmail) L.push(state.values.bmEmail);
  if (state.values.bmTel) L.push(state.values.bmTel);
  return L.join("\n");
}

async function copyMail() {
  const ta = $("#mailText");
  const st = $("#mailStatus");
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch (e) {
    ta.select();
    try { document.execCommand("copy"); } catch (e2) {}
  }
  st.textContent = "\u2713 Mail copi\u00e9 dans le presse-papier";
  st.style.color = "var(--ok)";
}

/* ------------------------------------------------------------------ */
/* Module : analyse de pi\u00E8ces (OCR IA) + alertes                       */
/* ------------------------------------------------------------------ */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Lecture du fichier impossible."));
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(",") + 1)); };
    fr.readAsDataURL(file);
  });
}

// [Analyse OCR par IA retiree : verification des pieces en local via
//  /api/document/analyze (pdf-parse + tesseract.js) — voir analyzeChecklistDoc.]

/* ------------------------------------------------------------------ */
/* Code d'accès aux Paramètres                                         */
/* ------------------------------------------------------------------ */
// Le code (data/code-parametres.txt côté serveur) est vérifié par l'API puis
// gardé pour la session du navigateur ; il accompagne chaque action sensible
// dans l'en-tête x-code-parametres (le serveur re-vérifie systématiquement).
function codeParamActuel() {
  try { return sessionStorage.getItem("codeParametres") || ""; } catch (e) { return ""; }
}
function enteteCode() {
  return { "x-code-parametres": codeParamActuel() };
}
function ouvrirCodeModal() {
  $("#codeInput").value = "";
  $("#codeStatus").textContent = "";
  $("#codeModal").classList.remove("hidden");
  setTimeout(() => $("#codeInput").focus(), 50);
}
async function validerCodeParametres() {
  const st = $("#codeStatus");
  st.textContent = "Vérification…";
  st.className = "status";
  try {
    const r = await fetch("/api/parametres/verifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: $("#codeInput").value }),
    });
    if (!r.ok) throw new Error("Code invalide.");
    try { sessionStorage.setItem("codeParametres", $("#codeInput").value); } catch (e) {}
    $("#codeModal").classList.add("hidden");
    showView("parametres");
  } catch (e) {
    st.textContent = "🔴 " + e.message;
    st.className = "status err";
    $("#codeInput").select();
  }
}

// Dernier état des connecteurs (rempli par loadSettings) + bascule des zones.
let ETAT_CONNECTEURS = {};
function majEtatConnecteur() {
  const s = ETAT_CONNECTEURS;
  const actif = $("#setSignFournisseur").value;
  $("#zoneYousign").classList.toggle("hidden", actif !== "yousign");
  $("#zoneZoho").classList.toggle("hidden", actif !== "zoho");
  // Le bouton « Tester » de l'en-tête vise le connecteur affiché.
  const btn = document.querySelector('.set-test[data-provider="yousign"], .set-test[data-provider="zoho"]');
  if (btn) btn.dataset.provider = actif;
  const es = $("#setSignState");
  if (actif === "zoho") {
    es.textContent = s.zohoConfigure ? "Zoho Sign · " + (s.zohoRegion || "eu")
      : s.zohoIdentifiants ? "Zoho — échange le code pour finir" : "Zoho — identifiants manquants";
    es.className = "set-state " + (s.zohoConfigure ? "ok" : "off");
  } else {
    es.textContent = s.yousignConfigure ? "Yousign · " + (s.yousignMode || "sandbox") : "clé manquante — signature impossible";
    es.className = "set-state " + (s.yousignConfigure ? "ok" : "off");
  }
}

// Échange du code self-client Zoho → refresh token stocké côté serveur.
async function zohoEchangerCode() {
  const code = $("#setZohoCode").value.trim();
  const st = $("#setStatus");
  if (!code) { st.textContent = "Colle d'abord le code généré dans l'API console Zoho."; st.style.color = "var(--accent)"; return; }
  const btn = $("#btnZohoEchanger");
  btn.disabled = true;
  st.textContent = "Échange du code…"; st.style.color = "var(--muted)";
  try {
    const r = await fetch("/api/zoho/echanger-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...enteteCode() },
      body: JSON.stringify({ code }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.message || "Erreur " + r.status);
    $("#setZohoCode").value = "";
    st.textContent = "🟢 " + j.message; st.style.color = "var(--ok)";
    await loadSettings();
  } catch (e) {
    st.textContent = "🔴 " + e.message; st.style.color = "var(--accent)";
  }
  btn.disabled = false;
}

async function testConnection(provider, btn) {
  const map = { gouv: "#setGouvState", pappers: "#setPappersState", insee: "#setInseeState", yousign: "#setSignState", zoho: "#setSignState" };
  const el = $(map[provider]);
  if (!el) return;
  el.textContent = "test\u2026"; el.className = "set-state";
  if (btn) btn.disabled = true;
  try {
    const r = await getJSON("/api/test/" + provider);
    el.textContent = (r.ok ? "\uD83D\uDFE2 " : "\uD83D\uDD34 ") + r.message;
    el.className = "set-state " + (r.ok ? "ok" : "off");
  } catch (e) {
    el.textContent = "\uD83D\uDD34 " + e.message;
    el.className = "set-state off";
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateCheckCount() {
  const total = state.checklistDef.length;
  const done = state.checklistDef.filter((it) => state.checkState[it.id]).length;
  $("#checkCount").textContent = done + " / " + total;
}

/* ------------------------------------------------------------------ */
/* Module : recherche société (Pappers / INSEE)                        */
/* ------------------------------------------------------------------ */
// Sélecteur de profil Business Manager (remplit nom / email / téléphone).
function buildBmProfiles() {
  const bar = document.createElement("div");
  bar.className = "lookup bm-bar";
  const label = document.createElement("span");
  label.className = "bm-label";
  label.textContent = "Profil BM :";
  const sel = document.createElement("select");
  sel.className = "lookup-input";
  const managers = (state.ref.managers && state.ref.managers.length) ? state.ref.managers : BM_PROFILES;
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "— Choisir un Business Manager —";
  sel.appendChild(opt0);
  managers.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = p.nom;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const p = managers[sel.value];
    if (!p) return;
    setFieldValue("bmNom", p.nom);
    setFieldValue("bmEmail", p.email);
    setFieldValue("bmTel", p.tel);
    renderPreview();
  });
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "btn btn-ghost ref-manage";
  manage.textContent = "＋ Gérer";
  manage.title = "Gérer les managers et clients (référentiels)";
  manage.addEventListener("click", () => showView("referentiels"));
  bar.appendChild(label);
  bar.appendChild(sel);
  bar.appendChild(manage);
  return bar;
}

// Dropdown des signataires enregistrés (remplit nom + qualité) + bouton « Enregistrer ».
// Entreprises sous-traitantes réutilisables : sélecteur qui pré-remplit toute la
// fiche + bouton « ＋ » qui enregistre l'entreprise saisie au référentiel.
const CHAMPS_SOUSTRAITANT = [
  ["stNom", "nom"], ["stFormeJuridique", "formeJuridique"], ["stAdresse", "adresse"],
  ["stSiren", "siren"], ["stSiret", "siret"], ["stRepresentant", "representant"],
  ["stQualite", "qualite"], ["stEmail", "email"],
];
function buildSoustraitantProfiles() {
  const bar = document.createElement("div");
  bar.className = "lookup bm-bar";
  const label = document.createElement("span");
  label.className = "bm-label";
  label.textContent = "Entreprise :";
  const sel = document.createElement("select");
  sel.className = "lookup-input";
  const ents = state.ref.soustraitants || [];
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = ents.length ? "— Choisir une entreprise enregistrée —" : "— Aucune entreprise enregistrée —";
  sel.appendChild(opt0);
  ents.forEach((e, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = e.nom + (e.siren ? " (" + e.siren + ")" : "");
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const e = ents[sel.value];
    if (!e) return;
    CHAMPS_SOUSTRAITANT.forEach(([champ, cle]) => setFieldValue(champ, e[cle] || ""));
    renderPreview();
    setStatus("Fiche « " + e.nom + " » reprise du référentiel.", "ok");
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-ghost ref-manage";
  saveBtn.textContent = "＋ Enregistrer l’entreprise";
  saveBtn.title = "Ajouter ce sous-traitant au référentiel réutilisable";
  saveBtn.addEventListener("click", async () => {
    const nom = (state.values.stNom || "").trim();
    if (!nom) { setStatus("Renseigne d'abord la raison sociale du sous-traitant.", "err"); return; }
    const fiche = {};
    CHAMPS_SOUSTRAITANT.forEach(([champ, cle]) => { fiche[cle] = (state.values[champ] || "").trim(); });
    state.ref.soustraitants = state.ref.soustraitants || [];
    // Dédoublonnage : par SIREN si connu, sinon par nom — une fiche existante est mise à jour.
    const idx = state.ref.soustraitants.findIndex((e) =>
      (fiche.siren && e.siren === fiche.siren) || String(e.nom).toLowerCase() === nom.toLowerCase());
    if (idx >= 0) state.ref.soustraitants[idx] = fiche;
    else state.ref.soustraitants.push(fiche);
    await refSave();
    buildForm();
    setStatus(idx >= 0 ? "Fiche « " + nom + " » mise à jour au référentiel." : "Entreprise « " + nom + " » enregistrée au référentiel.", "ok");
  });
  bar.append(label, sel, saveBtn);
  return bar;
}

function buildSignataireProfiles() {
  const bar = document.createElement("div");
  bar.className = "lookup bm-bar";
  const label = document.createElement("span");
  label.className = "bm-label";
  label.textContent = "Signataire :";
  const sel = document.createElement("select");
  sel.className = "lookup-input";
  const sigs = state.ref.signataires || [];
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = sigs.length ? "— Choisir un signataire enregistré —" : "— Aucun signataire enregistré —";
  sel.appendChild(opt0);
  sigs.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = p.nom + (p.qualite ? " (" + p.qualite + ")" : "");
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const p = sigs[sel.value];
    if (!p) return;
    setFieldValue("stSignataireNom", p.nom);
    setFieldValue("stSignataireQualite", p.qualite || "");
    renderPreview();
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-ghost ref-manage";
  saveBtn.textContent = "＋ Enregistrer";
  saveBtn.title = "Ajouter ce signataire au référentiel réutilisable";
  saveBtn.addEventListener("click", async () => {
    const nom = (state.values.stSignataireNom || "").trim();
    if (!nom) { setStatus("Renseigne d'abord le nom du signataire.", "err"); return; }
    const qualite = (state.values.stSignataireQualite || "").trim();
    state.ref.signataires = state.ref.signataires || [];
    if (!state.ref.signataires.some((s) => String(s.nom).toLowerCase() === nom.toLowerCase())) {
      state.ref.signataires.push({ nom, qualite });
      await refSave();
      buildForm();
      setStatus("Signataire enregistré au référentiel.", "ok");
    } else { setStatus("Ce signataire est déjà enregistré.", "ok"); }
  });
  bar.appendChild(label);
  bar.appendChild(sel);
  bar.appendChild(saveBtn);
  return bar;
}

/* ------------------------------------------------------------------ */
/* Référentiels : clients (valideurs CRA + lieux), managers            */
/* ------------------------------------------------------------------ */
const REF_FIELDS = { clientFinal: 1, craValidePar: 1, lieuExecution: 1 };

function findRefClient(name) {
  const n = String(name || "").trim().toLowerCase();
  return (state.ref.clients || []).find((c) => String(c.nom).toLowerCase() === n);
}

function populateRefList(key) {
  const dl = document.getElementById("dl-" + key);
  if (!dl) return;
  let opts = [];
  if (key === "clientFinal") {
    opts = (state.ref.clients || []).map((c) => c.nom);
  } else {
    const field = key === "craValidePar" ? "craValidateurs" : "lieux";
    const client = findRefClient(state.values.clientFinal);
    opts = client ? (client[field] || []) : (state.ref.clients || []).flatMap((c) => c[field] || []);
  }
  dl.innerHTML = [...new Set(opts)].map((o) => '<option value="' + escapeHtml(o) + '"></option>').join("");
}

function refreshRefLists() {
  populateRefList("clientFinal");
  populateRefList("craValidePar");
  populateRefList("lieuExecution");
}

// Quand le client change : actualise les suggestions, et pré-remplit si une seule valeur connue.
function onClientChange() {
  refreshRefLists();
  const c = findRefClient(state.values.clientFinal);
  if (!c) return;
  if (!String(state.values.craValidePar || "").trim() && (c.craValidateurs || []).length === 1) setFieldValue("craValidePar", c.craValidateurs[0]);
  if (!String(state.values.lieuExecution || "").trim() && (c.lieux || []).length === 1) setFieldValue("lieuExecution", c.lieux[0]);
  renderPreview();
}

function attachRefAutocomplete(input, wrap, key) {
  const dlId = "dl-" + key;
  let dl = document.getElementById(dlId);
  if (!dl) { dl = document.createElement("datalist"); dl.id = dlId; document.body.appendChild(dl); }
  input.setAttribute("list", dlId);
  populateRefList(key);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ref-add";
  if (key === "clientFinal") {
    add.textContent = "＋ Ajouter";
    add.title = "Ajouter ce client au référentiel (SIREN et adresse repris automatiquement de l'annuaire gouv.fr)";
  } else {
    add.textContent = "＋ réf.";
    add.title = "Enregistrer cette valeur dans le référentiel";
  }
  add.addEventListener("click", () => saveRefEntry(key));
  wrap.appendChild(add);
}

async function persistRef() {
  const r = await fetch("/api/referentiels", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.ref),
  });
  if (r.status === 409) {
    // Quelqu'un d'autre a sauvegardé le référentiel depuis notre dernier
    // chargement : notre écriture est refusée (voir lib/referentiels.js,
    // issue #84) plutôt que d'écraser silencieusement son changement. On se
    // resynchronise sur l'état serveur ; la modification en cours ici est
    // perdue et doit être refaite par l'utilisateur après relecture.
    const body = await r.json().catch(() => ({}));
    if (body && body.referentiels) state.ref = body.referentiels;
    renderReferentiels();
    refreshRefLists();
    throw new Error((body && body.error) || "Référentiel modifié entre-temps — page resynchronisée, réessaie ton changement.");
  }
  if (!r.ok) throw new Error("HTTP " + r.status);
  state.ref = await r.json();
}

async function saveRefEntry(key) {
  const val = String(state.values[key] || "").trim();
  if (!val) { setStatus("Rien à enregistrer.", "err"); return; }
  try {
    if (key === "clientFinal") {
      if (findRefClient(val)) { setStatus("« " + val + " » est déjà dans le référentiel clients.", "ok"); return; }
      const c = { nom: val, craValidateurs: [], lieux: [] };
      // Enrichissement automatique via l'annuaire public gouv.fr (comme l'import
      // initial des clients) : SIREN + adresse du siège, proposée comme lieu.
      try {
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: val }),
        });
        const d = await r.json();
        const e = ((d && d.results) || [])[0];
        if (e && e.stSiren) {
          c.siren = e.stSiren;
          c.adresse = e.stAdresse || "";
          if (e.stAdresse) c.lieux.push(e.stAdresse);
        }
      } catch (e) { /* hors ligne ou introuvable : le client est ajouté sans enrichissement */ }
      state.ref.clients.push(c);
      await persistRef();
      refreshRefLists();
      setStatus("Client « " + val + " » ajouté au référentiel" +
        (c.siren ? " — SIREN " + c.siren + " et adresse du siège repris de l'annuaire gouv.fr." : "."), "ok");
      return;
    }
    {
      const clientName = String(state.values.clientFinal || "").trim();
      if (!clientName) { setStatus("Renseigne d'abord le client final.", "err"); return; }
      let c = findRefClient(clientName);
      if (!c) { c = { nom: clientName, craValidateurs: [], lieux: [] }; state.ref.clients.push(c); }
      const field = key === "craValidePar" ? "craValidateurs" : "lieux";
      if (!c[field]) c[field] = [];
      if (!c[field].some((x) => x.toLowerCase() === val.toLowerCase())) c[field].push(val);
    }
    await persistRef();
    refreshRefLists();
    setStatus("✓ Enregistré dans le référentiel.", "ok");
  } catch (e) {
    setStatus("Référentiel : " + e.message, "err");
  }
}

/* ---- Vue de gestion des référentiels ---- */
async function loadReferentiels() {
  try { state.ref = await getJSON("/api/referentiels"); } catch (e) {}
  renderReferentiels();
}

function refInput(ph) {
  const i = document.createElement("input");
  i.type = "text";
  i.placeholder = ph;
  i.className = "ref-input";
  return i;
}

async function refSave() {
  try { await persistRef(); refreshRefLists(); renderReferentiels(); }
  catch (e) { setStatus("Référentiel : " + e.message, "err"); }
}

function refSubList(c, field, label) {
  const box = document.createElement("div");
  box.className = "ref-sublist";
  const lab = document.createElement("div");
  lab.className = "ref-sublabel";
  lab.textContent = label + " :";
  box.appendChild(lab);
  (c[field] || []).forEach((v, vi) => {
    const chip = document.createElement("span");
    chip.className = "ref-chip";
    chip.textContent = v;
    const x = document.createElement("button");
    x.className = "ref-chip-x";
    x.textContent = "✕";
    x.addEventListener("click", () => { c[field].splice(vi, 1); refSave(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
  const add = refInput("+ ajouter puis Entrée…");
  add.classList.add("ref-input-sm");
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && add.value.trim()) {
      if (!c[field]) c[field] = [];
      c[field].push(add.value.trim());
      refSave();
    }
  });
  box.appendChild(add);
  return box;
}

let refClientQuery = "";
const normStr = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Carte d'un client dans le référentiel (ci = index dans state.ref.clients).
function renderClientCard(c, ci) {
  const card = document.createElement("div");
  card.className = "ref-client";
  const head = document.createElement("div");
  head.className = "ref-client-head";
  head.innerHTML = "<b>" + escapeHtml(c.nom) + "</b>";
  const cdel = document.createElement("button");
  cdel.className = "ref-del"; cdel.textContent = "✕"; cdel.title = "Supprimer le client";
  cdel.addEventListener("click", () => { state.ref.clients.splice(ci, 1); refSave(); });
  head.appendChild(cdel);
  card.appendChild(head);
  const bits = [];
  if (c.siren) bits.push("SIREN " + c.siren);
  if (c.adresse) bits.push(c.adresse);
  if (c.email) bits.push(c.email);
  if (c.tel) bits.push(c.tel);
  if (bits.length) {
    const info = document.createElement("div");
    info.className = "ref-client-info";
    info.textContent = bits.join("  ·  ");
    card.appendChild(info);
  }
  card.appendChild(refSubList(c, "craValidateurs", "Valideurs CRA"));
  card.appendChild(refSubList(c, "lieux", "Lieux d'exécution"));
  return card;
}

function renderReferentiels() {
  const host = $("#refContent");
  if (!host) return;
  host.innerHTML = "";

  // Managers
  const mSec = document.createElement("div");
  mSec.className = "ref-sec";
  const mh = document.createElement("h3"); mh.textContent = "Business Managers"; mSec.appendChild(mh);
  (state.ref.managers || []).forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.innerHTML = '<span class="ref-main">' + escapeHtml(m.nom) + '</span><span class="ref-sub">' + escapeHtml(m.email || "") + " · " + escapeHtml(m.tel || "") + "</span>";
    const del = document.createElement("button");
    del.className = "ref-del"; del.textContent = "✕"; del.title = "Supprimer";
    del.addEventListener("click", () => { state.ref.managers.splice(i, 1); refSave(); });
    row.appendChild(del);
    mSec.appendChild(row);
  });
  const mNom = refInput("Nom (ex : M. Jean DUPONT)"), mEmail = refInput("Email"), mTel = refInput("Téléphone");
  const mBtn = document.createElement("button");
  mBtn.className = "btn btn-primary"; mBtn.textContent = "Ajouter le manager";
  mBtn.addEventListener("click", () => {
    if (!mNom.value.trim()) return;
    state.ref.managers.push({ nom: mNom.value.trim(), email: mEmail.value.trim(), tel: mTel.value.trim() });
    refSave();
  });
  const mAdd = document.createElement("div");
  mAdd.className = "ref-add-form";
  mAdd.append(mNom, mEmail, mTel, mBtn);
  mSec.appendChild(mAdd);
  host.appendChild(mSec);

  // Signataires réutilisables (côté cocontractant) : nom + qualité.
  const sSec = document.createElement("div");
  sSec.className = "ref-sec";
  const shd = document.createElement("h3"); shd.textContent = "Signataires (côté cocontractant)"; sSec.appendChild(shd);
  (state.ref.signataires || []).forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.innerHTML = '<span class="ref-main">' + escapeHtml(s.nom) + '</span><span class="ref-sub">' + escapeHtml(s.qualite || "—") + "</span>";
    const del = document.createElement("button");
    del.className = "ref-del"; del.textContent = "✕"; del.title = "Supprimer";
    del.addEventListener("click", () => { state.ref.signataires.splice(i, 1); refSave(); });
    row.appendChild(del);
    sSec.appendChild(row);
  });
  const sNom = refInput("Nom (ex : Mme Julie MARTIN)"), sQual = refInput("En qualité de (vide si entrepreneur individuel)");
  const sBtn = document.createElement("button");
  sBtn.className = "btn btn-primary"; sBtn.textContent = "Ajouter le signataire";
  sBtn.addEventListener("click", () => {
    if (!sNom.value.trim()) return;
    state.ref.signataires = state.ref.signataires || [];
    state.ref.signataires.push({ nom: sNom.value.trim(), qualite: sQual.value.trim() });
    refSave();
  });
  const sAdd = document.createElement("div");
  sAdd.className = "ref-add-form";
  sAdd.append(sNom, sQual, sBtn);
  sSec.appendChild(sAdd);
  host.appendChild(sSec);

  // Entreprises sous-traitantes (fiches complètes, ajoutées via « ＋ » dans l'éditeur).
  const eSec = document.createElement("div");
  eSec.className = "ref-sec";
  const ehd = document.createElement("h3");
  ehd.textContent = "Sous-traitants (" + (state.ref.soustraitants || []).length + ")";
  eSec.appendChild(ehd);
  const eIntro = document.createElement("p");
  eIntro.className = "muted set-intro";
  eIntro.textContent = "Enregistrées depuis l'étape Sous-Traitant de l'éditeur (bouton « ＋ Enregistrer l'entreprise »). Sélectionner une entreprise dans l'éditeur pré-remplit toute la fiche.";
  eSec.appendChild(eIntro);
  (state.ref.soustraitants || []).forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.innerHTML = '<span class="ref-main">🏢 ' + escapeHtml(e.nom) + "</span>" +
      '<span class="ref-sub">' + escapeHtml([e.formeJuridique, e.siren && "SIREN " + e.siren, e.representant].filter(Boolean).join(" · ") || "—") + "</span>";
    const del = document.createElement("button");
    del.className = "ref-del"; del.textContent = "✕"; del.title = "Supprimer";
    del.addEventListener("click", () => { state.ref.soustraitants.splice(i, 1); refSave(); });
    row.appendChild(del);
    eSec.appendChild(row);
  });
  host.appendChild(eSec);

  // Clients (avec recherche — on n'affiche pas les 80+ clients d'un coup)
  const cSec = document.createElement("div");
  cSec.className = "ref-sec";
  const clients = state.ref.clients || [];
  const ch = document.createElement("h3");
  ch.textContent = "Clients — valideurs CRA & lieux (" + clients.length + ")";
  cSec.appendChild(ch);

  const search = document.createElement("input");
  search.type = "text";
  search.className = "ref-input ref-search";
  search.placeholder = "🔎 Rechercher un client par nom…";
  search.value = refClientQuery;
  cSec.appendChild(search);

  const list = document.createElement("div");
  list.className = "ref-client-list";
  cSec.appendChild(list);

  const renderList = () => {
    list.innerHTML = "";
    const q = normStr(refClientQuery.trim());
    if (!q) {
      const hint = document.createElement("div");
      hint.className = "muted ref-hint";
      hint.textContent = "Tapez un nom pour rechercher parmi " + clients.length + " clients.";
      list.appendChild(hint);
      return;
    }
    const matches = clients.map((c, i) => ({ c, i })).filter((o) => normStr(o.c.nom).includes(q));
    const info = document.createElement("div");
    info.className = "muted ref-hint";
    info.textContent = matches.length + " résultat" + (matches.length > 1 ? "s" : "");
    list.appendChild(info);
    matches.slice(0, 40).forEach((o) => list.appendChild(renderClientCard(o.c, o.i)));
    if (matches.length > 40) {
      const more = document.createElement("div");
      more.className = "muted ref-hint";
      more.textContent = "… affinez la recherche (40 premiers affichés).";
      list.appendChild(more);
    }
  };
  search.addEventListener("input", () => { refClientQuery = search.value; renderList(); });
  renderList();

  const cNom = refInput("Nom du client (ex : Groupe Accor)");
  const cBtn = document.createElement("button");
  cBtn.className = "btn btn-primary"; cBtn.textContent = "Ajouter le client";
  cBtn.addEventListener("click", () => {
    if (!cNom.value.trim()) return;
    state.ref.clients.push({ nom: cNom.value.trim(), craValidateurs: [], lieux: [] });
    refClientQuery = cNom.value.trim(); // pour retrouver le client ajouté
    refSave();
  });
  const cAdd = document.createElement("div");
  cAdd.className = "ref-add-form";
  cAdd.append(cNom, cBtn);
  cSec.appendChild(cAdd);
  host.appendChild(cSec);
}

// Barre « Contrat initial » (avenant) : reprend N'IMPORTE QUEL contrat de l'Historique
// (sous-traitance, CDS, CDI, CDD) → fixe le type + la référence + les parties adaptées.
const CONTRAT_TYPE_LABELS = { "sous-traitance": "Sous-traitance", cds: "CDS", cdi: "CDI", cdd: "CDD" };
// Cadre récapitulatif du contrat initial, affiché dans l'étape Avenant.
// Purement INFORMATIF (rien n'est modifié ici) : deux volets — le contrat
// (dates, TJM) et les personnes (client final, sous-traitant, consultant).
function buildRecapAvenant() {
  const p = state.avenantParent;
  const boite = document.createElement("div");
  boite.className = "recap-avenant";
  const ligne = (emoji, label, valeur, classe) => valeur
    ? '<div class="recap-ligne' + (classe ? " " + classe : "") + '"><span class="recap-emoji">' + emoji + '</span><span class="recap-label">' + label + '</span><b>' + escapeHtml(String(valeur)) + "</b></div>"
    : "";
  const finBientot = (() => {
    if (!p.dateFin) return "";
    const j = Math.ceil((new Date(p.dateFin + "T23:59:59") - new Date()) / 86400000);
    if (isNaN(j)) return "";
    if (j < 0) return "echu";
    if (j <= 30) return "bientot";
    return "";
  })();
  const dFr = (d) => d ? d.split("-").reverse().join("/") : "";
  boite.innerHTML =
    '<div class="recap-titre">ⓘ Repris du contrat initial <b>' + escapeHtml(p.numero || "") + "</b> — à titre informatif " +
    '<span class="muted">(modifiez les champs ci-dessous si la situation a changé)</span></div>' +
    '<div class="recap-volets">' +
    '<div class="recap-volet"><h4>📄 Le contrat</h4>' +
    ligne("🗓️", "Début", dFr(p.dateDebut)) +
    ligne("⏰", "Fin du contrat", dFr(p.dateFin) + (finBientot === "echu" ? " — échu" : finBientot === "bientot" ? " — bientôt !" : ""), finBientot ? "alerte" : "") +
    ligne("💶", "TJM", p.tjm ? p.tjm + " € HT / jour" : "") +
    "</div>" +
    '<div class="recap-volet"><h4>👥 Les personnes</h4>' +
    ligne("🏢", "Client final", p.clientFinal) +
    ligne("🤝", "Sous-traitant", p.stNom) +
    ligne("👤", "Consultant", p.consultant) +
    "</div>" +
    "</div>";
  return boite;
}

function buildContractRefBar() {
  const bar = document.createElement("div");
  bar.className = "lookup";
  const sel = document.createElement("select");
  sel.className = "lookup-input";
  sel.innerHTML = '<option value="">— Reprendre un contrat de l’Historique —</option>';
  const msg = document.createElement("div");
  msg.className = "lookup-msg";
  fetch("/api/contracts").then((r) => r.json()).then((list) => {
    (list || []).forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = (CONTRAT_TYPE_LABELS[c.type] || c.type) + " · " + (c.numero || "?") + " — " + (c.sousTraitant || c.clientFinal || "");
      sel.appendChild(o);
    });
    if (sel.options.length <= 1) { msg.textContent = "Aucun contrat dans l’Historique. Enregistre d’abord le contrat initial."; msg.className = "lookup-msg"; }
  }).catch(() => {});
  sel.addEventListener("change", async () => {
    if (!sel.value) return;
    msg.textContent = "Chargement du contrat…"; msg.className = "lookup-msg";
    try {
      const r = await fetch("/api/contracts/" + sel.value);
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error || ("HTTP " + r.status));
      applyContractRef(payload);
      const t = CONTRAT_TYPE_LABELS[payload.type] || payload.type;
      msg.textContent = "✓ " + t + " repris : " + ((payload.values && payload.values.numeroContrat) || "");
      msg.className = "lookup-msg ok";
    } catch (e) { msg.textContent = "Erreur : " + e.message; msg.className = "lookup-msg err"; }
  });
  bar.appendChild(sel);
  bar.appendChild(msg);
  return bar;
}

// Applique un contrat de l'Historique à l'avenant : type + référence + parties adaptées.
function applyContractRef(payload) {
  const type = (payload && payload.type) || "sous-traitance";
  const src = (payload && payload.values) || {};
  state.values.contratType = type;
  if (src.numeroContrat) state.values.numeroContratInitial = src.numeroContrat;
  if (src.dateRedaction) state.values.dateContratInitial = src.dateRedaction;
  if (type === "cds") {
    // CDS : Partie 1 = Client, Partie 2 = ADBI (Prestataire).
    state.values.avPartie1Nom = src.clientNom || "";
    state.values.avPartie1Repr = src.clientSignataireNom || "";
    state.values.avPartie1Qualite = src.clientSignataireFonction || "";
    state.values.avPartie2Nom = "ADBI";
    state.values.avPartie2Repr = "Monsieur Cédric HOUPE";
    state.values.avPartie2Qualite = "Directeur des Opérations";
  } else if (type === "sous-traitance") {
    // Sous-traitance : Partie 1 = ADBI (le Client), Partie 2 = Sous-Traitant.
    state.values.avPartie1Nom = src.adbiNom || "ADBI";
    state.values.avPartie1Repr = src.adbiRepresentant || "";
    state.values.avPartie1Qualite = "";
    state.values.avPartie2Nom = src.stNom || "";
    state.values.avPartie2Repr = src.stSignataireNom || src.stRepresentant || "";
    state.values.avPartie2Qualite = (src.stSignataireNom ? src.stSignataireQualite : src.stQualite) || "";
  }
  // (CDI/CDD : parties saisies à la main pour le moment.)
  // Récap informatif + n° d'avenant automatique + signataires repris.
  state.avenantParent = infosParent(src.numeroContrat, src);
  if (!String(state.values.numeroAvenant || "").trim() && src.numeroContrat) {
    state.values.numeroAvenant = prochainNumeroAvenant(src.numeroContrat);
  }
  buildForm();
  renderPreview();
}

// Profils de recherche société : mapping résultat gouv.fr -> champs du formulaire.
// Réutilisable : Sous-Traitant (sous-traitance/avenant) ou Client (CDS), etc.
const LOOKUP_PROFILES = {
  soustraitant: {
    placeholder: "Nom de la société, ou SIREN / SIRET…",
    label: "Rechercher la société",
    map: { nom: "stNom", adresse: "stAdresse", siren: "stSiren", siret: "stSiret", representant: "stRepresentant", qualite: "stQualite", forme: "stFormeJuridique" },
  },
  client: {
    placeholder: "Nom du client, ou SIREN / SIRET…",
    label: "Rechercher le client",
    map: { nom: "clientNom", adresse: "clientAdresse", representant: "clientSignataireNom", qualite: "clientSignataireFonction", forme: "clientFormeJuridique", rcs: "clientRcs", tva: "clientTva" },
  },
};

// N° de TVA intracommunautaire français calculé à partir du SIREN.
function frTva(siren) {
  const s = String(siren || "").replace(/\D/g, "");
  if (s.length !== 9) return "";
  const cle = (12 + 3 * (Number(s) % 97)) % 97;
  return "FR" + String(cle).padStart(2, "0") + " " + s;
}

// Valeur à injecter pour une clé de profil, à partir d'une société trouvée.
function companyValue(c, key) {
  switch (key) {
    case "nom": return c.stNom || "";
    case "adresse": return c.stAdresse || "";
    case "siren": return c.stSiren || "";
    case "siret": return c.stSiret || "";
    case "representant": return c.stRepresentant || "";
    case "qualite": return c.qualite || "";
    case "forme": return c.formeJuridique || "";
    case "rcs": return c.stSiren ? ("RCS " + (c.ville || "").trim() + " n° " + c.stSiren).replace(/\s+/g, " ").trim() : "";
    case "tva": return frTva(c.stSiren);
    default: return "";
  }
}

function buildLookupBar(profile) {
  profile = profile || LOOKUP_PROFILES.soustraitant;
  const bar = document.createElement("div");
  bar.className = "lookup";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = profile.placeholder;
  input.className = "lookup-input";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-ghost lookup-btn";
  btn.textContent = profile.label;
  const msg = document.createElement("div");
  msg.className = "lookup-msg";
  const list = document.createElement("div");
  list.className = "lookup-candidates hidden";
  const run = () => runLookup(input.value, msg, btn, list, profile);
  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  bar.appendChild(input);
  bar.appendChild(btn);
  bar.appendChild(msg);
  bar.appendChild(list);
  return bar;
}

async function runLookup(q, msg, btn, list, profile) {
  profile = profile || LOOKUP_PROFILES.soustraitant;
  if (!String(q || "").trim()) { msg.textContent = "Saisir un nom de société ou un SIREN/SIRET."; msg.className = "lookup-msg err"; return; }
  msg.textContent = "Recherche en cours…"; msg.className = "lookup-msg";
  if (list) { list.classList.add("hidden"); list.innerHTML = ""; }
  if (btn) btn.disabled = true;
  try {
    const r = await fetch("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    const results = d.results || [];
    if (!results.length) { msg.textContent = "Aucune société trouvée."; msg.className = "lookup-msg err"; return; }
    if (results.length === 1) { selectCompany(results[0], msg, list, profile); return; }
    msg.textContent = results.length + " sociétés trouvées — cliquez sur la bonne :";
    msg.className = "lookup-msg";
    renderCandidates(results, list, msg, profile);
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "lookup-msg err";
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Affiche la liste des sociétés trouvées (recherche par nom) + badge forme/EI.
function renderCandidates(results, list, msg, profile) {
  if (!list) return;
  list.innerHTML = "";
  results.forEach((c) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lookup-cand" + (c.etat === "cessée" ? " cessee" : "");
    const badge = c.estEI ? '<em class="cand-ei">Entrepreneur individuel</em>'
      : (c.formeJuridique ? '<em class="cand-forme">' + escapeHtml(c.formeJuridique) + "</em>" : "");
    const sub = [c.stSiren, c.ville].filter(Boolean).join(" · ");
    item.innerHTML =
      '<span class="cand-nom">' + escapeHtml(c.stNom || "(sans nom)") + " " + badge +
      (c.etat === "cessée" ? ' <em class="cand-cessee">cessée</em>' : "") + "</span>" +
      '<span class="cand-sub">' + escapeHtml(sub) +
      (c.stRepresentant ? " — " + escapeHtml(c.stRepresentant) : "") + "</span>";
    item.addEventListener("click", () => { selectCompany(c, msg, list, profile); });
    list.appendChild(item);
  });
  list.classList.remove("hidden");
}

// Remplit les champs cibles (selon le profil) à partir d'une société choisie + statut.
// Si la société a plusieurs établissements actifs, propose le choix du SIRET.
function selectCompany(c, msg, list, profile) {
  profile = profile || LOOKUP_PROFILES.soustraitant;
  if (list) { list.classList.add("hidden"); list.innerHTML = ""; }
  Object.keys(profile.map).forEach((key) => {
    const val = companyValue(c, key);
    if (val) setFieldValue(profile.map[key], val);
  });
  renderPreview();

  const etabs = (c.etablissements || []).filter((e) => e.actif && e.siret);
  if (etabs.length > 1 && list && (profile.map.siret || profile.map.adresse)) {
    msg.textContent = "✓ " + (c.stNom || "Société") + " — " + etabs.length + " établissements, choisissez le bon (SIRET) :";
    msg.className = "lookup-msg ok";
    renderEtablissements(c, etabs, list, msg, profile);
    return;
  }
  const type = c.estEI ? "Entrepreneur individuel (freelance)" : (c.formeJuridique || "société");
  let note = c.etat === "cessée" ? " — ⚠️ ENTREPRISE CESSÉE" : " — " + type + ", actif";
  if (c.etablissementsFermes) note += ", " + c.etablissementsFermes + " établissement(s) fermé(s)";
  msg.textContent = "✓ " + (c.stNom || "Société") + note;
  msg.className = "lookup-msg " + (c.etat === "cessée" ? "err" : "ok");
}

// Liste des établissements (SIRET) d'une société, pour choisir le site exact.
function renderEtablissements(c, etabs, list, msg, profile) {
  profile = profile || LOOKUP_PROFILES.soustraitant;
  list.innerHTML = "";
  etabs.sort((a, b) => (b.estSiege ? 1 : 0) - (a.estSiege ? 1 : 0));
  etabs.forEach((et) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lookup-cand";
    item.innerHTML =
      '<span class="cand-nom">' + escapeHtml(et.adresse || et.ville || "Établissement") +
      (et.estSiege ? ' <em class="cand-siege">siège</em>' : "") + "</span>" +
      '<span class="cand-sub">SIRET ' + escapeHtml(et.siret) + (et.enseigne ? " · " + escapeHtml(et.enseigne) : "") + "</span>";
    item.addEventListener("click", () => {
      if (profile.map.siret) setFieldValue(profile.map.siret, et.siret);
      if (et.adresse && profile.map.adresse) setFieldValue(profile.map.adresse, et.adresse);
      renderPreview();
      msg.textContent = "✓ " + (c.stNom || "Société") + " — établissement " + (et.ville || et.siret);
      msg.className = "lookup-msg ok";
      list.classList.add("hidden"); list.innerHTML = "";
    });
    list.appendChild(item);
  });
  list.classList.remove("hidden");
}

/* ------------------------------------------------------------------ */
/* Module : assistant IA Gemini (nature des travaux)                   */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Vue Paramètres (clés API)                                           */
/* ------------------------------------------------------------------ */
async function loadSettings() {
  try {
    const s = await getJSON("/api/settings");
    $("#setSource").value = s.source || "gouv";
    const mark = (id, on) => {
      const el = $(id);
      el.textContent = on ? "✓ configurée" : "non configurée";
      el.className = "set-state " + (on ? "ok" : "off");
    };
    mark("#setPappersState", s.pappers);
    mark("#setInseeState", s.insee);
    ["#setPappers", "#setInsee"].forEach((id) => { $(id).value = ""; });
    // Connecteur de signature : sélection + état (les clés ne sont jamais réaffichées).
    $("#setSignFournisseur").value = s.fournisseurSignature || "yousign";
    $("#setYousignMode").value = s.yousignMode || "sandbox";
    $("#setYousignCle").value = "";
    $("#setYousignCle").placeholder = s.yousignConfigure ? "•••••• (enregistrée — retaper pour changer)" : "clé créée sur yousign.com";
    $("#setYousignWebhook").value = "";
    $("#setYousignWebhook").placeholder = s.yousignWebhook ? "•••••• (enregistré)" : "pour vérifier l'authenticité des webhooks";
    $("#setZohoRegion").value = s.zohoRegion || "eu";
    $("#setZohoClientId").value = "";
    $("#setZohoClientId").placeholder = s.zohoIdentifiants ? "•••••• (enregistré — retaper pour changer)" : "depuis api-console.zoho.eu (Self Client)";
    $("#setZohoClientSecret").value = "";
    $("#setZohoClientSecret").placeholder = s.zohoIdentifiants ? "•••••• (enregistré)" : "depuis api-console.zoho.eu";
    $("#setZohoWebhook").value = "";
    $("#setZohoWebhook").placeholder = s.zohoWebhook ? "•••••• (enregistré)" : "pour vérifier l'authenticité des webhooks (X-ZS-Webhook-Signature)";
    ETAT_CONNECTEURS = s;
    majEtatConnecteur();
    // SMTP : hôte/port/utilisateur/expéditeur ré-affichés (pas le mot de passe).
  } catch (e) {
    $("#setStatus").textContent = "Erreur de chargement : " + e.message;
  }
}

async function saveSettings() {
  const body = {
    pappersApiKey: $("#setPappers").value,
    inseeApiKey: $("#setInsee").value,
    source: $("#setSource").value,
  };
  // Connecteur de signature (clés envoyées seulement si retapées).
  body.fournisseurSignature = $("#setSignFournisseur").value;
  body.yousignMode = $("#setYousignMode").value;
  if ($("#setYousignCle").value.trim()) body.yousignCleApi = $("#setYousignCle").value.trim();
  if ($("#setYousignWebhook").value.trim()) body.yousignWebhookSecret = $("#setYousignWebhook").value.trim();
  body.zohoRegion = $("#setZohoRegion").value;
  if ($("#setZohoClientId").value.trim()) body.zohoClientId = $("#setZohoClientId").value.trim();
  if ($("#setZohoClientSecret").value.trim()) body.zohoClientSecret = $("#setZohoClientSecret").value.trim();
  if ($("#setZohoWebhook").value.trim()) body.zohoWebhookSecret = $("#setZohoWebhook").value.trim();
  const st = $("#setStatus");
  st.textContent = "Enregistrement…"; st.style.color = "var(--muted)";
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json", ...enteteCode() }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    await loadSettings();
    st.textContent = "✓ Clés enregistrées."; st.style.color = "var(--ok)";
  } catch (e) {
    st.textContent = "Erreur : " + e.message; st.style.color = "var(--accent)";
  }
}

/* ------------------------------------------------------------------ */
/* Aperçu live                                                         */
/* ------------------------------------------------------------------ */
function renderPreview() {
  const v = Object.assign({}, state.values);
  // Fragments optionnels (clé …Clause → rien si vide) : CRA + contacts du Suivi.
  v.craValideParClause = v.craValidePar ? " (" + v.craValidePar + ")" : "";
  v.bmEmailClause = v.bmEmail ? " — " + v.bmEmail : "";
  v.bmTelClause = v.bmTel ? " — " + v.bmTel : "";
  v.consultantFonctionClause = v.consultantFonction ? " — " + v.consultantFonction : "";
  v.consultantTelClause = v.consultantTel ? " — " + v.consultantTel : "";
  // Signataire du sous-traitant (à défaut, le représentant) + « en qualité de » (vide si EI).
  const stSig = (v.stSignataireNom || "").trim();
  v.sigStNom = stSig || v.stRepresentant || "";
  const stQ = stSig ? (v.stSignataireQualite || "") : (v.stQualite || "");
  v.sigStQualiteClause = stQ ? "En qualité de : " + stQ : "";
  v.clientSignataireQualiteClause = v.clientSignataireFonction ? "En qualité de : " + v.clientSignataireFonction : "";
  // Avenant universel : libellés + désignations des parties selon le type de contrat initial.
  const AVT = {
    "sous-traitance": { short: "CONVENTION DE SOUS-TRAITANCE", def: "la Convention de sous-traitance d'assistance technique", d1: "le Client", d2: "le Sous-Traitant" },
    "cds": { short: "CENTRE DE SERVICES", def: "le Contrat de prestations informatiques du Centre de Services", d1: "le Client", d2: "le Prestataire" },
    "cdi": { short: "CONTRAT CDI", def: "le Contrat de travail à durée indéterminée", d1: "l'Employeur", d2: "le Salarié" },
    "cdd": { short: "CONTRAT CDD", def: "le Contrat de travail à durée déterminée", d1: "l'Employeur", d2: "le Salarié" },
  };
  const at = AVT[v.contratType] || AVT["sous-traitance"];
  v.contratTypeLabelShort = at.short;
  v.contratTypeLabelDef = at.def;
  v.avDesignation1 = at.d1;
  v.avDesignation2 = at.d2;
  v.avPartie1QualiteClause = v.avPartie1Qualite ? ", agissant en qualité de " + v.avPartie1Qualite : "";
  v.avPartie2QualiteClause = v.avPartie2Qualite ? ", agissant en qualité de " + v.avPartie2Qualite : "";
  v.avPartie1QualiteLine = v.avPartie1Qualite ? "En qualité de : " + v.avPartie1Qualite : "";
  v.avPartie2QualiteLine = v.avPartie2Qualite ? "En qualité de : " + v.avPartie2Qualite : "";

  // Bandeau d'en-tête (répété) — titre + n° configurables selon le type (avenant inclus).
  const dhHtml = () =>
    '<div class="doc-header"><div class="dh-left"><img src="/logo-adbi.png" class="dh-logo" alt="ADBI" />' +
    '<div class="dh-num">' + escapeHtml(fill(state.headerNum || "N° de contrat : {{numeroContrat}}", v)) + "</div></div>" +
    '<div class="dh-title">' + escapeHtml(fill(state.headerTitle || "CONVENTION DE SOUS-TRAITANCE D’ASSISTANCE TECHNIQUE", v)) + "</div></div>";

  const html = [];
  if (state.headerOnFirst) html.push(dhHtml()); // avenant : en-tête dès la 1re page (pas de couverture)

  for (const b of activeBlocks(state.blocks, state.optionState)) {
    switch (b.t) {
      case "cover":
        html.push(
          '<div class="cover"><img src="/logo-adbi.png" class="clogo-img" alt="ADBI" />' +
          '<div class="ctitle">' + escapeHtml(state.titre) + "</div>" +
          '<div class="cmeta">Contrat n\u00B0 ' + escapeHtml(fill("{{numeroContrat}}", v)) +
          "<br>Version " + escapeHtml(fill("{{version}}", v)) + "</div></div>"
        );
        break;
      case "pagebreak":
        html.push(dhHtml());
        break;
      case "col2-start":
        html.push('<div class="cols2">');
        break;
      case "col2-end":
        html.push('</div><div class="pb"><span>· · ·</span></div>');
        break;
      case "parties":
        html.push(
          "<h4>ENTRE LES SOUSSIGN\u00C9S :</h4>" +
          "<p><strong>" + escapeHtml(fill("{{adbiNom}}", v)) + "</strong><br>" +
          escapeHtml(fill("{{adbiAdresse}}", v)) + "<br>" +
          "Capital : " + escapeHtml(fill("{{adbiCapital}}", v)) + " \u2014 " + escapeHtml(fill("{{adbiRcs}}", v)) + "<br>" +
          "Repr\u00E9sent\u00E9e par : " + escapeHtml(fill("{{adbiRepresentant}}", v)) + ", d\u00FBment habilit\u00E9 \u00E0 signer les pr\u00E9sentes</p>" +
          '<p class="right">Ci-apr\u00E8s d\u00E9sign\u00E9e le \u00AB Client \u00BB, d\u2019une part</p>' +
          '<p class="party-sep"><strong>ET</strong></p>' +
          "<p><strong>" + escapeHtml(fill("{{stNom}}", v)) + "</strong><br>" +
          (v.stFormeJuridique ? escapeHtml(fill("{{stFormeJuridique}}", v)) + "<br>" : "") +
          "Adresse : " + escapeHtml(fill("{{stAdresse}}", v)) + "<br>" +
          "SIREN : " + escapeHtml(fill("{{stSiren}}", v)) + "   \u2014   SIRET : " + escapeHtml(fill("{{stSiret}}", v)) + "<br>" +
          "Repr\u00E9sent\u00E9e par : " + escapeHtml(fill("{{stRepresentant}}", v)) + (v.stQualite ? ", en sa qualit\u00E9 de " + escapeHtml(fill("{{stQualite}}", v)) : "") + ", d\u00FBment habilit\u00E9 \u00E0 signer les pr\u00E9sentes</p>" +
          '<p class="right">Ci-apr\u00E8s d\u00E9sign\u00E9e le \u00AB Sous-Traitant \u00BB, d\u2019autre part</p>'
        );
        break;
      case "h2":
        html.push("<h4>" + runsHtml(fillBold(b.x, v)) + "</h4>");
        break;
      case "h3":
        html.push("<h5>" + runsHtml(fillBold(b.x, v)) + "</h5>");
        break;
      case "annexe-title":
        html.push('<div class="atitle">' + runsHtml(fill(b.x, v)) + "</div>");
        break;
      case "p":
        html.push("<p>" + runsHtml(fillBold(b.x, v)) + "</p>");
        break;
      case "dash":
        html.push('<div class="li">\u2013\u00A0\u00A0' + runsHtml(fillBold(b.x, v)) + "</div>");
        break;
      case "li":
        html.push('<div class="li">\u2022\u00A0\u00A0' + runsHtml(fillBold(b.x, v)) + "</div>");
        break;
      case "table":
        html.push(
          '<table class="doc-table"><thead><tr>' +
          (b.headers || []).map((h) => "<th>" + escapeHtml(h) + "</th>").join("") +
          "</tr></thead><tbody>" +
          (b.rows || []).map((r) => "<tr>" + r.map((c) => "<td>" + escapeHtml(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>"
        );
        break;
      case "spacer":
        html.push('<div style="height:8px"></div>');
        break;
      case "signatures": {
        const lTitle = b.leftTitle || "Pour le Client \u2014 {{adbiNom}}";
        const rTitle = b.rightTitle || "Pour le Sous-Traitant \u2014 {{stNom}}";
        const lName = b.leftName || "{{adbiRepresentant}}";
        const rName = b.rightName || "{{sigStNom}}";
        const lSubTxt = fill(b.leftSub || "", v);
        const rSubTxt = fill(b.rightSub || "{{sigStQualiteClause}}", v);
        const lSub = lSubTxt ? escapeHtml(lSubTxt) + "<br>" : "";
        const rSub = rSubTxt ? escapeHtml(rSubTxt) + "<br>" : "";
        html.push(
          "<p>" + escapeHtml(fill("Fait le {{dateRedaction}} \u00E0 {{lieuRedaction}}, en deux exemplaires originaux, chacune des parties reconnaissant avoir re\u00E7u le sien.", v)) + "</p>" +
          '<div class="sig">' +
          "<div><b>" + escapeHtml(fill(lTitle, v)) + "</b><br><br>Nom : " + escapeHtml(fill(lName, v)) + "<br>" + lSub + "Signature :<div class=\"sigline\"></div>Lu et approuv\u00E9, bon pour accord<br>Cachet :<div class=\"cachet-box\"></div></div>" +
          "<div><b>" + escapeHtml(fill(rTitle, v)) + "</b><br><br>Nom : " + escapeHtml(fill(rName, v)) + "<br>" + rSub + "Signature :<div class=\"sigline\"></div>Lu et approuv\u00E9, bon pour accord<br>Cachet :<div class=\"cachet-box\"></div></div>" +
          "</div>" +
          '<p class="small">Porter la mention manuscrite \u00AB Lu et approuv\u00E9 \u2013 Bon pour accord \u00BB</p>'
        );
        break;
      }
      default:
        break;
    }
  }

  const host = $("#preview");
  if (state.stub) {
    host.innerHTML = '<div class="cover"><img src="/logo-adbi.png" class="clogo-img" alt="ADBI" />' +
      '<div class="ctitle">' + escapeHtml(state.titre) + "</div>" +
      '<p style="text-align:center;color:#888">Mod\u00E8le non encore disponible.<br>Fournissez le contrat type correspondant pour l\u2019activer.</p></div>';
  } else {
    host.innerHTML = html.join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* Chargement d'un type de contrat                                     */
/* ------------------------------------------------------------------ */
async function loadType(type, preset) {
  try {
    setStatus("Chargement\u2026");
    const data = await getJSON("/api/template/" + encodeURIComponent(type));
    state.type = type;
    state.titre = data.titre;
    state.stub = !!data.stub;
    state.headerTitle = data.headerTitle || "";
    state.headerNum = data.headerNum || "";
    state.headerOnFirst = !!data.headerOnFirst;
    state.blocks = data.blocks || [];
    state.fields = data.fields || [];
    state.options = data.options || [];
    state.checklistDef = data.checklist || [];
    state.values = Object.assign({}, data.defaults, preset && preset.values);
    state.optionState = Object.assign({}, data.optionDefaults, preset && preset.options);
    // Clauses optionnelles TOUJOURS incluses (choix utilisateur sept. 2026) :
    // le panneau est masqué et toutes les annexes optionnelles restent actives.
    Object.keys(state.optionState).forEach((k) => { state.optionState[k] = true; });
    state.checkState = Object.assign({}, preset && preset.checklist);
    state.docState = Object.assign({}, preset && preset.docs);
    state.dateState = Object.assign({}, preset && preset.dates);

    $("#formTitle").textContent = data.titre;
    $("#stubBadge").classList.toggle("hidden", !state.stub);

    document.querySelectorAll("#typeButtons .type-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });

    // Changer de type ou repartir d'un mod\u00E8le vierge sort du mode \u00AB modification \u00BB ;
    // openContract repose editing juste apr\u00E8s ce chargement. Le r\u00E9cap d'avenant
    // est repos\u00E9 de la m\u00EAme fa\u00E7on par creerAvenantDepuis / applyContractRef.
    state.editing = null;
    state.avenantParent = null;
    majBandeauEdition();

    buildForm();
    buildOptions();
    buildChecklist();
    renderPreview();
    setExportsEnabled(!state.stub);
    if (type === "avenant") attacherDatalistContrats();
    setStatus(state.stub ? "Mod\u00E8le \u00E0 venir pour ce type." : "");
  } catch (e) {
    setStatus("Erreur de chargement : " + e.message, "err");
  }
}

// Avenant : auto-compl\u00E9tion du \u00AB N\u00B0 du contrat initial \u00BB avec les num\u00E9ros
// des contrats de l'historique (rattachement avenant \u2192 contrat parent).
async function attacherDatalistContrats() {
  try {
    const rows = await getJSON("/api/contracts");
    HIST_CACHE = rows; // sert aussi à la numérotation automatique des avenants
    let dl = document.getElementById("dl-contrats");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "dl-contrats";
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    rows.filter((r) => r.type !== "avenant" && r.numero).forEach((r) => {
      const o = document.createElement("option");
      o.value = r.numero;
      o.label = (r.sousTraitant || "") + (r.clientFinal ? " \u2192 " + r.clientFinal : "");
      dl.appendChild(o);
    });
    const champ = document.getElementById("f_numeroContratInitial");
    if (champ) {
      champ.setAttribute("list", "dl-contrats");
      // R\u00E8gle de nommage : d\u00E8s que le contrat initial est choisi, le n\u00B0 d'avenant
      // se remplit tout seul (nombre d'avenants existants pour ce contrat + 1).
      champ.addEventListener("change", () => {
        const num = champ.value.trim();
        if (!num || String(state.values.numeroAvenant || "").trim()) return;
        setFieldValue("numeroAvenant", prochainNumeroAvenant(num));
        renderPreview();
      });
    }
  } catch (e) { /* auto-compl\u00E9tion facultative */ }
}

// Bandeau \u00AB Modification du contrat \u2026 \u00BB au-dessus des exports.
function majBandeauEdition() {
  const b = document.getElementById("editBanner");
  if (!b) return;
  if (state.editing) {
    b.classList.remove("hidden");
    b.querySelector(".edit-num").textContent = state.editing.numero || ("#" + state.editing.id);
  } else {
    b.classList.add("hidden");
  }
  const btn = $("#btnSave");
  if (btn) btn.innerHTML = state.editing ? '<span class="ico-anim">\uD83D\uDCBE</span> Enregistrer les modifications' : "Enregistrer";
}

function setExportsEnabled(on) {
  ["#btnPdf", "#btnWord", "#btnZip", "#btnSave", "#btnSign"].forEach((s) => { $(s).disabled = !on; });
}

/* ------------------------------------------------------------------ */
/* Historique                                                          */
/* ------------------------------------------------------------------ */
function majSelectionHist() {
  const coches = document.querySelectorAll("#histBody .sel-contrat:checked");
  const btn = $("#histDelSel");
  btn.classList.toggle("hidden", coches.length === 0);
  btn.textContent = "🗑 Supprimer la sélection (" + coches.length + ")";
  const tous = document.querySelectorAll("#histBody .sel-contrat");
  $("#histAll").checked = tous.length > 0 && coches.length === tous.length;
}

function fermerMenusHist() {
  document.querySelectorAll(".menu-pop").forEach((m) => m.classList.add("hidden"));
}

const TYPE_LABELS = { "sous-traitance": "Sous-traitance", avenant: "Avenant", cds: "Centre de services", cdi: "CDI", cdd: "CDD" };

// Jours restants avant la fin de mission (négatif = échue) ; null sans date de fin.
function joursAvantFin(r) {
  if (!r.dateFin || r.type === "avenant") return null;
  const fin = new Date(r.dateFin + "T23:59:59");
  if (isNaN(fin)) return null;
  return Math.ceil((fin - new Date()) / 86400000);
}

// Alerte de fin de contrat : rouge si échu ou ≤ 7 j, orange si ≤ 30 j.
function alerteFin(r) {
  if (r.statut === "clos") return null;
  const j = joursAvantFin(r);
  if (j === null || j > 30) return null;
  if (j < 0) return { niveau: "rouge", texte: "échu depuis " + (-j) + " j", jours: j };
  if (j === 0) return { niveau: "rouge", texte: "se termine aujourd’hui", jours: j };
  if (j <= 7) return { niveau: "rouge", texte: "fin dans " + j + " j", jours: j };
  return { niveau: "orange", texte: "fin dans " + j + " j", jours: j };
}

// Récap du contrat initial gardé « à titre informatif » sur l'avenant : dates,
// parties, consultant, TJM, et les personnes/e-mails repris pour la signature.
function infosParent(numero, v) {
  return {
    numero: numero || v.numeroContrat || "",
    dateDebut: v.dateDebut || "",
    dateFin: v.dateFin || "",
    clientFinal: v.clientFinal || "",
    stNom: v.stNom || "",
    consultant: v.consultantNom || "",
    tjm: v.tjm || "",
    adbiRepresentant: v.adbiRepresentant || "",
    stRepresentant: v.stSignataireNom || v.stRepresentant || "",
    bmEmail: v.bmEmail || "",
    stEmail: v.stEmail || "",
  };
}

// Règle de nommage des avenants : numéro d'ordre POUR CE CONTRAT (1, 2, 3…).
function prochainNumeroAvenant(numeroContrat) {
  return String(HIST_CACHE.filter((x) => x.type === "avenant" && x.contratInitial === numeroContrat).length + 1);
}

// Nouvel avenant pré-rempli depuis un contrat de l'historique (rattaché à son n°).
async function creerAvenantDepuis(r) {
  let v = {};
  try { v = (await getJSON("/api/contracts/" + r.id)).values || {}; } catch (e) {}
  if (!HIST_CACHE.length) { try { HIST_CACHE = await getJSON("/api/contracts"); } catch (e) {} }
  await loadType("avenant", {
    values: {
      numeroAvenant: prochainNumeroAvenant(r.numero || ""),
      contratType: r.type,
      numeroContratInitial: r.numero || "",
      dateContratInitial: v.dateRedaction || "",
      avPartie1Nom: v.adbiNom || "A.D.B.I",
      avPartie1Repr: v.adbiRepresentant || "",
      avPartie2Nom: r.sousTraitant || v.stNom || "",
      avPartie2Repr: v.stRepresentant || "",
      lieuRedaction: v.lieuRedaction || "Paris",
    },
  });
  state.avenantParent = infosParent(r.numero, v);
  buildForm(); // ré-affiche l'étape Avenant avec le récap informatif
  showView("editeur");
  setStatus("Avenant n° " + state.values.numeroAvenant + " pré-rempli depuis le contrat " + (r.numero || "") + " — complétez l’objet puis enregistrez.", "ok");
}

// Clôture / réouverture d'un contrat (les alertes de fin s'arrêtent une fois clos).
async function basculerCloture(r) {
  const clos = r.statut === "clos";
  if (!clos && !window.confirm("Clôturer le contrat " + (r.numero || "") + " ?\nIl restera dans l’historique (marqué 🔒) et ses alertes de fin s’arrêteront.")) return;
  await fetch("/api/contracts/" + r.id + "/statut", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ statut: clos ? "" : "clos" }),
  });
  loadHistory();
}

// Fiche entreprise (annuaire public gouv.fr) au clic sur un groupe de l'historique.
async function ficheEntreprise(nom, siren) {
  $("#entNom").textContent = nom;
  $("#entCorps").innerHTML = '<p class="muted">Interrogation de l’annuaire des entreprises…</p>';
  $("#entModal").classList.remove("hidden");
  try {
    const r = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: siren || nom }),
    });
    const e = await r.json();
    if (!r.ok || e.error) throw new Error(e.error || "Erreur " + r.status);
    const ligne = (ico, label, val) => val ? '<div class="ent-ligne"><span class="ent-ico">' + ico + '</span><span class="ent-label">' + label + "</span><b>" + escapeHtml(String(val)) + "</b></div>" : "";
    const etabs = (e.etablissements || []).slice(0, 4).map((x) =>
      '<li>' + (x.estSiege ? "🏛 Siège — " : "📍 ") + escapeHtml(x.adresse || x.ville || x.siret) + (x.actif ? "" : " <i>(fermé)</i>") + "</li>").join("");
    $("#entCorps").innerHTML =
      '<div class="ent-etat ' + (e.etat === "active" ? "ok" : "ko") + '">' + (e.etat === "active" ? "● En activité" : "■ Cessée") + "</div>" +
      ligne("🏢", "Raison sociale", e.stNom) +
      ligne("⚖️", "Forme juridique", e.formeJuridique) +
      ligne("👤", "Dirigeant", e.stRepresentant + (e.qualite ? " — " + e.qualite : "")) +
      ligne("🔢", "SIREN", e.stSiren) +
      ligne("🏷", "SIRET (siège)", e.stSiret) +
      ligne("📍", "Adresse", e.stAdresse) +
      (e.etablissementsTotal != null ? ligne("🏬", "Établissements", e.etablissementsTotal + (e.etablissementsFermes ? " (dont " + e.etablissementsFermes + " fermés)" : "")) : "") +
      (etabs ? '<ul class="ent-etabs">' + etabs + "</ul>" : "") +
      '<p class="ent-source">Source : ' + escapeHtml(e._source || "annuaire public") + " — " +
      '<a href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + encodeURIComponent(e.stSiren || "") + '" target="_blank" rel="noopener">fiche complète ↗</a></p>';
  } catch (err) {
    $("#entCorps").innerHTML = '<p class="status err">Fiche indisponible : ' + escapeHtml(err.message) + "</p>";
  }
}

// Une ligne de contrat (ou d'avenant rattaché, indentée sous son parent).
// `demandes` : demandes de signature de CE contrat — badge d'état sur la ligne,
// suivi complet déplié au clic (le panneau « Signatures » séparé a disparu).
function ligneContrat(r, estAvenantRattache, demandes) {
  demandes = demandes || [];
  const tr = document.createElement("tr");
  tr.className = (estAvenantRattache ? "avenant-row " : "") + (r.statut === "clos" ? "contrat-clos" : "");
  const date = r.creeLe ? new Date(r.creeLe).toLocaleDateString("fr-FR") : "";
  const icone = r.statut === "clos" ? ico("cadenas") : r.type === "avenant" ? ico("avenant") : ico("document");
  const prefixe = estAvenantRattache ? '<span class="av-lien">└</span> ' : "";
  const alerte = alerteFin(r);
  const badge = r.statut === "clos" ? '<span class="badge-fin clos">🔒 clôturé</span>'
    : alerte ? '<span class="badge-fin ' + alerte.niveau + '">⏰ ' + alerte.texte + "</span>" : "";
  // Signé HORS application (mention cochée, PDF en pièce jointe dans le dossier) :
  // badge vert seulement si aucune demande de signature app ne raconte déjà l'histoire.
  const badgeExterne = r.signe && !demandes.length
    ? '<span class="badge-sig signe externe" title="Signé hors application — voir les fichiers du contrat">' + ico("coche") + " signé le " + r.signe.split("-").reverse().join("/") + "</span>"
    : "";
  tr.innerHTML =
    '<td class="col-sel"><input type="checkbox" class="sel-contrat" value="' + r.id + '" /></td>' +
    "<td>" + prefixe + '<span class="ico-doc">' + icone + '</span> <a class="lien-contrat" href="#" title="Ouvrir et modifier">' + escapeHtml(r.numero || "(sans n°)") + "</a> " + badge + badgeSignature(demandes) + badgeExterne +
    (estAvenantRattache ? ' <span class="av-note">avenant du contrat ' + escapeHtml(r.contratInitial || "") + "</span>" : "") + "</td>" +
    "<td>" + escapeHtml(TYPE_LABELS[r.type] || r.type || "") + "</td>" +
    "<td>" + escapeHtml(r.clientFinal || "") + "</td>" +
    "<td>" + escapeHtml(date) + "</td>" +
    '<td class="col-acts">' +
    '<a class="btn btn-ghost act-loupe" href="/api/contracts/' + r.id + '/pdf" target="_blank" rel="noopener" title="Voir le contrat (PDF)"><span class="ico-anim">' + ico("loupe") + '</span></a>' +
    '<span class="menu-acts"><button class="btn btn-ghost act-menu" title="Plus d’actions"><span class="ico-anim">⋮</span></button>' +
    '<span class="menu-pop hidden">' +
    '<button class="pop-ouvrir">' + ico("plume") + ' Modifier le contrat</button>' +
    (r.type !== "avenant" ? '<button class="pop-avenant">' + ico("avenant") + ' Créer un avenant</button>' : "") +
    '<button class="pop-fichiers">' + ico("dossier") + ' Fichiers générés</button>' +
    (r.signe ? '<button class="pop-designer">✕ Retirer la mention signé</button>'
             : '<button class="pop-signe">' + ico("coche") + ' Marquer signé (hors app)</button>') +
    '<button class="pop-cloture">' + (r.statut === "clos" ? ico("cadenasOuvert") + " Rouvrir" : ico("cadenas") + " Clôturer") + "</button>" +
    '<button class="pop-suppr danger">' + ico("corbeille") + ' Supprimer</button>' +
    "</span></span></td>";
  tr.querySelector(".lien-contrat").addEventListener("click", (e) => { e.preventDefault(); openContract(r.id); });
  tr.querySelector(".sel-contrat").addEventListener("change", majSelectionHist);
  const bSig = tr.querySelector(".badge-sig");
  if (bSig) bSig.addEventListener("click", () => toggleSignatures(tr, demandes));
  const pop = tr.querySelector(".menu-pop");
  tr.querySelector(".act-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const ouvert = !pop.classList.contains("hidden");
    fermerMenusHist();
    pop.classList.toggle("hidden", ouvert);
  });
  tr.querySelector(".pop-ouvrir").addEventListener("click", () => { fermerMenusHist(); openContract(r.id); });
  const bAv = tr.querySelector(".pop-avenant");
  if (bAv) bAv.addEventListener("click", () => { fermerMenusHist(); creerAvenantDepuis(r); });
  tr.querySelector(".pop-fichiers").addEventListener("click", () => { fermerMenusHist(); toggleFichiers(tr, r.base || ""); });
  const bExt = tr.querySelector(".badge-sig.externe");
  if (bExt) bExt.addEventListener("click", () => toggleFichiers(tr, r.base || ""));
  const bSigne = tr.querySelector(".pop-signe");
  if (bSigne) bSigne.addEventListener("click", () => { fermerMenusHist(); ouvrirSigneModal(r); });
  const bDesigner = tr.querySelector(".pop-designer");
  if (bDesigner) bDesigner.addEventListener("click", async () => {
    fermerMenusHist();
    if (!window.confirm("Retirer la mention « signé » du contrat " + (r.numero || "") + " ?\n(Le PDF déjà archivé reste dans le dossier.)")) return;
    await fetch("/api/contracts/" + r.id + "/signe", { method: "DELETE" });
    loadHistory();
  });
  tr.querySelector(".pop-cloture").addEventListener("click", () => { fermerMenusHist(); basculerCloture(r); });
  tr.querySelector(".pop-suppr").addEventListener("click", async () => {
    fermerMenusHist();
    if (!doubleConfirmation("le contrat " + (r.numero || "") + " de l’historique")) return;
    await fetch("/api/contracts/" + r.id, { method: "DELETE" });
    setStatus("Contrat " + (r.numero || "") + " déplacé dans la corbeille (restaurable dans Paramètres).", "ok");
    loadHistory();
  });
  return tr;
}

// Bandeau rouge « contrats en fin de vie » : avenant à créer, ou clôture.
function renderFinAlertes(rows) {
  const box = $("#finAlertes");
  const urgents = rows
    .map((r) => ({ r, a: alerteFin(r) }))
    .filter((x) => x.a)
    .sort((x, y) => x.a.jours - y.a.jours);
  box.classList.toggle("hidden", urgents.length === 0);
  box.innerHTML = "";
  urgents.forEach(({ r, a }) => {
    const div = document.createElement("div");
    div.className = "fin-carte " + a.niveau;
    div.innerHTML =
      '<span class="fin-ico">' + ico("horloge") + '</span>' +
      '<span class="fin-txt"><b>' + escapeHtml(r.numero || "(sans n°)") + "</b> — " + escapeHtml(r.sousTraitant || "") +
      (r.clientFinal ? " chez " + escapeHtml(r.clientFinal) : "") + " : <b>" + a.texte + "</b>" +
      (r.dateFin ? " (fin le " + r.dateFin.split("-").reverse().join("/") + ")" : "") +
      " — prolonger par avenant ou clôturer ?</span>" +
      '<span class="fin-acts">' +
      '<button class="btn btn-primary f-avenant">➕ Créer l’avenant</button>' +
      '<button class="btn f-cloturer">🔒 Clôturer</button>' +
      "</span>";
    div.querySelector(".f-avenant").addEventListener("click", () => creerAvenantDepuis(r));
    div.querySelector(".f-cloturer").addEventListener("click", () => basculerCloture(r));
    box.appendChild(div);
  });
}

let HIST_CACHE = [];
let SIGN_CACHE = []; // demandes de signature, intégrées aux lignes de l'historique
const GROUPES_OUVERTS = new Set(); // entreprises dépliées dans l'historique (accordéon)

// Demandes de signature d'un contrat : par dossier de stockage, sinon par numéro.
function demandesPour(r, attachees) {
  return SIGN_CACHE.filter((d) => {
    if (attachees.has(d.id)) return false;
    return (d.base && d.base === r.base) || (d.numero && d.numero === r.numero);
  });
}

function renderHistory(filtre) {
  const rows = HIST_CACHE;
  const body = $("#histBody");
  body.innerHTML = "";
  $("#histAll").checked = false;
  majSelectionHist();
  $("#histEmpty").classList.toggle("hidden", rows.length > 0 || SIGN_CACHE.length > 0);
  renderFinAlertes(rows);
  // Chaque demande de signature n'est rattachée qu'à UNE ligne (la plus récente).
  const attachees = new Set();

  const f = (filtre || "").trim().toLowerCase();
  const visible = (r) => !f || [r.numero, r.sousTraitant, r.clientFinal, r.type].some((x) => (x || "").toLowerCase().includes(f));

  // Organisation par entreprise (sous-traitant), avec les avenants rattachés
  // à leur contrat parent via le n° du contrat initial.
  const parents = rows.filter((r) => r.type !== "avenant");
  const avenants = rows.filter((r) => r.type === "avenant");
  const parNumero = {};
  parents.forEach((p) => { p.avenants = []; if (p.numero) parNumero[p.numero] = parNumero[p.numero] || p; });
  const orphelins = [];
  avenants.forEach((a) => {
    const parent = a.contratInitial && parNumero[a.contratInitial];
    if (parent) parent.avenants.push(a);
    else orphelins.push(a);
  });
  const groupes = new Map();
  const nomGroupe = (r) => (r.sousTraitant || "").trim() || "Sans entreprise";
  [...parents, ...orphelins].forEach((r) => {
    const nom = nomGroupe(r);
    if (!groupes.has(nom)) groupes.set(nom, []);
    groupes.get(nom).push(r);
  });

  [...groupes.keys()].sort((a, b) => a.localeCompare(b, "fr")).forEach((nom) => {
    // Un groupe reste affiché si lui ou l'un de ses contrats correspond au filtre.
    const items = groupes.get(nom).filter((r) => visible(r) || (r.avenants || []).some(visible) || nom.toLowerCase().includes(f));
    if (!items.length) return;
    const nb = items.reduce((n, r) => n + 1 + (r.avenants ? r.avenants.length : 0), 0);
    const siren = (items.find((r) => r.stSiren) || {}).stSiren || "";
    // Accordéon : replié par défaut (dossier par entreprise) ; un filtre actif déplie tout.
    const ouvert = f ? true : GROUPES_OUVERTS.has(nom);
    const nbAlertes = items.reduce((n, r) => n + (alerteFin(r) ? 1 : 0), 0);
    // État de signature du groupe (chip visible quand le dossier est replié).
    const demGroupe = [];
    items.forEach((r) => {
      demGroupe.push(...demandesPour(r, new Set(attachees)));
      (r.avenants || []).forEach((a) => demGroupe.push(...demandesPour(a, new Set(attachees))));
    });
    const enCours = demGroupe.filter((d) => d.statut === "envoyee");
    const aVousGrp = enCours.some((d) => !d.expiree && d.tour && d.tour.cote === "left");
    const chipSig = !ouvert && enCours.length
      ? (aVousGrp ? ' <span class="badge-sig avous">' + ico("plume") + ' à vous de signer</span>'
                  : ' <span class="badge-sig attente">' + ico("plume") + ' ' + enCours.length + " en signature</span>")
      : "";
    const trg = document.createElement("tr");
    trg.className = "grp-row" + (ouvert ? " ouvert" : "");
    trg.innerHTML = '<td colspan="6">' +
      '<span class="grp-chevron">' + ico("chevron") + '</span>' +
      '<span class="ico-anim grp-dossier">' + ico("immeuble") + '</span> <b>' + escapeHtml(nom) + "</b>" +
      ' <span class="grp-nb">' + nb + (nb > 1 ? " contrats" : " contrat") + "</span>" +
      (nbAlertes && !ouvert ? ' <span class="badge-fin rouge">⏰ ' + nbAlertes + " à traiter</span>" : "") +
      chipSig +
      ' <button class="grp-fiche btn btn-ghost" title="Fiche entreprise (annuaire public gouv.fr)">' + ico("immeuble") + ' Fiche entreprise</button></td>';
    trg.addEventListener("click", () => {
      if (GROUPES_OUVERTS.has(nom)) GROUPES_OUVERTS.delete(nom);
      else GROUPES_OUVERTS.add(nom);
      renderHistory(f);
    });
    trg.querySelector(".grp-fiche").addEventListener("click", (e) => {
      e.stopPropagation();
      ficheEntreprise(nom, siren);
    });
    body.appendChild(trg);
    items.forEach((r) => {
      const dR = demandesPour(r, attachees);
      dR.forEach((d) => attachees.add(d.id));
      if (ouvert) body.appendChild(ligneContrat(r, false, dR));
      (r.avenants || []).forEach((a) => {
        const dA = demandesPour(a, attachees);
        dA.forEach((d) => attachees.add(d.id));
        if (ouvert) body.appendChild(ligneContrat(a, true, dA));
      });
    });
  });

  // Demandes de signature sans contrat correspondant dans l'historique
  // (contrat supprimé ou jamais enregistré) : affichées quand même, à la suite.
  const orphelines = SIGN_CACHE.filter((d) => !attachees.has(d.id) &&
    (!f || (d.numero || "").toLowerCase().includes(f) || (d.titre || "").toLowerCase().includes(f)));
  if (orphelines.length) {
    const trh = document.createElement("tr");
    trh.className = "grp-row ouvert";
    trh.style.cursor = "default";
    trh.innerHTML = '<td colspan="6">' + ico("plume") + ' <b>Signatures sans contrat enregistré</b>' +
      ' <span class="grp-nb">' + orphelines.length + "</span></td>";
    body.appendChild(trh);
    const trc = document.createElement("tr");
    trc.className = "signature-row";
    const td = document.createElement("td");
    td.colSpan = 6;
    orphelines.forEach((d) => td.appendChild(carteDemande(d)));
    trc.appendChild(td);
    body.appendChild(trc);
  }
}

async function loadHistory() {
  try {
    const [contrats, demandes] = await Promise.all([
      getJSON("/api/contracts"),
      getJSON("/api/signatures").catch(() => []),
    ]);
    HIST_CACHE = contrats;
    SIGN_CACHE = demandes;
    majPastilleSignatures(demandes);
    renderHistory($("#histFiltre") ? $("#histFiltre").value : "");
  } catch (e) {
    setStatus("Erreur historique : " + e.message, "err");
  }
}

async function supprimerSelectionHist() {
  const ids = [...document.querySelectorAll("#histBody .sel-contrat:checked")].map((c) => c.value);
  if (!ids.length) return;
  if (!doubleConfirmation(ids.length + " contrat(s) de l’historique")) return;
  try {
    const r = await fetch("/api/contracts/supprimer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    setStatus(ids.length + " contrat(s) déplacé(s) dans la corbeille (restaurables dans Paramètres).", "ok");
  } catch (e) { setStatus("Erreur suppression : " + e.message, "err"); }
  loadHistory();
}

async function openContract(id) {
  try {
    const saved = await getJSON("/api/contracts/" + id);
    const type = saved.type || "sous-traitance";
    await loadType(type, {
      values: saved.values || {},
      options: saved.options || {},
      checklist: saved.checklist || {},
      docs: saved.docs || {},
      dates: saved.dates || {},
    });
    // Mode modification : \u00AB Enregistrer \u00BB mettra \u00E0 jour CETTE ligne d'historique.
    const v = saved.values || {};
    state.editing = { id, numero: v.numeroContrat || v.numeroAvenant || "" };
    majBandeauEdition();
    showView("editeur");
    setStatus("Contrat ouvert en modification.", "ok");
  } catch (e) {
    setStatus("Impossible d\u2019ouvrir ce contrat : " + e.message, "err");
  }
}

/* ------------------------------------------------------------------ */
/* Signature électronique (façon Zoho Sign) + fichiers stockés         */
/* ------------------------------------------------------------------ */
function openSignModal() {
  if (!validateRequired()) return;
  // Pré-remplissage : partie 1 = ADBI, partie 2 = co-contractant. Pour un
  // AVENANT, les MÊMES personnes que le contrat initial sont reprises
  // (récap avenantParent) — modifiables si ça a changé.
  const parent = state.avenantParent || {};
  const estAvenant = state.type === "avenant";
  $("#sp1nom").value = (estAvenant ? state.values.avPartie1Repr || parent.adbiRepresentant : state.values.adbiRepresentant) || "";
  $("#sp1email").value = state.values.bmEmail || parent.bmEmail || "";
  $("#sp2nom").value = (estAvenant ? state.values.avPartie2Repr || parent.stRepresentant : state.values.stSignataireNom || state.values.stRepresentant) || "";
  $("#sp2email").value = state.values.stEmail || parent.stEmail || "";
  $("#signEcheance").value = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  $("#signStatus").textContent = "";
  $("#signStep1").classList.remove("hidden");
  $("#signStep2").classList.add("hidden");
  $("#signModal").classList.remove("hidden");
}

async function createSignRequest() {
  const p1 = { nom: $("#sp1nom").value.trim(), email: $("#sp1email").value.trim(), role: "Client (ADBI)" };
  const p2 = { nom: $("#sp2nom").value.trim(), email: $("#sp2email").value.trim(), role: "Co-contractant" };
  if (!p1.email || !p2.email) {
    $("#signStatus").textContent = "Renseignez les deux adresses e-mail.";
    $("#signStatus").className = "status err";
    return;
  }
  $("#signStatus").textContent = "Création de la demande…";
  $("#signStatus").className = "status";
  $("#signCreate").disabled = true;
  try {
    const r = await fetch("/api/signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign(payload(), {
        signataires: { partie1: p1, partie2: p2 },
        echeance: $("#signEcheance").value,
      })),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "Erreur " + r.status);
    renderSignLinks(d.demande, d.envoiAuto);
    $("#signStep1").classList.add("hidden");
    $("#signStep2").classList.remove("hidden");
  } catch (e) {
    $("#signStatus").textContent = "Échec : " + e.message;
    $("#signStatus").className = "status err";
  }
  $("#signCreate").disabled = false;
}

function renderSignLinks(demande, envoiAuto) {
  const box = $("#signLinks");
  box.innerHTML = "";
  // La demande vit chez le CONNECTEUR (Yousign…) : il envoie les invitations,
  // les relances et le code de vérification — ici on récapitule l'ordre.
  const ban = document.createElement("div");
  ban.className = "envoi-banniere ok";
  ban.innerHTML = "📨 <b>Enveloppe créée chez " + escapeHtml((envoiAuto && envoiAuto.fournisseur) || demande.fournisseur || "le fournisseur") + "</b> — " +
    "l'invitation part au 1er signataire, le 2e est invité dès la 1re signature (relances automatiques). " +
    "À la fin : PDF signé + dossier de preuve, récupérés par « Synchroniser » ou automatiquement via webhook.";
  box.appendChild(ban);
  [...(demande.signataires || [])].sort((a, b) => (a.rang || 0) - (b.rang || 0)).forEach((s) => {
    const premier = s.rang === 1;
    const row = document.createElement("div");
    row.className = "sign-link-row";
    row.innerHTML =
      '<div class="qui"><span class="rang-badge' + (premier ? "" : " deux") + '">' + (premier ? "1er à signer" : s.rang + "e à signer") + "</span> " +
      escapeHtml(s.role + " — " + (s.nom || "")) + "</div>" +
      '<div class="mail">' + escapeHtml(s.email) +
      (premier ? " — invitation envoyée par e-mail" : " — sera invité après la 1re signature") + "</div>" +
      (s.url ? '<div class="acts"><a class="btn" href="' + s.url + '" target="_blank" rel="noopener">✍ Ouvrir la page de signature</a></div>' : "");
    box.appendChild(row);
  });
}

// Pastille « à vous de signer » sur l'onglet Historique : nombre de demandes
// où c'est au tour d'ADBI (partie « left ») de signer.
function majPastilleSignatures(rows) {
  const nav = document.querySelector('.nav-item[data-view="signatures"]');
  if (!nav) return;
  let p = nav.querySelector(".pastille-sign");
  const n = (rows || []).filter((d) => d.statut === "envoyee" && d.tour && d.tour.cote === "left").length;
  if (!n) { if (p) p.remove(); return; }
  if (!p) { p = document.createElement("span"); p.className = "pastille-sign"; nav.appendChild(p); }
  p.textContent = n;
  p.title = n + " document(s) à signer par ADBI";
}

// Carte de suivi d'UNE demande de signature — affichée dans l'historique, dépliée
// sous la ligne du contrat concerné (plus de panneau « Signatures » séparé).
function carteDemande(d) {
  const ETATS = { envoyee: "En attente de signature", complete: "Signée par toutes les parties", annulee: "Annulée" };
  // Toute demande vit chez un CONNECTEUR (Yousign…) : invitations, relances et
  // page de signature sont chez lui — ici : statut, synchronisation, documents.
  // (`externe` reste faux pour les anciennes demandes locales, lisibles en archive.)
  const externe = d.fournisseur && d.fournisseur !== "local";
  const aVous = !d.expiree && d.statut === "envoyee" && d.tour && d.tour.cote === "left";
  const it = document.createElement("div");
  it.className = "sign-item" + (aVous ? " a-vous" : "") + (d.expiree ? " expiree" : "");
  const parties = (d.signataires || []).map((s) =>
    '<span class="rang">' + (s.rang === 1 ? "1er" : s.rang + "e") + "</span> <b>" + escapeHtml(s.nom || s.role) + "</b> (" + escapeHtml(s.email) + ") : " +
    (s.statut === "signe" ? '<span class="sig-ok">signé le ' + escapeHtml(s.signeLe || "") + " ✓</span>"
      : (d.tour && d.tour.rang === s.rang ? '<span class="sig-attente">à lui de signer maintenant</span>' : "attendra son tour"))).join(" &nbsp;·&nbsp; ");
  const echBadge = d.statut !== "envoyee" || !d.echeanceFr ? ""
    : d.expiree ? '<span class="badge-fin rouge">⏰ délai dépassé (' + d.echeanceFr + ")</span>"
    : '<span class="ech-info">⏰ à signer avant le ' + d.echeanceFr + "</span>";
  it.innerHTML =
    '<div class="ligne1"><span class="ref">SIG-' + d.id + " — " + escapeHtml(d.numero || "") + "</span>" +
    "<span>" + escapeHtml(d.titre || "") + "</span>" +
    (aVous ? '<span class="badge-etat a-vous-badge">✍ À vous de signer</span>'
           : '<span class="badge-etat ' + d.statut + '">' + (ETATS[d.statut] || d.statut) + "</span>") +
    (externe ? '<span class="chip-fournisseur" title="Demande gérée par le tiers de confiance">via ' + escapeHtml(d.fournisseur) + "</span>" : "") +
    echBadge +
    "</div>" +
    '<div class="parties">' + parties + "</div>" +
    '<div class="acts"></div>';
  const acts = it.querySelector(".acts");
  const addBtn = (label, cls, fn, primaire) => {
    const b = document.createElement(cls === "a" ? "a" : "button");
    b.className = "btn" + (primaire ? " btn-primary" : "");
    b.innerHTML = label;
    if (cls === "a") { b.href = fn; b.target = "_blank"; b.rel = "noopener"; }
    else b.addEventListener("click", fn);
    acts.appendChild(b);
    return b;
  };
  if (aVous) {
    // Le lien pointe vers la page de signature DU FOURNISSEUR (sinon : l'e-mail reçu).
    const moi = (d.signataires || []).find((s) => s.cote === "left");
    if (moi && moi.url) addBtn('<span class="ico-anim">' + ico("plume") + '</span> Signer maintenant', "a", moi.url, true);
  }
  // Synchronisation : statut chez le fournisseur + téléchargement du PDF signé
  // et du dossier de preuve à la fin (relances/délais gérés par le fournisseur).
  if (externe && d.statut === "envoyee") {
    addBtn("🔄 Synchroniser le statut", "b", async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await fetch("/api/signatures/" + d.id + "/synchroniser", { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { alert(j.error || "Erreur " + r.status); ev.target.disabled = false; return; }
        rafraichirSuivi();
      } catch (e) { ev.target.disabled = false; }
    }, true);
  }
  addBtn(ico("document") + (d.statut === "complete" ? " PDF signé" : " PDF (état actuel)"), "a", "/api/signatures/" + d.id + "/pdf");
  if (d.statut === "complete") {
    // Le certificat (local) ou le dossier de preuve (fournisseur) — document séparé.
    addBtn(ico("certificat") + (externe ? " Dossier de preuve" : " Certificat de signature"), "a", "/api/signatures/" + d.id + "/certificat");
  }
  addBtn(ico("corbeille") + " Supprimer", "b", async () => {
    if (!doubleConfirmation("la demande de signature SIG-" + d.id + " (les liens cesseront de fonctionner)")) return;
    await fetch("/api/signatures/" + d.id, { method: "DELETE" });
    setStatus("Demande SIG-" + d.id + " déplacée dans la corbeille (restaurable dans Paramètres).", "ok");
    rafraichirSuivi();
  });
  return it;
}

// Badge d'état de signature affiché SUR la ligne du contrat (cliquable → détail).
function badgeSignature(demandes) {
  if (!demandes || !demandes.length) return "";
  const d = demandes[0]; // la plus récente
  const suffixe = demandes.length > 1 ? " (+" + (demandes.length - 1) + ")" : "";
  if (d.statut === "complete") {
    return '<span class="badge-sig signe" title="Voir le suivi de signature">' + ico("coche") + ' signé' + suffixe + "</span>";
  }
  if (d.statut === "envoyee") {
    if (d.expiree) return '<span class="badge-sig expiree" title="Voir le suivi de signature">' + ico("horloge") + ' signature expirée' + suffixe + "</span>";
    if (d.tour && d.tour.cote === "left") return '<span class="badge-sig avous" title="Voir le suivi de signature">' + ico("plume") + ' À vous de signer' + suffixe + "</span>";
    return '<span class="badge-sig attente" title="Voir le suivi de signature">' + ico("plume") + ' en signature : ' + escapeHtml(d.tour ? d.tour.nom : "") + suffixe + "</span>";
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Corbeille + double confirmation des suppressions sensibles           */
/* ------------------------------------------------------------------ */

// Suppression SENSIBLE = deux confirmations successives, en insistant.
// L'élément part ensuite dans la corbeille (restaurable dans Paramètres).
function doubleConfirmation(quoi) {
  if (!window.confirm("Supprimer " + quoi + " ?\n\nL'élément partira dans la CORBEILLE (restaurable dans Paramètres → Corbeille).")) return false;
  return window.confirm("⚠️ DERNIÈRE CONFIRMATION\n\nÊtes-vous VRAIMENT sûr de supprimer " + quoi + " ?");
}

async function loadCorbeille() {
  try {
    const rows = await getJSON("/api/corbeille");
    const liste = $("#corbListe");
    liste.innerHTML = "";
    $("#corbVide").classList.toggle("hidden", rows.length > 0);
    $("#corbStatus").textContent = "";
    rows.forEach((r) => {
      const l = document.createElement("label");
      l.className = "corb-ligne";
      const quand = r.supprimeLe ? new Date(r.supprimeLe).toLocaleString("fr-FR") : "";
      l.innerHTML =
        '<input type="checkbox" class="corb-sel" value="' + r.id + '" />' +
        '<span class="corb-type">' + (r.type === "contrat" ? ico("document") + " Contrat" : ico("plume") + " Signature") + "</span>" +
        '<span class="corb-libelle">' + escapeHtml(r.libelle || "") + "</span>" +
        '<span class="corb-date">supprimé le ' + escapeHtml(quand) + "</span>";
      liste.appendChild(l);
    });
  } catch (e) {
    $("#corbStatus").textContent = "Corbeille indisponible : " + e.message;
  }
}

function corbSelection() {
  return [...document.querySelectorAll(".corb-sel:checked")].map((c) => c.value);
}

async function corbRestaurer() {
  const ids = corbSelection();
  const st = $("#corbStatus");
  if (!ids.length) { st.textContent = "Coche d'abord ce que tu veux restaurer."; st.className = "status err"; return; }
  const r = await fetch("/api/corbeille/restaurer", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...enteteCode() },
    body: JSON.stringify({ ids }),
  });
  const j = await r.json().catch(() => ({}));
  st.textContent = r.ok ? "♻ " + j.restaures + " élément(s) restauré(s) — retrouve-les dans l'Historique / Signatures." : (j.error || "Erreur " + r.status);
  st.className = "status " + (r.ok ? "ok" : "err");
  loadCorbeille();
  loadHistory();
}

async function corbPurger() {
  const ids = corbSelection();
  const st = $("#corbStatus");
  if (!ids.length) { st.textContent = "Coche d'abord ce que tu veux purger."; st.className = "status err"; return; }
  if (!doubleConfirmation(ids.length + " élément(s) DÉFINITIVEMENT (il n'y aura plus AUCUN moyen de les restaurer)")) return;
  const r = await fetch("/api/corbeille/purger", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...enteteCode() },
    body: JSON.stringify({ ids }),
  });
  const j = await r.json().catch(() => ({}));
  st.textContent = r.ok ? j.purges + " élément(s) supprimé(s) définitivement." : (j.error || "Erreur " + r.status);
  st.className = "status " + (r.ok ? "ok" : "err");
  loadCorbeille();
}

/* ------------------------------------------------------------------ */
/* Signature externe + import de contrats existants                     */
/* ------------------------------------------------------------------ */

// Lit un fichier PDF choisi par l'utilisateur en dataURL (25 Mo max).
function lirePdf(input) {
  return new Promise((resolve, reject) => {
    const f = input.files && input.files[0];
    if (!f) return resolve(null);
    if (f.type !== "application/pdf") return reject(new Error("Choisis un fichier PDF."));
    if (f.size > 25 * 1024 * 1024) return reject(new Error("PDF trop lourd (25 Mo max)."));
    const lecteur = new FileReader();
    lecteur.onload = () => resolve({ nom: f.name, contenu: lecteur.result });
    lecteur.onerror = () => reject(new Error("Lecture du fichier impossible."));
    lecteur.readAsDataURL(f);
  });
}

// Modal « Marquer signé » : contrat signé HORS application, PDF en pièce jointe.
let SIGNE_CIBLE = null;
function ouvrirSigneModal(r) {
  SIGNE_CIBLE = r;
  $("#signeNumero").textContent = r.numero || "(sans n°)";
  $("#signeDate").value = new Date().toISOString().slice(0, 10);
  $("#signeFichier").value = "";
  $("#signeStatus").textContent = "";
  $("#signeModal").classList.remove("hidden");
}

async function validerSigneExterne() {
  if (!SIGNE_CIBLE) return;
  const st = $("#signeStatus");
  st.textContent = "Enregistrement…";
  st.className = "status";
  try {
    const fichier = await lirePdf($("#signeFichier"));
    const r = await fetch("/api/contracts/" + SIGNE_CIBLE.id + "/signe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: $("#signeDate").value, fichier }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "Erreur " + r.status);
    $("#signeModal").classList.add("hidden");
    setStatus("Contrat " + (SIGNE_CIBLE.numero || "") + " marqué signé" + (j.fichier ? " — PDF archivé dans le dossier." : "."), "ok");
    loadHistory();
  } catch (e) {
    st.textContent = "Échec : " + e.message;
    st.className = "status err";
  }
}

// Modal « Importer un contrat existant » : le PDF + les infos clés rejoignent
// l'historique comme n'importe quel contrat créé dans l'application.
function ouvrirImportModal() {
  $("#impStatus").textContent = "";
  $("#impSigneLe").value = new Date().toISOString().slice(0, 10);
  $("#importModal").classList.remove("hidden");
  attacherDatalistContrats(); // alimente la liste des n° pour le rattachement d'avenant
  basculerChampsImport();
}

function basculerChampsImport() {
  const avenant = $("#impType").value === "avenant";
  $("#impNumWrap").classList.toggle("hidden", avenant);
  $("#impNumAvWrap").classList.toggle("hidden", !avenant);
  $("#impInitialWrap").classList.toggle("hidden", !avenant);
}

async function validerImport() {
  const st = $("#impStatus");
  st.textContent = "Import en cours…";
  st.className = "status";
  try {
    const type = $("#impType").value;
    const avenant = type === "avenant";
    const values = {
      stNom: avenant ? "" : $("#impSt").value.trim(),
      avPartie2Nom: avenant ? $("#impSt").value.trim() : "",
      clientFinal: $("#impClient").value.trim(),
      consultantNom: $("#impConsultant").value.trim(),
      tjm: $("#impTjm").value.trim(),
      dateDebut: $("#impDebut").value,
      dateFin: $("#impFin").value,
      numeroContrat: avenant ? "" : $("#impNumero").value.trim(),
      numeroAvenant: avenant ? $("#impNumAvenant").value.trim() : "",
      numeroContratInitial: avenant ? $("#impInitial").value.trim() : "",
      contratType: avenant ? "sous-traitance" : "",
    };
    const fichier = await lirePdf($("#impFichier"));
    if (!fichier) throw new Error("Choisis le PDF du contrat à importer.");
    const r = await fetch("/api/contracts/importer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type, values, fichier,
        signeLe: $("#impSigne").checked ? $("#impSigneLe").value : "",
      }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "Erreur " + r.status);
    $("#importModal").classList.add("hidden");
    ["impNumero", "impNumAvenant", "impInitial", "impSt", "impClient", "impConsultant", "impTjm", "impDebut", "impFin", "impFichier"]
      .forEach((id) => { $("#" + id).value = ""; });
    setStatus("Contrat importé dans le dossier — PDF archivé, historique à jour.", "ok");
    showView("historique");
  } catch (e) {
    st.textContent = "Échec : " + e.message;
    st.className = "status err";
  }
}

// Recharge la vue de suivi active (Signatures ou Historique) après une action.
function rafraichirSuivi() {
  const vueSign = document.getElementById("view-signatures");
  if (vueSign && !vueSign.classList.contains("hidden")) loadVueSignatures();
  else loadHistory();
}

// Vue « Signatures » (ADBI Sign dans le module) : stats + toutes les demandes.
async function loadVueSignatures() {
  try {
    const rows = await getJSON("/api/signatures");
    SIGN_CACHE = rows;
    majPastilleSignatures(rows);
    const stats = $("#signStats");
    const enCours = rows.filter((d) => d.statut === "envoyee" && !d.expiree);
    const aVous = enCours.filter((d) => d.tour && d.tour.cote === "left").length;
    const expirees = rows.filter((d) => d.expiree).length;
    const signees = rows.filter((d) => d.statut === "complete").length;
    stats.innerHTML =
      '<span class="stat-chip attente">⏳ ' + enCours.length + " en attente</span>" +
      (aVous ? '<span class="stat-chip avous">✍ ' + aVous + " à vous de signer</span>" : "") +
      (expirees ? '<span class="stat-chip expiree">⏰ ' + expirees + " expirée(s)</span>" : "") +
      '<span class="stat-chip ok">✔ ' + signees + " signée(s)</span>";
    const liste = $("#listeSignatures");
    liste.innerHTML = "";
    $("#signVide").classList.toggle("hidden", rows.length > 0);
    rows.forEach((d) => liste.appendChild(carteDemande(d)));
  } catch (e) {
    setStatus("Erreur signatures : " + e.message, "err");
  }
}

// Suivi de signature déplié sous la ligne du contrat (comme les fichiers).
function toggleSignatures(tr, demandes) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("signature-row")) { next.remove(); return; }
  document.querySelectorAll("tr.signature-row").forEach((x) => x.remove());
  const row = document.createElement("tr");
  row.className = "signature-row";
  const td = document.createElement("td");
  td.colSpan = tr.children.length;
  demandes.forEach((d) => td.appendChild(carteDemande(d)));
  row.appendChild(td);
  tr.after(row);
}

// Fichiers stockés d'un contrat : ligne dépliante sous la ligne d'historique.
async function toggleFichiers(tr, base) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("fichiers-row")) { next.remove(); return; }
  document.querySelectorAll("tr.fichiers-row").forEach((x) => x.remove());
  const row = document.createElement("tr");
  row.className = "fichiers-row";
  const td = document.createElement("td");
  td.colSpan = tr.children.length;
  td.innerHTML = '<div class="fichiers-liste muted">Chargement…</div>';
  row.appendChild(td);
  tr.after(row);
  try {
    const fichiers = await getJSON("/api/fichiers/" + encodeURIComponent(base));
    const liste = td.querySelector(".fichiers-liste");
    if (!fichiers.length) {
      liste.textContent = "Aucun fichier stocké pour ce contrat (les exports PDF / Word / ZIP y sont archivés automatiquement).";
      return;
    }
    liste.classList.remove("muted");
    liste.innerHTML = "";
    fichiers.forEach((f) => {
      const a = document.createElement("a");
      a.href = "/api/fichiers/" + encodeURIComponent(base) + "/" + encodeURIComponent(f.nom);
      a.textContent = "📎 " + f.nom;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = Math.max(1, Math.round(f.taille / 1024)) + " Ko";
      a.appendChild(meta);
      liste.appendChild(a);
    });
  } catch (e) {
    td.querySelector(".fichiers-liste").textContent = "Erreur : " + e.message;
  }
}

/* ------------------------------------------------------------------ */
/* Éditeur de modèles (Paramètres → « Modèles de contrat »)            */
/* ------------------------------------------------------------------ */
const TPL_TAGS = { h2: "Titre d'article", h3: "Sous-titre", p: "Paragraphe", dash: "Tiret –", li: "Puce •", "annexe-title": "Titre d'annexe" };
const TPL_EDIT = { type: "sous-traitance", data: null };

async function loadTplEditor(type) {
  if (type) TPL_EDIT.type = type;
  const sel = $("#tplType");
  try {
    // Le sélecteur de type est rempli une fois (les titres reflètent les retouches).
    if (!sel.options.length) {
      const types = await getJSON("/api/types");
      types.forEach((t) => {
        const o = document.createElement("option");
        o.value = t.id;
        o.textContent = t.titre + (t.stub ? " (à venir)" : "");
        sel.appendChild(o);
      });
    }
    sel.value = TPL_EDIT.type;
    TPL_EDIT.data = await getJSON("/api/templates-perso/" + TPL_EDIT.type);
    renderTplEditor(TPL_EDIT.data);
  } catch (e) {
    $("#tplCompteur").textContent = "Éditeur de modèle indisponible : " + e.message;
  }
}

function renderTplEditor(d) {
  const meta = $("#tplMeta"), list = $("#tplBlocs");
  meta.innerHTML = "";
  list.innerHTML = "";
  $("#tplStatus").textContent = "";
  $("#tplFiltre").value = "";
  const nMod = (d.blocs || []).filter((b) => b.modifie).length;
  $("#tplCompteur").textContent = d.stub
    ? "Modèle à venir pour ce type : rien à modifier."
    : d.blocs.length + " blocs de texte" + (nMod ? " — " + nMod + " personnalisé(s)" : " — aucun personnalisé");
  if (d.stub) return;

  (d.meta || []).forEach((m) => {
    const row = document.createElement("label");
    row.className = "tpl-meta-row";
    const lib = document.createElement("span");
    lib.textContent = m.libelle;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = m.texte || "";
    inp.placeholder = m.original || m.defaut || "";
    inp.dataset.cle = m.cle;
    row.append(lib, inp);
    meta.appendChild(row);
  });

  // ÉDITION FLUIDE : le modèle s'affiche comme UN document continu (titres,
  // paragraphes, puces) directement éditable au clic — plus de cases séparées.
  // Chaque élément reste rattaché à son bloc d'origine (data-i) pour la
  // sauvegarde et la réversibilité bloc par bloc (bouton ↺ au survol).
  const page = document.createElement("div");
  page.className = "tpl-doc";
  (d.blocs || []).forEach((b) => {
    const ligne = document.createElement("div");
    ligne.className = "tpl-ligne" + (b.modifie ? " modifie" : "");
    const el = document.createElement("div");
    el.className = "tpl-el t-" + b.t;
    el.dataset.i = b.i;
    el.dataset.original = b.original;
    el.textContent = b.texte;
    el.title = TPL_TAGS[b.t] || b.t;
    // plaintext-only : la frappe ne crée jamais de HTML (repli : contenteditable simple).
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.addEventListener("input", () => ligne.classList.toggle("modifie", el.textContent !== b.original));
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "tpl-el-reset";
    reset.title = "Revenir au texte d’origine de ce bloc";
    reset.textContent = "↺";
    reset.addEventListener("mousedown", (e) => {
      e.preventDefault(); // ne pas voler le focus au bloc en cours d'édition
      el.textContent = b.original;
      ligne.classList.remove("modifie");
    });
    ligne.append(el, reset);
    page.appendChild(ligne);
  });
  list.appendChild(page);
}

// Recharge le type courant de l'éditeur de contrat SANS perdre le brouillon en cours.
async function rechargerTypeCourant() {
  if (state.type !== TPL_EDIT.type) return;
  const ed = state.editing;
  await loadType(state.type, {
    values: state.values, options: state.optionState,
    checklist: state.checkState, docs: state.docState, dates: state.dateState,
  });
  state.editing = ed;
  majBandeauEdition();
}

async function tplSauver() {
  const d = TPL_EDIT.data;
  if (!d || d.stub) return;
  const meta = {};
  document.querySelectorAll("#tplMeta input").forEach((i) => { meta[i.dataset.cle] = i.value; });
  const blocs = [...document.querySelectorAll("#tplBlocs .tpl-el")].map((el) => ({
    i: parseInt(el.dataset.i, 10),
    original: el.dataset.original,
    texte: el.textContent,
  }));
  $("#tplStatus").textContent = "Enregistrement…";
  $("#tplStatus").className = "status";
  try {
    const r = await fetch("/api/templates-perso/" + TPL_EDIT.type, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...enteteCode() },
      body: JSON.stringify({ meta, blocs }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "Erreur " + r.status);
    await loadTplEditor();
    $("#tplStatus").textContent = j.blocsModifies || j.metaModifiees
      ? "Modèle enregistré : " + j.blocsModifies + " bloc(s) et " + j.metaModifiees + " métadonnée(s) personnalisés — aperçu et exports à jour."
      : "Aucun écart avec le modèle d'origine : rien à retenir.";
    $("#tplStatus").className = "status ok";
    getJSON("/api/types").then(buildTypeButtons).catch(() => {});
    await rechargerTypeCourant();
  } catch (e) {
    $("#tplStatus").textContent = "Échec : " + e.message;
    $("#tplStatus").className = "status err";
  }
}

async function tplToutReinitialiser() {
  if (!TPL_EDIT.data || TPL_EDIT.data.stub) return;
  if (!window.confirm("Revenir au modèle d'origine pour « " + $("#tplType").selectedOptions[0].textContent + " » ?\nToutes les personnalisations de texte de ce type seront supprimées.")) return;
  await fetch("/api/templates-perso/" + TPL_EDIT.type, { method: "DELETE", headers: enteteCode() });
  await loadTplEditor();
  $("#tplStatus").textContent = "Modèle d'origine restauré.";
  $("#tplStatus").className = "status ok";
  getJSON("/api/types").then(buildTypeButtons).catch(() => {});
  await rechargerTypeCourant();
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */
function showView(name) {
  // Écran Paramètres protégé : le code est demandé une fois par session de navigation.
  if (name === "parametres" && !codeParamActuel()) { ouvrirCodeModal(); return; }
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  const el = document.getElementById("view-" + name);
  if (el) el.classList.remove("hidden");
  if (name === "historique") loadHistory();
  if (name === "signatures") loadVueSignatures();
  if (name === "parametres") { loadSettings(); loadCorbeille(); loadTplEditor().catch(() => {}); }
  if (name === "referentiels") loadReferentiels();
  if (name === "editeur" && state.fields.length) buildForm(); // rafraîchit BM + autocomplétions
}

// Met à jour une valeur de champ + son input dans le DOM (utilisé par la recherche société et l'IA).
function setFieldValue(key, val) {
  state.values[key] = val;
  const el = document.getElementById("f_" + key);
  if (el) { el.value = val; if (String(val).trim()) el.classList.remove("invalid"); }
}

/* ------------------------------------------------------------------ */
/* Câblage des actions                                                 */
/* ------------------------------------------------------------------ */
function wire() {
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });
  $("#refreshHist").addEventListener("click", loadHistory);
  $("#refreshSignVue").addEventListener("click", loadVueSignatures);
  $("#corbRafraichir").addEventListener("click", loadCorbeille);
  $("#corbRestaurer").addEventListener("click", corbRestaurer);
  $("#corbPurger").addEventListener("click", corbPurger);
  // Connecteur de signature : bascule Yousign/Zoho + échange de code OAuth
  $("#setSignFournisseur").addEventListener("change", majEtatConnecteur);
  $("#btnZohoEchanger").addEventListener("click", zohoEchangerCode);
  // Code d'accès aux Paramètres
  $("#codeValider").addEventListener("click", validerCodeParametres);
  $("#codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") validerCodeParametres(); });
  $("#codeClose").addEventListener("click", () => $("#codeModal").classList.add("hidden"));
  $("#codeModal").addEventListener("click", (e) => { if (e.target === $("#codeModal")) $("#codeModal").classList.add("hidden"); });
  $("#btnImporter").addEventListener("click", ouvrirImportModal);
  $("#btnImporter2").addEventListener("click", ouvrirImportModal);
  $("#impType").addEventListener("change", basculerChampsImport);
  $("#impCreer").addEventListener("click", validerImport);
  $("#importClose").addEventListener("click", () => $("#importModal").classList.add("hidden"));
  $("#importModal").addEventListener("click", (e) => { if (e.target === $("#importModal")) $("#importModal").classList.add("hidden"); });
  $("#signeValider").addEventListener("click", validerSigneExterne);
  $("#signeClose").addEventListener("click", () => $("#signeModal").classList.add("hidden"));
  $("#signeModal").addEventListener("click", (e) => { if (e.target === $("#signeModal")) $("#signeModal").classList.add("hidden"); });
  $("#btnSaveSettings").addEventListener("click", saveSettings);
  document.querySelectorAll(".set-test").forEach((b) => {
    b.addEventListener("click", () => testConnection(b.dataset.provider, b));
  });
  $("#btnMail").addEventListener("click", () => {
    $("#mailText").value = buildMail();
    $("#mailBox").classList.remove("hidden");
    copyMail();
  });
  $("#btnCopyMail").addEventListener("click", copyMail);

  $("#btnPdf").addEventListener("click", async () => {
    if (!validateRequired()) return;
    try { const n = await exportBlob("/api/export/pdf", "contrat.pdf"); setStatus("PDF g\u00E9n\u00E9r\u00E9 : " + n, "ok"); }
    catch (e) { setStatus(e.message, "err"); }
  });
  $("#btnWord").addEventListener("click", async () => {
    if (!validateRequired()) return;
    try { const n = await exportBlob("/api/export/docx", "contrat.docx"); setStatus("Word g\u00E9n\u00E9r\u00E9 : " + n, "ok"); }
    catch (e) { setStatus(e.message, "err"); }
  });
  $("#btnZip").addEventListener("click", async () => {
    if (!validateRequired()) return;
    try { const n = await exportBlob("/api/export/zip", "contrat.zip"); setStatus("ZIP g\u00E9n\u00E9r\u00E9 : " + n, "ok"); }
    catch (e) { setStatus(e.message, "err"); }
  });
  $("#btnSave").addEventListener("click", async () => {
    if (!validateRequired()) return;
    try {
      setStatus("Enregistrement\u2026");
      // Mode modification : mise \u00E0 jour de la ligne existante ; sinon cr\u00E9ation.
      const url = state.editing ? "/api/contracts/" + state.editing.id : "/api/save";
      const r = await fetch(url, {
        method: state.editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      if (state.editing) {
        state.editing.numero = state.values.numeroContrat || state.values.numeroAvenant || "";
        majBandeauEdition();
        setStatus("Contrat mis \u00E0 jour dans l\u2019historique.", "ok");
      } else if (d.id) {
        // Le contrat existe maintenant : les enregistrements suivants le mettront \u00E0 jour.
        state.editing = { id: d.id, numero: state.values.numeroContrat || state.values.numeroAvenant || "" };
        majBandeauEdition();
        setStatus("Contrat enregistr\u00E9 dans l\u2019historique.", "ok");
      } else {
        setStatus("Contrat enregistr\u00E9 dans l\u2019historique.", "ok");
      }
    } catch (e) { setStatus("Erreur d\u2019enregistrement : " + e.message, "err"); }
  });
  // Bandeau modification : \u00AB enregistrer comme nouveau \u00BB + quitter le mode.
  $("#editSaveNew").addEventListener("click", async () => {
    if (!validateRequired()) return;
    try {
      const r = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      if (d.id) state.editing = { id: d.id, numero: state.values.numeroContrat || state.values.numeroAvenant || "" };
      majBandeauEdition();
      setStatus("Copie enregistr\u00E9e comme nouveau contrat.", "ok");
    } catch (e) { setStatus("Erreur : " + e.message, "err"); }
  });
  $("#editQuit").addEventListener("click", () => {
    state.editing = null;
    majBandeauEdition();
    setStatus("Mode modification quitt\u00E9 \u2014 \u00AB Enregistrer \u00BB cr\u00E9era un nouveau contrat.", "ok");
  });

  // Signature \u00E9lectronique
  $("#btnSign").addEventListener("click", openSignModal);
  $("#signCreate").addEventListener("click", createSignRequest);
  $("#signClose").addEventListener("click", () => $("#signModal").classList.add("hidden"));
  $("#signDone").addEventListener("click", () => {
    $("#signModal").classList.add("hidden");
    showView("historique");
  });
  $("#signModal").addEventListener("click", (e) => {
    if (e.target === $("#signModal")) $("#signModal").classList.add("hidden");
  });
  // Historique : sélection groupée + fermeture des menus ⋮ au clic ailleurs
  $("#histAll").addEventListener("change", () => {
    document.querySelectorAll("#histBody .sel-contrat").forEach((c) => { c.checked = $("#histAll").checked; });
    majSelectionHist();
  });
  $("#histDelSel").addEventListener("click", supprimerSelectionHist);
  document.addEventListener("click", fermerMenusHist);
  // Filtre plein-texte de l'historique + fiche entreprise
  $("#histFiltre").addEventListener("input", () => renderHistory($("#histFiltre").value));
  // Éditeur de modèles (Paramètres)
  $("#tplType").addEventListener("change", () => loadTplEditor($("#tplType").value));
  $("#tplSave").addEventListener("click", tplSauver);
  $("#tplResetAll").addEventListener("click", tplToutReinitialiser);
  $("#tplFiltre").addEventListener("input", () => {
    // Dans le document fluide, la recherche SURLIGNE et fait défiler jusqu'au
    // premier passage trouvé (au lieu de découper le document en morceaux).
    const q = $("#tplFiltre").value.trim().toLowerCase();
    let premier = null;
    document.querySelectorAll("#tplBlocs .tpl-ligne").forEach((ligne) => {
      const el = ligne.querySelector(".tpl-el");
      const trouve = !!q && (el.textContent.toLowerCase().includes(q) || el.dataset.original.toLowerCase().includes(q));
      ligne.classList.toggle("trouve", trouve);
      if (trouve && !premier) premier = ligne;
    });
    if (premier) premier.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  $("#entClose").addEventListener("click", () => $("#entModal").classList.add("hidden"));
  $("#entModal").addEventListener("click", (e) => {
    if (e.target === $("#entModal")) $("#entModal").classList.add("hidden");
  });
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */
async function init() {
  wire();
  // Alerte « à vous de signer » dès l'ouverture de l'app (pastille sur Historique).
  getJSON("/api/signatures").then(majPastilleSignatures).catch(() => {});
  // La tuile « ADBI Sign » de la Factory ouvre directement le suivi des
  // signatures : http://localhost:4100/#historique (le fragment peut aussi
  // contenir adbi-theme=… ajouté par la Factory, d'où le simple includes).
  if (window.location.hash.includes("signatures")) showView("signatures");
  else if (window.location.hash.includes("historique")) showView("historique");
  try { state.ref = await getJSON("/api/referentiels"); } catch (e) { /* référentiel optionnel */ }
  try {
    const types = await getJSON("/api/types");
    buildTypeButtons(types);
    const first = types.find((t) => !t.stub) || types[0];
    await loadType(first ? first.id : "sous-traitance");
  } catch (e) {
    setStatus("Impossible de contacter le serveur : " + e.message, "err");
  }
}

document.addEventListener("DOMContentLoaded", init);
