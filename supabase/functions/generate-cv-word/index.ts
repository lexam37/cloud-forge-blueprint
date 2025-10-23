import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

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
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Vérifier l'utilisateur authentifié (pour RLS)
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('User not authenticated');

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id) // RLS
      .single();

    if (cvError || !cvDoc) throw new Error('CV document not found or not owned by user');

    // Placeholder for generation logic (replace with actual DOCX creation)
    const fileName = `${cvDoc.extracted_data?.personal?.trigram || 'XXX'} CV.docx`;
    const filePath = `generated-${Date.now()}-${fileName}`;

    // Simulate generation - replace with actual DOCX creation
    const buffer = new Uint8Array([0x50, 0x4B, 0x03, 0x04]); // Placeholder for DOCX binary
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(filePath, blob, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true,
        metadata: { user_id: user.id } // Pour futur RLS Storage
      });

    if (uploadError) throw uploadError;

    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'generation',
      message: 'CV Word generated successfully',
      user_id: user.id
    });

    await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: filePath,
        generated_file_type: 'docx',
        status: 'processed'
      })
      .eq('id', cvDocumentId)
      .eq('user_id', user.id); // RLS

    return new Response(
      JSON.stringify({ 
        success: true, 
        filePath,
        fileName,
        message: 'CV Word generated successfully'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (error) {
    console.error('Error in generate-cv-word:', error);
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
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
