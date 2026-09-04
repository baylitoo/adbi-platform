const {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel,
  BorderStyle, Footer, Header, PageNumber, Tab, TabStopType, TabStopPosition, ImageRun, SectionType,
  Table, TableRow, TableCell, WidthType, VerticalAlign,
} = require("docx");
const fs = require("fs");
const path = require("path");
const { fill, fillBold, runs, activeBlocks } = require("./render");

const LOGO = path.join(__dirname, "..", "public", "logo-adbi.png");

const NAVY = "1B2559";
const ACCENT = "C81E78"; // magenta ADBI

function rt(text, opts = {}) {
  return new TextRun({ text, bold: opts.bold, color: opts.color, size: opts.size, font: "Calibri" });
}
function para(text, values, opts = {}) {
  const f = opts.boldVars ? fillBold : fill;
  const children = runs(f(text, values)).map((r) =>
    rt(r.text, { bold: r.bold || opts.bold, color: opts.color, size: opts.size }));
  return new Paragraph({
    children,
    alignment: opts.align || AlignmentType.JUSTIFIED,
    spacing: { after: opts.after != null ? opts.after : 120, before: opts.before || 0 },
    bullet: opts.bullet,
    indent: opts.indent,
  });
}

function footer(values, tpl) {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: [fill((tpl && tpl.footerText) || "Convention de sous-traitance — Contrat n° {{numeroContrat}}", values) + " — p. ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 16, color: "888888", font: "Calibri" })],
    })],
  });
}

// En-tête répété (logo + titre + n° de contrat) dans un cadre — pages 2+.
function headerObj(values, tpl) {
  let logoP;
  try {
    logoP = new Paragraph({ children: [new ImageRun({ data: fs.readFileSync(LOGO), transformation: { width: 96, height: 48 } })] });
  } catch (e) {
    logoP = new Paragraph({ children: [rt("ADBI", { bold: true, size: 30, color: ACCENT })] });
  }
  // Bloc gauche : logo + n° de contrat (sous le logo, avec un espace).
  const numP = new Paragraph({ spacing: { before: 160 }, children: [rt(fill((tpl && tpl.headerNum) || "N° de contrat : {{numeroContrat}}", values), { bold: true, size: 16 })] });
  const titleP = new Paragraph({ alignment: AlignmentType.CENTER, children: [rt(fill((tpl && tpl.headerTitle) || "CONVENTION DE SOUS-TRAITANCE D’ASSISTANCE TECHNIQUE", values), { bold: true, size: 19, color: NAVY })] });
  const box = { style: BorderStyle.SINGLE, size: 6, color: "333333" };
  const none = { style: BorderStyle.NONE };
  return new Header({
    children: [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: box, bottom: box, left: box, right: box, insideHorizontal: none, insideVertical: none },
      rows: [
        new TableRow({ children: [
          // gauche : logo + n°
          new TableCell({ width: { size: 28, type: WidthType.PERCENTAGE }, margins: { top: 60, bottom: 60, left: 90, right: 60 }, verticalAlign: VerticalAlign.TOP, children: [logoP, numP] }),
          // milieu : titre centré
          new TableCell({ width: { size: 44, type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.CENTER, children: [titleP] }),
          // droite : vide (équilibre le centrage)
          new TableCell({ width: { size: 28, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [] })] }),
        ] }),
      ],
    })],
  });
}
function emptyHeader() {
  return new Header({ children: [new Paragraph({ children: [] })] });
}

