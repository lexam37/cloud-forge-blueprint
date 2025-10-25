import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { parseStringPromise, Builder } from "https://esm.sh/xml2js@0.6.2";

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
    const generatedBuffer = await generateCVWithXml2js(
      templateBuffer,
      extractedData,
      template.structure_data
    );

    console.log('[generate-cv-word] CV generated successfully');

    // Upload le fichier généré
    const fileName = `CV_${extractedData.header?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'Document'}_${Date.now()}.docx`;
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
 * Génère le CV en utilisant xml2js pour manipuler le XML de manière structurée
 */
async function generateCVWithXml2js(
  templateBuffer: ArrayBuffer,
  cvData: any,
  templateStructure: any
) {
  console.log('[generateCV] Starting with xml2js approach');
  console.log('[generateCV] Template structure:', JSON.stringify(templateStructure, null, 2));
  
  const zip = new JSZip();
  await zip.loadAsync(templateBuffer);
  
  // Extraire document.xml
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("Cannot extract document.xml from template");
  
  // Parser le XML en objet JavaScript
  const doc = await parseStringPromise(docXml, {
    explicitArray: true,
    preserveChildrenOrder: true,
    xmlns: true
  });
  
  if (!doc['w:document'] || !doc['w:document']['w:body']) {
    throw new Error('Invalid Word document structure');
  }
  
  const body = doc['w:document']['w:body'][0];
  const paragraphs = body['w:p'] || [];
  
  console.log(`[generateCV] Found ${paragraphs.length} paragraphs in document`);
  
  // === ÉTAPE 1: Remplacer le header (trigram et titre) ===
  await replaceHeader(paragraphs, cvData);
  
  // === ÉTAPE 2: Remplacer les sections ===
  await replaceSections(paragraphs, cvData, templateStructure);
  
  // Rebuilder le XML
  const builder = new Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8', standalone: true },
    renderOpts: { pretty: false }
  });
  const newXml = builder.buildObject(doc);
  
  // Réinsérer le XML modifié
  zip.file("word/document.xml", newXml);
  
  // Générer le nouveau fichier
  const generatedBuffer = await zip.generateAsync({ 
    type: "uint8array",
    compression: "DEFLATE"
  });
  
  console.log('[generateCV] Generated buffer size:', generatedBuffer.length);
  
  return generatedBuffer;
}

/**
 * Remplace le header (trigram et titre)
 */
async function replaceHeader(paragraphs: any[], cvData: any) {
  console.log('[replaceHeader] Starting header replacement');
  
  const trigram = cvData.header?.trigram || cvData.trigramme || '';
  const title = cvData.header?.title || cvData.titre_poste || '';
  
  let trigramFound = false;
  let titleFound = false;
  
  // Parcourir les premiers paragraphes pour trouver le header
  for (let i = 0; i < Math.min(20, paragraphs.length); i++) {
    const para = paragraphs[i];
    const text = extractTextFromParagraph(para);
    
    // Remplacer le trigram (chercher 3 lettres majuscules)
    if (!trigramFound && /^[A-Z]{3}$/.test(text.trim()) && trigram) {
      replaceTextInParagraph(para, trigram);
      trigramFound = true;
      console.log('[replaceHeader] Replaced trigram:', text, '->', trigram);
    }
    
    // Remplacer le titre (texte long après le trigram)
    if (trigramFound && !titleFound && text.length > 10 && title) {
      replaceTextInParagraph(para, title);
      titleFound = true;
      console.log('[replaceHeader] Replaced title:', text.substring(0, 30), '->', title);
      break;
    }
  }
}

/**
 * Remplace les sections du document
 */
