/**
 * Referentiel des competences FONCTIONNELLES.
 *
 * Le referentiel technique (lib/taxonomy) ne connait que des outils. Or une
 * large part des profils d'une ESN — AMOA, chef de projet, consultant metier,
 * expert relation client — n'en cite presque aucun. Leur dossier se retrouvait
 * avec une colonne de droite vide, alors que leurs missions decrivent
 * abondamment ce qu'ils savent faire.
 *
 * Ce module reconnait ce vocabulaire-la, dans le texte des missions.
 */

const GROUPES = {
  pilotage: {
    label: "Pilotage & Gouvernance",
    termes: {
      "Pilotage de programme": [/pilotage\s+(?:de|du|d'un)\s+programme/i, /\bpilote?\s+un\s+programme/i],
      "Gestion de projet": [/gestion\s+de\s+projets?/i, /pilotage\s+de\s+projets?/i],
      "Gouvernance": [/gouvernance/i],
      "Coordination d'équipes": [/coordination\s+d(?:es|e\s+l['’]|'une?)\s*[ée]quipes?/i, /coordonn\w+\s+(?:les|des)\s+[ée]quipes/i],
      "Management d'équipe": [/management\s+d(?:'|e\s+l['’])?\s*[ée]quipes?/i, /encadrement\s+d['’]?[ée]quipes?/i, /management\s+direct/i],
      "Suivi budgétaire": [/suivi\s+budg[ée]taire/i, /gestion\s+(?:du|de)\s+budget/i, /budget\s+de\s+\d/i],
      "Gestion des risques": [/gestion\s+des\s+risques/i, /analyse\s+des\s+risques/i],
      "Planification": [/planification/i, /\bplanning\b/i, /diagramme\s+de\s+gantt/i, /\bwbs\b/i],
      "Animation de COPIL": [/\bcopil\b/i, /comit[ée]s?\s+de\s+pilotage/i, /\bcoproj\b/i],
      "Reporting direction": [/reporting\s+(?:direction|de\s+direction)/i, /tableaux?\s+de\s+bord/i],
      "PMO": [/\bpmo\b/i],
    },
  },

  amoa: {
    label: "AMOA & Fonctionnel",
    termes: {
      "Recueil des besoins": [/recueil\s+d(?:es|u)\s+besoins?/i, /analyse\s+d(?:es|u)\s+besoins?/i, /expression\s+de\s+besoins?/i],
      "Cahier des charges": [/cahiers?\s+des\s+charges/i],
      "Spécifications fonctionnelles": [/sp[ée]cifications?\s+fonctionnelles?/i, /\bsfd\b/i, /\bsfg\b/i],
      "Spécifications techniques": [/sp[ée]cifications?\s+techniques?/i, /\bstd\b/i],
      "Cadrage": [/\bcadrage\b/i, /[ée]tude\s+d['’]opportunit[ée]/i],
      "Pilotage de recette": [/pilotage\s+de\s+(?:la\s+)?recette/i, /strat[ée]gie\s+de\s+recette/i, /cahiers?\s+de\s+recette/i],
      "Tests & UAT": [/\buat\b/i, /tests?\s+(?:fonctionnels?|d['’]acceptation|de\s+non[\s-]r[ée]gression)/i, /suivi\s+des\s+anomalies/i],
      "Homologation": [/homologation/i, /mise\s+en\s+production/i, /\bmep\b/i],
      "Modélisation de processus": [/mod[ée]lisation\s+(?:des?\s+)?processus/i, /cartographie\s+(?:du|des)\s+processus/i, /\bbpmn\b/i],
      "Ateliers métier": [/ateliers?\s+m[ée]tiers?/i, /animation\s+d(?:es|'|e\s+l['’])?\s*ateliers?/i],
    },
  },

  changement: {
    label: "Conduite du changement",
    termes: {
      "Conduite du changement": [/conduite\s+du\s+changement/i, /accompagnement\s+au\s+changement/i],
      "Formation des utilisateurs": [/formation\s+d(?:es|'|e\s+l['’])?\s*utilisateurs?/i, /plan\s+de\s+formation/i],
      "Support utilisateurs": [/support\s+(?:aux\s+)?utilisateurs?/i, /support\s+niveau\s+[12]/i, /\bassistance\s+utilisateurs?/i],
      "Documentation": [/r[ée]daction\s+de\s+(?:la\s+)?documentation/i, /supports?\s+utilisateurs?/i, /guides?\s+utilisateurs?/i],
      "Communication": [/plan\s+de\s+communication/i, /communication\s+interne/i],
    },
  },

  relation: {
    label: "Relation & Expérience client",
    termes: {
      "Expérience client": [/exp[ée]rience\s+client/i, /\bcx\b/],
      "Relation client": [/relation\s+client/i],
      "Satisfaction client": [/satisfaction\s+client/i, /\bcsat\b/i, /\bnps\b/i, /\bces\b/],
      "Voix du client": [/\bvoc\b/, /voix\s+du\s+client/i],
      "Parcours client": [/parcours\s+clients?/i],
      "Service client": [/service\s+clients?/i, /centre\s+de\s+contacts?/i, /\bcrm\b/i],
      "Success client": [/customer\s+success/i, /success\s+client/i],
    },
  },

  transfo: {
    label: "Transformation & Stratégie",
    termes: {
      "Transformation digitale": [/transformation\s+(?:digitale|num[ée]rique)/i],
      "Stratégie": [/strat[ée]gie\s+(?:d['’]|de\s+)/i, /vision\s+strat[ée]gique/i],
      "Optimisation des processus": [/optimisation\s+des\s+(?:processus|flux)/i, /am[ée]lioration\s+continue/i],
      "Cadrage budgétaire": [/chiffrage/i, /\broi\b/i, /business\s+case/i],
      "Innovation": [/innovation/i],
      "Migration": [/migration\s+(?:de|des|du|vers)/i, /refonte\s+(?:du|de\s+la|des)/i],
      "Audit": [/\baudit\b/i, /diagnostic/i],
    },
  },

  qualite: {
    label: "Qualité & Conformité",
    termes: {
      "Qualité de données": [/qualit[ée]\s+des?\s+donn[ée]es/i, /data\s+quality/i, /fiabilisation/i],
      "Gouvernance des données": [/gouvernance\s+des?\s+donn[ée]es/i, /data\s+governance/i],
      "Conformité réglementaire": [/conformit[ée]\s+r[ée]glementaire/i, /r[ée]glementaire/i],
      "KPI & Indicateurs": [/\bkpis?\b/i, /indicateurs?\s+(?:de\s+)?performance/i],
    },
  },
};

/**
 * Detecte les competences fonctionnelles d'un texte.
 * @returns {[{key, label, items: string[]}]} groupes non vides, dans l'ordre.
 */
function detect(texte) {
  const t = String(texte || "");
  if (!t) return [];

  const out = [];
  for (const [key, groupe] of Object.entries(GROUPES)) {
    const items = [];
    for (const [nom, motifs] of Object.entries(groupe.termes)) {
      if (motifs.some((re) => re.test(t))) items.push(nom);
    }
    if (items.length) out.push({ key, label: groupe.label, items });
  }
  return out;
}

/** Liste a plat, triee par groupe puis par ordre de declaration. */
function detectFlat(texte) {
  return detect(texte).flatMap((g) => g.items);
}

module.exports = { detect, detectFlat, GROUPES };
