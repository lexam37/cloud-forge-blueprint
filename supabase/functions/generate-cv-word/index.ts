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

/**
 * Convertit une couleur hex en objet compatible docx
 */
function hexToDocxColor(hex: string): string {
  if (!hex || hex === '#000000') return '000000';
  return hex.replace('#', '');
}

/**
 * Convertit des points en half-points (utilisé par docx pour les tailles de police)
 */
function ptToHalfPt(pt: string): number {
  const num = parseFloat(pt.replace('pt', ''));
  return Math.round(num * 2);
}

/**
 * Convertit des points en twips (1/20 de point, utilisé pour les espacements)
 */
function ptToTwip(pt: string): number {
  const num = parseFloat(pt.replace('pt', ''));
  return Math.round(num * 20);
}

/**
 * Applique les styles détaillés d'un élément du template aux options de TextRun
 */
function applyDetailedStyleToTextRun(style: any): any {
  const options: any = {};
  
  if (style.font) options.font = style.font;
  if (style.size) options.size = ptToHalfPt(style.size);
  if (style.color && style.color !== '#000000') options.color = hexToDocxColor(style.color);
  if (style.bold) options.bold = true;
  if (style.italic) options.italics = true;
  if (style.strike) options.strike = true;
  if (style.case === 'uppercase') options.allCaps = true;
  if (style.case === 'lowercase') options.smallCaps = false;
  
  if (style.underline) {
    options.underline = {
      type: UnderlineType.SINGLE,
      color: style.underline.color ? hexToDocxColor(style.underline.color) : undefined
    };
  }
  
  return options;
}

/**
 * Applique les styles détaillés d'un élément du template aux options de Paragraph
 */
