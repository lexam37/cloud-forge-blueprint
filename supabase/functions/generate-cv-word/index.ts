import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const requestSchema = z.object({
  cvDocumentId: z.string().uuid({ message: 'cvDocumentId must be a valid UUID' })
});

/**
 * Edge function pour générer un CV Word à partir des données extraites
 * Utilise la bibliothèque docx pour créer un nouveau document avec les styles du template
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const { cvDocumentId } = requestSchema.parse(await req.json());
    console.log('[generate-cv-word] Starting generation for:', cvDocumentId);
    
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');
    const jwt = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      throw new Error('User not authenticated');
    }

    console.log('[generate-cv-word] User authenticated:', user.id);

    // Récupérer le document CV
    const { data: cvDoc, error: cvError } = await supabase
      .from('cv_documents')
      .select('*')
      .eq('id', cvDocumentId)
      .eq('user_id', user.id)
      .single();

    if (cvError || !cvDoc) {
      console.error('[generate-cv-word] CV not found:', cvError);
      throw new Error('CV document not found or access denied');
    }

    const extractedData = cvDoc.extracted_data;
    if (!extractedData) {
      throw new Error('No extracted data found - CV not processed yet');
    }

    console.log('[generate-cv-word] CV data loaded, template_id:', cvDoc.template_id);

    // Vérifier qu'un template est sélectionné
    if (!cvDoc.template_id) {
      throw new Error('No template selected for this CV');
    }

    // Récupérer le template
    const { data: template, error: templateError } = await supabase
      .from('cv_templates')
      .select('file_path, structure_data, name')
      .eq('id', cvDoc.template_id)
      .single();

    if (templateError || !template) {
      console.error('[generate-cv-word] Template not found:', templateError);
      throw new Error('Template not found');
    }

    console.log('[generate-cv-word] Using template:', template.name);

    // Télécharger le fichier template
    const { data: templateFile, error: downloadError } = await supabase
      .storage
      .from('cv-templates')
      .download(template.file_path);

    if (downloadError || !templateFile) {
      console.error('[generate-cv-word] Template download error:', downloadError);
      throw new Error(`Failed to download template: ${downloadError?.message}`);
    }

    const templateBuffer = await templateFile.arrayBuffer();
    console.log('[generate-cv-word] Template downloaded, size:', templateBuffer.byteLength, 'bytes');

    /**
     * NOUVELLE APPROCHE : Génération par CLONAGE DE PARAGRAPHES
     * Principe : on extrait des paragraphes exemples du template et on les clone avec tout leur style
     */
    async function generateCVWithJSZip(
      templateBuffer: ArrayBuffer,
      cvData: any,
      templateStructure: any
    ) {
      console.log('[generateCVWithJSZip] Starting PARAGRAPH CLONING generation...');
      console.log('[generateCVWithJSZip] Template structure:', JSON.stringify(templateStructure, null, 2));
      
      const zip = new JSZip();
      await zip.loadAsync(templateBuffer);
      
      // Extraire document.xml
      const docXml = await zip.file("word/document.xml")?.async("string");
      if (!docXml) throw new Error("Cannot extract document.xml from template");
      
      console.log('[generateCVWithJSZip] Extracted document.xml, length:', docXml.length);
      
      let modifiedXml = docXml;
      
      // ÉTAPE 1 : Remplacer l'en-tête (trigramme et titre) - on trouve le texte et on le remplace dans les balises <w:t>
      if (templateStructure?.header?.hasTrigramme) {
        modifiedXml = replaceTextInXml(modifiedXml, ['CVA', 'Trigramme', 'XXX'], cvData.header?.trigram || 'XXX');
        console.log('[generateCVWithJSZip] Replaced trigram:', cvData.header?.trigram);
      }
      
      if (templateStructure?.header?.hasTitle) {
        modifiedXml = replaceTextInXml(
          modifiedXml, 
          ['Analyste Fonctionnel / Product Owner', 'Analyste Fonctionnel \/ Product Owner', 'Titre du poste'],
          cvData.header?.title || 'Poste'
        );
        console.log('[generateCVWithJSZip] Replaced title:', cvData.header?.title);
      }
      
      // ÉTAPE 2 : Traiter les SECTIONS en extrayant et clonant les paragraphes
      for (const section of templateStructure?.sections || []) {
        console.log('[generateCVWithJSZip] Processing section:', section.name, 'with title:', section.title);
        
        if (section.placeholderType === 'competences' && cvData.skills?.subcategories) {
          // Extraire un paragraphe exemple de la section Compétences
          const exampleParagraph = extractExampleParagraph(modifiedXml, section.title);
          console.log('[generateCVWithJSZip] Extracted example paragraph for skills, length:', exampleParagraph?.length);
          
          if (exampleParagraph) {
            const competencesXml = generateSkillsFromExample(
              cvData.skills.subcategories,
              exampleParagraph
            );
            modifiedXml = replaceSectionContent(modifiedXml, section.title, competencesXml);
            console.log('[generateCVWithJSZip] Generated skills section with cloned styles');
          }
        }
        
        if (section.placeholderType === 'missions' && cvData.missions) {
          const exampleParagraphs = extractMultipleExampleParagraphs(modifiedXml, section.title, 2);
          console.log('[generateCVWithJSZip] Extracted', exampleParagraphs.length, 'example paragraphs for missions');
          
          if (exampleParagraphs.length > 0) {
            const missionsXml = generateMissionsFromExample(
              cvData.missions,
              exampleParagraphs
            );
            modifiedXml = replaceSectionContent(modifiedXml, section.title, missionsXml);
            console.log('[generateCVWithJSZip] Generated missions section with cloned styles');
          }
        }
        
        if (section.placeholderType === 'formations' && cvData.education) {
          const exampleParagraph = extractExampleParagraph(modifiedXml, section.title);
          console.log('[generateCVWithJSZip] Extracted example paragraph for education, length:', exampleParagraph?.length);
          
          if (exampleParagraph) {
            const educationXml = generateEducationFromExample(
              cvData.education,
              exampleParagraph
            );
            modifiedXml = replaceSectionContent(modifiedXml, section.title, educationXml);
            console.log('[generateCVWithJSZip] Generated education section with cloned styles');
          }
        }
      }
      
      console.log('[generateCVWithJSZip] All sections processed');
      
      // Réinsérer le XML modifié
      zip.file("word/document.xml", modifiedXml);
      
      // Générer le nouveau fichier
      const generatedBuffer = await zip.generateAsync({ 
        type: "uint8array",
        compression: "DEFLATE"
      });
      
      console.log('[generateCVWithJSZip] Generated buffer size:', generatedBuffer.length);
      
      return generatedBuffer;
    }
    
    /**
     * Remplace du texte dans les balises <w:t> en préservant tous les styles XML environnants
     */
    function replaceTextInXml(xml: string, searchTexts: string[], replacement: string): string {
      let result = xml;
      for (const searchText of searchTexts) {
        // Chercher <w:t>TexteRecherché</w:t> ou <w:t xml:space="preserve">TexteRecherché</w:t>
        const regex = new RegExp(`(<w:t[^>]*>)(${escapeRegex(searchText)})(<\/w:t>)`, 'gi');
        result = result.replace(regex, `$1${escapeXml(replacement)}$3`);
      }
      return result;
    }
    
    /**
     * Extrait un paragraphe exemple d'une section pour le cloner
     */
    function extractExampleParagraph(xml: string, sectionTitle: string): string | null {
      console.log('[extractExampleParagraph] Extracting for section:', sectionTitle);
      
      // Décoder les entités XML dans le titre pour la recherche
      const decodedTitle = decodeXmlEntities(sectionTitle);
      const titleVariations = [sectionTitle, decodedTitle, sectionTitle.replace('&', '&amp;')];
      
      let sectionStart = -1;
      let foundTitle = '';
      
      // Chercher le titre de section avec toutes les variations
      for (const title of titleVariations) {
        const escapedTitle = escapeRegex(title);
        const titleRegex = new RegExp(`<w:t[^>]*>${escapedTitle}<\/w:t>`, 'i');
        const match = titleRegex.exec(xml);
        if (match) {
          sectionStart = match.index;
          foundTitle = title;
          break;
        }
      }
      
      if (sectionStart === -1) {
        console.warn('[extractExampleParagraph] Could not find section title:', sectionTitle);
        return null;
      }
      
      console.log('[extractExampleParagraph] Found section title:', foundTitle, 'at position:', sectionStart);
      
      // Trouver le paragraphe qui suit le titre (premier <w:p> après le titre)
      const afterTitle = xml.substring(sectionStart);
      const nextParagraphMatch = /<w:p[^>]*>[\s\S]*?<\/w:p>/.exec(afterTitle);
      
      if (!nextParagraphMatch) {
        console.warn('[extractExampleParagraph] No paragraph found after title');
        return null;
      }
      
      // Chercher le deuxième paragraphe (le premier est le titre lui-même)
      const afterFirstP = afterTitle.substring(nextParagraphMatch.index + nextParagraphMatch[0].length);
      const secondParagraphMatch = /<w:p[^>]*>[\s\S]*?<\/w:p>/.exec(afterFirstP);
      
      if (secondParagraphMatch) {
        console.log('[extractExampleParagraph] Extracted paragraph, length:', secondParagraphMatch[0].length);
        return secondParagraphMatch[0];
      }
      
      return null;
    }
    
    /**
     * Extrait plusieurs paragraphes exemples d'une section
     */
    function extractMultipleExampleParagraphs(xml: string, sectionTitle: string, count: number): string[] {
      console.log('[extractMultipleExampleParagraphs] Extracting', count, 'paragraphs for:', sectionTitle);
      
      const decodedTitle = decodeXmlEntities(sectionTitle);
      const titleVariations = [sectionTitle, decodedTitle, sectionTitle.replace('&', '&amp;')];
      
      let sectionStart = -1;
      
      for (const title of titleVariations) {
        const escapedTitle = escapeRegex(title);
        const titleRegex = new RegExp(`<w:t[^>]*>${escapedTitle}<\/w:t>`, 'i');
        const match = titleRegex.exec(xml);
        if (match) {
          sectionStart = match.index;
          break;
        }
      }
      
      if (sectionStart === -1) {
        console.warn('[extractMultipleExampleParagraphs] Could not find section title');
        return [];
      }
      
      const paragraphs: string[] = [];
      let searchFrom = sectionStart;
      
      // Extraire les N premiers paragraphes après le titre
      for (let i = 0; i < count + 1; i++) { // +1 pour ignorer le paragraphe titre
        const afterSection = xml.substring(searchFrom);
        const paragraphMatch = /<w:p[^>]*>[\s\S]*?<\/w:p>/.exec(afterSection);
        
        if (!paragraphMatch) break;
        
        if (i > 0) { // Ignorer le premier (titre)
          paragraphs.push(paragraphMatch[0]);
        }
        
        searchFrom += paragraphMatch.index + paragraphMatch[0].length;
      }
      
      console.log('[extractMultipleExampleParagraphs] Extracted', paragraphs.length, 'paragraphs');
      return paragraphs;
    }
    
    /**
     * Génère la section Compétences en clonant le paragraphe exemple
     */
    function generateSkillsFromExample(subcategories: any[], exampleParagraph: string): string {
      let xml = '';
      
      for (const cat of subcategories) {
        const text = `${cat.name}: ${cat.items.join(', ')}`;
        xml += cloneParagraphWithNewText(exampleParagraph, text);
      }
      
      return xml;
    }
    
    /**
     * Génère la section Missions en clonant les paragraphes exemples
     */
    function generateMissionsFromExample(missions: any[], exampleParagraphs: string[]): string {
      const titleParagraph = exampleParagraphs[0] || exampleParagraphs[0];
      const contentParagraph = exampleParagraphs[1] || exampleParagraphs[0];
      let xml = '';
      
      for (const mission of missions) {
        // Titre de mission
        const missionTitle = `${mission.date_start} - ${mission.date_end} ${mission.role} @ ${mission.client}`;
        xml += cloneParagraphWithNewText(titleParagraph, missionTitle);
        
        // Contexte
        if (mission.context) {
          xml += cloneParagraphWithNewText(contentParagraph, `Contexte: ${mission.context}`);
        }
        
        // Missions (liste à puces)
        if (mission.achievements) {
          for (const achievement of mission.achievements) {
            xml += cloneParagraphWithNewText(contentParagraph, achievement);
          }
        }
        
        // Environnement
        if (mission.environment) {
          const envText = `Environnement: ${Array.isArray(mission.environment) ? mission.environment.join(', ') : mission.environment}`;
          xml += cloneParagraphWithNewText(contentParagraph, envText);
        }
      }
      
      return xml;
    }
    
    /**
     * Génère la section Formations en clonant le paragraphe exemple
     */
    function generateEducationFromExample(education: any[], exampleParagraph: string): string {
      let xml = '';
      
      for (const edu of education) {
        const text = `${edu.year} - ${edu.degree} - ${edu.institution}`;
        xml += cloneParagraphWithNewText(exampleParagraph, text);
      }
      
      return xml;
    }
    
    /**
     * Clone un paragraphe XML et remplace uniquement le texte dans les balises <w:t>
     * Préserve TOUS les attributs de style (police, taille, couleur, espacement, etc.)
     */
    function cloneParagraphWithNewText(paragraphXml: string, newText: string): string {
      // Remplacer tout le contenu des balises <w:t>...</w:t> par le nouveau texte
      return paragraphXml.replace(/(<w:t[^>]*>)[^<]*(<\/w:t>)/g, `$1${escapeXml(newText)}$2`);
    }
    
    /**
     * Remplace le contenu d'une section en trouvant son titre (gère les entités XML)
     */
    function replaceSectionContent(xml: string, sectionTitle: string, newContent: string): string {
      console.log('[replaceSectionContent] Searching for section:', sectionTitle);
      
      // Gérer les variations du titre (avec entités XML décodées/encodées)
      const decodedTitle = decodeXmlEntities(sectionTitle);
      const titleVariations = [
        sectionTitle,
        decodedTitle,
        sectionTitle.replace('&', '&amp;'),
        sectionTitle.replace('&amp;', '&')
      ];
      
      let titleMatch: RegExpExecArray | null = null;
      let foundTitle = '';
      
      // Essayer de trouver le titre avec toutes les variations
      for (const title of titleVariations) {
        const escapedTitle = escapeRegex(title);
        const titleRegex = new RegExp(`(<w:p[^>]*>(?:[\\s\\S]*?)<w:t[^>]*>)(${escapedTitle})(<\/w:t>(?:[\\s\\S]*?)<\/w:p>)`, 'i');
        titleMatch = titleRegex.exec(xml);
        
        if (titleMatch) {
          foundTitle = title;
          break;
        }
      }
      
      if (!titleMatch) {
        console.warn('[replaceSectionContent] Could not find section title with any variation:', sectionTitle);
        return xml;
      }
      
      console.log('[replaceSectionContent] Found section title:', foundTitle, 'at position:', titleMatch.index);
      
      // Trouver la fin de cette section (prochaine section ou fin du body)
      const afterTitle = xml.substring(titleMatch.index + titleMatch[0].length);
      
      // Chercher le prochain titre de section
      const nextSectionRegex = /<w:p[^>]*>(?:[\s\S]*?)<w:t[^>]*>(?:Compétences|Expérience|Formations?|Certifications?|Langues?|Projets?|Éducation|Contact|Profil)<\/w:t>(?:[\s\S]*?)<\/w:p>/i;
      const nextSectionMatch = nextSectionRegex.exec(afterTitle);
      
      let sectionEndIndex;
      if (nextSectionMatch) {
        sectionEndIndex = titleMatch.index + titleMatch[0].length + nextSectionMatch.index;
        console.log('[replaceSectionContent] Found next section at position:', sectionEndIndex);
      } else {
        const bodyEndMatch = /<\/w:body>/.exec(xml);
        sectionEndIndex = bodyEndMatch ? bodyEndMatch.index : xml.length;
        console.log('[replaceSectionContent] No next section found, using end of body:', sectionEndIndex);
      }
      
      // Construire le nouveau XML
      const beforeSection = xml.substring(0, titleMatch.index + titleMatch[0].length);
      const afterSection = xml.substring(sectionEndIndex);
      
      const result = beforeSection + '\n' + newContent + '\n' + afterSection;
      
      console.log('[replaceSectionContent] Successfully replaced section');
      console.log('[replaceSectionContent] Content length:', {
        before: titleMatch.index,
        newContent: newContent.length,
        after: xml.length - sectionEndIndex
      });
      
      return result;
    }
    
    /**
     * Échappe les caractères spéciaux XML
     */
    function escapeXml(text: string): string {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }
    
    /**
     * Décode les entités XML
     */
    function decodeXmlEntities(text: string): string {
      return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }
    
    /**
     * Échappe les caractères spéciaux pour les regex
     */
    function escapeRegex(text: string): string {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // CORRECTION CRITIQUE : Déclarer generatedBuffer AVANT le try pour éviter le scope error
    let generatedBuffer: Uint8Array;
    
    try {
      generatedBuffer = await generateCVWithJSZip(
        templateBuffer,
        extractedData,
        template.structure_data
      );
      console.log('[generate-cv-word] CV generated successfully');
    } catch (genError) {
      console.error('[generate-cv-word] Generation failed:', genError);
      throw new Error(`CV generation failed: ${genError instanceof Error ? genError.message : 'Unknown error'}`);
    }

    // Upload du fichier généré
    const trigram = (extractedData as any)?.header?.trigram || 'XXX';
    const title = (extractedData as any)?.header?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'Poste';
    const generatedFileName = `${trigram}_DC_${title}_${Date.now()}.docx`;
    const generatedPath = `${user.id}/${generatedFileName}`;
    
    console.log('[generate-cv-word] Uploading to:', generatedPath);
    
    const { error: uploadError } = await supabase
      .storage
      .from('cv-generated')
      .upload(generatedPath, generatedBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      console.error('[generate-cv-word] Upload error:', uploadError);
      throw new Error(`Failed to upload generated CV: ${uploadError.message}`);
    }

    console.log('[generate-cv-word] File uploaded successfully');

    // Mise à jour du document avec le chemin du fichier généré
    const { error: updateError } = await supabase
      .from('cv_documents')
      .update({
        generated_file_path: generatedPath,
        generated_file_type: 'docx' as any
      })
      .eq('id', cvDocumentId);

    if (updateError) {
      console.error('[generate-cv-word] Update error:', updateError);
      throw new Error(`Failed to update CV document: ${updateError.message}`);
    }

    // Log de succès
    await supabase.from('processing_logs').insert({
      cv_document_id: cvDocumentId,
      step: 'generation',
      message: 'Word CV generated successfully',
      details: { 
        file_path: generatedPath,
        generation_time_ms: Date.now() - startTime
      },
      user_id: user.id
    });

    console.log('[generate-cv-word] Complete in', Date.now() - startTime, 'ms');

    return new Response(
      JSON.stringify({ 
        success: true, 
        file_path: generatedPath,
        file_name: generatedFileName
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[generate-cv-word] Error:', error);
    
    // Log de l'erreur
    try {
      const body = await req.clone().json();
      const { cvDocumentId } = body;
      
      if (cvDocumentId) {
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL')!, 
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );
        const authHeader = req.headers.get('Authorization');
        
        if (authHeader) {
          const jwt = authHeader.replace('Bearer ', '');
          const { data: { user } } = await supabase.auth.getUser(jwt);
          
          await supabase.from('processing_logs').insert({
            cv_document_id: cvDocumentId,
            step: 'error',
            message: `Generation failed: ${error.message}`,
            user_id: user?.id || null
          });
        }
      }
    } catch (logError) {
      console.error('[generate-cv-word] Error logging failure:', logError);
    }

    return new Response(
      JSON.stringify({ 
        error: error.message || 'Unknown error during CV generation'
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
