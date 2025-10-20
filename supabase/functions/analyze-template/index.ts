import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sectionKeywords = {
  'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
  'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
  'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
};

interface RunStyle {
  font?: string;
  size?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  underlineColor?: string;
  highlight?: string;
}

interface ParagraphStyle {
  alignment?: string;
  spacingBefore?: string;
  spacingAfter?: string;
  lineSpacing?: string;
  indentLeft?: string;
  indentRight?: string;
  indentFirstLine?: string;
  backgroundColor?: string;
  borderTop?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
  borderRight?: boolean;
  isBullet?: boolean;
  bulletChar?: string;
  isNumbered?: boolean;
}

interface LayoutInfo {
  margins?: {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
  };
  orientation?: string;
  pageWidth?: string;
  pageHeight?: string;
  columns?: number;
}

function extractRunStyle(runContent: string): RunStyle {
  const style: RunStyle = {};
  
  const fontMatch = runContent.match(/<w:rFonts[^>]+w:ascii="([^"]+)"/);
  if (fontMatch) style.font = fontMatch[1];
  
  const sizeMatch = runContent.match(/<w:sz[^>]+w:val="(\d+)"/);
  if (sizeMatch) style.size = `${parseInt(sizeMatch[1]) / 2}pt`;
  
  const colorMatch = runContent.match(/<w:color[^>]+w:val="([^"]+)"/);
  if (colorMatch && colorMatch[1] !== 'auto') style.color = `#${colorMatch[1]}`;
  
  style.bold = /<w:b[\s\/>]/.test(runContent) && !/<w:b\s+w:val="0"/.test(runContent);
  style.italic = /<w:i[\s\/>]/.test(runContent) && !/<w:i\s+w:val="0"/.test(runContent);
  
  const underlineMatch = runContent.match(/<w:u\s+w:val="([^"]+)"/);
  if (underlineMatch && underlineMatch[1] !== 'none') {
    style.underline = true;
    const underlineColorMatch = runContent.match(/<w:u[^>]+w:color="([^"]+)"/);
    if (underlineColorMatch) style.underlineColor = `#${underlineColorMatch[1]}`;
  }
  
  const highlightMatch = runContent.match(/<w:highlight\s+w:val="([^"]+)"/);
  if (highlightMatch) style.highlight = highlightMatch[1];
  
  return style;
}

function extractParagraphStyle(paraContent: string): ParagraphStyle {
  const style: ParagraphStyle = {};
  
  const alignMatch = paraContent.match(/<w:jc[^>]+w:val="([^"]+)"/);
  if (alignMatch) style.alignment = alignMatch[1];
  
  const spacingMatch = paraContent.match(/<w:spacing([^>]+)>/);
  if (spacingMatch) {
    const beforeMatch = spacingMatch[1].match(/w:before="(\d+)"/);
    if (beforeMatch) style.spacingBefore = `${parseInt(beforeMatch[1]) / 20}pt`;
    
    const afterMatch = spacingMatch[1].match(/w:after="(\d+)"/);
    if (afterMatch) style.spacingAfter = `${parseInt(afterMatch[1]) / 20}pt`;
    
    const lineMatch = spacingMatch[1].match(/w:line="(\d+)"/);
    if (lineMatch) style.lineSpacing = `${parseInt(lineMatch[1]) / 240}`;
  }
  
  const indMatch = paraContent.match(/<w:ind([^>]+)>/);
  if (indMatch) {
    const leftMatch = indMatch[1].match(/w:left="(\d+)"/);
    if (leftMatch) style.indentLeft = `${parseInt(leftMatch[1]) / 20}pt`;
    
    const rightMatch = indMatch[1].match(/w:right="(\d+)"/);
    if (rightMatch) style.indentRight = `${parseInt(rightMatch[1]) / 20}pt`;
    
    const firstLineMatch = indMatch[1].match(/w:firstLine="(\d+)"/);
    if (firstLineMatch) style.indentFirstLine = `${parseInt(firstLineMatch[1]) / 20}pt`;
  }
  
  const shdMatch = paraContent.match(/<w:shd[^>]+w:fill="([^"]+)"/);
  if (shdMatch && shdMatch[1] !== 'auto') style.backgroundColor = `#${shdMatch[1]}`;
  
  const pBdrMatch = paraContent.match(/<w:pBdr>(.*?)<\/w:pBdr>/s);
  if (pBdrMatch) {
    style.borderTop = /<w:top/.test(pBdrMatch[1]);
    style.borderBottom = /<w:bottom/.test(pBdrMatch[1]);
    style.borderLeft = /<w:left/.test(pBdrMatch[1]);
    style.borderRight = /<w:right/.test(pBdrMatch[1]);
  }
  
  const numPrMatch = paraContent.match(/<w:numPr>/);
  if (numPrMatch) {
    const ilvlMatch = paraContent.match(/<w:ilvl\s+w:val="(\d+)"/);
    const numIdMatch = paraContent.match(/<w:numId\s+w:val="(\d+)"/);
    
    if (numIdMatch) {
      style.isBullet = true;
      style.isNumbered = parseInt(numIdMatch[1]) > 0;
    }
  }
  
  return style;
}

