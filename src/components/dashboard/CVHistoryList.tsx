import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Download, Clock, CheckCircle2, AlertCircle, Loader2, FileDown, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Database } from "@/integrations/supabase/types";

type CVDocument = Database['public']['Tables']['cv_documents']['Row'];

export const CVHistoryList = () => {
  const [cvDocuments, setCvDocuments] = useState<CVDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { toast } = useToast();
  const handleDeleteAllCVsAndClearCache = async () => {
    if (!confirm("Êtes-vous sûr de vouloir supprimer tous les CV et vider le cache ? Cette action est irréversible.")) {
      return;
    }
  
    setIsLoading(true);
    try {
      // Étape 1: Récupérer tous les enregistrements de cv_documents
      const { data: cvDocs, error: fetchError } = await supabase
        .from('cv_documents')
        .select('*');
  
      if (fetchError) {
        console.error('Erreur lors de la récupération des CV:', fetchError);
        throw new Error(`Échec récupération des CV: ${fetchError.message}`);
      }
  
      if (!cvDocs || cvDocs.length === 0) {
        console.log('Aucun CV à supprimer.');
      } else {
        // Étape 2: Supprimer chaque CV individuellement (comme handleDeleteCV)
        for (const cv of cvDocs) {
          // Supprimer le fichier original
          const { error: storageError } = await supabase.storage
            .from('cv-uploads')
            .remove([cv.original_file_path]);
  
          if (storageError) {
            console.error(`Erreur suppression fichier original ${cv.original_file_path}:`, storageError);
          }
  
          // Supprimer le fichier généré s'il existe
          if (cv.generated_file_path) {
            const { error: generatedError } = await supabase.storage
              .from('cv-generated')
              .remove([cv.generated_file_path]);
            if (generatedError) {
              console.error(`Erreur suppression fichier généré ${cv.generated_file_path}:`, generatedError);
            }
          }
  
          // Supprimer l'enregistrement de la DB
          const { error: dbError } = await supabase
            .from('cv_documents')
            .delete()
            .eq('id', cv.id);
  
          if (dbError) {
            console.error(`Erreur suppression DB pour CV ${cv.id}:`, dbError);
            throw new Error(`Échec suppression DB pour CV ${cv.id}: ${dbError.message}`);
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
      setCvDocuments([]);
      toast({
        title: "Succès",
        description: "Tous les CV ont été supprimés et le cache vidé.",
      });
  
      // Optionnel: Recharger la page
      window.location.reload();
    } catch (error) {
      console.error('Erreur lors de la suppression globale:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: `Impossible de supprimer les CV ou vider le cache: ${error.message}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCVDocuments();
  }, []);

  const fetchCVDocuments = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('cv_documents')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCvDocuments(data || []);
    } catch (error) {
      console.error('Error fetching CV documents:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de charger l'historique des CV",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'uploaded':
        return <Clock className="w-4 h-4 text-muted-foreground" />;
      case 'analyzing':
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case 'processed':
        return <CheckCircle2 className="w-4 h-4 text-accent" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'uploaded':
        return 'En attente';
      case 'analyzing':
        return 'En cours';
      case 'processed':
        return 'Traité';
      case 'error':
        return 'Erreur';
      default:
        return status;
    }
  };

  const getStatusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case 'processed':
        return 'default';
      case 'error':
        return 'destructive';
      case 'analyzing':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const handleDownloadOriginal = async (cv: CVDocument) => {
    try {
      toast({
        title: "Téléchargement en cours...",
        description: "Fichier original",
      });

      // Télécharger le fichier original
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('cv-uploads')
        .download(cv.original_file_path);

      if (downloadError) throw downloadError;

      const url = URL.createObjectURL(fileData);
      const a = document.createElement('a');
      a.href = url;
      a.download = cv.original_file_name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "✅ Téléchargement réussi",
        description: "CV original téléchargé",
      });
    } catch (error) {
      console.error('Error downloading original:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de télécharger le CV original",
      });
    }
  };

  const handleDownloadPDF = async (cv: CVDocument) => {
    try {
      toast({
        title: "Génération du dossier de compétences...",
        description: "Format PDF",
      });

      // Appeler la fonction edge pour générer le PDF
      const { data, error: functionError } = await supabase.functions.invoke('generate-cv-pdf', {
        body: { cvDocumentId: cv.id }
      });

      if (functionError) throw functionError;

      // Télécharger le fichier généré
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('cv-generated')
        .download(data.filePath);

      if (downloadError) throw downloadError;

      const url = URL.createObjectURL(fileData);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.fileName || 'DC.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "✅ Téléchargement réussi",
        description: "Dossier de compétences téléchargé",
      });
    } catch (error) {
      console.error('Error downloading PDF:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de télécharger le dossier de compétences",
      });
    }
  };

  const handleDownloadWord = async (cv: CVDocument) => {
    try {
      if (!cv.generated_file_path) {
        toast({
          variant: "destructive",
          title: "Erreur",
          description: "Fichier non généré. Veuillez uploader à nouveau le CV.",
        });
        return;
      }

      toast({
        title: "Téléchargement en cours...",
        description: "Récupération du fichier",
      });

      // Télécharger directement le fichier déjà généré
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('cv-generated')
        .download(cv.generated_file_path);

      if (downloadError) throw downloadError;

      const trigram = (cv.extracted_data as any)?.header?.trigram || 'XXX';
      const title = (cv.extracted_data as any)?.header?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'Poste';
      const fileName = `${trigram}_DC_${title}.docx`;

      const url = URL.createObjectURL(fileData);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "✅ Téléchargement réussi",
        description: "Dossier de compétences téléchargé",
      });
    } catch (error) {
      console.error('Error downloading Word:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de télécharger le dossier de compétences",
      });
    }
  };

  const handleDeleteCV = async (cv: CVDocument) => {
    if (!confirm("Êtes-vous sûr de vouloir supprimer ce CV ?")) return;

    setDeletingId(cv.id);

    try {
      // Supprimer le fichier original du storage
      const { error: storageError } = await supabase.storage
        .from('cv-uploads')
        .remove([cv.original_file_path]);

      if (storageError) console.error('Storage error:', storageError);

      // Supprimer le fichier généré s'il existe
      if (cv.generated_file_path) {
        await supabase.storage
          .from('cv-generated')
          .remove([cv.generated_file_path]);
      }

      // Supprimer de la base de données
      const { error: dbError } = await supabase
        .from('cv_documents')
        .delete()
        .eq('id', cv.id);

      if (dbError) throw dbError;

      toast({
        title: "CV supprimé",
        description: "Le CV a été supprimé avec succès",
      });

      fetchCVDocuments();
    } catch (error) {
      console.error('Error deleting CV:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de supprimer le CV",
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

  if (cvDocuments.length === 0) {
    return (
      <Card className="p-12 text-center">
        <FileText className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
        <h3 className="text-xl font-semibold mb-2">Aucun CV traité</h3>
        <p className="text-muted-foreground">
          Uploadez votre premier CV pour commencer
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Historique des CV</h2>
        <Badge variant="secondary">{cvDocuments.length} document{cvDocuments.length > 1 ? 's' : ''}</Badge>
        <Button
          onClick={handleDeleteAllCVsAndClearCache}
          variant="destructive"
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Supprimer les CV et vider le cache
        </Button>
      </div>

      <div className="grid gap-4">
        {cvDocuments.map((cv) => (
          <Card key={cv.id} className="p-6 hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-4 flex-1">
                <div className="w-12 h-12 rounded-lg bg-gradient-hero flex items-center justify-center flex-shrink-0">
                  <FileText className="w-6 h-6 text-primary-foreground" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold truncate">
                      {(cv.extracted_data as any)?.header?.trigram || 'XXX'} - {(cv.extracted_data as any)?.header?.title || cv.original_file_name}
                    </h3>
                    <Badge variant={getStatusVariant(cv.status || 'uploaded')} className="flex items-center gap-1">
                      {getStatusIcon(cv.status || 'uploaded')}
                      <span>{getStatusLabel(cv.status || 'uploaded')}</span>
                    </Badge>
                  </div>

                  {cv.extracted_data && typeof cv.extracted_data === 'object' && (
                    <div className="text-sm text-muted-foreground space-y-1 mb-2">
                      <p>
                        <strong>Trigramme:</strong> {(cv.extracted_data as any).header?.trigram || 'N/A'}
                      </p>
                      <p>
                        <strong>Poste:</strong> {(cv.extracted_data as any).header?.title || 'N/A'}
                      </p>
                      <p>
                        <strong>Expérience:</strong> {(cv.extracted_data as any).personal?.years_experience || 0} ans
                      </p>
                    </div>
                  )}

                  {cv.error_message && (
                    <p className="text-sm text-destructive mb-2">
                      Erreur: {cv.error_message}
                    </p>
                  )}

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>
                      {formatDistanceToNow(new Date(cv.created_at), { addSuffix: true, locale: fr })}
                    </span>
                    {cv.processing_time_ms && (
                      <span>Traité en {Math.round(cv.processing_time_ms / 1000)}s</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 flex-shrink-0">
                {/* Télécharger le CV original */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownloadOriginal(cv)}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Original
                </Button>

                {/* Télécharger le dossier de compétences généré */}
                {cv.status === 'processed' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="default" size="sm">
                        <FileDown className="w-4 h-4 mr-2" />
                        Dossier de compétences
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleDownloadPDF(cv)}>
                        <Download className="w-4 h-4 mr-2" />
                        Format PDF
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleDownloadWord(cv)}>
                        <Download className="w-4 h-4 mr-2" />
                        Format Word (.docx)
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteCV(cv)}
                  disabled={deletingId === cv.id}
                >
                  {deletingId === cv.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 text-destructive" />
                  )}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};
