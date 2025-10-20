import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun, UnderlineType, convertInchesToTwip, convertMillimetersToTwip, BorderStyle, Header } from "https://esm.sh/docx@8.5.0";

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

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('extracted_data, cv_templates(structure_data)')
      .eq('id', cvDocumentId)
      .single();

    if (cvError || !cvDoc) {
      throw new Error('CV document not found');
    }

    const extractedData = cvDoc.extracted_data || {};
    const templateStyle = cvDoc.cv_templates?.structure_data || {};
    const colors = templateStyle.colors || { primary: "#0000FF", text: "#000000", secondary: "#000000" }; // Bleu par défaut
    const fonts = templateStyle.fonts || { title_font: "Arial", body_font: "Arial", title_size: "14pt", body_size: "11pt", title_weight: "bold", line_height: "1.15" };
    const spacing = templateStyle.spacing || { section_spacing: "12pt", element_spacing: "6pt", padding: "10mm", line_spacing: "1.15" };
    const sections = templateStyle.sections || [];
    const visualElements = templateStyle.visual_elements || {};
    const elementStyles = templateStyle.element_styles || {};

    const ptToHalfPt = (pt: string) => parseInt(pt.replace('pt', '')) * 2;
    const colorToHex = (color: string) => color.startsWith('#') ? color.replace('#', '') : color;
    const mmToTwip = (mm: string) => convertMillimetersToTwip(parseInt(mm.replace('mm', '')));

    let logoImage = null;
    const logoPath = visualElements.logo?.extracted_logo_path;
    if (logoPath) {
      try {
        const { data: logoData } = await supabase.storage.from('company-logos').download(logoPath);
        if (logoData) {
          logoImage = new Uint8Array(await logoData.arrayBuffer());
          console.log('✅ Logo loaded:', logoPath);
        }
      } catch (err) {
        console.log('❌ Could not load logo:', err);
      }
    }

    const children = [];
    const headers = [];

    // Coordonnées commerciales dans l'en-tête
    if (extractedData.commercial_contact?.enabled) {
      const contactStyle = elementStyles.commercial_contact || {};
      headers.push(
        new Paragraph({
          children: [
            new TextRun({
              text: extractedData.commercial_contact.text || 'Contact Commercial',
              bold: contactStyle.bold !== false,
              size: ptToHalfPt(contactStyle.size || fonts.body_size),
              color: colorToHex(contactStyle.color || colors.text),
              font: contactStyle.font || fonts.body_font,
            }),
          ],
          alignment: contactStyle.paragraph?.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.RIGHT,
          spacing: { after: 120 }
        })
      );
    }

    // Logo dans l'en-tête
    if (logoImage && visualElements.logo?.position === 'header') {
      const widthPoints = (visualElements.logo.width_emu / 914400) * 72;
      const heightPoints = (visualElements.logo.height_emu / 914400) * 72;
      const alignment = visualElements.logo.alignment === 'center' ? AlignmentType.CENTER : visualElements.logo.alignment === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;

      headers.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: logoImage,
              transformation: { width: widthPoints, height: heightPoints },
            }),
          ],
          alignment,
          spacing: { after: 120 }
        })
      );
    }

    // Trigramme et titre
    const trigram = extractedData.personal?.trigram || 'XXX';
    const title = extractedData.personal?.title || '';
    children.push(
      new Paragraph({
        children: [
          new TextRun({ 
            text: trigram,
            bold: elementStyles.trigram?.bold !== false,
            size: ptToHalfPt(elementStyles.trigram?.size || fonts.body_size),
            color: colorToHex(elementStyles.trigram?.color || colors.primary),
            font: elementStyles.trigram?.font || fonts.body_font,
          }),
        ],
        spacing: { after: ptToHalfPt(spacing.element_spacing) },
        alignment: elementStyles.trigram?.paragraph?.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT
      }),
      new Paragraph({
        children: [
          new TextRun({ 
            text: title,
            bold: elementStyles.title?.bold !== false,
            size: ptToHalfPt(elementStyles.title?.size || fonts.body_size),
            color: colorToHex(elementStyles.title?.color || colors.text),
            font: elementStyles.title?.font || fonts.body_font,
          }),
        ],
        spacing: { after: ptToHalfPt(spacing.section_spacing) },
        alignment: elementStyles.title?.paragraph?.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT
      }),
      new Paragraph({ text: '' })
    );

    // Sections dynamiques
    for (const section of sections) {
      const sectionName = section.name;
      const sectionStyle = section.title_style || {};
      const sectionData = sectionName.toLowerCase().includes('compétence') ? extractedData.skills :
                         sectionName.toLowerCase().includes('expérience') ? extractedData.missions :
                         sectionName.toLowerCase().includes('formation') ? extractedData.education : [];

      // Respecter la casse exacte du template
      const formattedSectionName = section.name; // Utiliser le nom exact du template

      children.push(
        new Paragraph({
          children: [
            new TextRun({ 
              text: formattedSectionName,
              bold: sectionStyle.bold !== false,
              size: ptToHalfPt(sectionStyle.size || fonts.title_size),
              color: colorToHex(sectionStyle.color || colors.primary),
              font: sectionStyle.font || fonts.title_font,
              underline: sectionStyle.underline ? { type: UnderlineType.SINGLE } : undefined,
            }),
          ],
          alignment: section.paragraph?.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: {
            before: mmToTwip(section.spacing?.top || spacing.section_spacing),
            after: mmToTwip(section.spacing?.bottom || spacing.element_spacing),
          }
        })
      );

      if (sectionName.toLowerCase().includes('compétence')) {
        const subcategories = extractedData.skills?.subcategories || [];
        for (const subcategory of subcategories) {
          const subcategoryStyle = elementStyles.skill_subcategories?.find((sc: any) => sc.name === subcategory.name)?.style || elementStyles.skills_label || {};
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${subcategory.name}: `,
                  bold: subcategoryStyle.bold !== false,
                  italic: subcategoryStyle.italic || false,
                  size: ptToHalfPt(subcategoryStyle.size || fonts.body_size),
                  color: colorToHex(subcategoryStyle.color || colors.text),
                  font: subcategoryStyle.font || fonts.body_font,
                }),
                new TextRun({
                  text: subcategory.items.join(', '),
                  size: ptToHalfPt(elementStyles.skills_item?.size || fonts.body_size),
                  color: colorToHex(elementStyles.skills_item?.color || colors.text),
                  font: elementStyles.skills_item?.font || fonts.body_font,
                }),
              ],
              indent: { left: mmToTwip(visualElements.bullets?.indent || '5mm') },
              spacing: { after: ptToHalfPt(spacing.element_spacing) }
            })
          );
        }
        if (extractedData.skills?.languages?.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: 'Langues: ',
                  bold: elementStyles.skills_label?.bold !== false,
                  italic: elementStyles.skills_label?.italic || false,
                  size: ptToHalfPt(elementStyles.skills_label?.size || fonts.body_size),
                  color: colorToHex(elementStyles.skills_label?.color || colors.text),
                  font: elementStyles.skills_label?.font || fonts.body_font,
                }),
                new TextRun({
                  text: extractedData.skills.languages.join(', '),
                  size: ptToHalfPt(elementStyles.skills_item?.size || fonts.body_size),
                  color: colorToHex(elementStyles.skills_item?.color || colors.text),
                  font: elementStyles.skills_item?.font || fonts.body_font,
                }),
              ],
              indent: { left: mmToTwip(visualElements.bullets?.indent || '5mm') },
              spacing: { after: ptToHalfPt(spacing.element_spacing) }
            })
          );
        }
        if (extractedData.skills?.certifications?.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: 'Certifications: ',
                  bold: elementStyles.skills_label?.bold !== false,
                  italic: elementStyles.skills_label?.italic || false,
                  size: ptToHalfPt(elementStyles.skills_label?.size || fonts.body_size),
                  color: colorToHex(elementStyles.skills_label?.color || colors.text),
                  font: elementStyles.skills_label?.font || fonts.body_font,
                }),
                new TextRun({
                  text: extractedData.skills.certifications.join(', '),
                  size: ptToHalfPt(elementStyles.skills_item?.size || fonts.body_size),
                  color: colorToHex(elementStyles.skills_item?.color || colors.text),
                  font: elementStyles.skills_item?.font || fonts.body_font,
                }),
              ],
              indent: { left: mmToTwip(visualElements.bullets?.indent || '5mm') },
              spacing: { after: ptToHalfPt(spacing.element_spacing) }
            })
          );
        }
      } else if (sectionName.toLowerCase().includes('expérience')) {
        for (const mission of sectionData) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${mission.date_start || ''} - ${mission.date_end || ''} ${mission.role || ''} @ ${mission.client || 'N/A'}`,
                  bold: elementStyles.mission_title?.bold !== false,
                  size: ptToHalfPt(elementStyles.mission_title?.size || fonts.body_size),
                  color: colorToHex(elementStyles.mission_title?.color || colors.primary),
                  font: elementStyles.mission_title?.font || fonts.body_font,
                }),
              ],
              spacing: { after: ptToHalfPt(spacing.element_spacing) }
            })
          );
          if (mission.context) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: 'Contexte: ',
                    bold: true,
                    size: ptToHalfPt(elementStyles.mission_context?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_context?.color || colors.text),
                    font: elementStyles.mission_context?.font || fonts.body_font,
                  }),
                  new TextRun({
                    text: mission.context,
                    italic: elementStyles.mission_context?.italic !== false,
                    size: ptToHalfPt(elementStyles.mission_context?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_context?.color || colors.text),
                    font: elementStyles.mission_context?.font || fonts.body_font,
                  }),
                ],
                spacing: { after: ptToHalfPt(spacing.element_spacing) }
              })
            );
          }
          if (mission.achievements?.length > 0) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: 'Missions',
                    bold: true,
                    size: ptToHalfPt(elementStyles.mission_achievement?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_achievement?.color || colors.text),
                    font: elementStyles.mission_achievement?.font || fonts.body_font,
                  }),
                ],
                spacing: { after: ptToHalfPt(spacing.element_spacing) }
              })
            );
            for (const achievement of mission.achievements) {
              children.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: `${elementStyles.mission_achievement?.bulletChar || '•'} ${achievement}`,
                      size: ptToHalfPt(elementStyles.mission_achievement?.size || fonts.body_size),
                      color: colorToHex(elementStyles.mission_achievement?.color || colors.text),
                      font: elementStyles.mission_achievement?.font || fonts.body_font,
                    }),
                  ],
                  indent: { left: mmToTwip(visualElements.bullets?.indent || '5mm') },
                  spacing: { after: ptToHalfPt(spacing.element_spacing) }
                })
              );
            }
          }
          if (mission.environment?.length > 0) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: 'Environnement: ',
                    bold: elementStyles.mission_environment?.bold !== false,
                    size: ptToHalfPt(elementStyles.mission_environment?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_environment?.color || colors.text),
                    font: elementStyles.mission_environment?.font || fonts.body_font,
                  }),
                  new TextRun({
                    text: mission.environment.join(', '),
                    size: ptToHalfPt(elementStyles.mission_environment?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_environment?.color || colors.text),
                    font: elementStyles.mission_environment?.font || fonts.body_font,
                  }),
                ],
                spacing: { after: ptToHalfPt(spacing.element_spacing) }
              })
            );
          }
        }
      } else if (sectionName.toLowerCase().includes('formation')) {
        for (const edu of sectionData) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${edu.year || ''} ${edu.degree || 'N/A'} @ ${edu.institution || ''}`,
                  bold: elementStyles.education_degree?.bold !== false,
                  size: ptToHalfPt(elementStyles.education_degree?.size || fonts.body_size),
                  color: colorToHex(elementStyles.education_degree?.color || colors.text),
                  font: elementStyles.education_degree?.font || fonts.body_font,
                }),
              ],
              spacing: { after: ptToHalfPt(spacing.element_spacing) }
            })
          );
          if (edu.field) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: edu.field,
                    size: ptToHalfPt(elementStyles.education_place?.size || fonts.body_size),
                    color: colorToHex(elementStyles.education_place?.color || colors.text),
                    font: elementStyles.education_place?.font || fonts.body_font,
                  }),
                ],
                spacing: { after: ptToHalfPt(spacing.element_spacing) }
              })
            );
          }
        }
      }
      children.push(new Paragraph({ text: '' }));
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: mmToTwip(templateStyle.layout?.margins?.top || "20mm"),
              right: mmToTwip(templateStyle.layout?.margins?.right || "15mm"),
              bottom: mmToTwip(templateStyle.layout?.margins?.bottom || "20mm"),
              left: mmToTwip(templateStyle.layout?.margins?.left || "15mm"),
            },
          },
        },
        headers: headers.length > 0 ? { default: new Header({ children: headers }) } : undefined,
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const fileName = `${trigram} CV.docx`;
    const filePath = `generated-${Date.now()}-${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('cv-generated')
      .upload(filePath, blob, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) throw uploadError;

    await supabase
      .from('cv_documents')
      .update({ 
        generated_file_path: filePath,
        generated_file_type: 'docx',
        status: 'processed'
      })
      .eq('id', cvDocumentId);

    return new Response(
      JSON.stringify({ 
        success: true, 
        filePath,
        fileName,
        message: 'CV Word généré avec succès'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (error) {
    console.error('Error in generate-cv-word:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
