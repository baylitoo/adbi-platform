/* etat-ia.js — indicateur des services d'IA, sur le bord droit de l'écran.
 *
 * Au survol, il annonce deux choses distinctes que la cascade rend différentes :
 *   · le modèle qui a RÉELLEMENT répondu au dernier appel ;
 *   · ceux qui prendraient la relève, dans l'ordre, s'il venait à manquer.
 *
 * Il est injecté en JavaScript plutôt qu'ajouté aux gabarits : les six écrans
 * ont des en-têtes différents (pas de gabarit commun dans ce projet), et un
 * élément posé en position fixe s'affiche correctement sur tous sans les
 * modifier un par un.
 *
 * Le survol n'interroge que /api/llm/apercu, qui lit un état déjà en mémoire :
 * aucun appel n'est fait aux modèles, donc aucun quota consommé. */

(() => {
  if (document.getElementById('ia-bord')) return;      // déjà en place

  const style = document.createElement('style');
  style.textContent = `
    #ia-bord{position:fixed;right:0;top:96px;z-index:9000;display:flex;align-items:flex-start;
      font-family:inherit}
    #ia-onglet{display:flex;align-items:center;gap:7px;cursor:default;
      background:var(--adbi-surface,#fff);border:1px solid var(--adbi-border,#e0e0ea);
      border-right:0;border-radius:10px 0 0 10px;padding:9px 12px;
      box-shadow:0 2px 10px rgba(20,20,40,.10);font-size:11.5px;font-weight:700;
      color:var(--adbi-text2,#4d4d63)}
    #ia-point{width:8px;height:8px;border-radius:50%;background:var(--adbi-textm,#74748c);flex-shrink:0}
    #ia-point.ok{background:#15803d}
    #ia-point.ko{background:var(--adbi-erreur,#c8102e)}
    /* Replié, le panneau garde ses bordures et son ombre : à largeur nulle il
       reste donc 2 px de trait le long du bord droit, qui se lisaient comme
       une barre sombre en travers de l'écran. On les retire au repos. */
    #ia-bulle{width:0;overflow:hidden;
      transition:width .18s ease,border-width .18s ease;
      background:var(--adbi-surface,#fff);border:0 solid var(--adbi-border,#e0e0ea);
      border-radius:12px 0 0 12px;box-shadow:none;
      max-height:70vh;overflow-y:auto}
    #ia-bord:hover #ia-bulle,#ia-bord.ouvert #ia-bulle{width:330px;border-width:1px;
      box-shadow:0 14px 34px rgba(20,20,40,.16)}
    #ia-bulle .dedans{width:330px;padding:13px 15px}
    #ia-bulle h4{font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;
      color:var(--adbi-textm,#74748c);margin:0 0 7px}
    #ia-bulle h4+h4{margin-top:14px}
    .ia-courant{font-size:12.5px;font-weight:700;color:var(--adbi-text1,#12121a);line-height:1.45;
      word-break:break-word}
    .ia-sous{font-size:11px;color:var(--adbi-textm,#74748c);margin-top:3px;line-height:1.45}
    /* La liste tombe en cascade : chaque service apparaît juste après le
       précédent, dans le sens où ils sont réellement essayés. Le filet vertical
       matérialise le chemin de la bascule. */
    #ia-releve{position:relative;padding-left:13px}
    #ia-releve::before{content:'';position:absolute;left:4px;top:6px;bottom:6px;width:1px;
      background:linear-gradient(var(--adbi-border,#e0e0ea),transparent);
      animation:ia-filet .5s ease both}
    @keyframes ia-filet{from{transform:scaleY(0)}to{transform:scaleY(1)}}
    #ia-releve::before{transform-origin:top}

    .ia-item{position:relative;display:flex;align-items:center;gap:8px;padding:5px 0;
      font-size:11.5px;color:var(--adbi-text2,#4d4d63);
      border-top:1px solid var(--adbi-border,#e0e0ea);
      animation:ia-chute .3s cubic-bezier(.22,.61,.36,1) both;
      animation-delay:calc(var(--i) * 55ms)}
    @keyframes ia-chute{from{opacity:0;transform:translate(10px,-6px)}
                        to{opacity:1;transform:translate(0,0)}}
    .ia-item::before{content:'';position:absolute;left:-11px;width:5px;height:5px;
      border-radius:50%;background:var(--adbi-border,#e0e0ea)}
    .ia-item:first-of-type{border-top:0}
    .ia-item .r{font-weight:800;color:var(--adbi-textm,#74748c);width:13px;flex-shrink:0}
    .ia-item .m{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ia-item.encours{color:#15803d;font-weight:700}
    .ia-item.encours::before{background:#15803d;box-shadow:0 0 0 3px rgba(21,128,61,.16)}
    /* Les services sautés avant celui qui a répondu : la bascule s'est arrêtée
       là, on le montre plutôt que de l'écrire. */
    .ia-item.saute{color:var(--adbi-textm,#74748c)}
    .ia-item.saute .m{text-decoration:line-through;text-decoration-color:rgba(200,16,46,.5)}
    .ia-item.saute::before{background:var(--adbi-erreur,#c8102e);opacity:.55}
    .ia-item.inactif{opacity:.45;text-decoration:line-through}
    @media(prefers-reduced-motion:reduce){
      .ia-item,#ia-releve::before{animation:none}
    }
    .ia-note{font-size:10.5px;color:var(--adbi-textm,#74748c);line-height:1.5;margin-top:11px;
      padding-top:9px;border-top:1px solid var(--adbi-border,#e0e0ea)}
    @media(max-width:720px){#ia-bord{display:none}}
  `;
  document.head.appendChild(style);

  const zone = document.createElement('div');
  zone.id = 'ia-bord';
  zone.innerHTML =
    '<div id="ia-bulle"><div class="dedans" id="ia-contenu">Chargement…</div></div>' +
    '<div id="ia-onglet"><span id="ia-point"></span>IA</div>';
  document.body.appendChild(zone);

  const echapper = t => String(t ?? '').replace(/[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  function dessiner(d) {
    const dernier = d.dernier || {};
    const chaine  = d.chaine || [];
    const point   = document.getElementById('ia-point');

    /* Vert seulement si un modèle a effectivement répondu. Sans appel encore
       passé, on ne prétend pas savoir : le point reste neutre. */
    point.className = dernier.service ? 'ok' : '';

    const enCours = dernier.service
      ? `<div class="ia-courant">${echapper(dernier.service)}</div>
         <div class="ia-sous">A répondu à ${echapper(dernier.quand)} en ${dernier.ms} ms` +
        (dernier.sautes
          ? ` — ${dernier.sautes} service(s) sauté(s) avant lui.`
          : ' — premier de la chaîne.') + '</div>'
      : `<div class="ia-courant" style="font-weight:600;color:var(--adbi-textm,#74748c)">
           Aucun appel depuis le démarrage</div>
         <div class="ia-sous">Le premier service de la liste ci-dessous sera essayé.</div>`;

    /* Les services actifs situés avant celui qui a répondu sont ceux que la
       cascade a effectivement essayés puis abandonnés : on les barre, pour que
       le chemin parcouru se lise d'un coup d'œil.
       Tant qu'aucun appel n'a eu lieu, il n'y a pas de « courant » — et donc
       rien de sauté : sans ce garde-fou, tous les rangs étaient comparés à
       l'infini et la liste entière s'affichait comme indisponible. */
    const service = chaine.find(e => e.courant);
    const rangCourant = service ? service.rang : null;

    const releve = '<div id="ia-releve">' + chaine.map((e, i) => {
      const saute   = rangCourant !== null && e.actif && !e.courant && e.rang < rangCourant;
      const classes = 'ia-item' + (e.courant ? ' encours' : '') +
                      (saute ? ' saute' : '') + (e.actif ? '' : ' inactif');
      /* « écarté au dernier appel » et non « indisponible » : le service
         n'avait pas répondu à ce moment-là, ce qui ne dit rien de son état
         maintenant — sur un quota qui se réarme à la minute, la nuance
         compte. */
      const suffixe = e.courant ? ' ← a traité le dernier appel'
                    : saute     ? ' — écarté au dernier appel'
                    : e.actif   ? '' : ' (désactivé)';
      return `<div class="${classes}" style="--i:${i}">` +
             `<span class="r">${e.rang}</span>` +
             `<span class="m" title="${echapper(e.nom)} / ${echapper(e.modele)}">` +
             `${echapper(e.modele)}${suffixe}</span></div>`;
    }).join('') + '</div>';

    document.getElementById('ia-contenu').innerHTML =
      '<h4>Modèle en cours</h4>' + enCours +
      '<h4>Relève pour l’extraction</h4>' + releve +
      '<div class="ia-note">La chaîne est sondée avant chaque appel : le premier ' +
      'service qui répond à cet instant traite la demande. Ordre modifiable dans ' +
      'Paramètres → API &amp; LLM.</div>';
  }

  async function rafraichir() {
    try {
      const r = await fetch('/api/llm/apercu', { credentials: 'include' });
      if (!r.ok) throw new Error(r.status);
      dessiner(await r.json());
    } catch {
      document.getElementById('ia-point').className = 'ko';
      document.getElementById('ia-contenu').innerHTML =
        '<h4>Services d’IA</h4><div class="ia-sous">État indisponible.</div>';
    }
  }

  /* Rafraîchi à l'ouverture du survol : le modèle en cours change au fil des
     analyses, une valeur figée au chargement de la page induirait en erreur. */
  zone.addEventListener('mouseenter', rafraichir);
  zone.addEventListener('click', () => {           // repli tactile
    zone.classList.toggle('ouvert');
    if (zone.classList.contains('ouvert')) rafraichir();
  });

  rafraichir();
})();
