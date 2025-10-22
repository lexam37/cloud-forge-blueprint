// supabase/functions/analyze-template/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import JSZip from "npm:jszip@3.10.1";
import { parseStringPromise } from "npm:xml2js@0.6.2";
import OpenAI from "npm:openai@4.0.0";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

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

    // Extract general page layout (same as before)
    const body = document["w:document"]["w:body"][0];
    let sectPr = body["w:sectPr"]?.[0];
    if (!sectPr && body["w:p"]) {
      const lastPara = body["w:p"][body["w:p"].length - 1];
      sectPr = lastPara["w:pPr"]?.[0]?.["w:sectPr"]?.[0];
    }
    const pageLayout = {
      margins: sectPr?.["w:pgMar"]?.[0]?.$ || { top: "1440", bottom: "1440", left: "1440", right: "1440" },
      orientation: sectPr?.["w:pgSz"]?.[0]?.$?.orient || "portrait",
      size: sectPr?.["w:pgSz"]?.[0]?.$ || { w: "12240", h: "15840" },
      columns: sectPr?.["w:cols"]?.[0]?.$?.num || 1,
      spacing: sectPr?.["w:spacing"]?.[0]?.$?.line || "240",
    };

    // Parse headers and footers (similar)
    const headers = {};
    const footers = {};
    for (const file of headerFiles) {
      const headerXml = await zip.file(file)?.async("string");
      if (headerXml) {
        const header = await parseStringPromise(headerXml);
        const type = file.includes("header1") ? "first" : "default";
        headers[type] = extractElements(header["w:hdr"], zip, rels);
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

    // New approach: Extract all styles and group by similarities
    const allElements = { body: extractElements(body, zip, rels), headers, footers };
    const styleProfiles = collectStyleProfiles(allElements, styles);

    // Count uniques
    const uniqueFonts = [...new Set(styleProfiles.map(s => s.font))];
    const uniqueSizes = [...new Set(styleProfiles.map(s => s.size))];
    const uniqueColors = [...new Set(styleProfiles.map(s => s.color))];
    const uniqueStyles = groupByStyleKey(styleProfiles); // Group into clusters

    // Use AI to label clusters based on text examples and differences
    const clusterLabels = await labelClustersWithAI(uniqueStyles);

    // Resolve to resolvedStyles: { title: style, experiences.title: style, etc. }
    const resolvedStyles = mapLabelsToElements(clusterLabels);

    // Extract logo if present
    const images = allElements.body.images.concat(Object.values(headers).flatMap(h => h?.images || []), Object.values(footers).flatMap(f => f?.images || []));
    const logo = images.find(img => img.description?.toLowerCase().includes("logo")) || null;
    const logoBuffer = logo ? await zip.file(logo.filePath)?.async("uint8array") : null;

    return new Response(JSON.stringify({
      pageLayout,
      headers,
      footers,
      resolvedStyles,
      firstPageDifferent,
      uniqueCounts: { fonts: uniqueFonts.length, sizes: uniqueSizes.length, colors: uniqueColors.length },
      logoBuffer: logoBuffer ? btoa(String.fromCharCode(...logoBuffer)) : null,
    }), { status: 200 });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
});

// Helper functions (extractElements, extractParagraphs, etc. similar to previous)

// Collect all styles with text and position
function collectStyleProfiles(allElements, globalStyles) {
  const profiles = [];
  Object.entries(allElements).forEach(([section, elements]) => {
    if (elements && elements.paragraphs) {
      elements.paragraphs.forEach(para => {
        const style = extractStyle(para.pPr, para.rPrs, globalStyles, para.text);
        style.position = section;
        style.textExample = para.text.slice(0, 100); // For AI labeling
        profiles.push(style);
      });
    }
    // Add for tables, images if needed
  });
  return profiles;
}

// Group by hash of style (similarity)
function groupByStyleKey(profiles) {
  const groups = new Map();
  profiles.forEach(p => {
    const key = createStyleHash(p); // e.g., JSON.stringify({font, size, bold, italic, color, underline, alignment, etc.})
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  return groups;
}

function createStyleHash(style) {
  const { font, size, bold, italic, underline, underlineColor, color, effects, alignment, indent, spacing, background, borders, bullets, case: textCase } = style;
  return JSON.stringify({ font, size, bold, italic, underline, underlineColor, color, effects, alignment, indent, spacing, background, borders, bullets, textCase });
}

// AI labeling
async function labelClustersWithAI(groups) {
  const clusterDescs = Array.from(groups.entries()).map(([key, ps]) => ({
    style: JSON.parse(key),
    examples: ps.map(p => ({ text: p.textExample, position: p.position })),
    count: ps.length,
  }));

  const prompt = `Analyse ces clusters de styles dans un template de CV. Pour chaque cluster, identifie à quel élément il correspond (ex: titre CV, titre mission, date, compétences, etc.) basé sur différences/similitudes et exemples de texte. Détecte incohérences et choisis le plus commun si besoin. Output JSON: { cluster1: "label", ... } où cluster1 est l'index.`;
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: `${prompt}\n\nClusters: ${JSON.stringify(clusterDescs)}` }],
  });
  return JSON.parse(response.choices[0].message.content);
}

// Map labels to standard elements
function mapLabelsToElements(clusterLabels) {
  const resolved = {};
  // e.g., if label === "titre des missions", map to experiences.title
  // Implement mapping logic based on common labels
  Object.entries(clusterLabels).forEach(([clusterId, label]) => {
    const key = normalizeLabelToKey(label); // Custom function, e.g., "Titre mission" -> "experiences.title"
    resolved[key] = clusterDescs[parseInt(clusterId)].style; // Assume clusterDescs array
  });
  return resolved;
}

// Add normalizeLabelToKey function
function normalizeLabelToKey(label) {
  // Logic to map AI labels to your spec keys
  if (/titre.*mission/i.test(label)) return "experiences.title";
  // etc.
  return label.toLowerCase().replace(/\s/g, "");
}
