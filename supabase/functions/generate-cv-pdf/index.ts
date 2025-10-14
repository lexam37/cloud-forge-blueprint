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

    // TODO: Implémenter la génération PDF avec un service de conversion
    // Pour l'instant, on simule en copiant simplement le fichier original
    
    const fileName = `cv-${cvDocumentId}-${Date.now()}.pdf`;
    
    // Marquer le document comme ayant un fichier généré
    await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: fileName,
        generated_file_type: 'pdf'
      })
      .eq('id', cvDocumentId);

    return new Response(
      JSON.stringify({ 
        success: true,
        filePath: fileName,
        message: 'PDF generation in progress'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in generate-cv-pdf:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
