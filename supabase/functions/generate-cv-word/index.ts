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
 * Génère le CV avec une approche de remplacement simple et fiable
 */
async function generateCVWithAIXML(
  templateBuffer: Uint8Array,
  cvData: any,
  templateStructure: any
): Promise<Uint8Array> {
  console.log('[generateCV] Starting CV generation with simple replacement...');

  // Charger le template comme ZIP
  const zip = await JSZip.loadAsync(templateBuffer);
  let documentXml = await zip.file('word/document.xml')?.async('string');
  
  if (!documentXml) {
    throw new Error('Could not extract document.xml from template');
  }

  console.log('[generateCV] Template loaded, XML length:', documentXml.length);

  // 1. Remplacer le trigramme (3 lettres majuscules entre balises <w:t>)
  const trigramPattern = /<w:t>([A-Z]{3})<\/w:t>/g;
  const trigramReplacement = `<w:t>${cvData.trigram || 'XXX'}</w:t>`;
  documentXml = documentXml.replace(trigramPattern, trigramReplacement);
  console.log('[generateCV] Trigram replaced');

  // 2. Remplacer le titre professionnel
  // Chercher un pattern typique de titre (en gras, grande taille)
  const titlePattern = /<w:t>([^<>]{10,100})<\/w:t>/g;
  let titleReplaced = false;
  documentXml = documentXml.replace(titlePattern, (match, content) => {
    // Ne remplacer que le premier titre long qui n'est pas le trigramme
    if (!titleReplaced && content.length > 10 && !/^[A-Z]{3}$/.test(content)) {
      titleReplaced = true;
      return `<w:t>${cvData.title || 'Titre Professionnel'}</w:t>`;
    }
    return match;
  });
  console.log('[generateCV] Title replaced');

  // 3. Traiter les sections dynamiques (compétences, missions, formations)
  if (templateStructure && templateStructure.sections) {
    for (const section of templateStructure.sections) {
      console.log('[generateCV] Processing section:', section.name, `(${section.title})`);
      
      if (section.type === 'list' && section.name === 'Compétences') {
        // Remplacer les compétences
        documentXml = replaceSectionContent(
          documentXml, 
          section.title,
          cvData.competences || [],
          'competence'
        );
      }
      
      if (section.type === 'list' && section.name === 'Expérience') {
        // Remplacer les missions
        documentXml = replaceSectionContent(
          documentXml,
          section.title,
          (cvData.missions || []).map((m: any) => ({
            title: m.title,
            client: m.client,
            period: m.period,
            description: m.description
          })),
          'mission'
        );
      }
      
      if (section.type === 'list' && section.name === 'Formations') {
        // Remplacer les formations
        documentXml = replaceSectionContent(
          documentXml,
          section.title,
          (cvData.formations || []).map((f: any) => ({
            title: f.title,
            institution: f.institution,
            year: f.year
          })),
          'formation'
        );
      }
    }
  }

  // Mettre à jour le XML dans le ZIP
  zip.file('word/document.xml', documentXml);

  // Générer le nouveau DOCX
  const generatedBuffer = await zip.generateAsync({ 
    type: 'uint8array',
    compression: 'DEFLATE'
  });

  console.log('[generateCV] Document generated successfully, size:', generatedBuffer.length);
  return generatedBuffer;
}

/**
 * Remplace le contenu d'une section dans le XML
 */
function replaceSectionContent(
  xml: string,
  sectionTitle: string,
  items: any[],
  itemType: string
): string {
  // Trouver le titre de la section
  const titlePattern = new RegExp(`<w:t[^>]*>${escapeRegex(sectionTitle)}</w:t>`, 'i');
  const titleMatch = xml.match(titlePattern);
  
  if (!titleMatch) {
    console.log(`[replaceSectionContent] Section title not found: ${sectionTitle}`);
    return xml;
  }

  // Trouver le paragraphe du titre
  const titleIndex = xml.indexOf(titleMatch[0]);
  const beforeTitle = xml.substring(0, titleIndex);
  const afterTitle = xml.substring(titleIndex);
  
  // Trouver le prochain paragraphe après le titre (c'est l'exemple)
  const exampleParagraphMatch = afterTitle.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/);
  
  if (!exampleParagraphMatch) {
    console.log(`[replaceSectionContent] Example paragraph not found after: ${sectionTitle}`);
    return xml;
  }

  const exampleParagraph = exampleParagraphMatch[0];
  const exampleStart = afterTitle.indexOf(exampleParagraph);
  const beforeExample = afterTitle.substring(0, exampleStart);
  const afterExample = afterTitle.substring(exampleStart + exampleParagraph.length);

  // Générer les nouveaux paragraphes
  let newParagraphs = '';
  
  for (const item of items) {
    let newParagraph = exampleParagraph;
    
    if (itemType === 'competence') {
      // Remplacer le texte de la compétence
      newParagraph = newParagraph.replace(/<w:t[^>]*>.*?<\/w:t>/, `<w:t>${item}</w:t>`);
    } else if (itemType === 'mission') {
      // Remplacer les informations de la mission
      newParagraph = newParagraph.replace(/<w:t[^>]*>.*?<\/w:t>/, 
        `<w:t>${item.title} - ${item.client} (${item.period})</w:t>`);
    } else if (itemType === 'formation') {
      // Remplacer les informations de la formation
      newParagraph = newParagraph.replace(/<w:t[^>]*>.*?<\/w:t>/, 
        `<w:t>${item.title} - ${item.institution} (${item.year})</w:t>`);
    }
    
    newParagraphs += newParagraph;
  }

  // Reconstruire le XML
  return beforeTitle + titleMatch[0] + beforeExample + newParagraphs + afterExample;
}

/**
 * Échappe les caractères spéciaux pour regex
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
