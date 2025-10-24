import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";

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

    if (cvError || !cvDoc) throw new Error('CV document not found');

    const extractedData = cvDoc.extracted_data;
    if (!extractedData) throw new Error('No extracted data found');

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

    // Télécharger le template ORIGINAL (pas celui avec placeholders)
    const templatePath = template.file_path;
    console.log('[generate-cv-word] Downloading original template from:', templatePath);
    
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

    // Générer le CV avec l'IA
    console.log('[generate-cv-word] Génération du CV avec IA...');
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

    // Mise à jour du document
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
 * Utilise l'IA pour générer le CV en manipulant intelligemment le contenu Word
 */
async function generateCVWithAI(
  templateBuffer: Uint8Array,
  cvData: any,
  templateStructure: any
): Promise<Uint8Array> {
  console.log('[generateCVWithAI] Démarrage de la génération avec IA...');
  
  // Charger le template comme ZIP
  const zip = await JSZip.loadAsync(templateBuffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  
  if (!documentXml) {
    throw new Error('Impossible d\'extraire document.xml du template');
  }

  console.log('[generateCVWithAI] Template chargé, taille XML:', documentXml.length);

  // Préparer les données pour l'IA
  const promptData = {
    cvData: {
      trigram: cvData.header?.trigram || cvData.trigram || 'XXX',
      title: cvData.header?.title || cvData.title || 'Titre Professionnel',
      competences: extractCompetences(cvData),
      missions: extractMissions(cvData),
      formations: extractFormations(cvData)
    },
    templateStructure: templateStructure,
    xmlSample: documentXml.substring(0, 5000) // Premier extrait pour comprendre la structure
  };

  console.log('[generateCVWithAI] Données préparées:', JSON.stringify(promptData.cvData, null, 2));

  // Appeler l'IA pour obtenir les instructions de remplacement
  const aiInstructions = await callAIForReplacements(promptData, documentXml);
  
  console.log('[generateCVWithAI] Instructions IA reçues');

  // Appliquer les remplacements
  let modifiedXml = documentXml;
  
  // Remplacement du trigramme
  modifiedXml = replaceInXml(modifiedXml, /(<w:t>)[A-Z]{3}(<\/w:t>)/g, `$1${promptData.cvData.trigram}$2`);
  console.log('[generateCVWithAI] Trigramme remplacé:', promptData.cvData.trigram);

  // Remplacement du titre (premier texte long après le trigramme)
  let titleReplaced = false;
  modifiedXml = modifiedXml.replace(/<w:t>([^<>]{15,150})<\/w:t>/g, (match, content) => {
    if (!titleReplaced && !content.match(/^[A-Z]{3}$/)) {
      titleReplaced = true;
      console.log('[generateCVWithAI] Titre remplacé:', promptData.cvData.title);
      return `<w:t>${promptData.cvData.title}</w:t>`;
    }
    return match;
  });

  // Utiliser les instructions de l'IA pour remplacer les sections
  modifiedXml = await applyAISectionReplacements(modifiedXml, aiInstructions, promptData.cvData);

  // Sauvegarder le XML modifié
  zip.file('word/document.xml', modifiedXml);

  const result = await zip.generateAsync({ 
    type: 'uint8array',
    compression: 'DEFLATE'
  });

  console.log('[generateCVWithAI] Document généré, taille:', result.length);
  return result;
}

/**
 * Extrait toutes les compétences du CV
 */
function extractCompetences(cvData: any): string[] {
  const competences: string[] = [];
  if (cvData.skills?.subcategories) {
    for (const subcategory of cvData.skills.subcategories) {
      if (subcategory.items) {
        competences.push(...subcategory.items);
      }
    }
  }
  return competences;
}

/**
 * Extrait les missions formatées
 */
function extractMissions(cvData: any): Array<{title: string, client: string, period: string, description: string}> {
  return (cvData.missions || []).map((m: any) => ({
    title: m.role || m.title || '',
    client: m.client || '',
    period: `${m.date_start || ''} - ${m.date_end || ''}`,
    description: m.context || m.description || ''
  }));
}

/**
 * Extrait les formations formatées
 */
function extractFormations(cvData: any): Array<{title: string, institution: string, year: string}> {
  return (cvData.education || []).map((f: any) => ({
    title: f.degree || f.title || '',
    institution: f.institution || '',
    year: f.year || ''
  }));
}

/**
 * Appelle l'IA pour obtenir des instructions de remplacement
 */
async function callAIForReplacements(promptData: any, fullXml: string): Promise<any> {
  if (!LOVABLE_API_KEY) {
    console.warn('[callAIForReplacements] Pas de clé API Lovable, utilisation du mode simple');
    return { sections: [] };
  }

  const prompt = `Tu es un expert en manipulation de fichiers Word XML (format Office Open XML).

MISSION : Analyser ce document Word XML et fournir des instructions précises pour remplacer le contenu des sections par les données du CV.

DONNÉES DU CV :
${JSON.stringify(promptData.cvData, null, 2)}

STRUCTURE DU TEMPLATE :
${JSON.stringify(promptData.templateStructure, null, 2)}

EXTRAIT DU XML (premiers 5000 caractères) :
${promptData.xmlSample}

INSTRUCTIONS :
1. Identifie dans le XML les sections "Compétences", "Expérience" et "Formations"
2. Pour chaque section, trouve le paragraphe d'exemple à dupliquer
3. Retourne un JSON avec les instructions de remplacement

Format de réponse attendu :
{
  "sections": [
    {
      "name": "Compétences",
      "titleText": "Compétences",
      "exampleParagraph": "<w:p>...</w:p>",
      "items": ["item1", "item2"]
    }
  ]
}`;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Tu es un expert en manipulation de fichiers Word XML.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    
    // Extraire le JSON de la réponse
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { sections: [] };
    
  } catch (error) {
    console.error('[callAIForReplacements] Erreur:', error);
    return { sections: [] };
  }
}

/**
 * Applique les remplacements de sections basés sur les instructions de l'IA
 */
async function applyAISectionReplacements(
  xml: string,
  aiInstructions: any,
  cvData: any
): Promise<string> {
  let modifiedXml = xml;

  // Si pas d'instructions IA, utiliser une approche de secours simple
  if (!aiInstructions.sections || aiInstructions.sections.length === 0) {
    console.log('[applyAISectionReplacements] Mode de secours : remplacement simple');
    
    // Remplacement basique des compétences (remplacer les puces)
    let compIndex = 0;
    modifiedXml = modifiedXml.replace(/<w:t>([•·○▪▫-]\s*[^<]{3,100})<\/w:t>/g, (match) => {
      if (compIndex < cvData.competences.length) {
        const comp = cvData.competences[compIndex++];
        return `<w:t>• ${comp}</w:t>`;
      }
      return match;
    });
    
    console.log('[applyAISectionReplacements]', compIndex, 'compétences remplacées');
  } else {
    // Utiliser les instructions de l'IA
    for (const section of aiInstructions.sections) {
      console.log('[applyAISectionReplacements] Traitement section:', section.name);
      // TODO: Implémenter le remplacement intelligent basé sur les instructions
    }
  }

  return modifiedXml;
}

/**
 * Utilitaire pour remplacer dans le XML de manière sûre
 */
function replaceInXml(xml: string, pattern: RegExp, replacement: string): string {
  return xml.replace(pattern, replacement);
}

