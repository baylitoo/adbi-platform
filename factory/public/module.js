/* ADBI Factory — ouverture d'un module : démarrage si besoin puis affichage en cadre.
   Les fonctions chargerModules / construireRail viennent de rail.js. */

const identifiant = new URLSearchParams(window.location.search).get("m");

const titre = document.getElementById("titre");
const cadre = document.getElementById("cadre-module");
const voile = document.getElementById("voile");
const rondelle = document.getElementById("rondelle");
const voileTitre = document.getElementById("voile-titre");
const voileTexte = document.getElementById("voile-texte");
const voileRetour = document.getElementById("voile-retour");
const lienExterne = document.getElementById("lien-externe");

construireRail(identifiant);

function echec(entete, texte) {
  rondelle.style.display = "none";
  voileTitre.textContent = entete;
  voileTexte.innerHTML = texte;
  voileRetour.hidden = false;
}

function afficher(url) {
  // Le thème voyage dans le fragment : le module l'applique avant son premier
  // affichage, ce qui évite qu'il clignote en sombre avant de passer en clair.
  // adbi-theme.js le retire de l'URL aussitôt lu.
  // Si la charte n'est pas chargée (Factory restée sur une version qui ne sert
  // pas adbi-theme.js), on ouvre le module sans fragment plutôt que d'échouer.
  if (themeDisponible()) {
    const separateur = url.indexOf("#") === -1 ? "#" : "&";
    cadre.src = url + separateur + "adbi-theme=" + themeCourant();
  } else {
    cadre.src = url;
  }
  cadre.hidden = false;
  voile.classList.add("masque");
  lienExterne.href = url;
  lienExterne.hidden = false;
}

async function ouvrir() {
  if (!identifiant) {
    echec("Module non précisé", "Revenez à la liste des modules.");
    return;
  }

  const modules = await chargerModules();
  const module = modules.find((m) => m.id === identifiant);

  if (!module) {
    echec("Module inconnu", "Cet identifiant ne correspond à aucun module.");
    return;
  }

  titre.textContent = module.nom;
  document.title = module.nom + " — ADBI Factory";

  // Module servi directement par la Factory (page statique).
  if (module.type === "statique") {
    afficher(module.url);
    return;
  }

  if (module.etat === "indisponible") {
    echec(
      "Application introuvable",
      "Le dossier de ce module n'existe pas sur ce poste. Vérifiez le chemin dans " +
        "<code>modules.json</code>."
    );
    return;
  }

  if (module.etat === "pret") {
    afficher(module.url);
    return;
  }

  // Sinon : on demande le démarrage à la Factory et on attend la réponse.
  voileTitre.textContent = "Démarrage de " + module.nom + "…";
  if (module.delai_long) {
    voileTexte.textContent =
      "Ce module charge son moteur d'analyse au lancement : comptez une trentaine " +
      "de secondes la première fois.";
  }

  const reponse = await (
    await fetch("/api/modules/" + identifiant + "/demarrer", { method: "POST" })
  ).json();

  if (reponse.etat === "pret") {
    afficher(reponse.url);
    return;
  }

  // Toujours vivant mais pas encore en écoute : on patiente en surveillant.
  if (reponse.etat === "demarrage") {
    surveiller(module, reponse.url);
    return;
  }

  echoueDemarrage(reponse);
}

function echoueDemarrage(reponse) {
  let texte = reponse.message || "Erreur inconnue.";
  if (reponse.journal) {
    texte += "<pre class=\"journal\">" + echapper(reponse.journal) + "</pre>";
  }
  texte +=
    "<br>Journal complet : <code>logs/" + identifiant + ".log</code> " +
    "dans le dossier ADBI Factory.";
  echec("Le module n'a pas démarré", texte);
}

/**
 * Le module met plus longtemps que prévu : on interroge la Factory toutes les
 * trois secondes plutôt que de déclarer un échec, en annonçant le temps écoulé.
 */
function surveiller(m, url) {
  const debut = Date.now();
  const PLAFOND = 5 * 60 * 1000; // au-delà, l'attente n'est plus crédible

  voileTitre.textContent = m.nom + " démarre encore…";
  const minuteur = setInterval(async () => {
    const ecoule = Math.round((Date.now() - debut) / 1000);
    voileTexte.textContent =
      "Démarrage plus long que prévu (" + ecoule + " s). L'application est " +
      "lancée et charge encore ses moteurs.";

    let etat;
    try {
      etat = (await chargerModules(true)).find((x) => x.id === m.id);
    } catch (err) {
      return; // Factory momentanément injoignable : on retentera au tour suivant.
    }

    if (etat && etat.etat === "pret") {
      clearInterval(minuteur);
      afficher(url || etat.url);
    } else if (etat && (etat.etat === "arrete" || etat.etat === "erreur")) {
      clearInterval(minuteur);
      echec(
        "Le module s'est arrêté",
        "Il a quitté avant de répondre. Consultez <code>logs/" +
          m.id + ".log</code> dans le dossier ADBI Factory."
      );
    } else if (Date.now() - debut > PLAFOND) {
      clearInterval(minuteur);
      echec(
        "Le module ne répond toujours pas",
        "Après cinq minutes, l'application n'écoute pas sur le port " + m.port +
          ". Consultez <code>logs/" + m.id + ".log</code>."
      );
    }
  }, 3000);
}

ouvrir().catch((err) => echec("Erreur", err.message));
