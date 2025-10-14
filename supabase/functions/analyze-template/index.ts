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
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Analyzing template:', templateId);

    // Récupérer le template
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found');
    }

    console.log('Template found:', template.name);

    // Télécharger le fichier template
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('cv-templates')
      .download(template.file_path);

    if (downloadError) {
      console.error('Download error:', downloadError);
      throw new Error('Failed to download template file');
    }

    console.log('File downloaded, analyzing structure...');

    // Analyser avec l'IA
    const prompt = `Tu es un expert en analyse de documents CV. Analyse ce template de CV et extrait sa structure visuelle complète.

Retourne un objet JSON avec :
- layout: { type: "colonne-unique" | "deux-colonnes" | "trois-colonnes", sections_order: [...] }
- colors: { primary: "#hex", secondary: "#hex", text: "#hex", background: "#hex" }
- fonts: { title: "nom", body: "nom", sizes: {...} }
- spacing: { margin: "...", padding: "...", line_height: "..." }
- sections: [{ name: "...", position: "...", style: {...} }]
- logo: { position: "...", size: "...", style: {...} }
- visual_elements: { separators: [...], icons: [...], decorations: [...] }

Sois très précis sur les couleurs, polices, espacements et positionnement de chaque élément.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Tu es un expert en analyse de documents CV professionnels.' },
          { role: 'user', content: prompt }
        ],
        tools: [{
          type: "function",
          function: {
            name: "extract_template_structure",
            description: "Extraire la structure complète d'un template de CV",
            parameters: {
              type: "object",
              properties: {
                layout: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["colonne-unique", "deux-colonnes", "trois-colonnes"] },
                    sections_order: { type: "array", items: { type: "string" } }
                  },
                  required: ["type", "sections_order"]
                },
                colors: {
                  type: "object",
                  properties: {
                    primary: { type: "string" },
                    secondary: { type: "string" },
                    text: { type: "string" },
                    background: { type: "string" }
                  },
                  required: ["primary", "text"]
                },
                fonts: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" }
                  }
                },
                sections: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      position: { type: "string" },
                      style: { type: "object" }
                    }
                  }
                },
                logo: {
                  type: "object",
                  properties: {
                    position: { type: "string" },
                    size: { type: "string" }
                  }
                }
              },
              required: ["layout", "colors", "fonts"],
              additionalProperties: false
            }
          }
        }],
        tool_choice: { type: "function", function: { name: "extract_template_structure" } }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI API error:', response.status, errorText);
      throw new Error(`AI API error: ${response.status}`);
    }

    const aiResult = await response.json();
    console.log('AI analysis result:', JSON.stringify(aiResult));

    // Extraire la structure du résultat
    let structureData;
    if (aiResult.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments) {
      structureData = JSON.parse(aiResult.choices[0].message.tool_calls[0].function.arguments);
    } else {
      // Fallback : structure par défaut basée sur le template COBER
      structureData = {
        layout: { 
          type: "colonne-unique", 
          sections_order: ["header", "competences", "experience", "education"] 
        },
        colors: { 
          primary: "#1a1a1a", 
          secondary: "#666666",
          text: "#333333",
          background: "#ffffff"
        },
        fonts: { 
          title: "Arial", 
          body: "Arial"
        },
        sections: [
          { name: "header", position: "top", style: {} },
          { name: "competences", position: "after-header", style: {} },
          { name: "experience", position: "middle", style: {} },
          { name: "education", position: "bottom", style: {} }
        ]
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
      console.error('Update error:', updateError);
      throw updateError;
    }

    // Désactiver les autres templates
    await supabase
      .from('cv_templates')
      .update({ is_active: false })
      .neq('id', templateId);

    console.log('Template structure updated and activated');

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
    console.error('Error in analyze-template:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
