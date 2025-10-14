import { Upload } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import uploadIcon from "@/assets/upload-icon.png";
import { useState } from "react";

const UploadZone = () => {
  const [isDragging, setIsDragging] = useState(false);
  const navigate = useNavigate();

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // Handle file drop logic here
  };

  return (
    <section className="py-24 bg-gradient-card">
      <div className="container mx-auto px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold mb-4">
              Essayez maintenant
            </h2>
            <p className="text-xl text-muted-foreground">
              Transformez votre premier CV en quelques secondes
            </p>
          </div>

          <Card 
            className={`p-12 border-2 border-dashed transition-all duration-300 ${
              isDragging 
                ? 'border-primary bg-primary/5 shadow-glow' 
                : 'border-border hover:border-primary/50 hover:shadow-lg'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="flex flex-col items-center text-center">
              <div className="mb-6 animate-pulse-glow">
                <img 
                  src={uploadIcon} 
                  alt="Upload" 
                  className="w-24 h-24"
                />
              </div>
              
              <h3 className="text-2xl font-semibold mb-3">
                Glissez et déposez votre CV ici
              </h3>
              
              <p className="text-muted-foreground mb-6 max-w-md">
                Formats acceptés : PDF, Word (.docx), PowerPoint (.pptx)
                <br />
                Taille maximale : 10 MB
              </p>

              <div className="flex items-center gap-4 mb-6">
                <div className="h-px flex-1 bg-border" />
                <span className="text-sm text-muted-foreground">ou</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <Button variant="hero" size="lg" className="group" onClick={() => navigate('/dashboard')}>
                <Upload className="w-5 h-5 mr-2 group-hover:scale-110 transition-transform" />
                Sélectionner un fichier
              </Button>

              <div className="mt-8 flex items-center gap-6 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span>Sécurisé</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span>Rapide</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span>Confidentiel</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
};

export default UploadZone;
