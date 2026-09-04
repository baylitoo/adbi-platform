/* ADBI Factory — voyant des services d'intelligence artificielle.
 *
 * Un seul indicateur dans l'en-tête : vert si un modèle répond, rouge si aucun.
 * Derrière, une chaîne de six modèles est essayée dans l'ordre. Comme le quota
 * d'OVHcloud se compte PAR MODÈLE, un modèle bloqué ne dit rien des autres :
 * c'est ce qui rend la cascade efficace plutôt que redondante.
 *
 * Au chargement, on s'arrête au premier modèle qui répond — inutile de
 * consommer le quota des cinq autres pour afficher un voyant. Le détail complet
 * n'est mesuré que si l'utilisateur ouvre le panneau et le demande. */

(() => {
  const USAGE = 'redaction';          // chaîne servant de référence pour le voyant
  const CACHE = 'factory.ia.etat';    // évite de retester à chaque navigation

  const hero = document.querySelector('.hero');
  if (!hero || typeof LLM === 'undefined') return;

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
  const chaine = LLM.CASCADE[USAGE] || [];

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

  /* Voyant : on descend la chaîne et on s'arrête au premier qui répond. */
  async function verifier() {
    poser('test', 'IA — test…');
    const r = await LLM.premierDisponible(USAGE);

    if (r.ok) {
      poser('ok', r.indisponibles ? `IA — secours ${r.indisponibles + 1}/${chaine.length}` : 'IA — en marche');
      $('ia-pied').textContent = r.indisponibles
        ? `${r.modele} répond en ${r.ms} ms. Les ${r.indisponibles} modèles précédents étaient ` +
          'indisponibles : la cascade a basculé toute seule.'
        : `${r.modele} répond en ${r.ms} ms.`;
    } else {
      poser('ko', 'IA — indisponible');
      $('ia-pied').textContent = `Aucun des ${chaine.length} modèles n'a répondu. ` +
        'Vérifiez la connexion au réseau.';
    }

    for (const j of r.journal) majLigne(j.modele, 'ko', j.erreur.includes('quota') ? 'quota' : 'panne');
    if (r.ok) majLigne(r.modele, 'ok', r.ms + ' ms');

    try { sessionStorage.setItem(CACHE, JSON.stringify({ ok: r.ok, modele: r.modele, rang: r.indisponibles })); } catch {}
    return r;
  }

  /* Détail : chaque modèle est mesuré, un par un pour ne pas se faire limiter
     en rafale. C'est plus lent, donc réservé à une demande explicite. */
  async function toutTester() {
    $('ia-tout').disabled = true;
    for (const m of chaine) {
      majLigne(m, 'test', '…');
      const debut = performance.now();
      try {
        await LLM.repondre({ modele: m, essais: 1, temperature: 0, max_tokens: 8,
                             messages: [{ role: 'user', content: 'ping' }] });
        majLigne(m, 'ok', Math.round(performance.now() - debut) + ' ms');
      } catch (e) {
        majLigne(m, 'ko', e.message.includes('quota') ? 'quota' : 'panne');
      }
    }
    const vivants = $('ia-lignes').querySelectorAll('.ia-ligne.ok').length;
    $('ia-pied').textContent = `${vivants} modèle(s) disponible(s) sur ${chaine.length}. ` +
      'Un « quota » n’est pas une panne : il se compte par modèle et se réarme seul.';
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
    /* Hauteur bornée à la place réellement disponible sous la puce : sur une
       fenêtre courte, le panneau défile au lieu de sortir de l'écran. */
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

  lignes();
  verifier();
})();
