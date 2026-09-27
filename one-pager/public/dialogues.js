/* Boîtes de dialogue et notifications à la charte : remplacent confirm() et alert() natifs, thème clair et sombre. */
(() => {
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function adbiConfirmer({ titre = "Confirmer", message = "", confirmer = "Confirmer", annuler = "Annuler", danger = true } = {}) {
    return new Promise((resoudre) => {
      const fond = document.createElement("div");
      fond.className = "adbi-dialogue-fond";
      fond.innerHTML =
        '<div class="adbi-dialogue" role="dialog" aria-modal="true" aria-labelledby="adbiDialogueTitre">' +
        `<h2 class="adbi-dialogue-titre" id="adbiDialogueTitre">${esc(titre)}</h2>` +
        `<p class="adbi-dialogue-texte">${esc(message)}</p>` +
        '<div class="adbi-dialogue-actions">' +
        `<button type="button" class="adbi-dialogue-bouton" data-choix="non">${esc(annuler)}</button>` +
        `<button type="button" class="adbi-dialogue-bouton ${danger ? "danger" : "principal"}" data-choix="oui">${esc(confirmer)}</button>` +
        "</div></div>";
      const clavier = (e) => { if (e.key === "Escape") fermer(false); };
      const fermer = (valeur) => { document.removeEventListener("keydown", clavier); fond.remove(); resoudre(valeur); };
      fond.addEventListener("click", (e) => {
        const bouton = e.target.closest("[data-choix]");
        if (bouton) fermer(bouton.dataset.choix === "oui");
        else if (e.target === fond) fermer(false);
      });
      document.addEventListener("keydown", clavier);
      document.body.appendChild(fond);
      fond.querySelector('[data-choix="non"]').focus();
    });
  }

  function adbiNotifier(message, type = "err", duree = 6000) {
    let zone = document.querySelector(".adbi-notes");
    if (!zone) {
      zone = document.createElement("div");
      zone.className = "adbi-notes";
      zone.setAttribute("role", "status");
      zone.setAttribute("aria-live", "polite");
      document.body.appendChild(zone);
    }
    const note = document.createElement("div");
    note.className = "adbi-note " + type;
    note.textContent = message;
    zone.appendChild(note);
    setTimeout(() => note.remove(), duree);
  }

  window.adbiConfirmer = adbiConfirmer;
  window.adbiNotifier = adbiNotifier;
})();
