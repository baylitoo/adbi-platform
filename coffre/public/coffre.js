/* ADBI Coffre — logique commune : navigation, dépôts de fichiers, envois à
   l'API locale et téléchargements. Aucun mot de passe à saisir : le serveur
   chiffre et déchiffre avec la clé locale du poste. Tout transite par la
   boucle locale (127.0.0.1) : rien ne part sur le réseau. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ── Navigation entre les deux vues ────────────────────────────────────── */

  const onglets = Array.from(document.querySelectorAll(".onglet"));
  onglets.forEach((onglet) => {
    onglet.addEventListener("click", () => {
      onglets.forEach((o) => o.classList.toggle("actif", o === onglet));
      document.querySelectorAll(".vue").forEach((vue) => {
        vue.classList.toggle("active", vue.id === "vue-" + onglet.dataset.vue);
      });
    });
  });

  /* ── Petites aides ─────────────────────────────────────────────────────── */

  function tailleLisible(octets) {
    if (octets < 1024) return octets + " o";
    if (octets < 1024 * 1024) return (octets / 1024).toFixed(1) + " Ko";
    return (octets / (1024 * 1024)).toFixed(1) + " Mo";
  }

  /** Envoie un contenu à l'API et renvoie { nom, blob } du résultat. */
  async function envoyer(url, nomEnvoi, corps, entetesExtra) {
    const entetes = Object.assign(
      {
        "Content-Type": "application/octet-stream",
        "X-Nom-Fichier": encodeURIComponent(nomEnvoi),
      },
      entetesExtra || {}
    );
    const reponse = await fetch(url, { method: "POST", headers: entetes, body: corps });
    if (!reponse.ok) {
      let message = "Erreur " + reponse.status;
      try {
        message = (await reponse.json()).erreur || message;
      } catch (err) {
        /* réponse sans corps JSON : on garde le code HTTP */
      }
      throw new Error(message);
    }
    const nom = decodeURIComponent(reponse.headers.get("X-Nom-Fichier") || "document");
    return { nom, blob: await reponse.blob() };
  }

  /** Lien de téléchargement d'un résultat ; déclenché aussitôt si demandé. */
  function lienTelechargement(nom, blob, automatique) {
    // L'URL n'est pas révoquée : le lien doit rester cliquable dans la liste
    // tant que la page est ouverte. Elle disparaît avec l'onglet.
    const lien = document.createElement("a");
    lien.href = URL.createObjectURL(blob);
    lien.download = nom;
    lien.className = "telecharger";
    lien.textContent = "Télécharger";
    if (automatique) lien.click();
    return lien;
  }

  /* ── Dépôt de fichiers (clic + glisser-déposer) ────────────────────────── */

  function initDepot(zone, entree, boutonParcourir, surNouveauxFichiers) {
    boutonParcourir.addEventListener("click", () => entree.click());
    entree.addEventListener("change", () => {
      surNouveauxFichiers(Array.from(entree.files));
      entree.value = "";
    });
    ["dragenter", "dragover"].forEach((type) =>
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.add("survol");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.classList.remove("survol");
      })
    );
    zone.addEventListener("drop", (e) => {
      surNouveauxFichiers(Array.from(e.dataTransfer.files));
    });
  }

  /* ── Vue « Déchiffrer » ────────────────────────────────────────────────── */

  const fichiersDechiffrer = [];
  const btnDechiffrer = $("btn-dechiffrer");

  function majListeDechiffrer() {
    const liste = $("liste-dechiffrer");
    liste.innerHTML = "";
    fichiersDechiffrer.forEach((fichier, index) => {
      const li = document.createElement("li");
      const nom = document.createElement("span");
      nom.className = "nom";
      nom.textContent = fichier.name;
      const taille = document.createElement("span");
      taille.className = "taille";
      taille.textContent = tailleLisible(fichier.size);
      const retirer = document.createElement("button");
      retirer.type = "button";
      retirer.className = "retirer";
      retirer.textContent = "×";
      retirer.title = "Retirer ce fichier";
      retirer.addEventListener("click", () => {
        fichiersDechiffrer.splice(index, 1);
        majListeDechiffrer();
      });
      li.append(nom, taille, retirer);
      liste.appendChild(li);
    });
    $("carte-action-dechiffrer").hidden = fichiersDechiffrer.length === 0;
    const n = fichiersDechiffrer.length;
    btnDechiffrer.textContent = n > 1 ? "Déchiffrer les " + n + " fichiers" : "Déchiffrer";
  }

  initDepot($("depot-dechiffrer"), $("fichiers-dechiffrer"), $("btn-parcourir-dechiffrer"), (nouveaux) => {
    fichiersDechiffrer.push(...nouveaux);
    majListeDechiffrer();
  });

  btnDechiffrer.addEventListener("click", async () => {
    const resultats = $("resultats-dechiffrer");
    resultats.innerHTML = "";
    btnDechiffrer.disabled = true;

    for (const fichier of fichiersDechiffrer.slice()) {
      const li = document.createElement("li");
      li.className = "encours";
      const nom = document.createElement("span");
      nom.className = "nom";
      nom.textContent = fichier.name;
      const etat = document.createElement("span");
      etat.className = "etat";
      etat.innerHTML = '<span class="tourne"></span>Déchiffrement…';
      li.append(nom, etat);
      resultats.appendChild(li);

      try {
        // .pdf : la charge chiffrée est extraite ici même (pdfjs) ;
        // .docx : le serveur lit l'archive lui-même ; .adbi : envoyé tel quel.
        let corps = fichier;
        if (/[.]pdf$/i.test(fichier.name)) {
          if (!window.COFFRE_PDF) throw new Error("Module PDF non chargé : rechargez la page.");
          const extraction = await window.COFFRE_PDF.extraireCharge(await fichier.arrayBuffer());
          if (!extraction.charge) {
            throw new Error(extraction.anonyme
              ? "Document anonymisé : les informations masquées ont été supprimées définitivement, il n'y a rien à déchiffrer."
              : "Ce PDF ne contient pas d'original chiffré ADBI Coffre.");
          }
          corps = new Blob([extraction.charge]);
        }
        const sortie = await envoyer("/api/dechiffrer", fichier.name, corps);
        li.className = "ok";
        etat.textContent = "Déchiffré";
        nom.textContent = fichier.name + " → " + sortie.nom;
        li.appendChild(lienTelechargement(sortie.nom, sortie.blob, true));
      } catch (err) {
        li.className = "erreur";
        etat.textContent = err.message;
      }
    }
    btnDechiffrer.disabled = false;
  });

  /* ── Vue « Fichier / dossier à clé » ───────────────────────────────────── */
  /* Archive ZIP chiffrée en AES-256 : à l'ouverture (7-Zip, WinRAR…), la clé
     est demandée. La clé est choisie ici — elle doit pouvoir être transmise
     au destinataire par un autre canal. */

  function evaluerSolidite(mdp) {
    if (!mdp) return { pct: 0, libelle: "", classe: "" };
    let jeu = 0;
    if (/[a-z]/.test(mdp)) jeu += 26;
    if (/[A-Z]/.test(mdp)) jeu += 26;
    if (/[0-9]/.test(mdp)) jeu += 10;
    if (/[^A-Za-z0-9]/.test(mdp)) jeu += 20;
    const bits = mdp.length * Math.log2(jeu || 1);
    if (mdp.length < 8) return { pct: 12, libelle: "Trop courte (8 minimum)", classe: "faible" };
    if (bits < 45) return { pct: 30, libelle: "Faible", classe: "faible" };
    if (bits < 70) return { pct: 55, libelle: "Moyenne", classe: "moyen" };
    if (bits < 95) return { pct: 80, libelle: "Bonne", classe: "bon" };
    return { pct: 100, libelle: "Excellente", classe: "bon" };
  }

  // Alphabet sans caractères ambigus : une clé se dicte au téléphone.
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

  function genererPhrase() {
    const plafond = ALPHABET.length * Math.floor(256 / ALPHABET.length);
    const blocs = [];
    for (let b = 0; b < 4; b++) {
      let bloc = "";
      while (bloc.length < 4) {
        const octet = new Uint8Array(1);
        crypto.getRandomValues(octet);
        if (octet[0] < plafond) bloc += ALPHABET[octet[0] % ALPHABET.length];
      }
      blocs.push(bloc);
    }
    return blocs.join("-");
  }

  function copierTexte(texte) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(texte);
    }
    return new Promise((resoudre, rejeter) => {
      const zone = document.createElement("textarea");
      zone.value = texte;
      zone.style.position = "fixed";
      zone.style.opacity = "0";
      document.body.appendChild(zone);
      zone.select();
      const ok = document.execCommand("copy");
      zone.remove();
      ok ? resoudre() : rejeter(new Error("copie refusée"));
    });
  }

  /* Afficher / masquer les champs de clé. */
  const OEIL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/>' +
    '<circle cx="12" cy="12" r="2.8"/></svg>';
  document.querySelectorAll(".oeil").forEach((bouton) => {
    bouton.innerHTML = OEIL;
    bouton.addEventListener("click", () => {
      const champ = $(bouton.dataset.cible);
      champ.type = champ.type === "text" ? "password" : "text";
    });
  });

  const elementsArchive = []; // { chemin, fichier }
  const mdpArchive = $("mdp-archive");
  const mdpArchiveConfirme = $("mdp-archive-confirme");
  const btnArchiver = $("btn-archiver");

  /** Parcourt récursivement un dossier déposé (API webkitGetAsEntry). */
  async function collecterEntree(entree, prefixe, sortie) {
    if (entree.isFile) {
      const fichier = await new Promise((res, rej) => entree.file(res, rej));
      sortie.push({ chemin: prefixe + fichier.name, fichier });
    } else if (entree.isDirectory) {
      const lecteur = entree.createReader();
      let lot;
      do {
        lot = await new Promise((res, rej) => lecteur.readEntries(res, rej));
        for (const e of lot) await collecterEntree(e, prefixe + entree.name + "/", sortie);
      } while (lot.length);
    }
  }

  function ajouterElements(nouveaux) {
    elementsArchive.push(...nouveaux);
    majListeArchive();
  }

  function majJaugeArchive() {
    const s = evaluerSolidite(mdpArchive.value);
    const barre = $("jauge-archive-barre");
    barre.style.width = s.pct + "%";
    barre.className = "jauge-barre " + s.classe;
    let libelle = s.libelle;
    if (mdpArchive.value && mdpArchiveConfirme.value && mdpArchive.value !== mdpArchiveConfirme.value) {
      libelle = "Les deux saisies diffèrent";
    }
    $("jauge-archive-libelle").textContent = libelle;
  }

  function majBoutonArchiver() {
    btnArchiver.disabled = !(
      elementsArchive.length > 0 &&
      mdpArchive.value.length >= 8 &&
      mdpArchive.value === mdpArchiveConfirme.value
    );
    const n = elementsArchive.length;
    btnArchiver.textContent =
      n > 1 ? "Créer l'archive protégée (" + n + " éléments)" : "Créer l'archive protégée";
  }

  function majListeArchive() {
    const liste = $("liste-archiver");
    liste.innerHTML = "";
    elementsArchive.forEach((element, index) => {
      const li = document.createElement("li");
      const nom = document.createElement("span");
      nom.className = "nom";
      nom.textContent = element.chemin;
      const taille = document.createElement("span");
      taille.className = "taille";
      taille.textContent = tailleLisible(element.fichier.size);
      const retirer = document.createElement("button");
      retirer.type = "button";
      retirer.className = "retirer";
      retirer.textContent = "×";
      retirer.title = "Retirer";
      retirer.addEventListener("click", () => {
        elementsArchive.splice(index, 1);
        majListeArchive();
      });
      li.append(nom, taille, retirer);
      liste.appendChild(li);
    });
    $("carte-archiver").hidden = elementsArchive.length === 0;
    majBoutonArchiver();
  }

  const depotArchiver = $("depot-archiver");
  ["dragenter", "dragover"].forEach((type) =>
    depotArchiver.addEventListener(type, (e) => {
      e.preventDefault();
      depotArchiver.classList.add("survol");
    })
  );
  ["dragleave", "drop"].forEach((type) =>
    depotArchiver.addEventListener(type, (e) => {
      e.preventDefault();
      depotArchiver.classList.remove("survol");
    })
  );
  depotArchiver.addEventListener("drop", async (e) => {
    const sortie = [];
    const entrees = Array.from(e.dataTransfer.items || [])
      .map((objet) => (objet.webkitGetAsEntry ? objet.webkitGetAsEntry() : null));
    if (entrees.some(Boolean)) {
      for (const entree of entrees) {
        if (entree) await collecterEntree(entree, "", sortie);
      }
    } else {
      for (const fichier of Array.from(e.dataTransfer.files)) {
        sortie.push({ chemin: fichier.name, fichier });
      }
    }
    ajouterElements(sortie);
  });

  $("btn-archive-fichiers").addEventListener("click", () => $("entree-archive-fichiers").click());
  $("btn-archive-dossier").addEventListener("click", () => $("entree-archive-dossier").click());
  $("entree-archive-fichiers").addEventListener("change", (e) => {
    ajouterElements(Array.from(e.target.files).map((f) => ({ chemin: f.name, fichier: f })));
    e.target.value = "";
  });
  $("entree-archive-dossier").addEventListener("change", (e) => {
    ajouterElements(Array.from(e.target.files).map((f) => ({
      chemin: f.webkitRelativePath || f.name,
      fichier: f,
    })));
    e.target.value = "";
  });

  [mdpArchive, mdpArchiveConfirme].forEach((champ) =>
    champ.addEventListener("input", () => {
      majJaugeArchive();
      majBoutonArchiver();
    })
  );

  $("btn-generer-mdp-archive").addEventListener("click", () => {
    const phrase = genererPhrase();
    mdpArchive.value = phrase;
    mdpArchiveConfirme.value = phrase;
    mdpArchive.type = "text";
    mdpArchiveConfirme.type = "text";
    majJaugeArchive();
    majBoutonArchiver();
  });

  $("btn-copier-mdp-archive").addEventListener("click", () => {
    if (!mdpArchive.value) return;
    copierTexte(mdpArchive.value).then(() => {
      const temoin = $("copie-archive-ok");
      temoin.hidden = false;
      setTimeout(() => (temoin.hidden = true), 1800);
    });
  });

  /** Nom proposé : le dossier racine commun, le fichier unique, ou Archive. */
  function nomArchive() {
    if (elementsArchive.length === 1 && !elementsArchive[0].chemin.includes("/")) {
      return elementsArchive[0].chemin.replace(/[.][^.]+$/, "") || "Archive";
    }
    const racines = new Set(elementsArchive.map((e) => e.chemin.split("/")[0]));
    if (racines.size === 1 && elementsArchive[0].chemin.includes("/")) {
      return [...racines][0];
    }
    return "Archive";
  }

  btnArchiver.addEventListener("click", async () => {
    const resultats = $("resultats-archiver");
    resultats.innerHTML = "";
    btnArchiver.disabled = true;

    const li = document.createElement("li");
    li.className = "encours";
    const nom = document.createElement("span");
    nom.className = "nom";
    nom.textContent = nomArchive() + " — " + elementsArchive.length + " élément(s)";
    const etat = document.createElement("span");
    etat.className = "etat";
    etat.innerHTML = '<span class="tourne"></span>Chiffrement de l’archive…';
    li.append(nom, etat);
    resultats.appendChild(li);

    try {
      // Corps : [4 o longueur][manifeste JSON][contenus concaténés].
      const manifeste = new TextEncoder().encode(JSON.stringify({
        fichiers: elementsArchive.map((e) => ({ chemin: e.chemin, taille: e.fichier.size })),
      }));
      const entete = new Uint8Array(4);
      new DataView(entete.buffer).setUint32(0, manifeste.length);
      const corps = new Blob([entete, manifeste, ...elementsArchive.map((e) => e.fichier)]);

      const sortie = await envoyer("/api/archiver", nomArchive(), corps, {
        "X-Cle": encodeURIComponent(mdpArchive.value),
      });
      li.className = "ok";
      etat.textContent = "Archive chiffrée (AES-256)";
      li.appendChild(lienTelechargement(sortie.nom, sortie.blob, true));
    } catch (err) {
      li.className = "erreur";
      etat.textContent = err.message;
    }
    btnArchiver.disabled = false;
    majBoutonArchiver();
  });

  /* ── Utilitaires partagés avec le module « Protéger » ──────────────────── */

  window.COFFRE = {
    initDepot: initDepot,
    envoyer: envoyer,
    lienTelechargement: lienTelechargement,
    tailleLisible: tailleLisible,
  };
})();
