/**
 * conv_widget.js — Widget de conversion CV persistant inter-pages
 *
 * Survit aux changements de page via sessionStorage.
 * Auto-reprend le polling si un job est en cours.
 * Applique un effet glassmorphism quand la conversion est terminée.
 *
 * API publique :
 *   ConvWidget.start(jobId, cvId, filename)  — démarrer le suivi
 *   ConvWidget.dismiss()                     — fermer manuellement
 */
(function () {
  'use strict';

  const SK = 'adbi_conv_job';

  /* ─────────────────────────────────────────────────────────────────────────
     CSS  (injecté une seule fois dans <head>)
  ───────────────────────────────────────────────────────────────────────── */
  const CSS = `
    #cgw {
      position: fixed; bottom: 70px; right: 20px; z-index: 500;
      width: 244px; border-radius: 14px; padding: 20px 20px 16px;
      display: none; flex-direction: column; align-items: center; gap: 10px;
      font-family: 'Inter','Segoe UI',system-ui,sans-serif;
      color: var(--adbi-text1, #f4f4f7);
      background: var(--adbi-surface, #131319);
      border: 1.5px solid var(--adbi-border, #26262f);
      box-shadow: var(--adbi-sh-lg, 0 18px 44px rgba(0,0,0,.55));
      animation: _cgwIn .22s cubic-bezier(.34,1.56,.64,1) both;
      transition: background .8s ease, border-color .8s ease, box-shadow .8s ease;
    }
    #cgw.show { display: flex; }
    @keyframes _cgwIn { from { opacity:0; transform:translateY(14px) scale(.96); } }

    /* ── Glassmorphism — affiché à la fin de la conversion ──
       Le voile est un magenta ADBI translucide : il fonctionne aussi bien
       sur le fond sombre que sur le fond clair de la charte. L'ombre passe
       par le jeton pour suivre le thème (elle est plus légère en clair). */
    #cgw.glass {
      background: rgba(232,22,122,.12) !important;
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      border-color: rgba(232,22,122,.42) !important;
      box-shadow:
        var(--adbi-sh-lg, 0 8px 40px rgba(0,0,0,.5)),
        inset 0 0 0 1.5px rgba(232,22,122,.18) !important;
    }

    .cgw-x {
      position: absolute; top: 9px; right: 11px;
      background: none; border: none; cursor: pointer;
      color: var(--adbi-text2, #a6a6b6); font-size: 15px; line-height: 1; padding: 0;
      opacity: .5; transition: opacity .15s;
    }
    .cgw-x:hover { opacity: 1; color: var(--adbi-erreur, #ff5470); }

    /* ── Document animé ── */
    .cgw-fly {
      width: 68px; height: 76px; perspective: 360px;
      display: flex; align-items: center; justify-content: center;
    }
    .cgw-doc {
      width: 48px; height: 62px;
      background: var(--adbi-surface-2, #1a1a22);
      border: 1.5px solid var(--adbi-border-fort, #34343f);
      border-radius: 3px 8px 3px 3px;
      padding: 8px 6px 6px;
      display: flex; flex-direction: column; gap: 4px;
      animation: _cgwFly 1.8s cubic-bezier(.4,0,.2,1) infinite;
      box-shadow: var(--adbi-sh, 0 6px 18px rgba(0,0,0,.45));
      position: relative; overflow: hidden;
    }
    .cgw-doc::before {
      content: ''; position: absolute; top: 0; right: 0;
      width: 11px; height: 11px;
      background: var(--adbi-border-fort, #34343f); clip-path: polygon(0 0,100% 100%,100% 0);
    }
    .cgw-dl { height: 3px; background: linear-gradient(90deg,#8b1a7e,#e8167a); border-radius: 2px; animation: _cgwBlink 1.8s ease-in-out infinite; }
    .cgw-dl.s  { width: 55%; }
    .cgw-dl.m  { width: 80%;  animation-delay: .15s; }
    .cgw-dl.l  { width: 100%; animation-delay: .3s; }
    .cgw-dl.xs { width: 40%;  animation-delay: .45s; }
    @keyframes _cgwFly {
      0%   { transform: translateZ(-150px) translateX(-22px) rotate(-6deg); opacity: 0; }
      20%  { opacity: 1; }
      65%  { transform: translateZ(14px) translateX(0) rotate(0deg); opacity: 1; }
      85%  { transform: translateZ(24px); opacity: .6; }
      100% { transform: translateZ(32px) translateX(5px); opacity: 0; }
    }
    @keyframes _cgwBlink { 0%,100%{opacity:.35} 50%{opacity:1} }

    /* ── Check (état terminé) ── */
    .cgw-check { display: none; font-size: 40px; animation: _cgwPop .4s cubic-bezier(.34,1.56,.64,1); }
    @keyframes _cgwPop { from { transform: scale(0); opacity: 0; } }

    .cgw-pct   { font-size: 36px; font-weight: 900; color: var(--adbi-text1, #f4f4f7); letter-spacing: -2px; line-height: 1; }
    .cgw-label { font-size: 13px; font-weight: 700; text-align: center; }
    .cgw-sub   { font-size: 11px; color: var(--adbi-text2, #a6a6b6); text-align: center; }

    .cgw-bar  { width: 100%; height: 5px; background: var(--adbi-surface-3, #22222c); border-radius: 5px; overflow: hidden; }
    .cgw-fill {
      height: 100%; width: 0%; border-radius: 5px;
      background: linear-gradient(90deg, #8b1a7e, #e8167a 52%, #f26522);
      transition: width .38s ease-out;
    }
    .cgw-fill.done  { background: var(--adbi-magenta, #e8167a); }
    .cgw-fill.error { background: var(--adbi-erreur, #ff5470); }

    .cgw-fname {
      color: var(--adbi-textm, #6c6c80); font-size: 10px; font-weight: 600; text-align: center;
      max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cgw-btn {
      display: none; width: 100%; padding: 8px 16px;
      background: var(--adbi-magenta, #e8167a);
      color: var(--adbi-sur-accent, #fff); border: none; border-radius: 7px;
      font-size: 12px; font-weight: 700; cursor: pointer;
      text-decoration: none; text-align: center; transition: background .15s;
      margin-top: 2px;
    }
    .cgw-btn:hover { background: var(--adbi-violet, #8b1a7e); }
    .cgw-btn.show  { display: block; }
  `;

  /* ─────────────────────────────────────────────────────────────────────────
     HTML du widget (injecté dans <body>)
  ───────────────────────────────────────────────────────────────────────── */
  const HTML = `
    <div id="cgw">
      <button class="cgw-x" onclick="ConvWidget.dismiss()" title="Fermer">✕</button>
      <div class="cgw-fly">
        <div class="cgw-doc" id="cgwDoc">
          <div class="cgw-dl s"></div><div class="cgw-dl m"></div>
          <div class="cgw-dl l"></div><div class="cgw-dl xs"></div>
          <div class="cgw-dl m"></div><div class="cgw-dl l"></div>
        </div>
      </div>
      <div class="cgw-check" id="cgwCheck">✅</div>
      <div class="cgw-pct"   id="cgwPct">0%</div>
      <p class="cgw-label"   id="cgwLabel">Analyse en cours…</p>
      <p class="cgw-sub"     id="cgwSub">En file d'attente…</p>
      <div class="cgw-bar"><div class="cgw-fill" id="cgwFill"></div></div>
      <div class="cgw-fname" id="cgwFname"></div>
      <a class="cgw-btn" id="cgwBtn" href="#">Ouvrir le dossier →</a>
    </div>`;

  /* ─────────────────────────────────────────────────────────────────────────
     sessionStorage — persistance inter-pages
  ───────────────────────────────────────────────────────────────────────── */
  function _load() {
    try { return JSON.parse(sessionStorage.getItem(SK) || 'null'); }
    catch { return null; }
  }
  function _save(d) { sessionStorage.setItem(SK, JSON.stringify(d)); }
  function _clear()  { sessionStorage.removeItem(SK); }

  /* ─────────────────────────────────────────────────────────────────────────
     Injection CSS + HTML (idempotent)
  ───────────────────────────────────────────────────────────────────────── */
  function _inject() {
    if (document.getElementById('cgw')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const tmpl = document.createElement('template');
    tmpl.innerHTML = HTML;
    document.body.appendChild(tmpl.content.firstElementChild);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Renderers d'état
  ───────────────────────────────────────────────────────────────────────── */
  function _q(id) { return document.getElementById(id); }

  function _subLabel(pct, status) {
    if (status === 'queued')  return "En file d'attente…";
    if (pct < 25)             return 'Extraction du texte…';
    if (pct < 60)             return 'Analyse IA en cours…';
    return 'Structuration des données…';
  }

  function _stateRunning(pct, status, sousTexte) {
    _q('cgwDoc').style.display   = '';
    _q('cgwCheck').style.display = 'none';
    _q('cgwBtn').classList.remove('show');
    _q('cgw').classList.remove('glass');
    _q('cgwFill').style.width    = Math.round(pct) + '%';
    _q('cgwPct').textContent     = Math.round(pct) + '%';
    _q('cgwLabel').textContent   = 'Analyse en cours…';
    _q('cgwSub').textContent     = sousTexte || _subLabel(pct, status);
  }

  function _stateDone(cvId, warning) {
    _q('cgwFill').style.width    = '100%';
    _q('cgwFill').classList.add('done');
    _q('cgwDoc').style.display   = 'none';
    _q('cgwCheck').style.display = 'block';
    _q('cgwPct').textContent     = '✓';
    _q('cgwLabel').textContent   = warning ? '⚠️ Terminé (partiel)' : '✅ Conversion réussie !';
    _q('cgwSub').textContent     = warning ? 'Certains champs peuvent manquer' : 'Prêt à consulter';
    _q('cgwBtn').href            = '/cv/' + cvId;
    _q('cgwBtn').classList.add('show');
    // Glassmorphism avec léger délai pour que la transition soit visible
    setTimeout(() => _q('cgw').classList.add('glass'), 180);
    // Événement pour les handlers spécifiques à la page (ex: showParseSummary)
    document.dispatchEvent(new CustomEvent('convDone', {
      detail: { cvId, warning, parseSummary: (_load() || {}).parseSummary },
    }));
  }

  function _stateFail(msg) {
    _q('cgwFill').classList.add('error');
    _q('cgwPct').textContent   = '!';
    _q('cgwLabel').textContent = '❌ Erreur';
    _q('cgwSub').textContent   = msg || 'Erreur de conversion';
    setTimeout(() => { _q('cgw').classList.remove('show'); _clear(); }, 6000);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Boucle de polling (fire-and-forget)
  ───────────────────────────────────────────────────────────────────────── */
  async function _poll(jobId, cvId) {
    for (let i = 0; i < 90; i++) {   // 90 × 2 s = 3 min max
      await new Promise(r => setTimeout(r, 2000));

      const j = _load();
      if (!j || j.status === 'dismissed') return;

      let data;
      try {
        const res = await fetch('/api/jobs/' + jobId, { credentials: 'include' });
        if (!res.ok) continue;
        data = await res.json();
      } catch { continue; }

      const pct = data.progress || 0;
      _stateRunning(pct, data.status);
      j.progress = pct; j.status = data.status;
      if (data.parse_summary) j.parseSummary = data.parse_summary;
      _save(j);

      if (data.status === 'done') {
        j.status = 'done'; _save(j);
        _stateDone(cvId, data.parse_warning);
        // Rafraîchir les listes si on est sur la page d'accueil
        if (typeof loadLibrary === 'function') loadLibrary();
        if (typeof loadSkills  === 'function') loadSkills();
        return;
      }
      if (data.status === 'failed') {
        j.status = 'failed'; _save(j);
        _stateFail(data.error);
        return;
      }
    }
    _stateFail('Timeout — conversion trop longue');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     Mode local — animation sans polling (backend synchrone)
  ───────────────────────────────────────────────────────────────────────── */
  let _localTimer = null;
  let _suiviTimer = null;

  function _startLocalAnim() {
    let pct = 0;
    _localTimer = setInterval(() => {
      // Progression rapide au début, ralentit en approchant 88 %
      const step = pct < 30 ? 3.5 : pct < 60 ? 2 : pct < 80 ? 0.9 : 0.2;
      pct = Math.min(pct + step + Math.random() * step * 0.6, 88);
      const status = pct < 25 ? 'extracting' : pct < 60 ? 'analyzing' : 'structuring';
      _stateRunning(pct, status);
    }, 700);
  }

  /* Suivi RÉEL : le serveur note l'étape en cours (extraction, OCR, quel
     service IA répond…) et on vient la lire pendant que le POST est en vol.
     La barre glisse en douceur vers le pourcentage réel — fini le faux 88 %
     figé pendant que la cascade IA travaille. */
  function _startSuiviReel(jeton) {
    let cible = 4, affiche = 0, etape = '', detail = '';
    const lisse = setInterval(() => {
      affiche = Math.min(affiche + Math.max(0.4, (cible - affiche) * 0.25), cible);
      _stateRunning(affiche, 'processing', etape + (detail ? ' — ' + detail : ''));
    }, 250);
    const sonde = setInterval(async () => {
      try {
        const r = await fetch('/api/upload/progression/' + encodeURIComponent(jeton),
                              { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (typeof d.pct === 'number' && d.pct > cible) cible = Math.min(d.pct, 99);
        etape = d.etape || etape;
        detail = d.detail || '';
      } catch { /* le POST principal tranchera */ }
    }, 700);
    _suiviTimer = { lisse, sonde };
  }

  function _stopLocalAnim() {
    if (_localTimer) { clearInterval(_localTimer); _localTimer = null; }
    if (_suiviTimer) {
      clearInterval(_suiviTimer.lisse);
      clearInterval(_suiviTimer.sonde);
      _suiviTimer = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     API publique
  ───────────────────────────────────────────────────────────────────────── */
  window.ConvWidget = {
    /**
     * Démarre le suivi d'un job (backend async — répond 202 avec job_id).
     */
    start(jobId, cvId, filename) {
      _inject();
      _save({ jobId, cvId, filename, progress: 0, status: 'queued' });
      _q('cgwFname').textContent = filename;
      _q('cgw').classList.add('show');
      _stateRunning(0, 'queued');
      _poll(jobId, cvId);
    },

    /**
     * Démarre l'animation locale (backend sync — pas de polling).
     * À appeler juste AVANT le fetch bloquant.
     */
    startLocal(filename, jeton) {
      _inject();
      _stopLocalAnim();
      _clear();
      _q('cgwFname').textContent = filename || '';
      _q('cgw').classList.add('show');
      _stateRunning(0, 'queued');
      if (jeton) _startSuiviReel(jeton);
      else _startLocalAnim();
    },

    /**
     * Marque le job local comme terminé (appeler quand le fetch répond OK).
     * cvId  : identifiant du CV pour le lien "Ouvrir le dossier"
     * warning : booléen — extraction partielle
     */
    done(cvId, warning) {
      _stopLocalAnim();
      _clear();
      _stateDone(cvId, warning);
    },

    /**
     * Marque le job local comme échoué.
     */
    fail(msg) {
      _stopLocalAnim();
      _clear();
      _stateFail(msg);
    },

    /** Ferme le widget et efface le job en cours. */
    dismiss() {
      _stopLocalAnim();
      const el = document.getElementById('cgw');
      if (el) el.classList.remove('show');
      _clear();
    },
  };

  /* ─────────────────────────────────────────────────────────────────────────
     Auto-reprise à chaque chargement de page
  ───────────────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    const j = _load();
    if (!j || j.status === 'dismissed') return;

    _inject();
    _q('cgwFname').textContent = j.filename;
    _q('cgw').classList.add('show');

    if (j.status === 'done') {
      _stateDone(j.cvId, false);
    } else if (j.status === 'failed') {
      _stateFail('Erreur lors de la conversion précédente');
    } else {
      // Job toujours en cours — reprendre le polling
      _stateRunning(j.progress || 0, j.status || 'processing');
      _poll(j.jobId, j.cvId);
    }
  });
})();
