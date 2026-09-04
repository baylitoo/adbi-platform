/*
 * One pager — logique d'interface.
 *
 * Trois ecrans : import, validation (edition du cv_master), rendu (projection
 * one-page). L'etat tient dans un seul objet : le cv_master est la seule source
 * de verite, le one-pager est toujours recalcule cote serveur.
 */

const etat = {
  id: null,
  hash: null,
  master: null,
  onepager: null,
  options: {
    template: "adbi_16_9",
    anonymization: "trigram",
    headerClient: "",
    density: "normal",
    focus: "neutre",
    maxExperiences: 3,
    targetJob: "",
    keep: [],
    drop: [],
    photo: null,
    avatar: "avatar-homme-rose.png",
    badges: [],
  },
  sourceTexte: "",
  file: [],            // import en lot : un element par fichier depose
  selection: new Set(),// identifiants coches dans l'historique, pour le livret
  zoom: null,          // zoom manuel de l'apercu ; null = ajustement automatique
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ══════════════════════════════════════════════════════ navigation ══════

function aller(vue) {
  $$(".vue").forEach((v) => v.classList.remove("active"));
  $("#vue-" + vue).classList.add("active");
  $$("[data-vue]").forEach((b) => b.classList.toggle("actif", b.dataset.vue === vue));
  window.scrollTo(0, 0);
  if (vue === "rendu") { synchroniserReglages(); lireOptions(); }
  if (vue === "historique") chargerHistorique().then(majSelection);
}

/** Reporte l'etat courant dans les contröles, avant de les relire. */
function synchroniserReglages() {
  $("#opt-anon").value = etat.options.anonymization;
  $("#opt-density").value = etat.options.density;
  $("#opt-focus").value = etat.options.focus;
  $("#opt-maxexp").value = etat.options.maxExperiences;
  $("#opt-client").value = etat.options.headerClient;
  $("#opt-target").value = etat.options.targetJob;
}

$$("[data-vue]").forEach((b) => b.addEventListener("click", () => !b.disabled && aller(b.dataset.vue)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => aller(b.dataset.goto)));

function debloquer() {
  $$('.etape[data-vue="validation"], .etape[data-vue="rendu"]').forEach((b) => (b.disabled = false));
}

// ══════════════════════════════════════════════════════════ import ══════

const depot = $("#depot");
$("#btn-parcourir").addEventListener("click", () => $("#fichier").click());
$("#fichier").addEventListener("change", (e) => lancerFile([...e.target.files]));

["dragenter", "dragover"].forEach((ev) =>
  depot.addEventListener(ev, (e) => { e.preventDefault(); depot.classList.add("survol"); })
);
["dragleave", "drop"].forEach((ev) =>
  depot.addEventListener(ev, (e) => { e.preventDefault(); depot.classList.remove("survol"); })
);
depot.addEventListener("drop", (e) => lancerFile([...e.dataTransfer.files]));

$("#btn-file-vider").addEventListener("click", reinitImport);

/**
 * Import en lot : les fichiers sont traites l'un apres l'autre, jamais en
 * parallele. L'analyse d'un CV de 8 pages sature deja un cœur ; lancer dix
 * lectures simultanees allongerait le total et figerait l'interface.
 */
async function lancerFile(fichiers) {
  const liste = fichiers.filter((f) => /\.(pdf|docx?|txt)$/i.test(f.name));
  if (!liste.length) {
    return notice("Aucun fichier exploitable : formats acceptés PDF, Word, texte.", "erreur");
  }

  etat.file = liste.map((f) => ({ nom: f.name, fichier: f, etat: "attente", detail: "" }));
  $("#import-erreur").hidden = true;
  depot.hidden = true;
  $("#file-attente").hidden = false;
  $("#btn-file-vider").hidden = true;
  dessinerFile();

  for (const item of etat.file) {
    item.etat = "encours";
    dessinerFile();
    try {
      const data = await analyser(item.fichier);
      item.etat = "ok";
      item.resultat = data;
      item.detail = resumeImport(data.master);
    } catch (e) {
      item.etat = "echec";
      item.detail = e.message;
    }
    dessinerFile();
  }

  const ok = etat.file.filter((i) => i.etat === "ok");
  $("#file-titre").textContent = ok.length === etat.file.length
    ? `${ok.length} CV analysé${ok.length > 1 ? "s" : ""}`
    : `${ok.length} sur ${etat.file.length} CV analysés`;
  $("#btn-file-vider").hidden = false;

  if (!ok.length) return notice("Aucun CV n'a pu être lu.", "erreur");

  // Un seul fichier : on enchaine directement sur sa validation, c'est le
  // geste attendu. Plusieurs : on laisse choisir dans la liste.
  if (ok.length === 1 && etat.file.length === 1) return ouvrirResultat(ok[0]);
  notice(`${ok.length} CV prêts. Cliquez sur une ligne pour le valider.`, "ok");
}

async function analyser(file) {
  const contentBase64 = await lireBase64(file);
  const r = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentBase64 }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Import impossible.");
  return data;
}

function resumeImport(m) {
  const bouts = [];
  if (m.identity.full_name || m.identity.trigram) bouts.push(m.identity.full_name || m.identity.trigram);
  bouts.push(`${m.experiences.length} mission${m.experiences.length > 1 ? "s" : ""}`);
  if (m.identity.seniority_years) bouts.push(`${m.identity.seniority_years} ans`);
  return bouts.join(" · ");
}

function dessinerFile() {
  const total = etat.file.length;
  const finis = etat.file.filter((i) => i.etat === "ok" || i.etat === "echec").length;
  $("#jauge-barre").style.width = Math.round((finis / total) * 100) + "%";
  if (finis < total) $("#file-titre").textContent = `Analyse ${finis + 1} sur ${total}…`;

  const libelle = { attente: "en attente", encours: "analyse…", ok: "prêt", echec: "échec" };
  $("#liste-file").innerHTML = etat.file.map((i, k) => `
    <li class="${i.etat === "ok" ? "cliquable" : ""}" data-file="${k}">
      <span class="nom">${echapper(i.nom)}</span>
      <span class="detail">${echapper(i.detail)}</span>
      <span class="etat ${i.etat}">${libelle[i.etat]}</span>
    </li>`).join("");
}

$("#liste-file").addEventListener("click", (ev) => {
  const li = ev.target.closest("[data-file]");
  if (!li) return;
  const item = etat.file[+li.dataset.file];
  if (item && item.etat === "ok") ouvrirResultat(item);
});

