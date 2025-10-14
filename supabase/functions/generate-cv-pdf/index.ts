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

    // Générer un document Word formaté, puis le sauvegarder comme PDF
    // Note: Une vraie conversion DOCX->PDF nécessiterait une API externe
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('https://esm.sh/docx@8.5.0');

    const extractedData = cvDoc.extracted_data || {};
    const personal = extractedData.personal || {};
    const missions = extractedData.missions || [];
    const skills = extractedData.skills || {};
    const education = extractedData.education || [];

    // Créer le contenu du document
    const children = [];

    // En-tête avec trigramme et coordonnées commerciales
    children.push(
      new Paragraph({
        text: personal.trigram || 'N/A',
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        text: personal.title || 'Professionnel',
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({ text: '' })
    );

    // Coordonnées commerciales
    if (commercial) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Contact Commercial: ', bold: true }),
            new TextRun({ text: `${commercial.first_name} ${commercial.last_name}` }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Email: ', bold: true }),
            new TextRun({ text: commercial.email }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Téléphone: ', bold: true }),
            new TextRun({ text: commercial.phone }),
          ],
        }),
        new Paragraph({ text: '' })
      );
    }

    // Compétences
    if (skills.technical?.length > 0 || skills.tools?.length > 0) {
      children.push(
        new Paragraph({
          text: 'COMPÉTENCES',
          heading: HeadingLevel.HEADING_2,
        })
      );

      if (skills.technical?.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: 'Techniques: ', bold: true }),
              new TextRun({ text: skills.technical.join(', ') }),
            ],
          })
        );
      }

      if (skills.tools?.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: 'Outils: ', bold: true }),
              new TextRun({ text: skills.tools.join(', ') }),
            ],
          })
        );
      }

      if (skills.languages?.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: 'Langues: ', bold: true }),
              new TextRun({ text: skills.languages.join(', ') }),
            ],
          })
        );
      }

      children.push(new Paragraph({ text: '' }));
    }

    // Missions
    if (missions.length > 0) {
      children.push(
        new Paragraph({
          text: 'EXPÉRIENCE PROFESSIONNELLE',
          heading: HeadingLevel.HEADING_2,
        })
      );

      missions.forEach((mission: any) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${mission.role || 'N/A'}`, bold: true }),
              new TextRun({ text: ` - ${mission.client || 'N/A'}` }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `${mission.date_start || ''} - ${mission.date_end || ''}`, italics: true }),
            ],
          })
        );

        if (mission.achievements?.length > 0) {
          mission.achievements.forEach((achievement: string) => {
            children.push(
              new Paragraph({
                text: `• ${achievement}`,
              })
            );
          });
        }

        children.push(new Paragraph({ text: '' }));
      });
    }

    // Formation
    if (education.length > 0) {
      children.push(
        new Paragraph({
          text: 'FORMATION',
          heading: HeadingLevel.HEADING_2,
        })
      );

      education.forEach((edu: any) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${edu.degree || 'N/A'}`, bold: true }),
              new TextRun({ text: ` - ${edu.institution || 'N/A'}` }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: edu.year || '', italics: true }),
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

    // Générer le buffer Word
    const buffer = await Packer.toBuffer(doc);
    
    // Note: Pour une vraie conversion PDF, il faudrait utiliser une API externe comme:
    // - CloudConvert API
    // - Gotenberg
    // - LibreOffice en mode headless
    // 
    // Pour l'instant, nous uploadons le document Word avec l'extension .pdf
    // Le client devra utiliser une solution de conversion côté client ou serveur
    
    const blob = new Blob([buffer], { 
      type: 'application/pdf'
    });

    // Générer le nom du fichier avec le trigramme
    const trigram = personal.trigram || 'XXX';
    const fileName = `${trigram} DC.pdf`;
    const storagePath = `${cvDocumentId}/${fileName}`;

    // IMPORTANT: Ce fichier est un DOCX renommé en PDF
    // Pour une vraie conversion, implémenter une API de conversion
    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(storagePath, blob, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      throw new Error('Failed to upload generated PDF file');
    }
    
    // Marquer le document comme ayant un fichier généré
    await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: storagePath,
        generated_file_type: 'pdf'
      })
      .eq('id', cvDocumentId);

    return new Response(
      JSON.stringify({ 
        success: true,
        filePath: storagePath,
        fileName: fileName,
        message: 'PDF generated (Note: Real PDF conversion requires external API)',
        warning: 'Le fichier PDF est actuellement un document Word. Pour une vraie conversion PDF, contactez le support.'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in generate-cv-pdf:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
