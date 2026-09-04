/* ══════════════════════════════════════════════════════════════════════════
   CHARTE ADBI — bascule sombre / clair.

   Ce fichier est la SOURCE : il vit dans `adbi-factory/theme/` et est recopié
   dans chaque application par `node scripts/sync-theme.js`. Ne le modifiez
   jamais dans une application, la copie serait écrasée.

   Le thème par DÉFAUT de la plateforme est le CLAIR ; le sombre est un choix
   explicite, conservé d'une visite à l'autre. Attention à ne pas confondre
   avec la feuille de style, où c'est l'inverse : le sombre y est le thème
   « sans attribut », et le clair s'obtient par `data-theme="clair"`. Les pages
   posent donc cet attribut directement dans leur HTML, et ce script le retire
   si l'utilisateur a choisi le sombre.

   À charger dans le <head>, AVANT les feuilles de style, pour que le thème
   soit posé avant le premier affichage.

   Chaque application tourne sur son propre port, donc sur une origine
   différente : elles ne partagent NI localStorage NI cookie. La préférence est
   donc mémorisée par application, et la Factory pousse la sienne aux modules
   qu'elle affiche en cadre, par postMessage.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  var CLE = "adbi-theme";
  var SOMBRE = "sombre";
  var CLAIR = "clair";

  function valide(valeur) {
    return valeur === CLAIR || valeur === SOMBRE ? valeur : null;
  }

  function lireMemoire() {
    try {
      return valide(window.localStorage.getItem(CLE));
    } catch (err) {
      return null; // navigation privée, stockage bloqué…
    }
  }

  function ecrireMemoire(theme) {
    try {
      window.localStorage.setItem(CLE, theme);
    } catch (err) {
      /* sans stockage, le thème vaut pour la session en cours seulement */
    }
  }

  /**
   * Indication passée par la Factory dans le fragment d'URL du cadre.
   * On la retire aussitôt lue : l'application ne doit pas voir ce fragment.
   */
  function lireFragment() {
    // On travaille sans le « # » de tête, sinon le premier paramètre du
    // fragment ne serait jamais reconnu.
    var brut = window.location.hash.replace(/^#/, "");
    var trouve = /(?:^|&)adbi-theme=(clair|sombre)(?:&|$)/.exec(brut);
    if (!trouve) return null;
    try {
      var reste = brut
        .replace(/(?:^|&)adbi-theme=(clair|sombre)/, "")
        .replace(/^&/, "");
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + (reste ? "#" + reste : "")
      );
    } catch (err) {
      /* replaceState peut échouer selon le contexte : sans gravité */
    }
    return trouve[1];
  }

  function appliquer(theme) {
    var racine = document.documentElement;
    if (theme === CLAIR) {
      racine.setAttribute("data-theme", CLAIR);
    } else {
      // Côté CSS, le sombre reste le thème « sans attribut » : on retire donc
      // l'attribut posé dans le HTML. (Le thème par DÉFAUT de la plateforme est
      // le clair — c'est ce que décide la ligne `courant` ci-dessous, pas la
      // structure de la feuille de style.)
      racine.removeAttribute("data-theme");
    }
    racine.dispatchEvent(
      new CustomEvent("adbi-theme-change", { detail: { theme: theme }, bubbles: true })
    );
  }

  // Priorité : indication de la Factory > choix mémorisé > CLAIR par défaut.
  // Les pages posent aussi `data-theme="clair"` dans leur HTML, pour que le
  // clair s'applique même si ce script ne se charge pas.
  var courant = lireFragment() || lireMemoire() || CLAIR;
  appliquer(courant);
  ecrireMemoire(courant);

  /** API publique, utilisée par le bouton de bascule de chaque application. */
  window.ADBI_THEME = {
    SOMBRE: SOMBRE,
    CLAIR: CLAIR,

    lire: function () {
      return courant;
    },

    poser: function (theme, diffuser) {
      var cible = valide(theme) || SOMBRE;
      if (cible === courant) return cible;
      courant = cible;
      appliquer(cible);
      ecrireMemoire(cible);
      if (diffuser !== false) window.ADBI_THEME.diffuser();
      return cible;
    },

    basculer: function () {
      return window.ADBI_THEME.poser(courant === CLAIR ? SOMBRE : CLAIR);
    },

    /** Transmet le thème aux modules affichés en cadre (Factory uniquement). */
    diffuser: function () {
      var cadres = document.querySelectorAll("iframe");
      for (var i = 0; i < cadres.length; i++) {
        try {
          cadres[i].contentWindow.postMessage(
            { type: "adbi-theme", theme: courant },
            "*"
          );
        } catch (err) {
          /* cadre pas encore prêt ou origine inaccessible */
        }
      }
    },
  };

  // Un module affiché en cadre suit la Factory. On n'accepte que le format
  // attendu et une valeur connue : le message ne fait que changer des couleurs,
  // il ne déclenche aucune action.
  window.addEventListener("message", function (evenement) {
    var donnees = evenement.data;
    if (!donnees || donnees.type !== "adbi-theme") return;
    var theme = valide(donnees.theme);
    if (theme) window.ADBI_THEME.poser(theme, false);
    majBoutonFlottant();
  });

  /* ── Bouton flottant pour les applications lancées seules ─────────────────
     Dans la Factory, la bascule vit dans le rail : les pages qui en ont une
     posent `data-theme-bouton="non"` sur <html>. Affiché en cadre, le module
     suit la Factory, donc pas de bouton non plus. Reste le cas d'une
     application ouverte directement par son .bat : sans ce bouton, elle serait
     coincée sur son dernier thème. */

  var LUNE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8z"/></svg>';
  var SOLEIL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

  var bouton = null;

  function majBoutonFlottant() {
    if (!bouton) return;
    var clair = courant === CLAIR;
    bouton.innerHTML = clair ? LUNE : SOLEIL;
    bouton.title = clair ? "Passer en sombre" : "Passer en clair";
    bouton.setAttribute("aria-label", bouton.title);
  }

  function ajouterBoutonFlottant() {
    if (window.self !== window.top) return; // affiché en cadre : la Factory pilote
    if (document.documentElement.getAttribute("data-theme-bouton") === "non") return;
    if (!document.body || bouton) return;

    bouton = document.createElement("button");
    bouton.type = "button";
    bouton.id = "adbi-bascule-theme";
    bouton.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483000",
      "width:38px",
      "height:38px",
      "display:grid",
      "place-items:center",
      "padding:0",
      "cursor:pointer",
      "border-radius:50%",
      "border:1px solid var(--adbi-border,#26262f)",
      "background:var(--adbi-surface,#131319)",
      "color:var(--adbi-text2,#a6a6b6)",
      "box-shadow:var(--adbi-sh-lg,0 8px 24px rgba(0,0,0,.45))",
      "transition:color .15s,border-color .15s",
    ].join(";");
    bouton.addEventListener("mouseenter", function () {
      bouton.style.color = "var(--adbi-accent,#1665c1)";
      bouton.style.borderColor = "var(--adbi-accent-bord,rgba(22,101,193,.32))";
    });
    bouton.addEventListener("mouseleave", function () {
      bouton.style.color = "var(--adbi-text2,#a6a6b6)";
      bouton.style.borderColor = "var(--adbi-border,#26262f)";
    });
    bouton.addEventListener("click", function () {
      window.ADBI_THEME.basculer();
      majBoutonFlottant();
    });

    document.body.appendChild(bouton);
    // Les icônes font 17px : on les dimensionne après insertion.
    var style = document.createElement("style");
    style.textContent = "#adbi-bascule-theme svg{width:17px;height:17px}@media print{#adbi-bascule-theme{display:none}}";
    document.head.appendChild(style);
    majBoutonFlottant();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ajouterBoutonFlottant);
  } else {
    ajouterBoutonFlottant();
  }
})();
