// Analyse LOCALE des pièces (Kbis / URSSAF…) — SANS LLM, sans envoi externe (RGPD OK).
// PDF : texte extrait par pdf-parse. Image : OCR par tesseract.js.
// Puis parsing par règles : type de document, correspondance de société, date de délivrance.

const { PDFParse } = require("pdf-parse");

const pad = (n) => String(n).padStart(2, "0");
const FR_MONTHS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];

function norm(s) {
  return String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

async function extractText(buffer, mime) {
  const isPdf = (mime || "").includes("pdf") || buffer.slice(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) {
    const parser = new PDFParse({ data: buffer });
    try { const r = await parser.getText(); return r.text || ""; }
    finally { try { await parser.destroy(); } catch (e) {} }
  }
  // Image → OCR (télécharge le modèle « fra » à la première utilisation)
  const { createWorker } = require("tesseract.js");
  const worker = await createWorker("fra");
  try { const { data } = await worker.recognize(buffer); return data.text || ""; }
  finally { try { await worker.terminate(); } catch (e) {} }
}

function detectType(nt, items) {
  let type = "", key = "";
  if (/EXTRAIT KBIS|K BIS|GREFFE DU TRIBUNAL DE COMMERCE/.test(nt)) { type = "Extrait Kbis"; key = "kbis"; }
  else if (/VIGILANCE/.test(nt) && /URSSAF/.test(nt)) { type = "Attestation de vigilance URSSAF"; key = "urssaf"; }
  else if (/ATTESTATION DE VIGILANCE/.test(nt)) { type = "Attestation de vigilance URSSAF"; key = "urssaf"; }
  else if (/URSSAF/.test(nt)) { type = "Document URSSAF"; key = "urssaf"; }
  else if (/REGULARITE FISCALE|DECLARATIONS FISCALES|ATTESTATION FISCALE/.test(nt)) { type = "Attestation de régularité fiscale"; key = "fiscale"; }
  else if (/RELEVE D IDENTITE BANCAIRE|\bIBAN\b|\bBIC\b/.test(nt)) { type = "RIB"; key = "rib"; }
  else if (/CARTE NATIONALE D IDENTITE|PIECE D IDENTITE|PASSEPORT|TITRE DE SEJOUR/.test(nt)) { type = "Pièce d'identité"; key = "cni"; }
  const item = (items || [])[0];
  const matchedId = (item && key && item.id === key) ? item.id : null;
  return { documentType: type || "Document non identifié", matchedId, key };
}

function extractCompanyName(text) {
  const m = text.match(/(?:D[ée]nomination(?:\s+sociale)?|Raison\s+sociale|Soci[ée]t[ée])\s*:?\s*([^\n]{2,80})/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}

function checkName(text, expectedName) {
  if (!expectedName) return null;
  const nt = norm(text);
  const tokens = norm(expectedName).split(" ")
    .filter((t) => t.length >= 3 && !/^(SARL|SAS|SASU|EURL|SA|SCI|GROUPE|EI)$/.test(t));
  if (!tokens.length) return null;
  const found = tokens.filter((t) => nt.includes(t)).length;
  return found >= Math.ceil(tokens.length * 0.6);
}

function extractIssuedDate(text) {
  const now = new Date();
  const minY = 2000, maxY = now.getFullYear() + 1; // rejette les années aberrantes (ex : 2124)
  const todayIso = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  const dates = [];
  let m;
  const re1 = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/g;
  while ((m = re1.exec(text))) {
    const dd = +m[1], mm = +m[2], yy = +m[3];
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yy >= minY && yy <= maxY) dates.push({ iso: yy + "-" + pad(mm) + "-" + pad(dd), idx: m.index });
  }
  const re2 = /(\d{1,2})\s+([A-Za-zûéèàêôä]+)\s+(\d{4})/g;
  while ((m = re2.exec(text))) {
    const mo = FR_MONTHS.indexOf(norm(m[2]).toLowerCase()), yy = +m[3];
    if (mo >= 0 && yy >= minY && yy <= maxY) dates.push({ iso: yy + "-" + pad(mo + 1) + "-" + pad(+m[1]), idx: m.index });
  }
  if (!dates.length) return "";
  // 1) date proche d'un mot-clé de délivrance (mots complets, pas de « LE » trop large)
  const kw = /(D[ÉE]LIVR|[ÀA] JOUR AU|[ÉE]DIT[ÉE]? LE|[ÉE]TABLI LE|[ÉE]MISE? LE|FAIT [ÀA]? ?[A-Z ]*LE|EN DATE DU|DATE DE D[ÉE]LIVRANCE)/;
  const near = dates.filter((d) => kw.test(norm(text.slice(Math.max(0, d.idx - 55), d.idx))));
  if (near.length) return near.map((d) => d.iso).sort().reverse()[0];
  // 2) sinon : la date la plus récente qui n'est PAS dans le futur (une délivrance ne peut pas être future)
  const past = dates.filter((d) => d.iso <= todayIso).map((d) => d.iso).sort();
  if (past.length) return past[past.length - 1];
  // 3) sinon : la date la plus ancienne trouvée
  return dates.map((d) => d.iso).sort()[0];
}

async function analyzeDocumentLocal({ dataBase64, mimeType, items, expectedName } = {}) {
  if (!dataBase64) throw new Error("Aucun fichier reçu.");
  const buffer = Buffer.from(dataBase64, "base64");
  const text = ((await extractText(buffer, mimeType)) || "").trim();
  if (text.length < 15) {
    return {
      documentType: "Document", matchedId: null, isValid: false, issuedDate: "",
      companyName: null, nameMatches: null,
      issues: ["Aucun texte lisible (PDF scanné sans texte ou image floue). Fournir un PDF texte ou une image nette."],
      summary: "Document illisible.",
    };
  }
  const nt = norm(text);
  const { documentType, matchedId } = detectType(nt, items);
  const nameMatches = checkName(text, expectedName);
  const companyName = extractCompanyName(text) || (nameMatches ? expectedName : null);
  const issuedDate = extractIssuedDate(text);
  const issues = [];
  if (nameMatches === false) issues.push("La société du document ne correspond pas au sous-traitant saisi.");
  if (!issuedDate) issues.push("Date de délivrance non trouvée dans le document.");
  return {
    documentType, matchedId, isValid: true, issuedDate, companyName, nameMatches, issues,
    summary: documentType + (issuedDate ? " — délivré le " + issuedDate : ""),
  };
}

// checkName est aussi exportée (issue #153) : réutilisée telle quelle par
// lib/kbis-mapping.js pour comparer le company_name structuré extrait par
// DocIE au nom attendu, sans dupliquer cette règle de correspondance.
// norm/extractCompanyName/extractIssuedDate restent exportées pour d'usage
// direct (tests, autres consommateurs locaux) mais ne servent plus à
// l'extraction DocIE depuis que celle-ci lit des champs structurés
// (lib/kbis-mapping.js) plutôt que du texte aplati.
module.exports = { analyzeDocumentLocal, extractText, norm, checkName, extractCompanyName, extractIssuedDate };