function applyDetailedStyleToParagraph(style: any): any {
  const options: any = {};
  
  // Alignement
  if (style.alignment === 'center') options.alignment = AlignmentType.CENTER;
  else if (style.alignment === 'right') options.alignment = AlignmentType.RIGHT;
  else if (style.alignment === 'justify') options.alignment = AlignmentType.JUSTIFIED;
  else options.alignment = AlignmentType.LEFT;
  
  // Espacements
  const spacing: any = {};
  if (style.spacingBefore) spacing.before = ptToTwip(style.spacingBefore);
  if (style.spacingAfter) spacing.after = ptToTwip(style.spacingAfter);
  if (Object.keys(spacing).length > 0) options.spacing = spacing;
  
  // Retraits
  const indent: any = {};
  if (style.indent) indent.left = ptToTwip(style.indent);
  if (style.firstLineIndent) indent.firstLine = ptToTwip(style.firstLineIndent);
  if (Object.keys(indent).length > 0) options.indent = indent;
  
  // Puces
  if (style.bullet && style.bulletStyle === 'bullet') {
    options.bullet = { level: 0 };
  }
  
  return options;
}

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

    // Logs de débogage pour comprendre la structure récupérée
    console.log('[generate-cv-word] cvDoc.cv_templates type:', typeof cvDoc.cv_templates);
    console.log('[generate-cv-word] cvDoc.cv_templates is array:', Array.isArray(cvDoc.cv_templates));
    console.log('[generate-cv-word] cvDoc.cv_templates:', JSON.stringify(cvDoc.cv_templates)?.substring(0, 500));

    const extractedData = cvDoc.extracted_data;
    
    // Fix: cv_templates peut être un tableau ou un objet selon la relation
    const templateStructure = Array.isArray(cvDoc.cv_templates) 
      ? cvDoc.cv_templates[0]?.structure_data 
      : cvDoc.cv_templates?.structure_data;

    console.log('[generate-cv-word] templateStructure exists:', !!templateStructure);
    console.log('[generate-cv-word] templateStructure.detailedStyles exists:', !!templateStructure?.detailedStyles);
    
    if (templateStructure?.detailedStyles) {
      console.log('[generate-cv-word] detailedStyles keys:', Object.keys(templateStructure.detailedStyles));
    }

    if (!extractedData) throw new Error('No extracted data found in CV document');

    console.log('Generating DOCX from extracted data with template styles...');

    // Génération avec styles du template
    const sections: Paragraph[] = [];
    const templateStyles = templateStructure?.detailedStyles || {};
    const headerStyles = templateStructure?.headerElements || [];
    
    console.log('[generate-cv-word] Template styles available:', Object.keys(templateStyles));

    // === EN-TÊTE : Application des styles du template ===
    // Extraction des éléments d'en-tête du template
    if (headerStyles.length > 0) {
      console.log('[generate-cv-word] Applying header styles from template');
      headerStyles.forEach((headerEl: any) => {
        if (headerEl.type === 'img') {
          // Logo - à implémenter si nécessaire avec ImageRun
          console.log('[generate-cv-word] Logo detected in header (skipped for now)');
        } else if (headerEl.text && headerEl.text.length > 2) {
          // Texte d'en-tête (coordonnées commerciales, etc.)
          const textOptions = applyDetailedStyleToTextRun(headerEl.style);
          const paraOptions = applyDetailedStyleToParagraph(headerEl.style);
          
          sections.push(
            new Paragraph({
              ...paraOptions,
              children: [
                new TextRun({
                  text: headerEl.text,
                  ...textOptions
                })
              ]
            })
          );
        }
      });
    }

    // Trigramme avec style du template
    const trigramStyle = templateStyles.header?.trigram || {};
    const trigramTextOptions = applyDetailedStyleToTextRun(trigramStyle);
    const trigramParaOptions = applyDetailedStyleToParagraph(trigramStyle);
    
    sections.push(
      new Paragraph({
        ...trigramParaOptions,
        children: [
          new TextRun({
            text: extractedData.header?.trigram || 'XXX',
            ...trigramTextOptions,
            bold: trigramTextOptions.bold !== undefined ? trigramTextOptions.bold : true
          })
        ]
      })
    );

    // Titre professionnel avec style du template
    if (extractedData.header?.title) {
      const titleStyle = templateStyles.header?.title || {};
      const titleTextOptions = applyDetailedStyleToTextRun(titleStyle);
      const titleParaOptions = applyDetailedStyleToParagraph(titleStyle);
      
      sections.push(
        new Paragraph({
          ...titleParaOptions,
          children: [
            new TextRun({
              text: extractedData.header.title,
              ...titleTextOptions
            })
          ]
        })
      );
    }

    // Contact commercial avec style du template
    if (extractedData.header?.commercial_contact?.enabled) {
      const contactStyle = templateStyles.header?.commercial || {};
      const contactTextOptions = applyDetailedStyleToTextRun(contactStyle);
      const contactParaOptions = applyDetailedStyleToParagraph(contactStyle);
      
      sections.push(
        new Paragraph({
          ...contactParaOptions,
          children: [
            new TextRun({
              text: extractedData.header.commercial_contact.text || 'Contact Commercial',
              ...contactTextOptions
            })
          ]
        })
      );
    }

    // === COMPÉTENCES : Application des styles multi-niveaux ===
    if (extractedData.skills?.subcategories?.length > 0) {
      // Titre de section "Compétences"
      const sectionTitleStyle = templateStyles.competences?.sectionTitle || {};
      const sectionTitleTextOptions = applyDetailedStyleToTextRun(sectionTitleStyle);
      const sectionTitleParaOptions = applyDetailedStyleToParagraph(sectionTitleStyle);
      
      sections.push(
        new Paragraph({
          ...sectionTitleParaOptions,
          children: [
            new TextRun({
              text: 'Compétences',
              ...sectionTitleTextOptions
            })
          ]
        })
      );

      // Catégories et items avec styles spécifiques
      extractedData.skills.subcategories.forEach((subcat: any) => {
        const categoryStyle = templateStyles.competences?.category || {};
        const itemStyle = templateStyles.competences?.item || {};
        
        const categoryTextOptions = applyDetailedStyleToTextRun(categoryStyle);
        const itemTextOptions = applyDetailedStyleToTextRun(itemStyle);
        const paraOptions = applyDetailedStyleToParagraph(categoryStyle);
        
        sections.push(
          new Paragraph({
            ...paraOptions,
            children: [
              new TextRun({
                text: `${subcat.name}: `,
                ...categoryTextOptions
              }),
              new TextRun({
                text: subcat.items.join(', '),
                ...itemTextOptions
              })
            ]
          })
        );
      });
    }

    // === EXPÉRIENCE : Application des styles pour missions ===
    if (extractedData.missions?.length > 0) {
      // Titre de section "Expérience"
      const sectionTitleStyle = templateStyles.experience?.sectionTitle || {};
      const sectionTitleTextOptions = applyDetailedStyleToTextRun(sectionTitleStyle);
      const sectionTitleParaOptions = applyDetailedStyleToParagraph(sectionTitleStyle);
      
      sections.push(
        new Paragraph({
          ...sectionTitleParaOptions,
          children: [
            new TextRun({
              text: 'Expérience',
              ...sectionTitleTextOptions
            })
          ]
        })
      );

      extractedData.missions.forEach((mission: any) => {
        // Titre de mission avec style spécifique
        const missionTitleStyle = templateStyles.experience?.missionTitle || {};
        const missionTitleTextOptions = applyDetailedStyleToTextRun(missionTitleStyle);
        const missionTitleParaOptions = applyDetailedStyleToParagraph(missionTitleStyle);
        
        sections.push(
          new Paragraph({
            ...missionTitleParaOptions,
            children: [
              new TextRun({
                text: `${mission.date_start} - ${mission.date_end} ${mission.role} @ ${mission.client}`,
                ...missionTitleTextOptions
              })
            ]
          })
        );

        // Lieu avec style
        if (mission.location) {
          const locationStyle = templateStyles.experience?.location || {};
          const locationTextOptions = applyDetailedStyleToTextRun(locationStyle);
          const locationParaOptions = applyDetailedStyleToParagraph(locationStyle);
          
          sections.push(
            new Paragraph({
              ...locationParaOptions,
              children: [
                new TextRun({
                  text: `Lieu: ${mission.location}`,
                  ...locationTextOptions
                })
              ]
            })
          );
        }

        // Contexte avec style
        if (mission.context) {
          const contextStyle = templateStyles.experience?.context || {};
          const contextTextOptions = applyDetailedStyleToTextRun(contextStyle);
          const contextParaOptions = applyDetailedStyleToParagraph(contextStyle);
          
          sections.push(
            new Paragraph({
              ...contextParaOptions,
              children: [
                new TextRun({
                  text: `Contexte: ${mission.context}`,
                  ...contextTextOptions
                })
              ]
            })
          );
        }

        // Réalisations avec style
        if (mission.achievements?.length > 0) {
          const achievementStyle = templateStyles.experience?.achievements || {};
          const achievementTextOptions = applyDetailedStyleToTextRun(achievementStyle);
          const achievementParaOptions = applyDetailedStyleToParagraph(achievementStyle);
          
          sections.push(
            new Paragraph({
              ...achievementParaOptions,
              children: [
                new TextRun({
                  text: 'Missions:',
                  ...achievementTextOptions,
                  bold: true
                })
              ]
            })
          );
          
          mission.achievements.forEach((achievement: string) => {
            sections.push(
              new Paragraph({
                ...achievementParaOptions,
                children: [
                  new TextRun({
                    text: `• ${achievement}`,
                    ...achievementTextOptions
                  })
                ]
              })
            );
          });
        }

        // Environnement avec style
        if (mission.environment?.length > 0) {
          const envStyle = templateStyles.experience?.environment || {};
          const envTextOptions = applyDetailedStyleToTextRun(envStyle);
          const envParaOptions = applyDetailedStyleToParagraph(envStyle);
          
          sections.push(
            new Paragraph({
              ...envParaOptions,
              children: [
                new TextRun({
                  text: `Environnement: ${mission.environment.join(', ')}`,
                  ...envTextOptions
                })
              ]
            })
          );
        }
      });
    }

    // === FORMATIONS & CERTIFICATIONS : Application des styles ===
    if (extractedData.education?.length > 0) {
      // Titre de section
      const sectionTitleStyle = templateStyles.formations?.sectionTitle || {};
      const sectionTitleTextOptions = applyDetailedStyleToTextRun(sectionTitleStyle);
      const sectionTitleParaOptions = applyDetailedStyleToParagraph(sectionTitleStyle);
      
      sections.push(
        new Paragraph({
          ...sectionTitleParaOptions,
          children: [
            new TextRun({
              text: 'Formations & Certifications',
              ...sectionTitleTextOptions
            })
          ]
        })
      );

      extractedData.education.forEach((edu: any) => {
        const eduStyle = templateStyles.formations?.item || {};
        const eduTextOptions = applyDetailedStyleToTextRun(eduStyle);
        const eduParaOptions = applyDetailedStyleToParagraph(eduStyle);
        
        sections.push(
          new Paragraph({
            ...eduParaOptions,
            children: [
              new TextRun({
                text: `${edu.year} `,
                ...eduTextOptions,
                bold: true
              }),
              new TextRun({
                text: edu.degree,
                ...eduTextOptions
              })
            ]
          })
        );

        if (edu.institution || edu.location) {
          sections.push(
            new Paragraph({
              ...eduParaOptions,
              children: [
                new TextRun({
                  text: `${edu.institution || ''}${edu.institution && edu.location ? ' - ' : ''}${edu.location || ''}`,
                  ...eduTextOptions
                })
              ]
            })
          );
        }
      });
    }

    // === PIED DE PAGE ===
    if (extractedData.footer?.text) {
      const footerStyle = templateStyles.footer || {};
      const footerTextOptions = applyDetailedStyleToTextRun(footerStyle);
      const footerParaOptions = applyDetailedStyleToParagraph(footerStyle);
      
      sections.push(
        new Paragraph({
          ...footerParaOptions,
          children: [
            new TextRun({
              text: extractedData.footer.text,
              ...footerTextOptions
            })
          ]
        })
      );
    }

    // Récupération des marges du template ou valeurs par défaut
    const pageLayout = templateStructure?.pageLayout || {};
    const margins = pageLayout.margins || {
      top: '2.54cm',
      right: '2cm',
      bottom: '2.54cm',
      left: '2cm'
    };
    
    // Conversion cm -> twips pour docx
    const cmToTwip = (cm: string): number => {
      const num = parseFloat(cm.replace('cm', ''));
      return Math.round(num * 567); // 1cm = 567 twips
    };
    
    console.log('[generate-cv-word] Applying page margins:', margins);

    // Create the document with template margins
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: {
              top: cmToTwip(margins.top),
              right: cmToTwip(margins.right),
              bottom: cmToTwip(margins.bottom),
              left: cmToTwip(margins.left)
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
