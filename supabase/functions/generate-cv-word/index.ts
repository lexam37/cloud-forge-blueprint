// supabase/functions/generate-cv-word/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Packer, Document, Paragraph, TextRun, AlignmentType, UnderlineType, ShadingType, BorderStyle, PageOrientation, Header, Footer, ImageRun, Table, TableRow, TableCell, WidthType } from "npm:docx@8.5.0";

serve(async (req: Request) => {
  try {
    const { extractedData, templateStyles } = await req.json(); // extractedData from process-cv, templateStyles from analyze-template

    const { pageLayout, resolvedStyles, firstPageDifferent, dateFormats, logoBuffer, headers: templateHeaders, footers: templateFooters } = templateStyles;

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: {
              width: parseInt(pageLayout.size.w),
              height: parseInt(pageLayout.size.h),
              orientation: pageLayout.orientation === "portrait" ? PageOrientation.PORTRAIT : PageOrientation.LANDSCAPE,
            },
            margin: {
              top: parseInt(pageLayout.margins.top),
              bottom: parseInt(pageLayout.margins.bottom),
              left: parseInt(pageLayout.margins.left),
              right: parseInt(pageLayout.margins.right),
            },
            column: { count: parseInt(pageLayout.columns) },
          },
        },
        headers: buildHeaders(templateHeaders, resolvedStyles, extractedData, logoBuffer, firstPageDifferent),
        footers: buildFooters(templateFooters, resolvedStyles, extractedData, firstPageDifferent),
        children: buildBody(extractedData, resolvedStyles, dateFormats),
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    return new Response(JSON.stringify({ outputBase64: base64 }), { status: 200 });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
});

// Helper to build headers
function buildHeaders(templateHeaders, styles, data, logoBuffer, firstDifferent) {
  const defaultHeader = new Header({
    children: [],
  });
  // Add elements based on styles.position === 'header'
  if (styles.trigram.position === 'header') {
    defaultHeader.add(buildParagraph(data.trigram, styles.trigram));
  }
  if (styles.commercialCoords.position === 'header') {
    defaultHeader.add(buildParagraph(JSON.stringify(data.commercial), styles.commercialCoords));
  }
  if (styles.logo.position === 'header' && logoBuffer) {
    const logoUint8 = Uint8Array.from(atob(logoBuffer), c => c.charCodeAt(0));
    defaultHeader.add(new Paragraph({
      children: [new ImageRun({ data: logoUint8, transformation: { width: 100, height: 50 } })], // Adjust size
    }));
  }
  // Similar for first if different
  return { default: defaultHeader, first: firstDifferent ? /* clone and modify */ defaultHeader : null };
}

// Similar for footers
function buildFooters(templateFooters, styles, data, firstDifferent) {
  // Analogous to headers
  const defaultFooter = new Footer({ children: [] });
  // Add trigram, coords if position 'footer'
  return { default: defaultFooter, first: firstDifferent ? defaultFooter : null };
}

// Build body content
function buildBody(data, styles, dateFormats) {
  const children = [];

  // Title
  children.push(buildParagraph(applyCase(data.title, styles.title.case), styles.title));
  children.push(new Paragraph({ spacing: { after: parseInt(styles.title.spacing) } })); // Line break

  // Competencies
  if (styles.competencies.table) {
    children.push(buildTable(data.competencies, styles.competencies));
  } else {
    children.push(buildParagraph("Compétences Techniques: " + data.competencies.technical.join(', '), styles.competencies));
    children.push(buildParagraph("Compétences Fonctionnelles: " + data.competencies.functional.join(', '), styles.competencies));
  }
  children.push(new Paragraph({ spacing: { after: 240 } }));

  // Experiences
  data.experiences.forEach(exp => {
    children.push(buildParagraph(applyCase(exp.title, styles.experiences.title.case), styles.experiences.title));
    children.push(buildParagraph(formatDate(exp.dates, dateFormats.mission), styles.experiences.date));
    if (exp.context) children.push(buildParagraph(exp.context, styles.experiences.context));
    exp.missions.forEach(m => children.push(buildParagraph(m, styles.experiences.missions, true))); // Bullets if style.bullets
    children.push(buildParagraph(exp.env, styles.experiences.env));
    children.push(new Paragraph({ spacing: { after: 240 } }));
  });

  // Formations
  data.formations.forEach(form => {
    children.push(buildParagraph(applyCase(form.title, styles.formations.title.case), styles.formations.title));
    children.push(buildParagraph(formatDate(form.dates, form.dateFormat), styles.formations.date));
    if (form.place) children.push(buildParagraph(form.place, styles.formations.place));
    children.push(new Paragraph({ spacing: { after: 240 } }));
  });

  return children;
}

// Helper to build paragraph with style
function buildParagraph(text, style, isBullet = false) {
  return new Paragraph({
    children: [new TextRun({
      text: text,
      font: { name: style.font },
      size: style.size * 2, // pt to half-pt
      bold: style.bold,
      italics: style.italic,
      underline: style.underline ? { type: UnderlineType[style.underline.toUpperCase() || 'SINGLE'], color: style.underlineColor } : undefined,
      color: style.color,
      // effects if supported
    })],
    alignment: AlignmentType[style.alignment.toUpperCase()],
    indent: { left: parseInt(style.indent) },
    spacing: { after: parseInt(style.spacing) },
    shading: style.background ? { fill: style.background, type: ShadingType.SOLID, color: "auto" } : undefined,
    border: style.borders ? {
      top: { style: BorderStyle.SINGLE, size: 1, color: "000000" }, // Map from extracted
      // etc.
    } : undefined,
    numbering: isBullet && style.bullets ? [{ level: 0, reference: "bullet-ref" }] : undefined, // Need to define numbering in doc
  });
}

// Similar for table
function buildTable(data, style) {
  // Example for competencies as table
  const rows = [];
  // Add rows based on data
  rows.push(new TableRow({ children: [new TableCell({ children: [buildParagraph("Technical", style)] })] }));
  // etc.
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    // borders, etc.
  });
}

function applyCase(text, caseType) {
  if (caseType === 'upper') return text.toUpperCase();
  if (caseType === 'lower') return text.toLowerCase();
  if (caseType === 'title') return text.split(' ').map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return text;
}

function formatDate(dates, format) {
  // Simple, assume dates match format, or use library if added
  return dates;
}
