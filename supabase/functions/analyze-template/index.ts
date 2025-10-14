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

    // Convertir le fichier en base64 pour l'envoyer à l'IA (méthode compatible avec les gros fichiers)
    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192; // Traiter par chunks pour éviter le stack overflow
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    const base64 = btoa(binary);
    
    const mimeType = template.file_type === 'pdf' ? 'application/pdf' : 
                     template.file_type === 'docx' || template.file_type === 'doc' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
                     'application/vnd.openxmlformats-officedocument.presentationml.presentation';

    console.log('🤖 Sending to AI for analysis...');

    // Prompt détaillé pour une analyse visuelle complète
    const prompt = `Analyse ce CV template de manière extrêmement détaillée. 

Je veux que tu identifies et extraies TOUS les éléments visuels et structurels :

1. **LAYOUT & STRUCTURE**
   - Type de layout (1, 2 ou 3 colonnes)
   - Ordre exact des sections (header, expérience, formation, compétences, etc.)
   - Pourcentage de largeur de chaque colonne
   - Marges et espacements (en mm ou px)

2. **COULEURS** (avec codes hex précis)
   - Couleur principale (titres, accents)
   - Couleur secondaire
   - Couleur de texte principal
   - Couleur de fond
   - Couleurs des bordures/séparateurs
   - Dégradés éventuels

3. **TYPOGRAPHIE**
   - Police(s) utilisée(s) pour les titres (nom exact)
   - Police(s) pour le corps de texte
   - Tailles de police pour chaque élément (en pt)
   - Graisses (bold, regular, light)
   - Styles (italique, souligné, etc.)
   - Interlignage

4. **SECTIONS & ÉLÉMENTS**
   Pour chaque section identifiée :
   - Position exacte (haut/milieu/bas, gauche/centre/droite)
   - Dimensions
   - Style de titre (couleur, taille, police, décoration)
   - Style de contenu
   - Séparateurs utilisés (ligne, espace, couleur)

5. **ÉLÉMENTS VISUELS**
   - Logo/photo : position, taille, forme (carré, rond, etc.)
   - Icônes : positions, couleurs, tailles
   - Bordures : épaisseurs, couleurs, styles
   - Arrière-plans : couleurs, dégradés, motifs
   - Puces/listes : style, couleur, taille
   - Barres de progression (pour compétences) : style, couleurs

6. **MISE EN PAGE**
   - Alignements (gauche, centre, droite, justifié)
   - Espacements entre éléments
   - Padding des sections
   - Organisation hiérarchique

Sois EXTRÊMEMENT PRÉCIS sur chaque détail visuel pour que je puisse reproduire ce template à l'identique.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-pro', // Utiliser le modèle le plus puissant pour l'analyse visuelle
        messages: [
          { 
            role: 'system', 
            content: 'Tu es un expert en design graphique et analyse de documents. Tu dois extraire chaque détail visuel avec une précision millimétrique.' 
          },
          { 
            role: 'user', 
            content: [
              { type: 'text', text: prompt },
              { 
                type: 'image_url', 
                image_url: { url: `data:${mimeType};base64,${base64}` }
              }
            ]
          }
        ],
        tools: [{
          type: "function",
          function: {
            name: "extract_cv_template_structure",
            description: "Extraire tous les détails visuels et structurels d'un template de CV",
            parameters: {
              type: "object",
              properties: {
                layout: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["colonne-unique", "deux-colonnes", "trois-colonnes"] },
                    column_widths: { type: "array", items: { type: "number" } },
                    sections_order: { type: "array", items: { type: "string" } },
                    margins: { 
                      type: "object",
                      properties: {
                        top: { type: "string" },
                        right: { type: "string" },
                        bottom: { type: "string" },
                        left: { type: "string" }
                      }
                    }
                  },
                  required: ["type", "sections_order"]
                },
                colors: {
                  type: "object",
                  properties: {
                    primary: { type: "string", description: "Couleur principale en hex" },
                    secondary: { type: "string", description: "Couleur secondaire en hex" },
                    text: { type: "string", description: "Couleur du texte en hex" },
                    background: { type: "string", description: "Couleur de fond en hex" },
                    accent: { type: "string", description: "Couleur d'accent en hex" },
                    borders: { type: "string", description: "Couleur des bordures en hex" }
                  },
                  required: ["primary", "text", "background"]
                },
                fonts: {
                  type: "object",
                  properties: {
                    title_font: { type: "string", description: "Nom de la police pour les titres" },
                    body_font: { type: "string", description: "Nom de la police pour le corps" },
                    title_size: { type: "string", description: "Taille des titres (ex: 24pt)" },
                    body_size: { type: "string", description: "Taille du corps (ex: 11pt)" },
                    title_weight: { type: "string", description: "Graisse des titres (bold, regular, etc.)" },
                    line_height: { type: "string", description: "Interlignage (ex: 1.5)" }
                  },
                  required: ["title_font", "body_font"]
                },
                sections: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Nom de la section (ex: Expérience)" },
                      position: { type: "string", description: "Position (ex: top-left, middle-center)" },
                      title_style: { 
                        type: "object",
                        properties: {
                          color: { type: "string" },
                          size: { type: "string" },
                          font: { type: "string" },
                          decoration: { type: "string" }
                        }
                      },
                      spacing: {
                        type: "object",
                        properties: {
                          top: { type: "string" },
                          bottom: { type: "string" }
                        }
                      },
                      separator: {
                        type: "object",
                        properties: {
                          type: { type: "string", description: "Type de séparateur (line, space, none)" },
                          color: { type: "string" },
                          thickness: { type: "string" }
                        }
                      }
                    },
                    required: ["name", "position"]
                  }
                },
                visual_elements: {
                  type: "object",
                  properties: {
                    logo: {
                      type: "object",
                      properties: {
                        position: { type: "string" },
                        size: { type: "string" },
                        shape: { type: "string", enum: ["circle", "square", "rectangle"] }
                      }
                    },
                    icons: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string" },
                          color: { type: "string" },
                          size: { type: "string" },
                          position: { type: "string" }
                        }
                      }
                    },
                    borders: {
                      type: "object",
                      properties: {
                        style: { type: "string" },
                        width: { type: "string" },
                        color: { type: "string" }
                      }
                    },
                    progress_bars: {
                      type: "object",
                      properties: {
                        style: { type: "string" },
                        height: { type: "string" },
                        filled_color: { type: "string" },
                        empty_color: { type: "string" }
                      }
                    }
                  }
                },
                spacing: {
                  type: "object",
                  properties: {
                    section_spacing: { type: "string", description: "Espacement entre sections" },
                    element_spacing: { type: "string", description: "Espacement entre éléments" },
                    padding: { type: "string", description: "Padding général" }
                  }
                }
              },
              required: ["layout", "colors", "fonts", "sections"],
              additionalProperties: false
            }
          }
        }],
        tool_choice: { type: "function", function: { name: "extract_cv_template_structure" } }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ AI API error:', response.status, errorText);
      
      if (response.status === 429) {
        throw new Error('Rate limit atteint. Veuillez réessayer dans quelques instants.');
      }
      if (response.status === 402) {
        throw new Error('Crédits insuffisants. Veuillez ajouter des crédits à votre compte.');
      }
      
      throw new Error(`Erreur API IA: ${response.status}`);
    }

    const aiResult = await response.json();
    console.log('✅ AI analysis completed');

    // Extraire la structure du résultat
    let structureData;
    if (aiResult.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments) {
      try {
        structureData = JSON.parse(aiResult.choices[0].message.tool_calls[0].function.arguments);
        console.log('✅ Structure extracted successfully');
      } catch (parseError) {
        console.error('❌ Failed to parse AI response:', parseError);
        throw new Error('Erreur lors du parsing de la réponse IA');
      }
    } else {
      // Fallback : structure par défaut si l'IA ne répond pas correctement
      console.log('⚠️ Using fallback structure');
      structureData = {
        layout: { 
          type: "deux-colonnes", 
          column_widths: [35, 65],
          sections_order: ["header", "competences", "experience", "education"],
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
          title_font: "Arial", 
          body_font: "Arial",
          title_size: "18pt",
          body_size: "11pt",
          title_weight: "bold",
          line_height: "1.5"
        },
        sections: [
          { 
            name: "En-tête", 
            position: "top-center",
            title_style: { color: "#2563eb", size: "24pt", font: "Arial", decoration: "none" },
            spacing: { top: "0mm", bottom: "10mm" }
          },
          { 
            name: "Compétences", 
            position: "left-column",
            title_style: { color: "#2563eb", size: "14pt", font: "Arial", decoration: "underline" },
            spacing: { top: "5mm", bottom: "5mm" },
            separator: { type: "line", color: "#e2e8f0", thickness: "1px" }
          },
          { 
            name: "Expérience", 
            position: "right-column",
            title_style: { color: "#2563eb", size: "16pt", font: "Arial", decoration: "none" },
            spacing: { top: "5mm", bottom: "5mm" }
          },
          { 
            name: "Formation", 
            position: "right-column",
            title_style: { color: "#2563eb", size: "16pt", font: "Arial", decoration: "none" },
            spacing: { top: "5mm", bottom: "5mm" }
          }
        ],
        visual_elements: {
          logo: { position: "top-left", size: "50x50mm", shape: "circle" },
          borders: { style: "solid", width: "1px", color: "#e2e8f0" }
        },
        spacing: {
          section_spacing: "8mm",
          element_spacing: "3mm",
          padding: "10mm"
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
