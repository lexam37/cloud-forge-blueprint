import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { cvDocumentId } = await req.json();
    
    if (!cvDocumentId) {
      throw new Error('cvDocumentId is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Récupérer les données du CV
    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .single();

    if (cvError || !cvDoc) {
      throw new Error('CV document not found');
    }

    // Récupérer le profil commercial
    const { data: commercial, error: commercialError } = await supabase
      .from('commercial_profiles')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Récupérer un template actif
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    console.log('CV data:', cvDoc.extracted_data);
    console.log('Commercial:', commercial);
    console.log('Template:', template);

    // Récupérer le fichier CV original
    const { data: originalFile, error: downloadError } = await supabase.storage
      .from('cv-uploads')
      .download(cvDoc.original_file_path);

    if (downloadError) {
      throw new Error('Failed to download original CV file');
    }

    // Pour l'instant, copier le fichier original dans le bucket generated
    // TODO: Implémenter la vraie génération avec le template
    const fileName = `cv-${cvDocumentId}-${Date.now()}.docx`;
    
    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(fileName, originalFile, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      throw new Error('Failed to upload generated Word file');
    }
    
    // Marquer le document comme ayant un fichier généré
    await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: fileName,
        generated_file_type: 'docx'
      })
      .eq('id', cvDocumentId);

    return new Response(
      JSON.stringify({ 
        success: true,
        filePath: fileName,
        message: 'Word generation in progress'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in generate-cv-word:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