function extractLayout(documentXml: string): LayoutInfo {
  const layout: LayoutInfo = { margins: {} };
  
  const sectPrMatch = documentXml.match(/<w:sectPr>(.*?)<\/w:sectPr>/s);
  if (sectPrMatch) {
    const pgMarMatch = sectPrMatch[1].match(/<w:pgMar([^>]+)>/);
    if (pgMarMatch) {
      const topMatch = pgMarMatch[1].match(/w:top="(\d+)"/);
      if (topMatch) layout.margins!.top = `${parseInt(topMatch[1]) / 1440}in`;
      
      const bottomMatch = pgMarMatch[1].match(/w:bottom="(\d+)"/);
      if (bottomMatch) layout.margins!.bottom = `${parseInt(bottomMatch[1]) / 1440}in`;
      
      const leftMatch = pgMarMatch[1].match(/w:left="(\d+)"/);
      if (leftMatch) layout.margins!.left = `${parseInt(leftMatch[1]) / 1440}in`;
      
      const rightMatch = pgMarMatch[1].match(/w:right="(\d+)"/);
      if (rightMatch) layout.margins!.right = `${parseInt(rightMatch[1]) / 1440}in`;
    }
    
    const pgSzMatch = sectPrMatch[1].match(/<w:pgSz([^>]+)>/);
    if (pgSzMatch) {
      const widthMatch = pgSzMatch[1].match(/w:w="(\d+)"/);
      if (widthMatch) layout.pageWidth = `${parseInt(widthMatch[1]) / 1440}in`;
      
      const heightMatch = pgSzMatch[1].match(/w:h="(\d+)"/);
      if (heightMatch) layout.pageHeight = `${parseInt(heightMatch[1]) / 1440}in`;
      
      const orientMatch = pgSzMatch[1].match(/w:orient="([^"]+)"/);
      if (orientMatch) layout.orientation = orientMatch[1];
    }
    
    const colsMatch = sectPrMatch[1].match(/<w:cols\s+w:num="(\d+)"/);
    if (colsMatch) layout.columns = parseInt(colsMatch[1]);
  }
  
  return layout;
}

function extractCommercialContact(headerXml: string | undefined, documentXml: string): any {
  if (!headerXml) return null;
  
  const emailMatch = documentXml.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const phoneMatch = documentXml.match(/(\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9})/);
  const nameMatch = documentXml.match(/([A-ZÉÈÊËÀÂÄÔÖÛÜÇ][a-zéèêëàâäôöûüç]+(?:\s+[A-ZÉÈÊËÀÂÄÔÖÛÜÇ][a-zéèêëàâäôöûüç]+)+)/);
  
  const contactText = headerXml.match(/<w:t[^>]*>([^<]*(?:commercial|professionnel)[^<]*)<\/w:t>/i);
  
  return {
    email: emailMatch ? emailMatch[1] : null,
    phone: phoneMatch ? phoneMatch[1] : null,
    first_name: nameMatch ? nameMatch[1].split(/\s+/)[0] : null,
    last_name: nameMatch ? nameMatch[1].split(/\s+/).slice(1).join(' ') : null,
    text: contactText ? contactText[1] : 'Contact Commercial',
    position: 'header'
  };
}

