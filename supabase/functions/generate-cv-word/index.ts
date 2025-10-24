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

    // Utiliser l'IA pour générer directement le XML final
    console.log('[generate-cv-word] Generating CV with AI-powered XML generation...');
    const generatedBuffer = await generateCVWithAIXML(
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
 * Génère le CV en demandant à l'IA de modifier directement le XML du template
 */
async function generateCVWithAIXML(
  templateBuffer: Uint8Array,
  cvData: any,
  templateStructure: any
): Promise<Uint8Array> {
  console.log('[generateCVWithAIXML] Starting AI-powered XML generation...');

  if (!LOVABLE_API_KEY) {
    throw new Error('LOVABLE_API_KEY not configured');
  }

  // Charger le template comme ZIP
  const zip = await JSZip.loadAsync(templateBuffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  
  if (!documentXml) {
    throw new Error('Could not extract document.xml from template');
  }

  console.log('[generateCVWithAIXML] Extracted XML, length:', documentXml.length);

  // Préparer un résumé du XML (trop long sinon)
  const xmlSummary = extractXMLSummary(documentXml);
  
  // Préparer les données du CV
  const cvContent = {
    trigram: cvData.trigram || 'XXX',
    title: cvData.title || '',
    competences: cvData.competences || [],
    missions: (cvData.missions || []).slice(0, 3), // Limiter à 3 missions pour l'exemple
    formations: (cvData.formations || []).slice(0, 3)
  };

  console.log('[generateCVWithAIXML] CV data prepared');

  // Prompt pour l'IA
  const prompt = `Tu es un expert en manipulation de documents Word XML. Tu dois modifier le XML d'un template de CV pour y insérer les données d'un CV.

**IMPORTANT**: Tu dois CONSERVER la structure XML EXACTEMENT, juste remplacer le contenu exemple par les vraies données.

**Structure du template:**
${JSON.stringify(templateStructure, null, 2)}

**Résumé du XML (sections importantes):**
${xmlSummary}

**Données du CV à insérer:**
\`\`\`json
${JSON.stringify(cvContent, null, 2)}
\`\`\`

**Ta tâche:**
1. Repère dans le XML où se trouvent les sections (Compétences, Expérience, Formations)
2. Remplace le CONTENU exemple par les vraies données du CV
3. Conserve TOUS les attributs de style, formatage, couleurs, polices
4. Pour les sections répétitives (compétences, missions), duplique les paragraphes XML nécessaires

**Règles critiques:**
- Ne change QUE le texte entre les balises <w:t>...</w:t>
- Conserve TOUTES les balises de style (<w:rPr>, <w:pPr>, etc.)
- Pour les listes, duplique les paragraphes <w:p>...</w:p>
- Remplace le trigramme (3 lettres majuscules) par: ${cvContent.trigram}
- Remplace le titre professionnel par: ${cvContent.title}

Génère le XML modifié complet. CRITIQUE: Réponds UNIQUEMENT avec le XML, sans texte avant ou après, sans markdown.`;

  console.log('[generateCVWithAIXML] Calling Lovable AI for XML generation...');

  // Appeler l'IA en plusieurs fois si nécessaire (le XML peut être long)
  const chunks = splitXMLForAI(documentXml);
  let modifiedXml = documentXml;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[generateCVWithAIXML] Processing chunk ${i + 1}/${chunks.length}...`);

    const chunkPrompt = `Modifie cette partie du XML en insérant les données du CV.
    
**Données du CV:**
- Trigramme: ${cvContent.trigram}
- Titre: ${cvContent.title}
- ${cvContent.competences.length} compétences
- ${cvContent.missions.length} missions
- ${cvContent.formations.length} formations

**XML à modifier:**
\`\`\`xml
${chunk.xml}
\`\`\`

Réponds UNIQUEMENT avec le XML modifié, sans texte supplémentaire.`;

    try {
      const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash', // Utiliser flash pour économiser des tokens
          messages: [
            {
              role: 'system',
              content: 'Tu es un expert en XML Word. Réponds UNIQUEMENT avec du XML valide, sans commentaires ni texte explicatif.'
            },
            {
              role: 'user',
              content: chunkPrompt
            }
          ],
          temperature: 0.1,
          max_tokens: 8000
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error('[generateCVWithAIXML] AI error:', aiResponse.status, errorText);
        console.error('[generateCVWithAIXML] Skipping chunk due to error');
        continue; // Passer au chunk suivant
      }

      // Vérifier que la réponse n'est pas vide
      const responseText = await aiResponse.text();
      if (!responseText || responseText.trim() === '') {
        console.error('[generateCVWithAIXML] Empty response from AI');
        continue;
      }

      // Parser le JSON
      const aiResult = JSON.parse(responseText);
      
      if (!aiResult.choices?.[0]?.message?.content) {
        console.error('[generateCVWithAIXML] No content in AI response');
        continue;
      }

      let modifiedChunk = aiResult.choices[0].message.content;
      
      // Nettoyer la réponse (enlever les markdown si présents)
      modifiedChunk = modifiedChunk.replace(/```xml\n?/g, '').replace(/```\n?/g, '').trim();
      
      // Remplacer le chunk original par le chunk modifié
      modifiedXml = modifiedXml.replace(chunk.xml, modifiedChunk);
      
      console.log(`[generateCVWithAIXML] Chunk ${i + 1} processed`);
    } catch (error) {
      console.error(`[generateCVWithAIXML] Error processing chunk ${i + 1}:`, error);
      console.error('[generateCVWithAIXML] Skipping chunk and continuing...');
      // Continue avec le chunk suivant sans modifier le XML
    }
  }

  console.log('[generateCVWithAIXML] AI processing complete, rebuilding document...');

  // Mettre à jour le XML dans le ZIP
  zip.file('word/document.xml', modifiedXml);

  // Générer le nouveau DOCX
  const generatedBuffer = await zip.generateAsync({ 
    type: 'uint8array',
    compression: 'DEFLATE'
  });

  console.log('[generateCVWithAIXML] Document generated, size:', generatedBuffer.length);
  return generatedBuffer;
}

/**
 * Extrait un résumé du XML pour réduire la taille envoyée à l'IA
 */
function extractXMLSummary(xml: string): string {
  const sections = [];
  
  // Extraire les paragraphes principaux
  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  
  for (let i = 0; i < Math.min(paragraphs.length, 30); i++) {
    const p = paragraphs[i];
    const textMatches = p.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || [];
    const text = textMatches
      .map((t: string) => t.replace(/<\/?w:t[^>]*>/g, ''))
      .join(' ')
      .trim();
    
    if (text.length > 0 && text.length < 100) {
      sections.push(`[Para ${i}]: "${text}"`);
    }
  }
  
  return sections.slice(0, 20).join('\n');
}

/**
 * Divise le XML en chunks pour traitement par l'IA
 */
function splitXMLForAI(xml: string): Array<{xml: string, type: string}> {
  const chunks = [];
  
  // Chunk 1: Header (premiers 15000 caractères)
  const headerChunk = xml.substring(0, 15000);
  chunks.push({ xml: headerChunk, type: 'header' });
  
  // Chunk 2: Body (milieu)
  if (xml.length > 30000) {
    const bodyChunk = xml.substring(15000, 30000);
    chunks.push({ xml: bodyChunk, type: 'body' });
  }
  
  // Chunk 3: Reste
  if (xml.length > 30000) {
    const footerChunk = xml.substring(30000);
    if (footerChunk.length < 15000) {
      chunks.push({ xml: footerChunk, type: 'footer' });
    }
  }
  
  return chunks;
}