/** Charge un resultat d'analyse dans l'ecran de validation. */
function ouvrirResultat(item) {
  const data = item.resultat;
  etat.id = data.id;
  etat.hash = data.hash;
  etat.master = data.master;
  etat.options.maxExperiences = Math.min(3, data.master.experiences.length || 1);
  etat.sourceTexte = texteSource(data.master);

  if (data.doublon) {
    notice(`Déjà importé le ${new Date(data.doublon.maj_le).toLocaleDateString("fr-FR")} — une nouvelle version sera créée.`, "info", 6000);
  }
  remplirValidation();
  debloquer();
  aller("validation");
}

function reinitImport() {
  etat.file = [];
  depot.hidden = false;
  $("#file-attente").hidden = true;
  $("#jauge-barre").style.width = "0%";
  $("#liste-file").innerHTML = "";
  $("#fichier").value = "";
}

function lireBase64(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);
    fr.onerror = () => rej(new Error("Fichier illisible."));
    fr.readAsDataURL(file);
  });
}

/** Reconstitue un apercu textuel du CV pour la colonne de gauche. */
function texteSource(m) {
  const l = [];
  l.push(m.identity.full_name, m.identity.title, "");
  l.push([m.contact.email, m.contact.phone_display, m.contact.location.city].filter(Boolean).join("  ·  "), "");
  if (m.summary.raw) l.push("PROFIL\n" + m.summary.raw, "");
  l.push("EXPÉRIENCES");
  m.experiences.forEach((e) => {
    l.push(`\n▸ ${e.role}${e.mission ? " — " + e.mission : ""}`);
    l.push(`  ${[e.end_client || e.company, e.via && "via " + e.via, e.location].filter(Boolean).join(" · ")}`);
    l.push(`  ${e.start_date || "?"} → ${e.is_current ? "en cours" : e.end_date || "?"}`);
    if (e.context) l.push("  " + e.context);
    e.highlights.forEach((h) => l.push("   • " + h.text));
    if (e.tech_stack.length) l.push("   ⚙ " + e.tech_stack.join(", "));
  });
  if (m.skills.length) l.push("\nCOMPÉTENCES", ...m.skills.map((s) => `  ${s.label} : ${s.items.join(", ")}`));
  if (m.education.length) l.push("\nFORMATION", ...m.education.map((e) => `  ${e.degree} — ${e.institution || ""} ${e.end_year || ""}`));
  if (m.certifications.length) l.push("\nCERTIFICATIONS", ...m.certifications.map((c) => `  ${c.name}${c.year ? " (" + c.year + ")" : ""}`));
  if (m.languages.length) l.push("\nLANGUES", ...m.languages.map((x) => `  ${x.name} ${x.level || ""}`));
  return l.filter((x) => x !== undefined).join("\n");
}

// ═════════════════════════════════════════════════════ validation ═══════

function remplirValidation() {
  const m = etat.master;
  $("#source-brut").textContent = etat.sourceTexte;

  // Bandeau qualite : ce que l'extraction sait, et ce dont elle doute.
  const q = m.quality;
  $("#bandeau-qualite").innerHTML = `
    <div class="kpi"><b>${Math.round(q.completeness * 100)}%</b><span>complétude</span></div>
    <div class="kpi"><b>${m.experiences.length}</b><span>missions</span></div>
    <div class="kpi"><b>${m.technologies.length}</b><span>technologies</span></div>
    <div class="kpi"><b>${m.identity.seniority_years}</b><span>ans d'expérience</span></div>
    ${q.needs_review.map((r) => `<span class="puce-avert">à vérifier : ${echapper(r)}</span>`).join("")}
    ${q.warnings.map((w) => `<span class="puce-avert">${echapper(w.replace(/_/g, " "))}</span>`).join("")}
  `;

  const doute = (chemin) => (q.needs_review.includes(chemin) ? " doute" : "");

  $("#champs").innerHTML = `
    <div class="bloc">
      <h3>Identité &amp; contact</h3>
      <div class="grille">
        ${champ("identity.full_name", "Nom complet", m.identity.full_name, doute("identity.full_name"))}
        ${champ("identity.title", "Titre professionnel", m.identity.title)}
        ${champ("contact.email", "E-mail", m.contact.email, doute("contact.email"))}
        ${champ("contact.phone_display", "Téléphone", m.contact.phone_display)}
        ${champ("contact.location.city", "Ville", m.contact.location.city)}
        ${champ("identity.seniority_years", "Années d'expérience", m.identity.seniority_years)}
      </div>
    </div>

    <div class="bloc">
      <h3>Résumé professionnel</h3>
      ${zone("summary.raw", m.summary.raw)}
    </div>

    <div class="bloc">
      <h3>Missions <span class="pastille">${m.experiences.length}</span>
        <span class="grandit"></span>
        <button class="btn petit" id="btn-ajout-mission">+ Ajouter une mission</button>
      </h3>
      <div id="missions">${m.experiences.map(missionHtml).join("")}</div>
    </div>

    <div class="bloc">
      <h3>Compétences</h3>
      ${m.skills.map((g, i) => `
        <div class="champ">
          <span>${echapper(g.label)}</span>
          <input type="text" data-skill="${i}" value="${echapper(g.items.join(", "))}">
        </div>`).join("") || '<p class="aide">Aucune compétence détectée.</p>'}
    </div>

    <div class="bloc">
      <h3>Formation &amp; certifications</h3>
      ${m.education.map((e, i) => `
        <div class="champ">
          <span>Diplôme ${i + 1}</span>
          <input type="text" data-edu="${i}" value="${echapper([e.degree, e.institution, e.end_year].filter(Boolean).join(" — "))}">
        </div>`).join("")}
      ${m.certifications.map((c, i) => `
        <div class="champ">
          <span>Certification ${i + 1}</span>
          <input type="text" data-cert="${i}" value="${echapper(c.name + (c.year ? " — " + c.year : ""))}">
        </div>`).join("")}
    </div>

    <div class="bloc">
      <h3>Langues</h3>
      <div class="grille">
        ${m.languages.map((l, i) => `
          <div class="champ">
            <span>${echapper(l.name)}</span>
            <input type="text" data-lang="${i}" value="${echapper(l.level || "")}" placeholder="A1 → C2">
          </div>`).join("") || '<p class="aide">Aucune langue détectée.</p>'}
      </div>
    </div>
  `;

}

