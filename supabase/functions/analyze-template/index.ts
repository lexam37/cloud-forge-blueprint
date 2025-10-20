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
  console.log('Extracted HTML from template:', html.substring(0, 500));

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allColors = new Set<string>();
  const styles: any = { skill_subcategories: [], skills_item: {} };
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
      font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Segoe UI Symbol',
      size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
      color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
      bold: styleAttr.includes('font-weight:bold'),
      italic: styleAttr.includes('font-style:italic'),
      case: text.match(/^[A-Z][a-z]+/) ? 'mixed' : text === text.toUpperCase() ? 'uppercase' : 'lowercase',
      bullet: p.querySelector('li') || text.match(/^[•\-\*É°\u2022\u25CF]/) ? true : false,
      alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
      spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
      spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '0pt',
      indent: styleAttr.match(/padding-left:([^;]+)/)?.[1]?.trim() || '0pt'
    };

    if (style.color && style.color !== '#000000') allColors.add(style.color);

    const textLower = text.toLowerCase();
    const position = index < 2 ? 'header' : 'body';

    // Coordonnées commerciales
    if (position === 'header' && text.match(/contact\s*(commercial|professionnel)/i)) {
      styles.commercial_contact = { ...style, position, text };
    }

    // Logo (simplifié)
    if (p.querySelector('img')) {
      visualElements.logo = {
        position,
        alignment: style.alignment,
        width_emu: 1000000,
        height_emu: 500000
      };
    }

    // Sections
    let sectionDetected = false;
    for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionKey;
        styles[`section_${sectionKey}`] = { ...style, position, text };
        sections.push({
          name: sectionKey,
          position,
          title_style: {
            ...style,
            case: sectionKey === 'Compétences' ? 'mixed' : style.case, // Forcer casse mixte pour Compétences
            color: sectionKey === 'Compétences' ? '#142D5A' : style.color, // Forcer bleu pour Compétences
            font: sectionKey === 'Compétences' ? 'Segoe UI Symbol' : style.font,
            size: sectionKey === 'Compétences' ? '14pt' : style.size
          },
          spacing: { top: style.spacingBefore || '10mm', bottom: style.spacingAfter || '5mm' },
          paragraph: { alignment: style.alignment }
        });
        sectionDetected = true;
        break;
      }
    }

    // Sous-catégories et compétences
    if (currentSection === 'Compétences' && !sectionDetected) {
      const textParts = text.split(/[\t:]/).map(t => t.trim()); // Détecter tabulation ou deux-points
      if (skillSubcategories.some(sc => textLower.includes(sc.toLowerCase()))) {
        styles.skill_subcategories.push({
          name: textParts[0],
          style: { ...style, bold: false } // Sous-catégories non gras
        });
      } else if (textParts.length > 1 || style.bullet) {
        styles.skills_item = {
          ...style,
          bold: true, // Compétences en gras
          color: '#329696', // Couleur verte du template
          font: 'Segoe UI Symbol',
          size: '11pt'
        };
      }
    }
  });

  const structureData = {
    colors: {
      primary: '#142D5A', // Bleu du titre Compétences
      text: '#000000',
      secondary: '#329696' // Vert des compétences
    },
    fonts: {
      title_font: 'Segoe UI Symbol',
      body_font: 'Segoe UI Symbol',
      title_size: '14pt',
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
      margins: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      orientation: 'portrait',
      size: 'A4'
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
