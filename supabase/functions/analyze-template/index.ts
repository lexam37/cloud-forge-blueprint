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

    console.log('[analyze-template] Starting XML-based analysis...');
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
 * Parse le XML d'un fichier DOCX pour extraire les styles réels
 */
async function analyzeTemplateStructure(fileData: Blob, templateId: string, supabase: any, userId: string) {
  console.log('[analyzeTemplateStructure] Extracting DOCX XML...');
  
  const arrayBuffer = await fileData.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  const documentXml = await zip.file('word/document.xml')?.async('text');
  
  if (!documentXml) throw new Error('Could not extract document.xml from DOCX');
  
  console.log('[analyzeTemplateStructure] Parsing XML structure...');
  
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
    
    // Extraire les propriétés de run (première occurrence pour le style principal)
    const rPrMatch = paragraphContent.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[1] : '';
    
    // Parser les styles de caractère
    const isBold = /<w:b\b/.test(rPr);
    const isItalic = /<w:i\b/.test(rPr);
    const isUnderline = /<w:u\b/.test(rPr);
    const isStrike = /<w:strike\b/.test(rPr);
    
    // Taille de police (en demi-points, donc diviser par 2)
    const szMatch = rPr.match(/<w:sz w:val="(\d+)"/);
    const fontSize = szMatch ? `${parseInt(szMatch[1]) / 2}pt` : '11pt';
    
    // Police
    const fontMatch = rPr.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/);
    const fontFamily = fontMatch ? fontMatch[1] : 'Calibri';
    
    // Couleur (format hexadécimal dans le XML)
    const colorMatch = rPr.match(/<w:color w:val="([^"]+)"/);
    let color = '#000000';
    if (colorMatch) {
      const colorVal = colorMatch[1];
      color = colorVal.toLowerCase() === 'auto' ? '#000000' : `#${colorVal}`;
    }
    
    // Soulignement
    const underlineTypeMatch = rPr.match(/<w:u w:val="([^"]+)"/);
    const underline = isUnderline && underlineTypeMatch ? {
      type: underlineTypeMatch[1],
      color: color
    } : null;
    
    // Casse du texte
    let textCase: 'uppercase' | 'lowercase' | 'mixed' | 'capitalize' = 'mixed';
    const capsMatch = rPr.match(/<w:caps\b/);
    const smallCapsMatch = rPr.match(/<w:smallCaps\b/);
    if (capsMatch) textCase = 'uppercase';
    else if (text === text.toUpperCase() && text !== text.toLowerCase()) textCase = 'uppercase';
    else if (text === text.toLowerCase()) textCase = 'lowercase';
    else if (text.match(/^[A-ZÀ-Ý][a-zà-ÿ]/)) textCase = 'capitalize';
    
    // Alignement de paragraphe
    const alignMatch = pPr.match(/<w:jc w:val="([^"]+)"/);
    let alignment: 'left' | 'center' | 'right' | 'justify' = 'left';
    if (alignMatch) {
      const alignVal = alignMatch[1];
      if (alignVal === 'center') alignment = 'center';
      else if (alignVal === 'right') alignment = 'right';
      else if (alignVal === 'both') alignment = 'justify';
    }
    
    // Espacements (en twips, 1 twip = 1/20 pt, donc diviser par 20)
    const spacingMatch = pPr.match(/<w:spacing[^>]*w:before="(\d+)"[^>]*w:after="(\d+)"/);
    const spacingBefore = spacingMatch ? `${parseInt(spacingMatch[1]) / 20}pt` : '0pt';
    const spacingAfter = spacingMatch ? `${parseInt(spacingMatch[2]) / 20}pt` : '0pt';
    
    // Interligne
    const lineMatch = pPr.match(/<w:spacing[^>]*w:line="(\d+)"/);
    const lineHeight = lineMatch ? `${parseInt(lineMatch[1]) / 240}` : '1.15';
    
    // Retraits (en twips)
    const indMatch = pPr.match(/<w:ind[^>]*w:left="(\d+)"/);
    const indent = indMatch ? `${parseInt(indMatch[1]) / 20}pt` : '0pt';
    
    const firstLineIndMatch = pPr.match(/<w:ind[^>]*w:firstLine="(\d+)"/);
    const firstLineIndent = firstLineIndMatch ? `${parseInt(firstLineIndMatch[1]) / 20}pt` : '0pt';
    
    // Puces et numérotation
    const numPrMatch = pPr.match(/<w:numPr>/);
    const isList = numPrMatch !== null;
    let bulletStyle: string | null = null;
    if (isList) {
      const numIdMatch = pPr.match(/<w:numId w:val="(\d+)"/);
      bulletStyle = numIdMatch ? 'bullet' : 'custom';
    }
    
    // Bordures (simplifiées)
    const hasBorder = /<w:pBdr>/.test(pPr);
    const borderColor = hasBorder ? color : null;
    
    // Fond/ombrage
    const shadingMatch = pPr.match(/<w:shd[^>]*w:fill="([^"]+)"/);
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
    // Détecter les titres de section (courts, souvent en gras)
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
    'Compétences': ['compétence', 'competence', 'skill', 'savoir', 'technologie'],
    'Expérience': ['expérience', 'experience', 'parcours', 'mission', 'professionnel'],
    'Formations & Certifications': ['formation', 'certification', 'diplôme', 'education', 'étude']
  };
  
  for (let i = headerEndIndex; i < extractedContent.length; i++) {
    const text = extractedContent[i].text.toLowerCase().trim();
    const origText = extractedContent[i].text.trim();
    
    // Vérifier si c'est un titre de section (court, souvent en gras ou taille différente)
    if (origText.length < 60 && extractedContent[i].style.bold) {
      for (const [sectionName, keywords] of Object.entries(sectionKeywords)) {
        // Vérifier si le texte contient un mot-clé ET n'est pas déjà détecté
        if (keywords.some(kw => text.includes(kw)) && !sections.find(s => s.name === sectionName)) {
          sections.push({
            name: sectionName,
            titleStyle: extractedContent[i].style,
            startIndex: i,
            endIndex: i + 100
          });
          console.log(`[analyzeTemplateStructure] Section "${sectionName}" detected at index ${i}: "${origText}"`);
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
      
      // Catégories : texte court avec ":" ou en gras
      if ((text.includes(':') || item.style.bold) && text.length < 50 && !text.includes(',')) {
        skillCategoryStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Skill category detected: ${text.substring(0, 40)}`);
      }
      // Items : texte avec virgules ou liste
      else if (text.includes(',') || item.style.bullet) {
        skillItemStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Skill items detected: ${text.substring(0, 40)}`);
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
      
      // Titre de mission : contient des dates et "@"
      if (/\d{2}\/\d{4}/.test(text) && (text.includes('@') || text.includes('-'))) {
        missionTitleStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Mission title detected: ${text.substring(0, 50)}`);
      }
      // Contexte : ligne avec "contexte" ou paragraphe descriptif après titre
      else if (textLower.includes('contexte') || textLower.includes('description')) {
        missionContextStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Mission context detected`);
      }
      // Environnement : ligne avec "environnement" ou "technologies"
      else if (textLower.includes('environnement') || textLower.includes('technologie') || textLower.includes('stack')) {
        missionEnvironmentStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Mission environment detected`);
      }
      // Réalisations : lignes avec puces
      else if (item.style.bullet) {
        missionAchievementStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Mission achievement detected (bullet)`);
      }
    }
  } else {
    console.warn('[analyzeTemplateStructure] Expérience section NOT found');
  }
  
  const formationSection = sections.find(s => s.name === 'Formations & Certifications');
  if (formationSection) {
    console.log(`[analyzeTemplateStructure] Analyzing Formations section (${formationSection.startIndex} to ${formationSection.endIndex})`);
    for (let i = formationSection.startIndex + 1; i < Math.min(formationSection.endIndex, formationSection.startIndex + 20); i++) {
      const item = extractedContent[i];
      if (item && item.text.trim().length > 3) {
        educationItemStyles.push(item.style);
        console.log(`[analyzeTemplateStructure] Education item detected: ${item.text.substring(0, 40)}`);
      }
    }
  } else {
    console.warn('[analyzeTemplateStructure] Formations section NOT found');
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

  console.log('[analyzeTemplateStructure] Saving to database...');
  
  await supabase
    .from('cv_templates')
    .update({ structure_data: structure })
    .eq('id', templateId)
    .eq('user_id', userId);

  console.log('[analyzeTemplateStructure] Analysis complete, structure saved');
  
  return structure;
}
