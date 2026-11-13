/* ADBI Factory — connexion par le compte Cynov ; /api/auth/* est relayé à cv-parser, seul émetteur de session. */

(function () {
  const $ = (id) => document.getElementById(id);
  const bouton = $("valider");
  const erreur = $("erreur");
  const info = $("info");
  // Destination déjà validée par le serveur (server.js, retourDeConfiance).
  const retour = JSON.parse($("retour").textContent);
  let changement = false;

  const libelle = () => (changement ? "Changer le mot de passe" : "Se connecter");
  const partir = () => { window.location.href = retour; };
  const poster = (route, corps) => fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(corps || {}),
  });

  function montrerErreur(texte) {
    erreur.textContent = texte;
    erreur.hidden = false;
    bouton.disabled = false;
    bouton.textContent = libelle();
  }

  // Déconnexion demandée par un module : on ferme la session (ADBI et Cynov) ; sinon, une session Cynov vivante renouvelle la session ADBI.
  if (new URLSearchParams(window.location.search).has("sortie")) {
    poster("/api/auth/logout").catch(() => {}).finally(() => {
      history.replaceState(null, "", "/login");
      info.textContent = "Vous êtes déconnecté.";
      info.hidden = false;
    });
  } else {
    poster("/api/auth/refresh").then((r) => { if (r.ok) partir(); }).catch(() => {});
  }

  $("bascule-mdp").addEventListener("click", function () {
    changement = !changement;
    $("champ-nouveau").hidden = !changement;
    $("nouveau").required = changement;
    $("libelle-mdp").textContent = changement ? "Mot de passe actuel" : "Mot de passe Cynov";
    this.textContent = changement ? "Retour à la connexion" : "Première connexion : changer le mot de passe";
    bouton.textContent = libelle();
  });

  $("formulaire").addEventListener("submit", async (e) => {
    e.preventDefault();
    erreur.hidden = true;
    info.hidden = true;
    bouton.disabled = true;
    bouton.textContent = changement ? "Changement…" : "Connexion…";
    const login = $("login").value.trim();
    const password = $("password").value;
    try {
      const reponse = changement
        ? await poster("/api/auth/change-password", { login, old_password: password, new_password: $("nouveau").value })
        : await poster("/api/auth/login", { login, password });
      const donnees = await reponse.json().catch(() => ({}));
      if (!reponse.ok) return montrerErreur(donnees.error || (changement ? "Changement refusé." : "Identifiants invalides."));
      if (changement) {
        $("bascule-mdp").click();
        $("password").value = "";
        $("nouveau").value = "";
        info.textContent = "Mot de passe changé — connectez-vous avec le nouveau.";
        info.hidden = false;
        bouton.disabled = false;
        return;
      }
      partir();
    } catch {
      montrerErreur("Erreur réseau — réessayez.");
    }
  });
})();
