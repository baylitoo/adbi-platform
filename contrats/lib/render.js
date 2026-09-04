// Remplissage des variables {{cle}} et resolution des blocs actifs (options).
function fill(text, values) {
  if (text == null) return "";
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = values[k];
    if (v === undefined || v === null || v === "") return /Clause$/.test(k) ? "" : "\u2026\u2026\u2026\u2026";
    return String(v);
  });
}

// Comme fill(), mais met les VALEURS des variables en gras (**valeur**) pour les
// faire ressortir dans le corps du contrat. Les champs vides restent en placeholder.
function fillBold(text, values) {
  if (text == null) return "";
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = values[k];
    if (v === undefined || v === null || v === "") return /Clause$/.test(k) ? "" : "…………";
    return "**" + String(v) + "**";
  });
}

// Decoupe une chaine en runs {text, bold} a partir des **gras**
function runs(text) {
  const out = [];
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith("**") && p.endsWith("**")) out.push({ text: p.slice(2, -2), bold: true });
    else out.push({ text: p, bold: false });
  }
  return out;
}

// Filtre les blocs selon les options activees
function activeBlocks(blocks, options) {
  return blocks.filter((b) => !b.opt || options[b.opt]);
}

module.exports = { fill, fillBold, runs, activeBlocks };
