import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, Loader2, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import uploadIcon from "@/assets/upload-icon.png";
import { Progress } from "@/components/ui/progress";

interface FileUploadSectionProps {
  onUploadSuccess?: () => void;
}

type ProcessingStep = {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'error';
};

export const FileUploadSection = ({ onUploadSuccess }: FileUploadSectionProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentFileName, setCurrentFileName] = useState('');
  const [steps, setSteps] = useState<ProcessingStep[]>([
    { id: 'upload', label: 'Upload du fichier', status: 'pending' },
    { id: 'save', label: 'Enregistrement', status: 'pending' },
    { id: 'extract', label: 'Extraction des données', status: 'pending' },
    { id: 'anonymize', label: 'Anonymisation (trigramme + suppression infos perso)', status: 'pending' },
    { id: 'template', label: 'Application du template', status: 'pending' },
    { id: 'commercial', label: 'Ajout coordonnées commercial', status: 'pending' },
    { id: 'complete', label: 'Finalisation', status: 'pending' },
  ]);
  const { toast } = useToast();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const updateStep = (stepId: string, status: ProcessingStep['status']) => {
    setSteps(prev => prev.map(step => 
      step.id === stepId ? { ...step, status } : step
    ));
  };

  const resetSteps = () => {
    setSteps([
      { id: 'upload', label: 'Upload du fichier', status: 'pending' },
      { id: 'save', label: 'Enregistrement', status: 'pending' },
      { id: 'extract', label: 'Extraction des données', status: 'pending' },
      { id: 'anonymize', label: 'Anonymisation (trigramme + suppression infos perso)', status: 'pending' },
      { id: 'template', label: 'Application du template', status: 'pending' },
      { id: 'commercial', label: 'Ajout coordonnées commercial', status: 'pending' },
      { id: 'complete', label: 'Finalisation', status: 'pending' },
    ]);
  };

  const processFile = async (file: File) => {
    setIsProcessing(true);
    setCurrentFileName(file.name);
    resetSteps();

    try {
      // Étape 1: Upload
      updateStep('upload', 'active');
      
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

      // Get current user for file path and database operations
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        throw new Error('You must be logged in to upload files');
      }

      // Generate unique filename with user ID folder structure
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `${user.id}/${fileName}`;

      // Upload file to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('cv-uploads')
        .upload(filePath, file);

      if (uploadError) {
        console.error('Upload error:', uploadError);
        throw new Error('Erreur lors de l\'upload du fichier');
      }

      updateStep('upload', 'completed');
      
      // Étape 2: Enregistrement
      updateStep('save', 'active');

      // Déterminer le type de fichier
      let fileType: 'pdf' | 'docx' | 'pptx' | 'doc' | 'ppt' = 'pdf';
      if (file.type === 'application/msword') fileType = 'doc';
      if (file.type.includes('wordprocessingml')) fileType = 'docx';
      if (file.type === 'application/vnd.ms-powerpoint') fileType = 'ppt';
      if (file.type.includes('presentationml')) fileType = 'pptx';

      // Create database record with user_id
      const { data: cvDoc, error: dbError } = await supabase
        .from('cv_documents')
        .insert({
          user_id: user.id,
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

      updateStep('save', 'completed');
      
      // Étape 3: Extraction
      updateStep('extract', 'active');

      // Appeler la fonction backend pour traiter le CV
      const { data, error: processError } = await supabase.functions.invoke('process-cv', {
        body: { cvDocumentId: cvDoc.id }
      });

      if (processError) {
        console.error('Process error:', processError);
        updateStep('extract', 'error');
        throw new Error(processError.message || 'Erreur lors du traitement');
      }

      updateStep('extract', 'completed');
      
      // Étape 4: Anonymisation (déjà faite par l'IA)
      updateStep('anonymize', 'active');
      await new Promise(resolve => setTimeout(resolve, 300));
      updateStep('anonymize', 'completed');
      
      // Étape 5: Application du template
      updateStep('template', 'active');
      
      // Générer le CV Word avec le template
      const { error: generateError } = await supabase.functions.invoke('generate-cv-word', {
        body: { cvDocumentId: cvDoc.id }
      });

      if (generateError) {
        console.error('Generate error:', generateError);
        updateStep('template', 'error');
        throw new Error(generateError.message || 'Erreur lors de l\'application du template');
      }

      updateStep('template', 'completed');
      
      // Étape 6: Ajout coordonnées commercial (fait lors de la génération)
      updateStep('commercial', 'active');
      await new Promise(resolve => setTimeout(resolve, 300));
      updateStep('commercial', 'completed');
      
      // Étape 7: Finalisation
      updateStep('complete', 'active');
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      updateStep('complete', 'completed');

      toast({
        title: "✅ CV traité avec succès !",
        description: `${file.name} a été analysé`,
      });

      onUploadSuccess?.();

    } catch (error) {
      console.error('Error processing file:', error);
      
      // Marquer l'étape active comme erreur
      setSteps(prev => prev.map(step => 
        step.status === 'active' ? { ...step, status: 'error' } : step
      ));
      
      toast({
        variant: "destructive",
        title: "Erreur",
        description: error instanceof Error ? error.message : "Une erreur est survenue",
      });
    } finally {
      setTimeout(() => {
        setIsProcessing(false);
        setCurrentFileName('');
      }, 2000);
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
            <div className="w-full max-w-md mb-8">
              <div className="flex items-center gap-3 mb-6">
                <Loader2 className="w-8 h-8 text-primary animate-spin flex-shrink-0" />
                <div className="flex-1 text-left">
                  <h3 className="text-xl font-semibold">Traitement de {currentFileName}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Veuillez patienter...
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                {steps.map((step, index) => (
                  <div key={step.id} className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                      step.status === 'completed' 
                        ? 'bg-accent text-white' 
                        : step.status === 'active'
                        ? 'bg-primary text-white animate-pulse'
                        : step.status === 'error'
                        ? 'bg-destructive text-white'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {step.status === 'completed' ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : step.status === 'error' ? (
                        <span className="text-lg">✕</span>
                      ) : (
                        <span className="text-sm font-semibold">{index + 1}</span>
                      )}
                    </div>
                    
                    <div className="flex-1 text-left">
                      <p className={`text-sm font-medium ${
                        step.status === 'active' ? 'text-primary' : 
                        step.status === 'completed' ? 'text-accent' :
                        step.status === 'error' ? 'text-destructive' :
                        'text-muted-foreground'
                      }`}>
                        {step.label}
                      </p>
                      
                      {step.status === 'active' && (
                        <Progress value={undefined} className="h-1 mt-2" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
