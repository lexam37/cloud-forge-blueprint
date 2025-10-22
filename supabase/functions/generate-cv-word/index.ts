// supabase/functions/generate-cv-word/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Packer, Document, Paragraph, TextRun, AlignmentType, UnderlineType, ShadingType, BorderStyle, PageOrientation, Header, Footer, ImageRun, Table, TableRow, TableCell, WidthType } from "npm:docx@8.5.0";

serve(async (req: Request) => {
  try {
    const { extractedData, templateStyles } = await req.json();

    const { pageLayout, resolvedStyles, firstPageDifferent, logoBuffer, headers: templateHeaders, footers: templateFooters } = templateStyles;

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
        children: buildBody(extractedData, resolvedStyles),
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    return new Response(JSON.stringify({ outputBase64: base64 }), { status: 200 });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
});

// Helpers similar to previous, but use resolvedStyles from clusters
// e.g., in buildBody, use resolvedStyles["title"] for title, resolvedStyles["experiences.title"] for exp titles, etc.

// Adjust buildParagraph to handle case, effects, etc.
function buildParagraph(text, style, isBullet = false) {
  return new Paragraph({
    children: [new TextRun({
      text: applyCase(text, style.case),
      font: { name: style.font },
      size: style.size * 2,
      bold: style.bold,
      italics: style.italic,
      underline: style.underline ? { type: UnderlineType[style.underline.toUpperCase() || 'SINGLE'], color: style.underlineColor } : undefined,
      color: style.color,
    })],
    alignment: AlignmentType[style.alignment.toUpperCase()],
    indent: { left: parseInt(style.indent) },
    spacing: { after: parseInt(style.spacing), line: parseInt(pageLayout.spacing) },
    shading: style.background ? { fill: style.background, type: ShadingType.SOLID } : undefined,
    border: style.borders ? mapBorders(style.borders) : undefined,
    numbering: isBullet && style.bullets ? [{ level: 0, reference: "bullets" }] : undefined,
  });
}

function mapBorders(borders) {
  return {
    top: borders.top ? { style: BorderStyle.SINGLE, size: parseInt(borders.top.sz || 1), color: borders.top.color || "000000" } : undefined,
    // similar for bottom, left, right
  };
}

// In buildBody, add line breaks with empty paras
// For tables/icons if in resolvedStyles (e.g., if style.table true)

// Similar for headers/footers, place based on position in style
