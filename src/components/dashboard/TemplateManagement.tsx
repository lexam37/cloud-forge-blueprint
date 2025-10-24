import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FileText, Upload, Loader2, Sparkles, CheckCircle2, Trash2 } from "lucide-react";
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { toast } = useToast();
  const handleDeleteAllTemplatesAndClearCache = async () => {
    if (!confirm("Êtes-vous sûr de vouloir supprimer tous les templates et vider le cache ? Cette action est irréversible.")) {
      return;
    }
  
    setIsLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in",
          variant: "destructive"
        });
        return;
      }

      // Étape 1: Récupérer tous les templates de l'utilisateur
      const { data: templateDocs, error: fetchError } = await supabase
        .from('cv_templates')
        .select('*')
        .eq('user_id', user.id);
  
      if (fetchError) {
        console.error('Erreur lors de la récupération des templates:', fetchError);
        throw new Error(`Échec récupération des templates: ${fetchError.message}`);
      }
  
      if (!templateDocs || templateDocs.length === 0) {
        console.log('Aucun template à supprimer.');
      } else {
        // Étape 2: Supprimer chaque template individuellement
        for (const template of templateDocs) {
          // Supprimer le fichier du storage
          const { error: storageError } = await supabase.storage
            .from('cv-templates')
            .remove([template.file_path]);
  
          if (storageError) {
            console.error(`Erreur suppression fichier ${template.file_path}:`, storageError);
          }
  
          // Supprimer l'enregistrement de la DB
          const { error: dbError } = await supabase
            .from('cv_templates')
            .delete()
            .eq('id', template.id)
            .eq('user_id', user.id);
  
          if (dbError) {
            console.error(`Erreur suppression DB pour template ${template.id}:`, dbError);
            throw new Error(`Échec suppression DB pour template ${template.id}: ${dbError.message}`);
          }
        }
      }
  
      // Étape 3: Vider le cache du navigateur
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        console.log('Caches du navigateur vidés.');
      }
      localStorage.clear();
      console.log('localStorage vidé.');
  
      // Étape 4: Rafraîchir la liste
      setTemplates([]);
      toast({
        title: "Succès",
        description: "Tous les templates ont été supprimés et le cache vidé.",
      });
      window.location.reload();
    } catch (error) {
      console.error('Erreur lors de la suppression globale:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: `Impossible de supprimer les templates ou vider le cache: ${error.message}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    setIsLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('cv_templates')
        .select('*')
        .eq('user_id', user.id)
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to upload templates",
          variant: "destructive"
        });
        return;
      }

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

      // Upload file with user ID folder structure
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/template-${Date.now()}.${fileExt}`;

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

      // Create template record with user_id
      const { data: template, error: dbError } = await supabase
        .from('cv_templates')
        .insert({
          user_id: user.id,
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");

      const template = templates.find(t => t.id === templateId);
      const isPdf = template?.file_type === 'pdf';
      
      toast({
        title: isPdf ? "Analyse IA en cours..." : "Création du template...",
        description: isPdf 
          ? "L'IA analyse la structure visuelle du PDF" 
          : "Utilisation d'une structure par défaut intelligente",
      });

      // Désactiver tous les autres templates
      const { error: deactivateError } = await supabase
        .from('cv_templates')
        .update({ is_active: false })
        .eq('user_id', user.id)
        .neq('id', templateId);

      if (deactivateError) {
        console.error("Error deactivating templates:", deactivateError);
      }

      // Appeler l'analyse
      const { data, error } = await supabase.functions.invoke('analyze-template', {
        body: { templateId }
      });

      if (error) throw error;

      // Activer ce template
      const { error: activateError } = await supabase
        .from('cv_templates')
        .update({ is_active: true })
        .eq('id', templateId)
        .eq('user_id', user.id);

      if (activateError) {
        console.error("Error activating template:", activateError);
        throw activateError;
      }

      toast({
        title: "✅ Template configuré et activé !",
        description: isPdf 
          ? "La structure visuelle a été extraite avec succès" 
          : "Template prêt à l'emploi avec structure par défaut",
      });

      fetchTemplates();
    } catch (error) {
      console.error('Error analyzing template:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: error instanceof Error ? error.message : "Erreur lors de la configuration",
      });
    } finally {
      setIsAnalyzing(null);
    }
  };

  const handleDeleteTemplate = async (templateId: string, filePath: string) => {
    if (!confirm("Êtes-vous sûr de vouloir supprimer ce template ?")) return;

    setDeletingId(templateId);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to delete templates",
          variant: "destructive"
        });
        return;
      }

      // D'abord, mettre à null le template_id dans les CV qui référencent ce template
      const { error: updateError } = await supabase
        .from('cv_documents')
        .update({ template_id: null })
        .eq('template_id', templateId)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('Error updating CV documents:', updateError);
        throw new Error("Impossible de dissocier les CV de ce template");
      }

      // Supprimer du storage
      const { error: storageError } = await supabase.storage
        .from('cv-templates')
        .remove([filePath]);

      if (storageError) throw storageError;

      // Supprimer de la base de données
      const { error: dbError } = await supabase
        .from('cv_templates')
        .delete()
        .eq('id', templateId)
        .eq('user_id', user.id);

      if (dbError) throw dbError;

      toast({
        title: "Template supprimé",
        description: "Le template a été supprimé avec succès",
      });

      fetchTemplates();
    } catch (error) {
      console.error('Error deleting template:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: error instanceof Error ? error.message : "Impossible de supprimer le template",
      });
    } finally {
      setDeletingId(null);
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
          <p className="text-muted-foreground">
            Uploadez vos templates de CV (PDF pour analyse IA, .doc/.docx/.ppt/.pptx avec structure par défaut)
          </p>
        </div>
        <Badge variant="secondary">{templates.length} template{templates.length > 1 ? 's' : ''}</Badge>
        <Button
          onClick={handleDeleteAllTemplatesAndClearCache}
          variant="destructive"
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Supprimer les templates et vider le cache
        </Button>
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
                <div className="flex items-start gap-3 flex-1">
                  <div className="w-10 h-10 rounded-lg bg-gradient-hero flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-primary-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold mb-1 truncate">{template.name}</h3>
                    <Badge variant={template.is_active ? "default" : "secondary"}>
                      {template.is_active ? "Actif" : "Inactif"}
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {template.structure_data && (
                    <CheckCircle2 className="w-5 h-5 text-accent" />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteTemplate(template.id, template.file_path)}
                    disabled={deletingId === template.id}
                  >
                    {deletingId === template.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4 text-destructive" />
                    )}
                  </Button>
                </div>
              </div>

              {template.structure_data ? (
                <div className="text-sm text-muted-foreground mb-4">
                  <p><strong>Layout:</strong> {template.structure_data.layout?.type}</p>
                  <p><strong>Couleur principale:</strong> {template.structure_data.colors?.primary}</p>
                  {template.file_type === 'pdf' && (
                    <p className="text-xs text-accent mt-1">✨ Analysé par IA</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground mb-4">
                  {template.file_type === 'pdf' 
                    ? 'Cliquez pour analyser avec IA' 
                    : 'Cliquez pour configurer (structure par défaut)'}
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
                    {template.structure_data 
                      ? 'Reconfigurer' 
                      : (template.file_type === 'pdf' ? 'Analyser avec IA' : 'Configurer')}
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
