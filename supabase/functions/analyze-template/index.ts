import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { docx4js } from "https://esm.sh/docx4js@3.2.7";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sectionKeywords = {
  'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
  'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
  'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
};

function extractStyle(run: any) {
  const style: any = {};
  const font = run.find('w\\:rFonts').attr('w:ascii');
  if (font) style.font = font;
  const size = run.find('w\\:sz').attr('w:val');
  if (size) style.size = `${parseInt(size) / 2}pt`;
  const color = run.find('w\\:color').attr('w:val');
  if (color && color !== 'auto') style.color = `#${color}`;
  style.bold = !!run.find('w\\:b').length;
  style.italic = !!run.find('w\\:i').length;
  return style;
}

function extractParagraph(para: any) {
  const paragraph: any = {};
  const align = para.find('w\\:jc').attr('w:val');
  if (align) paragraph.alignment = align;
  const spacingBefore = para.find('w\\:spacing').attr('w:before');
  if (spacingBefore) paragraph.spacingBefore = `${parseInt(spacingBefore) / 20}pt`;
  const spacingAfter = para.find('w\\:spacing').attr('w:after');
  if (spacingAfter) paragraph.spacingAfter = `${parseInt(spacingAfter) / 20}pt`;
  return paragraph;
}

async function analyzeDocxTemplate(doc: any, templateId: string, supabase: any) {
  const allColors = new Set<string>();
  const styles: any = {};
  const sections: any[] = [];
  const visualElements: any = {};
  let currentSection: string | null = null;

  const paragraphs = doc.officeDocument.content('w\\:p');
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const text = para.text().trim();
    if (!text || text.length < 2) continue;

    const style = extractStyle(para.find('w\\:r').first());
    const paragraph = extractParagraph(para);
    
    if (style.color && style.color !== '#000000') allColors.add(style.color);
    
    const textLower = text.toLowerCase();
    const position = doc.officeDocument.header ? 'header' : doc.officeDocument.footer ? 'footer' : 'body';
    
    // Détection des coordonnées commerciales
    if (position === 'header' && text.match(/contact\s*(commercial|professionnel)/i)) {
      styles.commercial_contact = { ...style, paragraph, position, text };
    }
    
    // Détection des sections
    let sectionDetected = false;
    for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionKey;
        styles[`section_${sectionKey}`] = { ...style, paragraph, position, text };
        sections.push({
          name: sectionKey,
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
    
    // Détection du logo
    if (para.find('w\\:drawing').length || para.find('w\\:pict').length) {
      visualElements.logo = {
        position,
        alignment: paragraph.alignment || 'left',
        width_emu: 1000000,
        height_emu: 500000
      };
    }
  }

  const structureData = {
    colors: {
      primary: Array.from(allColors)[0] || '#0000FF',
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
    const doc = await docx4js.load(arrayBuffer);

    const structureData = await analyzeDocxTemplate(doc, templateId, supabase);

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
