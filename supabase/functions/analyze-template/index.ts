import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { convert } from "https://esm.sh/mammoth@1.6.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Received request at', new Date().toISOString());
    const { templateId } = await req.json();
    console.log('Processing templateId:', templateId);

    if (!templateId) {
      throw new Error('templateId is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    console.log('Creating Supabase client with URL:', supabaseUrl.substring(0, 20) + '...');
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Fetching template from cv_templates...');
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('template_file_path')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      console.error('Template fetch error:', templateError);
      throw new Error('Template not found');
    }

    console.log('Template found, downloading file:', template.template_file_path);
    const { data: templateFileData, error: fileError } = await supabase
      .storage
      .from('cv_templates')
      .download(template.template_file_path);

    if (fileError || !templateFileData) {
      console.error('File download error:', fileError);
      throw new Error('Failed to download template file');
    }

    console.log('Template file downloaded, size:', templateFileData.size, 'bytes');
    const arrayBuffer = await templateFileData.arrayBuffer();

    const structureData = await analyzeDocxTemplate(arrayBuffer, templateId, supabase);

    return new Response(
      JSON.stringify({ success: true, templateId, structureData, message: 'Template analyzed successfully' }),
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

// Constantes et fonctions nécessaires
const sectionKeywords = {
  'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
  'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
  'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
};

interface Style {
  font: string;
  size: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: { type: string; color: string } | null;
  case: string;
  bullet: boolean;
  alignment: string;
  spacingBefore: string;
  spacingAfter: string;
  lineHeight: string;
  indent: string;
}

interface Section {
  name: string;
  position: string;
  title_style: Style;
  spacing: { top: string; bottom: string };
  paragraph: { alignment: string };
}

function extractStyle(p: any, text: string): Style {
  const styleAttr = p.getAttribute('style') || '';
  const underlineMatch = styleAttr.match(/text-decoration: underline/);
  const underlineColorMatch = styleAttr.match(/text-decoration-color: (#\w+)/);
  const tabMatch = text.match(/\t/);

  return {
    font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Segoe UI Symbol',
    size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
    color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
    bold: styleAttr.includes('font-weight:bold'),
    italic: styleAttr.includes('font-style:italic'),
    underline: underlineMatch ? { type: 'single', color: underlineColorMatch ? underlineColorMatch[1] : '#000000' } : null,
    case: text.match(/^[A-Z][a-z]+/) ? 'mixed' : text === text.toUpperCase() ? 'uppercase' : 'lowercase',
    bullet: p.querySelector('li') || text.match(/^[•\-\*É°\u2022\u25CF]/) ? true : false,
    alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
    spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
    spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '0pt',
    lineHeight: styleAttr.match(/line-height:([^;]+)/)?.[1]?.trim() || '1.15',
    indent: styleAttr.match(/padding-left:([^;]+)/)?.[1]?.trim() || tabMatch ? '5mm' : '0pt',
  };
}

function extractVisualElements(p: any, text: string, style: Style, position: string, visualElements: any, styles: any) {
  if (position === 'header') {
    if (text.match(/contact\s*(commercial|professionnel)/i)) {
      styles.commercial_contact = { ...style, position, text };
      visualElements.commercial_contact = { ...style, position, text };
    }
    if (p.querySelector('img')) {
      visualElements.logo = {
        present: true,
        position,
        alignment: style.alignment,
        width_emu: 1000000,
        height_emu: 500000,
      };
    }
  }
}

function extractSectionsAndSubcategories(
  p: any,
  text: string,
  style: Style,
  index: number,
  paragraphsLength: number,
  currentSection: string | null,
  styles: any,
  sections: Section[],
  skillSubcategories: string[]
): string | null {
  const textLower = text.toLowerCase();
  const position = index < 2 ? 'header' : index > paragraphsLength - 3 ? 'footer' : 'body';
  let newCurrentSection = currentSection;
  let sectionDetected = false;

  for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
    if (keywords.some(keyword => textLower.includes(keyword))) {
      newCurrentSection = sectionKey;
      styles[`section_${sectionKey}`] = { ...style, position, text };
      sections.push({
        name: sectionKey,
        position,
        title_style: {
          ...style,
          case: sectionKey === 'Compétences' ? 'mixed' : style.case,
          color: sectionKey === 'Compétences' ? '#142D5A' : style.color,
          font: sectionKey === 'Compétences' ? 'Segoe UI Symbol' : style.font,
          size: sectionKey === 'Compétences' ? '14pt' : style.size,
        },
        spacing: { top: style.spacingBefore || '10mm', bottom: style.spacingAfter || '5mm' },
        paragraph: { alignment: style.alignment },
      });
      sectionDetected = true;
      break;
    }
  }

  if (!sectionDetected && newCurrentSection) {
    if (newCurrentSection === 'Compétences') {
      const textParts = text.split(/[\t:]/).map(t => t.trim());
      if (textParts[0].match(/[A-Z][a-z]+\/[A-Z][a-z]+/) || skillSubcategories.some(sc => textLower.includes(sc.toLowerCase()))) {
        styles.skill_subcategories.push({
          name: textParts[0],
          style: { ...style, bold: false, color: '#329696', font: 'Segoe UI Symbol', size: '11pt' },
        });
        skillSubcategories.push(textParts[0]);
      } else if (textParts.length > 1 || style.bullet) {
        styles.skills_item = { ...style, bold: true, color: '#329696', font: 'Segoe UI Symbol', size: '11pt' };
      }
    } else if (newCurrentSection === 'Expérience') {
      if (text.match(/^\d{2}\/\d{4}\s*-\s*\d{2}\/\d{4}\s*.*@.*/)) {
        styles.mission_title = { ...style, text };
      } else if (textLower.includes('contexte') || textLower.includes('objectif')) {
        styles.mission_context = { ...style, text };
      } else if (textLower.includes('mission') || textLower.includes('tâche')) {
        styles.mission_achievements = { ...style, text, bullet: style.bullet };
      } else if (textLower.includes('environnement') || textLower.includes('technologie')) {
        styles.mission_environment = { ...style, text };
      } else if (text.match(/lieu|ville|city/i)) {
        styles.mission_location = { ...style, text };
      }
    } else if (newCurrentSection === 'Formations & Certifications') {
      if (text.match(/^\d{4}\s*[A-Z][a-z]+|^[A-Z][a-z]+\s*@\s*[A-Z]/i)) {
        styles.education_degree = { ...style, text };
      } else if (text.match(/lieu|ville|city|organisme|université|école/i)) {
        styles.education_details = { ...style, text };
      }
    }
  }

  return newCurrentSection;
}

async function analyzeDocxTemplate(arrayBuffer: ArrayBuffer, templateId: string, supabase: any) {
  console.log('Starting DOCX template analysis for templateId:', templateId);

  const { value: html, messages } = await convert({ arrayBuffer });
  if (messages.length > 0) {
    console.warn('Mammoth conversion warnings:', messages);
  }
  console.log('Extracted HTML from template (first 500 chars):', html.substring(0, 500));

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const paragraphs = doc.querySelectorAll('p');
  console.log('Paragraphs found:', paragraphs.length);

  const allColors = new Set<string>();
  const styles: any = { skill_subcategories: [], mission_subcategories: {}, education_subcategories: {} };
  const sections: Section[] = [];
  const visualElements: any = {};
  let currentSection: string | null = null;
  const skillSubcategories: string[] = [];

  paragraphs.forEach((p: any, index: number) => {
    const text = p.textContent.trim();
    if (!text || text.length < 2) return;

    const style = extractStyle(p, text);
    if (style.color && style.color !== '#000000') allColors.add(style.color);

    const position = index < 2 ? 'header' : index > paragraphs.length - 3 ? 'footer' : 'body';
    extractVisualElements(p, text, style, position, visualElements, styles);

    currentSection = extractSectionsAndSubcategories(
      p,
      text,
      style,
      index,
      paragraphs.length,
      currentSection,
      styles,
      sections,
      skillSubcategories
    );
  });

  const structureData = {
    colors: {
      primary: '#142D5A',
      text: '#000000',
      secondary: '#329696',
    },
    fonts: {
      title_font: 'Segoe UI Symbol',
      body_font: 'Segoe UI Symbol',
      title_size: '14pt',
      body_size: '11pt',
      title_weight: 'bold',
      line_height: '1.15',
    },
    spacing: {
      section_spacing: '12pt',
      element_spacing: '6pt',
      padding: '10mm',
      line_spacing: '1.15',
    },
    layout: {
      margins: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      orientation: 'portrait',
      size: 'A4',
      columns: 1,
    },
    sections,
    visual_elements: visualElements,
    element_styles: styles,
  };

  console.log('Generated structureData:', JSON.stringify(structureData, null, 2));

  const { error: updateError } = await supabase
    .from('cv_templates')
    .update({ structure_data: structureData })
    .eq('id', templateId);

  if (updateError) {
    console.error('Failed to update cv_templates:', updateError);
    throw new Error(`Failed to update template: ${updateError.message}`);
  }

  console.log('Template structure data updated successfully');
  return structureData;
}