function missionHtml(e, i) {
  return `
  <div class="mission" data-exp="${i}">
    <div class="mission-tete">
      <b>${echapper(e.role || "Mission " + (i + 1))}</b>
      <span class="periode">${echapper(e.start_date || "?")} → ${e.is_current ? "en cours" : echapper(e.end_date || "?")}</span>
      <span class="grandit"></span>
      <button class="icone" data-monter="${i}" title="Remonter cette mission" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="icone" data-descendre="${i}" title="Descendre cette mission">↓</button>
      <button class="retirer" data-suppr-exp="${i}" title="Supprimer cette mission">✕</button>
    </div>
    <div class="grille">
      ${champ(`experiences.${i}.role`, "Poste", e.role)}
      ${champ(`experiences.${i}.mission`, "Intitulé de mission", e.mission)}
      ${champ(`experiences.${i}.end_client`, "Client final", e.end_client)}
      ${champ(`experiences.${i}.via`, "Via (ESN)", e.via)}
      ${champ(`experiences.${i}.start_date`, "Début (AAAA-MM)", e.start_date)}
      ${champ(`experiences.${i}.end_date`, "Fin (AAAA-MM)", e.end_date)}
    </div>
    ${zone(`experiences.${i}.context`, e.context, "Contexte")}
    <ul class="puces">
      ${e.highlights.map((h, j) => `
        <li>
          <input type="text" data-hl="${i}.${j}" value="${echapper(h.text)}">
          ${h.has_metric ? '<span class="pastille chiffre">chiffré</span>' : ""}
          <button class="retirer" data-suppr-hl="${i}.${j}" title="Supprimer">✕</button>
        </li>`).join("")}
      <li class="ajout"><button class="btn petit" data-ajout-hl="${i}">+ Ajouter une réalisation</button></li>
    </ul>
    ${champ(`experiences.${i}.tech_stack`, "Environnement technique", e.tech_stack.join(", "))}
  </div>`;
}

function champ(chemin, label, valeur, classe = "") {
  return `<label class="champ${classe}"><span>${echapper(label)}</span>
    <input type="text" data-chemin="${chemin}" value="${echapper(valeur ?? "")}"></label>`;
}

function zone(chemin, valeur, label = "") {
  return `<label class="champ">${label ? `<span>${echapper(label)}</span>` : ""}
    <textarea rows="3" data-chemin="${chemin}">${echapper(valeur ?? "")}</textarea></label>`;
}

/**
 * Ecouteurs de l'ecran de validation, poses UNE SEULE FOIS.
 *
 * Ils sont delegues sur le conteneur, qui n'est jamais remplace — seul son
 * contenu l'est. Les rebrancher a chaque reconstruction les empilait : au
 * huitieme rendu, un clic sur « supprimer » effacait huit missions.
 */
function brancherEdition() {
  $("#champs").addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset.chemin) ecrire(etat.master, t.dataset.chemin, t.value);
    else if (t.dataset.hl) {
      const [i, j] = t.dataset.hl.split(".").map(Number);
      etat.master.experiences[i].highlights[j].text = t.value;
    } else if (t.dataset.skill !== undefined) {
      etat.master.skills[+t.dataset.skill].items = decouper(t.value);
    } else if (t.dataset.lang !== undefined) {
      etat.master.languages[+t.dataset.lang].level = t.value.trim().toUpperCase() || null;
    }
  });

  $("#champs").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    const exps = etat.master.experiences;
    const d = b.dataset;

    if (d.supprExp !== undefined) {
      exps.splice(+d.supprExp, 1);
    } else if (d.supprHl !== undefined) {
      const [i, j] = d.supprHl.split(".").map(Number);
      exps[i].highlights.splice(j, 1);
    } else if (d.ajoutHl !== undefined) {
      exps[+d.ajoutHl].highlights.push({ text: "", has_metric: false, score: 0 });
    } else if (d.monter !== undefined || d.descendre !== undefined) {
      // Le classement chronologique vient de l'extraction ; l'utilisateur doit
      // pouvoir le reprendre, ne serait-ce que pour corriger une date fausse.
      const i = Number(d.monter ?? d.descendre);
      const j = d.monter !== undefined ? i - 1 : i + 1;
      if (j < 0 || j >= exps.length) return;
      [exps[i], exps[j]] = [exps[j], exps[i]];
    } else if (b.id === "btn-ajout-mission") {
      exps.unshift(missionVide());
    } else {
      return;
    }

    remplirValidation();
    // On rend la main sur le champ ajoute : l'utilisateur enchaine sa saisie.
    const cible = d.ajoutHl !== undefined
      ? $(`[data-hl="${d.ajoutHl}.${exps[+d.ajoutHl].highlights.length - 1}"]`)
      : b.id === "btn-ajout-mission" ? $('[data-chemin="experiences.0.role"]') : null;
    if (cible) cible.focus();
  });
}

/** Mission vierge, a saisir entierement a la main. */
function missionVide() {
  return {
    id: "exp_manuel_" + Date.now(),
    role: "", mission: "", company: "", end_client: "", via: "",
    contract_type: "", location: "",
    start_date: "", end_date: "", is_current: false, duration_months: null,
    context: "", highlights: [], tech_stack: [], confidence: 1,
  };
}

/** Ecriture par chemin pointe, avec conversion pour les champs typés. */
function ecrire(obj, chemin, valeur) {
  const parts = chemin.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  const cle = parts[parts.length - 1];

  if (cle === "tech_stack") cur[cle] = decouper(valeur);
  else if (cle === "seniority_years") cur[cle] = Number(valeur) || 0;
  else if (cle === "end_date") {
    cur[cle] = valeur.trim() || null;
    cur.is_current = !valeur.trim();
  } else cur[cle] = valeur;
}

function decouper(v) {
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}

$("#btn-valider").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/cvs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: etat.id, hash: etat.hash, master: etat.master, options: etat.options }),
    });
    if (r.ok) { etat.id = (await r.json()).id; chargerHistorique(); }
  } catch { /* l'enregistrement est un confort : on genere quand meme */ }
  aller("rendu");
});

// ═════════════════════════════════════════════════════════ rendu ════════

["opt-anon", "opt-density", "opt-focus", "opt-template"].forEach((id) =>
  $("#" + id).addEventListener("change", lireOptions)
);
$("#opt-maxexp").addEventListener("input", lireOptions);
$("#opt-client").addEventListener("input", debounce(lireOptions, 350));
$("#opt-target").addEventListener("input", debounce(lireOptions, 600));

// ------------------------------------------- portrait, avatars, badges --

/** Galeries d'illustrations, alimentees par le contenu reel de public/assets. */
async function chargerGaleries() {
  let a = { avatars: [], badges: [] };
  try { a = await (await fetch("/api/assets")).json(); } catch { return; }

  $("#galerie-avatars").innerHTML = a.avatars.map((f) =>
    `<button type="button" data-avatar="${f}" aria-pressed="${f === etat.options.avatar}" title="${f.replace(/^avatar-|\.png$/g, "").replace(/-/g, " ")}">
       <img src="assets/${f}" alt=""></button>`).join("");

  // Catalogue groupe par editeur : [{ editeur, items: [{ cle, libelle }] }]
  etat.catalogueBadges = Array.isArray(a.badges) ? a.badges : [];
  remplirSelectBadges();
  dessinerBadgesRetenus();
}