async function buildDocx(tpl, values, options) {
  const blocks = activeBlocks(tpl.blocks, options);

  // On découpe le document en segments : 1 colonne (couverture, parties, signatures,
  // annexes) ou 2 colonnes (le corps des articles), façon contrat original.
  const segments = [{ cols: 1, children: [] }];
  let cur = segments[0];
  const push = (...p) => cur.children.push(...p);

  for (const b of blocks) {
    switch (b.t) {
      case "col2-start":
        segments.push({ cols: 2, children: [] });
        cur = segments[segments.length - 1];
        break;
      case "col2-end":
        segments.push({ cols: 1, children: [] });
        cur = segments[segments.length - 1];
        break;
      case "cover":
        try {
          push(new Paragraph({ spacing: { before: 1300, after: 200 }, alignment: AlignmentType.CENTER,
            children: [new ImageRun({ data: fs.readFileSync(LOGO), transformation: { width: 250, height: 125 } })] }));
        } catch (e) {
          push(new Paragraph({ spacing: { before: 2400 }, children: [rt("ADBI", { bold: true, size: 56, color: ACCENT })], alignment: AlignmentType.CENTER }));
        }
        push(new Paragraph({ spacing: { before: 600, after: 200 }, alignment: AlignmentType.CENTER, children: [rt(tpl.titre, { bold: true, size: 36, color: NAVY })] }));
        push(new Paragraph({ spacing: { before: 1200 }, alignment: AlignmentType.CENTER, children: [rt("Contrat n° " + fill("{{numeroContrat}}", values) + "   —   Version " + fill("{{version}}", values), { size: 24, color: NAVY })] }));
        break;
      case "pagebreak":
        push(new Paragraph({ children: [], pageBreakBefore: true }));
        break;
      case "parties":
        push(para("ENTRE LES SOUSSIGNÉS :", values, { bold: true, align: AlignmentType.LEFT, after: 260 }));
        push(para("**{{adbiNom}}**", values, { after: 40, align: AlignmentType.LEFT }));
        push(para("{{adbiAdresse}}", values, { after: 20, align: AlignmentType.LEFT }));
        push(para("Capital : {{adbiCapital}} — {{adbiRcs}}", values, { after: 20, align: AlignmentType.LEFT }));
        push(para("Représentée par : {{adbiRepresentant}}, dûment habilité à signer les présentes", values, { after: 60, align: AlignmentType.LEFT }));
        push(para("Ci-après désignée le **« Client »**, d’une part", values, { align: AlignmentType.RIGHT, after: 340 }));
        push(para("ET", values, { bold: true, align: AlignmentType.LEFT, before: 120, after: 340 }));
        push(para("**{{stNom}}**", values, { after: values.stFormeJuridique ? 10 : 40, align: AlignmentType.LEFT }));
        if (values.stFormeJuridique) push(para("{{stFormeJuridique}}", values, { after: 30, align: AlignmentType.LEFT }));
        push(para("Adresse : {{stAdresse}}", values, { after: 20, align: AlignmentType.LEFT }));
        push(para("SIREN : {{stSiren}}   —   SIRET : {{stSiret}}", values, { after: 20, align: AlignmentType.LEFT }));
        push(para(values.stQualite ? "Représentée par : {{stRepresentant}}, en sa qualité de {{stQualite}}, dûment habilité à signer les présentes" : "Représentée par : {{stRepresentant}}, dûment habilité à signer les présentes", values, { after: 60, align: AlignmentType.LEFT }));
        push(para("Ci-après désignée le **« Sous-Traitant »**, d’autre part", values, { align: AlignmentType.RIGHT, after: 200 }));
        break;
      case "h2":
        push(new Paragraph({ spacing: { before: 280, after: 120 }, children: [rt(fill(b.x, values), { bold: true, size: 24, color: NAVY })] }));
        break;
      case "h3":
        push(new Paragraph({ spacing: { before: 200, after: 100 }, children: [rt(fill(b.x, values), { bold: true, size: 22, color: NAVY })] }));
        break;
      case "annexe-title":
        push(new Paragraph({ spacing: { before: 200, after: 200 }, alignment: AlignmentType.CENTER, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT } }, children: [rt(fill(b.x, values), { bold: true, size: 26, color: NAVY })] }));
        break;
      case "p":
        push(para(b.x, values, { boldVars: true }));
        break;
      case "dash":
        push(para(b.x, values, { bullet: { level: 0 }, boldVars: true }));
        break;
      case "li":
        push(para(b.x, values, { bullet: { level: 0 }, boldVars: true }));
        break;
      case "spacer":
        push(new Paragraph({ children: [rt("")], spacing: { after: 120 } }));
        break;
      case "table": {
        const bd = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
        const cell = (txt, head, w) => new TableCell({
          shading: head ? { fill: "E6E6E6" } : undefined,
          width: { size: w, type: WidthType.PERCENTAGE },
          margins: { top: 40, bottom: 40, left: 90, right: 90 },
          children: [new Paragraph({ spacing: { after: 0 }, children: [rt(txt, { bold: !!head })] })],
        });
        const trows = [new TableRow({ tableHeader: true, children: [cell(b.headers[0], true, 64), cell(b.headers[1], true, 36)] })];
        (b.rows || []).forEach((r) => trows.push(new TableRow({ children: [cell(r[0], false, 64), cell(r[1], false, 36)] })));
        push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: bd, bottom: bd, left: bd, right: bd, insideHorizontal: bd, insideVertical: bd },
          rows: trows,
        }));
        push(new Paragraph({ children: [rt("")], spacing: { after: 80 } }));
        break;
      }
      case "signatures": {
        push(para("Fait le {{dateRedaction}} à {{lieuRedaction}}, en deux exemplaires originaux, chacune des parties reconnaissant avoir reçu le sien.", values, { after: 360, boldVars: true }));
        const lTitle = b.leftTitle || "Pour le Client — {{adbiNom}}";
        const rTitle = b.rightTitle || "Pour le Sous-Traitant — {{stNom}}";
        const lName = b.leftName || "{{adbiRepresentant}}";
        const rName = b.rightName || "{{sigStNom}}";
        const sigRow = new Paragraph({
          tabStops: [{ type: TabStopType.LEFT, position: 4800 }],
          spacing: { after: 120, before: 240 }, keepNext: true, keepLines: true,
          children: [rt(fill(lTitle, values), { bold: true }), new TextRun({ children: [new Tab()] }), rt(fill(rTitle, values), { bold: true })],
        });
        const nameRow = new Paragraph({
          tabStops: [{ type: TabStopType.LEFT, position: 4800 }],
          spacing: { after: 80 }, keepNext: true, keepLines: true,
          children: [rt("Nom : " + fill(lName, values)), new TextRun({ children: [new Tab()] }), rt("Nom : " + fill(rName, values))],
        });
        const lSubTxt = fill(b.leftSub || "", values);
        const rSubTxt = fill(b.rightSub || "{{sigStQualiteClause}}", values);
        const subRow = (lSubTxt || rSubTxt) ? new Paragraph({
          tabStops: [{ type: TabStopType.LEFT, position: 4800 }],
          spacing: { after: 80 }, keepNext: true, keepLines: true,
          children: [rt(lSubTxt), new TextRun({ children: [new Tab()] }), rt(rSubTxt)],
        }) : null;
        const signRow = new Paragraph({
          tabStops: [{ type: TabStopType.LEFT, position: 4800 }],
          spacing: { after: 80, before: 160 }, keepNext: true, keepLines: true,
          children: [rt("Signature :"), new TextRun({ children: [new Tab()] }), rt("Signature :")],
        });
        // Espace pour la signature manuscrite (~80 pt).
        const signSpace = new Paragraph({ children: [rt("")], spacing: { after: 700 } });
        // Mention « Lu et approuvé » + emplacement du cachet, pour chaque partie.
        const luRow = new Paragraph({
          tabStops: [{ type: TabStopType.LEFT, position: 4800 }],
          spacing: { after: 120 }, keepNext: true, keepLines: true,
          children: [rt("Lu et approuvé, bon pour accord", { size: 18 }), new TextRun({ children: [new Tab()] }), rt("Lu et approuvé, bon pour accord", { size: 18 })],
        });
        const cachetRow = new Paragraph({
          tabStops: [{ type: TabStopType.LEFT, position: 4800 }],
          spacing: { before: 80 }, keepNext: true, keepLines: true,
          children: [rt("Cachet :"), new TextRun({ children: [new Tab()] }), rt("Cachet :")],
        });
        const cachetSpace = new Paragraph({ children: [rt("")], spacing: { after: 700 } });
        const mention = new Paragraph({ spacing: { before: 120 }, children: [rt("Porter la mention manuscrite « Lu et approuvé – Bon pour accord »", { size: 18 })] });
        push(sigRow, nameRow, ...(subRow ? [subRow] : []), signRow, signSpace, luRow, cachetRow, cachetSpace, mention);
        break;
      }
      default:
        break;
    }
  }

  const sections = segments
    .filter((s) => s.children.length)
    .map((s, i) => ({
      properties: {
        type: i === 0 ? undefined : SectionType.CONTINUOUS,
        // 1re page (couverture) = pas d'en-tête. Sauf avenant (headerOnFirst) : en-tête dès la 1re page.
        titlePage: (i === 0 && !tpl.headerOnFirst) ? true : undefined,
        page: { margin: { top: 2150, bottom: 1100, left: 1200, right: 1200, header: 480 } },
        column: s.cols === 2 ? { count: 2, space: 340, separate: true } : { count: 1 },
      },
      headers: (i === 0 && !tpl.headerOnFirst)
        ? { default: headerObj(values, tpl), first: emptyHeader() }
        : { default: headerObj(values, tpl) },
      footers: { default: footer(values, tpl) },
      children: s.children,
    }));

  const doc = new Document({
    creator: "ADBI - Generateur de contrats",
    title: tpl.titre,
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections,
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
