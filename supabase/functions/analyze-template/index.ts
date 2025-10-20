import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mammoth } from "https://esm.sh/mammoth@1.6.0";

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

    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('template_file_path')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found');
    }

    const { data: templateFileData, error: fileError } = await supabase
      .storage
      .from('cv_templates')
      .download(template.template_file_path);

    if (fileError || !templateFileData) {
      throw new Error('Failed to download template file');
    }

    const arrayBuffer = await templateFileData.arrayBuffer();
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
    console.log('Extracted HTML from template:', html);

    // Parse the HTML to extract sections and styles
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const paragraphs = doc.querySelectorAll('p');
    const allColors = new Set<string>();
    const styles: any = {};
    const sections: any[] = [];
    let currentSection: string | null = null;

    paragraphs.forEach((p: any) => {
      const text = p.textContent.trim();
      if (!text || text.length < 2) return;

      const style = p.getAttribute('style') || '';
      const colorMatch = style.match(/color:(#[0-9a-f]{6})/i);
      if (colorMatch && colorMatch[1] !== '#000000') allColors.add(colorMatch[1]);
      const fontMatch = style.match(/font-family:([^;]+)/);
      const sizeMatch = style.match(/font-size:([^;]+)/);
      const bold = style.includes('font-weight:bold');
      const italic = style.includes('font-style:italic');

      const parsedStyle = { font: fontMatch ? fontMatch[1] : 'Arial', size: sizeMatch ? sizeMatch[1] : '11pt', color: colorMatch ? colorMatch[1] : '#000000', bold, italic };

      const textLower = text.toLowerCase();
      // Détection des sections (adapté à votre template)
      if (textLower.includes('compétence')) {
        currentSection = 'Compétences';
        sections.push({
          name: 'Compétences',
          title_style: parsedStyle,
          spacing: { top: "10mm", bottom: "5mm" }
        });
      } else if (textLower.includes('expérience')) {
        currentSection = 'Expérience';
        sections.push({
          name: 'Expérience',
          title_style: parsedStyle,
          spacing: { top: "10mm", bottom: "5mm" }
        });
      } else if (textLower.includes('formation')) {
        currentSection = 'Formations & Certifications';
        sections.push({
          name: 'Formations & Certifications',
          title_style: parsedStyle,
          spacing: { top: "10mm", bottom: "5mm" }
        });
      }
      // ... Ajoutez logique pour sous-catégories, logo, etc.
    });

    const structureData = {
      colors: {
        primary: Array.from(allColors)[0] || '#0000FF',
        text: '#000000',
        secondary: Array.from(allColors)[1] || '#000000'
      },
      fonts: {
        title_font: 'Arial',
        body_font: 'Arial',
        title_size: '14pt',
        body_size: '11pt',
        title_weight: 'bold',
        line_height: '1.15'
      },
      sections,
      // ... Ajoutez element_styles, visual_elements
    };

    await supabase
      .from('cv_templates')
      .update({ structure_data: structureData })
      .eq('id', templateId);

    return new Response(
      JSON.stringify({ success: true, templateId, structureData }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (error) {
    console.error('Error in analyze-template:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