/** Libelle lisible d'une cle de badge, pour la liste des badges retenus. */
function libelleBadge(cle) {
  for (const g of etat.catalogueBadges || []) {
    for (const it of g.items) if (it.cle === cle) return g.editeur + " — " + it.libelle;
  }
  return String(cle).replace(/^.*\//, "").replace(/\.\w+$/, "");
}

/**
 * Liste deroulante des certifications, un groupe par editeur. Les badges deja
 * retenus en sont retires : les reproposer n'aurait servi qu'a produire des
 * doublons dans le pied de page.
 */
function remplirSelectBadges() {
  const sel = $("#select-badge");
  const groupes = (etat.catalogueBadges || [])
    .map((g) => ({ ...g, items: g.items.filter((it) => !etat.options.badges.includes(it.cle)) }))
    .filter((g) => g.items.length);

  sel.innerHTML = `<option value="">Choisir une certification…</option>` +
    groupes.map((g) => `<optgroup label="${echapper(g.editeur)}">` +
      g.items.map((it) => `<option value="${echapper(it.cle)}">${echapper(it.libelle)}</option>`).join("") +
      `</optgroup>`).join("");
  sel.disabled = !groupes.length;
  // La liste revient sur son intitule : les deux boutons qui dependent de la
  // selection doivent suivre, sinon « Supprimer » resterait actif sans cible.
  $("#btn-badge-select").disabled = true;
  $("#btn-badge-supprimer").hidden = true;
}

/**
 * Badges retenus, dans l'ordre ou ils apparaitront en pied de page. Chacun
 * porte son bouton de retrait : c'est le seul moyen d'enlever une image
 * importee, qui n'existe nulle part ailleurs que dans cette liste.
 */
function dessinerBadgesRetenus() {
  const retenus = etat.options.badges;
  const liste = $("#badges-retenus");

  liste.innerHTML = retenus.length
    ? retenus.map((cle, i) => {
        const importe = String(cle).startsWith("data:");
        const src = importe ? cle : "assets/badges/" + cle;
        const titre = importe ? "Image importée" : libelleBadge(cle);
        return `<li>
          <img src="${echapper(src)}" alt="">
          <span>${echapper(titre)}</span>
          <button type="button" class="retirer" data-retirer="${i}"
                  title="Retirer" aria-label="Retirer ${echapper(titre)}">×</button>
        </li>`;
      }).join("")
    : `<li class="vide">Aucun badge — le pied de page n'en affichera pas.</li>`;
}

$("#galerie-avatars").addEventListener("click", (e) => {
  const b = e.target.closest("[data-avatar]");
  if (!b) return;
  etat.options.avatar = b.dataset.avatar;
  etat.options.photo = null; // choisir un avatar remplace la photo importee
  majPortraitUI();
  rafraichirRendu();
});

$("#select-badge").addEventListener("change", (e) => {
  const cle = String(e.target.value);
  $("#btn-badge-select").disabled = !cle;
  // Seules les images ajoutees depuis l'application — donc rangees sous un
  // editeur — sont supprimables. Voir le gestionnaire de suppression.
  $("#btn-badge-supprimer").hidden = !cle.includes("/");
});

$("#btn-badge-select").addEventListener("click", () => {
  const sel = $("#select-badge");
  const cle = sel.value;
  if (!cle) return;
  if (etat.options.badges.length >= 5) {
    return notice("5 badges au maximum : le pied de page ne peut pas en contenir davantage.", "erreur");
  }
  etat.options.badges.push(cle);
  const nom = libelleBadge(cle);
  remplirSelectBadges();
  dessinerBadgesRetenus();
  rafraichirRendu();
  notice(`« ${nom} » ajouté au pied de page.`, "ok");
});

$("#badges-retenus").addEventListener("click", (e) => {
  const b = e.target.closest("[data-retirer]");
  if (!b) return;
  const [retire] = etat.options.badges.splice(Number(b.dataset.retirer), 1);
  // Le badge redevient proposable : il faut donc reconstruire la liste.
  remplirSelectBadges();
  dessinerBadgesRetenus();
  rafraichirRendu();
  notice(`« ${libelleBadge(retire)} » retiré.`, "ok");
});

$("#btn-photo").addEventListener("click", () => $("#photo").click());
$("#photo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  etat.options.photo = await lireDataUri(f);
  majPortraitUI();
  rafraichirRendu();
  e.target.value = "";
});
$("#btn-photo-retirer").addEventListener("click", () => {
  etat.options.photo = null;
  majPortraitUI();
  rafraichirRendu();
});

// ------------------------------------- bibliotheque de certifications ----

/**
 * Ajout d'une certification a la BIBLIOTHEQUE, et non au seul dossier courant.
 * L'image est rangee sous son editeur : elle reste disponible pour tous les
 * dossiers suivants, au lieu de disparaitre avec la page.
 */
$("#btn-badge-ajouter").addEventListener("click", () => $("#badge-fichier").click());

$("#badge-fichier").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (f.size > 4 * 1024 * 1024) {
    return notice("Image trop lourde : 4 Mo au maximum.", "erreur");
  }

  etat.badgeEnAttente = await lireDataUri(f);
  $("#badge-apercu").src = etat.badgeEnAttente;
  $("#badge-libelle").value = libelleDepuisNomFichier(f.name);
  $("#liste-editeurs").innerHTML = (etat.catalogueBadges || [])
    .map((g) => `<option value="${echapper(g.editeur)}">`).join("");
  $("#badge-form").hidden = false;
  $("#badge-editeur").focus();
});

/**
 * Libelle propose a partir du nom du fichier : dans la plupart des cas c'est
 * le bon, et cela evite de tout retaper.
 *
 * Le tiret n'est traite comme un separateur que sur un nom en forme de
 * « slug » (celui des badges telecharges depuis Credly). Ailleurs il porte du
 * sens et doit rester : « DP-700 » ne doit pas devenir « DP 700 ».
 */
function libelleDepuisNomFichier(nom) {
  const base = nom.replace(/\.\w+$/, "").replace(/_+/g, " ").trim();
  const slug = /^[a-z0-9 -]+$/.test(base) && (base.match(/-/g) || []).length >= 3;
  const t = slug ? base.replace(/-+/g, " ") : base;
  return t.replace(/\s+/g, " ").trim().slice(0, 60);
}

$("#btn-badge-annuler").addEventListener("click", fermerFormulaireBadge);

function fermerFormulaireBadge() {
  etat.badgeEnAttente = null;
  $("#badge-form").hidden = true;
  $("#badge-editeur").value = "";
  $("#badge-libelle").value = "";
}

