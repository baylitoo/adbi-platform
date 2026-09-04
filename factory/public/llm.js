/* ---------------------------------------------------------------------------
 * llm.js — appel d'un LLM gratuit depuis une page HTML. Zéro dépendance.
 *
 * Tous les fournisseurs retenus ici parlent le même dialecte (celui d'OpenAI) :
 * POST {base}/chat/completions avec {model, messages}. Changer de fournisseur
 * revient donc à changer une URL et un nom de modèle, jamais le code d'appel.
 *
 * Seuls figurent les fournisseurs dont les en-têtes CORS acceptent réellement
 * un appel depuis un navigateur (vérifié le 12/08/2026 depuis http://localhost).
 * Cerebras, SambaNova, NVIDIA NIM et GitHub Models refusent : ils ne sont
 * appelables que depuis un serveur.
 *
 * Usage minimal, sans aucune clé :
 *     const texte = await LLM.repondre({ messages: [{role:'user', content:'Bonjour'}] });
 * ------------------------------------------------------------------------- */
const LLM = (() => {

  const FOURNISSEURS = {
    ovh: {
      nom: 'OVHcloud AI Endpoints',
      base: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
      cleRequise: false,           // le palier anonyme fonctionne sans inscription
      zone: 'UE (France)',
      limite: '2 requêtes/minute par modèle et par IP',
      defaut: 'Mistral-Small-3.2-24B-Instruct-2506',
      modeleTest: 'Mistral-7B-Instruct-v0.3',
      usage: 'Tout ce qui contient des données nominatives : CV, contrats, dossiers de compétences.',
      projets: 'One pager, CV Parser, ADBI Coffre',
      cleOu: null
    },
    mistral: {
      nom: 'Mistral AI',
      base: 'https://api.mistral.ai/v1',
      cleRequise: true,
      zone: 'UE (France)',
      limite: '~1 req/s, ~1 milliard de jetons/mois',
      defaut: 'mistral-small-2603',
      modeleTest: 'ministral-3b-2512',
      usage: 'Rédaction et synthèse en français sur gros volumes, quand le quota d’OVHcloud est trop serré.',
      projets: 'Générateur de contrats, One pager',
      cleOu: 'https://console.mistral.ai/api-keys'
    },
  };

  /* Écartés volontairement, pour ne garder que du stable :
       · Groq         — quotas divisés par 14 en 2026 (14 400 → 1 000 req/jour).
                        Une brique de production ne peut pas dépendre de ça.
       · OpenRouter   — 50 requêtes/jour sur les modèles gratuits, et les
                        fournisseurs gratuits journalisent les échanges.
       · LLM7.io      — aucun engagement : lors des essais, des modèles annoncés
                        dans son catalogue n'existaient déjà plus.
       · Hugging Face — crédits mensuels symboliques et routage changeant.
     Pour en réactiver un, il suffit de le décrire ici comme les deux autres. */

  const config = { fournisseur: 'ovh', essais: 3 };

  /* Réglages issus du banc d'essai du 12/08/2026 : 12 modèles OVHcloud passés
     sur trois épreuves (extraction JSON d'un CV, calcul de marge, rédaction
     française sous contrainte), notation automatique.
       · Mistral-Small-3.2-24B : sans faute partout, le plus rapide (1,9 s).
       · gpt-oss-20b           : sans faute partout, 2,1 s.
       · Qwen3-Coder-30B       : sans faute partout mais 6,8 s.
     Les modèles raisonneurs (Qwen3-32B, 3.6-27B, 3.5-9B) trouvent juste mais
     mettent 15 à 37 s et rendent une réponse vide si max_tokens est trop serré.
     Mistral-Nemo, Mistral-7B et Qwen2.5-VL se trompent sur le calcul en
     affirmant un montant faux : à ne jamais employer sur du chiffre. */
  const USAGES = {
    extraction: { modele: 'Mistral-Small-3.2-24B-Instruct-2506', temperature: 0,   json: true,  max_tokens: 900  },
    redaction:  { modele: 'Mistral-Small-3.2-24B-Instruct-2506', temperature: 0.4,              max_tokens: 1200 },
    code:       { modele: 'Qwen3-Coder-30B-A3B-Instruct',        temperature: 0,                max_tokens: 2000 },
    /* Budget large : les modèles raisonneurs de cette chaîne rendent une
       réponse vide s'ils n'ont plus de jetons pour écrire après avoir réfléchi. */
    calcul:     { modele: 'Mistral-Small-3.2-24B-Instruct-2506', temperature: 0,                max_tokens: 3500 },
    secours:    { modele: 'gpt-oss-20b',                         temperature: 0,                max_tokens: 1200 },
  };

  /* Chaînes de secours. Le quota d'OVHcloud se comptant PAR MODÈLE, un modèle
     bloqué ne dit rien des autres : passer au suivant débloque immédiatement.
     C'est le remède exact au 429, et la raison d'être de la cascade.
     L'ordre suit les mesures du banc : les modèles validés d'abord, puis ceux
     qui ont réussi CETTE épreuve-là, en dernier recours.
     Aucun modèle n'apparaît dans une chaîne sans y avoir été mesuré : les trois
     qui se trompaient sur le calcul sont absents de la chaîne « calcul ». */
  const CASCADE = {
    extraction: ['Mistral-Small-3.2-24B-Instruct-2506', 'gpt-oss-20b',
                 'Qwen3-Coder-30B-A3B-Instruct', 'Meta-Llama-3_3-70B-Instruct',
                 'Qwen3.5-397B-A17B', 'Mistral-Nemo-Instruct-2407'],
    redaction:  ['Mistral-Small-3.2-24B-Instruct-2506', 'gpt-oss-20b',
                 'Qwen3-Coder-30B-A3B-Instruct', 'gpt-oss-120b',
                 'Qwen2.5-VL-72B-Instruct', 'Mistral-Nemo-Instruct-2407'],
    code:       ['Qwen3-Coder-30B-A3B-Instruct', 'Mistral-Small-3.2-24B-Instruct-2506',
                 'gpt-oss-20b', 'gpt-oss-120b', 'Meta-Llama-3_3-70B-Instruct',
                 'Qwen3.5-397B-A17B'],
    /* Chiffres : uniquement les six modèles qui ont trouvé 6 270 € exactement.
       Les trois derniers sont lents (15 à 37 s) mais justes — sur du chiffre,
       mieux vaut attendre que se tromper. */
    calcul:     ['Mistral-Small-3.2-24B-Instruct-2506', 'gpt-oss-20b',
                 'Qwen3-Coder-30B-A3B-Instruct', 'Qwen3-32B',
                 'Qwen3.6-27B', 'Qwen3.5-9B'],
  };

  /* Les seuls modèles qui ont réussi les trois épreuves sans réserve. Tout le
     reste du catalogue est accessible, mais n'est pas recommandé. */
  const MODELES_VALIDES = {
    ovh: [
      { id: 'Mistral-Small-3.2-24B-Instruct-2506', note: '100/100 · 1,9 s · extraction et rédaction' },
      { id: 'gpt-oss-20b',                         note: '100/100 · 2,1 s · secours' },
      { id: 'Qwen3-Coder-30B-A3B-Instruct',        note: '100/100 · 6,8 s · code' },
    ],
    mistral: [
      { id: 'mistral-small-2603', note: 'non passé au banc (clé requise pour tester)' },
    ],
  };

  /* Dans le navigateur, les clés vivent dans le localStorage du poste : jamais
     dans le HTML, qui serait lisible par quiconque ouvre le code source.
     Sous Node (server.js d'une application), elles viennent de l'environnement
     — CLE_LLM_MISTRAL=xxx node server.js — ce qui évite de les écrire dans un
     fichier versionné. Le même fichier sert donc des deux côtés. */
  const navigateur = typeof localStorage !== 'undefined';
  const memoire = {};
  const cleDe = f => navigateur
    ? (localStorage.getItem('llm.cle.' + f) || '')
    : (memoire[f] || (typeof process !== 'undefined' && process.env['CLE_LLM_' + f.toUpperCase()]) || '');
  const definirCle = (f, v) => {
    if (!navigateur) { memoire[f] = (v || '').trim(); return; }
    v ? localStorage.setItem('llm.cle.' + f, v.trim()) : localStorage.removeItem('llm.cle.' + f);
  };

  const attendre = ms => new Promise(r => setTimeout(r, ms));
  const maintenant = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

  function enTetes(f) {
    const h = { 'Content-Type': 'application/json' };
    const cle = cleDe(f);
    if (cle) h['Authorization'] = 'Bearer ' + cle;
    return h;
  }

  function verifier(f) {
    const four = FOURNISSEURS[f];
    if (!four) throw new Error(`Fournisseur inconnu : ${f}`);
    if (four.cleRequise && !cleDe(f))
      throw new Error(`${four.nom} exige une clé API. Renseignez-la avant d'envoyer.`);
    return four;
  }

  async function envoyer(four, f, corps, signal) {
    const r = await fetch(four.base + '/chat/completions', {
      method: 'POST', headers: enTetes(f), body: JSON.stringify(corps), signal
    });
    if (r.status === 429) { const e = new Error('LIMITE'); e.limite = true; throw e; }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      let m = t;
      try { const j = JSON.parse(t); m = j.error?.message || j.detail || j.message || t; } catch {}
      throw new Error(`${four.nom} a répondu ${r.status} : ${m || 'erreur inconnue'}`);
    }
    return r;
  }

  /* Deux familles de modèles exposent leur raisonnement de deux façons :
     certains le rangent dans un champ `reasoning` séparé (simple à ignorer),
     d'autres l'écrivent au début de la réponse entre balises <think>…</think>.
     Sans ce nettoyage, ce brouillon se retrouve collé dans le document final.
     La fonction est appelée à chaque fragment reçu : elle doit donc aussi
     retenir une balise arrivée coupée en deux (« <thi » en fin de fragment). */
  function partieVisible(brut) {
    let t = brut.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const ouvert = t.search(/<think>/i);
    if (ouvert !== -1) t = t.slice(0, ouvert);          // bloc encore en cours
    const partiel = t.match(/<[a-z\/]{0,6}$/i);
    if (partiel) t = t.slice(0, t.length - partiel[0].length);
    return t;
  }

  /* Réessaie sur 429 en espaçant : le palier anonyme d'OVHcloud n'autorise que
     2 appels par minute et par modèle, un simple échec y est la norme. */
  async function avecReprises(fn, essais) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (!e.limite || i >= essais - 1) {
          if (e.limite) throw new Error(
            'Ce modèle est momentanément bloqué (quota atteint). Le blocage porte sur ' +
            'le modèle, pas sur le service : choisissez-en un autre dans la liste, ' +
            'il répondra immédiatement.');
          throw e;
        }
        await attendre(4000 * (i + 1));
      }
    }
  }

  /** Réponse complète, en un seul bloc. `json: true` impose une réponse JSON
   *  au modèle (vérifié : OVHcloud accepte `response_format`). */
  async function repondre({ messages, modele, fournisseur, temperature = 0.2,
                            max_tokens = 1200, json = false, signal,
                            essais = config.essais } = {}) {
    const f = fournisseur || config.fournisseur;
    const four = verifier(f);
    return avecReprises(async () => {
      const corps = { model: modele || four.defaut, messages, temperature, max_tokens };
      if (json) corps.response_format = { type: 'json_object' };
      const r = await envoyer(four, f, corps, signal);
      const j = await r.json();
      const m = j.choices?.[0]?.message || {};
      /* Les modèles « raisonneurs » (Qwen3, gpt-oss…) placent leur brouillon
         dans `reasoning` et la vraie réponse dans `content`. Si `content` est
         vide, c'est presque toujours que max_tokens a été consommé par le
         raisonnement : il faut l'augmenter, pas changer de modèle. */
      if (!m.content && m.reasoning)
        throw new Error('Le modèle a épuisé son quota de jetons en raisonnant. ' +
                        'Augmentez max_tokens ou choisissez un modèle sans raisonnement.');
      return partieVisible(m.content || '').trim();
    }, essais);
  }

  /** Réponse mot à mot. `surMorceau(texte)` est appelé à chaque fragment ;
   *  la promesse résout le texte complet. */
  async function diffuser({ messages, modele, fournisseur, temperature = 0.2,
                            max_tokens = 1200, signal } = {}, surMorceau = () => {}) {
    const f = fournisseur || config.fournisseur;
    const four = verifier(f);
    return avecReprises(async () => {
      const r = await envoyer(four, f, {
        model: modele || four.defaut, messages, temperature, max_tokens, stream: true
      }, signal);

      const lecteur = r.body.getReader();
      const decodeur = new TextDecoder();
      let tampon = '', brut = '', emis = '';
      while (true) {
        const { value, done } = await lecteur.read();
        if (done) break;
        tampon += decodeur.decode(value, { stream: true });
        /* Le flux est du Server-Sent Events : des blocs « data: {...} »
           séparés par une ligne vide. Un bloc peut arriver coupé en deux,
           d'où le tampon conservé entre deux lectures. */
        const blocs = tampon.split('\n\n');
        tampon = blocs.pop();
        for (const bloc of blocs) {
          const ligne = bloc.split('\n').find(l => l.startsWith('data:'));
          if (!ligne) continue;
          const charge = ligne.slice(5).trim();
          if (charge === '[DONE]') continue;
          let j; try { j = JSON.parse(charge); } catch { continue; }
          const d = j.choices?.[0]?.delta || {};
          /* d.reasoning est volontairement ignoré : c'est le brouillon interne. */
          if (!d.content) continue;
          brut += d.content;
          const visible = partieVisible(brut);
          if (visible.length > emis.length) {
            let fragment = visible.slice(emis.length);
            emis = visible;
            if (!emis.trim().length) continue;        // rien d'utile encore
            if (fragment !== fragment.trimStart() && emis.trimStart() === fragment.trimStart())
              fragment = fragment.trimStart();        // pas de blancs en tête de réponse
            surMorceau(fragment);
          }
        }
      }
      return emis.trim();
    }, config.essais);
  }

  /* Un même catalogue mélange conversation, embeddings, audio et images. Seuls
     les modèles de conversation répondent sur /chat/completions ; les autres
     renverraient une erreur déroutante s'ils apparaissaient dans la liste. */
  const HORS_CONVERSATION = /whisper|stable-diffusion|flux|embedding|^bge-|rerank|guard|tts|voxtral|moderation|image/i;

  /** Liste des modèles de conversation disponibles chez un fournisseur. */
  async function modeles(fournisseur, { tous = false } = {}) {
    const f = fournisseur || config.fournisseur;
    const four = FOURNISSEURS[f];
    const r = await fetch(four.base + '/models', { headers: enTetes(f) });
    if (!r.ok) throw new Error(`Liste des modèles indisponible (${r.status}).`);
    const j = await r.json();
    const liste = (j.data || j || []).map(m => m.id || m);
    return (tous ? liste : liste.filter(id => !HORS_CONVERSATION.test(id))).sort();
  }

  /** Vérifie qu'un service répond vraiment, ici et maintenant.
   *  Renvoie { etat, message, ms } où etat vaut :
   *    'ok'     le service a répondu           → voyant vert
   *    'ko'     injoignable ou refusé          → voyant rouge
   *    'cle'    clé absente, rien n'a été tenté
   *    'limite' service joignable mais quota momentanément épuisé
   *  Le test utilise un petit modèle dédié (`modeleTest`) : sur OVHcloud, où la
   *  limite se compte par modèle, tester ne consomme donc pas le quota du
   *  modèle que la page utilise pour travailler. */
  async function tester(fournisseur) {
    const f = fournisseur || config.fournisseur;
    const four = FOURNISSEURS[f];
    if (!four) return { etat: 'ko', message: 'Fournisseur inconnu' };
    if (four.cleRequise && !cleDe(f)) return { etat: 'cle', message: 'Clé absente' };

    const debut = performance.now();
    try {
      const r = await fetch(four.base + '/chat/completions', {
        method: 'POST', headers: enTetes(f),
        body: JSON.stringify({ model: four.modeleTest || four.defaut, max_tokens: 8,
                               messages: [{ role: 'user', content: 'ping' }] })
      });
      const ms = Math.round(performance.now() - debut);
      if (r.ok) return { etat: 'ok', message: 'Répond', ms };
      /* Un 429 prouve que le service est joignable et l'accès valide : seul ce
         modèle est bloqué. Le blocage dure plusieurs minutes, pas une seule
         (constaté sur le palier anonyme d'OVHcloud). */
      if (r.status === 429) return { etat: 'limite', message: 'Service joignable, mais le modèle de test est bloqué — les autres modèles restent disponibles', ms };
      if (r.status === 401 || r.status === 403) return { etat: 'ko', message: 'Clé refusée', ms };
      let d = ''; try { const j = JSON.parse(await r.text()); d = j.error?.message || j.detail || j.message || ''; } catch {}
      return { etat: 'ko', message: `Erreur ${r.status}${d ? ' : ' + d : ''}`, ms };
    } catch {
      /* fetch ne rejette ici que si le navigateur a bloqué l'appel : en-têtes
         CORS absentes, ou service hors ligne. */
      return { etat: 'ko', message: 'Bloqué par le navigateur (CORS) ou service hors ligne' };
    }
  }

  /** Cascade : essaie les modèles de la chaîne dans l'ordre et renvoie la
   *  première réponse obtenue. Un modèle bloqué ou en panne est abandonné
   *  immédiatement (pas de réessai) au profit du suivant — c'est tout l'intérêt
   *  d'avoir six modèles plutôt qu'un.
   *      const { texte, modele } = await LLM.cascade('redaction', messages);
   *  `journal` retrace ce qui a échoué avant, utile pour comprendre après coup. */
  async function cascade(usage, messages, options = {}) {
    const u = USAGES[usage];
    if (!u) throw new Error(`Usage inconnu : ${usage}.`);
    const chaine = options.chaine || CASCADE[usage] || [u.modele];
    const journal = [];

    for (const modele of chaine) {
      const debut = maintenant();
      try {
        const texte = await repondre({ ...u, messages, ...options, modele, essais: 1 });
        if (!texte) throw new Error('réponse vide');
        return { texte, modele, ms: maintenant() - debut, journal };
      } catch (e) {
        journal.push({ modele, erreur: e.message });
      }
    }
    const e = new Error(
      `Les ${chaine.length} modèles de la chaîne « ${usage} » ont échoué. ` +
      journal.map(j => `${j.modele} : ${j.erreur}`).join(' | '));
    e.journal = journal;
    throw e;
  }

  /** Première réponse disponible dans la chaîne, avec un message minimal.
   *  Sert au voyant : on s'arrête dès qu'un modèle répond, pour ne pas
   *  consommer inutilement le quota des cinq autres. */
  async function premierDisponible(usage = 'redaction') {
    const chaine = CASCADE[usage] || [];
    const journal = [];
    for (const modele of chaine) {
      const debut = maintenant();
      try {
        await repondre({ modele, essais: 1, temperature: 0, max_tokens: 8,
                         messages: [{ role: 'user', content: 'ping' }] });
        return { ok: true, modele, ms: Math.round(maintenant() - debut),
                 indisponibles: journal.length, chaine, journal };
      } catch (e) { journal.push({ modele, erreur: e.message }); }
    }
    return { ok: false, modele: null, indisponibles: journal.length, chaine, journal };
  }

  /** Raccourci : applique les réglages mesurés pour un usage donné.
   *      const t = await LLM.pour('redaction', [{role:'user', content:'…'}]);
   *  `usage` vaut 'extraction', 'redaction', 'code' ou 'secours'. */
  function pour(usage, messages, options = {}) {
    const u = USAGES[usage];
    if (!u) throw new Error(`Usage inconnu : ${usage}. Attendu : ${Object.keys(USAGES).join(', ')}.`);
    return repondre({ ...u, messages, ...options });
  }

  /** Extraction structurée : renvoie un objet, pas du texte.
   *  Décrivez les clés attendues dans le message système.
   *      const cv = await LLM.extraire([
   *        { role:'system', content:'Réponds en JSON avec les clés nom, email.' },
   *        { role:'user',   content: texteDuCV }
   *      ]);
   *  Sur les 12 modèles testés, les 10 qui ont répondu ont extrait un CV sans
   *  aucune erreur : c'est le réglage (temperature 0 + JSON imposé) qui fait la
   *  fiabilité, pas la taille du modèle. */
  async function extraire(messages, options = {}) {
    const texte = await pour('extraction', messages, options);
    try { return JSON.parse(texte); }
    catch {
      /* Certains modèles encadrent le JSON d'un bloc Markdown malgré la consigne. */
      const m = texte.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      throw new Error('Le modèle n’a pas renvoyé de JSON exploitable : ' + texte.slice(0, 160));
    }
  }

  return { FOURNISSEURS, USAGES, MODELES_VALIDES, CASCADE, config, cleDe, definirCle,
           repondre, diffuser, modeles, tester, pour, extraire,
           cascade, premierDisponible };
})();

if (typeof module !== 'undefined') module.exports = LLM;
