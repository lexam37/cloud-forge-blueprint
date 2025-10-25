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
        output_file_path: filePath,
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
  if (cvData.trigramme) {
    const trigramRegex = /<w:t[^>]*>CVA<\/w:t>/g;
    modifiedXml = modifiedXml.replace(trigramRegex, `<w:t>${escapeXml(cvData.trigramme)}</w:t>`);
    console.log('[generateCVWithJSZip] Replaced trigram:', cvData.trigramme);
  }
  
  // Titre du poste
  if (cvData.titre_poste || cvData.header?.title) {
    const title = cvData.titre_poste || cvData.header?.title;
    const titleRegex = /<w:t[^>]*>Analyste Fonctionnel \/ Product Owner<\/w:t>/g;
    modifiedXml = modifiedXml.replace(titleRegex, `<w:t>${escapeXml(title)}</w:t>`);
    console.log('[generateCVWithJSZip] Replaced title:', title);
  }
  
  // === REMPLACEMENT DES SECTIONS ===
  for (const section of templateStructure.sections || []) {
    console.log(`[generateCVWithJSZip] Processing section: ${section.name}`);
    
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
      if (cvData.competences) {
        newContent = generateSkillsSection(cvData.competences, templateParagraphs);
      } else if (cvData.skills?.subcategories) {
        newContent = generateSkillsSectionFromSubcategories(cvData.skills.subcategories, templateParagraphs);
      }
    }
    else if (section.placeholderType === 'formations') {
      if (cvData.formations) {
        newContent = generateFormationsSection(cvData.formations, templateParagraphs);
      } else if (cvData.education) {
        newContent = generateEducationSection(cvData.education, templateParagraphs);
      }
    }
    else if (section.placeholderType === 'missions') {
      if (cvData.missions) {
        newContent = generateMissionsSection(cvData.missions, templateParagraphs);
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
function extractSectionParagraphs(xml: string, sectionTitle: string, maxCount: number = 3): string[] {
  console.log(`[extractSectionParagraphs] Extracting paragraphs for: ${sectionTitle}`);
  
  // Trouver le titre de section
  const titlePos = findTextPosition(xml, sectionTitle);
  if (titlePos === -1) {
    console.warn(`[extractSectionParagraphs] Section not found: ${sectionTitle}`);
    return [];
  }
  
  console.log(`[extractSectionParagraphs] Found section at position: ${titlePos}`);
  
  // Extraire les paragraphes qui suivent
  const paragraphs: string[] = [];
  let currentPos = titlePos;
  
  // Sauter le paragraphe du titre
  const titlePEnd = xml.indexOf('</w:p>', currentPos);
  if (titlePEnd === -1) return [];
  currentPos = titlePEnd + 6;
  
  // Extraire les N paragraphes suivants
  for (let i = 0; i < maxCount; i++) {
    const pStart = xml.indexOf('<w:p', currentPos);
    if (pStart === -1) break;
    
    const pEnd = xml.indexOf('</w:p>', pStart);
    if (pEnd === -1) break;
    
    const paragraph = xml.substring(pStart, pEnd + 6);
    
    // Vérifier que ce n'est pas une nouvelle section (titre en gras)
    const hasNextSectionTitle = /<w:t[^>]*>(?:Compétences|Expérience|Formations?|Certifications?|Langues?|Profil|Contact|Éducation|Projets?)<\/w:t>/i.test(paragraph);
    if (hasNextSectionTitle) {
      console.log(`[extractSectionParagraphs] Found next section title, stopping extraction`);
      break;
    }
    
    paragraphs.push(paragraph);
    currentPos = pEnd + 6;
  }
  
  console.log(`[extractSectionParagraphs] Extracted ${paragraphs.length} paragraphs`);
  return paragraphs;
}

/**
 * Trouve la position d'un texte dans le XML (gère les variations d'encodage)
 */
function findTextPosition(xml: string, text: string): number {
  const variations = [
    text,
    text.replace(/&/g, '&amp;'),
    text.replace(/é/g, '&#xE9;').replace(/è/g, '&#xE8;').replace(/à/g, '&#xE0;')
  ];
  
  for (const variant of variations) {
    const regex = new RegExp(`<w:t[^>]*>${escapeRegex(variant)}</w:t>`, 'i');
    const match = xml.match(regex);
    if (match && match.index !== undefined) {
      return match.index;
    }
  }
  
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
  
  return result.join('\n');
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
  
  return result.join('\n');
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
  
  return result.join('\n');
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
  
  return result.join('\n');
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
  
  return result.join('\n');
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
  const titlePos = findTextPosition(xml, sectionTitle);
  if (titlePos === -1) {
    console.warn(`[replaceSectionContent] Section not found: ${sectionTitle}`);
    return xml;
  }
  
  // Trouver le début du paragraphe titre
  const pStart = xml.lastIndexOf('<w:p', titlePos);
  if (pStart === -1) return xml;
  
  // Trouver la fin du paragraphe titre
  const pEnd = xml.indexOf('</w:p>', titlePos);
  if (pEnd === -1) return xml;
  
  const contentStart = pEnd + 6;
  
  // Trouver la fin de la section (prochain titre ou fin du body)
  let contentEnd = xml.indexOf('</w:body>', contentStart);
  
  // Chercher le prochain titre de section
  const nextTitleRegex = /<w:p[^>]*>(?:[\s\S]*?)<w:t[^>]*>(?:Compétences|Expérience|Formations?|Certifications?|Langues?|Profil|Contact|Éducation|Projets?)<\/w:t>/i;
  const match = nextTitleRegex.exec(xml.substring(contentStart));
  
  if (match && match.index !== undefined) {
    // Trouver le début du paragraphe de ce titre
    const nextPStart = xml.lastIndexOf('<w:p', contentStart + match.index + 50);
    if (nextPStart > contentStart) {
      contentEnd = nextPStart;
    }
  }
  
  console.log(`[replaceSectionContent] Content range: ${contentStart} to ${contentEnd} (${contentEnd - contentStart} chars)`);
  
  // Construire le nouveau XML
  const before = xml.substring(0, contentStart);
  const after = xml.substring(contentEnd);
  
  return before + '\n' + newContent + '\n' + after;
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
