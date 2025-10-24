import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import mammoth from "https://esm.sh/mammoth@1.6.0";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.43/deno-dom-wasm.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const requestSchema = z.object({
  cvDocumentId: z.string().uuid({ message: 'cvDocumentId must be a valid UUID' })
});

/**
 * Point d'entrée principal de l'edge function
 * Gère l'extraction des données d'un CV en utilisant l'IA
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { cvDocumentId } = requestSchema.parse(await req.json());
    console.log('[process-cv] Processing CV:', cvDocumentId);
    
    // Authentification
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!supabaseUrl || !supabaseKey || !lovableApiKey) {
      throw new Error('Missing environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Vérification de l'utilisateur
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) throw new Error('User not authenticated');

    const startTime = Date.now();

    // Récupération du template actif pour ce traitement
    const { data: activeTemplate, error: templateError } = await supabase
      .from('cv_templates')
      .select('id, structure_data')
      .eq('is_active', true)
      .eq('user_id', user.id)
      .single();

    if (templateError || !activeTemplate) {
      console.warn('[process-cv] No active template found, proceeding without template structure');
    }

    console.log('[process-cv] Active template:', activeTemplate?.id || 'none');

    // Récupération du document CV
    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id)
      .single();

    if (cvError || !cvDoc) {
      throw new Error('CV document not found or not owned by user');
    }

    const templateStructure = activeTemplate?.structure_data || {};
    
    console.log('[process-cv] Starting CV extraction...');
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'Starting CV data extraction',
      user_id: user.id
    });

    await supabase
      .from('cv_documents')
      .update({ status: 'analyzing' })
      .eq('id', cvDocumentId)
      .eq('user_id', user.id);

    // Téléchargement du fichier CV
    const { data: cvFileData, error: cvFileError } = await supabase
      .storage
      .from('cv-uploads')
      .download(cvDoc.original_file_path);

    if (cvFileError || !cvFileData) {
      throw new Error('Failed to download CV file');
    }

    // Extraction du contenu du CV
    const extractedContent = await extractCVContent(
      cvFileData, 
      cvDoc.original_file_type
    );
    
    console.log('[process-cv] Extracted', extractedContent.length, 'elements');

    // Envoi à l'IA pour analyse et anonymisation
    const extractedData = await processWithAI(
      extractedContent,
      templateStructure,
      lovableApiKey
    );

    console.log('[process-cv] AI processing complete');

    // Sauvegarde temporaire des données extraites
    await supabase
      .from('cv_documents')
      .update({ 
        extracted_data: extractedData,
        template_id: activeTemplate?.id || null,
        status: 'analyzing'
      })
      .eq('id', cvDocumentId)
      .eq('user_id', user.id);

    // Générer immédiatement le CV Word
    console.log('[process-cv] Starting Word generation...');
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'generation',
      message: 'Starting Word CV generation',
      user_id: user.id
    });

    const { data: generateData, error: generateError } = await supabase.functions.invoke('generate-cv-word', {
      body: { cvDocumentId }
    });

    if (generateError) {
      console.error('[process-cv] Generation error:', generateError);
      await supabase.from('processing_logs').insert({
        cv_document_id: cvDocumentId,
        step: 'error',
        message: `Word generation failed: ${generateError.message}`,
        user_id: user.id
      });
      throw new Error(`Word generation failed: ${generateError.message}`);
    }

    const processingTime = Date.now() - startTime;
    
    // Mise à jour finale avec statut completed
    await supabase
      .from('cv_documents')
      .update({ 
        status: 'processed',
        processing_time_ms: processingTime
      })
      .eq('id', cvDocumentId)
      .eq('user_id', user.id);

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'complete',
      message: 'CV processing completed successfully',
      details: { processing_time_ms: processingTime },
      user_id: user.id
    });

    console.log('[process-cv] Complete processing finished in', processingTime, 'ms');

    return new Response(
      JSON.stringify({ 
        success: true,
        cvDocumentId,
        extractedData,
        processingTimeMs: processingTime,
        generatedFilePath: generateData?.file_path
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[process-cv] Error:', error);
    
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
            message: error instanceof Error ? error.message : 'Unknown error',
            user_id: user?.id || null
          });
          
          await supabase
            .from('cv_documents')
            .update({ 
              status: 'error',
              error_message: error instanceof Error ? error.message : 'Unknown error'
            })
            .eq('id', cvDocumentId);
        }
      }
    } catch (logError) {
      console.error('[process-cv] Error logging failure:', logError);
    }
    
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

/**
 * Extrait le contenu structuré d'un fichier CV (DOCX)
 * @param fileData - Données du fichier
 * @param fileType - Type de fichier (docx, pdf)
 * @returns Tableau d'éléments extraits avec leur texte et métadonnées
 */
