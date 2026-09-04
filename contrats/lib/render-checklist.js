const PDFDocument = require("pdfkit");
const { fill } = require("./render");
const NAVY = "#1B2559", ACCENT = "#C81E78", GREY = "#888888";

function buildChecklistPdf(items, values, doneMap) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: 60, right: 60 } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width - 120;

    doc.font("Helvetica-Bold").fontSize(22).fillColor(ACCENT).text("adbi", { align: "left" });
    doc.font("Helvetica-Bold").fontSize(15).fillColor(NAVY).text("Checklist des documents \u00E0 collecter", { align: "left" });
    doc.font("Helvetica").fontSize(10).fillColor("#444")
      .text("Sous-Traitant : " + fill("{{stNom}}", values) + "   \u2014   Contrat n\u00B0 " + fill("{{numeroContrat}}", values));
    doc.moveTo(60, doc.y + 6).lineTo(doc.page.width - 60, doc.y + 6).strokeColor(ACCENT).lineWidth(1).stroke();
    doc.moveDown(1.2);

    items.forEach((it) => {
      const done = doneMap && doneMap[it.id];
      const y = doc.y;
      // case a cocher
      doc.rect(62, y + 1, 11, 11).strokeColor(done ? "#1E9E5A" : "#999").lineWidth(1).stroke();
      if (done) doc.font("Helvetica-Bold").fontSize(10).fillColor("#1E9E5A").text("X", 64.5, y + 1.5, { lineBreak: false });
      doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(it.label, 84, y, { width: W - 24 });
      const meta = [it.art, it.recurrent].filter(Boolean).join("  \u2022  ");
      if (meta) doc.font("Helvetica-Oblique").fontSize(8).fillColor(GREY).text(meta, 84, doc.y, { width: W - 24 });
      doc.moveDown(0.7);
    });

    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor(GREY)
      .text("Document g\u00E9n\u00E9r\u00E9 par l'outil ADBI \u2014 \u00E0 conserver au dossier sous-traitant. Pi\u00E8ces \u00E0 renouveler tous les 6 mois conform\u00E9ment \u00E0 l'article 12.", { align: "left" });
    doc.end();
  });
}

module.exports = { buildChecklistPdf };
