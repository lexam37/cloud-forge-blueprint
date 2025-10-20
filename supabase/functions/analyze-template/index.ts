import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { templateId } = await req.json();
    
    if (!templateId) {
      throw new Error('templateId is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('🔍 Starting template analysis:', templateId);

    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      console.error('Template not found:', templateError);
      throw new Error('Template not found');
    }

    console.log('✅ Template found:', template.name);

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('cv-templates')
      .download(template.file_path);

    if (downloadError) {
      throw new Error('Failed to download template file');
    }

    console.log('✅ File downloaded:', fileData.size, 'bytes');

    let structureData;
    if (template.file_type === 'docx' || template.file_type === 'doc') {
      structureData = await analyzeDocxTemplate(fileData, supabase);
    } else {
      structureData = getDefaultStructure();
    }

    const { error: updateError } = await supabase
      .from('cv_templates')
      .update({ 
        structure_data: structureData,
        is_active: true
      })
      .eq('id', templateId);

    if (updateError) {
      throw updateError;
    }

    await supabase
      .from('cv_templates')
      .update({ is_active: false })
      .neq('id', templateId);

    console.log('✅ Template activated');

    return new Response(
      JSON.stringify({ 
        success: true, 
        structure: structureData,
        message: 'Template analysé et activé avec succès'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('❌ Error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Erreur inconnue'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});

async function analyzeDocxTemplate(docxData: Blob, supabase: any): Promise<any> {
  try {
    const JSZip = (await import('https://esm.sh/jszip@3.10.1')).default;
    const arrayBuffer = await docxData.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    
    const documentXml = await zip.file('word/document.xml')?.async('text');
    const headerXml = await zip.file('word/header1.xml')?.async('text');
    const footerXml = await zip.file('word/footer1.xml')?.async('text');
    const headerRelsXml = await zip.file('word/_rels/header1.xml.rels')?.async('text');
    const settingsXml = await zip.file('word/settings.xml')?.async('text');
    
    if (!documentXml) throw new Error('document.xml not found');
    
    console.log('📄 Analyzing document...');

    // === PAGE LAYOUT EXTRACTION ===
    const pageLayout = {
      margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
      orientation: "portrait",
      size: "A4",
      columns: { count: 1, widths: [100] }
    };

    if (settingsXml) {
      // Margins (in twips, 1 twip = 1/20 pt, 1 mm ≈ 56.69 twips)
      const marginMatch = settingsXml.match(/<w:pgMar[^>]+w:top="(\d+)"[^>]+w:right="(\d+)"[^>]+w:bottom="(\d+)"[^>]+w:left="(\d+)"[^>]+w:header="(\d+)"[^>]+w:footer="(\d+)"/);
      if (marginMatch) {
        pageLayout.margins = {
          top: (parseInt(marginMatch[1]) / 56.69).toFixed(2) + "mm",
          right: (parseInt(marginMatch[2]) / 56.69).toFixed(2) + "mm",
          bottom: (parseInt(marginMatch[3]) / 56.69).toFixed(2) + "mm",
          left: (parseInt(marginMatch[4]) / 56.69).toFixed(2) + "mm"
        };
      }

      // Orientation
      pageLayout.orientation = settingsXml.includes('<w:orient w:val="landscape"') ? "landscape" : "portrait";

      // Page size
      const sizeMatch = settingsXml.match(/<w:pgSz[^>]+w:w="(\d+)"[^>]+w:h="(\d+)"/);
      if (sizeMatch) {
        const width = parseInt(sizeMatch[1]) / 56.69; // twips to mm
        const height = parseInt(sizeMatch[2]) / 56.69;
        pageLayout.size = (width > 200 && height > 280) ? "A4" : "Letter"; // Approximation
      }

      // Columns
      const colsMatch = settingsXml.match(/<w:cols[^>]+w:num="(\d+)"[^>]*w:space="(\d+)"/);
      if (colsMatch) {
        const colCount = parseInt(colsMatch[1]);
        pageLayout.columns.count = colCount;
        pageLayout.columns.widths = colCount === 2 ? [35, 65] : [100]; // Default split for 2 columns
      }
    }

    // === LOGO EXTRACTION ===
    let logoData: any = null;
    if (headerXml && headerRelsXml) {
      console.log('📋 Extracting logo from header...');
      
      const imageRelations: { [key: string]: string } = {};
      const relMatches = headerRelsXml.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Type="[^"]*image[^"]*"[^>]+Target="([^"]+)"/g);
      for (const match of relMatches) {
        imageRelations[match[1]] = 'word/' + match[2].replace('../', '');
      }
      
      const drawingMatches = headerXml.matchAll(/<w:drawing>(.*?)<\/w:drawing>/gs);
      for (const drawingMatch of drawingMatches) {
        const drawingContent = drawingMatch[1];
        
        const embedMatch = drawingContent.match(/<a:blip[^>]+r:embed="([^"]+)"/);
        if (embedMatch && imageRelations[embedMatch[1]]) {
          const imagePath = imageRelations[embedMatch[1]];
          
          const extentMatch = drawingContent.match(/<wp:extent[^>]+cx="(\d+)"[^>]+cy="(\d+)"/);
          const width = extentMatch ? parseInt(extentMatch[1]) : 914400;
          const height = extentMatch ? parseInt(extentMatch[2]) : 914400;
          
          const widthMm = (width / 914400) * 25.4;
          const heightMm = (height / 914400) * 25.4;
          
          let wrapping = 'inline';
          if (drawingContent.includes('<wp:wrapSquare')) wrapping = 'square';
          else if (drawingContent.includes('<wp:wrapTight')) wrapping = 'tight';
          
          const alignMatch = drawingContent.match(/<wp:align>(\w+)<\/wp:align>/);
          const alignment = alignMatch ? alignMatch[1].toLowerCase() : 'left';
          
          try {
            const imageFile = zip.file(imagePath);
            if (imageFile) {
              const imageBuffer = await imageFile.async('uint8array');
              const ext = imagePath.split('.').pop() || 'png';
              const logoFileName = `template-logo-${Date.now()}.${ext}`;
              
              const { error: uploadError } = await supabase.storage
                .from('company-logos')
                .upload(logoFileName, imageBuffer, {
                  contentType: `image/${ext}`,
                  upsert: true
                });
              
              if (!uploadError) {
                console.log(`✅ Logo saved: ${widthMm.toFixed(1)}x${heightMm.toFixed(1)}mm, ${wrapping}, ${alignment}`);
                logoData = {
                  position: 'header',
                  extracted_logo_path: logoFileName,
                  width_mm: widthMm,
                  height_mm: heightMm,
                  width_emu: width,
                  height_emu: height,
                  wrapping: wrapping,
                  alignment: alignment
                };
              }
            }
          } catch (err) {
            console.error('Error saving logo:', err);
          }
          
          break;
        }
      }
    }

    // === STYLE EXTRACTION ===
    const extractStyle = (runContent: string) => {
      const style: any = {
        font: 'Calibri',
        size: '11pt',
        color: '#000000',
        bold: false,
        italic: false,
        underline: false,
        underlineColor: null,
        case: 'mixed'
      };
      
      const fontMatch = runContent.match(/<w:rFonts[^>]+w:ascii="([^"]+)"/);
      if (fontMatch) style.font = fontMatch[1];
      
      const sizeMatch = runContent.match(/<w:sz[^>]+w:val="(\d+)"/);
      if (sizeMatch) style.size = `${parseInt(sizeMatch[1]) / 2}pt`;
      
      const colorMatch = runContent.match(/<w:color[^>]+w:val="([^"]+)"/);
      if (colorMatch && colorMatch[1] !== 'auto') style.color = `#${colorMatch[1]}`;
      
      style.bold = /<w:b[\/\s>]/.test(runContent);
      style.italic = /<w:i[\/\s>]/.test(runContent);
      
      const underlineMatch = runContent.match(/<w:u[^>]+w:val="([^"]+)"(?:[^>]+w:color="([^"]+)")?/);
      if (underlineMatch && underlineMatch[1] !== 'none') {
        style.underline = true;
        style.underlineColor = underlineMatch[2] ? `#${underlineMatch[2]}` : style.color;
      }
      
      // Detect case
      const textMatch = runContent.match(/<w:t[^>]*>([^<]+)</w:t>/);
      if (textMatch) {
        const text = textMatch[1];
        style.case = text === text.toUpperCase() ? 'uppercase' : text === text.toLowerCase() ? 'lowercase' : 'mixed';
      }
      
      return style;
    };
    
    const extractParagraph = (paraContent: string) => {
      const props: any = {
        alignment: 'left',
        indentLeft: 0,
        indentFirstLine: 0,
        spacingBefore: 0,
        spacingAfter: 0,
        background: null,
        borders: null,
        bullet: null
      };
      
      const alignMatch = paraContent.match(/<w:jc[^>]+w:val="(\w+)"/);
      if (alignMatch) props.alignment = alignMatch[1].toLowerCase();
      
      const indMatch = paraContent.match(/<w:ind[^>]*\/>/);
      if (indMatch) {
        const indContent = indMatch[0];
        const leftMatch = indContent.match(/w:left="(\d+)"/);
        const firstLineMatch = indContent.match(/w:firstLine="(\d+)"/);
        if (leftMatch) props.indentLeft = (parseInt(leftMatch[1]) * 0.0176).toFixed(2); // twips to mm
        if (firstLineMatch) props.indentFirstLine = (parseInt(firstLineMatch[1]) * 0.0176).toFixed(2);
      }
      
      const spacingMatch = paraContent.match(/<w:spacing[^>]*\/>/);
      if (spacingMatch) {
        const spacingContent = spacingMatch[0];
        const beforeMatch = spacingContent.match(/w:before="(\d+)"/);
        const afterMatch = spacingContent.match(/w:after="(\d+)"/);
        if (beforeMatch) props.spacingBefore = (parseInt(beforeMatch[1]) / 20).toFixed(2); // twips to pt
        if (afterMatch) props.spacingAfter = (parseInt(afterMatch[1]) / 20).toFixed(2);
      }
      
      const shdMatch = paraContent.match(/<w:shd[^>]+w:fill="([^"]+)"/);
      if (shdMatch) props.background = `#${shdMatch[1]}`;
      
      const borderMatch = paraContent.match(/<w:pBdr>(.*?)<\/w:pBdr>/s);
      if (borderMatch) {
        const borders: any = {};
        const borderTypes = ['top', 'right', 'bottom', 'left'];
        for (const type of borderTypes) {
          const borderRegex = new RegExp(`<w:${type}[^>]+w:val="([^"]+)"[^>]+w:sz="(\d+)"[^>]+w:color="([^"]+)"`);
          const match = borderMatch[1].match(borderRegex);
          if (match) {
            borders[type] = {
              style: match[1],
              width: (parseInt(match[2]) / 8).toFixed(2) + 'pt', // eighths of a point to pt
              color: `#${match[3]}`
            };
          }
        }
        props.borders = borders;
      }
      
      const bulletMatch = paraContent.match(/<w:numPr>(.*?)<\/w:numPr>/s);
      if (bulletMatch) {
        const numIdMatch = bulletMatch[1].match(/<w:numId[^>]+w:val="(\d+)"/);
        const ilvlMatch = bulletMatch[1].match(/<w:ilvl[^>]+w:val="(\d+)"/);
        props.bullet = {
          level: ilvlMatch ? parseInt(ilvlMatch[1]) : 0,
          numId: numIdMatch ? parseInt(numIdMatch[1]) : 0
        };
      }
      
      return props;
    };

    // === TABLE DETECTION ===
    const tables: any[] = [];
    const tableMatches = documentXml.matchAll(/<w:tbl>(.*?)<\/w:tbl>/gs);
    for (const tableMatch of tableMatches) {
      const tableContent = tableMatch[1];
      const rows = tableContent.match(/<w:tr[^>]*>/g)?.length || 0;
      const cells = tableContent.match(/<w:tc[^>]*>/g)?.length || 0;
      const tablePropsMatch = tableContent.match(/<w:tblPr>(.*?)<\/w:tblPr>/s);
      const tableStyle: any = { borders: null, background: null };
      
      if (tablePropsMatch) {
        const shdMatch = tablePropsMatch[1].match(/<w:shd[^>]+w:fill="([^"]+)"/);
        if (shdMatch) tableStyle.background = `#${shdMatch[1]}`;
        
        const borderMatch = tablePropsMatch[1].match(/<w:tblBorders>(.*?)<\/w:tblBorders>/s);
        if (borderMatch) {
          const borders: any = {};
          const borderTypes = ['top', 'right', 'bottom', 'left', 'insideH', 'insideV'];
          for (const type of borderTypes) {
            const borderRegex = new RegExp(`<w:${type}[^>]+w:val="([^"]+)"[^>]+w:sz="(\d+)"[^>]+w:color="([^"]+)"`);
            const match = borderMatch[1].match(borderRegex);
            if (match) {
              borders[type] = {
                style: match[1],
                width: (parseInt(match[2]) / 8).toFixed(2) + 'pt',
                color: `#${match[3]}`
              };
            }
          }
          tableStyle.borders = borders;
        }
      }
      
      tables.push({
        rows,
        cells,
        style: tableStyle
      });
    }

    // === ELEMENT EXTRACTION ===
    const styles: any = {};
    const allColors = new Set<string>();
    
    const paragraphs = documentXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs);
    let isFirstPage = true;
    
    for (const paraMatch of paragraphs) {
      const paraContent = paraMatch[1];
      const textMatches = Array.from(paraContent.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g));
      const text = textMatches.map(m => m[1]).join('').trim();
      
      if (!text || text.length < 2) continue;
      
      const runMatch = paraContent.match(/<w:r[^>]*>(.*?)<\/w:r>/s);
      if (!runMatch) continue;
      
      const style = extractStyle(runMatch[1]);
      const paragraph = extractParagraph(paraContent);
      
      if (style.color !== '#000000') allColors.add(style.color);
      
      const textUpper = text.toUpperCase();
      const position = headerXml && paraContent.includes(headerXml) ? 'header' : footerXml && paraContent.includes(footerXml) ? 'footer' : 'body';
      
      // Title/Métier (large font, centered or bold, often first non-header paragraph)
      if (!styles.title && style.size >= '14pt' && (paragraph.alignment === 'center' || style.bold) && isFirstPage) {
        styles.title = { ...style, paragraph, position, text };
      }
      
      // Commercial contact (email/phone pattern in header or body)
      if (!styles.commercial_contact && text.match(/[\w\.-]+@[\w\.-]+\.\w+|\+\d{10,}|\d{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}/)) {
        styles.commercial_contact = { ...style, paragraph, position, text };
      }
      
      // Trigram (3 letters, uppercase)
      if (!styles.trigram && text.match(/^[A-Z]{3}$/)) {
        styles.trigram = { ...style, paragraph, position, text };
      }
      
      // Section titles (Compétences, Expériences, Formation)
      if (textUpper.includes('COMPÉTENCE') || textUpper.includes('COMPETENCE')) {
        styles.section_competences = { ...style, paragraph, position, text };
      } else if (textUpper.includes('EXPÉRIENCE') || textUpper.includes('EXPERIENCE')) {
        styles.section_experiences = { ...style, paragraph, position, text };
      } else if (textUpper.includes('FORMATION') || textUpper.includes('CERTIFICATION') || textUpper.includes('DIPLÔME')) {
        styles.section_formation = { ...style, paragraph, position, text };
      }
      
      // Mission title (Role, Date, Company, e.g., "Développeur | 01/2020 - 12/2021 | Acme Corp")
      if (!styles.mission_title && text.match(/\|.*\d{2}\/\d{4}\s*-\s*\d{2}\/\d{4}.*\|/)) {
        styles.mission_title = { ...style, paragraph, position, text };
        const dateMatch = text.match(/(\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{4})/);
        styles.mission_date_format = dateMatch ? 'MM/YYYY' : 'unknown';
      }
      
      // Mission context/objective (italic, often follows mission title)
      if (!styles.mission_context && style.italic && !styles.mission_context) {
        styles.mission_context = { ...style, paragraph, position, text };
      }
      
      // Mission achievements (bullet points)
      if (!styles.mission_achievement && paragraph.bullet) {
        styles.mission_achievement = { ...style, paragraph, position, text, bulletChar: text[0] };
      }
      
      // Mission environment (bold, often technical terms)
      if (!styles.mission_environment && style.bold && text.match(/Java|Python|SQL|Agile/i)) {
        styles.mission_environment = { ...style, paragraph, position, text };
      }
      
      // Skills (technical/functional, often in lists)
      if (!styles.skills_item && (styles.section_competences || textUpper.includes('COMPÉTENCE')) && paragraph.bullet) {
        styles.skills_item = { ...style, paragraph, position, text, bulletChar: text[0] };
      }
      
      // Education (degree, date, place/organization)
      if (!styles.education_degree && (styles.section_formation || textUpper.includes('FORMATION')) && style.bold) {
        styles.education_degree = { ...style, paragraph, position, text };
        const dateMatch = text.match(/(\d{4})\s*-\s*(\d{4})|(\d{4})/);
        styles.education_date_format = dateMatch ? (dateMatch[2] ? 'YYYY-YYYY' : 'YYYY') : 'unknown';
        const placeMatch = text.match(/,?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)$/);
        if (placeMatch) styles.education_place = { ...style, paragraph, position, text: placeMatch[1] };
      }
      
      // Default body text
      if (!styles.body_text) {
        styles.body_text = { ...style, paragraph, position, text };
      }
      
      isFirstPage = false;
    }
    
    // Header/Footer presence
    const page = {
      header: { enabled: !!headerXml },
      footer: { enabled: !!footerXml },
      first_page_different: settingsXml?.includes('<w:titlePg') || false
    };
    
    const bodyStyle = styles.body_text || { font: 'Calibri', size: '11pt', color: '#000000' };
    const titleStyle = styles.section_competences || styles.section_experiences || styles.section_formation || { font: 'Calibri', size: '16pt', color: '#2563eb', bold: true };
    const primaryColor = Array.from(allColors)[0] || '#2563eb';
    
    console.log('✅ Extraction complete');
    console.log('  Font:', bodyStyle.font);
    console.log('  Primary color:', primaryColor);
    console.log('  Logo:', logoData ? `${logoData.width_mm.toFixed(1)}x${logoData.height_mm.toFixed(1)}mm` : 'Not found');
    console.log('  Tables:', tables.length);
    
    return {
      layout: pageLayout,
      colors: {
        primary: primaryColor,
        secondary: "#64748b",
        text: "#1e293b",
        background: "#ffffff",
        accent: primaryColor,
        borders: "#e2e8f0"
      },
      fonts: {
        title_font: titleStyle.font,
        body_font: bodyStyle.font,
        title_size: titleStyle.size,
        body_size: bodyStyle.size,
        title_weight: titleStyle.bold ? "bold" : "normal",
        line_height: "1.15"
      },
      sections: [
        {
          name: "PROFIL",
          position: styles.title?.position || "top-center",
          title_style: styles.title || titleStyle,
          spacing: { top: "0mm", bottom: "10mm" },
          paragraph: styles.title?.paragraph || { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } }
        },
        {
          name: "COMPÉTENCES",
          position: styles.section_competences?.position || "body",
          title_style: styles.section_competences || titleStyle,
          spacing: { top: "10mm", bottom: "5mm" },
          paragraph: styles.section_competences?.paragraph || titleStyle.paragraph
        },
        {
          name: "EXPÉRIENCES",
          position: styles.section_experiences?.position || "body",
          title_style: styles.section_experiences || titleStyle,
          spacing: { top: "10mm", bottom: "5mm" },
          paragraph: styles.section_experiences?.paragraph || titleStyle.paragraph
        },
        {
          name: "FORMATION",
          position: styles.section_formation?.position || "body",
          title_style: styles.section_formation || titleStyle,
          spacing: { top: "10mm", bottom: "5mm" },
          paragraph: styles.section_formation?.paragraph || titleStyle.paragraph
        }
      ],
      element_styles: {
        commercial_contact: styles.commercial_contact || { ...bodyStyle, position: 'header', text: '' },
        trigram: styles.trigram || { ...bodyStyle, color: primaryColor, bold: true, text: '' },
        title: styles.title || { ...titleStyle, text: '' },
        section_competences: styles.section_competences || titleStyle,
        section_experiences: styles.section_experiences || titleStyle,
        section_formation: styles.section_formation || titleStyle,
        mission_title: styles.mission_title || { ...bodyStyle, bold: true, text: '' },
        mission_date_format: styles.mission_date_format || 'MM/YYYY',
        mission_context: styles.mission_context || { ...bodyStyle, italic: true, text: '' },
        mission_achievement: styles.mission_achievement || { ...bodyStyle, bulletChar: '•', text: '' },
        mission_environment: styles.mission_environment || { ...bodyStyle, bold: true, text: '' },
        skills_label: styles.skills_label || { ...bodyStyle, bold: true, text: '' },
        skills_item: styles.skills_item || { ...bodyStyle, bulletChar: '•', text: '' },
        education_degree: styles.education_degree || { ...bodyStyle, bold: true, text: '' },
        education_date_format: styles.education_date_format || 'YYYY',
        education_place: styles.education_place || { ...bodyStyle, text: '' },
        body_text: bodyStyle
      },
      visual_elements: {
        logo: logoData,
        tables: tables,
        borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
        bullets: styles.mission_achievement ? { character: styles.mission_achievement.bulletChar, color: primaryColor, indent: "12mm", font: bodyStyle.font, size: bodyStyle.size } : { character: '•', color: primaryColor, indent: "12mm" }
      },
      spacing: {
        section_spacing: "12pt",
        element_spacing: "6pt",
        padding: "10mm",
        line_spacing: "1.15"
      },
      page: page
    };
  } catch (error) {
    console.error('❌ DOCX analysis error:', error);
    return getDefaultStructure();
  }
}

