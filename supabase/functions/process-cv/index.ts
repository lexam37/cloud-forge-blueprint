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

    // Convertir le PDF en base64 pour l'envoyer à l'IA
    console.log('Converting CV to base64...');
    const arrayBuffer = await cvFileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    
    // Conversion en base64 par chunks pour éviter les problèmes de mémoire
    let base64 = '';
    const chunkSize = 1024 * 1024; // 1MB chunks
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      const binaryString = Array.from(chunk)
        .map(byte => String.fromCharCode(byte))
        .join('');
      base64 += btoa(binaryString);
    }

    console.log('CV converted to base64, extracting data with AI...');

    // Extraction avec l'IA
    const systemPrompt = `Tu es un expert en extraction de données de CV. Analyse ce CV et extrais TOUTES les informations de manière structurée.

IMPORTANT : 
1. Extrais les informations personnelles (nom, prénom, titre, années d'expérience)
2. Pour l'ANONYMISATION, génère des initiales : première lettre du prénom suivie d'un point, première lettre du nom suivie d'un point
3. Extrais TOUS les projets clés avec titre, rôle et description détaillée
4. Extrais TOUTES les compétences : techniques, outils, langues, certifications
5. Extrais TOUTE la formation : diplômes, institutions, années, domaines
6. Extrais TOUTES les missions : client, dates, rôle, contexte, réalisations, environnement technique

Retourne un JSON avec cette structure EXACTE :
{
  "personal": {
    "first_name": "prénom extrait",
    "last_name": "nom extrait",
    "anonymized_first": "première lettre du prénom + point (ex: J.)",
    "anonymized_last": "première lettre du nom + point (ex: D.)",
    "title": "titre professionnel",
    "years_experience": nombre_années
  },
  "key_projects": [
    {
      "title": "titre du projet",
      "role": "rôle dans le projet",
      "description": "description détaillée"
    }
  ],
  "skills": {
    "technical": ["compétence1", "compétence2"],
    "tools": ["outil1", "outil2"],
    "languages": ["langue1", "langue2"],
    "certifications": ["cert1", "cert2"]
  },
  "education": [
    {
      "degree": "diplôme",
      "institution": "établissement",
      "year": "année",
      "field": "domaine"
    }
  ],
  "missions": [
    {
      "client": "nom client",
      "date_start": "YYYY-MM",
      "date_end": "YYYY-MM ou 'Présent'",
      "role": "poste occupé",
      "context": "contexte de la mission",
      "achievements": ["réalisation1", "réalisation2"],
      "environment": ["tech1", "tech2"]
    }
  ]
}`;

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-pro',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: systemPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:application/pdf;base64,${base64}`
                }
              }
            ]
          }
        ],
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', aiResponse.status, errorText);
      throw new Error('AI extraction failed');
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No content in AI response');
    }

    console.log('AI extraction response:', content);

    // Parser la réponse JSON
    let extractedData;
    try {
      // Extraire le JSON de la réponse (peut être entouré de ```json ... ```)
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      extractedData = JSON.parse(jsonStr);
      console.log('Successfully parsed extracted data');
    } catch (parseError) {
      console.error('Error parsing AI response:', parseError);
      throw new Error('Failed to parse AI extraction result');
    }

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
