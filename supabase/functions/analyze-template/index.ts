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

    // Récupérer le template
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      console.error('Template not found:', templateError);
      throw new Error('Template not found');
    }

    console.log('✅ Template found:', template.name, 'Type:', template.file_type);

    // Télécharger le fichier template
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('cv-templates')
      .download(template.file_path);

    if (downloadError) {
      console.error('Download error:', downloadError);
      throw new Error('Failed to download template file');
    }

    console.log('✅ File downloaded successfully, size:', fileData.size, 'bytes');

    // Analyser le template selon son type
    let structureData;
    if (template.file_type === 'docx' || template.file_type === 'doc') {
      console.log('📝 DOCX/DOC detected - deep analysis');
      structureData = await analyzeDocxTemplate(fileData, supabase);
    } else if (template.file_type === 'pdf') {
      console.log('📄 PDF detected - analysis');
      structureData = await analyzePdfTemplate(fileData);
    } else {
      structureData = getDefaultStructure();
    }

    // Mettre à jour le template avec la structure analysée et l'activer
    const { error: updateError } = await supabase
      .from('cv_templates')
      .update({ 
        structure_data: structureData,
        is_active: true
      })
      .eq('id', templateId);

    if (updateError) {
      console.error('❌ Update error:', updateError);
      throw updateError;
    }

    // Désactiver les autres templates
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
    console.error('❌ Error in analyze-template:', error);
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

// Analyse DOCX avec extraction regex
async function analyzeDocxTemplate(docxData: Blob, supabase: any): Promise<any> {
  try {
    const JSZip = (await import('https://esm.sh/jszip@3.10.1')).default;
    const arrayBuffer = await docxData.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    
    const documentXml = await zip.file('word/document.xml')?.async('text');
    
    if (!documentXml) throw new Error('document.xml not found');
    
    console.log('📄 Document XML loaded, analyzing...');
    
    // Extraction des styles avec regex
    const fonts = new Set<string>();
    const sizes = new Set<string>();
    const colors = new Set<string>();
    
    // Extraire tous les runs avec leurs styles
    const runMatches = documentXml.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs);
    
    for (const runMatch of runMatches) {
      const runContent = runMatch[1];
      
      // Extraire la police
      const fontMatches = runContent.matchAll(/<w:rFonts[^>]+w:ascii="([^"]+)"/g);
      for (const fontMatch of fontMatches) {
        fonts.add(fontMatch[1]);
        console.log('✅ Font found:', fontMatch[1]);
      }
      
      // Extraire la taille
      const sizeMatches = runContent.matchAll(/<w:sz[^>]+w:val="([^"]+)"/g);
      for (const sizeMatch of sizeMatches) {
        const sizePt = parseInt(sizeMatch[1]) / 2;
        sizes.add(`${sizePt}pt`);
        console.log('✅ Size found:', `${sizePt}pt`);
      }
      
      // Extraire la couleur
      const colorMatches = runContent.matchAll(/<w:color[^>]+w:val="([^"]+)"/g);
      for (const colorMatch of colorMatches) {
        const colorVal = colorMatch[1];
        if (colorVal && colorVal !== 'auto' && colorVal !== '000000') {
          colors.add(`#${colorVal}`);
          console.log('✅ Color found:', `#${colorVal}`);
        }
      }
    }
    
    // Prendre la première police trouvée (la plus utilisée)
    const fontArray = Array.from(fonts);
    const sizeArray = Array.from(sizes);
    const colorArray = Array.from(colors);
    
    const bodyFont = fontArray[0] || 'Calibri';
    const bodySize = sizeArray.find(s => parseInt(s) <= 12) || '11pt';
    const titleSize = sizeArray.find(s => parseInt(s) > 12) || '16pt';
    const primaryColor = colorArray[0] || '#2563eb';
    
    console.log('📊 Extracted styles:');
    console.log('  Fonts:', fontArray.join(', '));
    console.log('  Sizes:', sizeArray.join(', '));
    console.log('  Colors:', colorArray.join(', '));
    console.log('  Selected: font=' + bodyFont + ', size=' + bodySize + ', color=' + primaryColor);
    
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
        title_font: bodyFont,
        body_font: bodyFont,
        title_size: titleSize,
        body_size: bodySize,
        title_weight: "bold",
        line_height: "1.15"
      },
      sections: [{
        name: "PROFIL",
        position: "top-center",
        title_style: { color: primaryColor, size: titleSize, font: bodyFont, decoration: "none", bold: true, underline: false },
        spacing: { top: "0mm", bottom: "10mm" },
        paragraph: { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      }],
      element_styles: {
        commercial_contact: { font: bodyFont, size: bodySize, color: "#000000", bold: false, position: 'body' },
        trigram: { font: bodyFont, size: bodySize, color: primaryColor, bold: true },
        title: { font: bodyFont, size: bodySize, color: "#000000", bold: false },
        section_title: { font: bodyFont, size: titleSize, color: primaryColor, bold: true, underline: false },
        mission_title: { font: bodyFont, size: bodySize, color: primaryColor, bold: true },
        mission_context: { font: bodyFont, size: bodySize, color: "#64748b", bold: false, italics: true },
        mission_achievement: { font: bodyFont, size: bodySize, color: "#000000", bold: false },
        mission_environment: { font: bodyFont, size: bodySize, color: "#000000", bold: true },
        skills_label: { font: bodyFont, size: bodySize, color: "#000000", bold: true },
        skills_item: { font: bodyFont, size: bodySize, color: "#000000", bold: false },
        education_degree: { font: bodyFont, size: bodySize, color: "#000000", bold: true },
        education_info: { font: bodyFont, size: bodySize, color: "#64748b", bold: false, italics: true },
        bullet_style: { character: '•', font: bodyFont, size: bodySize, color: primaryColor, indent: '12mm' }
      },
      visual_elements: {
        logo: { position: "header", size: "40x40mm", shape: "rectangle", wrapping: "square", alignment: "left" },
        borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
        bullets: { character: "•", color: primaryColor, indent: "12mm", font: bodyFont, size: bodySize }
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
  } catch (error) {
    console.error('❌ DOCX analysis error:', error);
    return getDefaultStructure();
  }
}

