import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { convert } from "https://deno.land/x/deno_mammoth@v0.1.0/mod.ts";
import { DOMParser } from "https://deno.land/std@0.168.0/dom/mod.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Style {
  font: string;
  size: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: { type: string; color: string } | null;
  case: string;
  bullet: boolean;
  alignment: string;
  spacingBefore: string;
  spacingAfter: string;
  lineHeight: string;
  indent: string;
}

interface StructuredData {
  text: string;
  style: Style;
  section: string;
  subcategory?: string;
  context?: { text: string; style: Style };
  achievements?: { text: string; style: Style }[];
  environment?: { text: string; style: Style };
  location?: { text: string; style: Style };
}

const sectionKeywords: Record<string, string[]> = {
  'Compétences': ['compétence', 'competence', 'skills', 'compétences', 'savoir-faire'],
  'Expérience': ['expérience', 'experience', 'expériences', 'work history', 'professional experience'],
  'Formations & Certifications': ['formation', 'formations', 'certification', 'certifications', 'diplôme', 'diplome', 'education', 'études', 'etudes', 'study', 'studies']
};

const requestSchema = z.object({
  cvDocumentId: z.string().uuid({ message: 'cvDocumentId must be a valid UUID' })
});

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { cvDocumentId } = requestSchema.parse(await req.json());
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!supabaseUrl || !supabaseKey || !lovableApiKey) throw new Error('Missing environment variables');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Vérifier l'utilisateur authentifié (pour RLS)
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('User not authenticated');

    const startTime = Date.now();
    console.log('Processing CV:', cvDocumentId, 'for user:', user.id);

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*, cv_templates(structure_data)')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id) // RLS
      .single();

    if (cvError || !cvDoc) throw new Error('CV document not found or not owned by user');

    const templateStructure = cvDoc.cv_templates?.structure_data || {};
    const sectionNames = templateStructure.sections?.map((s: any) => s.name) || ['Compétences', 'Expérience', 'Formations & Certifications'];
    const skillSubcategories = templateStructure.element_styles?.skill_subcategories?.map((sc: any) => sc.name) || ['Langage/BDD', 'OS', 'Outils', 'Méthodologies'];
    const hasCommercialContact = templateStructure.element_styles?.commercial_contact?.position === 'header';

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'Starting CV data extraction',
      user_id: user.id
    });

    await supabase.from('cv_documents').update({ status: 'analyzing' }).eq('id', cvDocumentId).eq('user_id', user.id);

    const { data: cvFileData, error: cvFileError } = await supabase
      .storage
      .from('cv-uploads')
      .download(cvDoc.original_file_path);

    if (cvFileError || !cvFileData) throw new Error('Failed to download CV file');

    let extractedText = '';
    let structuredData: StructuredData[] = [];
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
        let currentSection = '';
        let currentMission: StructuredData | null = null;

        paragraphs.forEach((p: any) => {
          const text = p.textContent.trim().replace(/^[•\-\*É°\u2022\u25CF]\s*/g, '');
          if (!text) return;

          const styleAttr = p.getAttribute('style') || '';
          const underlineMatch = styleAttr.match(/text-decoration: underline/);
          const underlineColorMatch = styleAttr.match(/text-decoration-color: (#\w+)/);
          const tabMatch = text.match(/\t/);
          const style: Style = {
            font: styleAttr.match(/font-family:([^;]+)/)?.[1]?.trim() || 'Segoe UI Symbol',
            size: styleAttr.match(/font-size:([^;]+)/)?.[1]?.trim() || '11pt',
            color: styleAttr.match(/color:(#[0-9a-fA-F]{6})/)?.[1] || '#000000',
            bold: styleAttr.includes('font-weight:bold'),
            italic: styleAttr.includes('font-style:italic'),
            underline: underlineMatch ? { type: 'single', color: underlineColorMatch ? underlineColorMatch[1] : '#000000' } : null,
            case: text.match(/^[A-Z][a-z]+/) ? 'mixed' : text === text.toUpperCase() ? 'uppercase' : 'lowercase',
            bullet: p.querySelector('li') || text.match(/^[•\-\*É°\u2022\u25CF]/) ? true : false,
            alignment: styleAttr.includes('text-align:center') ? 'center' : styleAttr.includes('text-align:right') ? 'right' : 'left',
            spacingBefore: styleAttr.match(/margin-top:([^;]+)/)?.[1]?.trim() || '0pt',
            spacingAfter: styleAttr.match(/margin-bottom:([^;]+)/)?.[1]?.trim() || '6pt',
            lineHeight: styleAttr.match(/line-height:([^;]+)/)?.[1]?.trim() || '1.15',
            indent: styleAttr.match(/padding-left:([^;]+)/)?.[1]?.trim() || tabMatch ? '5mm' : '0pt'
          };

          const textLower = text.toLowerCase();
          let isSection = false;
          for (const [sectionKey, keywords] of Object.entries(sectionKeywords)) {
            if (keywords.some(keyword => textLower.includes(keyword))) {
              currentSection = sectionKey;
              isSection = true;
              if (currentMission) {
                structuredData.push(currentMission);
                currentMission = null;
              }
              structuredData.push({ text, style, section: sectionKey });
              break;
            }
          }

          if (currentSection === 'Compétences' && !isSection) {
            const textParts = text.split(/[\t:]/).map((t: string) => t.trim());
            if (skillSubcategories.some((sc: string) => textLower.includes(sc.toLowerCase()))) {
              if (skillItems.length > 0) {
                structuredData.push({
                  text: `${currentSubcategory}: ${skillItems.join(', ')}`,
                  style: { ...style, bold: false, bullet: false },
                  section: 'Compétences',
                  subcategory: currentSubcategory
                });
                skillItems = [];
              }
              currentSubcategory = textParts[0];
              structuredData.push({ text: currentSubcategory, style: { ...style, bold: false }, section: 'Compétences', subcategory: currentSubcategory });
            } else if (style.bullet || textParts.length > 1) {
              skillItems.push(textParts.length > 1 ? textParts[1] : text);
            } else {
              if (skillItems.length > 0) {
                structuredData.push({
                  text: `${currentSubcategory}: ${skillItems.join(', ')}`,
                  style: { ...style, bold: false, bullet: false },
                  section: 'Compétences',
                  subcategory: currentSubcategory
                });
                skillItems = [];
                currentSubcategory = '';
              }
              structuredData.push({ text, style, section: currentSection });
            }
          } else if (currentSection === 'Expérience' && !isSection) {
            if (text.match(/^\d{2}\/\d{4}\s*-\s*\d{2}\/\d{4}\s*.*@.*/)) {
              if (currentMission) structuredData.push(currentMission);
              currentMission = { text, style, section: 'Expérience', subcategory: 'title' };
            } else if (textLower.includes('contexte') || textLower.includes('objectif')) {
              if (currentMission) currentMission.context = { text, style };
            } else if (textLower.includes('mission') || textLower.includes('tâche')) {
              if (currentMission) {
                if (!currentMission.achievements) currentMission.achievements = [];
                currentMission.achievements.push({ text, style });
              }
            } else if (textLower.includes('environnement') || textLower.includes('technologie')) {
              if (currentMission) currentMission.environment = { text, style };
            } else if (text.match(/lieu|ville|city/i)) {
              if (currentMission) currentMission.location = { text, style };
            } else {
              structuredData.push({ text, style, section: currentSection });
            }
          } else if (currentSection === 'Formations & Certifications' && !isSection) {
            if (text.match(/^\d{4}\s*[A-Z][a-z]+|^[A-Z][a-z]+\s*@\s*[A-Z]/i)) {
              structuredData.push({ text, style, section: 'Formations & Certifications', subcategory: 'degree' });
            } else if (text.match(/lieu|ville|city|organisme|université|école/i)) {
              structuredData.push({ text, style, section: 'Formations & Certifications', subcategory: 'details' });
            } else {
              structuredData.push({ text, style, section: currentSection });
            }
          } else if (!isSection) {
            structuredData.push({ text, style, section: currentSection || 'unknown' });
          }
        });

        if (currentMission) structuredData.push(currentMission);
        if (skillItems.length > 0) {
          structuredData.push({
            text: `${currentSubcategory}: ${skillItems.join(', ')}`,
            style: { ...style, bold: false, bullet: false },
            section: 'Compétences',
            subcategory: currentSubcategory
          });
        }

        extractedText = structuredData.map((p: StructuredData) => p.text).join('\n');
      } else if (fileType === 'pdf') {
        throw new Error('PDF processing temporarily disabled due to library incompatibility');
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

    const systemPrompt = `Tu es un expert en extraction et anonymisation de CV. Analyse ce CV et extrais TOUTES les informations en les ANONYMISANT, en respectant la structure du template suivant : ${JSON.stringify(sectionNames)}.

ÉTAPES CRITIQUES :
1. Créer un TRIGRAMME : première lettre du prénom + première lettre du nom + dernière lettre du nom (ex. : Jean DUPONT → JDT).
2. SUPPRIMER toutes informations personnelles : nom, prénom, email, téléphone, adresse, photos, QR codes, liens (LinkedIn, GitHub, etc.).
3. Mapper les sections du CV d'entrée vers les noms EXACTS du template :
   - Compétences : inclut 'compétence', 'skills', 'savoir-faire'.
   - Expérience : inclut 'expérience', 'work history', 'professional experience'.
   - Formations & Certifications : inclut 'formation', 'certification', 'diplôme', 'education', 'études', 'studies'.
4. Pour les COMPÉTENCES, regrouper les items par sous-catégories (${skillSubcategories.join(', ')}) dans UNE SEULE CHAÎNE séparée par des virgules (ex. : "Langage/BDD: Spark, Hive"). Ne pas ajouter "Techniques" sauf si explicite dans le CV.
5. Pour les EXPÉRIENCES, extraire les sous-parties :
   - Titre : format "MM/YYYY - MM/YYYY Rôle @ Entreprise" (ex. : "02/2012 - 05/2021 Expert Fonctionnel / Product Owner @ Atos : Orange, SIRS").
   - Dates : date_start (MM/YYYY), date_end (MM/YYYY ou 'Actuellement').
   - Entreprise : nom(s) après "@".
   - Lieu : si mentionné.
   - Contexte/Objectif : texte sous "Contexte" ou "Objectif".
   - Missions/Tâches : liste des tâches (puces ou texte).
   - Environnement/Technologies : technologies mentionnées.
6. Pour les FORMATIONS & CERTIFICATIONS, extraire :
   - Diplôme/Certification : nom (ex. : "Certification Scrum Product Owner I").
   - Date : année ou MM/YYYY.
   - Institution/Organisme : nom (ex. : "Aix-Marseille III").
   - Lieu : si mentionné.
7. Identifier dans l'EN-TÊTE : trigramme (ex. : "CVA"), titre professionnel (ex. : "Analyste Fonctionnel / Product Owner"), coordonnées commerciales (ex. : "Contact Commercial").
8. Identifier dans le PIED DE PAGE : tout texte ou élément (ex. : numéro de page, logo).
9. Conserver la casse exacte des titres de section ("Compétences", "Expérience", "Formations & Certifications").

Retourne un JSON avec cette structure :
{
  "header": {
    "trigram": "TRIGRAMME",
    "title": "titre professionnel",
    "commercial_contact": {
      "text": "Contact Commercial",
      "enabled": boolean
    },
    "logo": {
      "present": boolean,
      "position": "header" | "footer" | null
    }
  },
  "footer": {
    "text": "texte du pied de page",
    "logo": {
      "present": boolean
    }
  },
  "personal": {
    "years_experience": number
  },
  "skills": {
    "subcategories": Array<{ name: string; items: string[] }>,
    "languages": string[],
    "certifications": string[]
  },
  "education": Array<{
    "degree": string,
    "institution": string,
    "year": string,
    "location": string
  }>,
  "missions": Array<{
    "client": string,
    "date_start": string,
    "date_end": string,
    "role": string,
    "location": string,
    "context": string,
    "achievements": string[],
    "environment": string[]
  }>
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
      console.error('AI Response Status:', aiResponse.status);
      throw new Error('AI extraction failed');
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in AI response');

    let extractedData: any;
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

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'extraction',
      message: 'CV data extracted successfully',
      details: { processing_time_ms: Date.now() - startTime },
      user_id: user.id
    });

    const processingTime = Date.now() - startTime;
    await supabase
      .from('cv_documents')
      .update({ 
        extracted_data: extractedData,
        status: 'processed',
        processing_time_ms: processingTime
      })
      .eq('id', cvDocumentId)
      .eq('user_id', user.id);

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
    const { cvDocumentId } = requestSchema.parse(await req.json().catch(() => ({})));
    if (cvDocumentId) {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: { user } } = await supabase.auth.getUser();
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
        .eq('id', cvDocumentId)
        .eq('user_id', user?.id || null);
    }
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
