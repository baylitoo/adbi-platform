/* ADBI Factory — voyant des services d'intelligence artificielle.
 *
 * Un seul indicateur dans l'en-tête : vert si un modèle de la passerelle
 * interne répond, rouge sinon. Les appels passent par la Factory elle-même
 * (/api/llm/chaine, /api/llm/tester) — la clé de la passerelle
 * (ADBI_LLM_API_KEY) reste côté serveur, jamais exposée au navigateur.
 * Avant : appels directs du navigateur vers OVHcloud et Mistral AI
 * (public/llm.js, retiré) — impossible à reproduire sans faire fuiter la clé
 * de la passerelle interne à quiconque ouvre les outils de développement. */

(() => {
  const CACHE = 'factory.ia.etat';    // évite de retester à chaque navigation

  const hero = document.querySelector('.hero');
  if (!hero) return;

  const zone = document.createElement('div');
  zone.className = 'ia-zone';
  zone.innerHTML =
    '<button class="puce-ia test" id="puce-ia" type="button" aria-expanded="false">' +
      '<span class="point"></span><span id="ia-libelle">IA — test…</span>' +
    '</button>' +
    '<div class="ia-panneau" id="ia-panneau" hidden>' +
      '<div class="ia-tete"><h3>Chaîne de secours</h3>' +
        '<button type="button" id="ia-tout">Tout tester</button></div>' +
      '<div id="ia-lignes"></div>' +
      '<div class="ia-pied" id="ia-pied"></div>' +
    '</div>';

  /* La puce « Tout tourne en local » garde sa place en bout de ligne. */
  const locale = hero.querySelector('.puce-local');
  if (locale) { zone.style.marginLeft = 'auto'; hero.insertBefore(zone, locale); locale.style.marginLeft = '0'; }
  else hero.appendChild(zone);

  const $ = id => document.getElementById(id);
  let chaine = [];

  function poser(etat, libelle) {
    $('puce-ia').className = 'puce-ia ' + etat;
    $('ia-libelle').textContent = libelle;
  }

  function lignes() {
    $('ia-lignes').innerHTML = chaine.map((m, i) =>
      `<div class="ia-ligne" data-modele="${m}">` +
        `<span class="ia-rang">${i + 1}</span><span class="point"></span>` +
        `<span class="ia-nom" title="${m}">${m}</span>` +
        `<span class="ia-detail" data-detail="${m}">—</span>` +
      '</div>').join('');
  }

  function majLigne(modele, etat, detail) {
    const l = $('ia-lignes').querySelector(`[data-modele="${CSS.escape(modele)}"]`);
    if (!l) return;
    l.className = 'ia-ligne ' + etat;
    l.querySelector('[data-detail]').textContent = detail;
  }

  async function tester(modele) {
    try {
      const r = await fetch('/api/llm/tester', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modele }),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, modele, erreur: e.message };
    }
  }

  /* Voyant : on descend la chaîne et on s'arrête au premier qui répond. Les
     modèles sont testés un par un (pas de sondage parallèle côté navigateur
     ici) : la chaîne configurée reste courte en pratique, et la simplicité du
     relais serveur prime sur la vitesse d'un voyant d'en-tête. */
  async function verifier() {
    poser('test', 'IA — test…');
    let config;
    try {
      config = await fetch('/api/llm/chaine').then(r => r.json());
    } catch (e) {
      config = { configure: false, modeles: [] };
    }
    chaine = config.modeles || [];
    lignes();

    if (!config.configure) {
      poser('ko', 'IA — non configurée');
      $('ia-pied').textContent = 'Passerelle d’inférence interne non configurée côté serveur (ADBI_LLM_BASE_URL / ADBI_LLM_MODELS).';
      return;
    }

    for (let i = 0; i < chaine.length; i++) {
      majLigne(chaine[i], 'test', '…');
      const r = await tester(chaine[i]);
      if (r.ok) {
        majLigne(chaine[i], 'ok', r.ms + ' ms');
        poser('ok', i ? `IA — secours ${i + 1}/${chaine.length}` : 'IA — en marche');
        $('ia-pied').textContent = i
          ? `${chaine[i]} répond en ${r.ms} ms. ${i} modèle(s) précédent(s) indisponible(s).`
          : `${chaine[i]} répond en ${r.ms} ms.`;
        try { sessionStorage.setItem(CACHE, JSON.stringify({ ok: true, modele: chaine[i], rang: i })); } catch {}
        return;
      }
      majLigne(chaine[i], 'ko', (r.erreur || '').toLowerCase().includes('quota') ? 'quota' : 'panne');
    }

    poser('ko', 'IA — indisponible');
    $('ia-pied').textContent = chaine.length
      ? `Aucun des ${chaine.length} modèle(s) n'a répondu.`
      : 'Aucun modèle configuré (ADBI_LLM_MODELS).';
    try { sessionStorage.setItem(CACHE, JSON.stringify({ ok: false })); } catch {}
  }

  /* Détail : chaque modèle est mesuré, un par un, réservé à une demande explicite. */
  async function toutTester() {
    $('ia-tout').disabled = true;
    for (const m of chaine) {
      majLigne(m, 'test', '…');
      const r = await tester(m);
      majLigne(m, r.ok ? 'ok' : 'ko', r.ok ? r.ms + ' ms' : ((r.erreur || '').toLowerCase().includes('quota') ? 'quota' : 'panne'));
    }
    const vivants = $('ia-lignes').querySelectorAll('.ia-ligne.ok').length;
    $('ia-pied').textContent = `${vivants} modèle(s) disponible(s) sur ${chaine.length}.`;
    poser(vivants ? 'ok' : 'ko', vivants ? `IA — ${vivants}/${chaine.length} disponibles` : 'IA — indisponible');
    $('ia-tout').disabled = false;
  }

  /* Le panneau est en position fixe : on l'aligne sous la puce à l'ouverture,
     et on le replace si la fenêtre bouge pendant qu'il est ouvert. */
  function placer() {
    const p = $('ia-panneau');
    if (p.hidden) return;
    const r = $('puce-ia').getBoundingClientRect();
    p.style.top = (r.bottom + 9) + 'px';
    p.style.left = Math.max(12, r.right - p.offsetWidth) + 'px';
    p.style.maxHeight = Math.max(120, window.innerHeight - r.bottom - 22) + 'px';
  }

  $('puce-ia').addEventListener('click', () => {
    const p = $('ia-panneau');
    p.hidden = !p.hidden;
    placer();
    $('puce-ia').setAttribute('aria-expanded', String(!p.hidden));
  });
  window.addEventListener('resize', placer);
  window.addEventListener('scroll', placer, { passive: true });
  $('ia-tout').addEventListener('click', toutTester);
  document.addEventListener('click', e => {
    if (!zone.contains(e.target)) {
      $('ia-panneau').hidden = true;
      $('puce-ia').setAttribute('aria-expanded', 'false');
    }
  });

  verifier();
})();
