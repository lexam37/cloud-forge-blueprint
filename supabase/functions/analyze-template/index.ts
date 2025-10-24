import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import mammoth from "https://esm.sh/mammoth@1.6.0";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.43/deno-dom-wasm.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Interface représentant tous les attributs de style d'un élément
 */
interface DetailedStyle {
  // Police et texte
  font: string;
  size: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: { type: string; color: string } | null;
  strike: boolean;
  case: 'uppercase' | 'lowercase' | 'mixed' | 'capitalize';
  
  // Paragraphe
  alignment: 'left' | 'center' | 'right' | 'justify';
  spacingBefore: string;
  spacingAfter: string;
  lineHeight: string;
  indent: string;
  firstLineIndent: string;
  
  // Puces et numérotation
  bullet: boolean;
  bulletStyle: string | null;
  
  // Bordures et fond
  border: {
    top: string | null;
    right: string | null;
    bottom: string | null;
    left: string | null;
    color: string | null;
  };
  backgroundColor: string | null;
  
  // Position dans le document
  position: 'header' | 'body' | 'footer';
}

const requestSchema = z.object({
  templateId: z.string().uuid({ message: 'templateId must be a valid UUID' })
});

/**
 * Point d'entrée principal de l'edge function
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { templateId } = requestSchema.parse(await req.json());
    console.log('[analyze-template] Processing templateId:', templateId);

    // Authentification
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) throw new Error('Missing environment variables');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Vérification de l'utilisateur
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) throw new Error('User not authenticated');

    console.log('[analyze-template] Fetching template for user:', user.id);
    
    // Récupération du template
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

    // Téléchargement du fichier
    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('cv-templates')
      .download(template.file_path);

    if (fileError || !fileData) {
      throw new Error(`Failed to download file: ${fileError?.message}`);
    }

    console.log('[analyze-template] Starting detailed analysis...');
    const arrayBuffer = await fileData.arrayBuffer();
    const structureData = await analyzeTemplateStructure(arrayBuffer, templateId, supabase, user.id);
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
 * Extrait tous les attributs de style détaillés d'un élément HTML
 */
