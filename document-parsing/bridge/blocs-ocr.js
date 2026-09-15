"use strict";

// Fabrique les `ocr_blocks` de la voie texte à partir de ce qu'un appelant sait
// déjà de son document : ses paragraphes, et ses pages quand il en a.
//
// Pourquoi ce module existe. DocIE ne découpe le texte lui-même que si personne
// ne lui donne de blocs, et il en fait alors UNE LIGNE NON VIDE = UN BLOC
// (ocr/base.py::text_to_blocks) dont seuls les 800 premiers entrent dans le
// prompt (llm/prompts.py:134), en silence. Le plafond se compte donc en LIGNES,
// pas en contenu : un contrat de 1 200 lignes est tronqué alors qu'il tient
// largement dans le contexte du modèle. Nos deux rendus de DOCX produisent déjà
// une ligne par paragraphe (cv-parser/docie_client.py::_blocs,
// one-pager/lib/ingest.js::texteDocx), et la couche texte d'un PDF en produit
// bien plus — d'où ce regroupement.
//
// Ce qu'il ne fait PAS : inventer des frontières. Il regroupe des lignes
// consécutives, dans l'ordre, sans jamais franchir une page. Le texte d'un bloc
// est exactement celui de ses lignes, joint par "\n".
//
// Règle de conception, la seule qui compte ici : REGROUPER COÛTE DE LA
// PRÉCISION D'ANCRAGE. Un `evidence_id` désigne un bloc ; un bloc de dix lignes
// est une preuve dix fois plus grossière. On ne regroupe donc QUE lorsque
// l'alternative est la troncature silencieuse — en dessous du plafond, une
// ligne reste un bloc et l'ancrage est aussi fin qu'aujourd'hui.
//
// Le module est volontairement à côté du transport et lui EMPRUNTE ses plafonds,
// sa classe de blancs et son validateur (`validerBlocsOcr`) : une deuxième copie
// du plafond de 800, ou de la classe de blancs de Python, est exactement la
// dérive que le pont partagé existe pour empêcher.
const { createHash } = require("node:crypto");
const { DOCIE_BLOCS_TEXTE_MAX, DOCIE_BLOC_CARACTERES_MAX, LIGNE_BLANCHE_PYTHON,
  validerBlocsOcr, DocIEBridgeError } = require("./docie-bridge");

// Même forme d'identifiant que ceux que DocIE fabrique quand c'est lui qui
// découpe (`ocr/base.py:27`, `f"b{page}_{index}_{sha256(...)[:12]}"`) : les
// nôtres partent verbatim et reviennent tels quels dans `evidence_ids`, donc
// autant qu'ils se lisent comme les siens. Déterministe : le même document
// réimporté donne les mêmes ids, et une preuve enregistrée reste rattachable.
function identifiant(page, index, texte) {
  const empreinte = createHash("sha256").update(page + ":" + index + ":" + texte, "utf8").digest("hex").slice(0, 12);
  return "b" + page + "_" + index + "_" + empreinte;
}

function echouer(message) {
  throw new DocIEBridgeError("input", message);
}

// Points de code, comme `len()` côté DocIE (voir docie-bridge.js::pointsDeCode).
function pointsDeCode(texte) {
  let total = 0;
  for (const _ of texte) total++;
  return total;
}

// Blanc au sens de `str.strip()` de Python — la règle de DocIE, pas celle de
// `trim()` : une ligne réduite à un BOM est un bloc pour lui (elle consomme une
// place des 800), alors que `trim()` la dirait vide.
function ligneBlanche(texte) {
  return LIGNE_BLANCHE_PYTHON.test(texte);
}

// Pages normalisées : numéros entiers >= 1, lignes non blanches, pages vides
// écartées. L'ordre de lecture de l'appelant est conservé tel quel — c'est lui
// qui sait si sa page a deux colonnes, pas ce module.
function normaliser(pages) {
  if (!Array.isArray(pages) || !pages.length) echouer("Pages must be a non-empty array of {page, lignes}.");
  const propres = [];
  for (const [index, page] of pages.entries()) {
    const ou = " (pages[" + index + "])";
    if (page === null || typeof page !== "object" || Array.isArray(page)) echouer("Each page must be an object" + ou + ".");
    const numero = page.page;
    if (!Number.isInteger(numero) || numero < 1) echouer("Page number must be an integer >= 1" + ou + ".");
    if (!Array.isArray(page.lignes)) echouer("Page lignes must be an array of strings" + ou + ".");
    const lignes = [];
    for (const ligne of page.lignes) {
      if (typeof ligne !== "string") echouer("Each line must be a string" + ou + ".");
      if (!ligneBlanche(ligne)) lignes.push(ligne);
    }
    if (lignes.length) propres.push({ page: numero, lignes });
  }
  if (!propres.length) echouer("No non-blank line to send: DocIE would extract from nothing.");
  return propres;
}

