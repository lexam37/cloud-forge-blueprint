import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const requestSchema = z.object({
  cvDocumentId: z.string().uuid({ message: 'cvDocumentId must be a valid UUID' })
});

/**
 * Edge function pour générer un CV Word à partir des données extraites
 * Utilise la bibliothèque docx pour créer un nouveau document avec les styles du template
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const { cvDocumentId } = requestSchema.parse(await req.json());
    console.log('[generate-cv-word] Starting generation for:', cvDocumentId);
    
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      throw new Error('User not authenticated');
    }

    console.log('[generate-cv-word] User authenticated:', user.id);

    // Récupérer le document CV
    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id)
      .single();

    if (cvError || !cvDoc) {
      console.error('[generate-cv-word] CV not found:', cvError);
      throw new Error('CV document not found or access denied');
    }

    const extractedData = cvDoc.extracted_data;
    if (!extractedData) {
      throw new Error('No extracted data found - CV not processed yet');
    }

    console.log('[generate-cv-word] CV data loaded, template_id:', cvDoc.template_id);

    // Vérifier qu'un template est sélectionné
    if (!cvDoc.template_id) {
      throw new Error('No template selected for this CV');
    }

    // Récupérer le template
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('file_path, structure_data, name')
      .eq('id', cvDoc.template_id)
      .single();

    if (templateError || !template) {
      console.error('[generate-cv-word] Template not found:', templateError);
      throw new Error('Template not found');
    }

    console.log('[generate-cv-word] Using template:', template.name);

    // Télécharger le fichier template
    const { data: templateFile, error: downloadError } = await supabase
      .storage
      .from('cv-templates')
      .download(template.file_path);

    if (downloadError || !templateFile) {
      console.error('[generate-cv-word] Template download error:', downloadError);
      throw new Error(`Failed to download template: ${downloadError?.message}`);
    }

    const templateBuffer = await templateFile.arrayBuffer();
    console.log('[generate-cv-word] Template downloaded, size:', templateBuffer.byteLength, 'bytes');

    async function generateCVWithJSZip(
      templateBuffer: ArrayBuffer,
      cvData: any,
      templateStructure: any
    ) {
      console.log('[generateCVWithJSZip] Starting...');
      
      const zip = new JSZip();
      await zip.loadAsync(templateBuffer);
      
      // Extraire document.xml
      const docXml = await zip.file("word/document.xml")?.async("string");
      if (!docXml) throw new Error("Cannot extract document.xml from template");
      
      console.log('[generateCVWithJSZip] Extracted document.xml, length:', docXml.length);
      
      // Remplacer le trigramme
      let modifiedXml = docXml.replace(
        /CVA|Trigramme|XXX/g, 
        cvData.header?.trigram || 'XXX'
      );
      
      // Remplacer le titre
      modifiedXml = modifiedXml.replace(
        /Analyste Fonctionnel \/ Product Owner|Titre du poste/g,
        cvData.header?.title || 'Poste'
      );
      
      // Remplacer les compétences (simple remplacement pour démarrer)
      if (cvData.skills?.subcategories) {
        const competencesText = cvData.skills.subcategories
          .map((cat: any) => `${cat.name}: ${cat.items.join(', ')}`)
          .join('\n');
        
        modifiedXml = modifiedXml.replace(
          /<w:t>Langage\/BDD:.*?<\/w:t>/g,
          `<w:t>${competencesText}</w:t>`
        );
      }
      
      console.log('[generateCVWithJSZip] Replacements done');
      
      // Réinsérer le XML modifié
      zip.file("word/document.xml", modifiedXml);
      
      // Générer le nouveau fichier
      const generatedBuffer = await zip.generateAsync({ 
        type: "uint8array",
        compression: "DEFLATE"
      });
      
      console.log('[generateCVWithJSZip] Generated buffer size:', generatedBuffer.length);
      
      return generatedBuffer;
    }

      try {
        const generatedBuffer = await generateCVWithJSZip(
          templateBuffer,
          extractedData,
          template.structure_data
        );
        console.log('[generate-cv-word] CV generated successfully');
      } catch (genError) {
        console.error('[generate-cv-word] Generation failed:', genError);
        throw new Error(`CV generation failed: ${genError.message}`);
      }
      
    console.log('[generate-cv-word] CV generated successfully');

    // Upload du fichier généré
    const trigram = (extractedData as any)?.header?.trigram || 'XXX';
    const title = (extractedData as any)?.header?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'Poste';
    const generatedFileName = `${trigram}_DC_${title}_${Date.now()}.docx`;
    const generatedPath = `${user.id}/${generatedFileName}`;
    
    console.log('[generate-cv-word] Uploading to:', generatedPath);
    
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

    console.log('[generate-cv-word] File uploaded successfully');

    // Mise à jour du document avec le chemin du fichier généré
    const { error: updateError } = await supabase
      .from('cv_documents')
      .update({
        generated_file_path: generatedPath,
        generated_file_type: 'docx' as any
      })
      .eq('id', cvDocumentId);

    if (updateError) {
      console.error('[generate-cv-word] Update error:', updateError);
      throw new Error(`Failed to update CV document: ${updateError.message}`);
    }

    // Log de succès
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'generation',
      message: 'Word CV generated successfully',
      details: { 
        file_path: generatedPath,
        generation_time_ms: Date.now() - startTime
      },
      user_id: user.id
    });

    console.log('[generate-cv-word] Complete in', Date.now() - startTime, 'ms');

    return new Response(
      JSON.stringify({ 
        success: true, 
        file_path: generatedPath,
        file_name: generatedFileName
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[generate-cv-word] Error:', error);
    
    // Log de l'erreur
    try {
      const body = await req.clone().json();
      const { cvDocumentId } = body;
      
      if (cvDocumentId) {
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL')!, 
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );
        const authHeader = req.headers.get('Authorization');
        
        if (authHeader) {
          const jwt = authHeader.replace('Bearer ', '');
          const { data: { user } } = await supabase.auth.getUser(jwt);
          
          await supabase.from('processing_logs').insert({
            cv_document_id: cvDocumentId,
            step: 'error',
            message: `Generation failed: ${error.message}`,
            user_id: user?.id || null
          });
        }
      }
    } catch (logError) {
      console.error('[generate-cv-word] Error logging failure:', logError);
    }

    return new Response(
      JSON.stringify({ 
        error: error.message || 'Unknown error during CV generation'
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
