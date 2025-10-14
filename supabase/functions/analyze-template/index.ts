import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
      throw new Error('Template ID is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Fetching template:', templateId);

    // Récupérer le template
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found');
    }

    console.log('Template fetched, downloading file from:', template.file_path);

    // Télécharger le fichier du template
    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('cv-templates')
      .download(template.file_path);

    if (fileError || !fileData) {
      console.error('Error downloading file:', fileError);
      throw new Error('Failed to download template file');
    }

    console.log('File downloaded, size:', fileData.size);

    // Convertir le fichier en base64 pour l'envoyer à l'IA
    const arrayBuffer = await fileData.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    console.log('Calling AI to analyze template...');

    // Appeler l'IA pour analyser la structure du template
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `Tu es un expert en analyse de documents CV. Analyse la structure visuelle et organisationnelle du CV template fourni et extrais les informations suivantes au format JSON strict:
{
  "layout": {
    "type": "string (ex: 'two-column', 'single-column', 'modern', 'classic')",
    "sections_order": ["array des sections dans l'ordre d'apparition"]
  },
  "colors": {
    "primary": "string (couleur principale en hex)",
    "secondary": "string (couleur secondaire en hex)",
    "text": "string (couleur du texte en hex)",
    "background": "string (couleur du fond en hex)"
  },
  "fonts": {
    "headings": "string (nom de la police pour les titres)",
    "body": "string (nom de la police pour le corps)"
  },
  "logo": {
    "present": "boolean",
    "position": "string (ex: 'top-left', 'top-right', 'center')"
  },
  "sections": {
    "header": {"position": "string", "style": "string"},
    "experience": {"format": "string (ex: 'timeline', 'list')"},
    "education": {"format": "string"},
    "skills": {"format": "string (ex: 'tags', 'bars', 'list')"},
    "projects": {"format": "string"}
  },
  "spacing": {
    "margins": "string",
    "line_height": "string"
  }
}`
          },
          {
            role: 'user',
            content: 'Analyse ce template de CV et extrais sa structure détaillée.'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'extract_template_structure',
              description: 'Extract the visual and organizational structure of a CV template',
              parameters: {
                type: 'object',
                properties: {
                  layout: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' },
                      sections_order: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['type', 'sections_order']
                  },
                  colors: {
                    type: 'object',
                    properties: {
                      primary: { type: 'string' },
                      secondary: { type: 'string' },
                      text: { type: 'string' },
                      background: { type: 'string' }
                    },
                    required: ['primary', 'secondary', 'text', 'background']
                  },
                  fonts: {
                    type: 'object',
                    properties: {
                      headings: { type: 'string' },
                      body: { type: 'string' }
                    },
                    required: ['headings', 'body']
                  },
                  logo: {
                    type: 'object',
                    properties: {
                      present: { type: 'boolean' },
                      position: { type: 'string' }
                    },
                    required: ['present', 'position']
                  },
                  sections: {
                    type: 'object',
                    properties: {
                      header: { 
                        type: 'object',
                        properties: {
                          position: { type: 'string' },
                          style: { type: 'string' }
                        }
                      },
                      experience: {
                        type: 'object',
                        properties: {
                          format: { type: 'string' }
                        }
                      },
                      education: {
                        type: 'object',
                        properties: {
                          format: { type: 'string' }
                        }
                      },
                      skills: {
                        type: 'object',
                        properties: {
                          format: { type: 'string' }
                        }
                      },
                      projects: {
                        type: 'object',
                        properties: {
                          format: { type: 'string' }
                        }
                      }
                    }
                  },
                  spacing: {
                    type: 'object',
                    properties: {
                      margins: { type: 'string' },
                      line_height: { type: 'string' }
                    }
                  }
                },
                required: ['layout', 'colors', 'fonts', 'logo', 'sections', 'spacing'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'extract_template_structure' } }
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        throw new Error('Rate limit exceeded. Please try again later.');
      }
      if (aiResponse.status === 402) {
        throw new Error('Payment required. Please add funds to your workspace.');
      }
      throw new Error('AI analysis failed');
    }

    const aiData = await aiResponse.json();
    console.log('AI response received');

    // Extraire les données de la réponse tool calling
    const toolCall = aiData.choices[0].message.tool_calls?.[0];
    if (!toolCall) {
      throw new Error('No structured data returned from AI');
    }

    const structureData = JSON.parse(toolCall.function.arguments);
    console.log('Structure data extracted:', structureData);

    // Mettre à jour le template avec la structure extraite
    const { error: updateError } = await supabase
      .from('cv_templates')
      .update({ structure_data: structureData })
      .eq('id', templateId);

    if (updateError) {
      console.error('Error updating template:', updateError);
      throw new Error('Failed to save template structure');
    }

    console.log('Template structure saved successfully');

    return new Response(
      JSON.stringify({ 
        success: true, 
        templateId,
        structure: structureData 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in analyze-template function:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
