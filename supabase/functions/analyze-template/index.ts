// supabase/functions/analyze-template/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import JSZip from "npm:jszip@3.10.1";
import { parseStringPromise } from "npm:xml2js@0.6.2";

serve(async (req: Request) => {
  try {
    const { templateBase64 } = await req.json();
    const buffer = Uint8Array.from(atob(templateBase64), c => c.charCodeAt(0));

    // Unzip DOCX
    const zip = await JSZip.loadAsync(buffer);

    // Extract XML files
    const documentXml = await zip.file("word/document.xml")?.async("string");
    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
    const headerFiles = Object.keys(zip.files).filter(f => f.startsWith("word/header"));
    const footerFiles = Object.keys(zip.files).filter(f => f.startsWith("word/footer"));

    if (!documentXml || !stylesXml) {
      return new Response("Invalid template DOCX", { status: 400 });
    }

    const document = await parseStringPromise(documentXml);
    const styles = await parseStringPromise(stylesXml);
    const rels = relsXml ? await parseStringPromise(relsXml) : null;

    // Extract general page layout from w:sectPr
    const body = document["w:document"]["w:body"][0];
    let sectPr = body["w:sectPr"]?.[0];
    if (!sectPr) {
      // Check last paragraph for sectPr
      const lastPara = body["w:p"]?.[body["w:p"].length - 1];
      if (lastPara && lastPara["w:pPr"]) {
        sectPr = lastPara["w:pPr"][0]["w:sectPr"]?.[0];
      }
    }
    const pageLayout = {
      margins: sectPr?.["w:pgMar"]?.[0]?.$ || { top: "1440", bottom: "1440", left: "1440", right: "1440" },
      orientation: sectPr?.["w:pgSz"]?.[0]?.$?.orient || "portrait",
      size: sectPr?.["w:pgSz"]?.[0]?.$ || { w: "12240", h: "15840" }, // A4 default in twips
      columns: sectPr?.["w:cols"]?.[0]?.$?.num || 1,
      spacing: sectPr?.["w:spacing"]?.[0]?.$?.line || "240",
    };

    // Parse headers and footers
    const headers = {};
    const footers = {};
    for (const file of headerFiles) {
      const headerXml = await zip.file(file)?.async("string");
      if (headerXml) {
        const header = await parseStringPromise(headerXml);
        const type = file.includes("header1") ? "first" : "default"; // Simplify; check rels for exact
        headers[type] = extractElements(header["w:hdr"], zip, rels); // Custom extract
      }
    }
    for (const file of footerFiles) {
      const footerXml = await zip.file(file)?.async("string");
      if (footerXml) {
        const footer = await parseStringPromise(footerXml);
        const type = file.includes("footer1") ? "first" : "default";
        footers[type] = extractElements(footer["w:ftr"], zip, rels);
      }
    }
    const firstPageDifferent = !!headers["first"] || !!footers["first"];

    // Extract elements from body
    const bodyElements = extractElements(body, zip, rels);

    // Resolve styles by type, detecting inconsistencies
    const elementStyles = {
      title: [],
      commercialCoords: [],
      logo: [],
      trigram: [],
      competencies: [],
      experiences: { title: [], date: [], company: [], context: [], missions: [], env: [] },
      formations: { title: [], date: [], place: [] },
      // Add more subcategories
    };

    // Combine body, headers, footers for analysis
    const allElements = { ...bodyElements, headers, footers };

    // Categorize and collect styles using regex
    Object.keys(allElements).forEach(section => {
      allElements[section].paragraphs.forEach(para => {
        const text = para.text;
        const style = extractStyle(para.pPr, para.rPrs, styles, text);
        style.position = section; // header, footer, body

        if (/^(CV|Titre|Métier)/i.test(text)) {
          elementStyles.title.push(style);
        } else if (/Coordonnées du commercial/i.test(text)) {
          elementStyles.commercialCoords.push(style);
        } else if (/Trigramme/i.test(text)) {
          elementStyles.trigram.push(style);
        } else if (/(Compétences|Skills)/i.test(text)) {
          elementStyles.competencies.push(style);
        } else if (/(Expériences|Professional Experience)/i.test(text)) {
          elementStyles.experiences.title.push(style);
        } else if (/\d{2}\/\d{2}\/\d{4}/.test(text)) { // Date example
          elementStyles.experiences.date.push(style);
        } // Add more regex for subparts
        // Similar for other categories
      });

      // Tables, images, etc.
      allElements[section].images.forEach(img => {
        if (img.description?.includes("logo")) {
          elementStyles.logo.push({ ...img, position: section });
        }
      });
    });

    // Resolve inconsistencies: most common style per type
    const resolvedStyles = {};
    for (const type in elementStyles) {
      if (typeof elementStyles[type] === 'object') {
        const subResolved = {};
        for (const sub in elementStyles[type]) {
          subResolved[sub] = getMostCommonStyle(elementStyles[type][sub]);
        }
        resolvedStyles[type] = subResolved;
      } else {
        resolvedStyles[type] = getMostCommonStyle(elementStyles[type]);
      }
    }

    // Detect date formats
    const dateFormats = { mission: detectDateFormat(elementStyles.experiences.date.map(s => s.exampleText || '')) };

    // Extract images for logo if any
    const logoBuffer = elementStyles.logo.length ? await zip.file(elementStyles.logo[0].filePath)?.async("uint8array") : null;

    return new Response(JSON.stringify({ pageLayout, headers, footers, resolvedStyles, firstPageDifferent, dateFormats, logoBuffer: logoBuffer ? btoa(String.fromCharCode(...logoBuffer)) : null }), { status: 200 });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
});

// Helper to extract elements from section (body/header/footer)
async function extractElements(section, zip, rels) {
  const paragraphs = extractParagraphs(section);
  const tables = extractTables(section);
  const images = await extractImages(section, rels, zip);
  // Add shapes/icons if w:drawing with v:shape
  return { paragraphs, tables, images };
}

// From tool responses: extractParagraphs, extractRunsFromParagraph, etc.
function extractParagraphs(body) {
  const paragraphs = [];
  if (body["w:p"]) {
    const ps = Array.isArray(body["w:p"]) ? body["w:p"] : [body["w:p"]];
    ps.forEach(p => {
      const pPr = p["w:pPr"]?.[0] || {};
      const rPrs = extractRunsFromParagraph(p).map(run => run.properties);
      const text = extractTextFromRuns(p);
      paragraphs.push({ pPr, rPrs, text });
    });
  }
  return paragraphs;
}

function extractTextFromRuns(p) {
  let text = '';
  if (p['w:r']) {
    const rs = Array.isArray(p['w:r']) ? p['w:r'] : [p['w:r']];
    rs.forEach(r => {
      if (r['w:t']) text += (Array.isArray(r['w:t']) ? r['w:t'].join('') : r['w:t']) + ' ';
    });
  }
  return text.trim();
}

function extractRunsFromParagraph(p) {
  const runs = [];
  if (p['w:r']) {
    const rs = Array.isArray(p['w:r']) ? p['w:r'] : [p['w:r']];
    rs.forEach(r => {
      const props = {};
      if (r['w:rPr']) {
        const rPr = r['w:rPr'][0];
        if (rPr['w:b']) props.bold = true;
        if (rPr['w:i']) props.italic = true;
        if (rPr['w:sz']) props.size = parseInt(rPr['w:sz'][0]?.$?.val || '0') / 2;
        if (rPr['w:color']) props.color = rPr['w:color'][0]?.$?.val;
        if (rPr['w:u']) props.underline = rPr['w:u'][0]?.$?.val;
        if (rPr['w:u'] && rPr['w:u'][0]?.$?.color) props.underlineColor = rPr['w:u'][0]?.$?.color;
        if (rPr['w:rFonts']) props.font = rPr['w:rFonts'][0]?.$?.ascii;
        // Effects like w:effect, w:strike, etc.
      }
      const text = r['w:t'] ? (Array.isArray(r['w:t']) ? r['w:t'].join('') : r['w:t']) : '';
      runs.push({ properties: props, text });
    });
  }
  return runs;
}

async function extractImages(doc, rels, zip) {
  const images = [];
  const relMap = new Map();
  if (rels && rels['Relationships'] && rels['Relationships']['Relationship']) {
    const relationships = Array.isArray(rels['Relationships']['Relationship']) ? rels['Relationships']['Relationship'] : [rels['Relationships']['Relationship']];
    relationships.forEach(r => {
      if (r.$?.Type.includes('image')) {
        relMap.set(r.$?.Id, r.$?.Target);
      }
    });
  }

  // Traverse for w:drawing
  // Simplified: assume in body["w:p"] or section
  (section["w:p"] || []).forEach(p => {
    if (p['w:r'] && p['w:r'].some(r => r['w:drawing'])) {
      const drawing = p['w:r'].find(r => r['w:drawing'])['w:drawing'][0];
      const blip = drawing['wp:inline']?.[0]?.['a:graphic']?.[0]?.['a:graphicData']?.[0]?.['pic:pic']?.[0]?.['pic:blipFill']?.[0]?.['a:blip']?.[0];
      const relId = blip?.$?.['r:embed'];
      const target = relMap.get(relId);
      if (target) {
        const filePath = target.startsWith('../media') ? 'word/media' + target.slice(2) : target;
        const buffer = await zip.file(filePath)?.async("uint8array");
        images.push({ filePath, buffer, description: drawing['wp:docPr']?.[0]?.$?.descr || '' });
      }
    }
  });
  return images;
}

function extractTables(body) {
  // Similar to tool response
  const tables = [];
  if (body['w:tbl']) {
    const tbls = Array.isArray(body['w:tbl']) ? body['w:tbl'] : [body['w:tbl']];
    tbls.forEach(tbl => {
      const table = { rows: [] };
      if (tbl['w:tr']) {
        const trs = Array.isArray(tbl['w:tr']) ? tbl['w:tr'] : [tbl['w:tr']];
        trs.forEach(tr => {
          const row = [];
          if (tr['w:tc']) {
            const tcs = Array.isArray(tr['w:tc']) ? tr['w:tc'] : [tr['w:tc']];
            tcs.forEach(tc => {
              const text = extractTextFromRuns(tc);
              row.push({ text, pPr: tc['w:p']?.[0]?.['w:pPr']?.[0] });
            });
          }
          table.rows.push(row);
        });
      }
      tables.push(table);
    });
  }
  return tables;
}

function extractStyle(pPr, rPrs, globalStyles, text) {
  const style = {
    font: rPrs[0]?.font || "Arial",
    size: rPrs[0]?.size || 12,
    bold: !!rPrs[0]?.bold,
    italic: !!rPrs[0]?.italic,
    underline: rPrs[0]?.underline || null,
    underlineColor: rPrs[0]?.underlineColor || null,
    color: rPrs[0]?.color || "000000",
    effects: rPrs[0]?.effect || null, // e.g., shadow, outline
    alignment: pPr["w:jc"]?.[0]?.$?.val || "left",
    indent: pPr["w:ind"]?.[0]?.$?.left || 0,
    spacing: pPr["w:spacing"]?.[0]?.$?.after || 0,
    background: pPr["w:shd"]?.[0]?.$?.fill || null,
    borders: pPr["w:pBdr"] ? extractBorders(pPr["w:pBdr"][0]) : null,
    bullets: pPr["w:numPr"] ? true : false,
    case: detectCase(text),
    exampleText: text, // For date formats
    // Table if inside tbl, icon if drawing without blip
  };
  // Link to global style if pPr["w:pStyle"]
  if (pPr["w:pStyle"]) {
    const styleId = pPr["w:pStyle"][0]?.$?.val;
    const globalStyle = globalStyles["w:styles"]["w:style"].find(s => s.$?.["w:type"] === "paragraph" && s.$?.["w:styleId"] === styleId);
    if (globalStyle) {
      // Merge from global
      const globalRPr = globalStyle["w:rPr"]?.[0];
      if (globalRPr) {
        style.font = globalRPr["w:rFonts"]?.[0]?.$?.ascii || style.font;
        // etc.
      }
    }
  }
  return style;
}

function extractBorders(pBdr) {
  return {
    top: pBdr["w:top"]?.[0]?.$ || null,
    bottom: pBdr["w:bottom"]?.[0]?.$ || null,
    left: pBdr["w:left"]?.[0]?.$ || null,
    right: pBdr["w:right"]?.[0]?.$ || null,
  };
}

function detectCase(text) {
  if (!text) return 'mixed';
  if (text === text.toUpperCase()) return 'upper';
  if (text === text.toLowerCase()) return 'lower';
  if (text === text[0].toUpperCase() + text.slice(1).toLowerCase()) return 'title';
  return 'mixed';
}

function getMostCommonStyle(styles) {
  if (!styles.length) return {};
  const counts = new Map();
  styles.forEach(s => {
    const key = JSON.stringify(s);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const maxKey = Array.from(counts.entries()).reduce((a, b) => b[1] > a[1] ? b : a)[0];
  return JSON.parse(maxKey);
}

function detectDateFormat(dateStrings) {
  const patterns = dateStrings.map(d => d.match(/\d+([\/-])\d+([\/-])\d+/)?[0] : null).filter(Boolean);
  if (!patterns.length) return 'DD/MM/YYYY';
  const countMap = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  return Object.keys(countMap).reduce((a, b) => countMap[a] > countMap[b] ? a : b);
}
