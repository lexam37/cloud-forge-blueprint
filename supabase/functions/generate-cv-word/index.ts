import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import Docxtemplater from "https://esm.sh/docxtemplater@3.45.0";
import PizZip from "https://esm.sh/pizzip@3.1.6";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');

const requestSchema = z.object({
  cvDocumentId: z.string().uuid({ message: 'cvDocumentId must be a valid UUID' })
});

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { cvDocumentId } = requestSchema.parse(await req.json());
    console.log('[generate-cv-word] Processing cvDocumentId:', cvDocumentId);
    
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) throw new Error('Missing environment variables');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) throw new Error('User not authenticated');

    console.log('[generate-cv-word] Fetching CV document for user:', user.id);

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id)
      .single();

    if (cvError || !cvDoc) throw new Error('CV document not found or not owned by user');

    const extractedData = cvDoc.extracted_data;
    if (!extractedData) throw new Error('No extracted data found in CV document');

    if (!cvDoc.template_id) throw new Error('No template selected');

    console.log('[generate-cv-word] Fetching template:', cvDoc.template_id);
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('file_path, structure_data')
      .eq('id', cvDoc.template_id)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found');
    }

    console.log('[generate-cv-word] Template structure:', JSON.stringify(template.structure_data, null, 2));

    // Télécharger le template avec placeholders
    const templatePath = template.structure_data?.templateWithPlaceholdersPath || template.file_path;
    console.log('[generate-cv-word] Downloading template from:', templatePath);
    
    const { data: templateFile, error: downloadError } = await supabase
      .storage
      .from('cv-templates')
      .download(templatePath);

    if (downloadError || !templateFile) {
      console.error('[generate-cv-word] Download error:', downloadError);
      throw new Error(`Failed to download template: ${downloadError?.message}`);
    }

    const templateBuffer = await templateFile.arrayBuffer();
    console.log('[generate-cv-word] Template downloaded, size:', templateBuffer.byteLength);

    // Utiliser l'IA pour faire le mapping intelligent et générer le CV
    console.log('[generate-cv-word] Generating CV with AI mapping...');
    const generatedBuffer = await generateCVWithAI(
      new Uint8Array(templateBuffer),
      extractedData,
      template.structure_data
    );

    // Upload du fichier généré
    const generatedFileName = `cv-${cvDocumentId}-${Date.now()}.docx`;
    const generatedPath = `${user.id}/${generatedFileName}`;
    
    console.log('[generate-cv-word] Uploading generated CV...');
    
    const { error: uploadError } = await supabase
      .storage
      .from('cv-generated')
      .upload(generatedPath, generatedBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      console.error('[generate-cv-word] Upload error:', uploadError);
      throw new Error(`Failed to upload generated CV: ${uploadError.message}`);
    }

    // Mise à jour du document avec le chemin du fichier généré
    await supabase
      .from('cv_documents')
      .update({
        generated_file_path: generatedPath,
        generated_file_type: 'docx' as any,
        status: 'completed' as any
      })
      .eq('id', cvDocumentId);

    console.log('[generate-cv-word] CV generated successfully:', generatedPath);

    return new Response(
      JSON.stringify({ 
        success: true, 
        file_path: generatedPath
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[generate-cv-word] Error:', error);
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
 * Génère le CV en utilisant l'IA pour faire le mapping intelligent
 */
async function generateCVWithAI(
  templateBuffer: Uint8Array,
  cvData: any,
  templateStructure: any
): Promise<Uint8Array> {
  console.log('[generateCVWithAI] Starting AI-powered generation...');

  if (!LOVABLE_API_KEY) {
    throw new Error('LOVABLE_API_KEY not configured');
  }

  // Préparer les données du CV pour l'IA
  const cvContent = {
    trigram: cvData.trigram || 'XXX',
    title: cvData.title || '',
    competences: cvData.competences || [],
    missions: cvData.missions || [],
    formations: cvData.formations || []
  };

  console.log('[generateCVWithAI] CV data prepared:', JSON.stringify(cvContent, null, 2).substring(0, 500));

  // Appeler l'IA pour créer le mapping
  const prompt = `Tu es un expert en génération de CV. Tu dois créer un document Word qui combine le contenu du CV avec la structure du template.

**Structure du template identifiée:**
${JSON.stringify(templateStructure, null, 2)}

**Contenu du CV à insérer:**
${JSON.stringify(cvContent, null, 2)}

Ta tâche: Créer un mapping précis qui indique:
1. Où placer chaque section du CV dans le template
2. Comment formater chaque élément pour respecter le style du template
3. Quelles données du CV correspondent à quelles sections du template

Réponds en JSON avec cette structure:
{
  "mapping": {
    "header": {
      "trigram": "${cvContent.trigram}",
      "title": "${cvContent.title}"
    },
    "competences": [
      // Pour chaque compétence, indiquer category et items
    ],
    "missions": [
      // Pour chaque mission, indiquer tous les champs
    ],
    "formations": [
      // Pour chaque formation, indiquer tous les champs
    ]
  },
  "instructions": "Instructions spécifiques pour adapter le contenu au template"
}`;

  console.log('[generateCVWithAI] Calling Lovable AI for mapping...');

  const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LOVABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
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
    console.error('[generateCVWithAI] AI API error:', aiResponse.status, errorText);
    // Fallback: utiliser directement les données sans mapping IA
    console.log('[generateCVWithAI] Falling back to direct mapping');
    return generateWithDirectMapping(templateBuffer, cvContent);
  }

  const aiResult = await aiResponse.json();
  const mappingText = aiResult.choices[0].message.content;
  console.log('[generateCVWithAI] AI mapping received');

  let mapping;
  try {
    mapping = JSON.parse(mappingText);
  } catch (e) {
    console.error('[generateCVWithAI] Failed to parse AI response, using fallback');
    return generateWithDirectMapping(templateBuffer, cvContent);
  }

  console.log('[generateCVWithAI] Applying AI mapping to template...');
  
  // Utiliser docxtemplater pour remplir le template avec le mapping IA
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  // Remplir avec les données mappées par l'IA
  const templateData = mapping.mapping || cvContent;
  
  console.log('[generateCVWithAI] Rendering template with data...');
  try {
    doc.render(templateData);
    console.log('[generateCVWithAI] Template rendered successfully');
  } catch (renderError: any) {
    console.error('[generateCVWithAI] Render error:', renderError);
    throw new Error(`Template rendering failed: ${renderError?.message || 'Unknown error'}`);
  }

  // Générer le fichier final
  const generatedBuffer = doc.getZip().generate({
    type: 'uint8array',
    compression: 'DEFLATE'
  });

  console.log('[generateCVWithAI] CV generated successfully, size:', generatedBuffer.length);
  return generatedBuffer;
}

/**
 * Génère le CV avec un mapping direct (fallback si l'IA échoue)
 */
function generateWithDirectMapping(
  templateBuffer: Uint8Array,
  cvData: any
): Uint8Array {
  console.log('[generateWithDirectMapping] Using direct mapping...');
  
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  console.log('[generateWithDirectMapping] Rendering with CV data...');
  doc.render(cvData);

  const generatedBuffer = doc.getZip().generate({
    type: 'uint8array',
    compression: 'DEFLATE'
  });

  console.log('[generateWithDirectMapping] Generated, size:', generatedBuffer.length);
  return generatedBuffer;
}