$("#badge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const editeur = $("#badge-editeur").value.trim();
  const libelle = $("#badge-libelle").value.trim();
  if (!editeur || !libelle || !etat.badgeEnAttente) return;

  const bouton = $("#btn-badge-enregistrer");
  bouton.disabled = true;
  try {
    const r = await fetch("/api/badges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editeur, libelle, contentBase64: etat.badgeEnAttente }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Enregistrement impossible.");

    fermerFormulaireBadge();
    await chargerGaleries();
    // Ajoutee a la bibliotheque ET au dossier en cours : c'est le geste
    // attendu apres avoir pris la peine de deposer l'image.
    if (etat.options.badges.length < 5) {
      etat.options.badges.push(j.cle);
      remplirSelectBadges();
      dessinerBadgesRetenus();
      rafraichirRendu();
    }
    notice(`« ${editeur} — ${libelle} » ajouté à la bibliothèque.`, "ok");
  } catch (err) {
    notice(err.message, "erreur");
  } finally {
    bouton.disabled = false;
  }
});

/**
 * La suppression ne vise que les images ajoutees depuis l'application. Les
 * badges d'origine, poses a plat, sont references par des dossiers deja
 * enregistres : le serveur refuse de les effacer.
 */
$("#btn-badge-supprimer").addEventListener("click", async () => {
  const cle = $("#select-badge").value;
  if (!cle) return;
  const nom = libelleBadge(cle);
  if (!confirm(`Supprimer « ${nom} » de la bibliothèque ?\n\nL'image est effacée du disque. Les dossiers déjà exportés ne changent pas.`)) return;

  try {
    const r = await fetch("/api/badges?cle=" + encodeURIComponent(cle), { method: "DELETE" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Suppression impossible.");
    // Retirer aussi du dossier courant : l'image n'existe plus.
    etat.options.badges = etat.options.badges.filter((b) => b !== cle);
    await chargerGaleries();
    rafraichirRendu();
    notice(`« ${nom} » supprimé de la bibliothèque.`, "ok");
  } catch (err) {
    notice(err.message, "erreur");
  }
});

/** Une photo importee neutralise le choix d'avatar, et inversement. */
function majPortraitUI() {
  const photo = !!etat.options.photo;
  $("#btn-photo-retirer").hidden = !photo;
  $("#btn-photo").textContent = photo ? "Changer de photo…" : "Importer une photo…";
  $$("#galerie-avatars [data-avatar]").forEach((b) =>
    b.setAttribute("aria-pressed", !photo && b.dataset.avatar === etat.options.avatar)
  );
}

function lireDataUri(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("Image illisible."));
    fr.readAsDataURL(file);
  });
}

function lireOptions() {
  etat.options.anonymization = $("#opt-anon").value;
  etat.options.headerClient = $("#opt-client").value;
  etat.options.density = $("#opt-density").value;
  etat.options.focus = $("#opt-focus").value;
  etat.options.maxExperiences = Number($("#opt-maxexp").value) || 3;
  etat.options.targetJob = $("#opt-target").value;
  etat.options.template = $("#opt-template").value || "adbi_16_9";

  // Le meme champ sert a corriger le trigramme calcule ou a saisir un code
  // client : seul son libelle change, et il disparait en mode nominatif.
  const anon = etat.options.anonymization;
  $("#champ-client").hidden = anon === "none";
  $("#label-client").textContent = anon === "client_prefix" ? "Code client" : "Trigramme";
  $("#opt-client").placeholder =
    anon === "client_prefix" ? "ex. MMA" : etat.master?.identity.trigram || "calculé automatiquement";

  rafraichirRendu();
}

async function rafraichirRendu() {
  if (!etat.master) return;
  const r = await fetch("/api/onepager", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ master: etat.master, options: etat.options }),
  });
  if (!r.ok) return;
  etat.onepager = await r.json();
  // La liste d'abord : l'ajustement au format y ajoute ensuite ses propres
  // retraits, qui seraient effaces si on la reconstruisait apres.
  listerEcartes(etat.onepager);
  dessiner(etat.onepager);

  // Le trigramme affiche en filigrane vient du rendu, pas d'un calcul
  // duplique cote navigateur : une seule regle, cote serveur.
  if (etat.options.anonymization === "trigram" && !etat.options.headerClient) {
    $("#opt-client").placeholder = etat.onepager.header.name || "calculé automatiquement";
  }
}

function dessiner(op) {
  const slide = $("#slide");
  const v = op.visual || {};
  slide.innerHTML = `
    <div class="op-fond">
      ${v.fond ? `<img class="haut" src="${v.fond}" alt=""><img class="bas" src="${v.fond}" alt="">` : ""}
    </div>

    ${v.portrait ? `<div class="op-portrait"><img src="${echapper(v.portrait)}" alt=""></div>` : ""}

    <div class="op-tete">
      <div class="op-nom">
        ${op.header.name ? `<span class="n">${echapper(op.header.name)}</span>` : ""}${
          op.header.title
            ? `<span class="t">${op.header.name ? " : " : ""}${echapper(op.header.title)}</span>`
            : ""
        }
      </div>
    </div>

    <div class="op-bandeau">
      <span>Expériences</span>
      ${op.header.badge ? `<span class="badge">${echapper(op.header.badge)}</span>` : ""}
    </div>
    <div class="op-titre-bloc op-cote-titre">Compétences techniques</div>

    <div class="op-exp">
      ${op.experiences.map((e) => `
        <div class="op-mission">
          <div class="op-mission-tete">
            <span class="role">${echapper(e.role)}</span>${
              e.client ? ` <span class="client">— ${echapper(e.client)}</span>` : ""
            }${e.period ? ` <span class="periode">— ${echapper(e.period)}</span>` : ""}
          </div>
          ${e.context ? `<div class="op-ctx">${echapper(e.context)}</div>` : ""}
          ${e.bullets.length ? `<ul class="op-puces">${e.bullets.map((b) =>
            `<li class="${b.metric ? "chiffre" : ""}">${echapper(b.text)}</li>`).join("")}</ul>` : ""}
          ${e.tech_line ? `<div class="op-tech"><b>Environnement technique :</b> ${echapper(e.tech_line)}</div>` : ""}
        </div>`).join("")}
    </div>

    <div class="op-cote">
      <div class="op-chips">${op.chips.map((c) => `<div class="op-chip${c.length > 14 ? " long" : ""}">${echapper(c)}</div>`).join("")}</div>
      <div class="op-skills">
        ${op.skill_groups.map((g) => `<div><b>${echapper(g.label)} :</b> ${echapper(g.value)}</div>`).join("")}
      </div>
      ${op.certifications.length ? `
        <div class="op-certifs">
          <div class="op-titre-bloc">Certifications / Formations</div>
          <ul>${op.certifications.map((c) => `<li>${echapper(c.text)}</li>`).join("")}</ul>
        </div>` : ""}
    </div>

    <div class="op-pied">
      <span class="op-logo"><img src="${v.logo || "assets/logo-adbi.png"}" alt="ADBI"></span>
      ${(v.badges || []).length ? `<span class="op-badges">${v.badges.map((b) => `<img src="${echapper(b)}" alt="">`).join("")}</span>` : ""}
      <span class="op-pied-droite">
        ${op.languages.length ? `<span class="op-langues">Langues : ${echapper(op.languages.join(" · "))}</span>` : ""}
        ${op.header.contact ? `<span class="op-contact">${echapper([op.header.contact.email, op.header.contact.phone].filter(Boolean).join("  ·  "))}</span>` : ""}
      </span>
    </div>
  `;

  ajusterZoom();
  op.layout.auto_ajuste = ajusterAuFormat(slide);
  etat.opAffiche = capturerAffichage(op, slide);
}

