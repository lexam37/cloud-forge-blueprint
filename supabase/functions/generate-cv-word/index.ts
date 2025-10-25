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

    // Générer le CV
    const generatedBuffer = await generateCVWithJSZip(
      templateBuffer,
      extractedData,
      template.structure_data
    );

    console.log('[generate-cv-word] CV generated successfully');

    // Upload le fichier généré
    const fileName = `${cvDoc.trigramme || 'CV'}_${extractedData.header?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'Document'}_${Date.now()}.docx`;
    const filePath = `${user.id}/${fileName}`;

    console.log('[generate-cv-word] Uploading to:', filePath);

    const { error: uploadError } = await supabase
      .storage
      .from('cv-outputs')
      .upload(filePath, generatedBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true
      });

    if (uploadError) {
      console.error('[generate-cv-word] Upload error:', uploadError);
      throw new Error(`Failed to upload generated CV: ${uploadError.message}`);
    }

    console.log('[generate-cv-word] File uploaded successfully');

    // Mettre à jour le document avec le chemin du fichier généré
    const { error: updateError } = await supabase
      .from('cv_documents')
      .update({
        generated_file_path: filePath,
        status: 'processed',
        updated_at: new Date().toISOString()
      })
      .eq('id', cvDocumentId);

    if (updateError) {
      console.error('[generate-cv-word] Update error:', updateError);
    }

    const duration = Date.now() - startTime;
    console.log(`[generate-cv-word] Complete in ${duration} ms`);

    return new Response(
      JSON.stringify({
        success: true,
        file_path: filePath,
        duration_ms: duration
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('[generate-cv-word] Error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

/**
 * Génère le CV en clonant les paragraphes du template avec leur style complet
 */
async function generateCVWithJSZip(
  templateBuffer: ArrayBuffer,
  cvData: any,
  templateStructure: any
) {
  console.log('[generateCVWithJSZip] Starting XML-based generation...');
  console.log('[generateCVWithJSZip] CV Data:', JSON.stringify(cvData, null, 2));
  console.log('[generateCVWithJSZip] Template structure:', JSON.stringify(templateStructure, null, 2));
  
  const zip = new JSZip();
  await zip.loadAsync(templateBuffer);
  
  // Extraire document.xml
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("Cannot extract document.xml from template");
  
  console.log('[generateCVWithJSZip] Extracted document.xml, length:', docXml.length);
  
  let modifiedXml = docXml;
  
  // === REMPLACEMENT HEADER ===
  // Trigramme
  const trigram = cvData.header?.trigram || cvData.trigramme;
  if (trigram) {
    // Chercher et remplacer le trigramme (peut être CVA ou autre)
    const trigramRegex = /<w:t[^>]*>CVA<\/w:t>/g;
    if (modifiedXml.match(trigramRegex)) {
      modifiedXml = modifiedXml.replace(trigramRegex, `<w:t>${escapeXml(trigram)}</w:t>`);
      console.log('[generateCVWithJSZip] Replaced trigram CVA with:', trigram);
    } else {
      // Si CVA n'est pas trouvé, chercher les 3 premières lettres majuscules
      const genericTrigramRegex = /<w:t[^>]*>[A-Z]{3}<\/w:t>/;
      const match = modifiedXml.match(genericTrigramRegex);
      if (match) {
        modifiedXml = modifiedXml.replace(genericTrigramRegex, `<w:t>${escapeXml(trigram)}</w:t>`);
        console.log('[generateCVWithJSZip] Replaced generic trigram with:', trigram);
      }
    }
  }
  
  // Titre du poste - recherche dynamique dans le header
  if (cvData.titre_poste || cvData.header?.title) {
    const title = cvData.titre_poste || cvData.header?.title;
    
    // Trouver le trigramme d'abord pour localiser le header
    const trigramPattern = /<w:t[^>]*>[A-Z]{3}<\/w:t>/;
    const trigramMatch = modifiedXml.match(trigramPattern);
    
    if (trigramMatch && trigramMatch.index !== undefined) {
      // Chercher dans les 2000 caractères suivant le trigramme
      const searchArea = modifiedXml.substring(trigramMatch.index, trigramMatch.index + 2000);
      
      // Trouver le premier texte long (>10 chars) après le trigramme qui est probablement le titre
      const titlePattern = /<w:t[^>]*>([^<]{10,})<\/w:t>/;
      const titleMatch = searchArea.match(titlePattern);
      
      if (titleMatch && titleMatch[1]) {
        const oldTitle = titleMatch[1];
        console.log('[generateCVWithJSZip] Found title to replace:', oldTitle);
        
        // Remplacer ce titre spécifique
        const replacePattern = new RegExp(`<w:t([^>]*)>${escapeRegex(oldTitle)}</w:t>`, 'g');
        modifiedXml = modifiedXml.replace(replacePattern, `<w:t$1>${escapeXml(title)}</w:t>`);
        console.log('[generateCVWithJSZip] Replaced title with:', title);
      } else {
        console.warn('[generateCVWithJSZip] Could not find title to replace in header area');
      }
    } else {
      console.warn('[generateCVWithJSZip] Could not locate header (trigram not found)');
    }
  }
  
  // === REMPLACEMENT DES SECTIONS ===
  // Trouver les positions de toutes les sections d'abord
  const sectionsWithPositions = (templateStructure.sections || []).map((section: any) => {
    const position = findTextPosition(modifiedXml, section.title);
    return { ...section, position };
  }).filter((s: any) => s.position !== -1);
  
  // Trier par position DÉCROISSANTE pour traiter de la fin vers le début
  // Cela évite que les modifications changent les positions des sections précédentes
  sectionsWithPositions.sort((a: any, b: any) => b.position - a.position);
  
  console.log('[generateCVWithJSZip] Sections will be processed in this order (end to start):',
    sectionsWithPositions.map((s: any) => `${s.name}@${s.position}`).join(', '));
  
  for (const section of sectionsWithPositions) {
    console.log(`[generateCVWithJSZip] Processing section: ${section.name} at position ${section.position}`);
    
    // Extraire les paragraphes exemple du template pour cette section
    const templateParagraphs = extractSectionParagraphs(modifiedXml, section.title, 3);
    
    if (templateParagraphs.length === 0) {
      console.warn(`[generateCVWithJSZip] No template paragraphs found for ${section.name}`);
      continue;
    }
    
    console.log(`[generateCVWithJSZip] Extracted ${templateParagraphs.length} template paragraphs`);
    
    let newContent = '';
    
    // Générer le contenu en fonction du type de section
    if (section.placeholderType === 'competences') {
      // Essayer skills.subcategories d'abord (format AI), puis competences (ancien format)
      if (cvData.skills?.subcategories) {
        console.log('[generateCVWithJSZip] Using skills.subcategories for competences');
        newContent = generateSkillsSectionFromSubcategories(cvData.skills.subcategories, templateParagraphs);
      } else if (cvData.competences) {
        console.log('[generateCVWithJSZip] Using competences array');
        newContent = generateSkillsSection(cvData.competences, templateParagraphs);
      } else {
        console.warn('[generateCVWithJSZip] No competences data found');
      }
    }
    else if (section.placeholderType === 'formations') {
      // Essayer education d'abord (format AI), puis formations (ancien format)
      if (cvData.education && cvData.education.length > 0) {
        console.log('[generateCVWithJSZip] Using education array');
        newContent = generateEducationSection(cvData.education, templateParagraphs);
      } else if (cvData.formations && cvData.formations.length > 0) {
        console.log('[generateCVWithJSZip] Using formations array');
        newContent = generateFormationsSection(cvData.formations, templateParagraphs);
      } else {
        console.warn('[generateCVWithJSZip] No formations/education data found');
      }
    }
    else if (section.placeholderType === 'missions') {
      if (cvData.missions && cvData.missions.length > 0) {
        console.log('[generateCVWithJSZip] Using missions array');
        newContent = generateMissionsSection(cvData.missions, templateParagraphs);
      } else {
        console.warn('[generateCVWithJSZip] No missions data found');
      }
    }
    
    if (newContent) {
      modifiedXml = replaceSectionContent(modifiedXml, section.title, newContent);
      console.log(`[generateCVWithJSZip] Replaced section ${section.name}, new content length: ${newContent.length}`);
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
 * Extrait les paragraphes complets d'une section avec leur XML de style
 */
function extractSectionParagraphs(xml: string, sectionTitle: string, maxCount: number = 20): string[] {
  console.log(`[extractSectionParagraphs] Extracting paragraphs for: "${sectionTitle}"`);
  
  // Titres de sections principaux à reconnaître
  const sectionTitles = ['Compétences', 'Formations', 'Certifications', 'Expérience', 'Formation'];
  
  // Trouver le titre de section
  let titlePos = findTextPosition(xml, sectionTitle);
  
  if (titlePos === -1) {
    const words = sectionTitle.split(/[\s&]+/).filter(w => w.length > 2);
    if (words.length > 0) {
      const mainWord = words[0];
      console.log(`[extractSectionParagraphs] Section not found: "${sectionTitle}", trying main word: "${mainWord}"`);
      titlePos = findTextPosition(xml, mainWord);
    }
    
    if (titlePos === -1) {
      console.warn(`[extractSectionParagraphs] Could not find section with title "${sectionTitle}"`);
      return [];
    }
  }
  
  console.log(`[extractSectionParagraphs] Found section at position: ${titlePos}`);
  
  // Extraire les paragraphes qui suivent
  const paragraphs: string[] = [];
  let currentPos = titlePos;
  
  // Sauter le paragraphe du titre
  const titlePEnd = xml.indexOf('</w:p>', currentPos);
  if (titlePEnd === -1) {
    console.warn('[extractSectionParagraphs] Could not find end of title paragraph');
    return [];
  }
  currentPos = titlePEnd + 6;
  console.log(`[extractSectionParagraphs] Starting paragraph extraction from position: ${currentPos}`);
  
  // Extraire les paragraphes jusqu'à trouver une vraie section principale
  for (let i = 0; i < maxCount; i++) {
    const pStart = xml.indexOf('<w:p', currentPos);
    if (pStart === -1) break;
    
    const pEnd = xml.indexOf('</w:p>', pStart);
    if (pEnd === -1) break;
    
    const paragraph = xml.substring(pStart, pEnd + 6);
    
    // Extraire le texte du paragraphe
    const textMatches = paragraph.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    const paragraphText = textMatches ? textMatches.map(m => m.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')).join('').trim() : '';
    
    console.log(`[extractSectionParagraphs] Paragraph ${i + 1} text: ${paragraphText.substring(0, 50) || '(empty)'}`);
    
    // Vérifier si c'est un titre de SECTION PRINCIPALE (pas juste un sous-titre)
    const isBold = paragraph.includes('<w:b/>') || paragraph.includes('<w:b ');
    const sizeMatch = paragraph.match(/<w:sz w:val="(\d+)"\/>/);
    const fontSize = sizeMatch ? parseInt(sizeMatch[1]) : 20;
    
    // Vérifier si le texte correspond à un titre de section principal connu
    const isSectionTitle = sectionTitles.some(title => 
      paragraphText.toLowerCase().includes(title.toLowerCase())
    );
    
    // S'arrêter SEULEMENT si c'est clairement un titre de section principale
    if (isBold && fontSize >= 32 && isSectionTitle && paragraphText.length > 3) {
      console.log(`[extractSectionParagraphs] Found next main section "${paragraphText.substring(0, 30)}", stopping`);
      break;
    }
    
    paragraphs.push(paragraph);
    currentPos = pEnd + 6;
  }
  
  console.log(`[extractSectionParagraphs] Extracted ${paragraphs.length} paragraphs`);
  return paragraphs;
}

/**
 * Trouve la position d'un texte dans le XML (gère les variations d'encodage et texte fragmenté)
 */
function findTextPosition(xml: string, text: string): number {
  console.log(`[findTextPosition] Searching for: "${text}"`);
  
  // Nettoyer le texte recherché
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  // Extraire le premier mot significatif (pour chercher juste ce mot au lieu du titre complet)
  const firstWord = cleanText.split(/[\s&]+/).filter(w => w.length > 2)[0];
  
  // Créer toutes les variations possibles du texte complet ET du premier mot
  const textsToSearch = [cleanText];
  if (firstWord && firstWord !== cleanText) {
    textsToSearch.push(firstWord);
  }
  
  for (const searchText of textsToSearch) {
    const variations = [
      searchText,
      searchText.replace(/&/g, '&amp;'),
      searchText.replace(/&amp;/g, '&'),
      // Encoder les accents en entités XML
      searchText.replace(/é/g, '&#xE9;').replace(/è/g, '&#xE8;').replace(/à/g, '&#xE0;').replace(/ê/g, '&#xEA;').replace(/ô/g, '&#xF4;'),
      // Sans accents
      searchText.replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[ô]/g, 'o').replace(/[î]/g, 'i'),
    ];
    
    // Essayer de trouver chaque variation
    for (const variant of variations) {
      const escapedVariant = escapeRegex(variant);
      
      // 1. Chercher match exact dans une seule balise <w:t>
      const exactRegex = new RegExp(`<w:t[^>]*>${escapedVariant}</w:t>`, 'i');
      const match1 = xml.match(exactRegex);
      if (match1 && match1.index !== undefined) {
        console.log(`[findTextPosition] Found exact match with variant "${variant}" at position ${match1.index}`);
        return match1.index;
      }
      
      // 2. Chercher match partiel (texte plus long contenant notre recherche)
      const partialRegex = new RegExp(`<w:t[^>]*>[^<]*${escapedVariant}[^<]*</w:t>`, 'i');
      const match2 = xml.match(partialRegex);
      if (match2 && match2.index !== undefined) {
        console.log(`[findTextPosition] Found partial match with variant "${variant}" at position ${match2.index}`);
        return match2.index;
      }
      
      // 3. Chercher dans le texte décodé (extraire tout le texte des balises <w:t>)
      const textRegex = /<w:t[^>]*>([^<]+)<\/w:t>/gi;
      let textMatch;
      let concatenatedText = '';
      let lastIndex = 0;
      const positions: number[] = [];
      
      while ((textMatch = textRegex.exec(xml)) !== null) {
        concatenatedText += textMatch[1];
        positions.push(textMatch.index);
        
        // Vérifier si le texte concaténé contient notre recherche
        const normalizedConcatenated = concatenatedText.replace(/\s+/g, ' ').trim();
        const normalizedVariant = variant.replace(/\s+/g, ' ').trim();
        
        if (normalizedConcatenated.toLowerCase().includes(normalizedVariant.toLowerCase())) {
          console.log(`[findTextPosition] Found in concatenated text at position ${positions[0]}`);
          return positions[0];
        }
        
        // Limiter la fenêtre de recherche à 500 caractères
        if (concatenatedText.length > 500) {
          concatenatedText = concatenatedText.substring(concatenatedText.length - 250);
          positions.shift();
        }
      }
    }
  }
  
  console.warn(`[findTextPosition] Text not found: "${text}"`);
  return -1;
}

/**
 * Génère la section Compétences
 */
function generateSkillsSection(competences: any[], templateParagraphs: string[]): string {
  const result: string[] = [];
  const baseParagraph = templateParagraphs[0];
  
  for (const comp of competences) {
    // Ligne de catégorie (ex: "Big Data et analyse de flux temps réel")
    if (comp.category || comp.categorie) {
      const categoryText = comp.category || comp.categorie;
      result.push(cloneParagraphWithText(baseParagraph, categoryText));
    }
    
    // Liste des compétences
    if (comp.skills) {
      const skillsText = Array.isArray(comp.skills) ? comp.skills.join(', ') : comp.skills;
      result.push(cloneParagraphWithText(baseParagraph, `- ${skillsText}`));
    } else if (comp.items) {
      const itemsText = Array.isArray(comp.items) ? comp.items.join(', ') : comp.items;
      result.push(cloneParagraphWithText(baseParagraph, `- ${itemsText}`));
    }
  }
  
  return result.join('');
}

/**
 * Génère la section Compétences depuis subcategories
 */
function generateSkillsSectionFromSubcategories(subcategories: any[], templateParagraphs: string[]): string {
  const result: string[] = [];
  const baseParagraph = templateParagraphs[0];
  
  for (const subcat of subcategories) {
    const text = `${subcat.name}: ${subcat.items.join(', ')}`;
    result.push(cloneParagraphWithText(baseParagraph, text));
  }
  
  return result.join('');
}

/**
 * Génère la section Formations
 */
function generateFormationsSection(formations: any[], templateParagraphs: string[]): string {
  const result: string[] = [];
  const baseParagraph = templateParagraphs[0];
  
  for (const formation of formations) {
    let text = '';
    if (formation.annee) {
      text = `${formation.annee} - ${formation.titre}`;
      if (formation.etablissement) {
        text += ` - ${formation.etablissement}`;
      }
    } else {
      text = formation.titre;
      if (formation.etablissement) {
        text += ` - ${formation.etablissement}`;
      }
    }
    
    result.push(cloneParagraphWithText(baseParagraph, text));
  }
  
  return result.join('');
}

/**
 * Génère la section Education
 */
function generateEducationSection(education: any[], templateParagraphs: string[]): string {
  const result: string[] = [];
  const baseParagraph = templateParagraphs[0];
  
  for (const edu of education) {
    const text = `${edu.year || ''} - ${edu.degree || edu.titre || ''} - ${edu.institution || edu.etablissement || ''}`;
    result.push(cloneParagraphWithText(baseParagraph, text.trim()));
  }
  
  return result.join('');
}

/**
 * Génère la section Missions avec tous les détails
 */
function generateMissionsSection(missions: any[], templateParagraphs: string[]): string {
  const result: string[] = [];
  const normalParagraph = templateParagraphs[0];
  const bulletParagraph = templateParagraphs.length > 1 ? templateParagraphs[1] : templateParagraphs[0];
  
  for (const mission of missions) {
    // En-tête de mission (période, titre, entreprise)
    const periode = mission.periode || `${mission.date_start || ''} - ${mission.date_end || ''}`;
    const titre = mission.titre || mission.role || '';
    const entreprise = mission.entreprise || mission.client || '';
    
    const header = `${periode} ${titre} @ ${entreprise}`.trim();
    result.push(cloneParagraphWithText(normalParagraph, header));
    
    // Contexte
    if (mission.contexte || mission.context) {
      const contexte = mission.contexte || mission.context;
      result.push(cloneParagraphWithText(normalParagraph, `Contexte : ${contexte}`));
    }
    
    // Missions (liste à puces)
    if (mission.missions && mission.missions.length > 0) {
      result.push(cloneParagraphWithText(normalParagraph, 'Missions :'));
      
      for (const item of mission.missions) {
        result.push(cloneParagraphWithText(bulletParagraph, item));
      }
    } else if (mission.achievements && mission.achievements.length > 0) {
      for (const achievement of mission.achievements) {
        result.push(cloneParagraphWithText(bulletParagraph, achievement));
      }
    }
    
    // Environnement
    if (mission.environnement || mission.environment) {
      const env = mission.environnement || mission.environment;
      const envText = Array.isArray(env) ? env.join(', ') : env;
      result.push(cloneParagraphWithText(normalParagraph, `Environnement : ${envText}`));
    }
  }
  
  return result.join('');
}

/**
 * Clone un paragraphe XML et remplace uniquement le texte
 * Préserve TOUTE la mise en forme (police, taille, couleur, gras, italique, puces, etc.)
 */
function cloneParagraphWithText(paragraphXml: string, newText: string): string {
  // Trouver toutes les balises <w:t> et les remplacer
  // On garde la première et on met tout le texte dedans
  let foundFirst = false;
  
  return paragraphXml.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, (match) => {
    if (!foundFirst) {
      foundFirst = true;
      // Garder les attributs de la balise <w:t> mais remplacer le contenu
      return match.replace(/(<w:t[^>]*>)[^<]*(<\/w:t>)/, `$1${escapeXml(newText)}$2`);
    }
    // Supprimer les autres balises <w:t> pour éviter la duplication
    return '';
  });
}

/**
 * Remplace le contenu d'une section dans le document
 */
function replaceSectionContent(xml: string, sectionTitle: string, newContent: string): string {
  console.log(`[replaceSectionContent] Replacing section: ${sectionTitle}`);
  
  // Trouver le début de la section
  let titlePos = findTextPosition(xml, sectionTitle);
  if (titlePos === -1) {
    // Essayer avec le premier mot seulement
    const words = sectionTitle.split(/[\s&]+/).filter(w => w.length > 2);
    if (words.length > 0) {
      titlePos = findTextPosition(xml, words[0]);
    }
    
    if (titlePos === -1) {
      console.warn(`[replaceSectionContent] Section not found: ${sectionTitle}`);
      return xml;
    }
  }
  
  // Trouver le début du paragraphe titre
  const pStart = xml.lastIndexOf('<w:p', titlePos);
  if (pStart === -1) return xml;
  
  // Trouver la fin du paragraphe titre
  const pEnd = xml.indexOf('</w:p>', titlePos);
  if (pEnd === -1) return xml;
  
  const contentStart = pEnd + 6;
  
  // Trouver la fin de la section - chercher le prochain titre de section PRINCIPALE
  const sectionTitles = ['Compétences', 'Formations', 'Certifications', 'Expérience', 'Formation'];
  let contentEnd = xml.indexOf('</w:body>', contentStart);
  
  let searchPos = contentStart;
  const maxSearch = 100;
  
  for (let i = 0; i < maxSearch; i++) {
    const nextPStart = xml.indexOf('<w:p', searchPos);
    if (nextPStart === -1 || nextPStart >= contentEnd) break;
    
    const nextPEnd = xml.indexOf('</w:p>', nextPStart);
    if (nextPEnd === -1) break;
    
    const paragraph = xml.substring(nextPStart, nextPEnd + 6);
    
    // Vérifier si c'est un titre de section PRINCIPALE
    const isBold = paragraph.includes('<w:b/>') || paragraph.includes('<w:b ');
    const sizeMatch = paragraph.match(/<w:sz w:val="(\d+)"\/>/);
    const fontSize = sizeMatch ? parseInt(sizeMatch[1]) : 20;
    
    // Extraire le texte
    const textMatches = paragraph.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    const text = textMatches ? textMatches.map(m => m.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')).join('').trim() : '';
    
    // Vérifier si c'est un titre de section principal connu
    const isSectionTitle = sectionTitles.some(title => 
      text.toLowerCase().includes(title.toLowerCase())
    );
    
    // S'arrêter SEULEMENT pour un vrai titre de section principale
    if (isBold && fontSize >= 32 && isSectionTitle && text.length > 3) {
      console.log(`[replaceSectionContent] Found next section at ${nextPStart}, text: "${text.substring(0, 30)}"`);
      contentEnd = nextPStart;
      break;
    }
    
    searchPos = nextPEnd + 6;
  }
  
  console.log(`[replaceSectionContent] Content range: ${contentStart} to ${contentEnd} (${contentEnd - contentStart} chars)`);
  console.log(`[replaceSectionContent] Inserting new content of length: ${newContent.length}`);
  
  // Construire le nouveau XML - concaténer directement sans newlines
  const before = xml.substring(0, contentStart);
  const after = xml.substring(contentEnd);
  const result = before + newContent + after;
  
  console.log(`[replaceSectionContent] XML length change: ${result.length - xml.length}`);
  
  return result;
}

/**
 * Échappe les caractères XML spéciaux
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
 * Échappe les caractères spéciaux pour regex
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
