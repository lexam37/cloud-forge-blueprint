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
      const marginMatch = settingsXml.match(/<w:pgMar[^>]+w:top="(\d+)"[^>]+w:right="(\d+)"[^>]+w:bottom="(\d+)"[^>]+w:left="(\d+)"[^>]+w:header="(\d+)"[^>]+w:footer="(\d+)"/);
      if (marginMatch) {
        pageLayout.margins = {
          top: (parseInt(marginMatch[1]) / 56.69).toFixed(2) + "mm",
          right: (parseInt(marginMatch[2]) / 56.69).toFixed(2) + "mm",
          bottom: (parseInt(marginMatch[3]) / 56.69).toFixed(2) + "mm",
          left: (parseInt(marginMatch[4]) / 56.69).toFixed(2) + "mm"
        };
      }

      pageLayout.orientation = settingsXml.includes('<w:orient w:val="landscape"') ? "landscape" : "portrait";

      const sizeMatch = settingsXml.match(/<w:pgSz[^>]+w:w="(\d+)"[^>]+w:h="(\d+)"/);
      if (sizeMatch) {
        const width = parseInt(sizeMatch[1]) / 56.69;
        const height = parseInt(sizeMatch[2]) / 56.69;
        pageLayout.size = (width > 200 && height > 280) ? "A4" : "Letter";
      }

      const colsMatch = settingsXml.match(/<w:cols[^>]+w:num="(\d+)"[^>]*w:space="(\d+)"/);
      if (colsMatch) {
        const colCount = parseInt(colsMatch[1]);
        pageLayout.columns.count = colCount;
        pageLayout.columns.widths = colCount === 2 ? [35, 65] : [100];
      }
    }

    // === LOGO EXTRACTION ===
    let logoData: any = null; // Ignored as per requirement
    if (headerXml && headerRelsXml) {
      console.log('📋 Skipping logo extraction as per requirement...');
    }

    // === STYLE EXTRACTION ===
    const extractStyle = (runContent: string) => {
      const style: any = {
        font: 'Arial',
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
      
      const textMatch = runContent.match(/<w:t[^>]*>([^<]+)<\/w:t>/);
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
        if (leftMatch) props.indentLeft = (parseInt(leftMatch[1]) * 0.0176).toFixed(2);
        if (firstLineMatch) props.indentFirstLine = (parseInt(firstLineMatch[1]) * 0.0176).toFixed(2);
      }
      
      const spacingMatch = paraContent.match(/<w:spacing[^>]*\/>/);
      if (spacingMatch) {
        const spacingContent = spacingMatch[0];
        const beforeMatch = spacingContent.match(/w:before="(\d+)"/);
        const afterMatch = spacingContent.match(/w:after="(\d+)"/);
        if (beforeMatch) props.spacingBefore = (parseInt(beforeMatch[1]) / 20).toFixed(2);
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
              width: (parseInt(match[2]) / 8).toFixed(2) + 'pt',
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
        const textMatch = paraContent.match(/<w:t[^>]*>([^<]+)</w:t>/);
        props.bullet = {
          level: ilvlMatch ? parseInt(ilvlMatch[1]) : 0,
          numId: numIdMatch ? parseInt(numIdMatch[1]) : 0,
          character: textMatch && textMatch[1].match(/^[\•\-\*]/) ? textMatch[1][0] : '•'
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
    const sections: any[] = [];
    const skillSubcategories: any[] = [];
    const allColors = new Set<string>();
    
    const paragraphs = Array.from(documentXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs));
    let isFirstPage = true;
    let currentSection: string | null = null;
    let currentSubcategory: string | null = null;
    
    // Common section keywords (case-insensitive, with variations)
    const sectionKeywords = {
      competences: ['compétence', 'competence', 'skills', 'compétences'],
      experiences: ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
      formation: ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education']
    };

    for (let i = 0; i < paragraphs.length; i++) {
      const paraContent = paragraphs[i][1];
      const textMatches = Array.from(paraContent.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g));
      const text = textMatches.map(m => m[1]).join('').trim();
      
      if (!text || text.length < 2) continue;
      
      const runMatch = paraContent.match(/<w:r[^>]*>(.*?)<\/w:r>/s);
      if (!runMatch) continue;
      
      const style = extractStyle(runContent);
      const paragraph = extractParagraph(paraContent);
      
      if (style.color !== '#000000') allColors.add(style.color);
      
      const textLower = text.toLowerCase();
      const position = headerXml?.includes(paraContent) ? 'header' : footerXml?.includes(paraContent) ? 'footer' : 'body';
      
      // Title/Métier (first bold/large paragraph, or contains job title keywords)
      if (!styles.title && isFirstPage && (style.size >= '12pt' || style.bold) && (paragraph.alignment === 'center' || textLower.includes('architecte') || textLower.includes('analyste') || textLower.includes('product owner'))) {
        styles.title = { ...style, paragraph, position, text };
      }
      
      // Skip commercial contact
      if (text.match(/[\w\.-]+@[\w\.-]+\.\w+|\+?\d{10,}|\d{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}/)) {
        continue;
      }
      
      // Trigram (3 letters, uppercase)
      if (!styles.trigram && text.match(/^[A-Z]{3}$/)) {
        styles.trigram = { ...style, paragraph, position, text };
      }
      
      // Section detection (using keywords)
      let sectionDetected = false;
      for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
        if (keywords.some(keyword => textLower.includes(keyword))) {
          currentSection = sectionKey;
          styles[`section_${sectionKey}`] = { ...style, paragraph, position, text };
          sections.push({
            name: text,
            position,
            title_style: { ...style },
            spacing: { top: paragraph.spacingBefore || "10mm", bottom: paragraph.spacingAfter || "5mm" },
            paragraph
          });
          sectionDetected = true;
          break;
        }
      }
      
      if (sectionDetected) continue;
      
      // Skill subcategories (bold or italic, not a bullet point, in competences section)
      if (currentSection === 'competences' && (style.bold || style.italic) && !paragraph.bullet) {
        currentSubcategory = text;
        skillSubcategories.push({ name: text, style: { ...style, paragraph, position } });
      }
      
      // Mission title (date format + role/company)
      if (currentSection === 'experiences' && text.match(/\d{2}[/-]\d{4}\s*-\s*(\d{2}[/-]\d{4}|actuellement|present).*[@:]/i)) {
        styles.mission_title = { ...style, paragraph, position, text };
        const dateMatch = text.match(/(\d{2}[/-]\d{4})\s*-\s*(\d{2}[/-]\d{4}|actuellement|present)/i);
        styles.mission_date_format = dateMatch ? (dateMatch[2].toLowerCase() === 'actuellement' || dateMatch[2].toLowerCase() === 'present' ? 'MM/YYYY - Actuellement' : 'MM/YYYY - MM/YYYY') : 'unknown';
      }
      
      // Mission context (italic, starts with "contexte" or follows mission title)
      if (currentSection === 'experiences' && style.italic && (textLower.startsWith('contexte') || (i > 0 && paragraphs[i-1][1].match(/\d{2}[/-]\d{4}\s*-\s*(\d{2}[/-]\d{4}|actuellement|present)/i)))) {
        styles.mission_context = { ...style, paragraph, position, text };
      }
      
      // Mission achievements (bullet points in experiences)
      if (currentSection === 'experiences' && paragraph.bullet) {
        styles.mission_achievement = { ...style, paragraph, position, text, bulletChar: paragraph.bullet.character };
      }
      
      // Mission environment (bold, starts with "environnement" or technical terms)
      if (currentSection === 'experiences' && style.bold && (textLower.startsWith('environnement') || text.match(/java|python|sql|agile|linux|windows|docker/i))) {
        styles.mission_environment = { ...style, paragraph, position, text };
      }
      
      // Skills (bullet points in competences)
      if (currentSection === 'competences' && paragraph.bullet) {
        styles.skills_item = { ...style, paragraph, position, text, bulletChar: paragraph.bullet.character, subcategory: currentSubcategory || 'Autres' };
      }
      
      // Education (bold, in formation section, with year)
      if (currentSection === 'formation' && style.bold) {
        styles.education_degree = { ...style, paragraph, position, text };
        const dateMatch = text.match(/(\d{4})\s*-\s*(\d{4})|(\d{4})/);
        const placeMatch = text.match(/[@,]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)$/);
        styles.education_date_format = dateMatch ? (dateMatch[2] ? 'YYYY-YYYY' : 'YYYY') : 'unknown';
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
    
    const bodyStyle = styles.body_text || { font: 'Arial', size: '11pt', color: '#000000' };
    const titleStyle = styles.section_competences || styles.section_experiences || styles.section_formation || { font: 'Arial', size: '14pt', color: '#000000', bold: true, case: 'mixed' };
    const primaryColor = Array.from(allColors).sort((a, b) => allColors.size - allColors.size)[0] || '#000000';
    
    console.log('✅ Extraction complete');
    console.log('  Font:', bodyStyle.font);
    console.log('  Primary color:', primaryColor);
    console.log('  Tables:', tables.length);
    
    return {
      layout: pageLayout,
      colors: {
        primary: primaryColor,
        secondary: bodyStyle.color,
        text: bodyStyle.color,
        background: "#ffffff",
        accent: primaryColor,
        borders: primaryColor
      },
      fonts: {
        title_font: titleStyle.font,
        body_font: bodyStyle.font,
        title_size: titleStyle.size,
        body_size: bodyStyle.size,
        title_weight: titleStyle.bold ? "bold" : "normal",
        line_height: "1.15"
      },
      sections: sections.length > 0 ? sections : [
        {
          name: "COMPÉTENCES",
          position: "body",
          title_style: titleStyle,
          spacing: { top: "10mm", bottom: "5mm" },
          paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
        },
        {
          name: "EXPÉRIENCE",
          position: "body",
          title_style: titleStyle,
          spacing: { top: "10mm", bottom: "5mm" },
          paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
        },
        {
          name: "FORMATIONS & CERTIFICATIONS",
          position: "body",
          title_style: titleStyle,
          spacing: { top: "10mm", bottom: "5mm" },
          paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
        }
      ],
      element_styles: {
        commercial_contact: { ...bodyStyle, position: 'header', text: '', email: null, phone: null, first_name: null, last_name: null },
        trigram: styles.trigram || { ...bodyStyle, bold: true, text: '' },
        title: styles.title || { ...titleStyle, text: '' },
        section_competences: styles.section_competences || titleStyle,
        section_experiences: styles.section_experiences || titleStyle,
        section_formation: styles.section_formation || titleStyle,
        mission_title: styles.mission_title || { ...bodyStyle, bold: true, text: '' },
        mission_date_format: styles.mission_date_format || 'MM/YYYY - MM/YYYY',
        mission_context: styles.mission_context || { ...bodyStyle, italic: true, text: '' },
        mission_achievement: styles.mission_achievement || { ...bodyStyle, bulletChar: '•', text: '' },
        mission_environment: styles.mission_environment || { ...bodyStyle, bold: true, text: '' },
        skills_label: styles.skills_label || { ...bodyStyle, bold: true, text: '' },
        skills_item: styles.skills_item || { ...bodyStyle, bulletChar: '•', text: '', subcategory: 'Autres' },
        skill_subcategories: skillSubcategories,
        education_degree: styles.education_degree || { ...bodyStyle, bold: true, text: '' },
        education_date_format: styles.education_date_format || 'YYYY',
        education_place: styles.education_place || { ...bodyStyle, text: '' },
        body_text: bodyStyle
      },
      visual_elements: {
        logo: null,
        tables: tables,
        borders: { style: "solid", width: "0.5pt", color: primaryColor },
        bullets: styles.mission_achievement ? { character: styles.mission_achievement.bulletChar, color: primaryColor, indent: styles.mission_achievement.paragraph.indentLeft || "10mm", font: bodyStyle.font, size: bodyStyle.size } : { character: '•', color: primaryColor, indent: "10mm" }
      },
      spacing: {
        section_spacing: styles.section_competences?.paragraph.spacingBefore || "12pt",
        element_spacing: styles.body_text?.paragraph.spacingAfter || "6pt",
        padding: pageLayout.margins.left,
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
      primary: "#000000",
      secondary: "#000000",
      text: "#000000",
      background: "#ffffff",
      accent: "#000000",
      borders: "#000000"
    },
    fonts: {
      title_font: "Arial",
      body_font: "Arial",
      title_size: "14pt",
      body_size: "11pt",
      title_weight: "bold",
      line_height: "1.15"
    },
    sections: [
      {
        name: "Compétences",
        position: "body",
        title_style: { font: "Arial", size: "14pt", color: "#000000", bold: true, case: 'mixed' },
        spacing: { top: "10mm", bottom: "5mm" },
        paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      },
      {
        name: "Expérience",
        position: "body",
        title_style: { font: "Arial", size: "14pt", color: "#000000", bold: true, case: 'mixed' },
        spacing: { top: "10mm", bottom: "5mm" },
        paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      },
      {
        name: "Formations & Certifications",
        position: "body",
        title_style: { font: "Arial", size: "14pt", color: "#000000", bold: true, case: 'mixed' },
        spacing: { top: "10mm", bottom: "5mm" },
        paragraph: { alignment: "left", spacing: { before: "12pt", after: "6pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      }
    ],
    element_styles: {
      commercial_contact: { font: "Arial", size: "11pt", color: "#000000", bold: false, position: 'header', text: '', email: null, phone: null, first_name: null, last_name: null },
      trigram: { font: "Arial", size: "11pt", color: "#000000", bold: true, text: '' },
      title: { font: "Arial", size: "14pt", color: "#000000", bold: true, text: '' },
      section_competences: { font: "Arial", size: "14pt", color: "#000000", bold: true, case: 'mixed' },
      section_experiences: { font: "Arial", size: "14pt", color: "#000000", bold: true, case: 'mixed' },
      section_formation: { font: "Arial", size: "14pt", color: "#000000", bold: true, case: 'mixed' },
      mission_title: { font: "Arial", size: "11pt", color: "#000000", bold: true, text: '' },
      mission_date_format: 'MM/YYYY - MM/YYYY',
      mission_context: { font: "Arial", size: "11pt", color: "#000000", italic: true, text: '' },
      mission_achievement: { font: "Arial", size: "11pt", color: "#000000", bulletChar: '•', text: '' },
      mission_environment: { font: "Arial", size: "11pt", color: "#000000", bold: true, text: '' },
      skills_label: { font: "Arial", size: "11pt", color: "#000000", bold: true, text: '' },
      skills_item: { font: "Arial", size: "11pt", color: "#000000", bulletChar: '•', text: '', subcategory: 'Autres' },
      skill_subcategories: [],
      education_degree: { font: "Arial", size: "11pt", color: "#000000", bold: true, text: '' },
      education_date_format: 'YYYY',
      education_place: { font: "Arial", size: "11pt", color: "#000000", text: '' },
      body_text: { font: "Arial", size: "11pt", color: "#000000" }
    },
    visual_elements: {
      logo: null,
      tables: [],
      borders: { style: "solid", width: "0.5pt", color: "#000000" },
      bullets: { character: "•", color: "#000000", indent: "10mm" }
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