async function replaceSections(paragraphs: any[], cvData: any, templateStructure: any) {
  console.log('[replaceSections] Starting section replacement');
  
  const sections = templateStructure?.sections || [];
  
  for (const section of sections) {
    console.log(`[replaceSections] Processing section: ${section.name} (${section.title})`);
    
    // Trouver l'index du paragraphe de titre de section
    const sectionIndex = findSectionIndex(paragraphs, section.title);
    
    if (sectionIndex === -1) {
      console.warn(`[replaceSections] Section "${section.title}" not found`);
      continue;
    }
    
    console.log(`[replaceSections] Found section at index ${sectionIndex}`);
    
    // Trouver l'index de la prochaine section
    const nextSectionIndex = findNextSectionIndex(paragraphs, sectionIndex + 1);
    
    console.log(`[replaceSections] Content range: ${sectionIndex + 1} to ${nextSectionIndex} (${nextSectionIndex - sectionIndex - 1} paragraphs)`);
    
    // Extraire les paragraphes template de cette section
    const templateParagraphs = paragraphs.slice(sectionIndex + 1, nextSectionIndex);
    
    if (templateParagraphs.length === 0) {
      console.warn(`[replaceSections] No template paragraphs found for section ${section.name}`);
      continue;
    }
    
    console.log(`[replaceSections] Extracted ${templateParagraphs.length} template paragraphs`);
    
    // Générer les nouveaux paragraphes selon le type de section
    let newParagraphs: any[] = [];
    
    if (section.placeholderType === 'competences') {
      newParagraphs = generateSkillsParagraphs(cvData, templateParagraphs);
    } else if (section.placeholderType === 'formations') {
      newParagraphs = generateFormationsParagraphs(cvData, templateParagraphs);
    } else if (section.placeholderType === 'missions') {
      newParagraphs = generateMissionsParagraphs(cvData, templateParagraphs);
    }
    
    console.log(`[replaceSections] Generated ${newParagraphs.length} new paragraphs for ${section.name}`);
    
    // Remplacer les anciens paragraphes par les nouveaux
    const deleteCount = nextSectionIndex - sectionIndex - 1;
    paragraphs.splice(sectionIndex + 1, deleteCount, ...newParagraphs);
    
    console.log(`[replaceSections] Replaced ${deleteCount} paragraphs with ${newParagraphs.length} new ones`);
  }
}

/**
 * Trouve l'index d'une section dans les paragraphes
 */
function findSectionIndex(paragraphs: any[], sectionTitle: string): number {
  const searchTerms = [sectionTitle];
  
  // Ajouter le premier mot si c'est un titre composé
  const words = sectionTitle.split(/[\s&]+/).filter(w => w.length > 2);
  if (words.length > 0) {
    searchTerms.push(words[0]);
  }
  
  for (let i = 0; i < paragraphs.length; i++) {
    const text = extractTextFromParagraph(paragraphs[i]);
    
    // Vérifier si c'est un titre de section (texte bold, grande taille)
    if (isParagraphBold(paragraphs[i]) && getParagraphFontSize(paragraphs[i]) >= 32) {
      for (const term of searchTerms) {
        if (text.toLowerCase().includes(term.toLowerCase())) {
          return i;
        }
      }
    }
  }
  
  return -1;
}

/**
 * Trouve l'index de la prochaine section principale
 */
function findNextSectionIndex(paragraphs: any[], startIndex: number): number {
  const sectionKeywords = ['Compétences', 'Formations', 'Certifications', 'Expérience', 'Formation'];
  
  for (let i = startIndex; i < paragraphs.length; i++) {
    const text = extractTextFromParagraph(paragraphs[i]);
    
    // Vérifier si c'est un titre de section principale
    if (isParagraphBold(paragraphs[i]) && getParagraphFontSize(paragraphs[i]) >= 32) {
      for (const keyword of sectionKeywords) {
        if (text.toLowerCase().includes(keyword.toLowerCase())) {
          return i;
        }
      }
    }
  }
  
  return paragraphs.length;
}

/**
 * Génère les paragraphes pour la section Compétences
 */
function generateSkillsParagraphs(cvData: any, templateParagraphs: any[]): any[] {
  const result: any[] = [];
  const basePara = templateParagraphs[0];
  
  // Essayer skills.subcategories d'abord
  if (cvData.skills?.subcategories) {
    for (const subcat of cvData.skills.subcategories) {
      const text = `${subcat.name}: ${subcat.items.join(', ')}`;
      result.push(cloneParagraphWithNewText(basePara, text));
    }
  }
  // Sinon essayer competences
  else if (cvData.competences) {
    for (const comp of cvData.competences) {
      if (comp.category || comp.categorie) {
        const categoryText = comp.category || comp.categorie;
        result.push(cloneParagraphWithNewText(basePara, categoryText));
      }
      
      if (comp.skills) {
        const skillsText = Array.isArray(comp.skills) ? comp.skills.join(', ') : comp.skills;
        result.push(cloneParagraphWithNewText(basePara, skillsText));
      } else if (comp.items) {
        const itemsText = Array.isArray(comp.items) ? comp.items.join(', ') : comp.items;
        result.push(cloneParagraphWithNewText(basePara, itemsText));
      }
    }
  }
  
  return result;
}

/**
 * Génère les paragraphes pour la section Formations
 */
function generateFormationsParagraphs(cvData: any, templateParagraphs: any[]): any[] {
  const result: any[] = [];
  const basePara = templateParagraphs[0];
  
  // Essayer education d'abord
  if (cvData.education && cvData.education.length > 0) {
    for (const edu of cvData.education) {
      const text = `${edu.year || ''} ${edu.degree || ''} - ${edu.institution || ''} ${edu.location || ''}`.trim();
      result.push(cloneParagraphWithNewText(basePara, text));
    }
  }
  // Sinon essayer formations
  else if (cvData.formations && cvData.formations.length > 0) {
    for (const formation of cvData.formations) {
      const text = `${formation.annee || ''} ${formation.titre || ''} - ${formation.etablissement || ''}`.trim();
      result.push(cloneParagraphWithNewText(basePara, text));
    }
  }
  
  return result;
}

