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

/**
 * Interface pour une section détectée dans le template
 */
interface TemplateSection {
  name: string;
  position: 'header' | 'body' | 'footer';
  styles: {
    title: DetailedStyle;
    content: DetailedStyle;
  };
}

/**
 * Interface pour les éléments d'une mission
 */
interface MissionElementStyles {
  title: DetailedStyle & { dateFormat: string };
  location: DetailedStyle | null;
  context: DetailedStyle | null;
  achievements: DetailedStyle & { bulletStyle: string };
  environment: DetailedStyle | null;
}

/**
 * Interface pour les sous-catégories de compétences
 */
interface SkillSubcategoryStyle {
  name: DetailedStyle;
  items: DetailedStyle;
  separator: string;
}

/**
 * Interface pour la mise en page globale
 */
interface PageLayout {
  margins: { top: string; right: string; bottom: string; left: string };
  orientation: 'portrait' | 'landscape';
  size: string;
  columns: number;
  headerMargin: string;
  footerMargin: string;
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
 * @param element - Élément HTML à analyser
 * @param text - Texte de l'élément
 * @param position - Position dans le document (header/body/footer)
 * @returns Objet DetailedStyle contenant tous les attributs de style
 */
function extractDetailedStyle(element: any, text: string, position: 'header' | 'body' | 'footer'): DetailedStyle {
  const styleAttr = element.getAttribute('style') || '';
  
  // Extraction des attributs de police
  const font = styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Calibri';
  const size = styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt';
  const colorMatch = styleAttr.match(/color:(#[0-9a-fA-F]{6})/);
  const color = colorMatch ? colorMatch[1] : '#000000';
  const bold = styleAttr.includes('font-weight:bold') || styleAttr.includes('font-weight:700');
  const italic = styleAttr.includes('font-style:italic');
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
  if (text === text.toUpperCase() && text !== text.toLowerCase()) {
    textCase = 'uppercase';
  } else if (text === text.toLowerCase()) {
    textCase = 'lowercase';
  } else if (text.match(/^[A-Z][a-z]/)) {
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
 * Détecte les incohérences dans les styles (ex: couleurs différentes pour le même type d'élément)
 * et retourne le style le plus fréquent
 * @param styles - Tableau de styles à analyser
 * @returns Le style le plus fréquemment utilisé
 */
function getMostFrequentStyle(styles: DetailedStyle[]): DetailedStyle {
  if (styles.length === 0) return {} as DetailedStyle;
  if (styles.length === 1) return styles[0];
  
  // Comptage des occurrences pour chaque attribut
  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  const sizeCounts = new Map<string, number>();
  
  styles.forEach(style => {
    colorCounts.set(style.color, (colorCounts.get(style.color) || 0) + 1);
    fontCounts.set(style.font, (fontCounts.get(style.font) || 0) + 1);
    sizeCounts.set(style.size, (sizeCounts.get(style.size) || 0) + 1);
  });
  
  // Sélection des valeurs les plus fréquentes
  const mostFrequentColor = Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  const mostFrequentFont = Array.from(fontCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  const mostFrequentSize = Array.from(sizeCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  
  // Construction du style cohérent
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
 * @param arrayBuffer - Contenu binaire du fichier DOCX
 * @param templateId - ID du template dans la base de données
 * @param supabase - Client Supabase
 * @param userId - ID de l'utilisateur
 * @returns Structure complète du template avec tous les styles
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
  
  const paragraphs = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
  console.log('[analyzeTemplateStructure] Found', paragraphs.length, 'elements');

  // Collections pour stocker les styles par type d'élément
  const headerElements: Array<{ text: string; style: DetailedStyle }> = [];
  const footerElements: Array<{ text: string; style: DetailedStyle }> = [];
  const sections: TemplateSection[] = [];
  const missionStyles: MissionElementStyles[] = [];
  const skillSubcategoryStyles: SkillSubcategoryStyle[] = [];
  const educationStyles: DetailedStyle[] = [];
  
  // Détection des logos et icônes
  const images = doc.querySelectorAll('img');
  const hasLogo = images.length > 0;
  
  // Mots-clés pour détecter les sections
  const sectionKeywords: Record<string, string[]> = {
    'Compétences': ['compétence', 'competence', 'skills', 'savoir-faire'],
    'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience', 'parcours'],
    'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes']
  };
  
  let currentSection: string | null = null;
  let currentSectionStyle: DetailedStyle | null = null;
  
  // Analyse de chaque élément
  paragraphs.forEach((element: any, index: number) => {
    const text = element.textContent.trim();
    if (!text || text.length < 2) return;
    
    // Détermination de la position dans le document
    const position: 'header' | 'body' | 'footer' = 
      index < 3 ? 'header' : 
      index > paragraphs.length - 3 ? 'footer' : 
      'body';
    
    const style = extractDetailedStyle(element, text, position);
    
    // Stockage des éléments d'en-tête et pied de page
    if (position === 'header') {
      headerElements.push({ text, style });
    } else if (position === 'footer') {
      footerElements.push({ text, style });
    }
    
    // Détection des sections
    const textLower = text.toLowerCase();
    let isSectionTitle = false;
    
    for (const [sectionName, keywords] of Object.entries(sectionKeywords)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        currentSection = sectionName;
        currentSectionStyle = style;
        isSectionTitle = true;
        
        sections.push({
          name: sectionName,
          position,
          styles: {
            title: style,
            content: style // Will be updated with actual content style
          }
        });
        
        console.log(`[analyzeTemplateStructure] Detected section: ${sectionName}`);
        break;
      }
    }
    
    // Analyse du contenu des sections
    if (!isSectionTitle && currentSection) {
      if (currentSection === 'Compétences') {
        // Détection des sous-catégories de compétences
        if (text.includes(':') || text.match(/[A-Z][a-z]+\/[A-Z]/)) {
          const parts = text.split(':').map((p: string) => p.trim());
          skillSubcategoryStyles.push({
            name: style,
            items: { ...style, bold: false },
            separator: ':'
          });
        }
      } else if (currentSection === 'Expérience') {
        // Détection des éléments de mission
        if (text.match(/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{4}/)) {
          // Titre de mission avec dates
          missionStyles.push({
            title: { ...style, dateFormat: 'MM/YYYY' },
            location: null,
            context: null,
            achievements: { ...style, bulletStyle: 'bullet' },
            environment: null
          });
        } else if (textLower.includes('contexte') || textLower.includes('objectif')) {
          if (missionStyles.length > 0) {
            missionStyles[missionStyles.length - 1].context = style;
          }
        } else if (textLower.includes('lieu') || textLower.includes('location')) {
          if (missionStyles.length > 0) {
            missionStyles[missionStyles.length - 1].location = style;
          }
        } else if (textLower.includes('environnement') || textLower.includes('technolog')) {
          if (missionStyles.length > 0) {
            missionStyles[missionStyles.length - 1].environment = style;
          }
        } else if (style.bullet) {
          if (missionStyles.length > 0) {
            missionStyles[missionStyles.length - 1].achievements = { 
              ...style, 
              bulletStyle: style.bulletStyle || 'bullet' 
            };
          }
        }
      } else if (currentSection === 'Formations & Certifications') {
        if (text.match(/\d{4}/)) {
          educationStyles.push(style);
        }
      }
    }
  });
  
  // Détection des incohérences et normalisation
  console.log('[analyzeTemplateStructure] Normalizing styles...');
  const normalizedMissionStyles = missionStyles.length > 0 ? {
    title: getMostFrequentStyle(missionStyles.map(m => m.title)),
    location: missionStyles.find(m => m.location)?.location || null,
    context: missionStyles.find(m => m.context)?.context || null,
    achievements: getMostFrequentStyle(missionStyles.map(m => m.achievements)),
    environment: missionStyles.find(m => m.environment)?.environment || null
  } : null;
  
  // Extraction de la mise en page globale
  const pageLayout: PageLayout = {
    margins: {
      top: '2.5cm',
      right: '2cm',
      bottom: '2.5cm',
      left: '2cm'
    },
    orientation: 'portrait',
    size: 'A4',
    columns: 1,
    headerMargin: '1.25cm',
    footerMargin: '1.25cm'
  };
  
  // Construction de la structure finale
  const structureData = {
    metadata: {
      analyzedAt: new Date().toISOString(),
      version: '2.0',
      totalElements: paragraphs.length
    },
    pageLayout,
    header: {
      elements: headerElements,
      hasLogo,
      logoPosition: hasLogo ? 'top-left' : null
    },
    footer: {
      elements: footerElements,
      hasLogo: false
    },
    sections,
    detailedStyles: {
      missions: normalizedMissionStyles,
      skills: {
        subcategories: skillSubcategoryStyles.length > 0 ? skillSubcategoryStyles[0] : null
      },
      education: educationStyles.length > 0 ? getMostFrequentStyle(educationStyles) : null
    },
    colors: {
      primary: sections[0]?.styles.title.color || '#000000',
      text: '#000000',
      secondary: sections[1]?.styles.title.color || '#000000',
      accent: sections[2]?.styles.title.color || '#000000'
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

  console.log('[analyzeTemplateStructure] Analysis complete');
  return structureData;
}
