import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { convert } from "https://esm.sh/mammoth@1.6.0";
import { parse as parsePdf } from "https://esm.sh/pdf-parse@1.1.1";

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
    if (!cvDocumentId) throw new Error('CV Document ID is required');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const startTime = Date.now();
    console.log('Processing CV:', cvDocumentId);

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*, cv_templates(structure_data)')
      .eq('id', cvDocumentId)
      .single();

    if (cvError || !cvDoc) throw new Error('CV document not found');

    const templateStructure = cvDoc.cv_templates?.structure_data || {};
    const sectionNames = templateStructure.sections?.map((s: any) => s.name) || ['Compétences', 'Expérience', 'Formations & Certifications'];
    const skillSubcategories = templateStructure.element_styles?.skill_subcategories?.map((sc: any) => sc.name) || ['Langage/BDD', 'OS', 'Outils', 'Méthodologies'];
    const hasCommercialContact = templateStructure.element_styles?.commercial_contact?.position === 'header';

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'Starting CV data extraction',
    });

    await supabase.from('cv_documents').update({ status: 'analyzing' }).eq('id', cvDocumentId);

    const { data: cvFileData, error: cvFileError } = await supabase
      .storage
      .from('cv-uploads')
      .download(cvDoc.original_file_path);

    if (cvFileError || !cvFileData) throw new Error('Failed to download CV file');

    let extractedText = '';
    let structuredData: any[] = [];
    const fileType = cvDoc.original_file_type;

    try {
      const arrayBuffer = await cvFileData.arrayBuffer();
      if (fileType === 'docx' || fileType === 'doc') {
        const { value: html } = await convert({ arrayBuffer });
        console.log('Extracted HTML from CV:', html.substring(0, 500));

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const paragraphs = doc.querySelectorAll('p');
        console.log('Paragraphs found:', paragraphs.length);

        let currentSubcategory = '';
        let skillItems: string[] = [];
        paragraphs.forEach((p: any) => {
          const text = p.textContent.trim().replace(/^[•\-\*É°\u2022\u25CF]\s*/g, '');
          if (!text) return;

          const styleAttr = p.getAttribute('style') || '';
          const style = {
            font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Arial',
            size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
            color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
            bold: styleAttr.includes('font-weight:bold'),
            italic: styleAttr.includes('font-style:italic'),
            bullet: p.querySelector('li') || text.match(/^[•\-\*É°\u2022\u25CF]/) ? true : false
          };

          if (style.bullet && currentSubcategory) {
            skillItems.push(text);
          } else if (skillSubcategories.some(sc => text.toLowerCase().includes(sc.toLowerCase()))) {
            if (skillItems.length > 0) {
              structuredData.push({
                text: `${currentSubcategory}: ${skillItems.join(', ')}`,
                style: { ...style, bullet: false }
              });
              skillItems = [];
            }
            currentSubcategory = text;
            structuredData.push({ text, style });
          } else {
            if (skillItems.length > 0) {
              structuredData.push({
                text: `${currentSubcategory}: ${skillItems.join(', ')}`,
                style: { ...style, bullet: false }
              });
              skillItems = [];
              currentSubcategory = '';
            }
            structuredData.push({ text, style });
          }
        });

        if (skillItems.length > 0) {
          structuredData.push({
            text: `${currentSubcategory}: ${skillItems.join(', ')}`,
            style: { bullet: false }
          });
        }

        extractedText = structuredData.map((p: any) => p.text).join('\n');
      } else if (fileType === 'pdf') {
        const data = await parsePdf(arrayBuffer);
        extractedText = data.text.replace(/^[•\-\*É°\u2022\u25CF]\s*/gm, '').replace(/\s+/g, ' ').trim();
        structuredData = extractedText.split('\n').map(line => ({
          text: line.trim(),
          style: { font: 'Unknown', size: 'Unknown', color: '#000000', bold: false, italic: false, bullet: false, case: 'mixed' }
        }));
      } else {
        throw new Error(`Unsupported file type: ${fileType}`);
      }

      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text could be extracted from the file');
      }
      console.log('StructuredData:', JSON.stringify(structuredData, null, 2));
    } catch (extractError) {
      console.error('Error extracting text:', extractError);
      throw new Error(`Failed to extract text from ${fileType} file`);
    }

    const sectionSynonyms = {
      'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
      'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
      'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
    };

    const systemPrompt = `Tu es un expert en extraction et anonymisation de CV. Analyse ce CV et extrais TOUTES les informations en les ANONYMISANT, en respectant la structure du template suivant : ${JSON.stringify(sectionNames)}.

ÉTAPES CRITIQUES :
1. Créer un TRIGRAMME : première lettre du prénom + première lettre du nom + dernière lettre du nom (ex. : Jean DUPONT → JDT).
2. SUPPRIMER toutes informations personnelles : nom, prénom, email, téléphone, adresse, photos, QR codes, liens (LinkedIn, GitHub, etc.).
3. Mapper les sections du CV d'entrée vers les noms EXACTS du template (${sectionNames.join(', ')}) en utilisant les synonymes :
   - Compétences : ${sectionSynonyms['Compétences'].join(', ')}
   - Expérience : ${sectionSynonyms['Expérience'].join(', ')}
   - Formations & Certifications : ${sectionSynonyms['Formations & Certifications'].join(', ')}
4. Pour les compétences, regrouper les items par sous-catégories (${skillSubcategories.join(', ')}) dans UNE SEULE CHAÎNE séparée par des virgules (ex. : "Langage/BDD: Spark, Hive, Hadoop"). Supprimer tout caractère parasite (É, •, etc.).
5. Conserver la casse exacte des titres de section (${sectionNames.join(', ')}).
6. Inclure un placeholder pour les coordonnées commerciales si dans l'en-tête.

Retourne un JSON avec cette structure :
{
  "personal": {
    "trigram": "TRIGRAMME (ex: JDT)",
    "title": "titre professionnel",
    "years_experience": nombre_années
  },
  "commercial_contact": {
    "text": "Contact Commercial",
    "enabled": boolean
  },
  "skills": {
    "subcategories": [
      {
        "name": "nom de la sous-catégorie (ex: Langage/BDD)",
        "items": ["compétence1, compétence2"]
      }
    ],
    "languages": ["langue1: niveau"],
    "certifications": ["cert1"]
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
      "date_start": "MM-YYYY",
      "date_end": "MM-YYYY ou 'Actuellement'",
      "role": "poste occupé",
      "context": "contexte",
      "achievements": ["réalisation1"],
      "environment": ["tech1"]
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
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Texte extrait du CV avec styles :\n\n${JSON.stringify(structuredData, null, 2)}` }
        ],
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      console.error('AI Response Status:', aiResponse.status, await aiResponse.text());
      throw new Error('AI extraction failed');
    }

    const aiData = await aiResponse.json();
    console.log('AI Response:', JSON.stringify(aiData, null, 2));
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in AI response');

    let extractedData;
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      extractedData = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('Error parsing AI response:', parseError);
      throw new Error('Failed to parse AI extraction result');
    }

    extractedData.commercial_contact = {
      text: hasCommercialContact ? 'Contact Commercial' : '',
      enabled: hasCommercialContact
    };
    console.log('ExtractedData:', JSON.stringify(extractedData, null, 2));

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'CV data extracted successfully',
      details: { processing_time_ms: Date.now() - startTime }
    });

    const processingTime = Date.now() - startTime;
    await supabase
      .from('cv_documents')
      .update({ 
        extracted_data: extractedData,
        status: 'processed',
        processing_time_ms: processingTime
      })
      .eq('id', cvDocumentId);

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
    const { cvDocumentId } = await req.json().catch(() => ({}));
    if (cvDocumentId) {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
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
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
