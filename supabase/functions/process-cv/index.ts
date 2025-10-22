// supabase/functions/process-cv/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "npm:openai@4.0.0";
import mammoth from "npm:mammoth@1.8.0";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

serve(async (req: Request) => {
  try {
    const { cvBase64, commercialCoords } = await req.json();
    const buffer = Uint8Array.from(atob(cvBase64), c => c.charCodeAt(0));

    // Extract text from CV
    const { value: cvText } = await mammoth.extractRawText({ arrayBuffer: buffer });

    // AI prompt for extraction
    const prompt = `
Analyse la structure de ce CV et extrais les données clés en JSON structuré :
{
  "title": "Titre du CV/Métier",
  "name": "Nom complet pour générer trigramme (anonymise après)",
  "competencies": {
    "technical": ["liste"],
    "functional": ["liste"]
  },
  "experiences": [
    {
      "title": "Titre mission (rôle, entreprise)",
      "dates": "Dates (format détecté, e.g., MM/YYYY - MM/YYYY)",
      "dateFormat": "Format des dates (e.g., MM/YYYY)",
      "context": "Contexte/objectif (si présent)",
      "missions": ["liste des missions/réalisations"],
      "env": "Environnement technique/fonctionnel"
    }
  ],
  "formations": [
    {
      "title": "Diplôme/certification",
      "dates": "Dates",
      "dateFormat": "Format",
      "place": "Lieu et organisme (si présent)"
    }
  ]
}
Anonymise : retire nom, adresse, tel, email, etc. après génération du trigramme.
Génère trigramme : première lettre prénom + deux premières lettres nom, en majuscules.
Détecte incohérences et formats dates. Ajoute sauts de ligne implicites.
CV texte : ${cvText}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });
    let extracted = JSON.parse(response.choices[0].message.content);

    // Generate trigram from name
    if (extracted.name) {
      const [firstName, lastName] = extracted.name.split(' ');
      extracted.trigram = (firstName[0] + (lastName?.[0] || '') + (lastName?.[1] || '')).toUpperCase();
      delete extracted.name; // Anonymize
    } else {
      extracted.trigram = 'XXX'; // Default
    }

    // Add commercial coords
    extracted.commercial = commercialCoords;

    return new Response(JSON.stringify(extracted), { status: 200 });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
});
