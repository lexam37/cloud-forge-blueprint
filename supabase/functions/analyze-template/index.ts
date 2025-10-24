import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DetailedStyle {
  font: string;
  size: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: { type: string; color: string } | null;
  strike: boolean;
  case: 'uppercase' | 'lowercase' | 'mixed' | 'capitalize';
  alignment: 'left' | 'center' | 'right' | 'justify';
  spacingBefore: string;
  spacingAfter: string;
  lineHeight: string;
  indent: string;
  firstLineIndent: string;
  bullet: boolean;
  bulletStyle: string | null;
  border: {
    top: string | null;
    right: string | null;
    bottom: string | null;
    left: string | null;
    color: string | null;
  };
  backgroundColor: string | null;
  position: 'header' | 'body' | 'footer';
}

const requestSchema = z.object({
  templateId: z.string().uuid({ message: 'templateId must be a valid UUID' })
});

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { templateId } = requestSchema.parse(await req.json());
    console.log('[analyze-template] Processing templateId:', templateId);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) throw new Error('Missing environment variables');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) throw new Error('User not authenticated');

    console.log('[analyze-template] Fetching template for user:', user.id);
    
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('file_path')
      .eq('id', templateId)
      .eq('user_id', user.id)
      .single();

    if (templateError || !template) {
      throw new Error(`Template not found: ${templateError?.message}`);
    }

    console.log('[analyze-template] Downloading file:', template.file_path);

    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('cv-templates')
      .download(template.file_path);

    if (fileError || !fileData) {
      throw new Error(`Failed to download file: ${fileError?.message}`);
    }

    console.log('[analyze-template] Starting enhanced XML analysis...');
    const structureData = await analyzeTemplateStructure(fileData, templateId, supabase, user.id);
    console.log('[analyze-template] Analysis complete');

    await supabase.from('processing_logs').insert({
      cv_document_id: null,
      step: 'template_analysis',
      message: 'Template analyzed successfully',
      user_id: user.id
    });

    return new Response(
      JSON.stringify({ 
        success: true, 
        templateId, 
        structureData, 
        message: 'Template analyzed successfully' 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (error) {
    console.error('[analyze-template] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

/**
 * Parse les styles définis dans styles.xml
 */
function parseStylesXml(stylesXml: string): Map<string, any> {
  const stylesMap = new Map<string, any>();
  
  const styleRegex = /<w:style[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let styleMatch;
  
  while ((styleMatch = styleRegex.exec(stylesXml)) !== null) {
    const styleId = styleMatch[1];
    const styleContent = styleMatch[2];
    
    // Extraire les propriétés de run (rPr)
    const rPrMatch = styleContent.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[1] : '';
    
    // Extraire les propriétés de paragraphe (pPr)
    const pPrMatch = styleContent.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const pPr = pPrMatch ? pPrMatch[1] : '';
    
    // Parser les polices
    const fontMatch = rPr.match(/<w:rFonts[^>]*(?:w:ascii="([^"]+)"|w:hAnsi="([^"]+)"|w:cs="([^"]+)")[^>]*>/);
    const font = fontMatch ? (fontMatch[1] || fontMatch[2] || fontMatch[3]) : null;
    
    // Parser la taille
    const szMatch = rPr.match(/<w:sz w:val="(\d+)"/);
    const size = szMatch ? parseInt(szMatch[1]) / 2 : null;
    
    // Parser la couleur
    const colorMatch = rPr.match(/<w:color w:val="([^"]+)"/);
    const color = colorMatch ? colorMatch[1] : null;
    
    // Parser gras/italique
    const bold = /<w:b\b/.test(rPr);
    const italic = /<w:i\b/.test(rPr);
    
    stylesMap.set(styleId, {
      font,
      size,
      color,
      bold,
      italic,
      rPr,
      pPr
    });
  }
  
  console.log(`[parseStylesXml] Parsed ${stylesMap.size} style definitions`);
  return stylesMap;
}

/**
 * Parse le XML d'un fichier DOCX avec support des styles définis
 */
async function analyzeTemplateStructure(fileData: Blob, templateId: string, supabase: any, userId: string) {
  console.log('[analyzeTemplateStructure] Extracting DOCX XML...');
  
  const arrayBuffer = await fileData.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  const documentXml = await zip.file('word/document.xml')?.async('text');
  const stylesXml = await zip.file('word/styles.xml')?.async('text');
  
  if (!documentXml) throw new Error('Could not extract document.xml from DOCX');
  
  // Parser les styles définis
  const stylesMap = stylesXml ? parseStylesXml(stylesXml) : new Map();
  
  console.log('[analyzeTemplateStructure] Parsing document structure...');
  
  const extractedContent: any[] = [];
  
  // Regex pour extraire les paragraphes avec leurs propriétés
  const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch;
  let index = 0;
  
  while ((pMatch = paragraphRegex.exec(documentXml)) !== null) {
    const paragraphContent = pMatch[1];
    
    // Extraire le texte
    const textRegex = /<w:t[^>]*>(.*?)<\/w:t>/g;
    let textMatch;
    let text = '';
    while ((textMatch = textRegex.exec(paragraphContent)) !== null) {
      text += textMatch[1];
    }
    
    if (!text || text.trim().length < 2) continue;
    
    // Extraire les propriétés de paragraphe
    const pPrMatch = paragraphContent.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const pPr = pPrMatch ? pPrMatch[1] : '';
    
    // Chercher le style appliqué
    const styleIdMatch = pPr.match(/<w:pStyle w:val="([^"]+)"/);
    const styleId = styleIdMatch ? styleIdMatch[1] : null;
    const definedStyle = styleId ? stylesMap.get(styleId) : null;
    
    // Extraire les propriétés de run (combiner style défini + override local)
    const runs = paragraphContent.match(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g);
    let firstRunRPr = '';
    if (runs && runs.length > 0) {
      const firstRun = runs[0];
      const rPrMatch = firstRun.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
      firstRunRPr = rPrMatch ? rPrMatch[1] : '';
    }
    
    // Combiner style défini + override
    const combinedRPr = (definedStyle?.rPr || '') + firstRunRPr;
    
    // Parser les styles de caractère
    const isBold = /<w:b\b/.test(combinedRPr) || definedStyle?.bold || false;
    const isItalic = /<w:i\b/.test(combinedRPr) || definedStyle?.italic || false;
    const isUnderline = /<w:u\b/.test(combinedRPr);
    const isStrike = /<w:strike\b/.test(combinedRPr);
    
    // Taille de police (local > defined > default)
    let fontSize = '11pt';
    const localSzMatch = combinedRPr.match(/<w:sz w:val="(\d+)"/);
    if (localSzMatch) {
      fontSize = `${parseInt(localSzMatch[1]) / 2}pt`;
    } else if (definedStyle?.size) {
      fontSize = `${definedStyle.size}pt`;
    }
    
    // Police (local > defined > default)
    let fontFamily = 'Calibri';
    const localFontMatch = combinedRPr.match(/<w:rFonts[^>]*(?:w:ascii="([^"]+)"|w:hAnsi="([^"]+)"|w:cs="([^"]+)")[^>]*>/);
    if (localFontMatch) {
      fontFamily = localFontMatch[1] || localFontMatch[2] || localFontMatch[3] || 'Calibri';
    } else if (definedStyle?.font) {
      fontFamily = definedStyle.font;
    }
    
    // Couleur (local > defined > default)
    let color = '#000000';
    const localColorMatch = combinedRPr.match(/<w:color w:val="([^"]+)"/);
    if (localColorMatch) {
      const colorVal = localColorMatch[1];
      color = colorVal.toLowerCase() === 'auto' ? '#000000' : `#${colorVal}`;
    } else if (definedStyle?.color && definedStyle.color !== 'auto') {
      color = `#${definedStyle.color}`;
    }
    
    // Log pour debug des 5 premiers éléments
    if (index < 5) {
      console.log(`[analyzeTemplateStructure] Element ${index}: "${text.substring(0, 50)}" | Font: ${fontFamily} | Size: ${fontSize} | Color: ${color} | Bold: ${isBold}`);
    }
    
    // Soulignement
    const underlineTypeMatch = combinedRPr.match(/<w:u w:val="([^"]+)"/);
    const underline = isUnderline && underlineTypeMatch ? {
      type: underlineTypeMatch[1],
      color: color
    } : null;
    
    // Casse du texte
    let textCase: 'uppercase' | 'lowercase' | 'mixed' | 'capitalize' = 'mixed';
    const capsMatch = combinedRPr.match(/<w:caps\b/);
    if (capsMatch) textCase = 'uppercase';
    else if (text === text.toUpperCase() && text !== text.toLowerCase()) textCase = 'uppercase';
    else if (text === text.toLowerCase()) textCase = 'lowercase';
    else if (text.match(/^[A-ZÀ-Ý][a-zà-ÿ]/)) textCase = 'capitalize';
    
    // Alignement de paragraphe
    const combinedPPr = (definedStyle?.pPr || '') + pPr;
    const alignMatch = combinedPPr.match(/<w:jc w:val="([^"]+)"/);
    let alignment: 'left' | 'center' | 'right' | 'justify' = 'left';
    if (alignMatch) {
      const alignVal = alignMatch[1];
      if (alignVal === 'center') alignment = 'center';
      else if (alignVal === 'right') alignment = 'right';
      else if (alignVal === 'both') alignment = 'justify';
    }
    
    // Espacements (en twips, 1 twip = 1/20 pt)
    const spacingMatch = combinedPPr.match(/<w:spacing[^>]*w:before="(\d+)"[^>]*w:after="(\d+)"/);
    const spacingBefore = spacingMatch ? `${parseInt(spacingMatch[1]) / 20}pt` : '0pt';
    const spacingAfter = spacingMatch ? `${parseInt(spacingMatch[2]) / 20}pt` : '0pt';
    
    // Interligne
    const lineMatch = combinedPPr.match(/<w:spacing[^>]*w:line="(\d+)"/);
    const lineHeight = lineMatch ? `${parseInt(lineMatch[1]) / 240}` : '1.15';
    
    // Retraits (en twips)
    const indMatch = combinedPPr.match(/<w:ind[^>]*w:left="(\d+)"/);
    const indent = indMatch ? `${parseInt(indMatch[1]) / 20}pt` : '0pt';
    
    const firstLineIndMatch = combinedPPr.match(/<w:ind[^>]*w:firstLine="(\d+)"/);
    const firstLineIndent = firstLineIndMatch ? `${parseInt(firstLineIndMatch[1]) / 20}pt` : '0pt';
    
    // Puces et numérotation
    const numPrMatch = combinedPPr.match(/<w:numPr>/);
    const isList = numPrMatch !== null;
    let bulletStyle: string | null = null;
    if (isList) {
      const numIdMatch = combinedPPr.match(/<w:numId w:val="(\d+)"/);
      bulletStyle = numIdMatch ? 'bullet' : 'custom';
    }
    
    // Bordures
    const hasBorder = /<w:pBdr>/.test(combinedPPr);
    const borderColor = hasBorder ? color : null;
    
    // Fond/ombrage
    const shadingMatch = combinedPPr.match(/<w:shd[^>]*w:fill="([^"]+)"/);
    const backgroundColor = shadingMatch ? `#${shadingMatch[1]}` : null;
    
    extractedContent.push({
      text: text.trim(),
      index,
      style: {
        font: fontFamily,
        size: fontSize,
        color: color,
        bold: isBold,
        italic: isItalic,
        underline: underline,
        strike: isStrike,
        case: textCase,
        alignment: alignment,
        spacingBefore: spacingBefore,
        spacingAfter: spacingAfter,
        lineHeight: lineHeight,
        indent: indent,
        firstLineIndent: firstLineIndent,
        bullet: isList,
        bulletStyle: bulletStyle,
        border: {
          top: hasBorder ? '1pt solid' : null,
          right: hasBorder ? '1pt solid' : null,
          bottom: hasBorder ? '1pt solid' : null,
          left: hasBorder ? '1pt solid' : null,
          color: borderColor
        },
        backgroundColor: backgroundColor,
        position: 'body' as const
      }
    });
    
    index++;
  }

  console.log('[analyzeTemplateStructure] Found', extractedContent.length, 'elements');

  // Détection de l'en-tête
  let headerEndIndex = 0;
  const sectionStarters = ['compétence', 'competence', 'experience', 'expérience', 'formation', 'profil', 'skill'];
  
  for (let i = 0; i < Math.min(15, extractedContent.length); i++) {
    const text = extractedContent[i].text.toLowerCase().trim();
    if (sectionStarters.some(starter => text.includes(starter)) && text.length < 60) {
      headerEndIndex = i;
      console.log(`[analyzeTemplateStructure] Header ends at index ${i}, detected: "${extractedContent[i].text}"`);
      break;
    }
  }
  
  const headerElements = extractedContent.slice(0, headerEndIndex).map(el => ({
    ...el.style,
    position: 'header' as const
  }));

  console.log(`[analyzeTemplateStructure] Header extracted: ${headerElements.length} elements`);

  // Détection des sections principales
  console.log('[analyzeTemplateStructure] Detecting main sections...');
  
  const sections: any[] = [];
  const sectionKeywords: Record<string, string[]> = {
    'Compétences': ['compétence', 'competence', 'skill', 'savoir', 'technologie', 'expertise', 'technical', 'technique', 'connaissances', 'aptitudes'],
    'Expérience': ['expérience', 'experience', 'parcours', 'mission', 'professionnel', 'carrière', 'emploi'],
    'Formations & Certifications': ['formation', 'certification', 'diplôme', 'education', 'étude', 'académique', 'universitaire']
  };
  
  console.log(`[analyzeTemplateStructure] Scanning ${extractedContent.length - headerEndIndex} elements for sections...`);
  
  for (let i = headerEndIndex; i < extractedContent.length; i++) {
    const text = extractedContent[i].text.toLowerCase().trim();
    const origText = extractedContent[i].text.trim();
    const isBold = extractedContent[i].style.bold;
    
    // Log des candidats potentiels (textes courts et/ou en gras)
    if ((origText.length < 80 && isBold) || origText.length < 40) {
      console.log(`[analyzeTemplateStructure] Candidate at ${i}: "${origText}" (bold: ${isBold}, len: ${origText.length})`);
    }
    
    // Section = texte court (< 80 caractères) avec un mot-clé, de préférence en gras
    if (origText.length < 80) {
      for (const [sectionName, keywords] of Object.entries(sectionKeywords)) {
        const hasKeyword = keywords.some(kw => text.includes(kw));
        
        if (hasKeyword && !sections.find(s => s.name === sectionName)) {
          sections.push({
            name: sectionName,
            titleStyle: extractedContent[i].style,
            startIndex: i,
            endIndex: i + 100
          });
          console.log(`[analyzeTemplateStructure] ✅ Section "${sectionName}" detected at index ${i}: "${origText}" (bold: ${isBold})`);
          break;
        }
      }
    }
  }
  
  console.log(`[analyzeTemplateStructure] Total sections detected: ${sections.length}`);
  
  // Ajuster les endIndex
  sections.forEach((section, idx) => {
    if (idx < sections.length - 1) {
      section.endIndex = sections[idx + 1].startIndex;
    } else {
      section.endIndex = extractedContent.length;
    }
  });

  // Analyse des styles par section
  const skillCategoryStyles: DetailedStyle[] = [];
  const skillItemStyles: DetailedStyle[] = [];
  const missionTitleStyles: DetailedStyle[] = [];
  const missionContextStyles: DetailedStyle[] = [];
  const missionAchievementStyles: DetailedStyle[] = [];
  const missionEnvironmentStyles: DetailedStyle[] = [];
  const educationItemStyles: DetailedStyle[] = [];
  
  const competencesSection = sections.find(s => s.name === 'Compétences');
  if (competencesSection) {
    console.log(`[analyzeTemplateStructure] Analyzing Compétences section (${competencesSection.startIndex} to ${competencesSection.endIndex})`);
    for (let i = competencesSection.startIndex + 1; i < competencesSection.endIndex; i++) {
      const item = extractedContent[i];
      if (!item) continue;
      const text = item.text.trim();
      
      if ((text.includes(':') || item.style.bold) && text.length < 50 && !text.includes(',')) {
        skillCategoryStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Skill category: "${text.substring(0, 40)}"`);
      } else if (text.includes(',') || item.style.bullet) {
        skillItemStyles.push(item.style);
      }
    }
  } else {
    console.warn('[analyzeTemplateStructure] Compétences section NOT found');
  }
  
  const experienceSection = sections.find(s => s.name === 'Expérience');
  if (experienceSection) {
    console.log(`[analyzeTemplateStructure] Analyzing Expérience section (${experienceSection.startIndex} to ${experienceSection.endIndex})`);
    for (let i = experienceSection.startIndex + 1; i < experienceSection.endIndex; i++) {
      const item = extractedContent[i];
      if (!item) continue;
      const text = item.text.trim();
      const textLower = text.toLowerCase();
      
      if (/\d{2}\/\d{4}/.test(text) && (text.includes('@') || text.includes('-'))) {
        missionTitleStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Mission title: "${text.substring(0, 50)}"`);
      } else if (textLower.includes('contexte') || textLower.includes('description')) {
        missionContextStyles.push(item.style);
      } else if (textLower.includes('environnement') || textLower.includes('technologie')) {
        missionEnvironmentStyles.push(item.style);
      } else if (item.style.bullet) {
        missionAchievementStyles.push(item.style);
      }
    }
  } else {
    console.warn('[analyzeTemplateStructure] Expérience section NOT found');
  }
  
  const formationSection = sections.find(s => s.name === 'Formations & Certifications');
  if (formationSection) {
    for (let i = formationSection.startIndex + 1; i < Math.min(formationSection.endIndex, formationSection.startIndex + 20); i++) {
      const item = extractedContent[i];
      if (item && item.text.trim().length > 3) {
        educationItemStyles.push(item.style);
      }
    }
  }

  console.log('[analyzeTemplateStructure] Normalizing styles...');
  
  const getMostFrequent = (styles: DetailedStyle[]) => {
    if (styles.length === 0) return null;
    return styles[0];
  };

  // Construction de la structure finale
  const structure = {
    sections: sections.map(s => ({ name: s.name })),
    detailedStyles: {
      skills: {
        sectionTitle: getMostFrequent(sections.filter(s => s.name === 'Compétences').map(s => s.titleStyle)),
        category: getMostFrequent(skillCategoryStyles),
        items: getMostFrequent(skillItemStyles)
      },
      experience: {
        sectionTitle: getMostFrequent(sections.filter(s => s.name === 'Expérience').map(s => s.titleStyle)),
        missionTitle: getMostFrequent(missionTitleStyles),
        context: getMostFrequent(missionContextStyles),
        achievements: getMostFrequent(missionAchievementStyles),
        environment: getMostFrequent(missionEnvironmentStyles),
        missionDateFormat: 'MM/YYYY'
      },
      education: {
        sectionTitle: getMostFrequent(sections.filter(s => s.name === 'Formations & Certifications').map(s => s.titleStyle)),
        item: getMostFrequent(educationItemStyles)
      }
    },
    pageLayout: {
      orientation: 'portrait',
      margins: {
        top: '2.54cm',
        right: '2cm',
        bottom: '2.54cm',
        left: '2cm'
      }
    }
  };

  console.log('[analyzeTemplateStructure] Creating template with placeholders...');
  
  // Créer un template avec placeholders
  const modifiedTemplate = await createTemplateWithPlaceholders(zip, sections, extractedContent);
  
  // Sauvegarder le template modifié dans le storage
  const templateFileName = `template-with-placeholders-${templateId}-${Date.now()}.docx`;
  const templatePath = `${userId}/${templateFileName}`;
  
  const { error: uploadError } = await supabase.storage
    .from('cv-templates')
    .upload(templatePath, modifiedTemplate, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true
    });

  if (uploadError) {
    console.error('[analyzeTemplateStructure] Failed to upload template with placeholders:', uploadError);
  } else {
    console.log('[analyzeTemplateStructure] Template with placeholders uploaded:', templatePath);
    (structure as any).templateWithPlaceholdersPath = templatePath;
  }

  console.log('[analyzeTemplateStructure] Saving to database...');
  
  await supabase
    .from('cv_templates')
    .update({ structure_data: structure })
    .eq('id', templateId)
    .eq('user_id', userId);

  console.log('[analyzeTemplateStructure] Analysis complete, structure saved');
  
  return structure;
}