function getDefaultStructure() {
  return {
    layout: {
      margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
      orientation: "portrait",
      size: "A4",
      columns: { count: 1, widths: [100] }
    },
    colors: {
      primary: "#2563eb",
      secondary: "#64748b",
      text: "#1e293b",
      background: "#ffffff",
      accent: "#3b82f6",
      borders: "#e2e8f0"
    },
    fonts: {
      title_font: "Calibri",
      body_font: "Calibri",
      title_size: "16pt",
      body_size: "11pt",
      title_weight: "bold",
      line_height: "1.15"
    },
    sections: [
      {
        name: "PROFIL",
        position: "top-center",
        title_style: { font: "Calibri", size: "20pt", color: "#2563eb", bold: true, underline: false },
        spacing: { top: "0mm", bottom: "10mm" },
        paragraph: { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      },
      {
        name: "COMPÉTENCES",
        position: "body",
        title_style: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true },
        spacing: { top: "10mm", bottom: "5mm" },
        paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      },
      {
        name: "EXPÉRIENCES",
        position: "body",
        title_style: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true },
        spacing: { top: "10mm", bottom: "5mm" },
        paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      },
      {
        name: "FORMATION",
        position: "body",
        title_style: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true },
        spacing: { top: "10mm", bottom: "5mm" },
        paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      }
    ],
    element_styles: {
      commercial_contact: { font: "Calibri", size: "11pt", color: "#000000", bold: false, position: 'header', text: '' },
      trigram: { font: "Calibri", size: "11pt", color: "#2563eb", bold: true, text: '' },
      title: { font: "Calibri", size: "20pt", color: "#2563eb", bold: true, text: '' },
      section_competences: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true },
      section_experiences: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true },
      section_formation: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true },
      mission_title: { font: "Calibri", size: "11pt", color: "#2563eb", bold: true, text: '' },
      mission_date_format: 'MM/YYYY',
      mission_context: { font: "Calibri", size: "11pt", color: "#64748b", italic: true, text: '' },
      mission_achievement: { font: "Calibri", size: "11pt", color: "#000000", bulletChar: '•', text: '' },
      mission_environment: { font: "Calibri", size: "11pt", color: "#000000", bold: true, text: '' },
      skills_label: { font: "Calibri", size: "11pt", color: "#000000", bold: true, text: '' },
      skills_item: { font: "Calibri", size: "11pt", color: "#000000", bulletChar: '•', text: '' },
      education_degree: { font: "Calibri", size: "11pt", color: "#000000", bold: true, text: '' },
      education_date_format: 'YYYY',
      education_place: { font: "Calibri", size: "11pt", color: "#000000", text: '' },
      body_text: { font: "Calibri", size: "11pt", color: "#000000" }
    },
    visual_elements: {
      logo: null,
      tables: [],
      borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
      bullets: { character: "•", color: "#2563eb", indent: "12mm" }
    },
    spacing: {
      section_spacing: "12pt",
      element_spacing: "6pt",
      padding: "10mm",
      line_spacing: "1.15"
    },
    page: {
      header: { enabled: false },
      footer: { enabled: false },
      first_page_different: false
    }
  };
}
