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

    // Appeler l'IA pour extraire les données du CV
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `Tu es un expert en extraction de données de CV. Analyse le CV fourni et extrais TOUTES les informations au format JSON strict.
Extrait :
- Prénom et Nom (anonymise selon les règles : prénom → initiale, nom → deux initiales)
- Titre du poste/métier
- Années d'expérience (nombre)
- Projets clés avec : titre, poste, description
- Compétences (avec certifications si présentes) organisées par catégories
- Parcours académique et certificats (par date décroissante)
- Missions effectuées (ordre décroissant par date) avec : Client, Date, Poste, Contexte & Objectifs, Réalisations (rôle en liste à puces), Environnement technique

Retourne un JSON structuré avec tous ces éléments.`
          },
          {
            role: 'user',
            content: 'Analyse ce CV et extrais toutes les données pertinentes.'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'extract_cv_data',
              description: 'Extract all relevant data from a CV document',
              parameters: {
                type: 'object',
                properties: {
                  personal: {
                    type: 'object',
                    properties: {
                      first_name: { type: 'string' },
                      last_name: { type: 'string' },
                      anonymized_first: { type: 'string', description: 'Initiale du prénom' },
                      anonymized_last: { type: 'string', description: 'Deux initiales du nom' },
                      title: { type: 'string', description: 'Titre du métier/poste' },
                      years_experience: { type: 'number' }
                    },
                    required: ['first_name', 'last_name', 'anonymized_first', 'anonymized_last', 'title', 'years_experience']
                  },
                  key_projects: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        role: { type: 'string' },
                        description: { type: 'string' }
                      },
                      required: ['title', 'role', 'description']
                    }
                  },
                  skills: {
                    type: 'object',
                    properties: {
                      technical: { type: 'array', items: { type: 'string' } },
                      tools: { type: 'array', items: { type: 'string' } },
                      languages: { type: 'array', items: { type: 'string' } },
                      certifications: { type: 'array', items: { type: 'string' } }
                    }
                  },
                  education: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        degree: { type: 'string' },
                        institution: { type: 'string' },
                        year: { type: 'string' },
                        field: { type: 'string' }
                      }
                    }
                  },
                  missions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        client: { type: 'string' },
                        date_start: { type: 'string' },
                        date_end: { type: 'string' },
                        role: { type: 'string' },
                        context: { type: 'string' },
                        achievements: { type: 'array', items: { type: 'string' } },
                        environment: { type: 'array', items: { type: 'string' } }
                      }
                    }
                  }
                },
                required: ['personal', 'key_projects', 'skills', 'education', 'missions'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'extract_cv_data' } }
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', aiResponse.status, errorText);
      
      await supabase.from('processing_logs').insert({
        cv_document_id: cvDocumentId,
        step: 'error',
        message: 'AI extraction failed',
        details: { error: errorText, status: aiResponse.status }
      });

      if (aiResponse.status === 429) {
        throw new Error('Rate limit exceeded. Please try again later.');
      }
      if (aiResponse.status === 402) {
        throw new Error('Payment required. Please add funds to your workspace.');
      }
      throw new Error('AI extraction failed');
    }

    const aiData = await aiResponse.json();
    console.log('AI extraction successful');

    // Extraire les données structurées
    const toolCall = aiData.choices[0].message.tool_calls?.[0];
    if (!toolCall) {
      throw new Error('No structured data returned from AI');
    }

    const extractedData = JSON.parse(toolCall.function.arguments);
    console.log('Extracted data:', extractedData);

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