async function extractCVContent(fileData: Blob, fileType: string) {
  console.log('[extractCVContent] Processing', fileType, 'file');
  
  if (fileType !== 'docx' && fileType !== 'doc') {
    throw new Error(`Unsupported file type: ${fileType}`);
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const html = result.value;
  
  if (result.messages && result.messages.length > 0) {
    console.warn('[extractCVContent] Conversion warnings:', result.messages);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  if (!doc) throw new Error('Failed to parse HTML document');

  const elements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, table');
  const extractedContent: any[] = [];

  elements.forEach((element: any, index: number) => {
    const text = element.textContent.trim();
    if (!text || text.length < 2) return;

    // Extraction des métadonnées de l'élément
    const styleAttr = element.getAttribute('style') || '';
    const isBold = styleAttr.includes('font-weight:bold');
    const isItalic = styleAttr.includes('font-style:italic');
    const fontSize = styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim();
    const isList = element.tagName === 'LI' || /^[•\-\*°\u2022\u25CF]/.test(text);
    
    extractedContent.push({
      text,
      index,
      metadata: {
        isBold,
        isItalic,
        fontSize,
        isList,
        tagName: element.tagName
      }
    });
  });

  return extractedContent;
}

/**
 * Traite le contenu extrait avec l'IA pour anonymisation et structuration
 * @param content - Contenu extrait du CV
 * @param templateStructure - Structure du template à respecter
 * @param apiKey - Clé API Lovable AI
 * @returns Données extraites et anonymisées
 */
async function processWithAI(
  content: any[], 
  templateStructure: any,
  apiKey: string
) {
  console.log('[processWithAI] Sending to AI...');
  
  const sectionNames = templateStructure.sections?.map((s: any) => s.name) || [
    'Compétences', 
    'Expérience', 
    'Formations & Certifications'
  ];

  const systemPrompt = `Tu es un expert en extraction et anonymisation de CV professionnels.

MISSION : Analyser le CV fourni et extraire TOUTES les informations en les ANONYMISANT complètement.

RÈGLES D'ANONYMISATION :
1. Créer un TRIGRAMME : première lettre du prénom + première lettre du nom + dernière lettre du nom
   Exemple : Jean DUPONT → JDT, Marie MARTIN → MMN
2. SUPPRIMER toutes les informations personnelles identifiantes :
   - Nom et prénom complets
   - Adresse email personnelle
   - Numéro de téléphone personnel
   - Adresse postale complète
   - Photos et QR codes
   - Liens vers profils sociaux (LinkedIn, GitHub, etc.)
3. CONSERVER les informations professionnelles anonymisées :
   - Années d'expérience
   - Compétences techniques et fonctionnelles
   - Entreprises clientes (noms conservés)
   - Formations et certifications (sans informations personnelles)

STRUCTURE À RESPECTER :
Sections du template : ${sectionNames.join(', ')}

EXTRACTION PAR SECTION :

**Compétences** :
- Regrouper par sous-catégories (ex: "Langages/BDD", "OS", "Outils", "Méthodologies")
- Format: "Catégorie: item1, item2, item3"
- Conserver la casse exacte

**Expériences** :
Pour chaque mission :
- Titre: "MM/YYYY - MM/YYYY Rôle @ Client"
- Dates: date_start (MM/YYYY), date_end (MM/YYYY ou "Actuellement")
- Client: nom(s) après "@"
- Lieu: ville/pays si mentionné
- Contexte: description du contexte/objectifs
- Missions: liste des réalisations/tâches
- Environnement: technologies utilisées

**Formations & Certifications** :
- Diplôme/Certification: nom complet
- Date: année ou MM/YYYY
- Institution: nom (ANONYMISER si nécessaire)
- Lieu: ville/pays

SORTIE REQUISE :
Retourne un JSON strictement conforme à cette structure :

{
  "header": {
    "trigram": "XXX",
    "title": "titre professionnel",
    "commercial_contact": {
      "text": "Contact Commercial",
      "enabled": true
    }
  },
  "footer": {
    "text": "texte du pied de page ou vide"
  },
  "personal": {
    "years_experience": nombre
  },
  "skills": {
    "subcategories": [
      {
        "name": "Catégorie",
        "items": ["item1", "item2"]
      }
    ],
    "languages": ["langue1", "langue2"],
    "certifications": []
  },
  "education": [
    {
      "degree": "diplôme",
      "institution": "organisme",
      "year": "YYYY",
      "location": "ville"
    }
  ],
  "missions": [
    {
      "client": "nom client",
      "date_start": "MM/YYYY",
      "date_end": "MM/YYYY",
      "role": "rôle",
      "location": "ville",
      "context": "description",
      "achievements": ["mission1", "mission2"],
      "environment": ["tech1", "tech2"]
    }
  ]
}`;

  const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { 
          role: 'user', 
          content: `Contenu du CV à analyser et anonymiser :\n\n${JSON.stringify(content, null, 2)}` 
        }
      ],
      temperature: 0.1,
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    console.error('[processWithAI] AI API error:', aiResponse.status, errorText);
    throw new Error(`AI extraction failed: ${aiResponse.status}`);
  }

  const aiData = await aiResponse.json();
  const content_text = aiData.choices?.[0]?.message?.content;
  if (!content_text) throw new Error('No content in AI response');

  // Extraction du JSON de la réponse
  let extractedData: any;
  try {
    const jsonMatch = content_text.match(/```json\s*([\s\S]*?)\s*```/) || 
                     content_text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content_text;
    extractedData = JSON.parse(jsonStr);
  } catch (parseError) {
    console.error('[processWithAI] JSON parse error:', parseError);
    console.error('[processWithAI] AI response:', content_text.substring(0, 500));
    throw new Error('Failed to parse AI extraction result');
  }

  console.log('[processWithAI] Successfully extracted and anonymized data');
  return extractedData;
}
