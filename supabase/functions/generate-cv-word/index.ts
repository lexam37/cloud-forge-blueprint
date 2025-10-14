import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

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
      throw new Error('cvDocumentId is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Récupérer les données du CV
    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .single();

    if (cvError || !cvDoc) {
      throw new Error('CV document not found');
    }

    // Récupérer le profil commercial
    const { data: commercial, error: commercialError } = await supabase
      .from('commercial_profiles')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Récupérer un template actif
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    console.log('CV data:', cvDoc.extracted_data);
    console.log('Commercial:', commercial);
    console.log('Template:', template);

    // Importer la bibliothèque docx pour générer le document
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun, TableCell, TableRow, Table, WidthType, BorderStyle } = await import('https://esm.sh/docx@8.5.0');

    const extractedData = cvDoc.extracted_data || {};
    const personal = extractedData.personal || {};
    const missions = extractedData.missions || [];
    const skills = extractedData.skills || {};
    const education = extractedData.education || [];

    // Récupérer le style du template
    const templateStyle = template?.structure_data || {};
    const colors = templateStyle.colors || { primary: "#2563eb", text: "#1e293b" };
    const fonts = templateStyle.fonts || { title_font: "Arial", body_font: "Arial", title_size: "18pt", body_size: "11pt" };
    
    // Télécharger le logo commercial s'il existe
    let logoImage = null;
    if (commercial?.logo_path) {
      try {
        const { data: logoData } = await supabase.storage
          .from('company-logos')
          .download(commercial.logo_path);
        
        if (logoData) {
          const logoBuffer = await logoData.arrayBuffer();
          logoImage = new Uint8Array(logoBuffer);
        }
      } catch (err) {
        console.log('Could not load logo:', err);
      }
    }

    // Créer le contenu du document
    const children = [];

    // En-tête avec logo et trigramme
    const headerChildren = [];
    
    if (logoImage) {
      headerChildren.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: logoImage,
              transformation: {
                width: 80,
                height: 80,
              },
            }),
          ],
          alignment: AlignmentType.LEFT,
        })
      );
    }

    headerChildren.push(
      new Paragraph({
        children: [
          new TextRun({ 
            text: personal.trigram || 'N/A',
            bold: true,
            size: parseInt(fonts.title_size) * 2 || 48,
            color: colors.primary.replace('#', ''),
            font: fonts.title_font || 'Arial',
          }),
        ],
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        children: [
          new TextRun({ 
            text: personal.title || 'Professionnel',
            size: parseInt(fonts.body_size) * 2 || 24,
            color: colors.text.replace('#', ''),
            font: fonts.body_font || 'Arial',
          }),
        ],
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({ text: '' })
    );

    children.push(...headerChildren);

    // Coordonnées commerciales dans un tableau pour meilleure mise en page
    if (commercial) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'Contact Commercial',
              bold: true,
              size: parseInt(fonts.title_size) * 2 - 4 || 28,
              color: colors.primary.replace('#', ''),
              font: fonts.title_font || 'Arial',
            }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'Nom: ',
              bold: true,
              size: parseInt(fonts.body_size) * 2 || 22,
              color: colors.text.replace('#', ''),
              font: fonts.body_font || 'Arial',
            }),
            new TextRun({ 
              text: `${commercial.first_name} ${commercial.last_name}`,
              size: parseInt(fonts.body_size) * 2 || 22,
              color: colors.text.replace('#', ''),
              font: fonts.body_font || 'Arial',
            }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'Email: ',
              bold: true,
              size: parseInt(fonts.body_size) * 2 || 22,
              color: colors.text.replace('#', ''),
              font: fonts.body_font || 'Arial',
            }),
            new TextRun({ 
              text: commercial.email,
              size: parseInt(fonts.body_size) * 2 || 22,
              color: colors.text.replace('#', ''),
              font: fonts.body_font || 'Arial',
            }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'Téléphone: ',
              bold: true,
              size: parseInt(fonts.body_size) * 2 || 22,
              color: colors.text.replace('#', ''),
              font: fonts.body_font || 'Arial',
            }),
            new TextRun({ 
              text: commercial.phone,
              size: parseInt(fonts.body_size) * 2 || 22,
              color: colors.text.replace('#', ''),
              font: fonts.body_font || 'Arial',
            }),
          ],
        }),
        new Paragraph({ text: '' })
      );
    }

    // Compétences avec style du template
    if (skills.technical?.length > 0 || skills.tools?.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'COMPÉTENCES',
              bold: true,
              size: parseInt(fonts.title_size) * 2 || 32,
              color: colors.primary.replace('#', ''),
              font: fonts.title_font || 'Arial',
            }),
          ],
        })
      );

      if (skills.technical?.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ 
                text: 'Techniques: ',
                bold: true,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
              new TextRun({ 
                text: skills.technical.join(', '),
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          })
        );
      }

      if (skills.tools?.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ 
                text: 'Outils: ',
                bold: true,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
              new TextRun({ 
                text: skills.tools.join(', '),
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          })
        );
      }

      if (skills.languages?.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ 
                text: 'Langues: ',
                bold: true,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
              new TextRun({ 
                text: skills.languages.join(', '),
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          })
        );
      }

      children.push(new Paragraph({ text: '' }));
    }

    // Missions avec style du template
    if (missions.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'EXPÉRIENCE PROFESSIONNELLE',
              bold: true,
              size: parseInt(fonts.title_size) * 2 || 32,
              color: colors.primary.replace('#', ''),
              font: fonts.title_font || 'Arial',
            }),
          ],
        })
      );

      missions.forEach((mission: any) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ 
                text: `${mission.role || 'N/A'}`,
                bold: true,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
              new TextRun({ 
                text: ` - ${mission.client || 'N/A'}`,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ 
                text: `${mission.date_start || ''} - ${mission.date_end || ''}`,
                italics: true,
                size: parseInt(fonts.body_size) * 2 - 2 || 20,
                color: colors.secondary?.replace('#', '') || colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          })
        );

        if (mission.achievements?.length > 0) {
          mission.achievements.forEach((achievement: string) => {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({ 
                    text: `• ${achievement}`,
                    size: parseInt(fonts.body_size) * 2 || 22,
                    color: colors.text.replace('#', ''),
                    font: fonts.body_font || 'Arial',
                  }),
                ],
              })
            );
          });
        }

        children.push(new Paragraph({ text: '' }));
      });
    }

    // Formation avec style du template
    if (education.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ 
              text: 'FORMATION',
              bold: true,
              size: parseInt(fonts.title_size) * 2 || 32,
              color: colors.primary.replace('#', ''),
              font: fonts.title_font || 'Arial',
            }),
          ],
        })
      );

      education.forEach((edu: any) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ 
                text: `${edu.degree || 'N/A'}`,
                bold: true,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
              new TextRun({ 
                text: ` - ${edu.institution || 'N/A'}`,
                size: parseInt(fonts.body_size) * 2 || 22,
                color: colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ 
                text: edu.year || '',
                italics: true,
                size: parseInt(fonts.body_size) * 2 - 2 || 20,
                color: colors.secondary?.replace('#', '') || colors.text.replace('#', ''),
                font: fonts.body_font || 'Arial',
              }),
            ],
          }),
          new Paragraph({ text: '' })
        );
      });
    }

    // Créer le document
    const doc = new Document({
      sections: [{
        properties: {},
        children: children,
      }],
    });

    // Générer le buffer
    const buffer = await Packer.toBuffer(doc);
    const blob = new Blob([buffer], { 
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' 
    });

    // Générer le nom du fichier avec le trigramme
    const trigram = personal.trigram || 'XXX';
    const fileName = `${trigram} DC.docx`;
    const storagePath = `${cvDocumentId}/${fileName}`;

    // Uploader dans le bucket cv-generated
    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(storagePath, blob, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      throw new Error('Failed to upload generated Word file');
    }
    
    // Marquer le document comme ayant un fichier généré
    await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: storagePath,
        generated_file_type: 'docx'
      })
      .eq('id', cvDocumentId);

    return new Response(
      JSON.stringify({ 
        success: true,
        filePath: storagePath,
        fileName: fileName,
        message: 'Word document generated successfully'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in generate-cv-word:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
