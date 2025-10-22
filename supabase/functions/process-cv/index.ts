// supabase/functions/process-cv/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";
import OpenAI from "npm:openai@4.0.0";
import mammoth from "npm:mammoth@1.8.0";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

serve(async (req: Request) => {
  try {
    const { cvBase64, commercialCoords } = await req.json();
    const buffer = Uint8Array.from(atob(cvBase64), c => c.charCodeAt(0));

    // Extract text from CV
    const { value: cvText } = await mammoth.extractRawText({ arrayBuffer: buffer });

    // AI extraction (similar, but perhaps enhance with style awareness if CV has styles)
    const prompt = `
Extrais les données clés du CV en JSON:
{
  "title": "...",
  "name": "... (pour trigramme)",
  "competencies": { "technical": [], "functional": [] },
  "experiences": [{ "title": "", "dates": "", "company": "", "context": "", "missions": [], "env": "" }],
  "formations": [{ "title": "", "dates": "", "place": "" }]
}
Anonymise après trigramme. Détecte formats dates.
CV: ${cvText}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });
    let extracted = JSON.parse(response.choices[0].message.content);

    // Generate trigram
    if (extracted.name) {
      const [first, last] = extracted.name.split(' ');
      extracted.trigram = (first?.[0] || '') + (last?.[0] || '') + (last?.[1] || '').toUpperCase();
      delete extracted.name;
    } else {
      extracted.trigram = 'XXX';
    }

    extracted.commercial = commercialCoords;

    return new Response(JSON.stringify(extracted), { status: 200 });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
});