/**
 * Génère les paragraphes pour la section Missions/Expériences
 */
function generateMissionsParagraphs(cvData: any, templateParagraphs: any[]): any[] {
  const result: any[] = [];
  const normalPara = templateParagraphs[0];
  const bulletPara = templateParagraphs.find(p => isParagraphBulleted(p)) || normalPara;
  
  const missions = cvData.missions || [];
  
  for (const mission of missions) {
    // En-tête de mission
    const periode = mission.periode || `${mission.date_start || ''} - ${mission.date_end || ''}`;
    const role = mission.role || mission.titre || '';
    const client = mission.client || mission.entreprise || '';
    const location = mission.location || '';
    
    const header = `${periode} | ${role} | ${client} ${location}`.trim();
    result.push(cloneParagraphWithNewText(normalPara, header));
    
    // Contexte
    if (mission.context || mission.contexte) {
      const context = mission.context || mission.contexte;
      result.push(cloneParagraphWithNewText(normalPara, context));
    }
    
    // Achievements / Missions (liste à puces)
    const achievements = mission.achievements || mission.missions || [];
    for (const achievement of achievements) {
      result.push(cloneParagraphWithNewText(bulletPara, achievement));
    }
    
    // Environnement
    if (mission.environment || mission.environnement) {
      const env = mission.environment || mission.environnement;
      const envText = Array.isArray(env) && env.length > 0 ? `Environnement: ${env.join(', ')}` : '';
      if (envText) {
        result.push(cloneParagraphWithNewText(normalPara, envText));
      }
    }
  }
  
  return result;
}

/**
 * Clone un paragraphe et remplace son texte
 */
function cloneParagraphWithNewText(paragraph: any, newText: string): any {
  // Deep clone du paragraphe
  const cloned = JSON.parse(JSON.stringify(paragraph));
  
  // Remplacer le texte
  replaceTextInParagraph(cloned, newText);
  
  return cloned;
}

/**
 * Extrait le texte d'un paragraphe
 */
function extractTextFromParagraph(paragraph: any): string {
  const texts: string[] = [];
  
  if (paragraph['w:r']) {
    for (const run of paragraph['w:r']) {
      if (run['w:t']) {
        for (const t of run['w:t']) {
          if (typeof t === 'string') {
            texts.push(t);
          } else if (t._) {
            texts.push(t._);
          }
        }
      }
    }
  }
  
  return texts.join('');
}

/**
 * Remplace le texte dans un paragraphe (modifie en place)
 */
function replaceTextInParagraph(paragraph: any, newText: string) {
  if (!paragraph['w:r'] || paragraph['w:r'].length === 0) {
    return;
  }
  
  // Mettre tout le texte dans le premier run, vider les autres
  let firstTextFound = false;
  
  for (const run of paragraph['w:r']) {
    if (run['w:t']) {
      for (let i = 0; i < run['w:t'].length; i++) {
        if (!firstTextFound) {
          // Premier texte: remplacer par le nouveau
          if (typeof run['w:t'][i] === 'string') {
            run['w:t'][i] = newText;
          } else {
            run['w:t'][i]._ = newText;
          }
          firstTextFound = true;
        } else {
          // Autres textes: vider
          if (typeof run['w:t'][i] === 'string') {
            run['w:t'][i] = '';
          } else {
            run['w:t'][i]._ = '';
          }
        }
      }
    }
  }
}

/**
 * Vérifie si un paragraphe est en gras
 */
function isParagraphBold(paragraph: any): boolean {
  if (!paragraph['w:r']) return false;
  
  for (const run of paragraph['w:r']) {
    if (run['w:rPr'] && run['w:rPr'][0] && run['w:rPr'][0]['w:b']) {
      return true;
    }
  }
  
  return false;
}

/**
 * Obtient la taille de police d'un paragraphe
 */
function getParagraphFontSize(paragraph: any): number {
  if (!paragraph['w:r']) return 20;
  
  for (const run of paragraph['w:r']) {
    if (run['w:rPr'] && run['w:rPr'][0] && run['w:rPr'][0]['w:sz']) {
      const sz = run['w:rPr'][0]['w:sz'][0];
      if (sz.$) {
        return parseInt(sz.$['w:val']) || 20;
      }
    }
  }
  
  return 20;
}

/**
 * Vérifie si un paragraphe a des puces
 */
function isParagraphBulleted(paragraph: any): boolean {
  if (!paragraph['w:pPr']) return false;
  
  const pPr = paragraph['w:pPr'][0];
  if (pPr && pPr['w:numPr']) {
    return true;
  }
  
  return false;
}
