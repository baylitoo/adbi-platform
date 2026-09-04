const PDFDocument = require("pdfkit");
const path = require("path");
const { fill, fillBold, runs, activeBlocks } = require("./render");

const NAVY = "#1B2559";
const ACCENT = "#C81E78";
const GREY = "#888888";
const RULE = "#C7CEE0";
const MARGIN = 60;
const TOP_MARGIN = 120; // réserve la place de l'en-tête répété (pages 2+)
const GAP = 20;
const LOGO = path.join(__dirname, "..", "public", "logo-adbi.png");

// signatures (optionnel) : { left: {png, nom, quand}, right: {…}, certificat: {…} }
// — images apposées dans les cadres de signature + page « Certificat de signature »
// ajoutée en fin de document (flux d'envoi en signature électronique, façon Zoho Sign).
function buildPdf(tpl, values, options, signatures) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: TOP_MARGIN, bottom: 70, left: MARGIN, right: MARGIN }, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - MARGIN * 2;
    const blocks = activeBlocks(tpl.blocks, options);
    const numero = fill("{{numeroContrat}}", values);

    // En-tête (cadre + logo + titre + n°) répété sur chaque page SAUF la couverture.
    // La couverture (page 1) existe avant cet écouteur → pas d'en-tête dessus.
    let pageNum = 1;
    let drawing = false;
    function drawHeaderFooter() {
      const sx = doc.x, sy = doc.y;
      const ob = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // évite que le pied (bas de page) déclenche une nouvelle page
      doc.save();
      const hx0 = MARGIN, hx1 = doc.page.width - MARGIN, hy0 = 26, hy1 = 110;
      doc.rect(hx0, hy0, hx1 - hx0, hy1 - hy0).lineWidth(0.8).strokeColor("#333333").stroke();
      const logoW = 80;
      try { doc.image(LOGO, hx0 + 14, hy0 + 12, { width: logoW }); } catch (e) {}
      // N° de contrat sous le logo, avec un petit espace
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#222222")
        .text(fill(tpl.headerNum || "N° de contrat : {{numeroContrat}}", values), hx0 + 14, hy0 + 64, { width: logoW + 120, lineBreak: false });
      // Titre centré au milieu du cadre (marges symétriques pour dégager le logo)
      const pad = logoW + 24;
      const titleStr = fill(tpl.headerTitle || "CONVENTION DE SOUS-TRAITANCE D'ASSISTANCE TECHNIQUE", values);
      const tw = hx1 - hx0 - 2 * pad;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY);
      const th = doc.heightOfString(titleStr, { width: tw, align: "center" });
      doc.text(titleStr, hx0 + pad, hy0 + (hy1 - hy0 - th) / 2, { width: tw, align: "center" });
      doc.restore();
      doc.page.margins.bottom = ob;
      doc.x = sx; doc.y = sy;
    }
    doc.on("pageAdded", () => {
      if (drawing) return; // anti-réentrance
      drawing = true;
      pageNum++;
      drawHeaderFooter();
      doc.x = MARGIN; doc.y = TOP_MARGIN;
      drawing = false;
    });

    // ---- État deux colonnes ----
    let twoCol = false, col = 0, colTop = MARGIN, colW = 0;
    const colBottom = () => doc.page.height - 75;
    const colX = () => (col === 0 ? MARGIN : MARGIN + colW + GAP);
    function drawDivider() {
      const cx = MARGIN + colW + GAP / 2;
      doc.save();
      doc.moveTo(cx, colTop).lineTo(cx, colBottom()).lineWidth(0.7).strokeColor(RULE).stroke();
      doc.restore();
    }

    // Rend une suite de runs (gras inline) à partir de (x, doc.y), dans la largeur donnée.
    function renderRuns(text, x, width, opt = {}) {
      const f = opt.boldVars ? fillBold : fill;
      let rs = runs(f(text, values));
      // pdfkit (mode continued) AVALE les espaces en TÊTE d'un segment : après une
      // valeur en gras, « **X** est » devenait « Xest ». On transfère ces espaces à
      // la FIN du segment précédent (que pdfkit conserve), puis on écarte les vides.
      for (let i = 1; i < rs.length; i++) {
        const m = rs[i].text.match(/^\s+/);
        if (m) { rs[i - 1].text += m[0]; rs[i].text = rs[i].text.slice(m[0].length); }
      }
      rs = rs.filter((r) => r.text);
      rs.forEach((r, i) => {
        const last = i === rs.length - 1;
        doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opt.size || 9.5).fillColor(opt.color || "#222222");
        const o = { width, align: opt.align || "justify", continued: !last, lineGap: 1.5 };
        if (i === 0) doc.text(r.text, x, doc.y, o);
        else doc.text(r.text, o);
      });
    }

    // Hauteur estimée d'un bloc « flux » (mesure en gras = borne haute, évite les débordements).
    function blockHeight(b, width) {
      if (b.t === "spacer") return 6;
      if (b.t === "h2") { doc.font("Helvetica-Bold").fontSize(11); return 7 + doc.heightOfString(fill(b.x, values), { width, lineGap: 1 }) + 3; }
      if (b.t === "h3") { doc.font("Helvetica-Bold").fontSize(10); return 5 + doc.heightOfString(fill(b.x, values), { width, lineGap: 1 }) + 2; }
      const bullet = b.t === "dash" ? "–  " : b.t === "li" ? "•  " : "";
      doc.font("Helvetica-Bold").fontSize(9.5);
      const plain = (bullet + fillBold(b.x, values)).replace(/\*\*/g, "");
      return doc.heightOfString(plain, { width, lineGap: 1.5 }) + 6;
    }

    // Dessine un bloc « flux » à (x, doc.y) et avance doc.y.
    function drawFlow(b, x, width) {
      switch (b.t) {
        case "spacer":
          doc.y += 6; break;
        case "h2":
          doc.y += 7;
          doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text(fill(b.x, values), x, doc.y, { width, align: "left", lineGap: 1 });
          doc.y += 3; break;
        case "h3":
          doc.y += 5;
          doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text(fill(b.x, values), x, doc.y, { width, align: "left", lineGap: 1 });
          doc.y += 2; break;
        case "p":
          renderRuns(b.x, x, width, { boldVars: true });
          doc.y += 5; break;
        case "dash":
        case "li": {
          const bullet = b.t === "dash" ? "–  " : "•  ";
          renderRuns(bullet + b.x, x, width, { boldVars: true });
          doc.y += 4; break;
        }
        default: break;
      }
    }

    // Place un bloc dans la colonne courante (deux colonnes) : bascule colonne/page si besoin.
    function placeFlow(b) {
      let h = blockHeight(b, colW);
      if (b.t === "h2" || b.t === "h3") h += 26; // garder le titre avec le début de l'article
      if (doc.y + h > colBottom()) {
        if (col === 0) { col = 1; doc.y = colTop; }
        else { doc.addPage(); colTop = TOP_MARGIN; doc.y = TOP_MARGIN; col = 0; drawDivider(); }
      }
      drawFlow(b, colX(), colW);
    }

    const FLOW = { h2: 1, h3: 1, p: 1, dash: 1, li: 1, spacer: 1 };

    // Avenant : pas de couverture → dessiner l'en-tête encadré dès la 1re page.
    if (tpl.headerOnFirst) { drawHeaderFooter(); doc.x = MARGIN; doc.y = TOP_MARGIN; }

    for (const b of blocks) {
      if (FLOW[b.t]) {
        if (twoCol) placeFlow(b);
        else drawFlow(b, MARGIN, W);
        continue;
      }
      switch (b.t) {
        case "col2-start":
          twoCol = true; col = 0; colW = (W - GAP) / 2; colTop = doc.y; drawDivider();
          break;
        case "col2-end":
          twoCol = false; doc.addPage(); doc.x = MARGIN; doc.y = TOP_MARGIN;
          break;
        case "cover": {
          doc.y = 70; // la garde n'a pas d'en-tête : on remonte le contenu
          doc.moveDown(5);
          const lw = 210, lh = lw / 2;
          try {
            doc.image(LOGO, (doc.page.width - lw) / 2, doc.y, { width: lw });
            doc.y += lh + 12;
          } catch (e) {
            doc.font("Helvetica-Bold").fontSize(40).fillColor(ACCENT).text("adbi", { align: "center" });
          }
          doc.moveDown(2);
          doc.font("Helvetica-Bold").fontSize(20).fillColor(NAVY).text(tpl.titre, MARGIN, doc.y, { width: W, align: "center" });
          doc.moveDown(4);
          doc.font("Helvetica").fontSize(12).fillColor(NAVY)
            .text("Contrat n° " + fill("{{numeroContrat}}", values), { align: "center" })
            .text("Version " + fill("{{version}}", values), { align: "center" });
          break;
        }
        case "pagebreak":
          doc.addPage();
          break;
        case "parties":
          doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text("ENTRE LES SOUSSIGNÉS :", MARGIN, doc.y, { width: W });
          doc.moveDown(0.5);
          doc.font("Helvetica-Bold").fontSize(11).fillColor("#222").text(fill("{{adbiNom}}", values), { width: W });
          doc.font("Helvetica").fontSize(9.5).fillColor("#222")
            .text(fill("{{adbiAdresse}}", values), { width: W })
            .text("Capital : " + fill("{{adbiCapital}}", values) + " — " + fill("{{adbiRcs}}", values), { width: W })
            .text("Représentée par : " + fill("{{adbiRepresentant}}", values) + ", dûment habilité à signer les présentes", { width: W });
          doc.font("Helvetica-Oblique").fontSize(9.5).text("Ci-après désignée le « Client », d’une part", { width: W, align: "right" });
          doc.moveDown(1.5);
          doc.font("Helvetica-Bold").fontSize(11).fillColor("#222").text("ET", { width: W });
          doc.moveDown(0.7);
          doc.font("Helvetica-Bold").fontSize(11).text(fill("{{stNom}}", values), { width: W });
          doc.font("Helvetica").fontSize(9.5).fillColor("#222");
          if (values.stFormeJuridique) doc.text(fill("{{stFormeJuridique}}", values), { width: W });
          doc.text("Adresse : " + fill("{{stAdresse}}", values), { width: W });
          doc.text("SIREN : " + fill("{{stSiren}}", values) + "   —   SIRET : " + fill("{{stSiret}}", values), { width: W });
          doc.text("Représentée par : " + fill("{{stRepresentant}}", values) + (values.stQualite ? ", en sa qualité de " + fill("{{stQualite}}", values) : "") + ", dûment habilité à signer les présentes", { width: W });
          doc.font("Helvetica-Oblique").fontSize(9.5).text("Ci-après désignée le « Sous-Traitant », d’autre part", { width: W, align: "right" });
          doc.moveDown(0.8);
          break;
        case "annexe-title":
          doc.moveDown(0.5);
          doc.font("Helvetica-Bold").fontSize(13).fillColor(NAVY).text(fill(b.x, values), MARGIN, doc.y, { width: W, align: "center" });
          doc.moveTo(MARGIN, doc.y + 3).lineTo(doc.page.width - MARGIN, doc.y + 3).strokeColor(ACCENT).lineWidth(1).stroke();
          doc.moveDown(0.8);
          break;
        case "signatures": {
          // Respect du saut de page : on garde tout le bloc signature (avec cachet) sur une même page.
          if (doc.y + 340 > doc.page.height - 70) doc.addPage();
          doc.moveDown(0.6);
          doc.font("Helvetica").fontSize(9.5).fillColor("#222").text(fill("Fait le {{dateRedaction}} à {{lieuRedaction}}, en deux exemplaires originaux, chacune des parties reconnaissant avoir reçu le sien.", values), MARGIN, doc.y, { width: W, align: "justify" });
          doc.moveDown(1.6);
          const yTop = doc.y;
          const cW = (W - 30) / 2;
          const leftX = MARGIN, rightX = MARGIN + cW + 30;
          const lTitle = b.leftTitle || "Pour le Client — {{adbiNom}}";
          const rTitle = b.rightTitle || "Pour le Sous-Traitant — {{stNom}}";
          const lName = b.leftName || "{{adbiRepresentant}}";
          const rName = b.rightName || "{{sigStNom}}";
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text(fill(lTitle, values), leftX, yTop, { width: cW });
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text(fill(rTitle, values), rightX, yTop, { width: cW });
          const y2 = doc.y + 8;
          doc.font("Helvetica").fontSize(9.5).fillColor("#222");
          doc.text("Nom : " + fill(lName, values), leftX, y2, { width: cW });
          doc.text("Nom : " + fill(rName, values), rightX, y2, { width: cW });
          const lSubTxt = fill(b.leftSub || "", values);
          const rSubTxt = fill(b.rightSub || "{{sigStQualiteClause}}", values);
          let yAfterName = doc.y;
          if (lSubTxt || rSubTxt) {
            const y2b = yAfterName + 3;
            if (lSubTxt) doc.text(lSubTxt, leftX, y2b, { width: cW });
            if (rSubTxt) doc.text(rSubTxt, rightX, y2b, { width: cW });
            yAfterName = doc.y;
          }
          const y3 = yAfterName + 16;
          doc.text("Signature :", leftX, y3, { width: cW });
          doc.text("Signature :", rightX, y3, { width: cW });
          // Espace de signature manuscrite + ligne
          const ySign = y3 + 80;
          // Capture des positions RÉELLES des cadres de signature (page + x/y,
          // origine haut-gauche) : un fournisseur externe (Yousign…) y pose ses
          // champs exactement au bon endroit du document.
          if (signatures && signatures.sortiePositions) {
            signatures.sortiePositions.page = doc.bufferedPageRange().count;
            signatures.sortiePositions.gauche = { x: leftX, y: y3 + 10 };
            signatures.sortiePositions.droite = { x: rightX, y: y3 + 10 };
          }
          doc.save().strokeColor("#999").lineWidth(0.6);
          doc.moveTo(leftX, ySign).lineTo(leftX + cW - 10, ySign).stroke();
          doc.moveTo(rightX, ySign).lineTo(rightX + cW - 10, ySign).stroke();
          doc.restore();
          // Signatures électroniques : l'image du signataire remplit l'espace manuscrit,
          // avec l'horodatage juste sous la ligne (la partie non signée garde son cadre vide).
          const sigs = signatures || {};
          [["left", leftX], ["right", rightX]].forEach(([side, sx]) => {
            const s = sigs[side];
            if (!s || !s.png) return;
            try { doc.image(s.png, sx + 6, y3 + 14, { fit: [cW - 40, 58] }); } catch (e) {}
            // Le nom figure déjà au-dessus et le certificat détaille : mention courte.
            doc.font("Helvetica-Oblique").fontSize(6.5).fillColor("#444")
              .text("Signé électroniquement le " + (s.quand || ""), sx, ySign + 1.5, { width: cW - 10, lineBreak: false });
          });
          // Mention « Lu et approuvé » + emplacement du cachet, pour chaque partie.
          const yLu = ySign + 12;
          doc.font("Helvetica").fontSize(8.5).fillColor("#222");
          doc.text("Lu et approuvé, bon pour accord", leftX, yLu, { width: cW });
          doc.text("Lu et approuvé, bon pour accord", rightX, yLu, { width: cW });
          const yCachet = yLu + 16;
          doc.font("Helvetica").fontSize(9).fillColor("#444");
          doc.text("Cachet :", leftX, yCachet, { width: cW });
          doc.text("Cachet :", rightX, yCachet, { width: cW });
          const boxY = yCachet + 14, boxW = Math.min(150, cW - 10), boxH = 58;
          doc.save().strokeColor("#cccccc").lineWidth(0.6).dash(2, { space: 2 });
          doc.rect(leftX, boxY, boxW, boxH).stroke();
          doc.rect(rightX, boxY, boxW, boxH).stroke();
          doc.undash().restore();
          // Cachet d'entreprise transmis lors de la signature électronique (optionnel).
          [["left", leftX], ["right", rightX]].forEach(([side, sx]) => {
            const s = sigs[side];
            if (!s || !s.cachet) return;
            try { doc.image(s.cachet, sx + 4, boxY + 4, { fit: [boxW - 8, boxH - 8] }); } catch (e) {}
          });
          doc.x = MARGIN; doc.y = boxY + boxH + 12;
          doc.font("Helvetica-Oblique").fontSize(8).fillColor(GREY).text("Porter la mention manuscrite « Lu et approuvé – Bon pour accord »", MARGIN, doc.y, { width: W });
          break;
        }
        case "table": {
          const rows = [b.headers, ...(b.rows || [])];
          const colW1 = W * 0.64, colW2 = W - colW1;
          const heights = rows.map((r, ri) => {
            doc.font(ri === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9);
            const h1 = doc.heightOfString(String(r[0]), { width: colW1 - 12 });
            const h2 = doc.heightOfString(String(r[1]), { width: colW2 - 12 });
            return Math.max(h1, h2, 12) + 8;
          });
          const totalH = heights.reduce((a, v) => a + v, 0);
          if (doc.y + Math.min(totalH, 140) > doc.page.height - 90) { doc.addPage(); doc.y = TOP_MARGIN; }
          let ty = doc.y + 4;
          rows.forEach((r, ri) => {
            const rh = heights[ri];
            if (ri === 0) doc.save().rect(MARGIN, ty, W, rh).fillColor("#E6E6E6").fill().restore();
            doc.font(ri === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#222222")
              .text(String(r[0]), MARGIN + 6, ty + 4, { width: colW1 - 12 });
            doc.font(ri === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#222222")
              .text(String(r[1]), MARGIN + colW1 + 6, ty + 4, { width: colW2 - 12 });
            doc.save().lineWidth(0.6).strokeColor("#999999");
            doc.rect(MARGIN, ty, colW1, rh).stroke();
            doc.rect(MARGIN + colW1, ty, colW2, rh).stroke();
            doc.restore();
            ty += rh;
          });
          doc.x = MARGIN; doc.y = ty + 8;
          break;
        }
        default:
          break;
      }
    }

    // Pied de page « libellé — n / total » sur chaque page (pagination 1/20, 2/20…).
    // Passe finale (bufferPages) : le total n'est connu qu'une fois tout le contenu placé.
    // La couverture (si présente) n'est pas numérotée, comme dans l'export Word.
    const range = doc.bufferedPageRange();
    const footBase = fill(tpl.footerText || "Convention de sous-traitance — Contrat n° {{numeroContrat}}", values);
    const paraphes = (signatures && signatures.paraphes) || [];
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const ob = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      // Paraphe (initiales des signataires) en bas de chaque page, couverture comprise.
      if (paraphes.length) {
        doc.font("Helvetica-BoldOblique").fontSize(9).fillColor("#555555")
          .text(paraphes.join("   "), MARGIN, doc.page.height - 58, { width: W, align: "right", lineBreak: false });
      }
      if (!(!tpl.headerOnFirst && i === 0)) { // page de couverture : pas de pied
        doc.font("Helvetica").fontSize(8).fillColor(GREY).text(
          footBase + "   —   " + (i + 1) + " / " + range.count,
          MARGIN, doc.page.height - 42, { align: "center", width: W, lineBreak: false }
        );
      }
      doc.page.margins.bottom = ob;
    }
    doc.end();
  });
}

