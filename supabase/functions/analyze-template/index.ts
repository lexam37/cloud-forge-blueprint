import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { JSZip } from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sectionKeywords = {
  'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
  'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
  'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
};

function extractStyle(runContent: string) {
  const style: any = {};
  const fontMatch = runContent.match(/<w:rFonts[^>]+w:ascii="([^"]+)"/);
  if (fontMatch) style.font = fontMatch[1];
  const sizeMatch = runContent.match(/<w:sz[^>]+w:val="(\d+)"/);
  if (sizeMatch) style.size = `${parseInt(sizeMatch[1]) / 2}pt`;
  const colorMatch = runContent.match(/<w:color[^>]+w:val="([^"]+)"/);
  if (colorMatch && colorMatch[1] !== 'auto') style.color = `#${colorMatch[1]}`;
  style.bold = /<w:b[\/\s>]/.test(runContent);
  style.italic = /<w:i[\/\s>]/.test(runContent);
  return style;
}

function extractParagraph(paraContent: string) {
  const paragraph: any = {};
  const alignMatch = paraContent.match(/<w:jc[^>]+w:val="([^"]+)"/);
  if (alignMatch) paragraph.alignment = alignMatch[1];
  const spacingBeforeMatch = paraContent.match(/<w:spacing[^>]+w:before="(\d+)"/);
  if (spacingBeforeMatch) paragraph.spacingBefore = `${parseInt(spacingBeforeMatch[1]) / 20}pt`;
  const spacingAfterMatch = paraContent.match(/<w:spacing[^>]+w:after="(\d+)"/);
  if (spacingAfterMatch) paragraph.spacingAfter = `${parseInt(spacingAfterMatch[1]) / 20}pt`;
  return paragraph;
}

async function analyzeDocxTemplate(zip: any, templateId: string, supabase: any) {
  const documentXml = await zip.file('word/document.xml')?.async('text');
  const headerXml = await zip.file('word/header1.xml')?.async('text');
  const footerXml = await zip.file('word/footer1.xml')?.async('text');

  if (!documentXml) throw new Error('document.xml not found');

  const paragraphs = Array.from(documentXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs));
  const allColors = new Set<string>();
  const styles: any = {};
  const sections: any[] = [];
  const visualElements: any = {};
  let currentSection: string | null = null;

  for (let i = 0; i < paragraphs.length; i++) {
    const paraContent = paragraphs[i][1];
    const textMatches = Array.from(paraContent.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g));
    const text = textMatches.map(m => m[1]).join('').trim();
    
    if (!text || text.length < 2) continue;
    
    const runMatch = paraContent.match(/<w:r[^>]*>(.*?)<\/w:r>/s);
    if (!runMatch) continue;
    
    const style = extractStyle(runMatch[1]);
    const paragraph = extractParagraph(paraContent);
    
    if (style.color && style.color !== '#000000') allColors.add(style.color);
    
    const textLower = text.toLowerCase();
    const position = headerXml?.includes(paraContent) ? 'header' : footerXml?.includes(paraContent) ? 'footer' : 'body';
    
    // Détection des coordonnées commerciales
    if (headerXml && text.match(/contact\s*(commercial|professionnel)/i)) {
      styles.commercial_contact = { ...style, paragraph, position, text };
    }
    
    // Détection des sections
    let sectionDetected = false;
    for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionKey;
        styles[`section_${sectionKey}`] = { ...style, paragraph, position, text };
        sections.push({
          name: text, // Conserver la casse exacte
          position,
          title_style: { ...style, case: text === text.toUpperCase() ? 'uppercase' : text === text.toLowerCase() ? 'lowercase' : 'mixed' },
          spacing: { top: paragraph.spacingBefore || "10mm", bottom: paragraph.spacingAfter || "5mm" },
          paragraph
        });
        sectionDetected = true;
        break;
      }
    }
    
    // Détection des sous-catégories de compétences
    if (currentSection === 'Compétences' && !sectionDetected) {
      const subcategories = ['Langage/BDD', 'OS', 'Outils', 'Méthodologies'];
      if (subcategories.some(sc => textLower.includes(sc.toLowerCase()))) {
        if (!styles.skill_subcategories) styles.skill_subcategories = [];
        styles.skill_subcategories.push({ name: text, style: { ...style, paragraph } });
      }
    }
    
    // Détection du logo (simplifiée, ajustez selon votre logique)
    if (paraContent.includes('<w:drawing') || paraContent.includes('<w:pict')) {
      visualElements.logo = {
        position: position,
        alignment: paragraph.alignment || 'left',
        // Placeholder pour les dimensions, ajustez si nécessaire
        width_emu: 1000000,
        height_emu: 500000
      };
    }
  }

  const structureData = {
    colors: {
      primary: Array.from(allColors)[0] || '#0000FF', // Bleu par défaut
      text: '#000000',
      secondary: Array.from(allColors)[1] || '#000000'
    },
    fonts: {
      title_font: styles.section_Compétences?.font || 'Arial',
      body_font: styles.section_Compétences?.font || 'Arial',
      title_size: styles.section_Compétences?.size || '14pt',
      body_size: '11pt',
      title_weight: 'bold',
      line_height: '1.15'
    },
    spacing: {
      section_spacing: '12pt',
      element_spacing: '6pt',
      padding: '10mm',
      line_spacing: '1.15'
    },
    sections,
    visual_elements: visualElements,
    element_styles: styles
  };

  await supabase
    .from('cv_templates')
    .update({ structure_data: structureData })
    .eq('id', templateId);

  return structureData;
}

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

    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('template_file_path')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found');
    }

    const { data: templateFileData, error: fileError } = await supabase
      .storage
      .from('cv_templates')
      .download(template.template_file_path);

    if (fileError || !templateFileData) {
      throw new Error('Failed to download template file');
    }

    const arrayBuffer = await templateFileData.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const structureData = await analyzeDocxTemplate(zip, templateId, supabase);

    return new Response(
      JSON.stringify({ success: true, templateId, structureData }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (error) {
    console.error('Error in analyze-template:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
