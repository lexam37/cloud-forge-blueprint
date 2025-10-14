import { Upload, Brain, FileCheck, Zap, Shield, Globe } from "lucide-react";
import { Card } from "@/components/ui/card";

const features = [
  {
    icon: Upload,
    title: "Upload Simplifié",
    description: "Glissez-déposez vos CV en PDF, Word ou PowerPoint. Interface intuitive et rapide.",
  },
  {
    icon: Brain,
    title: "IA Avancée",
    description: "Extraction intelligente des données clés : expériences, compétences, formations et certifications.",
  },
  {
    icon: FileCheck,
    title: "Standardisation Automatique",
    description: "Transformation selon votre template d'entreprise avec anonymisation et mise en forme professionnelle.",
  },
  {
    icon: Zap,
    title: "Ultra Rapide",
    description: "Traitement en moins de 60 secondes. Gagnez des heures de travail manuel.",
  },
  {
    icon: Shield,
    title: "Sécurisé",
    description: "Vos données restent confidentielles avec un traitement sécurisé et des logs détaillés.",
  },
  {
    icon: Globe,
    title: "Multilingue",
    description: "Support complet du français et de l'anglais pour vos CV internationaux.",
  },
];

const Features = () => {
  return (
    <section id="features" className="py-24 bg-gradient-card">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-bold mb-4">
            Tout ce dont vous avez besoin
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Une solution complète pour automatiser la création de vos dossiers de compétences
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <Card 
              key={index} 
              className="p-6 hover:shadow-lg transition-all duration-300 hover:-translate-y-1 bg-card border-border/50 group"
            >
              <div className="w-12 h-12 rounded-lg bg-gradient-hero flex items-center justify-center mb-4 group-hover:shadow-glow transition-shadow">
                <feature.icon className="w-6 h-6 text-primary-foreground" />
              </div>
              <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
              <p className="text-muted-foreground">{feature.description}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
