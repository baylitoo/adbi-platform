/* ADBI Coffre — consultation du registre des références.
 *
 * Le registre répond à une question simple : « ce CV anonymisé porte
 * ADBI-7K4M — de qui s'agit-il ? ». Sans lui, la référence ne sert à rien.
 *
 * Il vit chiffré sur le serveur (clé locale du poste) et n'est lu que sur
 * demande : la page n'en garde aucune copie. */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const liste = $("liste-references");
  const compte = $("compte-references");
  const recherche = $("recherche-reference");
  if (!liste) return;

  const echapper = (t) =>
    String(t == null ? "" : t).replace(/[<>&"]/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  function dateLisible(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
           " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  function dessiner(donnees, filtre) {
    const entrees = donnees.entrees || [];
    liste.innerHTML = "";

    if (!entrees.length) {
      compte.textContent = filtre
        ? "Aucune référence ne correspond à « " + filtre + " »."
        : "Aucun document traité pour l'instant. Protégez un document : sa référence apparaîtra ici.";
      return;
    }

    compte.textContent = filtre
      ? entrees.length + " référence(s) sur " + donnees.total + " enregistrée(s)."
      : donnees.total + " document(s) enregistré(s) sur ce poste.";

    for (const e of entrees) {
      const li = document.createElement("li");
      li.className = "ok";
      li.innerHTML =
        '<span class="nom">' +
          '<strong style="font-family:Consolas,monospace">' + echapper(e.reference) + "</strong>" +
          '<span style="opacity:.6"> — </span>' + echapper(e.nom) +
        "</span>" +
        '<span class="etat">' +
          echapper(e.format) + " · " + echapper(e.mode) + " · " + dateLisible(e.cree) +
          (e.passages > 1 ? " · " + e.passages + " passages" : "") +
        "</span>";

      if (e.document) {
        // Le document conservé est chiffré côté serveur : le lien passe par
        // l'API, qui le déchiffre à la volée avec la clé du poste.
        const voir = document.createElement("a");
        voir.className = "telecharger";
        voir.href = "/api/references/" + encodeURIComponent(e.reference) + "/document";
        voir.target = "_blank";
        voir.rel = "noopener";
        voir.textContent = "Voir le document";
        li.appendChild(voir);
      } else {
        const absent = document.createElement("span");
        absent.className = "etat";
        absent.style.opacity = ".6";
        absent.textContent = "document non conservé";
        li.appendChild(absent);
      }

      liste.appendChild(li);
    }
  }

  let dernierAppel = 0;

  async function charger(filtre) {
    const appel = ++dernierAppel;
    try {
      const r = await fetch("/api/references" + (filtre ? "?q=" + encodeURIComponent(filtre) : ""));
      if (!r.ok) throw new Error("Erreur " + r.status);
      const donnees = await r.json();
      // Une frappe rapide lance plusieurs requêtes : seule la dernière compte,
      // sinon un résultat périmé peut s'afficher après le bon.
      if (appel === dernierAppel) dessiner(donnees, filtre);
    } catch (err) {
      compte.textContent = "Registre indisponible : " + err.message;
    }
  }

  let minuteur = null;
  recherche.addEventListener("input", () => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => charger(recherche.value.trim()), 180);
  });

  // Rechargé à chaque venue sur l'onglet : une protection faite entre-temps
  // doit apparaître sans qu'on ait à recharger la page.
  document.querySelectorAll('.onglet[data-vue="references"]').forEach((o) =>
    o.addEventListener("click", () => charger(recherche.value.trim()))
  );

  charger("");

  window.COFFRE_REFERENCES = {
    /** Attribue la référence, ou rend celle déjà donnée à ce document. */
    async attribuer(demande) {
      try {
        const r = await fetch("/api/references/attribuer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(demande),
        });
        return r.ok ? await r.json() : null;
      } catch (err) {
        return null;
      }
    },

    /** Range le document produit pour qu'il soit relisible depuis sa référence.
     *  Volontairement silencieux : un archivage manqué ne doit pas priver
     *  l'utilisateur du fichier qu'il vient de générer. */
    conserver(reference, nomFichier, octets, type) {
      return fetch("/api/references/" + encodeURIComponent(reference) + "/document", {
        method: "POST",
        headers: {
          "Content-Type": type || "application/octet-stream",
          "X-Nom-Fichier": encodeURIComponent(nomFichier),
        },
        body: octets,
      }).catch(() => null);
    },

    /** Entrée déjà enregistrée pour cette empreinte, ou null. */
    async parEmpreinte(empreinte) {
      try {
        const r = await fetch("/api/references?empreinte=" + encodeURIComponent(empreinte));
        if (!r.ok) return null;
        return (await r.json()).entree || null;
      } catch (err) {
        return null;
      }
    },
  };
})();
