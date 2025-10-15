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

    let structureData;
    
    if (template.file_type === 'pdf') {
      console.log('📄 PDF detected - analyzing structure');
      structureData = await analyzePdfTemplate(fileData);
    } else if (template.file_type === 'docx' || template.file_type === 'doc') {
      console.log('📝 DOCX/DOC detected - analyzing structure');
      structureData = await analyzeDocxTemplate(fileData);
    } else {
      console.log('📝 Using default structure for', template.file_type);
      structureData = getDefaultStructure();
    }

    // Fonction d'analyse PDF avec extraction détaillée
    async function analyzePdfTemplate(pdfData: Blob): Promise<any> {
      try {
        const pdfParse = (await import('https://esm.sh/pdf-parse@1.1.1')).default;
        const arrayBuffer = await pdfData.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);
        
        const data = await pdfParse(buffer);
        console.log(`📄 PDF analysé: ${data.numpages} page(s), ${data.text.length} caractères`);
        
        // Analyser le texte pour détecter la structure
        const lines = data.text.split('\n').filter(l => l.trim());
        const sections = detectSections(lines);
        
        // Analyser la mise en page basé sur le texte
        const hasMultipleColumns = analyzeColumnsFromText(lines);
        const columnCount = hasMultipleColumns ? 2 : 1;
        
        return {
          layout: {
            type: columnCount === 1 ? "colonne-unique" : "deux-colonnes",
            column_widths: getColumnWidths(columnCount),
            sections_order: sections.map(s => s.toLowerCase().replace(/\s+/g, '-')),
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
          sections: sections.map((name, idx) => ({
            name,
            position: idx === 0 ? "top-center" : idx % 2 === 0 ? "right-column" : "left-column",
            title_style: { 
              color: "#2563eb", 
              size: idx === 0 ? "20pt" : "14pt", 
              font: "Calibri", 
              decoration: "none",
              bold: true,
              underline: idx > 0
            },
            spacing: { top: "5mm", bottom: "5mm" },
            paragraph: {
              alignment: idx === 0 ? "center" : "left",
              spacing: { before: "6pt", after: "6pt" },
              indent: { left: "0mm", firstLine: "0mm" }
            }
          })),
          visual_elements: {
            logo: { 
              position: "top-left", 
              size: "40x40mm", 
              shape: "rectangle",
              wrapping: "square",
              alignment: "left"
            },
            borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
            bullets: {
              style: "•",
              color: "#2563eb",
              indent: "12mm"
            }
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
        
      } catch (error) {
        console.error('❌ Erreur analyse PDF:', error);
        return getDefaultStructure();
      }
    }
    
    // Fonction d'analyse DOCX avec extraction détaillée
    async function analyzeDocxTemplate(docxData: Blob): Promise<any> {
      try {
        const mammoth = await import('https://esm.sh/mammoth@1.6.0');
        const arrayBuffer = await docxData.arrayBuffer();
        
        const result = await mammoth.extractRawText({ arrayBuffer });
        const text = result.value;
        
        console.log('📝 DOCX text extrait, longueur:', text.length);
        
        // Analyser le texte pour détecter la structure
        const lines = text.split('\n').filter(l => l.trim());
        const sections = detectSections(lines);
        
        return {
          layout: {
            type: "deux-colonnes",
            column_widths: [35, 65],
            sections_order: sections.map(s => s.toLowerCase().replace(/\s+/g, '-')),
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
          sections: sections.map((name, idx) => ({
            name,
            position: idx === 0 ? "top-center" : idx % 2 === 0 ? "right-column" : "left-column",
            title_style: { 
              color: "#2563eb", 
              size: idx === 0 ? "20pt" : "14pt", 
              font: "Calibri", 
              decoration: "none",
              bold: true,
              underline: idx > 0
            },
            spacing: { top: "5mm", bottom: "5mm" },
            paragraph: {
              alignment: idx === 0 ? "center" : "left",
              spacing: { before: "6pt", after: "6pt" },
              indent: { left: "0mm", firstLine: "0mm" }
            }
          })),
          visual_elements: {
            logo: { 
              position: "top-left", 
              size: "40x40mm", 
              shape: "rectangle",
              wrapping: "square",
              alignment: "left"
            },
            borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
            bullets: {
              style: "•",
              color: "#2563eb",
              indent: "12mm"
            }
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
        
      } catch (error) {
        console.error('❌ Erreur analyse DOCX:', error);
        return getDefaultStructure();
      }
    }
    
    // Helpers
    function analyzeColumnsFromText(lines: string[]): boolean {
      // Détecter si le layout a plusieurs colonnes basé sur des indices textuels
      const shortLines = lines.filter(l => l.length > 0 && l.length < 60);
      return shortLines.length > lines.length * 0.3; // Si 30%+ sont courts, probablement 2 colonnes
    }
    
    function getColumnWidths(count: number): number[] {
      if (count === 1) return [100];
      if (count === 2) return [35, 65];
      return [30, 40, 30];
    }
    
    function detectSections(lines: string[]): string[] {
      const sections = ["PROFIL"];
      const keywords = [
        { keywords: ["compétence", "skill", "expertise", "savoir-faire"], name: "COMPÉTENCES" },
        { keywords: ["expérience", "experience", "mission", "projet"], name: "EXPÉRIENCES PROFESSIONNELLES" },
        { keywords: ["formation", "education", "diplôme", "études"], name: "FORMATION" },
        { keywords: ["langue", "language"], name: "LANGUES" },
        { keywords: ["certification", "certif"], name: "CERTIFICATIONS" },
        { keywords: ["loisir", "hobby", "intérêt"], name: "CENTRES D'INTÉRÊT" }
      ];
      
      const found = new Set<string>();
      
      for (const line of lines) {
        const lower = line.toLowerCase().trim();
        
        // Ignorer les lignes trop longues (probablement pas des titres)
        if (line.length > 60) continue;
        
        for (const { keywords: kws, name } of keywords) {
          if (found.has(name)) continue;
          
          for (const keyword of kws) {
            if (lower.includes(keyword)) {
              sections.push(name);
              found.add(name);
              break;
            }
          }
        }
      }
      
      return sections.slice(0, 6); // Limiter à 6 sections max
    }

    // Fonction helper pour la structure par défaut
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
            title_style: { 
              color: "#2563eb", 
              size: "20pt", 
              font: "Calibri", 
              decoration: "none",
              bold: true,
              underline: false
            },
            spacing: { top: "0mm", bottom: "10mm" },
            paragraph: {
              alignment: "center",
              spacing: { before: "0pt", after: "12pt" },
              indent: { left: "0mm", firstLine: "0mm" }
            }
          },
          { 
            name: "COMPÉTENCES", 
            position: "left-column",
            title_style: { 
              color: "#2563eb", 
              size: "14pt", 
              font: "Calibri", 
              decoration: "none",
              bold: true,
              underline: true
            },
            spacing: { top: "5mm", bottom: "5mm" },
            paragraph: {
              alignment: "left",
              spacing: { before: "6pt", after: "6pt" },
              indent: { left: "0mm", firstLine: "0mm" }
            }
          },
          { 
            name: "EXPÉRIENCES PROFESSIONNELLES", 
            position: "right-column",
            title_style: { 
              color: "#2563eb", 
              size: "14pt", 
              font: "Calibri", 
              decoration: "none",
              bold: true,
              underline: true
            },
            spacing: { top: "5mm", bottom: "5mm" },
            paragraph: {
              alignment: "left",
              spacing: { before: "6pt", after: "6pt" },
              indent: { left: "0mm", firstLine: "0mm" }
            }
          },
          { 
            name: "FORMATION", 
            position: "right-column",
            title_style: { 
              color: "#2563eb", 
              size: "14pt", 
              font: "Calibri", 
              decoration: "none",
              bold: true,
              underline: true
            },
            spacing: { top: "5mm", bottom: "5mm" },
            paragraph: {
              alignment: "left",
              spacing: { before: "6pt", after: "6pt" },
              indent: { left: "0mm", firstLine: "0mm" }
            }
          }
        ],
        visual_elements: {
          logo: { 
            position: "top-left", 
            size: "40x40mm", 
            shape: "rectangle",
            wrapping: "square",
            alignment: "left"
          },
          borders: { style: "solid", width: "0.5pt", color: "#d0d0d0" },
          bullets: {
            style: "•",
            color: "#2563eb",
            indent: "12mm"
          }
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

    console.log('✅ Template activated and all others deactivated');

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
        error: error instanceof Error ? error.message : 'Erreur inconnue',
        details: error instanceof Error ? error.stack : undefined
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
