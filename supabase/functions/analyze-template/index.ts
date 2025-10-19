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
    const headerRelsXml = await zip.file('word/_rels/header1.xml.rels')?.async('text');
    
    if (!documentXml) throw new Error('document.xml not found');
    
    console.log('📄 Analyzing document...');
    
    // === LOGO EXTRACTION ===
    let logoData: any = null;
    
    if (headerXml && headerRelsXml) {
      console.log('📋 Extracting logo from header...');
      
      // Build image relations map
      const imageRelations: { [key: string]: string } = {};
      const relMatches = headerRelsXml.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Type="[^"]*image[^"]*"[^>]+Target="([^"]+)"/g);
      for (const match of relMatches) {
        imageRelations[match[1]] = 'word/' + match[2].replace('../', '');
      }
      
      // Find image in header
      const drawingMatches = headerXml.matchAll(/<w:drawing>(.*?)<\/w:drawing>/gs);
      for (const drawingMatch of drawingMatches) {
        const drawingContent = drawingMatch[1];
        
        const embedMatch = drawingContent.match(/<a:blip[^>]+r:embed="([^"]+)"/);
        if (embedMatch && imageRelations[embedMatch[1]]) {
          const imagePath = imageRelations[embedMatch[1]];
          
          // Extract dimensions in EMUs (914400 EMUs = 1 inch = 25.4mm)
          const extentMatch = drawingContent.match(/<wp:extent[^>]+cx="(\d+)"[^>]+cy="(\d+)"/);
          const width = extentMatch ? parseInt(extentMatch[1]) : 914400;
          const height = extentMatch ? parseInt(extentMatch[2]) : 914400;
          
          const widthMm = (width / 914400) * 25.4;
          const heightMm = (height / 914400) * 25.4;
          
          // Extract wrapping style
          let wrapping = 'inline';
          if (drawingContent.includes('<wp:wrapSquare')) wrapping = 'square';
          else if (drawingContent.includes('<wp:wrapTight')) wrapping = 'tight';
          
          // Extract alignment
          const alignMatch = drawingContent.match(/<wp:align>(\w+)<\/wp:align>/);
          const alignment = alignMatch ? alignMatch[1].toLowerCase() : 'left';
          
          // Save logo to storage
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
      const style: any = { font: 'Calibri', size: '11pt', color: '#000000', bold: false, italic: false, underline: false };
      
      const fontMatch = runContent.match(/<w:rFonts[^>]+w:ascii="([^"]+)"/);
      if (fontMatch) style.font = fontMatch[1];
      
      const sizeMatch = runContent.match(/<w:sz[^>]+w:val="(\d+)"/);
      if (sizeMatch) style.size = `${parseInt(sizeMatch[1]) / 2}pt`;
      
      const colorMatch = runContent.match(/<w:color[^>]+w:val="([^"]+)"/);
      if (colorMatch && colorMatch[1] !== 'auto') style.color = `#${colorMatch[1]}`;
      
      style.bold = /<w:b[\/\s>]/.test(runContent);
      style.italic = /<w:i[\/\s>]/.test(runContent);
      style.underline = /<w:u[^>]+w:val="(?!none)/.test(runContent);
      
      return style;
    };
    
    const extractParagraph = (paraContent: string) => {
      const props: any = { alignment: 'left', indentLeft: 0, indentFirstLine: 0, spacingBefore: 0, spacingAfter: 0 };
      
      const alignMatch = paraContent.match(/<w:jc[^>]+w:val="(\w+)"/);
      if (alignMatch) props.alignment = alignMatch[1];
      
      const indMatch = paraContent.match(/<w:ind[^>]*\/>/);
      if (indMatch) {
        const indContent = indMatch[0];
        const leftMatch = indContent.match(/w:left="(\d+)"/);
        const firstLineMatch = indContent.match(/w:firstLine="(\d+)"/);
        if (leftMatch) props.indentLeft = parseInt(leftMatch[1]) * 0.0176; // twips to mm
        if (firstLineMatch) props.indentFirstLine = parseInt(firstLineMatch[1]) * 0.0176;
      }
      
      const spacingMatch = paraContent.match(/<w:spacing[^>]*\/>/);
      if (spacingMatch) {
        const spacingContent = spacingMatch[0];
        const beforeMatch = spacingContent.match(/w:before="(\d+)"/);
        const afterMatch = spacingContent.match(/w:after="(\d+)"/);
        if (beforeMatch) props.spacingBefore = parseInt(beforeMatch[1]) / 20; // twips to pt
        if (afterMatch) props.spacingAfter = parseInt(afterMatch[1]) / 20;
      }
      
      return props;
    };
    
    const styles: any = {};
    const allColors = new Set<string>();
    
    // Analyze document paragraphs
    const paragraphs = documentXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs);
    
    for (const paraMatch of paragraphs) {
      const paraContent = paraMatch[1];
      const textMatches = Array.from(paraContent.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g));
      const text = textMatches.map(m => m[1]).join('');
      
      if (!text || text.trim().length < 2) continue;
      
      const runMatch = paraContent.match(/<w:r[^>]*>(.*?)<\/w:r>/s);
      if (!runMatch) continue;
      
      const style = extractStyle(runMatch[1]);
      const paragraph = extractParagraph(paraContent);
      
      if (style.color !== '#000000') allColors.add(style.color);
      
      const textUpper = text.toUpperCase().trim();
      
      if (textUpper.match(/^[A-Z]{3}$/)) {
        styles.trigram = { ...style, paragraph };
      } else if (textUpper.includes('COMPÉTENCE') || textUpper.includes('COMPETENCE')) {
        styles.section_title = { ...style, paragraph };
      } else if (textUpper.includes('EXPÉRIENCE') || textUpper.includes('EXPERIENCE')) {
        styles.section_title = styles.section_title || { ...style, paragraph };
      } else if (textUpper.includes('FORMATION')) {
        styles.section_title = styles.section_title || { ...style, paragraph };
      } else if (text.startsWith('•') || text.startsWith('-')) {
        styles.bullet_item = { ...style, paragraph, bulletChar: text[0] };
      } else if (style.bold && style.color !== '#000000') {
        styles.mission_title = styles.mission_title || { ...style, paragraph };
      } else if (style.italic) {
        styles.context_text = styles.context_text || { ...style, paragraph };
      } else {
        styles.body_text = styles.body_text || { ...style, paragraph };
      }
    }
    
    // Analyze header for commercial contact
    if (headerXml) {
      const headerParas = headerXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs);
      for (const paraMatch of headerParas) {
        const paraContent = paraMatch[1];
        const runMatch = paraContent.match(/<w:r[^>]*>(.*?)<\/w:r>/s);
        if (runMatch) {
          styles.commercial_contact = { ...extractStyle(runMatch[1]), paragraph: extractParagraph(paraContent), position: 'header' };
          break;
        }
      }
    }
    
    const bodyStyle = styles.body_text || { font: 'Calibri', size: '11pt', color: '#000000' };
    const titleStyle = styles.section_title || { font: 'Calibri', size: '16pt', color: '#2563eb', bold: true };
    const primaryColor = Array.from(allColors)[0] || '#2563eb';
    
    console.log('✅ Extraction complete');
    console.log('  Font:', bodyStyle.font);
    console.log('  Primary color:', primaryColor);
    console.log('  Logo:', logoData ? `${logoData.width_mm.toFixed(1)}x${logoData.height_mm.toFixed(1)}mm in header` : 'Not found');
    
    return {
      layout: {
        type: "deux-colonnes",
        column_widths: [35, 65],
        sections_order: ["profil", "competences", "experiences-professionnelles", "formation"],
        margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" }
      },
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
        title_weight: "bold",
        line_height: "1.15"
      },
      sections: [{
        name: "PROFIL",
        position: "top-center",
        title_style: titleStyle,
        spacing: { top: "0mm", bottom: "10mm" },
        paragraph: titleStyle.paragraph || { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      }],
      element_styles: {
        commercial_contact: styles.commercial_contact || { ...bodyStyle, position: 'header' },
        trigram: styles.trigram || { ...bodyStyle, color: primaryColor, bold: true },
        title: styles.body_text || bodyStyle,
        section_title: titleStyle,
        mission_title: styles.mission_title || { ...bodyStyle, color: primaryColor, bold: true },
        mission_context: styles.context_text || { ...bodyStyle, italic: true },
        mission_achievement: bodyStyle,
        mission_environment: { ...bodyStyle, bold: true },
        skills_label: { ...bodyStyle, bold: true },
        skills_item: bodyStyle,
        education_degree: { ...bodyStyle, bold: true },
        education_info: styles.context_text || { ...bodyStyle, italic: true },
        bullet_style: styles.bullet_item || { ...bodyStyle, bulletChar: '•' }
      },
      visual_elements: {
        logo: logoData,
        borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
        bullets: { character: styles.bullet_item?.bulletChar || '•', color: primaryColor, indent: "12mm", font: bodyStyle.font, size: bodyStyle.size }
      },
      spacing: {
        section_spacing: "12pt",
        element_spacing: "6pt",
        padding: "10mm",
        line_spacing: "1.15"
      },
      page: {
        header: { enabled: !!headerXml },
        footer: { enabled: false },
        first_page_different: false
      }
    };
  } catch (error) {
    console.error('❌ DOCX analysis error:', error);
    return getDefaultStructure();
  }
}

