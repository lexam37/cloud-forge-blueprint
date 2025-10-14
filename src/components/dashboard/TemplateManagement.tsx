import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FileText, Upload, Loader2, Sparkles, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Template {
  id: string;
  name: string;
  description: string | null;
  file_path: string;
  file_type: string;
  structure_data: any;
  is_active: boolean;
  created_at: string;
}

export const TemplateManagement = () => {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('cv_templates')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      console.error('Error fetching templates:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de charger les templates",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    try {
      // Vérifier le type de fichier - supporter .doc, .docx, .pdf, .ppt, .pptx
      const allowedTypes = [
        'application/pdf',
        'application/msword', // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
        'application/vnd.ms-powerpoint', // .ppt
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' // .pptx
      ];

      if (!allowedTypes.includes(file.type)) {
        throw new Error('Format non supporté. Utilisez .doc, .docx, .pdf, .ppt ou .pptx');
      }

      // Upload du fichier
      const fileExt = file.name.split('.').pop();
      const fileName = `template-${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('cv-templates')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      // Déterminer le type de fichier
      let fileType: 'pdf' | 'docx' | 'pptx' | 'doc' | 'ppt' = 'pdf';
      if (file.type === 'application/msword') fileType = 'doc';
      if (file.type.includes('wordprocessingml')) fileType = 'docx';
      if (file.type === 'application/vnd.ms-powerpoint') fileType = 'ppt';
      if (file.type.includes('presentationml')) fileType = 'pptx';

      // Créer l'enregistrement
      const { data: template, error: dbError } = await supabase
        .from('cv_templates')
        .insert({
          name: file.name,
          file_path: fileName,
          file_type: fileType,
          is_active: false
        })
        .select()
        .single();

      if (dbError || !template) throw dbError;

      toast({
        title: "Template uploadé !",
        description: "Vous pouvez maintenant l'analyser",
      });

      fetchTemplates();
    } catch (error) {
      console.error('Error uploading template:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: error instanceof Error ? error.message : "Erreur lors de l'upload",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleAnalyzeTemplate = async (templateId: string) => {
    setIsAnalyzing(templateId);

    try {
      toast({
        title: "Analyse en cours...",
        description: "L'IA analyse la structure du template",
      });

      const { data, error } = await supabase.functions.invoke('analyze-template', {
        body: { templateId }
      });

      if (error) throw error;

      toast({
        title: "✅ Template analysé !",
        description: "La structure a été extraite avec succès",
      });

      fetchTemplates();
    } catch (error) {
      console.error('Error analyzing template:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: error instanceof Error ? error.message : "Erreur lors de l'analyse",
      });
    } finally {
      setIsAnalyzing(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold mb-2">Gestion des Templates</h2>
          <p className="text-muted-foreground">Uploadez et analysez vos templates de CV</p>
        </div>

        <label htmlFor="template-input">
          <Button variant="hero" size="lg" disabled={isUploading} asChild>
            <span>
              {isUploading ? (
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              ) : (
                <Upload className="w-5 h-5 mr-2" />
              )}
              Nouveau Template
            </span>
          </Button>
          <input
            id="template-input"
            type="file"
            className="hidden"
            accept=".pdf,.doc,.docx,.ppt,.pptx"
            onChange={handleTemplateUpload}
            disabled={isUploading}
          />
        </label>
      </div>

      {templates.length === 0 ? (
        <Card className="p-12 text-center">
          <FileText className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-xl font-semibold mb-2">Aucun template</h3>
          <p className="text-muted-foreground">
            Uploadez votre premier template pour commencer
          </p>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {templates.map((template) => (
            <Card key={template.id} className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-hero flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-primary-foreground" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">{template.name}</h3>
                    <Badge variant={template.is_active ? "default" : "secondary"}>
                      {template.is_active ? "Actif" : "Inactif"}
                    </Badge>
                  </div>
                </div>

                {template.structure_data && (
                  <CheckCircle2 className="w-5 h-5 text-accent" />
                )}
              </div>

              {template.structure_data ? (
                <div className="text-sm text-muted-foreground mb-4">
                  <p><strong>Layout:</strong> {template.structure_data.layout?.type}</p>
                  <p><strong>Couleur principale:</strong> {template.structure_data.colors?.primary}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground mb-4">
                  Template non analysé
                </p>
              )}

              <Button
                variant="outline"
                className="w-full"
                onClick={() => handleAnalyzeTemplate(template.id)}
                disabled={isAnalyzing === template.id}
              >
                {isAnalyzing === template.id ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyse en cours...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    {template.structure_data ? 'Réanalyser' : 'Analyser avec IA'}
                  </>
                )}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