async function analyzeDocxTemplate(zip: any, templateId: string, supabase: any) {
  const documentXml = await zip.file('word/document.xml')?.async('text');
  const headerXml = await zip.file('word/header1.xml')?.async('text');
  const footerXml = await zip.file('word/footer1.xml')?.async('text');
  const stylesXml = await zip.file('word/styles.xml')?.async('text');

  if (!documentXml) throw new Error('document.xml not found');

  const paragraphs = Array.from(documentXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs));
  const allColors = new Set<string>();
  const allFonts = new Set<string>();
  const styles: any = {};
  const sections: any[] = [];
  const visualElements: any = {};
  let currentSection: string | null = null;
  
  const layout = extractLayout(documentXml);
  const commercialContact = extractCommercialContact(headerXml, documentXml);

  for (let i = 0; i < paragraphs.length; i++) {
    const match = paragraphs[i] as RegExpMatchArray;
    const paraContent = match[1];
    
    const textMatches = Array.from(paraContent.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g));
    const text = textMatches.map((m: RegExpMatchArray) => m[1]).join('').trim();
    
    if (!text || text.length < 2) continue;
    
    const runs = Array.from(paraContent.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs));
    if (runs.length === 0) continue;
    
    const firstRun = runs[0] as RegExpMatchArray;
    const runStyle = extractRunStyle(firstRun[1]);
    const paragraphStyle = extractParagraphStyle(paraContent);
    
    if (runStyle.color && runStyle.color !== '#000000') allColors.add(runStyle.color);
    if (runStyle.font) allFonts.add(runStyle.font);
    
    const textLower = text.toLowerCase();
    const position = headerXml?.includes(text) ? 'header' : 
                     footerXml?.includes(text) ? 'footer' : 'body';
    
    let sectionDetected = false;
    for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionKey;
        styles[`section_${sectionKey}`] = { 
          ...runStyle, 
          paragraph: paragraphStyle, 
          position, 
          text 
        };
        sections.push({
          name: text,
          position,
          title_style: { 
            ...runStyle, 
            case: text === text.toUpperCase() ? 'uppercase' : 
                  text === text.toLowerCase() ? 'lowercase' : 'mixed' 
          },
          spacing: { 
            top: paragraphStyle.spacingBefore || "10mm", 
            bottom: paragraphStyle.spacingAfter || "5mm" 
          },
          paragraph: paragraphStyle
        });
        sectionDetected = true;
        break;
      }
    }
    
    if (currentSection === 'Compétences' && !sectionDetected) {
      const subcategories = ['langage', 'bdd', 'os', 'outil', 'méthodologie'];
      if (subcategories.some(sc => textLower.includes(sc))) {
        if (!styles.skill_subcategories) styles.skill_subcategories = [];
        styles.skill_subcategories.push({ 
          name: text, 
          style: { ...runStyle, paragraph: paragraphStyle } 
        });
      }
    }
    
    if (paraContent.includes('<w:drawing') || paraContent.includes('<w:pict')) {
      const extentMatch = paraContent.match(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/);
      visualElements.logo = {
        position: position,
        alignment: paragraphStyle.alignment || 'left',
        width_emu: extentMatch ? parseInt(extentMatch[1]) : 1000000,
        height_emu: extentMatch ? parseInt(extentMatch[2]) : 500000
      };
    }
  }

  const structureData = {
    colors: {
      primary: Array.from(allColors)[0] || '#0000FF',
      text: '#000000',
      secondary: Array.from(allColors)[1] || Array.from(allColors)[0] || '#0000FF'
    },
    fonts: {
      title_font: Array.from(allFonts)[0] || 'Arial',
      body_font: Array.from(allFonts)[0] || 'Arial',
      title_size: sections[0]?.title_style?.size || '14pt',
      body_size: '11pt',
      title_weight: 'bold',
      line_height: '1.15'
    },
    spacing: {
      section_spacing: sections[0]?.spacing?.bottom || '12pt',
      element_spacing: '6pt',
      padding: '10mm',
      line_spacing: '1.15'
    },
    layout,
    sections,
    visual_elements: visualElements,
    element_styles: {
      ...styles,
      commercial_contact: commercialContact
    }
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
      .select('file_path')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found');
    }

    const { data: templateFileData, error: fileError } = await supabase
      .storage
      .from('cv-templates')
      .download(template.file_path);

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
