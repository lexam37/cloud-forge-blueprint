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
const missionSubcategories = ['titre', 'date', 'entreprise', 'lieu', 'contexte', 'objectif', 'missions', 'tâches', 'environnement', 'technologies'];
const educationSubcategories = ['diplôme', 'date', 'lieu', 'organisme'];

async function analyzeDocxTemplate(arrayBuffer: ArrayBuffer, templateId: string, supabase: any) {
  const { value: html, messages } = await convert({ 
    arrayBuffer,
    includeEmbeddedStyleMap: true,
    extractRawText: true,
    includeDefaultStyleMap: true
  });
  console.log('Extracted HTML from template:', html.substring(0, 500));
  console.log('Mammoth messages:', messages);

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allColors = new Set<string>();
  const styles: any = { skill_subcategories: [], mission_subcategories: {}, education_subcategories: {} };
  const sections: any[] = [];
  const visualElements: any = { header: {}, footer: {} };
  let currentSection: string | null = null;

  // Analyse des en-têtes et pieds de page
  const headerElements = doc.querySelectorAll('header p');
  const footerElements = doc.querySelectorAll('footer p');
  console.log('Header elements:', headerElements.length, 'Footer elements:', footerElements.length);

  // En-tête : logo et coordonnées commerciales
  headerElements.forEach((p: any) => {
    const text = p.textContent.trim();
    if (!text) return;

    const styleAttr = p.getAttribute('style') || '';
    const style = {
      font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Segoe UI Symbol',
      size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
      color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
      bold: styleAttr.includes('font-weight:bold'),
      italic: styleAttr.includes('font-style:italic'),
      underline: styleAttr.includes('text-decoration:underline') ? { type: 'single', color: styleAttr.match(/text-decoration-color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000' } : null,
      case: text.match(/^[A-Z][a-z]+/) ? 'mixed' : text === text.toUpperCase() ? 'uppercase' : 'lowercase',
      alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
      spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
      spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '6pt',
      lineHeight: styleAttr.match(/line-height:([^;]+)/)?.[1]?.trim() || '1.15',
      indent: styleAttr.match(/padding-left:([^;]+)/)?.[1]?.trim() || text.match(/\t/) ? '5mm' : '0pt'
    };

    if (text.match(/contact\s*(commercial|professionnel)/i)) {
      styles.commercial_contact = { ...style, position: 'header', text };
      visualElements.header.commercial_contact = { ...style, text };
    }
    if (text.match(/^[A-Z]{3}$/)) {
      styles.trigram = { ...style, position: 'header', text };
      visualElements.header.trigram = { ...style, text };
    }
    if (text.match(/architecte|ingénieur|consultant|expert|owner/i)) {
      styles.title = { ...style, position: 'header', text };
      visualElements.header.title = { ...style, text };
    }
  });

  // Logo dans l'en-tête ou le pied de page
  const headerImages = doc.querySelectorAll('header img');
  const footerImages = doc.querySelectorAll('footer img');
  if (headerImages.length > 0) {
    visualElements.header.logo = {
      present: true,
      alignment: headerImages[0].getAttribute('style')?.includes('text-align:center') ? 'center' : 'left',
      width_emu: 1000000,
      height_emu: 500000
    };
  }
  if (footerImages.length > 0) {
    visualElements.footer.logo = {
      present: true,
      alignment: footerImages[0].getAttribute('style')?.includes('text-align:center') ? 'center' : 'left',
      width_emu: 1000000,
      height_emu: 500000
    };
  }

  // Pied de page : texte
  footerElements.forEach((p: any) => {
    const text = p.textContent.trim();
    if (!text) return;

    const styleAttr = p.getAttribute('style') || '';
    const style = {
      font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Segoe UI Symbol',
      size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '10pt',
      color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
      bold: styleAttr.includes('font-weight:bold'),
      italic: styleAttr.includes('font-style:italic'),
      underline: styleAttr.includes('text-decoration:underline') ? { type: 'single', color: styleAttr.match(/text-decoration-color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000' } : null,
      alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
      spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
      spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '0pt',
      lineHeight: styleAttr.match(/line-height:([^;]+)/)?.[1]?.trim() || '1.15'
    };
    visualElements.footer.text = { ...style, text };
  });

  // Corps du document
  const paragraphs = doc.querySelectorAll('body p');
  console.log('Body paragraphs found:', paragraphs.length);

  paragraphs.forEach((p: any) => {
    const text = p.textContent.trim();
    if (!text || text.length < 2) return;

    const styleAttr = p.getAttribute('style') || '';
    const style: any = {
      font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Segoe UI Symbol',
      size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
      color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
      bold: styleAttr.includes('font-weight:bold'),
      italic: styleAttr.includes('font-style:italic'),
      underline: styleAttr.includes('text-decoration:underline') ? { type: 'single', color: styleAttr.match(/text-decoration-color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000' } : null,
      case: text.match(/^[A-Z][a-z]+/) ? 'mixed' : text === text.toUpperCase() ? 'uppercase' : 'lowercase',
      bullet: p.querySelector('li') || text.match(/^[•\-\*É°\u2022\u25CF]/) ? true : false,
      alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
      spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
      spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '6pt',
      lineHeight: styleAttr.match(/line-height:([^;]+)/)?.[1]?.trim() || '1.15',
      indent: styleAttr.match(/padding-left:([^;]+)/)?.[1]?.trim() || text.match(/\t/) ? '5mm' : '0pt'
    };

    if (style.color && style.color !== '#000000') allColors.add(style.color);

    const textLower = text.toLowerCase();

    // Sections
    let sectionDetected = false;
    for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionKey;
        styles[`section_${sectionKey}`] = { ...style, position: 'body', text };
        sections.push({
          name: sectionKey,
          position: 'body',
          title_style: {
            ...style,
            case: sectionKey === 'Compétences' ? 'mixed' : style.case,
            color: sectionKey === 'Compétences' ? '#142D5A' : style.color,
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

    // Sous-catégories
    if (currentSection === 'Compétences' && !sectionDetected) {
      const textParts = text.split(/[\t:]/).map(t => t.trim());
      if (skillSubcategories.some(sc => textLower.includes(sc.toLowerCase()))) {
        styles.skill_subcategories.push({
          name: textParts[0],
          style: { ...style, bold: false, color: '#329696', font: 'Segoe UI Symbol', size: '11pt' }
        });
      } else if (textParts.length > 1 || style.bullet) {
        styles.skills_item = {
          ...style,
          bold: true,
          color: '#329696',
          font: 'Segoe UI Symbol',
          size: '11pt'
        };
      }
    } else if (currentSection === 'Expérience' && !sectionDetected) {
      if (text.match(/^\d{2}\/\d{4}\s*-\s*\d{2}\/\d{4}|^[A-Z][a-z]+\s*@/i)) {
        styles.mission_title = { 
          ...style, 
          text, 
          color: '#142D5A', 
          font: 'Segoe UI Symbol', 
          size: '11pt', 
          spacingAfter: '6pt', 
          lineHeight: '1.15', 
          indent: '0mm' 
        };
      } else if (textLower.includes('contexte') || textLower.includes('objectif')) {
        styles.mission_context = { ...style, text };
      } else if (textLower.includes('mission') || textLower.includes('tâche')) {
        styles.mission_achievements = { ...style, text, bullet: style.bullet };
      } else if (textLower.includes('environnement') || textLower.includes('technologie')) {
        styles.mission_environment = { ...style, text };
      } else if (text.match(/lieu|ville|city/i)) {
        styles.mission_location = { ...style, text };
      }
    } else if (currentSection === 'Formations & Certifications' && !sectionDetected) {
      if (text.match(/^\d{4}\s*[A-Z][a-z]+|^[A-Z][a-z]+\s*@\s*[A-Z]/i)) {
        styles.education_degree = { ...style, text };
      } else if (text.match(/lieu|ville|city|organisme|université|école/i)) {
        styles.education_details = { ...style, text };
      }
    }
  });

  const structureData = {
    colors: {
      primary: '#142D5A',
      text: '#000000',
      secondary: '#329696'
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
      size: 'A4',
      columns: 1
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
