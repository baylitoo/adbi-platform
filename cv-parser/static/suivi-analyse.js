/* Suivi d'une tâche d'analyse de CV (issue #196), commun au dépôt
   (templates/index.html) et à la ré-analyse (templates/cv_detail.html).

   Un grand CV prend plusieurs minutes côté DocIE, trop pour une requête HTTP :
   le serveur répond 202 { tache } et l'on interroge
   /api/upload/progression/<tache> toutes les 2 s. Plafond 30 min (un onglet
   oublié ne tourne pas indéfiniment) ; 3 échecs réseau d'affilée abandonnent,
   un seul ne doit pas perdre une analyse de 4 minutes. Aucune relance d'une
   tâche en échec : son message nommé s'affiche, l'utilisateur relance.

   `suivi(t)` reçoit l'état intermédiaire (etape, detail, position). Rend le
   `resultat` de la tâche, ou lève une Error au message affichable. */
const ANALYSE_INTERVALLE_MS = 2000, ANALYSE_MAX_INTERROGATIONS = 900, ANALYSE_MAX_ECHECS_RESEAU = 3;

async function attendreAnalyse(tache, suivi) {
  let echecsReseau = 0;
  for (let n = 0; n < ANALYSE_MAX_INTERROGATIONS; n++) {
    await new Promise(ok => setTimeout(ok, ANALYSE_INTERVALLE_MS));
    let r, t;
    try {
      r = await fetch('/api/upload/progression/' + encodeURIComponent(tache), { credentials: 'include' });
      t = await r.json();
      echecsReseau = 0;
    } catch {
      if (++echecsReseau >= ANALYSE_MAX_ECHECS_RESEAU) throw new Error("Serveur injoignable pendant l'analyse");
      continue;
    }
    if (!r.ok) throw new Error(t.error || "Suivi de l'analyse impossible, réessayez dans quelques instants.");
    if (t.etat === 'terminee') return t.resultat;
    if (t.etat === 'echec') throw new Error((t.erreur && t.erreur.message) || 'Analyse impossible');
    if (suivi) suivi(t);
  }
  throw new Error('Analyse trop longue : abandon du suivi après 30 minutes');
}