/**
 * Releve ce qui est REELLEMENT affiche a l'ecran, apres l'ajustement au format.
 *
 * C'est ce releve qui part a l'export : sans lui, le PowerPoint refaisait sa
 * propre reduction dans son coin et rendait moins de realisations que l'apercu
 * validé. Le document envoye au client doit etre celui qu'on a vu.
 */
function capturerAffichage(op, slide) {
  const missionsDom = [...slide.querySelectorAll(".op-mission")];
  const experiences = missionsDom.map((el, i) => {
    const source = op.experiences[i] || {};
    const textes = [...el.querySelectorAll(".op-puces li")].map((li) => li.textContent.trim());
    return {
      ...source,
      // On conserve l'ordre et les metadonnees d'origine, en ne gardant que
      // les puces encore presentes dans le rendu.
      bullets: textes.map((t) => source.bullets?.find((b) => b.text === t) || { text: t, metric: false, score: 0 }),
      context: el.querySelector(".op-ctx")?.textContent.trim() || "",
      tech_line: el.querySelector(".op-tech")?.textContent.replace(/^Environnement technique\s*:\s*/i, "").trim() || "",
    };
  });

  const groupes = [...slide.querySelectorAll(".op-skills div")].map((d) => {
    const label = d.querySelector("b")?.textContent.replace(/\s*:\s*$/, "").trim() || "";
    return { label, value: d.textContent.replace(/^[^:]*:\s*/, "").trim(), items: [] };
  });

  return {
    ...op,
    experiences,
    skill_groups: groupes.length ? groupes : op.skill_groups,
    chips: [...slide.querySelectorAll(".op-chip")].map((c) => c.textContent.trim()),
    certifications: [...slide.querySelectorAll(".op-certifs li")].map((li) => ({ text: li.textContent.trim(), kind: "" })),
  };
}

/**
 * Ajustement final : le debordement est MESURE sur le rendu reel, jamais
 * estime a partir d'un nombre de caracteres. Tant que ca deborde, on retire la
 * realisation la moins bien notee de la mission la plus fournie — jamais un
 * bout de phrase. La boucle est bornee et converge.
 */
function ajusterAuFormat(slide) {
  const exp = slide.querySelector(".op-exp");
  const cote = slide.querySelector(".op-cote");
  const retires = [];

  // Colonne de droite : on retire des categories entieres, de la plus pauvre a
  // la plus riche. Mieux vaut 6 categories completes que 8 dont deux coupees.
  const coteDeborde = () => cote && cote.scrollHeight > cote.clientHeight + 2;
  for (let i = 0; i < 8 && coteDeborde(); i++) {
    const groupes = [...slide.querySelectorAll(".op-skills div")];
    if (groupes.length <= 2) break;
    const plusPauvre = groupes.reduce((a, b) => (a.textContent.length <= b.textContent.length ? a : b));
    retires.push(plusPauvre.textContent.split(":")[0].trim());
    plusPauvre.remove();
  }

  const deborde = () => exp.scrollHeight > exp.clientHeight + 2;

  // On reduit d'abord le CORPS DE POLICE, jamais le texte : un contexte de
  // 700 caracteres doit s'afficher en entier, quitte a etre ecrit plus petit.
  // C'est aussi ce que fait l'export PowerPoint, pour que les deux coincident.
  exp.style.setProperty("--k", "1");
  let k = 1;
  for (let essai = 1; essai >= 0.62 && deborde(); essai -= 0.02) {
    k = essai;
    exp.style.setProperty("--k", k.toFixed(2));
  }

  // Retirer des realisations reste l'ultime recours, quand meme le corps
  // minimal ne suffit pas.
  for (let i = 0; i < 12 && deborde(); i++) {
    const listes = [...slide.querySelectorAll(".op-puces")]
      .filter((ul) => ul.children.length > 1)
      .sort((a, b) => b.children.length - a.children.length);
    if (!listes.length) break;
    const ul = listes[0];
    // Les puces sont deja triees par score decroissant : la derniere est la moins forte.
    const li = ul.lastElementChild;
    retires.push(li.textContent.trim());
    li.remove();
  }

  // Un debordement residuel signifie que meme sans puces le contenu est trop
  // long : on le signale plutot que de rogner du texte en silence.
  slide.classList.toggle("deborde", deborde() || coteDeborde());

  if (retires.length) {
    const liste = $("#liste-ecartes");
    liste.insertAdjacentHTML("beforeend", retires.map((t) =>
      `<li class="fige">${echapper(t.slice(0, 70))}<span class="motif">retiré à l'ajustement — manque de place</span></li>`
    ).join(""));
    $("#ecartes-nb").textContent = Number($("#ecartes-nb").textContent || 0) + retires.length;
  }
  return retires.length;
}

/**
 * Adapte l'apercu a la largeur disponible (le PDF, lui, reste a l'echelle 1).
 * Un zoom manuel prend le pas sur l'ajustement automatique : relire une ligne
 * a 8 pt sur un ecran de portable demande de pouvoir grossir.
 */
function ajusterZoom() {
  const scene = $(".scene");
  const px = 297 * 3.7795;
  const auto = Math.min(1, (scene.clientWidth - 24) / px);
  const zoom = etat.zoom || auto;
  $("#slide").style.setProperty("--zoom", zoom.toFixed(3));
  scene.style.height = 210 * 3.7795 * zoom + 20 + "px";
  scene.classList.toggle("deborde-x", zoom > auto);
  $("#zoom-valeur").textContent = etat.zoom ? Math.round(zoom * 100) + " %" : "ajusté";
}

