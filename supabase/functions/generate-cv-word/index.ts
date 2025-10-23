import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun, UnderlineType, convertMillimetersToTwip, Header, Footer } from "https://esm.sh/docx@8.5.0";

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
    if (!cvDocumentId) throw new Error('cvDocumentId is required');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('extracted_data, cv_templates(structure_data)')
      .eq('id', cvDocumentId)
      .single();

    if (cvError || !cvDoc) throw new Error('CV document not found');

    const extractedData = cvDoc.extracted_data || {};
    const templateStyle = cvDoc.cv_templates?.structure_data || {};
    console.log('ExtractedData:', JSON.stringify(extractedData, null, 2));
    console.log('TemplateStyle:', JSON.stringify(templateStyle, null, 2));

    const colors = templateStyle.colors || { primary: "#142D5A", text: "#000000", secondary: "#329696" };
    const fonts = templateStyle.fonts || { title_font: "Segoe UI Symbol", body_font: "Segoe UI Symbol", title_size: "14pt", body_size: "11pt", title_weight: "bold", line_height: "1.15" };
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

    const headerChildren = [];
    const footerChildren = [];

    // En-tête : logo, coordonnées commerciales, trigramme, titre
    if (extractedData.header?.commercial_contact?.enabled) {
      const contactStyle = elementStyles.commercial_contact || {};
      headerChildren.push(
        new Paragraph({
          children: [
            new TextRun({
              text: extractedData.header.commercial_contact.text || 'Contact Commercial',
              bold: contactStyle.bold !== false,
              size: ptToHalfPt(contactStyle.size || fonts.body_size),
              color: colorToHex(contactStyle.color || colors.text),
              font: contactStyle.font || fonts.body_font,
              underline: contactStyle.underline ? { type: UnderlineType.SINGLE, color: colorToHex(contactStyle.underline.color) } : undefined,
            }),
          ],
          alignment: contactStyle.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.RIGHT,
          spacing: { before: ptToHalfPt(contactStyle.spacingBefore || '0pt'), after: ptToHalfPt(contactStyle.spacingAfter || '6pt'), line: ptToHalfPt(contactStyle.lineHeight || '1.15') }
        })
      );
    }

    if (logoImage && visualElements.logo?.present && visualElements.logo?.position === 'header') {
      const widthPoints = (visualElements.logo.width_emu / 914400) * 72;
      const heightPoints = (visualElements.logo.height_emu / 914400) * 72;
      const alignment = visualElements.logo.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT;

      headerChildren.push(
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

    if (extractedData.header?.trigram) {
      const trigramStyle = elementStyles.trigram || {};
      headerChildren.push(
        new Paragraph({
          children: [
            new TextRun({
              text: extractedData.header.trigram,
              bold: trigramStyle.bold !== false,
              size: ptToHalfPt(trigramStyle.size || fonts.body_size),
              color: colorToHex(trigramStyle.color || colors.primary),
              font: trigramStyle.font || fonts.body_font,
              underline: trigramStyle.underline ? { type: UnderlineType.SINGLE, color: colorToHex(trigramStyle.underline.color) } : undefined,
            }),
          ],
          alignment: trigramStyle.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { before: ptToHalfPt(trigramStyle.spacingBefore || '0pt'), after: ptToHalfPt(trigramStyle.spacingAfter || '6pt'), line: ptToHalfPt(trigramStyle.lineHeight || '1.15') }
        })
      );
    }

    if (extractedData.header?.title) {
      const titleStyle = elementStyles.title || {};
      headerChildren.push(
        new Paragraph({
          children: [
            new TextRun({
              text: extractedData.header.title,
              bold: titleStyle.bold !== false,
              size: ptToHalfPt(titleStyle.size || fonts.body_size),
              color: colorToHex(titleStyle.color || colors.text),
              font: titleStyle.font || fonts.body_font,
              underline: titleStyle.underline ? { type: UnderlineType.SINGLE, color: colorToHex(titleStyle.underline.color) } : undefined,
            }),
          ],
          alignment: titleStyle.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { before: ptToHalfPt(titleStyle.spacingBefore || '0pt'), after: ptToHalfPt(titleStyle.spacingAfter || '6pt'), line: ptToHalfPt(titleStyle.lineHeight || '1.15') }
        })
      );
    }

    // Pied de page : texte
    if (extractedData.footer?.text) {
      const footerStyle = elementStyles.footer?.text || {};
      footerChildren.push(
        new Paragraph({
          children: [
            new TextRun({
              text: extractedData.footer.text,
              bold: footerStyle.bold !== false,
              size: ptToHalfPt(footerStyle.size || '10pt'),
              color: colorToHex(footerStyle.color || colors.text),
              font: footerStyle.font || fonts.body_font,
              underline: footerStyle.underline ? { type: UnderlineType.SINGLE, color: colorToHex(footerStyle.underline.color) } : undefined,
            }),
          ],
          alignment: footerStyle.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { before: ptToHalfPt(footerStyle.spacingBefore || '0pt'), after: ptToHalfPt(footerStyle.spacingAfter || '0pt'), line: ptToHalfPt(footerStyle.lineHeight || '1.15') }
        })
      );
    }

    if (logoImage && visualElements.logo?.present && visualElements.logo?.position === 'footer') {
      const widthPoints = (visualElements.logo.width_emu / 914400) * 72;
      const heightPoints = (visualElements.logo.height_emu / 914400) * 72;
      const alignment = visualElements.logo.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT;

      footerChildren.push(
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

    const children = [];

    // Corps du document
    console.log('Sections to process:', sections);
    for (const section of sections) {
      const sectionName = section.name;
      const sectionStyle = section.title_style || { color: "#142D5A", size: "14pt", bold: true, case: "mixed", font: "Segoe UI Symbol" };
      const sectionData = sectionName.toLowerCase().includes('compétence') ? extractedData.skills :
                         sectionName.toLowerCase().includes('expérience') ? extractedData.missions :
                         sectionName.toLowerCase().includes('formation') ? extractedData.education : [];

      children.push(
        new Paragraph({
          children: [
            new TextRun({ 
              text: sectionName,
              bold: sectionStyle.bold !== false,
              size: ptToHalfPt(sectionStyle.size || fonts.title_size),
              color: colorToHex(sectionStyle.color || colors.primary),
              font: sectionStyle.font || fonts.title_font,
              underline: sectionStyle.underline ? { type: UnderlineType.SINGLE, color: colorToHex(sectionStyle.underline.color) } : undefined,
            }),
          ],
          alignment: section.paragraph?.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: {
            before: mmToTwip(section.spacing?.top || spacing.section_spacing),
            after: mmToTwip(section.spacing?.bottom || spacing.element_spacing),
            line: ptToHalfPt(sectionStyle.lineHeight || '1.15')
          }
        })
      );

      if (sectionName.toLowerCase().includes('compétence')) {
        const subcategories = extractedData.skills?.subcategories || [];
        console.log('Skills subcategories:', subcategories);
        for (const subcategory of subcategories) {
          const subcategoryStyle = elementStyles.skill_subcategories?.find((sc: any) => sc.name === subcategory.name)?.style || elementStyles.skills_label || { font: 'Segoe UI Symbol', size: '11pt', color: '#329696', bold: false };
          const items = Array.isArray(subcategory.items) ? subcategory.items.join(', ') : subcategory.items;
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${subcategory.name}: `,
                  bold: subcategoryStyle.bold !== false,
                  italic: subcategoryStyle.italic || false,
                  size: ptToHalfPt(subcategoryStyle.size || fonts.body_size),
                  color: colorToHex(subcategoryStyle.color || colors.secondary),
                  font: subcategoryStyle.font || fonts.body_font,
                  underline: subcategoryStyle.underline ? { type: UnderlineType.SINGLE, color: colorToHex(subcategoryStyle.underline.color) } : undefined,
                }),
                new TextRun({
                  text: items,
                  bold: true,
                  size: ptToHalfPt(elementStyles.skills_item?.size || '11pt'),
                  color: colorToHex(elementStyles.skills_item?.color || '#329696'),
                  font: elementStyles.skills_item?.font || 'Segoe UI Symbol',
                  underline: elementStyles.skills_item?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.skills_item.underline.color) } : undefined,
                }),
              ],
              indent: { left: mmToTwip(subcategoryStyle.indent || '5mm') },
              spacing: { after: ptToHalfPt(subcategoryStyle.spacingAfter || spacing.element_spacing), line: ptToHalfPt(subcategoryStyle.lineHeight || '1.15') }
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
                  color: colorToHex(elementStyles.skills_label?.color || colors.secondary),
                  font: elementStyles.skills_label?.font || fonts.body_font,
                  underline: elementStyles.skills_label?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.skills_label.underline.color) } : undefined,
                }),
                new TextRun({
                  text: extractedData.skills.languages.join(', '),
                  bold: true,
                  size: ptToHalfPt(elementStyles.skills_item?.size || '11pt'),
                  color: colorToHex(elementStyles.skills_item?.color || '#329696'),
                  font: elementStyles.skills_item?.font || 'Segoe UI Symbol',
                  underline: elementStyles.skills_item?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.skills_item.underline.color) } : undefined,
                }),
              ],
              indent: { left: mmToTwip(elementStyles.skills_label?.indent || '5mm') },
              spacing: { after: ptToHalfPt(elementStyles.skills_label?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.skills_label?.lineHeight || '1.15') }
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
                  color: colorToHex(elementStyles.skills_label?.color || colors.secondary),
                  font: elementStyles.skills_label?.font || fonts.body_font,
                  underline: elementStyles.skills_label?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.skills_label.underline.color) } : undefined,
                }),
                new TextRun({
                  text: extractedData.skills.certifications.join(', '),
                  bold: true,
                  size: ptToHalfPt(elementStyles.skills_item?.size || '11pt'),
                  color: colorToHex(elementStyles.skills_item?.color || '#329696'),
                  font: elementStyles.skills_item?.font || 'Segoe UI Symbol',
                  underline: elementStyles.skills_item?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.skills_item.underline.color) } : undefined,
                }),
              ],
              indent: { left: mmToTwip(elementStyles.skills_label?.indent || '5mm') },
              spacing: { after: ptToHalfPt(elementStyles.skills_label?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.skills_label?.lineHeight || '1.15') }
            })
          );
        }
      } else if (sectionName.toLowerCase().includes('expérience')) {
        for (const mission of sectionData) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `${mission.date_start || ''} - ${mission.date_end || ''} ${mission.role || ''} @ ${mission.client || 'N/A'}${mission.location ? `, ${mission.location}` : ''}`,
                  bold: elementStyles.mission_title?.bold !== false,
                  size: ptToHalfPt(elementStyles.mission_title?.size || '11pt'),
                  color: colorToHex(elementStyles.mission_title?.color || '#142D5A'),
                  font: elementStyles.mission_title?.font || 'Segoe UI Symbol',
                  underline: elementStyles.mission_title?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_title.underline.color) } : undefined,
                }),
              ],
              indent: { left: mmToTwip(elementStyles.mission_title?.indent || '0mm') },
              spacing: { after: ptToHalfPt(elementStyles.mission_title?.spacingAfter || '6pt'), line: ptToHalfPt(elementStyles.mission_title?.lineHeight || '1.15') }
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
                    underline: elementStyles.mission_context?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_context.underline.color) } : undefined,
                  }),
                  new TextRun({
                    text: mission.context,
                    italic: elementStyles.mission_context?.italic !== false,
                    size: ptToHalfPt(elementStyles.mission_context?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_context?.color || colors.text),
                    font: elementStyles.mission_context?.font || fonts.body_font,
                    underline: elementStyles.mission_context?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_context.underline.color) } : undefined,
                  }),
                ],
                indent: { left: mmToTwip(elementStyles.mission_context?.indent || '0mm') },
                spacing: { after: ptToHalfPt(elementStyles.mission_context?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.mission_context?.lineHeight || '1.15') }
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
                    underline: elementStyles.mission_achievement?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_achievement.underline.color) } : undefined,
                  }),
                ],
                spacing: { after: ptToHalfPt(elementStyles.mission_achievement?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.mission_achievement?.lineHeight || '1.15') }
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
                      underline: elementStyles.mission_achievement?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_achievement.underline.color) } : undefined,
                    }),
                  ],
                  indent: { left: mmToTwip(elementStyles.mission_achievement?.indent || '5mm') },
                  spacing: { after: ptToHalfPt(elementStyles.mission_achievement?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.mission_achievement?.lineHeight || '1.15') }
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
                    underline: elementStyles.mission_environment?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_environment.underline.color) } : undefined,
                  }),
                  new TextRun({
                    text: mission.environment.join(', '),
                    size: ptToHalfPt(elementStyles.mission_environment?.size || fonts.body_size),
                    color: colorToHex(elementStyles.mission_environment?.color || colors.text),
                    font: elementStyles.mission_environment?.font || fonts.body_font,
                    underline: elementStyles.mission_environment?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.mission_environment.underline.color) } : undefined,
                  }),
                ],
                indent: { left: mmToTwip(elementStyles.mission_environment?.indent || '0mm') },
                spacing: { after: ptToHalfPt(elementStyles.mission_environment?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.mission_environment?.lineHeight || '1.15') }
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
                  text: `${edu.year || ''} ${edu.degree || 'N/A'} @ ${edu.institution || ''}${edu.location ? `, ${edu.location}` : ''}`,
                  bold: elementStyles.education_degree?.bold !== false,
                  size: ptToHalfPt(elementStyles.education_degree?.size || fonts.body_size),
                  color: colorToHex(elementStyles.education_degree?.color || colors.text),
                  font: elementStyles.education_degree?.font || fonts.body_font,
                  underline: elementStyles.education_degree?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.education_degree.underline.color) } : undefined,
                }),
              ],
              indent: { left: mmToTwip(elementStyles.education_degree?.indent || '0mm') },
              spacing: { after: ptToHalfPt(elementStyles.education_degree?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.education_degree?.lineHeight || '1.15') }
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
                    underline: elementStyles.education_place?.underline ? { type: UnderlineType.SINGLE, color: colorToHex(elementStyles.education_place.underline.color) } : undefined,
                  }),
                ],
                indent: { left: mmToTwip(elementStyles.education_place?.indent || '0mm') },
                spacing: { after: ptToHalfPt(elementStyles.education_place?.spacingAfter || spacing.element_spacing), line: ptToHalfPt(elementStyles.skills_place?.lineHeight || '1.15') }
              })
            );
          }
        }
      }
      children.push(new Paragraph({ text: '' }));
    }

    console.log('Children length:', children.length);

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
        headers: headerChildren.length > 0 ? { default: new Header({ children: headerChildren }) } : undefined,
        footers: footerChildren.length > 0 ? { default: new Footer({ children: footerChildren }) } : undefined,
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const fileName = `${extractedData.header?.trigram || 'XXX'} CV.docx`;
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
