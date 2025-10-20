import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { convert } from "https://esm.sh/mammoth@1.6.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sectionKeywords = {
  'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
  'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
  'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
};

const skillSubcategories = ['Langage/BDD', 'OS', 'Outils', 'Méthodologies'];

async function analyzeDocxTemplate(arrayBuffer: ArrayBuffer, templateId: string, supabase: any) {
  const { value: html } = await convert({ arrayBuffer });
  console.log('Extracted HTML from template:', html.substring(0, 500)); // Log premier 500 chars pour débogage

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allColors = new Set<string>();
  const styles: any = {};
  const sections: any[] = [];
  const visualElements: any = {};
  let currentSection: string | null = null;

  const paragraphs = doc.querySelectorAll('p');
  console.log('Paragraphs found:', paragraphs.length);

  paragraphs.forEach((p: any, index: number) => {
    const text = p.textContent.trim();
    if (!text || text.length < 2) return;

    const styleAttr = p.getAttribute('style') || '';
    const style: any = {
      font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Arial',
      size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
      color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
      bold: styleAttr.includes('font-weight:bold'),
      italic: styleAttr.includes('font-style:italic'),
      case: text === text.toUpperCase() ? 'uppercase' : text === text.toLowerCase() ? 'lowercase' : 'mixed',
      bullet: p.querySelector('li') ? true : false,
      alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
      spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
      spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '0pt'
    };

    if (style.color && style.color !== '#000000') allColors.add(style.color);

    const textLower = text.toLowerCase();
    const position = index < 2 ? 'header' : 'body'; // Simplification : premiers paragraphes en en-tête

    // Détection des coordonnées commerciales
    if (position === 'header' && text.match(/contact\s*(commercial|professionnel)/i)) {
      styles.commercial_contact = { ...style, position, text };
    }

    // Détection du logo (simplifié : si image présente)
    if (p.querySelector('img')) {
      visualElements.logo = {
        position,
        alignment: style.alignment,
        width_emu: 1000000,
        height_emu: 500000
      };
    }

    // Détection des sections
    let sectionDetected = false;
    for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionKey;
        styles[`section_${sectionKey}`] = { ...style, position, text };
        sections.push({
          name: sectionKey,
          position,
          title_style: { ...style, case: style.case },
          spacing: { top: style.spacingBefore || '10mm', bottom: style.spacingAfter || '5mm' },
          paragraph: { alignment: style.alignment }
        });
        sectionDetected = true;
        break;
      }
    }

    // Détection des sous-catégories de compétences
    if (currentSection === 'Compétences' && !sectionDetected) {
      if (skillSubcategories.some(sc => textLower.includes(sc.toLowerCase()))) {
        if (!styles.skill_subcategories) styles.skill_subcategories = [];
        styles.skill_subcategories.push({ name: text, style: { ...style } });
      }
    }
  });

  // Détection des marges (simplifié : valeurs par défaut)
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
    layout: {
      margins: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' }
    },
    sections,
    visual_elements: visualElements,
    element_styles: styles
  };

  console.log('StructureData:', JSON.stringify(structureData, null, 2));

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
    if (!templateId) throw new Error('templateId is required');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('template_file_path')
      .eq('id', templateId)
      .single();

    if (templateError || !template) throw new Error('Template not found');

    const { data: templateFileData, error: fileError } = await supabase
      .storage
      .from('cv_templates')
      .download(template.template_file_path);

    if (fileError || !templateFileData) throw new Error('Failed to download template file');

    const arrayBuffer = await templateFileData.arrayBuffer();
    const structureData = await analyzeDocxTemplate(arrayBuffer, templateId, supabase);

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
