import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');

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

    console.log('[analyze-template] Starting AI-powered analysis...');
    const structureData = await analyzeTemplateWithAI(fileData, templateId, supabase, user.id);
    console.log('[analyze-template] Analysis complete');

    await supabase.from('processing_logs').insert({
      cv_document_id: null,
      step: 'template_analysis',
      message: 'Template analyzed successfully with AI',
      user_id: user.id
    });

    return new Response(
      JSON.stringify({ success: true, structure: structureData }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[analyze-template] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

/**
 * Analyse les STYLES du template Word pour identifier tous les changements de formatage
 * Extrait : polices, couleurs, tailles, puces, espacements, etc.
 */
async function analyzeTemplateWithAI(
  fileData: Blob,
  templateId: string,
  supabase: any,
  userId: string
): Promise<any> {
  console.log('[analyzeTemplateWithAI] Starting comprehensive style analysis...');
  
  if (!LOVABLE_API_KEY) {
    throw new Error('LOVABLE_API_KEY not configured');
  }

  // Lire le fichier comme ArrayBuffer
  const arrayBuffer = await fileData.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  // Extraire TOUS les fichiers XML nécessaires du DOCX
  const zip = await JSZip.loadAsync(uint8Array);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  const numberingXml = await zip.file('word/numbering.xml')?.async('string');
  
  if (!documentXml) {
    throw new Error('Could not extract document.xml from template');
  }

  console.log('[analyzeTemplateWithAI] Extracted XML files:', {
    hasDocument: !!documentXml,
    hasStyles: !!stylesXml,
    hasNumbering: !!numberingXml
  });

  // ÉTAPE 1 : Extraire les styles définis dans styles.xml
  const definedStyles = extractDefinedStyles(stylesXml || '');
  console.log('[analyzeTemplateWithAI] Found', definedStyles.length, 'defined styles');

  // ÉTAPE 2 : Analyser le document pour identifier les styles UTILISÉS
  const usedStyles = analyzeUsedStyles(documentXml);
  console.log('[analyzeTemplateWithAI] Identified', usedStyles.length, 'used styles in document');

  // ÉTAPE 3 : Extraire le texte pour l'analyse sémantique par l'IA
  const textMatches = documentXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || [];
  const fullText = textMatches
    .map((t: string) => t.replace(/<\/?w:t[^>]*>/g, ''))
    .join('\n')
    .substring(0, 15000);

  console.log('[analyzeTemplateWithAI] Extracted text length:', fullText.length);

  // ÉTAPE 4 : Appeler l'IA pour mapper les styles aux types de contenu
  const prompt = `Tu es un expert en analyse de templates Word de CV professionnels.

CONTEXTE : J'ai extrait les styles utilisés dans un template Word de CV.

STYLES IDENTIFIÉS :
${JSON.stringify(usedStyles, null, 2)}

CONTENU DU TEMPLATE :
---
${fullText}
---

MISSION : Identifie les SECTIONS du CV et ASSOCIE chaque section à un ou plusieurs styles.

Pour chaque SECTION identifiée :
1. **Titre de la section** : Texte exact (ex: "Compétences", "Expérience professionnelle")
2. **Type de contenu** : list|paragraphs|table
3. **Styles associés** : Liste des styleIds utilisés pour cette section
   - titleStyleId : Style du titre de section
   - contentStyleIds : Styles utilisés pour le contenu
   - Exemple : "Heading1" pour titre, ["ListParagraph", "BodyText"] pour contenu

Réponds UNIQUEMENT en JSON valide avec cette structure :
{
  "sections": [
    {
      "name": "Type (Compétences|Expérience|Formations|Autre)",
      "title": "Titre exact",
      "contentType": "list|paragraphs|table",
      "exampleContent": "Exemple de contenu",
      "placeholderType": "competences|missions|formations|custom",
      "titleStyleId": "styleId du titre",
      "contentStyleIds": ["styleId1", "styleId2"],
      "formatting": {
        "hasBullets": true|false,
        "indentLevel": 0,
        "spacing": "normal|compact"
      }
    }
  ],
  "header": {
    "hasTrigramme": true|false,
    "trigramStyleId": "styleId",
    "hasTitle": true|false,
    "titleStyleId": "styleId",
    "hasContact": true|false
  },
  "footer": {
    "hasContent": true|false,
    "styleId": "styleId"
  },
  "styleMapping": {
    "description": "Résumé des styles identifiés et leur usage"
  }
}`;

  console.log('[analyzeTemplateWithAI] Calling Lovable AI...');

  const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LOVABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-pro',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    console.error('[analyzeTemplateWithAI] AI API error:', aiResponse.status, errorText);
    throw new Error(`AI API error: ${aiResponse.status}`);
  }

  const aiResult = await aiResponse.json();
  const analysisText = aiResult.choices[0].message.content;
  console.log('[analyzeTemplateWithAI] AI analysis received');

  let structure;
  try {
    structure = JSON.parse(analysisText);
  } catch (e) {
    console.error('[analyzeTemplateWithAI] Failed to parse AI response:', analysisText);
    throw new Error('AI response was not valid JSON');
  }

  console.log('[analyzeTemplateWithAI] Structure with styles:', JSON.stringify(structure, null, 2));

  // Enrichir la structure avec les styles définis complets
  structure.definedStyles = definedStyles;
  structure.usedStyleIds = usedStyles;

  // NE PAS créer de template modifié - on va utiliser l'original directement
  // et appliquer les styles par référence lors de la génération
  console.log('[analyzeTemplateWithAI] Template analysis complete - will use original for generation');

  // Sauvegarder la structure dans la base
  const { error: updateError } = await supabase
    .from('cv_templates')
    .update({ structure_data: structure })
    .eq('id', templateId)
    .eq('user_id', userId);

  if (updateError) {
    console.error('[analyzeTemplateWithAI] DB update error:', updateError);
    throw new Error(`Failed to update database: ${updateError.message}`);
  }

  console.log('[analyzeTemplateWithAI] Analysis complete');
  return structure;
}

/**
 * NOUVELLE FONCTION : Extrait les styles définis dans styles.xml
 * Identifie : polices, couleurs, tailles, puces, espacements, alignements
 */
function extractDefinedStyles(stylesXml: string): any[] {
  console.log('[extractDefinedStyles] Analyzing styles.xml...');
  
  const styles: any[] = [];
  
  // Extraire tous les styles définis <w:style w:type="paragraph|character" w:styleId="...">
  const styleRegex = /<w:style[^>]*w:styleId="([^"]+)"[^>]*w:type="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let match;
  
  while ((match = styleRegex.exec(stylesXml)) !== null) {
    const [, styleId, styleType, styleContent] = match;
    
    // Extraire les propriétés de formatage
    const fontMatch = styleContent.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/);
    const sizeMatch = styleContent.match(/<w:sz[^>]*w:val="([^"]+)"/);
    const colorMatch = styleContent.match(/<w:color[^>]*w:val="([^"]+)"/);
    const boldMatch = styleContent.match(/<w:b\s*\/>/);
    const italicMatch = styleContent.match(/<w:i\s*\/>/);
    const numIdMatch = styleContent.match(/<w:numId[^>]*w:val="([^"]+)"/);
    const indentMatch = styleContent.match(/<w:ind[^>]*w:left="([^"]+)"/);
    const spacingMatch = styleContent.match(/<w:spacing[^>]*w:after="([^"]+)"/);
    
    styles.push({
      styleId,
      styleType,
      font: fontMatch ? fontMatch[1] : null,
      size: sizeMatch ? parseInt(sizeMatch[1]) / 2 : null, // Word uses half-points
      color: colorMatch ? colorMatch[1] : null,
      bold: !!boldMatch,
      italic: !!italicMatch,
      numId: numIdMatch ? numIdMatch[1] : null,
      indent: indentMatch ? parseInt(indentMatch[1]) : 0,
      spacing: spacingMatch ? parseInt(spacingMatch[1]) : 0
    });
  }
  
  return styles;
}