/**
 * Crée un template avec des placeholders docxtemplater en remplaçant le contenu exemple
 * Approche améliorée: trouve les paragraphes par index et remplace leur contenu
 */
async function createTemplateWithPlaceholders(
  zipContent: any,
  sections: Array<{ name: string; startIndex: number; endIndex: number; titleStyle: DetailedStyle }>,
  extractedContent: Array<{ text: string; style: DetailedStyle }>
): Promise<Uint8Array> {
  console.log('[createTemplateWithPlaceholders] Creating template with placeholders...');
  
  // Extraire le document.xml
  const documentXml = await zipContent.file('word/document.xml')?.async('string');
  if (!documentXml) {
    throw new Error('document.xml not found in template');
  }

  // Extraire tous les paragraphes
  const paragraphs = documentXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  console.log(`[createTemplateWithPlaceholders] Found ${paragraphs.length} paragraphs in template`);

  let modifiedXml = documentXml;
  let replacements = 0;

  // Trouver la section Compétences
  const competencesSection = sections.find(s => s.name === 'Compétences');
  if (competencesSection) {
    console.log(`[createTemplateWithPlaceholders] Processing Compétences section (${competencesSection.startIndex} to ${competencesSection.endIndex})`);
    
    // Trouver le premier paragraphe de contenu dans la section (après le titre)
    for (let i = competencesSection.startIndex + 1; i < competencesSection.endIndex && i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const textContent = paragraph.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
      if (textContent && textContent.length > 0) {
        // Remplacer uniquement le texte en conservant la structure XML
        const newParagraph = paragraph.replace(
          /<w:t[^>]*>.*?<\/w:t>/g,
          '<w:t>{#competences}{category}: {items}{/competences}</w:t>'
        );
        modifiedXml = modifiedXml.replace(paragraph, newParagraph);
        replacements++;
        console.log(`[createTemplateWithPlaceholders] Replaced Compétences content at paragraph ${i}`);
        break; // On remplace seulement le premier paragraphe
      }
    }
  }

  // Trouver la section Expérience
  const experienceSection = sections.find(s => s.name === 'Expérience');
  if (experienceSection) {
    console.log(`[createTemplateWithPlaceholders] Processing Expérience section (${experienceSection.startIndex} to ${experienceSection.endIndex})`);
    
    // Trouver et remplacer la première mission
    let missionFound = false;
    for (let i = experienceSection.startIndex + 1; i < experienceSection.endIndex && i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const textContent = paragraph.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
      
      if (textContent && textContent.length > 0) {
        const fullText = textContent.join('');
        
        // Détecter les dates (format MM/YYYY - MM/YYYY)
        if (/\d{2}\/\d{4}/.test(fullText) && !missionFound) {
          const newParagraph = paragraph.replace(
            /<w:t[^>]*>.*?<\/w:t>/g,
            '<w:t>{#missions}{period} {role} @ {client}{/missions}</w:t>'
          );
          modifiedXml = modifiedXml.replace(paragraph, newParagraph);
          missionFound = true;
          replacements++;
          console.log(`[createTemplateWithPlaceholders] Replaced Mission title at paragraph ${i}`);
        }
        // Détecter les contextes
        else if (/contexte\s*:/i.test(fullText)) {
          const newParagraph = paragraph.replace(
            /<w:t[^>]*>.*?<\/w:t>/g,
            '<w:t>Contexte: {context}</w:t>'
          );
          modifiedXml = modifiedXml.replace(paragraph, newParagraph);
          replacements++;
          console.log(`[createTemplateWithPlaceholders] Replaced Context at paragraph ${i}`);
        }
        // Détecter les achievements (puces)
        else if (/<w:numPr>/.test(paragraph)) {
          const newParagraph = paragraph.replace(
            /<w:t[^>]*>.*?<\/w:t>/g,
            '<w:t>{#achievements}{.}{/achievements}</w:t>'
          );
          modifiedXml = modifiedXml.replace(paragraph, newParagraph);
          replacements++;
          console.log(`[createTemplateWithPlaceholders] Replaced Achievement at paragraph ${i}`);
          break; // On remplace seulement la première puce
        }
        // Détecter l'environnement
        else if (/environnement\s*:/i.test(fullText)) {
          const newParagraph = paragraph.replace(
            /<w:t[^>]*>.*?<\/w:t>/g,
            '<w:t>Environnement: {environment}</w:t>'
          );
          modifiedXml = modifiedXml.replace(paragraph, newParagraph);
          replacements++;
          console.log(`[createTemplateWithPlaceholders] Replaced Environment at paragraph ${i}`);
        }
      }
    }
  }

  // Trouver la section Formations
  const formationSection = sections.find(s => s.name === 'Formations & Certifications');
  if (formationSection) {
    console.log(`[createTemplateWithPlaceholders] Processing Formations section (${formationSection.startIndex} to ${formationSection.endIndex})`);
    
    // Trouver la première formation (commence souvent par une année)
    for (let i = formationSection.startIndex + 1; i < formationSection.endIndex && i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const textContent = paragraph.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
      
      if (textContent && textContent.length > 0) {
        const fullText = textContent.join('');
        
        if (/^\d{4}/.test(fullText.trim())) {
          const newParagraph = paragraph.replace(
            /<w:t[^>]*>.*?<\/w:t>/g,
            '<w:t>{#formations}{year} {degree} - {institution}{/formations}</w:t>'
          );
          modifiedXml = modifiedXml.replace(paragraph, newParagraph);
          replacements++;
          console.log(`[createTemplateWithPlaceholders] Replaced Formation at paragraph ${i}`);
          break;
        }
      }
    }
  }

  // Remplacer le trigramme dans les premiers paragraphes (header)
  for (let i = 0; i < Math.min(10, paragraphs.length); i++) {
    const paragraph = paragraphs[i];
    const textContent = paragraph.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
    
    if (textContent) {
      const fullText = textContent.join('');
      
      // Chercher un trigramme (3 lettres majuscules)
      if (/^[A-Z]{3}$/.test(fullText.trim())) {
        const newParagraph = paragraph.replace(
          /<w:t[^>]*>[A-Z]{3}<\/w:t>/g,
          '<w:t>{trigram}</w:t>'
        );
        modifiedXml = modifiedXml.replace(paragraph, newParagraph);
        replacements++;
        console.log(`[createTemplateWithPlaceholders] Replaced Trigram at paragraph ${i}`);
        break;
      }
    }
  }

  // Remplacer le titre professionnel
  for (let i = 0; i < Math.min(15, paragraphs.length); i++) {
    const paragraph = paragraphs[i];
    const textContent = paragraph.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
    
    if (textContent) {
      const fullText = textContent.join('').toLowerCase();
      
      if (/(consultant|développeur|chef de projet|manager|ingénieur|architecte)/i.test(fullText)) {
        const newParagraph = paragraph.replace(
          /<w:t[^>]*>.*?<\/w:t>/g,
          '<w:t>{title}</w:t>'
        );
        modifiedXml = modifiedXml.replace(paragraph, newParagraph);
        replacements++;
        console.log(`[createTemplateWithPlaceholders] Replaced Title at paragraph ${i}`);
        break;
      }
    }
  }

  console.log(`[createTemplateWithPlaceholders] Total replacements made: ${replacements}`);

  if (replacements === 0) {
    console.warn('[createTemplateWithPlaceholders] WARNING: No placeholders were inserted!');
  }

  // Mettre à jour le document.xml dans le ZIP
  zipContent.file('word/document.xml', modifiedXml);

  // Générer le nouveau DOCX
  const generatedBuffer = await zipContent.generateAsync({ type: 'uint8array' });

  console.log('[createTemplateWithPlaceholders] Template with placeholders created successfully');
  
  return generatedBuffer;
}