function extractDetailedStyle(element: any, text: string, position: 'header' | 'body' | 'footer'): DetailedStyle {
  const styleAttr = element.getAttribute('style') || '';
  
  // Extraction des attributs de police
  const font = styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim().replace(/['",]/g, '') || 'Calibri';
  const size = styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt';
  const colorMatch = styleAttr.match(/color:(#[0-9a-fA-F]{6}|rgb\([^)]+\))/);
  let color = '#000000';
  if (colorMatch) {
    const colorValue = colorMatch[1];
    if (colorValue.startsWith('rgb')) {
      const rgbMatch = colorValue.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (rgbMatch) {
        const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
        const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
        const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
        color = `#${r}${g}${b}`;
      }
    } else {
      color = colorValue;
    }
  }
  
  const bold = styleAttr.includes('font-weight:bold') || 
               styleAttr.includes('font-weight:700') || 
               element.querySelector('strong, b') !== null ||
               element.tagName === 'STRONG' ||
               element.tagName === 'B';
               
  const italic = styleAttr.includes('font-style:italic') || 
                 element.querySelector('em, i') !== null ||
                 element.tagName === 'EM' ||
                 element.tagName === 'I';
                 
  const strike = styleAttr.includes('text-decoration:line-through');
  
  // Extraction du soulignement
  const underlineMatch = styleAttr.match(/text-decoration:\s*underline/);
  const underlineColorMatch = styleAttr.match(/text-decoration-color:\s*(#[0-9a-fA-F]{6})/);
  const underline = underlineMatch ? {
    type: 'single',
    color: underlineColorMatch ? underlineColorMatch[1] : color
  } : null;
  
  // Détection de la casse
  let textCase: 'uppercase' | 'lowercase' | 'mixed' | 'capitalize' = 'mixed';
  if (text && text === text.toUpperCase() && text !== text.toLowerCase()) {
    textCase = 'uppercase';
  } else if (text && text === text.toLowerCase()) {
    textCase = 'lowercase';
  } else if (text && text.match(/^[A-Z][a-z]/)) {
    textCase = 'capitalize';
  }
  
  // Extraction des attributs de paragraphe
  let alignment: 'left' | 'center' | 'right' | 'justify' = 'left';
  if (styleAttr.includes('text-align:center')) alignment = 'center';
  else if (styleAttr.includes('text-align:right')) alignment = 'right';
  else if (styleAttr.includes('text-align:justify')) alignment = 'justify';
  
  const spacingBefore = styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt';
  const spacingAfter = styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '0pt';
  const lineHeight = styleAttr.match(/line-height:([^;]+)/)?.[1]?.trim() || '1.15';
  const indent = styleAttr.match(/(?:margin-left|padding-left):([^;]+)/)?.[1]?.trim() || '0pt';
  const firstLineIndent = styleAttr.match(/text-indent:([^;]+)/)?.[1]?.trim() || '0pt';
  
  // Détection des puces
  const isList = element.tagName === 'LI' || element.closest('ul') || element.closest('ol');
  const hasBulletChar = /^[•\-\*°\u2022\u25CF\u25E6]/.test(text);
  const bullet = isList || hasBulletChar;
  const bulletStyle = isList ? (element.closest('ol') ? 'numbered' : 'bullet') : (hasBulletChar ? 'custom' : null);
  
  // Extraction des bordures
  const borderTop = styleAttr.match(/border-top:([^;]+)/)?.[1]?.trim() || null;
  const borderRight = styleAttr.match(/border-right:([^;]+)/)?.[1]?.trim() || null;
  const borderBottom = styleAttr.match(/border-bottom:([^;]+)/)?.[1]?.trim() || null;
  const borderLeft = styleAttr.match(/border-left:([^;]+)/)?.[1]?.trim() || null;
  const borderColor = styleAttr.match(/border-color:([^;]+)/)?.[1]?.trim() || null;
  
  const backgroundColor = styleAttr.match(/background-color:([^;]+)/)?.[1]?.trim() || null;
  
  return {
    font,
    size,
    color,
    bold,
    italic,
    underline,
    strike,
    case: textCase,
    alignment,
    spacingBefore,
    spacingAfter,
    lineHeight,
    indent,
    firstLineIndent,
    bullet,
    bulletStyle,
    border: {
      top: borderTop,
      right: borderRight,
      bottom: borderBottom,
      left: borderLeft,
      color: borderColor
    },
    backgroundColor,
    position
  };
}

/**
 * Détecte les incohérences et retourne le style le plus fréquent
 */
function getMostFrequentStyle(styles: DetailedStyle[]): DetailedStyle {
  if (styles.length === 0) return {} as DetailedStyle;
  if (styles.length === 1) return styles[0];
  
  // Comptage des occurrences pour chaque attribut clé
  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  const sizeCounts = new Map<string, number>();
  
  styles.forEach(style => {
    if (style.color) colorCounts.set(style.color, (colorCounts.get(style.color) || 0) + 1);
    if (style.font) fontCounts.set(style.font, (fontCounts.get(style.font) || 0) + 1);
    if (style.size) sizeCounts.set(style.size, (sizeCounts.get(style.size) || 0) + 1);
  });
  
  // Sélection des valeurs les plus fréquentes
  const mostFrequentColor = colorCounts.size > 0 
    ? Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : styles[0].color;
    
  const mostFrequentFont = fontCounts.size > 0
    ? Array.from(fontCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : styles[0].font;
    
  const mostFrequentSize = sizeCounts.size > 0
    ? Array.from(sizeCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : styles[0].size;
  
  // Construction du style cohérent avec le premier comme base
  const baseStyle = styles[0];
  return {
    ...baseStyle,
    color: mostFrequentColor,
    font: mostFrequentFont,
    size: mostFrequentSize
  };
}

/**
 * Analyse complète de la structure du template DOCX
 * Extraction détaillée de l'en-tête, des sections et des styles multi-niveaux
 */
async function analyzeTemplateStructure(
  arrayBuffer: ArrayBuffer, 
  templateId: string, 
  supabase: any, 
  userId: string
) {
  console.log('[analyzeTemplateStructure] Converting DOCX to HTML...');
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const html = result.value;
  
  if (result.messages && result.messages.length > 0) {
    console.warn('[analyzeTemplateStructure] Conversion warnings:', result.messages);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  if (!doc) throw new Error('Failed to parse HTML document');
  
  const allElements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, img, table');
  console.log('[analyzeTemplateStructure] Found', allElements.length, 'elements');

  // === PHASE 1: Extraction de l'en-tête (header) avec logo et coordonnées ===
  console.log('[analyzeTemplateStructure] Extracting header section...');
  const headerElements: Array<{ text: string; html: string; style: DetailedStyle; type: string }> = [];
  let headerEndIndex = 0;
  let hasLogo = false;
  let logoSrc = '';
  
  // Les premiers éléments jusqu'à trouver une section connue constituent l'en-tête
  const sectionStarters = ['compétence', 'experience', 'expérience', 'formation', 'profil'];
  
  for (let i = 0; i < Math.min(15, allElements.length); i++) {
    const el = allElements[i] as any;
    const text = el.textContent?.trim() || '';
    const textLower = text.toLowerCase();
    
    // Arrêt si on trouve un titre de section principale
    if (sectionStarters.some(starter => textLower.includes(starter)) && text.length < 50) {
      headerEndIndex = i;
      console.log(`[analyzeTemplateStructure] Header ends at index ${i}, detected section: ${text}`);
      break;
    }
    
    const position = 'header' as const;
    
    // Traitement des images (logo)
    if (el.tagName === 'IMG') {
      hasLogo = true;
      logoSrc = el.getAttribute('src') || '';
      console.log('[analyzeTemplateStructure] Logo detected in header');
      headerElements.push({
        text: '[LOGO]',
        html: el.outerHTML,
        style: extractDetailedStyle(el, '', position),
        type: 'img'
      });
      continue;
    }
    
    // Traitement des tableaux (souvent utilisés pour la mise en page de l'en-tête)
    if (el.tagName === 'TABLE') {
      const cells = el.querySelectorAll('td, th');
      cells.forEach((cell: any) => {
        const cellText = cell.textContent?.trim() || '';
        if (cellText.length > 2) {
          headerElements.push({
            text: cellText,
            html: cell.outerHTML,
            style: extractDetailedStyle(cell, cellText, position),
            type: 'table-cell'
          });
        }
      });
      continue;
    }
    
    // Paragraphes et titres
    if (text.length > 0) {
      const style = extractDetailedStyle(el, text, position);
      headerElements.push({
        text,
        html: el.outerHTML,
        style,
        type: el.tagName.toLowerCase()
      });
      
      // Détection des coordonnées commerciales
      if (textLower.includes('contact') || 
          textLower.includes('commercial') || 
          /\d{2}[.\s]\d{2}[.\s]\d{2}[.\s]\d{2}[.\s]\d{2}/.test(text) ||
          /@/.test(text) && text.includes('.')) {
        console.log('[analyzeTemplateStructure] Commercial contact detected:', text.substring(0, 50));
      }
    }
  }
  
  console.log(`[analyzeTemplateStructure] Header extracted: ${headerElements.length} elements`);

  // === PHASE 2: Détection des sections principales ===
  console.log('[analyzeTemplateStructure] Detecting main sections...');
  
  interface Section {
    name: string;
    titleStyle: DetailedStyle;
    startIndex: number;
    endIndex: number;
  }
  
  const sections: Section[] = [];
  const sectionKeywords: Record<string, string[]> = {
    'Compétences': ['compétence', 'competence', 'skills'],
    'Expérience': ['expérience', 'experience', 'parcours'],
    'Formations & Certifications': ['formation', 'certification', 'diplôme', 'education']
  };
  
  for (let i = headerEndIndex; i < allElements.length; i++) {
    const el = allElements[i];
    const text = el.textContent?.trim() || '';
    const textLower = text.toLowerCase();
    
    for (const [sectionName, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(kw => textLower.includes(kw)) && text.length < 50) {
        const titleStyle = extractDetailedStyle(el, text, 'body');
        sections.push({
          name: sectionName,
          titleStyle,
          startIndex: i,
          endIndex: i + 100 // Temporaire, sera ajusté
        });
        console.log(`[analyzeTemplateStructure] Section "${sectionName}" detected at index ${i}`);
        break;
      }
    }
  }
  
  // Ajuster les endIndex
  sections.forEach((section, idx) => {
    if (idx < sections.length - 1) {
      section.endIndex = sections[idx + 1].startIndex;
    } else {
      section.endIndex = allElements.length;
    }
  });

  // === PHASE 3: Analyse détaillée des styles par section ===
  console.log('[analyzeTemplateStructure] Analyzing detailed styles per section...');
  
  // Compétences : styles multi-niveaux
  const competencesSection = sections.find(s => s.name === 'Compétences');
  const skillCategoryStyles: DetailedStyle[] = [];
  const skillItemStyles: DetailedStyle[] = [];
  
  if (competencesSection) {
    for (let i = competencesSection.startIndex + 1; i < competencesSection.endIndex; i++) {
      const el = allElements[i] as any;
      const text = el.textContent?.trim() || '';
      
      // Catégories (OS, Langages, etc.) : souvent en gras ou avec ":"
      if (text.includes(':') || (text.length < 30 && /^[A-Z]/.test(text))) {
        const style = extractDetailedStyle(el, text, 'body');
        if (style.bold || (el.querySelector && el.querySelector('strong, b'))) {
          skillCategoryStyles.push(style);
          console.log(`[analyzeTemplateStructure] Skill category detected: ${text.substring(0, 30)}`);
        } else {
          skillItemStyles.push(style);
        }
      }
      // Items (Windows, Java, etc.) : souvent séparés par des virgules
      else if (text.includes(',')) {
        const style = extractDetailedStyle(el, text, 'body');
        skillItemStyles.push(style);
      }
    }
  }
  
  // Expérience : styles des éléments de mission
  const experienceSection = sections.find(s => s.name === 'Expérience');
  const missionTitleStyles: DetailedStyle[] = [];
  const missionContextStyles: DetailedStyle[] = [];
  const missionAchievementStyles: DetailedStyle[] = [];
  const missionEnvironmentStyles: DetailedStyle[] = [];
  let missionDateFormat = 'MM/YYYY';
  
  if (experienceSection) {
    for (let i = experienceSection.startIndex + 1; i < experienceSection.endIndex; i++) {
      const el = allElements[i] as any;
      const text = el.textContent?.trim() || '';
      const textLower = text.toLowerCase();
      
      // Titre de mission avec dates
      if (/\d{2}\/\d{4}/.test(text) && text.includes('@')) {
        const style = extractDetailedStyle(el, text, 'body');
        missionTitleStyles.push(style);
        console.log(`[analyzeTemplateStructure] Mission title detected: ${text.substring(0, 50)}`);
      }
      // Contexte
      else if (textLower.includes('contexte') || textLower.includes('objectif')) {
        const style = extractDetailedStyle(el, text, 'body');
        missionContextStyles.push(style);
      }
      // Achievements/missions (puces)
      else if ((el.tagName && el.tagName === 'LI') || /^[•\-\*]/.test(text)) {
        const style = extractDetailedStyle(el, text, 'body');
        missionAchievementStyles.push(style);
      }
      // Environnement
      else if (textLower.includes('environnement') || textLower.includes('technolog')) {
        const style = extractDetailedStyle(el, text, 'body');
        missionEnvironmentStyles.push(style);
      }
    }
  }
  
  // Formation : styles des items
  const formationSection = sections.find(s => s.name === 'Formations & Certifications');
  const educationItemStyles: DetailedStyle[] = [];
  
  if (formationSection) {
    for (let i = formationSection.startIndex + 1; i < formationSection.endIndex; i++) {
      const el = allElements[i] as any;
      const text = el.textContent?.trim() || '';
      
      if (/\d{4}/.test(text) && text.length > 10) {
        const style = extractDetailedStyle(el, text, 'body');
        educationItemStyles.push(style);
      }
    }
  }
  
  // === PHASE 4: Normalisation des styles ===
  console.log('[analyzeTemplateStructure] Normalizing styles...');
  
  const normalizedSkillCategory = skillCategoryStyles.length > 0 
    ? getMostFrequentStyle(skillCategoryStyles) 
    : null;
    
  const normalizedSkillItems = skillItemStyles.length > 0 
    ? getMostFrequentStyle(skillItemStyles) 
    : null;
    
  const normalizedMissionTitle = missionTitleStyles.length > 0 
    ? getMostFrequentStyle(missionTitleStyles) 
    : null;
    
  const normalizedMissionContext = missionContextStyles.length > 0 
    ? getMostFrequentStyle(missionContextStyles) 
    : null;
    
  const normalizedMissionAchievements = missionAchievementStyles.length > 0 
    ? getMostFrequentStyle(missionAchievementStyles) 
    : null;
    
  const normalizedMissionEnvironment = missionEnvironmentStyles.length > 0 
    ? getMostFrequentStyle(missionEnvironmentStyles) 
    : null;
    
  const normalizedEducation = educationItemStyles.length > 0 
    ? getMostFrequentStyle(educationItemStyles) 
    : null;

  // === PHASE 5: Pied de page (footer) ===
  const footerElements: Array<{ text: string; style: DetailedStyle }> = [];
  for (let i = Math.max(allElements.length - 5, headerEndIndex); i < allElements.length; i++) {
    const el = allElements[i] as any;
    const text = el.textContent?.trim() || '';
    if (text && text.length > 0 && (!el.tagName || el.tagName !== 'IMG')) {
      footerElements.push({
        text,
        style: extractDetailedStyle(el, text, 'footer')
      });
    }
  }

  // === PHASE 6: Extraction de la mise en page globale ===
  const pageLayout = {
    margins: {
      top: '2.5cm',
      right: '2cm',
      bottom: '2.5cm',
      left: '2cm'
    },
    orientation: 'portrait' as const,
    size: 'A4',
    columns: 1,
    headerMargin: '1.25cm',
    footerMargin: '1.25cm'
  };
  
  // === PHASE 7: Construction de la structure finale ===
  const structureData = {
    metadata: {
      analyzedAt: new Date().toISOString(),
      version: '3.0',
      totalElements: allElements.length,
      headerElementCount: headerElements.length
    },
    pageLayout,
    header: {
      elements: headerElements,
      hasLogo,
      logoSrc,
      hasCommercialContact: headerElements.some(el => 
        el.text.toLowerCase().includes('contact') || 
        el.text.toLowerCase().includes('commercial') ||
        /\d{2}[.\s]\d{2}[.\s]\d{2}[.\s]\d{2}[.\s]\d{2}/.test(el.text)
      )
    },
    footer: {
      elements: footerElements
    },
    sections: sections.map(s => ({
      name: s.name,
      titleStyle: s.titleStyle
    })),
    detailedStyles: {
      skills: {
        sectionTitle: competencesSection?.titleStyle || null,
        category: normalizedSkillCategory,
        items: normalizedSkillItems
      },
      experience: {
        sectionTitle: experienceSection?.titleStyle || null,
        missionTitle: normalizedMissionTitle,
        missionDateFormat,
        context: normalizedMissionContext,
        achievements: normalizedMissionAchievements,
        environment: normalizedMissionEnvironment
      },
      education: {
        sectionTitle: formationSection?.titleStyle || null,
        item: normalizedEducation
      }
    },
    colors: {
      primary: sections[0]?.titleStyle.color || '#000000',
      text: '#000000',
      secondary: sections[1]?.titleStyle.color || '#000000',
      accent: sections[2]?.titleStyle.color || '#000000'
    }
  };
  
  console.log('[analyzeTemplateStructure] Saving to database...');
  const { error: updateError } = await supabase
    .from('cv_templates')
    .update({ structure_data: structureData })
    .eq('id', templateId)
    .eq('user_id', userId);

  if (updateError) {
    console.error('[analyzeTemplateStructure] Database error:', updateError);
    throw new Error(`Failed to update template: ${updateError.message}`);
  }

  console.log('[analyzeTemplateStructure] Analysis complete, structure saved');
  return structureData;
}