$("#zoom-plus").addEventListener("click", () => reglerZoom(0.15));
$("#zoom-moins").addEventListener("click", () => reglerZoom(-0.15));
$("#zoom-reset").addEventListener("click", () => { etat.zoom = null; ajusterZoom(); });

function reglerZoom(delta) {
  const actuel = etat.zoom || Number(getComputedStyle($("#slide")).getPropertyValue("--zoom")) || 1;
  etat.zoom = Math.min(2.5, Math.max(0.3, actuel + delta));
  ajusterZoom();
}
window.addEventListener("resize", debounce(ajusterZoom, 150));

const MOTIFS = {
  experience_ancienne: "expérience ancienne",
  mission_courte: "mission trop courte",
  hors_perimetre_cible: "hors du périmètre ciblé",
  score_inferieur: "score inférieur",
  budget_puces: "manque de place (puces)",
  budget_caracteres: "manque de place (caractères)",
  budget_categories: "manque de place (catégories)",
  budget_lignes: "manque de place (lignes)",
};

function listerEcartes(op) {
  const items = op.layout.dropped;
  $("#ecartes-nb").textContent = items.length;
  $("#liste-ecartes").innerHTML = items.length
    ? items.map((d) => {
        const reintegrable = /^exp_\d+$/.test(d.what);
        return `<li class="${reintegrable ? "" : "fige"}" ${reintegrable ? `data-keep="${d.what}"` : ""}>
          ${echapper(d.label || d.what)}
          <span class="motif">${echapper(MOTIFS[d.reason] || d.reason)}${reintegrable ? " — cliquer pour réintégrer" : ""}</span>
        </li>`;
      }).join("")
    : '<li class="fige">Tout tient sur la page.</li>';
}

$("#liste-ecartes").addEventListener("click", (ev) => {
  const li = ev.target.closest("[data-keep]");
  if (!li) return;
  const id = li.dataset.keep;
  if (!etat.options.keep.includes(id)) etat.options.keep.push(id);
  // Reintegrer une mission suppose d'agrandir la selection, sinon elle en chasse une autre.
  etat.options.maxExperiences = Math.max(etat.options.maxExperiences, etat.options.keep.length + 1);
  $("#opt-maxexp").value = etat.options.maxExperiences;
  rafraichirRendu();
});

// ------------------------------------------------------------- exports --

$("#btn-pdf").addEventListener("click", () => window.print());

$("#btn-json").addEventListener("click", () => {
  telecharger(
    new Blob([JSON.stringify({ cv_master: etat.master, cv_onepager: etat.onepager }, null, 2)], { type: "application/json" }),
    `cv-${nomFichier()}.json`
  );
});

$("#btn-pptx").addEventListener("click", async () => {
  const b = $("#btn-pptx");
  b.disabled = true;
  b.textContent = "Génération…";
  try {
    const r = await fetch("/api/export/pptx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // On envoie le dossier tel qu'affiche, pas les donnees brutes : l'export
      // doit reproduire l'apercu au contenu pres.
      body: JSON.stringify({ op: etat.opAffiche, master: etat.master, options: etat.options }),
    });
    if (!r.ok) throw new Error((await r.json()).error || "Export impossible.");
    telecharger(await r.blob(), `One-pager-${nomFichier()}.pptx`);
  } catch (e) {
    alert(e.message);
  } finally {
    b.disabled = false;
    b.textContent = "PowerPoint";
  }
});

function nomFichier() {
  return (etat.master?.identity.full_name || "cv")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cv";
}

function telecharger(blob, nom) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ═════════════════════════════════════════════════════ historique ══════

$("#recherche-histo").addEventListener("input", debounce(chargerHistorique, 250));

async function chargerHistorique() {
  const q = $("#recherche-histo").value;
  let cvs = [];
  try { cvs = await (await fetch("/api/cvs?q=" + encodeURIComponent(q))).json(); } catch { return; }

  // Le compteur de l'onglet reflete le total, pas le resultat filtre.
  if (!q) $("#historique-nb").textContent = cvs.length;

  $("#histo-vide").hidden = cvs.length > 0;
  $("#histo-vide").textContent = q
    ? `Aucun CV ne correspond à « ${q} ».`
    : "Aucun CV pour l'instant. Importez-en un depuis l'onglet Import.";

  $("#corps-histo").innerHTML = cvs.map((c) => `
    <tr class="cliquable ${etat.selection.has(c.id) ? "selectionne" : ""}" data-id="${c.id}">
      <td class="case"><input type="checkbox" data-cocher="${c.id}" ${etat.selection.has(c.id) ? "checked" : ""}></td>
      <td><span class="tri">${echapper(c.trigramme || "—")}</span></td>
      <td class="fort">${echapper(c.nom || "Sans nom")}</td>
      <td class="attenue">${echapper(c.titre || "—")}</td>
      <td class="num">${c.missions}</td>
      <td class="attenue mono">${echapper(c.fichier || "—")}</td>
      <td class="attenue">${dateFr(c.maj_le)}</td>
      <td class="actions">
        <button class="btn petit" data-ouvrir="${c.id}">Ouvrir</button>
        <button class="retirer" data-suppr="${c.id}" title="Retirer de l'historique">✕</button>
      </td>
    </tr>`).join("");
}

function dateFr(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("fr-FR") + " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

$("#corps-histo").addEventListener("click", async (ev) => {
  // Une case a cocher ne doit pas ouvrir la fiche : les deux gestes coexistent
  // sur la meme ligne, cocher pour le livret et cliquer pour reprendre le CV.
  const case_ = ev.target.closest("[data-cocher]");
  if (case_) {
    ev.stopPropagation();
    const id = case_.dataset.cocher;
    if (case_.checked) etat.selection.add(id); else etat.selection.delete(id);
    case_.closest("tr").classList.toggle("selectionne", case_.checked);
    majSelection();
    return;
  }

  const suppr = ev.target.closest("[data-suppr]");
  if (suppr) {
    const nom = suppr.closest("tr").querySelector(".fort").textContent;
    if (!confirm(`Retirer « ${nom} » de l'historique ?\n\nLe fichier d'origine n'est pas touché.`)) return;
    await fetch("/api/cvs/" + suppr.dataset.suppr, { method: "DELETE" });
    chargerHistorique();
    return;
  }
  const ligne = ev.target.closest("tr[data-id]");
  if (ligne) ouvrirDepuisHistorique(ligne.dataset.id);
});

// ------------------------------------------------- livret multi-profils --

function majSelection() {
  const n = etat.selection.size;
  $("#barre-selection").hidden = n === 0;
  $("#selection-nb").textContent = `${n} profil${n > 1 ? "s" : ""} sélectionné${n > 1 ? "s" : ""}`;
  const cases = $$("#corps-histo [data-cocher]");
  $("#tout-cocher").checked = cases.length > 0 && cases.every((c) => c.checked);
}

$("#tout-cocher").addEventListener("change", (e) => {
  $$("#corps-histo [data-cocher]").forEach((c) => {
    c.checked = e.target.checked;
    if (c.checked) etat.selection.add(c.dataset.cocher); else etat.selection.delete(c.dataset.cocher);
    c.closest("tr").classList.toggle("selectionne", c.checked);
  });
  majSelection();
});

$("#btn-selection-vider").addEventListener("click", () => {
  etat.selection.clear();
  chargerHistorique();
  majSelection();
});

$("#btn-livret").addEventListener("click", async () => {
  const ids = [...etat.selection];
  if (!ids.length) return;

  attendre(`Assemblage du livret — ${ids.length} profil${ids.length > 1 ? "s" : ""}…`);
  try {
    const r = await fetch("/api/export/livret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Les options de rendu du dossier courant servent de reglage commun :
      // un livret melangeant nom complet et trigrammes serait incoherent.
      body: JSON.stringify({ ids, options: etat.options }),
    });
    if (!r.ok) throw new Error((await r.json()).error || "Génération impossible.");
    telecharger(await r.blob(), `Livret-ADBI-${new Date().toISOString().slice(0, 10)}.pptx`);
    notice(`Livret de ${ids.length} profils téléchargé.`, "ok");
  } catch (e) {
    notice(e.message, "erreur", 6000);
  } finally {
    finAttente();
  }
});

