import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import uploadIcon from "@/assets/upload-icon.png";

interface FileUploadSectionProps {
  onUploadSuccess?: () => void;
}

export const FileUploadSection = ({ onUploadSuccess }: FileUploadSectionProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const { toast } = useToast();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const processFile = async (file: File) => {
    setIsUploading(true);
    setIsProcessing(true);

    try {
      // Vérifier le type de fichier
      const allowedTypes = [
        'application/pdf',
        'application/msword', // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
        'application/vnd.ms-powerpoint', // .ppt
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' // .pptx
      ];

      if (!allowedTypes.includes(file.type)) {
        throw new Error('Format non supporté. Utilisez .pdf, .doc, .docx, .ppt ou .pptx');
      }

      // Vérifier la taille (10 MB max)
      if (file.size > 10 * 1024 * 1024) {
        throw new Error('Le fichier est trop volumineux (max 10 MB)');
      }

      toast({
        title: "Upload en cours...",
        description: `Téléchargement de ${file.name}`,
      });

      // Générer un nom de fichier unique
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = fileName;

      // Upload du fichier vers Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('cv-uploads')
        .upload(filePath, file);

      if (uploadError) {
        console.error('Upload error:', uploadError);
        throw new Error('Erreur lors de l\'upload du fichier');
      }

      // Déterminer le type de fichier
      let fileType: 'pdf' | 'docx' | 'pptx' | 'doc' | 'ppt' = 'pdf';
      if (file.type === 'application/msword') fileType = 'doc';
      if (file.type.includes('wordprocessingml')) fileType = 'docx';
      if (file.type === 'application/vnd.ms-powerpoint') fileType = 'ppt';
      if (file.type.includes('presentationml')) fileType = 'pptx';

      // Créer l'enregistrement dans la base de données
      const { data: cvDoc, error: dbError } = await supabase
        .from('cv_documents')
        .insert({
          original_file_path: filePath,
          original_file_name: file.name,
          original_file_type: fileType,
          status: 'uploaded'
        })
        .select()
        .single();

      if (dbError || !cvDoc) {
        console.error('Database error:', dbError);
        throw new Error('Erreur lors de la création de l\'enregistrement');
      }

      toast({
        title: "Upload réussi !",
        description: "Traitement IA en cours...",
      });

      // Appeler la fonction backend pour traiter le CV
      const { data, error: processError } = await supabase.functions.invoke('process-cv', {
        body: { cvDocumentId: cvDoc.id }
      });

      if (processError) {
        console.error('Process error:', processError);
        throw new Error(processError.message || 'Erreur lors du traitement IA');
      }

      toast({
        title: "✅ CV traité avec succès !",
        description: `Traitement terminé en ${data.processingTimeMs}ms`,
      });

      onUploadSuccess?.();

    } catch (error) {
      console.error('Error processing file:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: error instanceof Error ? error.message : "Une erreur est survenue",
      });
    } finally {
      setIsUploading(false);
      setIsProcessing(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      processFile(files[0]);
    }
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  return (
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
        {isProcessing ? (
          <>
            <Loader2 className="w-24 h-24 text-primary animate-spin mb-6" />
            <h3 className="text-2xl font-semibold mb-3">
              {isUploading ? "Upload en cours..." : "Traitement IA en cours..."}
            </h3>
            <p className="text-muted-foreground">
              Veuillez patienter pendant l'analyse de votre CV
            </p>
          </>
        ) : (
          <>
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
              Formats acceptés : PDF, Word (.doc, .docx), PowerPoint (.ppt, .pptx)
              <br />
              Taille maximale : 10 MB
            </p>

            <div className="flex items-center gap-4 mb-6 w-full max-w-xs">
              <div className="h-px flex-1 bg-border" />
              <span className="text-sm text-muted-foreground">ou</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <label htmlFor="file-input">
              <Button variant="hero" size="lg" className="group cursor-pointer" asChild>
                <span>
                  <Upload className="w-5 h-5 mr-2 group-hover:scale-110 transition-transform" />
                  Sélectionner un fichier
                </span>
              </Button>
              <input
                id="file-input"
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.ppt,.pptx"
                onChange={handleFileInput}
                disabled={isProcessing}
              />
            </label>

            <div className="mt-8 flex items-center gap-6 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-accent" />
                <span>Sécurisé</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-accent" />
                <span>Moins de 60 sec</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-accent" />
                <span>Confidentiel</span>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
};