function getDefaultStructure() {
  return {
    layout: { type: "deux-colonnes", column_widths: [35, 65], sections_order: ["profil", "competences", "experiences-professionnelles", "formation"], margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" } },
    colors: { primary: "#2563eb", secondary: "#64748b", text: "#1e293b", background: "#ffffff", accent: "#3b82f6", borders: "#e2e8f0" },
    fonts: { title_font: "Calibri", body_font: "Calibri", title_size: "16pt", body_size: "11pt", title_weight: "bold", line_height: "1.15" },
    sections: [{ name: "PROFIL", position: "top-center", title_style: { color: "#2563eb", size: "20pt", font: "Calibri", bold: true, underline: false }, spacing: { top: "0mm", bottom: "10mm" }, paragraph: { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } } }],
    element_styles: { commercial_contact: { font: "Calibri", size: "11pt", color: "#000000", bold: false, position: 'body' }, trigram: { font: "Calibri", size: "11pt", color: "#2563eb", bold: true }, title: { font: "Calibri", size: "11pt", color: "#000000", bold: false }, section_title: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true, underline: false }, mission_title: { font: "Calibri", size: "11pt", color: "#2563eb", bold: true }, mission_context: { font: "Calibri", size: "11pt", color: "#64748b", bold: false, italic: true }, mission_achievement: { font: "Calibri", size: "11pt", color: "#000000", bold: false }, mission_environment: { font: "Calibri", size: "11pt", color: "#000000", bold: true }, skills_label: { font: "Calibri", size: "11pt", color: "#000000", bold: true }, skills_item: { font: "Calibri", size: "11pt", color: "#000000", bold: false }, education_degree: { font: "Calibri", size: "11pt", color: "#000000", bold: true }, education_info: { font: "Calibri", size: "11pt", color: "#64748b", bold: false, italic: true } },
    visual_elements: { logo: null, borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" }, bullets: { character: "•", color: "#2563eb", indent: "12mm" } },
    spacing: { section_spacing: "12pt", element_spacing: "6pt", padding: "10mm", line_spacing: "1.15" },
    page: { header: { enabled: false }, footer: { enabled: false }, first_page_different: false }
  };
}
