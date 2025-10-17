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

    // Récupérer le template actif
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
    const { 
      Document, Packer, Paragraph, TextRun, HeadingLevel, 
      AlignmentType, ImageRun, UnderlineType, 
      convertInchesToTwip, convertMillimetersToTwip,
      BorderStyle, Header
    } = await import('https://esm.sh/docx@8.5.0');

    const extractedData = cvDoc.extracted_data || {};
    const personal = extractedData.personal || {};
    const missions = extractedData.missions || [];
    const skills = extractedData.skills || {};
    const education = extractedData.education || [];

    // Récupérer le style détaillé du template
    const templateStyle = template?.structure_data || {};
    const colors = templateStyle.colors || { primary: "#2563eb", text: "#1e293b", secondary: "#64748b" };
    const fonts = templateStyle.fonts || { 
      title_font: "Calibri", 
      body_font: "Calibri", 
      title_size: "16pt", 
      body_size: "11pt",
      title_weight: "bold",
      line_height: "1.15"
    };
    const spacing = templateStyle.spacing || {
      section_spacing: "12pt",
      element_spacing: "6pt",
      padding: "10mm",
      line_spacing: "1.15"
    };
    const sections = templateStyle.sections || [];
    const visualElements = templateStyle.visual_elements || {};
    const pageSettings = templateStyle.page || {};
    
    // Helpers pour convertir les valeurs
    const ptToHalfPt = (pt: string) => parseInt(pt) * 2;
    const colorToHex = (color: string) => color.replace('#', '');
    const mmToTwip = (mm: string) => convertMillimetersToTwip(parseInt(mm));
    
    // Télécharger le logo - priorité au logo extrait du template
    let logoImage = null;
    const logoSettings = visualElements.logo || { position: "body", size: "40x40mm" };
    
    // Essayer d'abord le logo extrait du template
    const logoPath = template?.structure_data?.visual_elements?.logo?.extracted_logo_path || commercial?.logo_path;
    
    if (logoPath) {
      try {
        const { data: logoData } = await supabase.storage
          .from('company-logos')
          .download(logoPath);
        
        if (logoData) {
          const logoBuffer = await logoData.arrayBuffer();
          logoImage = new Uint8Array(logoBuffer);
          console.log('Logo chargé depuis:', logoPath);
        }
      } catch (err) {
        console.log('Could not load logo:', err);
      }
    }

    // Créer le contenu du document
    const children = [];
    const trigram = personal.trigram || 'XXX';
    const title = personal.title || '';
    
    // Créer l'en-tête si le logo ou les coordonnées commerciales doivent y être
    let headers = undefined;
    const logoPosition = visualElements.logo?.position || 'body';
    
    // Si le template contient des coordonnées commercial dans l'en-tête, on les récupère du template
    const hasCommercialInHeader = templateStyle.element_styles?.commercial_contact?.position === 'header';
    
    if (logoImage && logoPosition === 'header' || hasCommercialInHeader) {
      const headerChildren = [];
      
      // Ajouter le logo dans l'en-tête
      if (logoImage && logoPosition === 'header') {
        const originalWidth = visualElements.logo?.original_width || 40;
        const originalHeight = visualElements.logo?.original_height || 40;
        
        headerChildren.push(
          new Paragraph({
            children: [
              new ImageRun({
                data: logoImage,
                transformation: {
                  width: originalWidth * 2.83465,
                  height: originalHeight * 2.83465,
                },
              }),
            ],
            alignment: AlignmentType.LEFT,
            spacing: { after: 120 }
          })
        );
      }
      
      // Ajouter les coordonnées commerciales dans l'en-tête
      if (commercial && hasCommercialInHeader) {
        const contactStyle = templateStyle.element_styles?.commercial_contact || {};
        headerChildren.push(
          new Paragraph({
            children: [
              new TextRun({ 
                text: 'Contact Commercial',
                bold: true,
                size: ptToHalfPt(contactStyle.size || fonts.body_size),
                color: colorToHex(contactStyle.color || colors.text),
                font: contactStyle.font || fonts.body_font,
              }),
            ],
            spacing: { after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({ 
                text: `${commercial.first_name} ${commercial.last_name}`,
                size: ptToHalfPt(contactStyle.size || fonts.body_size),
                color: colorToHex(contactStyle.color || colors.text),
                font: contactStyle.font || fonts.body_font,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ 
                text: commercial.email,
                size: ptToHalfPt(contactStyle.size || fonts.body_size),
                color: colorToHex(contactStyle.color || colors.text),
                font: contactStyle.font || fonts.body_font,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ 
                text: commercial.phone,
                size: ptToHalfPt(contactStyle.size || fonts.body_size),
                color: colorToHex(contactStyle.color || colors.text),
                font: contactStyle.font || fonts.body_font,
              }),
            ],
          })
        );
      }
      
      if (headerChildren.length > 0) {
        headers = {
          default: new Header({
            children: headerChildren,
          }),
        };
      }
    }

    // Helper pour créer un paragraphe avec style de section
    function createSectionTitle(sectionName: string) {
      const sectionStyle = sections.find((s: any) => 
        s.name.toLowerCase().includes(sectionName.toLowerCase())
      ) || sections[0];
      
      const titleStyle = sectionStyle?.title_style || {};
      const sectionSpacing = sectionStyle?.spacing || { top: "5mm", bottom: "5mm" };
      const paragraph = sectionStyle?.paragraph || { alignment: "left" };
      
      return new Paragraph({
        children: [
          new TextRun({ 
            text: sectionName.toUpperCase(),
            bold: titleStyle.bold !== false,
            size: ptToHalfPt(titleStyle.size || fonts.title_size),
            color: colorToHex(titleStyle.color || colors.primary),
            font: titleStyle.font || fonts.title_font,
            underline: titleStyle.underline ? { type: UnderlineType.SINGLE } : undefined,
          }),
        ],
        alignment: paragraph.alignment === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: {
          before: mmToTwip(sectionSpacing.top || "5mm"),
          after: mmToTwip(sectionSpacing.bottom || "5mm"),
        }
      });
    }

    // Helper pour créer un paragraphe de contenu
    function createContentParagraph(textRuns: any[], indent = 0) {
      return new Paragraph({
        children: textRuns,
        spacing: {
          before: parseInt(spacing.element_spacing) * 20 || 120,
          after: parseInt(spacing.element_spacing) * 20 || 120,
          line: parseInt(fonts.line_height || "1.15") * 240,
        },
        indent: indent > 0 ? { left: convertInchesToTwip(indent) } : undefined,
      });
    }

    // Logo dans le corps si pas dans l'en-tête
    if (logoImage && logoPosition !== 'header') {
      const logoSize = visualElements.logo?.size || "40x40mm";
      const [width, height] = logoSize.split('x').map((s: string) => parseInt(s));
      const originalWidth = visualElements.logo?.original_width || width;
      const originalHeight = visualElements.logo?.original_height || height;
      
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: logoImage,
              transformation: {
                width: originalWidth * 2.83465,
                height: originalHeight * 2.83465,
              },
            }),
          ],
          alignment: AlignmentType.LEFT,
          spacing: { after: 240 }
        })
      );
    }

    // Coordonnées du commercial (seulement si pas dans l'en-tête)
    if (commercial && !hasCommercialInHeader) {
      const contactStyle = templateStyle.element_styles?.commercial_contact || {};
      children.push(
        createSectionTitle('Contact Commercial'),
        createContentParagraph([
          new TextRun({ 
            text: 'Nom: ',
            bold: true,
            size: ptToHalfPt(contactStyle.size || fonts.body_size),
            color: colorToHex(contactStyle.color || colors.text),
            font: contactStyle.font || fonts.body_font,
          }),
          new TextRun({ 
            text: `${commercial.first_name} ${commercial.last_name}`,
            size: ptToHalfPt(contactStyle.size || fonts.body_size),
            color: colorToHex(contactStyle.color || colors.text),
            font: contactStyle.font || fonts.body_font,
          }),
        ]),
        createContentParagraph([
          new TextRun({ 
            text: 'Email: ',
            bold: true,
            size: ptToHalfPt(contactStyle.size || fonts.body_size),
            color: colorToHex(contactStyle.color || colors.text),
            font: contactStyle.font || fonts.body_font,
          }),
          new TextRun({ 
            text: commercial.email,
            size: ptToHalfPt(contactStyle.size || fonts.body_size),
            color: colorToHex(contactStyle.color || colors.text),
            font: contactStyle.font || fonts.body_font,
          }),
        ]),
        createContentParagraph([
          new TextRun({ 
            text: 'Téléphone: ',
            bold: true,
            size: ptToHalfPt(contactStyle.size || fonts.body_size),
            color: colorToHex(contactStyle.color || colors.text),
            font: contactStyle.font || fonts.body_font,
          }),
          new TextRun({ 
            text: commercial.phone,
            size: ptToHalfPt(contactStyle.size || fonts.body_size),
            color: colorToHex(contactStyle.color || colors.text),
            font: contactStyle.font || fonts.body_font,
          }),
        ]),
        new Paragraph({ text: '' })
      );
    }

    // Trigramme + titre (pas de section PROFIL)
    const trigramStyle = templateStyle.element_styles?.trigram || {};
    const titleStyleElement = templateStyle.element_styles?.title || {};
    
    children.push(
      new Paragraph({
        children: [
          new TextRun({ 
            text: trigram,
            bold: trigramStyle.bold !== false,
            size: ptToHalfPt(trigramStyle.size || fonts.body_size),
            color: colorToHex(trigramStyle.color || colors.primary),
            font: trigramStyle.font || fonts.body_font,
          }),
        ],
        spacing: { after: 120 },
        alignment: AlignmentType.CENTER
      }),
      new Paragraph({
        children: [
          new TextRun({ 
            text: personal.title || '',
            bold: titleStyleElement.bold || false,
            size: ptToHalfPt(titleStyleElement.size || fonts.body_size),
            color: colorToHex(titleStyleElement.color || colors.text),
            font: titleStyleElement.font || fonts.body_font,
          }),
        ],
        spacing: { after: 240 },
        alignment: AlignmentType.CENTER
      }),
      new Paragraph({ text: '' })
    );

    // COMPÉTENCES
    const skillsLabelStyle = templateStyle.element_styles?.skills_label || {};
    const skillsItemStyle = templateStyle.element_styles?.skills_item || {};
    
    if (skills.technical?.length > 0 || skills.tools?.length > 0 || skills.languages?.length > 0) {
      children.push(createSectionTitle('Compétences'));

      if (skills.technical?.length > 0) {
        children.push(
          createContentParagraph([
            new TextRun({ 
              text: 'Techniques: ',
              bold: skillsLabelStyle.bold !== false,
              size: ptToHalfPt(skillsLabelStyle.size || fonts.body_size),
              color: colorToHex(skillsLabelStyle.color || colors.text),
              font: skillsLabelStyle.font || fonts.body_font,
            }),
          ]),
          ...skills.technical.map((skill: string) => 
            createContentParagraph([
              new TextRun({ 
                text: `• ${skill}`,
                size: ptToHalfPt(skillsItemStyle.size || fonts.body_size),
                color: colorToHex(skillsItemStyle.color || colors.text),
                font: skillsItemStyle.font || fonts.body_font,
                bold: skillsItemStyle.bold || false,
              }),
            ], 0.3)
          )
        );
      }

      if (skills.tools?.length > 0) {
        children.push(
          createContentParagraph([
            new TextRun({ 
              text: 'Outils: ',
              bold: skillsLabelStyle.bold !== false,
              size: ptToHalfPt(skillsLabelStyle.size || fonts.body_size),
              color: colorToHex(skillsLabelStyle.color || colors.text),
              font: skillsLabelStyle.font || fonts.body_font,
            }),
            new TextRun({ 
              text: skills.tools.join(', '),
              size: ptToHalfPt(skillsItemStyle.size || fonts.body_size),
              color: colorToHex(skillsItemStyle.color || colors.text),
              font: skillsItemStyle.font || fonts.body_font,
              bold: skillsItemStyle.bold || false,
            }),
          ])
        );
      }

      if (skills.languages?.length > 0) {
        children.push(
          createContentParagraph([
            new TextRun({ 
              text: 'Langues: ',
              bold: skillsLabelStyle.bold !== false,
              size: ptToHalfPt(skillsLabelStyle.size || fonts.body_size),
              color: colorToHex(skillsLabelStyle.color || colors.text),
              font: skillsLabelStyle.font || fonts.body_font,
            }),
            new TextRun({ 
              text: skills.languages.join(', '),
              size: ptToHalfPt(skillsItemStyle.size || fonts.body_size),
              color: colorToHex(skillsItemStyle.color || colors.text),
              font: skillsItemStyle.font || fonts.body_font,
              bold: skillsItemStyle.bold || false,
            }),
          ])
        );
      }

      children.push(new Paragraph({ text: '' }));
    }

    // EXPÉRIENCES PROFESSIONNELLES
    const missionTitleStyle = templateStyle.element_styles?.mission_title || {};
    const missionContextStyle = templateStyle.element_styles?.mission_context || {};
    const missionAchievementStyle = templateStyle.element_styles?.mission_achievement || {};
    const missionEnvironmentStyle = templateStyle.element_styles?.mission_environment || {};
    
    if (missions.length > 0) {
      children.push(createSectionTitle('Expériences Professionnelles'));

      missions.forEach((mission: any) => {
        // Titre de mission (Client)
        children.push(
          createContentParagraph([
            new TextRun({ 
              text: `${mission.client || 'N/A'}`,
              bold: missionTitleStyle.bold !== false,
              size: ptToHalfPt(missionTitleStyle.size || fonts.body_size),
              color: colorToHex(missionTitleStyle.color || colors.primary),
              font: missionTitleStyle.font || fonts.body_font,
            }),
          ])
        );

        // Dates
        children.push(
          createContentParagraph([
            new TextRun({ 
              text: `${mission.date_start || ''} - ${mission.date_end || ''}`,
              italics: missionContextStyle.italics !== false,
              size: ptToHalfPt(missionContextStyle.size || fonts.body_size) - 2,
              color: colorToHex(missionContextStyle.color || colors.secondary || colors.text),
              font: missionContextStyle.font || fonts.body_font,
            }),
          ])
        );

        // Contexte
        if (mission.context) {
          children.push(
            createContentParagraph([
              new TextRun({ 
                text: 'Contexte: ',
                bold: true,
                size: ptToHalfPt(missionContextStyle.size || fonts.body_size),
                color: colorToHex(colors.text),
                font: missionContextStyle.font || fonts.body_font,
              }),
              new TextRun({ 
                text: mission.context,
                size: ptToHalfPt(missionContextStyle.size || fonts.body_size),
                color: colorToHex(missionContextStyle.color || colors.text),
                font: missionContextStyle.font || fonts.body_font,
                italics: missionContextStyle.italics || false,
              }),
            ])
          );
        }

        // Réalisations
        if (mission.achievements?.length > 0) {
          children.push(
            createContentParagraph([
              new TextRun({ 
                text: 'Réalisations:',
                bold: true,
                size: ptToHalfPt(missionAchievementStyle.size || fonts.body_size),
                color: colorToHex(colors.text),
                font: missionAchievementStyle.font || fonts.body_font,
              }),
            ])
          );

          mission.achievements.forEach((achievement: string) => {
            children.push(
              createContentParagraph([
                new TextRun({ 
                  text: `• ${achievement}`,
                  size: ptToHalfPt(missionAchievementStyle.size || fonts.body_size),
                  color: colorToHex(missionAchievementStyle.color || colors.text),
                  font: missionAchievementStyle.font || fonts.body_font,
                }),
              ], 0.3)
            );
          });
        }

        // Environnement technique
        if (mission.environment?.length > 0) {
          children.push(
            createContentParagraph([
              new TextRun({ 
                text: 'Environnement: ',
                bold: missionEnvironmentStyle.bold !== false,
                size: ptToHalfPt(missionEnvironmentStyle.size || fonts.body_size),
                color: colorToHex(missionEnvironmentStyle.color || colors.text),
                font: missionEnvironmentStyle.font || fonts.body_font,
              }),
              new TextRun({ 
                text: mission.environment.join(', '),
                size: ptToHalfPt(missionEnvironmentStyle.size || fonts.body_size),
                color: colorToHex(missionEnvironmentStyle.color || colors.text),
                font: missionEnvironmentStyle.font || fonts.body_font,
              }),
            ])
          );
        }

        children.push(new Paragraph({ text: '' }));
      });
    }

    // FORMATION
    const educationDegreeStyle = templateStyle.element_styles?.education_degree || {};
    const educationInfoStyle = templateStyle.element_styles?.education_info || {};
    
    if (education.length > 0) {
      children.push(createSectionTitle('Formation'));

      education.forEach((edu: any) => {
        children.push(
          createContentParagraph([
            new TextRun({ 
              text: edu.degree || 'N/A',
              bold: educationDegreeStyle.bold !== false,
              size: ptToHalfPt(educationDegreeStyle.size || fonts.body_size),
              color: colorToHex(educationDegreeStyle.color || colors.text),
              font: educationDegreeStyle.font || fonts.body_font,
            }),
          ]),
          createContentParagraph([
            new TextRun({ 
              text: `${edu.institution || ''} - ${edu.year || ''}`,
              italics: educationInfoStyle.italics !== false,
              size: ptToHalfPt(educationInfoStyle.size || fonts.body_size),
              color: colorToHex(educationInfoStyle.color || colors.secondary || colors.text),
              font: educationInfoStyle.font || fonts.body_font,
              bold: educationInfoStyle.bold || false,
            }),
          ])
        );

        if (edu.field) {
          children.push(
            createContentParagraph([
              new TextRun({ 
                text: `Spécialité: ${edu.field}`,
                size: ptToHalfPt(educationInfoStyle.size || fonts.body_size),
                color: colorToHex(educationInfoStyle.color || colors.text),
                font: educationInfoStyle.font || fonts.body_font,
                bold: educationInfoStyle.bold || false,
              }),
            ])
          );
        }

        children.push(new Paragraph({ text: '' }));
      });
    }

    // Créer le document avec les marges du template
    const layout = templateStyle.layout || {};
    const margins = layout.margins || { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" };
    
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: mmToTwip(margins.top || "20mm"),
              right: mmToTwip(margins.right || "15mm"),
              bottom: mmToTwip(margins.bottom || "20mm"),
              left: mmToTwip(margins.left || "15mm"),
            },
          },
        },
        headers,
        children,
      }],
    });

    // Générer le fichier DOCX
    const buffer = await Packer.toBuffer(doc);
    const blob = new Blob([buffer], { 
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' 
    });

    // Nom du fichier généré - inclure le titre/poste
    const titlePart = title ? ` ${title}` : '';
    const fileName = `${trigram} DC${titlePart}.docx`;
    const filePath = `generated-${Date.now()}-${fileName}`;

    // Upload vers Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(filePath, blob, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      throw uploadError;
    }

    // Mettre à jour le document avec le fichier généré
    const { error: updateError } = await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: filePath,
        generated_file_type: 'docx',
        status: 'processed'
      })
      .eq('id', cvDocumentId);

    if (updateError) {
      throw updateError;
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        filePath,
        fileName,
        message: 'CV Word généré avec succès'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in generate-cv-word:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
