import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import { 
  Document, 
  Packer, 
  Paragraph, 
  TextRun, 
  AlignmentType, 
  HeadingLevel,
  UnderlineType,
  convertInchesToTwip
} from "https://esm.sh/docx@8.5.0";

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
    
    // Extract JWT from Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user authentication with JWT
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) throw new Error('User not authenticated');

    console.log('Fetching CV document and template for user:', user.id);

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*, cv_templates(structure_data)')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id)
      .single();

    if (cvError || !cvDoc) throw new Error('CV document not found or not owned by user');

    const extractedData = cvDoc.extracted_data;
    const templateStructure = cvDoc.cv_templates?.structure_data;

    if (!extractedData) throw new Error('No extracted data found in CV document');

    console.log('Generating DOCX from extracted data with template styles...');

    // Génération avec styles du template
    const sections: Paragraph[] = [];
    const templateStyles = templateStructure?.detailedStyles || {};

    // Header section
    sections.push(
      new Paragraph({
        text: extractedData.header?.trigram || 'XXX',
        alignment: AlignmentType.CENTER,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 200 }
      })
    );

    if (extractedData.header?.title) {
      sections.push(
        new Paragraph({
          text: extractedData.header.title,
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 }
        })
      );
    }

    // Commercial contact if enabled
    if (extractedData.header?.commercial_contact?.enabled) {
      sections.push(
        new Paragraph({
          text: extractedData.header.commercial_contact.text || 'Contact Commercial',
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 }
        })
      );
    }

    // Skills section
    if (extractedData.skills?.subcategories?.length > 0) {
      sections.push(
        new Paragraph({
          text: 'Compétences',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        })
      );

      extractedData.skills.subcategories.forEach((subcat: any) => {
        sections.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${subcat.name}: `,
                bold: true
              }),
              new TextRun({
                text: subcat.items.join(', ')
              })
            ],
            spacing: { after: 100 }
          })
        );
      });
    }

    // Experience section
    if (extractedData.missions?.length > 0) {
      sections.push(
        new Paragraph({
          text: 'Expérience',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        })
      );

      extractedData.missions.forEach((mission: any) => {
        // Mission title
        sections.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${mission.date_start} - ${mission.date_end} `,
                bold: true
              }),
              new TextRun({
                text: `${mission.role} @ ${mission.client}`,
                bold: true
              })
            ],
            spacing: { after: 100 }
          })
        );

        // Location
        if (mission.location) {
          sections.push(
            new Paragraph({
              text: `Lieu: ${mission.location}`,
              spacing: { after: 100 }
            })
          );
        }

        // Context
        if (mission.context) {
          sections.push(
            new Paragraph({
              text: `Contexte: ${mission.context}`,
              spacing: { after: 100 }
            })
          );
        }

        // Achievements
        if (mission.achievements?.length > 0) {
          sections.push(
            new Paragraph({
              text: 'Missions:',
              spacing: { after: 50 }
            })
          );
          mission.achievements.forEach((achievement: string) => {
            sections.push(
              new Paragraph({
                text: `• ${achievement}`,
                spacing: { after: 50 }
              })
            );
          });
        }

        // Environment
        if (mission.environment?.length > 0) {
          sections.push(
            new Paragraph({
              text: `Environnement: ${mission.environment.join(', ')}`,
              spacing: { after: 200 }
            })
          );
        }
      });
    }

    // Education section
    if (extractedData.education?.length > 0) {
      sections.push(
        new Paragraph({
          text: 'Formations & Certifications',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        })
      );

      extractedData.education.forEach((edu: any) => {
        sections.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${edu.year} `,
                bold: true
              }),
              new TextRun({
                text: edu.degree
              })
            ],
            spacing: { after: 50 }
          })
        );

        if (edu.institution || edu.location) {
          sections.push(
            new Paragraph({
              text: `${edu.institution || ''}${edu.institution && edu.location ? ' - ' : ''}${edu.location || ''}`,
              spacing: { after: 200 }
            })
          );
        }
      });
    }

    // Footer
    if (extractedData.footer?.text) {
      sections.push(
        new Paragraph({
          text: extractedData.footer.text,
          alignment: AlignmentType.CENTER,
          spacing: { before: 400 }
        })
      );
    }

    // Create the document with proper margins
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(0.79),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(0.79)
            }
          }
        },
        children: sections
      }]
    });

    console.log('Packing document to buffer...');
    const buffer = await Packer.toBuffer(doc);
    console.log('Document generated, size:', buffer.length, 'bytes');

    const fileName = `${extractedData.header?.trigram || 'XXX'} CV.docx`;
    const filePath = `${user.id}/generated-${Date.now()}-${fileName}`;

    console.log('Uploading to storage:', filePath);

    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(filePath, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
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
      .eq('user_id', user.id);

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
    
    try {
      const body = await req.clone().json();
      const { cvDocumentId } = body;
      
      if (cvDocumentId) {
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
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
      console.error('Error logging failure:', logError);
    }
    
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