// Remplissage glouton par budget de caractères, page par page. Un bloc se ferme
// quand la ligne suivante le ferait dépasser le budget, jamais au milieu d'une
// ligne, et jamais d'une page à l'autre. Une ligne plus longue que le plafond
// DocIE par bloc reste seule dans son bloc : la découper inventerait une
// frontière que le document n'a pas, et `validerBlocsOcr` refusera bruyamment.
function empaqueter(pages, budget) {
  const blocs = [];
  for (const { page, lignes } of pages) {
    let courant = [], taille = 0, index = 0;
    const fermer = () => {
      if (!courant.length) return;
      const texte = courant.join("\n");
      blocs.push({ id: identifiant(page, index, texte), text: texte, page, source: "manual" });
      index++; courant = []; taille = 0;
    };
    for (const ligne of lignes) {
      const coutLigne = pointsDeCode(ligne);
      if (courant.length && (taille + 1 + coutLigne > budget || taille + 1 + coutLigne > DOCIE_BLOC_CARACTERES_MAX)) fermer();
      courant.push(ligne);
      taille += (taille ? 1 : 0) + coutLigne;
    }
    fermer();
  }
  return blocs;
}

/**
 * Blocs d'un document dont on connaît les pages.
 *
 * @param {Array<{page: number, lignes: string[]}>} pages — ordre de lecture de
 *   l'appelant, une entrée par page, lignes déjà rendues (paragraphes d'un
 *   DOCX, lignes d'une couche texte de PDF).
 * @param {{max?: number}} options — `max` : nombre de blocs visé, par défaut le
 *   plafond de prompt de DocIE (800). Descendre plus bas n'a d'intérêt que pour
 *   `parallel_extraction`, où le document est évalué une fois par groupe.
 * @returns {{blocs: object[], resume: {lignes: number, blocs: number,
 *   caracteres: number, groupees: boolean}}} — `groupees` dit si le
 *   regroupement a eu lieu, donc si l'ancrage est plus grossier qu'une ligne.
 */
function blocsDepuisPages(pages, { max = DOCIE_BLOCS_TEXTE_MAX } = {}) {
  if (!Number.isInteger(max) || max < 1 || max > DOCIE_BLOCS_TEXTE_MAX) {
    echouer("max must be an integer between 1 and " + DOCIE_BLOCS_TEXTE_MAX + ".");
  }
  const propres = normaliser(pages);
  const lignes = propres.reduce((n, p) => n + p.lignes.length, 0);
  const caracteres = propres.reduce((n, p) => n + p.lignes.reduce((k, l) => k + pointsDeCode(l), 0), 0);
  // Sous le plafond : une ligne = un bloc, l'ancrage reste au plus fin. C'est
  // le cas courant (un CV, un Kbis) et il ne paie rien pour un problème qu'il
  // n'a pas.
  let blocs = empaqueter(propres, 0);
  if (blocs.length > max) {
    // Chaque page finit sur un bloc partiel, donc un budget ne garantit pas à
    // lui seul le compte visé : on resserre jusqu'à y être. Convergence : le
    // budget croît strictement, et un budget supérieur au total des caractères
    // donne un bloc par page, soit au plus `pages` blocs.
    let budget = Math.max(1, Math.ceil(caracteres / max));
    for (let essai = 0; essai < 40 && blocs.length > max; essai++) {
      blocs = empaqueter(propres, budget);
      budget = Math.ceil(budget * 1.25) + 1;
    }
    if (blocs.length > max) {
      echouer("Cannot pack " + lignes + " lines into " + max + " blocks: " + propres.length + " pages, and a block never spans two pages.");
    }
  }
  // Le validateur du transport a le dernier mot : ce module ne réimplémente
  // aucune de ses règles, il doit simplement produire ce qu'il accepte.
  const { blocs: valides } = validerBlocsOcr(blocs);
  return { blocs: valides, resume: { lignes, blocs: valides.length, caracteres, groupees: valides.length < lignes } };
}

/**
 * Blocs d'un document sans pagination connue — les paragraphes d'un DOCX, un
 * .txt. Tout est rattaché à `page`, 1 par défaut : DocIE n'émet alors aucun
 * marqueur `[page N]` (llm/prompts.py:136-146, ils n'apparaissent que si les
 * blocs gardés couvrent plus d'une page), ce qui est exact — nous n'avons pas
 * cette information à lui donner.
 */
function blocsDepuisLignes(lignes, { page = 1, max = DOCIE_BLOCS_TEXTE_MAX } = {}) {
  return blocsDepuisPages([{ page, lignes }], { max });
}

module.exports = { blocsDepuisPages, blocsDepuisLignes };