// Analyse PDF basique
async function analyzePdfTemplate(pdfData: Blob): Promise<any> {
  return getDefaultStructure();
}

// Structure par défaut
function getDefaultStructure() {
  return {
    layout: { 
      type: "deux-colonnes", 
      column_widths: [35, 65],
      sections_order: ["profil", "competences", "experiences-professionnelles", "formation"],
      margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" }
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
        title_style: { color: "#2563eb", size: "20pt", font: "Calibri", decoration: "none", bold: true, underline: false },
        spacing: { top: "0mm", bottom: "10mm" },
        paragraph: { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      }
    ],
    element_styles: {
      commercial_contact: { font: "Calibri", size: "11pt", color: "#000000", bold: false, position: 'body' },
      trigram: { font: "Calibri", size: "11pt", color: "#2563eb", bold: true },
      title: { font: "Calibri", size: "11pt", color: "#000000", bold: false },
      section_title: { font: "Calibri", size: "16pt", color: "#2563eb", bold: true, underline: false },
      mission_title: { font: "Calibri", size: "11pt", color: "#2563eb", bold: true },
      mission_context: { font: "Calibri", size: "11pt", color: "#64748b", bold: false, italics: true },
      mission_achievement: { font: "Calibri", size: "11pt", color: "#000000", bold: false },
      mission_environment: { font: "Calibri", size: "11pt", color: "#000000", bold: true },
      skills_label: { font: "Calibri", size: "11pt", color: "#000000", bold: true },
      skills_item: { font: "Calibri", size: "11pt", color: "#000000", bold: false },
      education_degree: { font: "Calibri", size: "11pt", color: "#000000", bold: true },
      education_info: { font: "Calibri", size: "11pt", color: "#64748b", bold: false, italics: true }
    },
    visual_elements: {
      logo: { position: "header", size: "40x40mm", shape: "rectangle", wrapping: "square", alignment: "left" },
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