// Certificat de signature électronique — DOCUMENT SÉPARÉ du contrat signé
// (deux fichiers distincts, comme Zoho Sign : le contrat, et son certificat).
function buildCertificatPdf(c) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: MARGIN, right: MARGIN } });
    const chunks = [];
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width - MARGIN * 2;

    try { doc.image(LOGO, MARGIN, 40, { width: 90 }); } catch (e) {}
    doc.font("Helvetica-Bold").fontSize(16).fillColor(NAVY)
      .text("CERTIFICAT DE SIGNATURE ÉLECTRONIQUE", MARGIN, 120, { width: W, align: "center" });
    doc.moveTo(MARGIN + W * 0.2, doc.y + 8).lineTo(MARGIN + W * 0.8, doc.y + 8).strokeColor(RULE).lineWidth(1).stroke();
    doc.y += 30;

    const ligne = (label, val) => {
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#222").text(label + " : ", MARGIN, doc.y, { continued: true, width: W });
      doc.font("Helvetica").text(String(val || ""), { width: W });
      doc.y += 3;
    };
    ligne("Référence de la demande", c.reference);
    ligne("Document", c.document);
    ligne("N° de contrat", c.numero);
    ligne("Empreinte SHA-256 du document transmis", c.empreinte);
    ligne("Demande créée le", c.creeLe);
    if (c.echeance) ligne("Délai de signature", "à signer avant le " + c.echeance);
    doc.moveDown(1);
    (c.signataires || []).forEach((s, i) => {
      // La boîte s'agrandit si l'IP/navigateur du signataire est connue (valeur probante).
      const avecIp = !!(s.ip || s.agent);
      const hBoite = avecIp ? 90 : 74;
      const boxY = doc.y;
      doc.save().rect(MARGIN, boxY, W, hBoite).lineWidth(0.8).strokeColor(RULE).stroke().restore();
      doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY)
        .text("Signataire " + (i + 1) + " — " + (s.role || ""), MARGIN + 12, boxY + 10, { width: W - 24 });
      doc.font("Helvetica").fontSize(9.5).fillColor("#222")
        .text("Nom : " + (s.nom || "") + "      Email : " + (s.email || ""), MARGIN + 12, boxY + 28, { width: W - 24 })
        .text("Signé le : " + (s.quand || "") + "      Mention : « Lu et approuvé — bon pour accord » acceptée", MARGIN + 12, boxY + 44, { width: W - 24 });
      if (avecIp) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#555")
          .text("Adresse IP : " + (s.ip || "—") + "      Navigateur : " + (s.agent || "—").slice(0, 90), MARGIN + 12, boxY + 62, { width: W - 24, lineBreak: false });
      }
      doc.x = MARGIN; doc.y = boxY + hBoite + 10;
    });
    // Journal des événements : chaque étape horodatée de la vie de la demande.
    if (Array.isArray(c.journal) && c.journal.length) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(NAVY).text("Journal des événements", MARGIN, doc.y, { width: W });
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(8.5).fillColor("#333");
      c.journal.slice(0, 18).forEach((j) => {
        doc.text(j.quand + "  —  " + j.evenement, MARGIN + 6, doc.y, { width: W - 12 });
        doc.y += 2;
      });
      if (c.journal.length > 18) {
        doc.font("Helvetica-Oblique").text("… et " + (c.journal.length - 18) + " autre(s) événement(s).", MARGIN + 6, doc.y, { width: W - 12 });
      }
    }
    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor(GREY).text(
      "Signature électronique simple au sens du règlement eIDAS (UE) n° 910/2014. " +
      "Chaque signataire a accédé au document via un lien personnel, a coché la mention " +
      "« Lu et approuvé — bon pour accord » puis a apposé sa signature ; la date, l'heure, " +
      "l'adresse IP et le navigateur de chaque signature ont été enregistrés par ADBI Contrats. " +
      "Ce certificat accompagne le document signé « " + (c.fichier || "") + " » ; " +
      "l'empreinte ci-dessus permet d'en vérifier l'intégrité.",
      MARGIN, doc.y, { width: W, align: "justify" });
    doc.font("Helvetica").fontSize(8).fillColor(GREY)
      .text("ADBI Contrats — " + (c.reference || ""), MARGIN, doc.page.height - 50, { width: W, align: "center", lineBreak: false });
    doc.end();
  });
}

module.exports = { buildPdf, buildCertificatPdf };
