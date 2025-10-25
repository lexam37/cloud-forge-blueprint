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

    const generatedBuffer = await generateCV(
      templateBuffer,
      extractedData,
      template.structure_data
    );

    console.log('[generate-cv-word] CV generated successfully');

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
 * Génère le CV en clonant un paragraphe template par section
 */
async function generateCV(
  templateBuffer: ArrayBuffer,
  cvData: any,
  templateStructure: any
) {
  console.log('[generateCV] Starting simple clone approach');
  
  const zip = new JSZip();
  await zip.loadAsync(templateBuffer);
  
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("Cannot extract document.xml from template");
  
  let modifiedXml = docXml;
  
  // === ÉTAPE 1: Remplacer le header ===
  modifiedXml = replaceHeader(modifiedXml, cvData);
  
  // === ÉTAPE 2: Remplacer les sections (de la fin vers le début) ===
  const sections = templateStructure?.sections || [];
  
  // Trouver toutes les positions de sections
  const sectionPositions = sections.map((section: any) => ({
    ...section,
    position: findSectionPosition(modifiedXml, section.title)
  })).filter((s: any) => s.position !== -1);
  
  // Trier par position décroissante
  sectionPositions.sort((a: any, b: any) => b.position - a.position);
  
  console.log('[generateCV] Processing sections:', sectionPositions.map((s: any) => s.name).join(', '));
  
  for (const section of sectionPositions) {
    console.log(`[generateCV] Processing: ${section.name}`);
    modifiedXml = replaceSection(modifiedXml, section, cvData);
  }
  
  console.log('[generateCV] All sections replaced');
  
  zip.file("word/document.xml", modifiedXml);
  
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
function replaceHeader(xml: string, cvData: any): string {
  let result = xml;
  
  const trigram = cvData.header?.trigram || cvData.trigramme || '';
  const title = cvData.header?.title || cvData.titre_poste || '';
  
  // Remplacer le trigram
  if (trigram) {
    const trigramRegex = /<w:t[^>]*>[A-Z]{3}<\/w:t>/;
    result = result.replace(trigramRegex, `<w:t>${escapeXml(trigram)}</w:t>`);
    console.log('[replaceHeader] Replaced trigram with:', trigram);
  }
  
  // Remplacer le titre
  if (title) {
    // Trouver le premier texte long après le trigram
    const afterTrigram = result.indexOf(trigram) + trigram.length;
    const searchArea = result.substring(afterTrigram, afterTrigram + 2000);
    const titleMatch = searchArea.match(/<w:t[^>]*>([^<]{10,})<\/w:t>/);
    
    if (titleMatch) {
      const oldTitle = titleMatch[1];
      const replaceRegex = new RegExp(`(<w:t[^>]*>)${escapeRegex(oldTitle)}(<\/w:t>)`, 'g');
      result = result.replace(replaceRegex, `$1${escapeXml(title)}$2`);
      console.log('[replaceHeader] Replaced title:', oldTitle, '->', title);
    }
  }
  
  return result;
}

/**
 * Trouve la position d'une section
 */
function findSectionPosition(xml: string, sectionTitle: string): number {
  // Chercher le titre exact ou le premier mot
  const searchTerms = [sectionTitle];
  const firstWord = sectionTitle.split(/[\s&]+/)[0];
  if (firstWord && firstWord.length > 2) {
    searchTerms.push(firstWord);
  }
  
  for (const term of searchTerms) {
    const regex = new RegExp(`<w:t[^>]*>${escapeRegex(term)}`, 'i');
    const match = xml.match(regex);
    if (match && match.index !== undefined) {
      return match.index;
    }
  }
  
  return -1;
}

/**
 * Remplace le contenu d'une section
 */
function replaceSection(xml: string, section: any, cvData: any): string {
  const sectionPos = section.position;
  
  // Trouver le début du paragraphe de titre
  const titlePStart = xml.lastIndexOf('<w:p', sectionPos);
  const titlePEnd = xml.indexOf('</w:p>', sectionPos) + 6;
  
  // Extraire UN SEUL paragraphe template après le titre
  const templatePStart = xml.indexOf('<w:p', titlePEnd);
  const templatePEnd = xml.indexOf('</w:p>', templatePStart) + 6;
  const templateParagraph = xml.substring(templatePStart, templatePEnd);
  
  console.log(`[replaceSection] Template paragraph length: ${templateParagraph.length}`);
  
  // Trouver la fin de la section (prochaine section principale)
  const sectionEnd = findNextSectionPosition(xml, titlePEnd);
  
  // Générer le nouveau contenu
  const newContent = generateSectionContent(section, cvData, templateParagraph);
  
  console.log(`[replaceSection] Generated ${newContent.length} chars for ${section.name}`);
  
  // Remplacer
  const before = xml.substring(0, titlePEnd);
  const after = xml.substring(sectionEnd);
  
  return before + newContent + after;
}

/**
 * Trouve la position de la prochaine section principale
 */
function findNextSectionPosition(xml: string, startPos: number): number {
  const sectionTitles = ['Compétences', 'Formations', 'Certifications', 'Expérience', 'Formation'];
  
  let pos = startPos;
  for (let i = 0; i < 50; i++) {
    const nextP = xml.indexOf('<w:p', pos);
    if (nextP === -1) return xml.indexOf('</w:body>', startPos);
    
    const nextPEnd = xml.indexOf('</w:p>', nextP) + 6;
    const paragraph = xml.substring(nextP, nextPEnd);
    
    // Vérifier si c'est un titre de section
    if (paragraph.includes('<w:b') || paragraph.includes('<w:b ')) {
      const textMatch = paragraph.match(/<w:t[^>]*>([^<]+)<\/w:t>/);
      if (textMatch) {
        const text = textMatch[1];
        for (const title of sectionTitles) {
          if (text.toLowerCase().includes(title.toLowerCase())) {
            return nextP;
          }
        }
      }
    }
    
    pos = nextPEnd;
  }
  
  return xml.indexOf('</w:body>', startPos);
}

/**
 * Génère le contenu d'une section
 */
function generateSectionContent(section: any, cvData: any, templateParagraph: string): string {
  if (section.placeholderType === 'competences') {
    return generateCompetences(cvData, templateParagraph);
  } else if (section.placeholderType === 'formations') {
    return generateFormations(cvData, templateParagraph);
  } else if (section.placeholderType === 'missions') {
    return generateMissions(cvData, templateParagraph);
  }
  
  return '';
}

/**
 * Génère les compétences
 */
function generateCompetences(cvData: any, templatePara: string): string {
  const lines: string[] = [];
  
  if (cvData.skills?.subcategories) {
    for (const subcat of cvData.skills.subcategories) {
      const text = `${subcat.name}: ${subcat.items.join(', ')}`;
      lines.push(cloneParagraph(templatePara, text));
    }
  } else if (cvData.competences) {
    for (const comp of cvData.competences) {
      if (comp.category) {
        lines.push(cloneParagraph(templatePara, comp.category));
      }
      if (comp.skills) {
        const skillsText = Array.isArray(comp.skills) ? comp.skills.join(', ') : comp.skills;
        lines.push(cloneParagraph(templatePara, skillsText));
      }
    }
  }
  
  return lines.join('');
}

/**
 * Génère les formations
 */
function generateFormations(cvData: any, templatePara: string): string {
  const lines: string[] = [];
  
  if (cvData.education && cvData.education.length > 0) {
    for (const edu of cvData.education) {
      const text = `${edu.year || ''} ${edu.degree || ''} - ${edu.institution || ''} ${edu.location || ''}`.trim();
      lines.push(cloneParagraph(templatePara, text));
    }
  } else if (cvData.formations && cvData.formations.length > 0) {
    for (const formation of cvData.formations) {
      const text = `${formation.annee || ''} ${formation.titre || ''} - ${formation.etablissement || ''}`.trim();
      lines.push(cloneParagraph(templatePara, text));
    }
  }
  
  return lines.join('');
}

/**
 * Génère les missions
 */
function generateMissions(cvData: any, templatePara: string): string {
  const lines: string[] = [];
  const missions = cvData.missions || [];
  
  // Extraire aussi un paragraphe à puces si disponible
  const bulletPara = templatePara.includes('numPr') ? templatePara : templatePara;
  
  for (const mission of missions) {
    // En-tête
    const periode = mission.periode || `${mission.date_start || ''} - ${mission.date_end || ''}`;
    const role = mission.role || mission.titre || '';
    const client = mission.client || mission.entreprise || '';
    const location = mission.location || '';
    
    const header = `${periode} | ${role} | ${client} ${location}`.trim();
    lines.push(cloneParagraph(templatePara, header));
    
    // Contexte
    if (mission.context || mission.contexte) {
      lines.push(cloneParagraph(templatePara, mission.context || mission.contexte));
    }
    
    // Achievements
    const achievements = mission.achievements || mission.missions || [];
    for (const achievement of achievements) {
      lines.push(cloneParagraph(bulletPara, achievement));
    }
    
    // Environnement
    if (mission.environment && mission.environment.length > 0) {
      const envText = `Environnement: ${mission.environment.join(', ')}`;
      lines.push(cloneParagraph(templatePara, envText));
    }
  }
  
  return lines.join('');
}

/**
 * Clone un paragraphe avec un nouveau texte
 */
function cloneParagraph(paragraph: string, newText: string): string {
  // Remplacer TOUS les <w:t> par le nouveau texte dans le premier, vider les autres
  let replaced = false;
  
  return paragraph.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (match, attrs, oldText) => {
    if (!replaced) {
      replaced = true;
      return `<w:t${attrs}>${escapeXml(newText)}</w:t>`;
    }
    return `<w:t${attrs}></w:t>`;
  });
}

/**
 * Échappe les caractères XML
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