/**
 * NOUVELLE FONCTION : Analyse les styles UTILISÉS dans le document
 * Identifie chaque changement de style = nouveau type de contenu
 */
function analyzeUsedStyles(documentXml: string): any[] {
  console.log('[analyzeUsedStyles] Scanning document for used styles...');
  
  const usedStyles = new Map<string, any>();
  
  // Extraire tous les paragraphes avec leur style
  const paragraphRegex = /<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch;
  
  while ((pMatch = paragraphRegex.exec(documentXml)) !== null) {
    const paragraphContent = pMatch[1];
    
    // Extraire le pStyle (style de paragraphe)
    const pStyleMatch = paragraphContent.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    const pStyleId = pStyleMatch ? pStyleMatch[1] : 'Normal';
    
    // Extraire les propriétés de formatage directes
    const numIdMatch = paragraphContent.match(/<w:numId[^>]*w:val="([^"]+)"/);
    const indentMatch = paragraphContent.match(/<w:ind[^>]*w:left="([^"]+)"/);
    
    // Extraire le texte pour contextualiser
    const textMatches = paragraphContent.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || [];
    const text = textMatches.map((t: string) => t.replace(/<\/?w:t[^>]*>/g, '')).join('').trim();
    
    if (text && text.length > 2) {
      const styleKey = `${pStyleId}_${numIdMatch ? numIdMatch[1] : 'none'}`;
      
      if (!usedStyles.has(styleKey)) {
        usedStyles.set(styleKey, {
          styleId: pStyleId,
          numId: numIdMatch ? numIdMatch[1] : null,
          indent: indentMatch ? parseInt(indentMatch[1]) : 0,
          hasBullets: !!numIdMatch,
          exampleText: text.substring(0, 100),
          occurrences: 1
        });
      } else {
        usedStyles.get(styleKey)!.occurrences++;
      }
    }
  }
  
  return Array.from(usedStyles.values());
}
