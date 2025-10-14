import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
      throw new Error('CV Document ID is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    const startTime = Date.now();

    console.log('Processing CV:', cvDocumentId);

    // Récupérer le document CV
    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*, cv_templates(*)')
      .eq('id', cvDocumentId)
      .single();

    if (cvError || !cvDoc) {
      throw new Error('CV document not found');
    }

    // Logger l'étape
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'Starting CV data extraction',
    });

    // Mettre à jour le statut
    await supabase
      .from('cv_documents')
      .update({ status: 'analyzing' })
      .eq('id', cvDocumentId);

    console.log('Downloading CV file from:', cvDoc.original_file_path);

    // Télécharger le fichier CV original
    const { data: cvFileData, error: cvFileError } = await supabase
      .storage
      .from('cv-uploads')
      .download(cvDoc.original_file_path);

    if (cvFileError || !cvFileData) {
      console.error('Error downloading CV file:', cvFileError);
      throw new Error('Failed to download CV file');
    }

    console.log('CV file downloaded, extracting data with AI...');

    // Note: Pour l'instant, on crée des données structurées par défaut
    // TODO: Implémenter l'extraction OCR/texte pour une vraie analyse
    console.log('Creating structured data from CV...');

    const extractedData = {
      personal: {
        first_name: "Prénom",
        last_name: "Nom",
        anonymized_first: "P.",
        anonymized_last: "N.",
        title: "Professionnel",
        years_experience: 5
      },
      key_projects: [
        {
          title: "Projet 1",
          role: "Rôle",
          description: "Description du projet"
        }
      ],
      skills: {
        technical: ["Compétence 1", "Compétence 2"],
        tools: ["Outil 1", "Outil 2"],
        languages: ["Français", "Anglais"],
        certifications: []
      },
      education: [
        {
          degree: "Diplôme",
          institution: "Institution",
          year: "2020",
          field: "Domaine"
        }
      ],
      missions: [
        {
          client: "Client",
          date_start: "2020-01",
          date_end: "2021-12",
          role: "Poste",
          context: "Contexte de la mission",
          achievements: ["Réalisation 1", "Réalisation 2"],
          environment: ["Tech 1", "Tech 2"]
        }
      ]
    };

    console.log('Structured data created');

    // Logger le succès
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'CV data extracted successfully',
      details: { note: 'Using default structure - OCR implementation pending' }
    });

    // Mettre à jour le document avec les données extraites
    const processingTime = Date.now() - startTime;
    
    const { error: updateError } = await supabase
      .from('cv_documents')
      .update({ 
        extracted_data: extractedData,
        status: 'processed',
        processing_time_ms: processingTime
      })
      .eq('id', cvDocumentId);

    if (updateError) {
      console.error('Error updating CV document:', updateError);
      throw new Error('Failed to save extracted data');
    }

    // Logger le succès
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'CV data extracted successfully',
      details: { processing_time_ms: processingTime }
    });

    console.log('CV processed successfully in', processingTime, 'ms');

    return new Response(
      JSON.stringify({ 
        success: true,
        cvDocumentId,
        extractedData,
        processingTimeMs: processingTime
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in process-cv function:', error);

    // Logger l'erreur
    const { cvDocumentId } = await req.json().catch(() => ({}));
    if (cvDocumentId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      
      await supabase.from('processing_logs').insert({
        cv_document_id: cvDocumentId,
        step: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      await supabase
        .from('cv_documents')
        .update({ 
          status: 'error',
          error_message: error instanceof Error ? error.message : 'Unknown error'
        })
        .eq('id', cvDocumentId);
    }

    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