async function ouvrirDepuisHistorique(id) {
  const r = await fetch("/api/cvs/" + id);
  if (!r.ok) return;
  const rec = await r.json();
  etat.id = rec.id;
  etat.master = rec.master;
  etat.options = { ...etat.options, ...rec.options };
  etat.sourceTexte = texteSource(rec.master);
  remplirValidation();
  debloquer();
  aller("validation");
}

// ═════════════════════════════════════════ recherche par offre ══════════

$("#btn-chercher").addEventListener("click", chercherProfils);
$("#btn-offre-vider").addEventListener("click", () => {
  $("#offre-texte").value = "";
  $("#besoin-resume").innerHTML = "";
  $("#resultats-matching").innerHTML = "";
  $("#matching-vide").hidden = false;
  $("#matching-vide").textContent = "Aucune recherche pour l'instant.";
});

async function chercherProfils() {
  const offre = $("#offre-texte").value.trim();
  if (offre.length < 15) {
    return notice("Collez au moins quelques lignes de la fiche de poste.", "erreur");
  }

  attendre("Classement des profils…");
  try {
    const r = await fetch("/api/matching", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offre }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Recherche impossible.");
    dessinerBesoin(data.besoin);
    dessinerResultats(data.resultats);
  } catch (e) {
    notice(e.message, "erreur", 6000);
  } finally {
    finAttente();
  }
}

/** Ce que l'outil a compris de l'offre — affiche pour que l'utilisateur puisse
 *  corriger sa fiche si la lecture est a cote. */
function dessinerBesoin(b) {
  if (!b) return ($("#besoin-resume").innerHTML = "");
  const bloc = (titre, items, classe = "") => items && items.length
    ? `<h4>${titre}</h4><div class="jetons">${items.map((i) => `<span class="jeton ${classe}">${echapper(i)}</span>`).join("")}</div>`
    : "";

  $("#besoin-resume").innerHTML = `
    <h4>Ce que l'outil a retenu</h4>
    ${bloc("Technologies", (b.technologies || []).map((t) => t.name || t), "techno")}
    ${bloc("Compétences", b.fonctionnels)}
    ${bloc("Secteurs", b.secteurs)}
    ${b.seniorite ? `<h4>Expérience demandée</h4><div class="jetons"><span class="jeton">${b.seniorite} ans</span></div>` : ""}
  `;
}

function dessinerResultats(res) {
  const liste = res || [];
  $("#matching-vide").hidden = liste.length > 0;
  $("#matching-vide").textContent = "Aucun profil ne correspond. Importez des CV, ou élargissez l'offre.";

  $("#resultats-matching").innerHTML = liste.map((r) => {
    const id = r.cv?.id || r.id;
    const nom = r.cv?.nom || r.nom || "Sans nom";
    const titre = r.cv?.titre || r.titre || "";
    const tri = r.cv?.trigramme || r.trigramme || "";
    const portrait = r.cv?.portrait || "assets/avatar-homme-rose.png";
    return `
    <article class="carte-profil" data-profil="${echapper(id)}">
      <img class="portrait-profil ${r.niveau}" src="${echapper(portrait)}" alt="">
      <div>
        <div class="nom">${tri ? `<span class="tri">${echapper(tri)}</span> ` : ""}${echapper(nom)}</div>
        <div class="titre">${echapper(titre)}</div>
        <div class="raisons">
          ${(r.raisons || []).slice(0, 4).map((x) =>
            `<div class="raison"><b>${echapper(x.label)}</b>${x.detail ? " — " + echapper(x.detail) : ""}</div>`).join("")}
        </div>
        ${(r.manques || []).length
          ? `<div class="lignes-manques">Manque : ${(r.manques).slice(0, 6).map((m) =>
              `<span class="jeton manque">${echapper(m.label || m)}</span>`).join(" ")}</div>`
          : ""}
      </div>
      <button class="btn petit">Ouvrir</button>
    </article>`;
  }).join("");
}

$("#resultats-matching").addEventListener("click", (ev) => {
  const carte = ev.target.closest("[data-profil]");
  if (carte) ouvrirDepuisHistorique(carte.dataset.profil);
});

// ═══════════════════════════════════════════════════════ utilitaires ════

/**
 * Message transitoire en bas d'ecran.
 * Remplace les fenetres « alert » : elles bloquaient la saisie et obligeaient
 * a cliquer pour un simple avertissement.
 */
function notice(texte, type = "info", duree = 4200) {
  const el = document.createElement("div");
  el.className = "notice " + type;
  el.textContent = texte;
  $("#notices").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, duree);
}

/** Voile d'attente pour les traitements longs (livret, classement du vivier). */
function attendre(texte) {
  $("#voile-texte").textContent = texte || "Traitement en cours…";
  $("#voile").hidden = false;
}
function finAttente() {
  $("#voile").hidden = true;
}

function echapper(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Chargement de la liste des gabarits.
fetch("/api/templates")
  .then((r) => r.json())
  .then((ts) => {
    $("#opt-template").innerHTML = ts.map((t) => `<option value="${t.key}">${echapper(t.label)}</option>`).join("");
  })
  .catch(() => {});

brancherEdition();
chargerGaleries();
chargerHistorique(); // alimente le compteur de l'onglet des l'ouverture
