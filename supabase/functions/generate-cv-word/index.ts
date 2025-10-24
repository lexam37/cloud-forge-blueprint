import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import Docxtemplater from "https://esm.sh/docxtemplater@3.45.0";
import PizZip from "https://esm.sh/pizzip@3.1.6";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    if (cvError || !cvDoc) throw new Error('CV document not found or not owned by user');

    const extractedData = cvDoc.extracted_data;
    if (!extractedData) throw new Error('No extracted data found in CV document');

    // Télécharger le template avec placeholders
    let templateBuffer: ArrayBuffer;
    if (cvDoc.template_id) {
      console.log('[generate-cv-word] Fetching template:', cvDoc.template_id);
      const { data: template, error: templateError } = await supabase
        .from('cv_templates')
        .select('file_path, structure_data')
        .eq('id', cvDoc.template_id)
        .single();

      if (templateError || !template) {
        console.warn('[generate-cv-word] Template not found, using default');
        throw new Error('Template not found');
      }

      console.log('[generate-cv-word] Template structure_data:', JSON.stringify(template.structure_data, null, 2));

      // Télécharger le template avec placeholders (priorité) ou le template original
      const templatePath = template.structure_data?.templateWithPlaceholdersPath || template.file_path;
      console.log('[generate-cv-word] Downloading template from path:', templatePath);
      
      const { data: templateFile, error: downloadError } = await supabase
        .storage
        .from('cv-templates')
        .download(templatePath);

      if (downloadError || !templateFile) {
        console.error('[generate-cv-word] Download error:', downloadError);
        throw new Error(`Failed to download template: ${downloadError?.message}`);
      }

      console.log('[generate-cv-word] Template downloaded, size:', templateFile.size, 'bytes');
      templateBuffer = await templateFile.arrayBuffer();
    } else {
      throw new Error('No template_id specified');
    }

    console.log('[generate-cv-word] Processing template with extracted data...');

    // Charger le template
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
    });

    // Préparer les données pour le template
    const templateData = {
      // Header
      trigram: extractedData.header?.trigram || 'XXX',
      title: extractedData.header?.title || '',
      commercial_contact: extractedData.header?.commercial_contact?.enabled 
        ? (extractedData.header.commercial_contact.text || 'Contact Commercial')
        : '',
      
      // Compétences
      competences: extractedData.skills?.subcategories?.map((subcat: any) => ({
        category: subcat.name,
        items: subcat.items.join(', ')
      })) || [],
      
      // Expériences/Missions
      missions: extractedData.missions?.map((mission: any) => ({
        period: `${mission.date_start} - ${mission.date_end}`,
        role: mission.role || '',
        client: mission.client || '',
        location: mission.location || '',
        context: mission.context || '',
        achievements: mission.achievements || [],
        environment: mission.environment?.join(', ') || ''
      })) || [],
      
      // Formations
      formations: extractedData.education?.map((edu: any) => ({
        year: edu.year || '',
        degree: edu.degree || '',
        institution: edu.institution || '',
        location: edu.location || ''
      })) || [],
      
      // Footer
      footer: extractedData.footer?.text || ''
    };

    console.log('[generate-cv-word] Template data prepared:', JSON.stringify(templateData, null, 2));

    // Remplir le template
    doc.render(templateData);

    // Générer le fichier final
    const generatedBuffer = doc.getZip().generate({
      type: 'arraybuffer',
      compression: 'DEFLATE'
    });

    console.log('[generate-cv-word] Document generated, uploading to storage...');

    // Uploader vers Supabase Storage
    const fileName = `cv-${cvDocumentId}-${Date.now()}.docx`;
    const filePath = `${user.id}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(filePath, generatedBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      throw new Error(`Failed to upload generated file: ${uploadError.message}`);
    }

    // Mettre à jour le document CV
    const { error: updateError } = await supabase
      .from('cv_documents')
      .update({
        status: 'processed',
        generated_file_path: filePath,
        generated_file_type: 'docx',
        updated_at: new Date().toISOString()
      })
      .eq('id', cvDocumentId);

    if (updateError) {
      console.error('[generate-cv-word] Failed to update CV document:', updateError);
    }

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'generation',
      message: 'CV generated successfully',
      details: { file_path: filePath }
    });

    console.log('[generate-cv-word] CV generated successfully:', filePath);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'CV generated successfully',
        file_path: filePath 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('[generate-cv-word] Error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error occurred' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
