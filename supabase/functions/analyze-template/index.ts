import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { templateId } = await req.json();
    
    if (!templateId) {
      throw new Error('templateId is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('🔍 Starting template analysis:', templateId);

    // Récupérer le template
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      console.error('Template not found:', templateError);
      throw new Error('Template not found');
    }

    console.log('✅ Template found:', template.name, 'Type:', template.file_type);

    // Télécharger le fichier template
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('cv-templates')
      .download(template.file_path);

    if (downloadError) {
      console.error('Download error:', downloadError);
      throw new Error('Failed to download template file');
    }

    console.log('✅ File downloaded successfully, size:', fileData.size, 'bytes');

    // Analyser le template selon son type
    let structureData;
    if (template.file_type === 'docx' || template.file_type === 'doc') {
      console.log('📝 DOCX/DOC detected - deep analysis');
      structureData = await analyzeDocxTemplate(fileData);
    } else if (template.file_type === 'pdf') {
      console.log('📄 PDF detected - analysis');
      structureData = await analyzePdfTemplate(fileData);
    } else {
      structureData = getDefaultStructure();
    }

    // Mettre à jour le template avec la structure analysée et l'activer
    const { error: updateError } = await supabase
      .from('cv_templates')
      .update({ 
        structure_data: structureData,
        is_active: true
      })
      .eq('id', templateId);

    if (updateError) {
      console.error('❌ Update error:', updateError);
      throw updateError;
    }

    // Désactiver les autres templates
    await supabase
      .from('cv_templates')
      .update({ is_active: false })
      .neq('id', templateId);

    console.log('✅ Template activated');

    return new Response(
      JSON.stringify({ 
        success: true, 
        structure: structureData,
        message: 'Template analysé et activé avec succès'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('❌ Error in analyze-template:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Erreur inconnue'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});

// Analyse DOCX profonde avec extraction XML
async function analyzeDocxTemplate(docxData: Blob): Promise<any> {
  try {
    const JSZip = (await import('https://esm.sh/jszip@3.10.1')).default;
    const arrayBuffer = await docxData.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const buffer = new Uint8Array(arrayBuffer);
    
    // Récupérer le client Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const documentXml = await zip.file('word/document.xml')?.async('text');
    const stylesXml = await zip.file('word/styles.xml')?.async('text');
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('text');
    
    let headerXml: string | null = null;
    let footerXml: string | null = null;
    
    try {
      const headerFile = await zip.file('word/header1.xml')?.async('text');
      headerXml = headerFile || null;
    } catch {
      // Pas d'en-tête
    }
    
    try {
      const footerFile = await zip.file('word/footer1.xml')?.async('text');
      footerXml = footerFile || null;
    } catch {
      // Pas de pied de page
    }
    
    if (!documentXml) throw new Error('document.xml not found');
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'text/xml');
    const stylesDoc = stylesXml ? parser.parseFromString(stylesXml, 'text/xml') : null;
    const headerDoc = headerXml ? parser.parseFromString(headerXml, 'text/xml') : null;
    const footerDoc = footerXml ? parser.parseFromString(footerXml, 'text/xml') : null;
    const relsDoc = relsXml ? parser.parseFromString(relsXml, 'text/xml') : null;
    
    // Extraire les images avec leurs relations
    const imageRelations: { [key: string]: string } = {};
    if (relsDoc) {
      const relationships = relsDoc.getElementsByTagNameNS('*', 'Relationship');
      for (let i = 0; i < relationships.length; i++) {
        const rel = relationships[i];
        const type = rel.getAttribute('Type');
        const target = rel.getAttribute('Target');
        const id = rel.getAttribute('Id');
        
        if (type?.includes('image') && target && id) {
          imageRelations[id] = 'word/' + target.replace('../', '');
        }
      }
    }
    
    // Analyser les images et extraire le logo
    const images = await extractImagesWithData(doc, headerDoc, zip, imageRelations, supabase);
    const logoInHeader = images.length > 0 && images[0].source === 'header';
    
    // Analyser les styles et sections avec détails
    const analysis = analyzeDocumentDetailed(doc, stylesDoc, headerDoc);
    
    console.log('✅ DOCX analyzed:', {
      sections: analysis.sections.length,
      hasHeader: !!headerDoc,
      hasFooter: !!footerDoc,
      logoInHeader,
      images: images.length,
      extractedLogoPath: images[0]?.extracted_logo_path
    });
    
    return {
      layout: {
        type: "deux-colonnes",
        column_widths: [35, 65],
        sections_order: analysis.sections.map(s => s.name.toLowerCase().replace(/\s+/g, '-')),
        margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" }
      },
      colors: analysis.colors,
      fonts: analysis.fonts,
      sections: analysis.sections,
      element_styles: analysis.element_styles,
      visual_elements: {
        logo: images.length > 0 ? {
          position: logoInHeader ? "header" : "body",
          size: images[0].size,
          shape: "rectangle",
          wrapping: images[0].wrapping,
          alignment: "left",
          original_width: images[0].width,
          original_height: images[0].height,
          extracted_logo_path: images[0].extracted_logo_path
        } : null,
        borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
        bullets: { style: "•", color: analysis.colors.primary, indent: "12mm" }
      },
      spacing: {
        section_spacing: "12pt",
        element_spacing: "6pt",
        padding: "10mm",
        line_spacing: "1.15"
      },
      page: {
        header: { enabled: !!headerDoc },
        footer: { enabled: !!footerDoc },
        first_page_different: false
      }
    };
  } catch (error) {
    console.error('❌ DOCX analysis error:', error);
    return getDefaultStructure();
  }
}

// Extraire les images du document avec leurs données
async function extractImagesWithData(doc: any, headerDoc: any, zip: any, imageRelations: any, supabase: any) {
  const images: any[] = [];
  
  const processDoc = async (xmlDoc: any, source: string) => {
    const drawings = xmlDoc.getElementsByTagNameNS('*', 'drawing');
    for (let i = 0; i < drawings.length; i++) {
      const drawing = drawings[i];
      const extent = drawing.getElementsByTagNameNS('*', 'extent')[0];
      const width = extent ? parseInt(extent.getAttribute('cx') || '0') / 360000 : 40;
      const height = extent ? parseInt(extent.getAttribute('cy') || '0') / 360000 : 40;
      const anchor = drawing.getElementsByTagNameNS('*', 'anchor')[0];
      
      // Extraire l'ID de l'image
      const blip = drawing.getElementsByTagNameNS('*', 'blip')[0];
      if (blip) {
        const embedId = blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
        
        if (embedId && imageRelations[embedId]) {
          const imagePath = imageRelations[embedId];
          const imageFile = zip.file(imagePath);
          
          if (imageFile) {
            const imageBuffer = await imageFile.async('uint8array');
            const ext = imagePath.split('.').pop() || 'png';
            
            // Sauvegarder le logo extrait
            const logoFileName = `template-logo-${Date.now()}.${ext}`;
            const logoBlob = new Blob([imageBuffer]);
            
            try {
              const { error: logoUploadError } = await supabase.storage
                .from('company-logos')
                .upload(logoFileName, logoBlob, {
                  contentType: `image/${ext}`,
                  upsert: true
                });
              
              if (!logoUploadError) {
                console.log('✅ Logo extrait et sauvegardé:', logoFileName);
                images.push({
                  width,
                  height,
                  size: `${Math.round(width)}x${Math.round(height)}mm`,
                  wrapping: anchor ? 'square' : 'inline',
                  source,
                  extracted_logo_path: logoFileName
                });
              }
            } catch (err) {
              console.error('❌ Erreur sauvegarde logo:', err);
            }
          }
        }
      }
    }
  };
  
  if (headerDoc) await processDoc(headerDoc, 'header');
  await processDoc(doc, 'body');
  
  return images;
}

// Analyser le document pour extraire styles et sections avec détails
function analyzeDocumentDetailed(doc: any, stylesDoc: any, headerDoc: any) {
  const paragraphs = doc.getElementsByTagNameNS('*', 'p');
  const headerParagraphs = headerDoc ? headerDoc.getElementsByTagNameNS('*', 'p') : [];
  const sections: any[] = [];
  const colors = new Set<string>();
  
  let bodyFont = 'Calibri';
  let bodySize = '11pt';
  let titleFont = 'Calibri';
  let titleSize = '16pt';
  let primaryColor = '#2563eb';
  
  // Styles spécifiques pour chaque élément
  const elementStyles: any = {
    commercial_contact: { font: 'Calibri', size: '11pt', color: '#000000', bold: false, position: 'body' },
    trigram: { font: 'Calibri', size: '11pt', color: '#2563eb', bold: true },
    title: { font: 'Calibri', size: '11pt', color: '#000000', bold: false },
    section_title: { font: 'Calibri', size: '16pt', color: '#2563eb', bold: true, underline: false },
    mission_title: { font: 'Calibri', size: '11pt', color: '#2563eb', bold: true },
    mission_context: { font: 'Calibri', size: '11pt', color: '#64748b', bold: false, italics: true },
    mission_achievement: { font: 'Calibri', size: '11pt', color: '#000000', bold: false },
    mission_environment: { font: 'Calibri', size: '11pt', color: '#000000', bold: true }
  };
  
  // Analyser l'en-tête pour les coordonnées commerciales
  if (headerParagraphs.length > 0) {
    for (let i = 0; i < headerParagraphs.length; i++) {
      const runs = headerParagraphs[i].getElementsByTagNameNS('*', 'r');
      if (runs.length > 0) {
        const style = extractRunStyle(runs[0]);
        elementStyles.commercial_contact = {
          ...style,
          position: 'header'
        };
        break;
      }
    }
  }
  
  let inExperienceSection = false;
  
  // Analyser chaque paragraphe du corps
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const text = para.textContent?.trim() || '';
    if (!text || text.length < 2) continue;
    
    const runs = para.getElementsByTagNameNS('*', 'r');
    if (runs.length === 0) continue;
    
    const firstRunStyle = extractRunStyle(runs[0]);
    const textUpper = text.toUpperCase();
    
    // Détecter les titres de sections
    if (textUpper.includes('PROFIL') || textUpper.includes('COMPÉTENCE') || 
        textUpper.includes('EXPÉRIENCE') || textUpper.includes('FORMATION')) {
      
      inExperienceSection = textUpper.includes('EXPÉRIENCE');
      
      const pPr = para.getElementsByTagNameNS('*', 'pPr')[0];
      let alignment = 'left';
      if (pPr) {
        const jc = pPr.getElementsByTagNameNS('*', 'jc')[0];
        if (jc) {
          const align = jc.getAttribute('w:val');
          alignment = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
        }
      }
      
      sections.push({
        name: textUpper,
        position: alignment === 'center' ? 'top-center' : 'left-column',
        title_style: firstRunStyle,
        spacing: { top: '5mm', bottom: '5mm' },
        paragraph: {
          alignment,
          spacing: { before: '6pt', after: '6pt' },
          indent: { left: '0mm', firstLine: '0mm' }
        }
      });
      
      elementStyles.section_title = firstRunStyle;
      titleFont = firstRunStyle.font;
      titleSize = firstRunStyle.size;
    }
    // Détecter le trigramme (3 lettres majuscules)
    else if (text.match(/^[A-Z]{3}$/)) {
      elementStyles.trigram = firstRunStyle;
    }
    // Détecter les titres de mission (noms d'entreprises - gras, couleur primaire)
    else if (inExperienceSection && firstRunStyle.bold && text.length > 3 && text.length < 100) {
      elementStyles.mission_title = firstRunStyle;
    }
    // Détecter les dates/contextes (italique ou tirets)
    else if (firstRunStyle.italics || text.includes('-')) {
      elementStyles.mission_context = firstRunStyle;
    }
    // Détecter les environnements techniques
    else if (text.toLowerCase().includes('environnement') || text.toLowerCase().includes('technologie')) {
      const nextRuns = i + 1 < paragraphs.length ? paragraphs[i + 1].getElementsByTagNameNS('*', 'r') : [];
      if (nextRuns.length > 0) {
        elementStyles.mission_environment = extractRunStyle(nextRuns[0]);
      }
    }
    
    // Collecter les couleurs
    if (firstRunStyle.color && firstRunStyle.color !== '#000000' && firstRunStyle.color !== '#FFFFFF') {
      colors.add(firstRunStyle.color);
    }
    
    bodyFont = firstRunStyle.font;
    bodySize = firstRunStyle.size;
  }
  
  // Déterminer la couleur primaire
  const colorArray = Array.from(colors);
  primaryColor = colorArray.find(c => c !== '#000000' && c !== '#FFFFFF') || '#2563eb';
  
  return {
    sections: sections.length > 0 ? sections : [{
      name: 'PROFIL',
      position: 'top-center',
      title_style: { font: titleFont, size: titleSize, color: primaryColor, bold: true, underline: false, decoration: 'none' },
      spacing: { top: '5mm', bottom: '5mm' },
      paragraph: { alignment: 'center', spacing: { before: '0pt', after: '12pt' }, indent: { left: '0mm', firstLine: '0mm' } }
    }],
    fonts: {
      title_font: titleFont,
      body_font: bodyFont,
      title_size: titleSize,
      body_size: bodySize,
      title_weight: 'bold',
      line_height: '1.15'
    },
    colors: {
      primary: primaryColor,
      secondary: '#64748b',
      text: '#1e293b',
      background: '#ffffff',
      accent: primaryColor,
      borders: '#e2e8f0'
    },
    element_styles: elementStyles
  };
}

// Fonction utilitaire pour extraire le style d'un run
function extractRunStyle(run: any) {
  const rPr = run.getElementsByTagNameNS('*', 'rPr')[0];
  const style: any = {
    font: 'Calibri',
    size: '11pt',
    color: '#000000',
    bold: false,
    italics: false,
    underline: false
  };
  
  if (rPr) {
    const rFonts = rPr.getElementsByTagNameNS('*', 'rFonts')[0];
    if (rFonts) {
      style.font = rFonts.getAttribute('w:ascii') || 'Calibri';
    }
    
    const sz = rPr.getElementsByTagNameNS('*', 'sz')[0];
    if (sz) {
      style.size = `${parseInt(sz.getAttribute('w:val') || '22') / 2}pt`;
    }
    
    const colorNode = rPr.getElementsByTagNameNS('*', 'color')[0];
    if (colorNode) {
      const colorVal = colorNode.getAttribute('w:val');
      if (colorVal && colorVal !== 'auto') {
        style.color = `#${colorVal}`;
      }
    }
    
    style.bold = !!rPr.getElementsByTagNameNS('*', 'b')[0];
    style.italics = !!rPr.getElementsByTagNameNS('*', 'i')[0];
    style.underline = !!rPr.getElementsByTagNameNS('*', 'u')[0];
  }
  
  return style;
}

// Analyse PDF basique
async function analyzePdfTemplate(pdfData: Blob): Promise<any> {
  return getDefaultStructure();
}

// Structure par défaut
function getDefaultStructure() {
  return {
    layout: { 
      type: "deux-colonnes", 
      column_widths: [35, 65],
      sections_order: ["profil", "competences", "experiences-professionnelles", "formation"],
      margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" }
    },
    colors: { 
      primary: "#2563eb", 
      secondary: "#64748b",
      text: "#1e293b",
      background: "#ffffff",
      accent: "#3b82f6",
      borders: "#e2e8f0"
    },
    fonts: { 
      title_font: "Calibri", 
      body_font: "Calibri",
      title_size: "16pt",
      body_size: "11pt",
      title_weight: "bold",
      line_height: "1.15"
    },
    sections: [
      { 
        name: "PROFIL", 
        position: "top-center",
        title_style: { color: "#2563eb", size: "20pt", font: "Calibri", decoration: "none", bold: true, underline: false },
        spacing: { top: "0mm", bottom: "10mm" },
        paragraph: { alignment: "center", spacing: { before: "0pt", after: "12pt" }, indent: { left: "0mm", firstLine: "0mm" } }
      }
    ],
    visual_elements: {
      logo: { position: "header", size: "40x40mm", shape: "rectangle", wrapping: "square", alignment: "left" },
      borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
      bullets: { style: "•", color: "#2563eb", indent: "12mm" }
    },
    spacing: {
      section_spacing: "12pt",
      element_spacing: "6pt",
      padding: "10mm",
      line_spacing: "1.15"
    },
    page: {
      header: { enabled: false },
      footer: { enabled: false },
      first_page_different: false
    }
  };
}
