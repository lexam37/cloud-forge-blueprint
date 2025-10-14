import { Upload, ScanSearch, Sparkles, Download } from "lucide-react";

const steps = [
  {
    icon: Upload,
    title: "1. Uploadez votre CV",
    description: "Glissez-déposez ou sélectionnez votre CV au format PDF, Word ou PowerPoint.",
    color: "primary",
  },
  {
    icon: ScanSearch,
    title: "2. Extraction des données",
    description: "Notre IA analyse et extrait automatiquement toutes les informations pertinentes.",
    color: "accent",
  },
  {
    icon: Sparkles,
    title: "3. Standardisation IA",
    description: "Le CV est restructuré selon votre template avec anonymisation et corrections.",
    color: "primary",
  },
  {
    icon: Download,
    title: "4. Téléchargez le résultat",
    description: "Récupérez votre dossier de compétences finalisé au format souhaité.",
    color: "accent",
  },
];

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="py-24 bg-background">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-bold mb-4">
            Comment ça marche ?
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Un processus simple en 4 étapes pour des résultats professionnels
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          <div className="relative">
            {/* Connecting Line */}
            <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-gradient-to-b from-primary via-accent to-primary hidden md:block" />
            
            {steps.map((step, index) => (
              <div key={index} className="relative flex gap-8 mb-12 last:mb-0">
                {/* Icon Circle */}
                <div className={`relative z-10 flex-shrink-0 w-16 h-16 rounded-full ${
                  step.color === 'primary' ? 'bg-gradient-hero' : 'bg-gradient-accent'
                } flex items-center justify-center shadow-lg`}>
                  <step.icon className="w-8 h-8 text-white" />
                </div>

                {/* Content */}
                <div className="flex-1 pt-2">
                  <h3 className="text-2xl font-bold mb-2">{step.title}</h3>
                  <p className="text-muted-foreground text-lg">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
