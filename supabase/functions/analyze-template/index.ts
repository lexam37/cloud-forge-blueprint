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
 * Analyse le template en utilisant l'IA Lovable (Gemini)
 */
async function analyzeTemplateWithAI(
  fileData: Blob,
  templateId: string,
  supabase: any,
  userId: string
): Promise<any> {
  console.log('[analyzeTemplateWithAI] Starting AI analysis...');
  
  if (!LOVABLE_API_KEY) {
    throw new Error('LOVABLE_API_KEY not configured');
  }

  // Lire le fichier comme ArrayBuffer
  const arrayBuffer = await fileData.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  // Extraire le contenu textuel du document
  const zip = await JSZip.loadAsync(uint8Array);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  
  if (!documentXml) {
    throw new Error('Could not extract document.xml from template');
  }

  // Extraire le texte visible
  const textMatches = documentXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || [];
  const fullText = textMatches
    .map((t: string) => t.replace(/<\/?w:t[^>]*>/g, ''))
    .join('\n')
    .substring(0, 20000); // Limiter la taille pour l'API

  console.log('[analyzeTemplateWithAI] Extracted text length:', fullText.length);

  // Appeler l'IA pour analyser la structure du template
  const prompt = `Tu es un expert en analyse de documents CV professionnels.

Analyse ce contenu extrait d'un template Word de CV et identifie précisément:

1. **Les SECTIONS principales** (ex: Compétences, Expérience professionnelle, Formations, etc.)
2. **Pour chaque section identifiée**, note:
   - Le titre EXACT tel qu'il apparaît dans le document
   - Les éléments de contenu présents (ce sont des EXEMPLES à remplacer)
   - Le type de contenu attendu (liste, paragraphes, tableau, etc.)

3. **L'en-tête** : Identifie les éléments dans l'en-tête (trigramme, titre professionnel, contact, etc.)

4. **Le pied de page** : Identifie le contenu du pied de page s'il existe

CONTENU DU TEMPLATE:
---
${fullText}
---

Réponds UNIQUEMENT en JSON valide avec cette structure exacte:
{
  "sections": [
    {
      "name": "Type de section (Compétences|Expérience|Formations|Autre)",
      "title": "Titre exact tel qu'il apparaît",
      "contentType": "list|paragraphs|table",
      "exampleContent": "Exemple de contenu présent",
      "placeholderType": "competences|missions|formations|custom"
    }
  ],
  "header": {
    "hasTrigramme": true|false,
    "hasTitle": true|false,
    "hasContact": true|false,
    "content": "Contenu de l'en-tête"
  },
  "footer": {
    "hasContent": true|false,
    "content": "Contenu du pied de page"
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

  console.log('[analyzeTemplateWithAI] Structure:', JSON.stringify(structure, null, 2));

  // Créer un template avec placeholders basé sur l'analyse IA
  const modifiedTemplate = await createTemplateWithPlaceholdersAI(zip, structure, documentXml);
  
  // Sauvegarder le template modifié
  const templateFileName = `template-with-placeholders-${templateId}-${Date.now()}.docx`;
  const templatePath = `${userId}/${templateFileName}`;
  
  console.log('[analyzeTemplateWithAI] Uploading modified template...');
  
  const { error: uploadError } = await supabase.storage
    .from('cv-templates')
    .upload(templatePath, modifiedTemplate, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true
    });

  if (uploadError) {
    console.error('[analyzeTemplateWithAI] Upload error:', uploadError);
    throw new Error(`Failed to upload template: ${uploadError.message}`);
  }

  console.log('[analyzeTemplateWithAI] Template uploaded:', templatePath);
  
  // Ajouter le chemin au résultat
  structure.templateWithPlaceholdersPath = templatePath;

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
 * Crée un template avec placeholders docxtemplater basé sur l'analyse IA
 */
async function createTemplateWithPlaceholdersAI(
  zip: any,
  structure: any,
  documentXml: string
): Promise<Uint8Array> {
  console.log('[createTemplateWithPlaceholdersAI] Creating template with AI-guided placeholders...');
  
  let modifiedXml = documentXml;
  
  // Pour chaque section identifiée par l'IA
  for (const section of structure.sections || []) {
    console.log(`[createTemplateWithPlaceholdersAI] Processing section: ${section.name} (${section.title})`);
    
    // Définir les placeholders selon le type identifié par l'IA
    let placeholders = '';
    
    if (section.placeholderType === 'competences') {
      placeholders = '{#competences}{category}: {items}\n{/competences}';
    } else if (section.placeholderType === 'missions') {
      placeholders = '{#missions}{period} - {role} @ {client}\n\nContexte: {context}\n\nRéalisations:\n{#achievements}- {.}\n{/achievements}\n\nEnvironnement: {environment}\n\n{/missions}';
    } else if (section.placeholderType === 'formations') {
      placeholders = '{#formations}{year} - {degree} - {institution}\n{/formations}';
    }
    
    if (placeholders) {
      // Chercher le titre de la section et marquer l'emplacement des placeholders
      const escapedTitle = section.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const titleRegex = new RegExp(`(<w:t[^>]*>)(${escapedTitle})(<\/w:t>)`, 'i');
      
      if (titleRegex.test(modifiedXml)) {
        console.log(`[createTemplateWithPlaceholdersAI] Found section: ${section.title}`);
        // Marquer l'emplacement pour un traitement ultérieur
        modifiedXml = modifiedXml.replace(
          titleRegex,
          `$1$2$3<!-- SECTION_MARKER:${section.placeholderType} -->`
        );
      } else {
        console.warn(`[createTemplateWithPlaceholdersAI] Could not find section title: ${section.title}`);
      }
    }
  }

  // Remplacer trigramme et titre dans le header (si identifiés par l'IA)
  if (structure.header?.hasTrigramme) {
    modifiedXml = modifiedXml.replace(
      /<w:t[^>]*>([A-Z]{3})<\/w:t>/g,
      '<w:t>{trigram}</w:t>'
    );
    console.log('[createTemplateWithPlaceholdersAI] Replaced trigramme placeholder');
  }
  
  if (structure.header?.hasTitle) {
    // Remplacer les titres professionnels longs
    modifiedXml = modifiedXml.replace(
      /<w:t[^>]*>([^<]{15,}(?:consultant|développeur|chef de projet|manager|ingénieur|architecte)[^<]{0,30})<\/w:t>/gi,
      '<w:t>{title}</w:t>'
    );
    console.log('[createTemplateWithPlaceholdersAI] Replaced title placeholder');
  }

  // Mettre à jour le document.xml dans le ZIP
  zip.file('word/document.xml', modifiedXml);
  
  // Générer le nouveau DOCX
  const generatedBuffer = await zip.generateAsync({ 
    type: 'uint8array',
    compression: 'DEFLATE'
  });
  
  console.log('[createTemplateWithPlaceholdersAI] Template created successfully');
  return generatedBuffer;
}
