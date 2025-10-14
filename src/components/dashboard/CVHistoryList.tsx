import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Download, Clock, CheckCircle2, AlertCircle, Loader2, FileDown } from "lucide-react";
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

interface CVDocument {
  id: string;
  original_file_name: string;
  original_file_type: string;
  status: string;
  extracted_data: any;
  processing_time_ms: number | null;
  error_message: string | null;
  generated_file_path: string | null;
  created_at: string;
}

export const CVHistoryList = () => {
  const [cvDocuments, setCvDocuments] = useState<CVDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

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

  const handleDownloadPDF = async (cv: CVDocument) => {
    try {
      toast({
        title: "Génération PDF en cours...",
        description: "Conversion du CV au format PDF",
      });

      // Appeler l'edge function pour générer le PDF
      const { data, error } = await supabase.functions.invoke('generate-cv-pdf', {
        body: { cvDocumentId: cv.id }
      });

      if (error) throw error;

      toast({
        title: "✅ PDF généré !",
        description: "Le téléchargement va démarrer...",
      });

      // Télécharger le fichier généré
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('cv-generated')
        .download(data.filePath);

      if (downloadError) throw downloadError;

      const url = URL.createObjectURL(fileData);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CV_${cv.original_file_name.replace(/\.[^/.]+$/, '')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de générer le PDF",
      });
    }
  };

  const handleDownloadWord = async (cv: CVDocument) => {
    try {
      toast({
        title: "Génération Word en cours...",
        description: "Conversion du CV au format Word",
      });

      // Appeler l'edge function pour générer le Word
      const { data, error } = await supabase.functions.invoke('generate-cv-word', {
        body: { cvDocumentId: cv.id }
      });

      if (error) throw error;

      toast({
        title: "✅ Word généré !",
        description: "Le téléchargement va démarrer...",
      });

      // Télécharger le fichier généré
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('cv-generated')
        .download(data.filePath);

      if (downloadError) throw downloadError;

      const url = URL.createObjectURL(fileData);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CV_${cv.original_file_name.replace(/\.[^/.]+$/, '')}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error generating Word:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de générer le Word",
      });
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
                    <h3 className="font-semibold truncate">{cv.original_file_name}</h3>
                    <Badge variant={getStatusVariant(cv.status)} className="flex items-center gap-1">
                      {getStatusIcon(cv.status)}
                      <span>{getStatusLabel(cv.status)}</span>
                    </Badge>
                  </div>

                  {cv.extracted_data && (
                    <div className="text-sm text-muted-foreground space-y-1 mb-2">
                      <p>
                        <strong>Candidat:</strong> {cv.extracted_data.personal?.anonymized_first}. {cv.extracted_data.personal?.anonymized_last}.
                      </p>
                      <p>
                        <strong>Poste:</strong> {cv.extracted_data.personal?.title}
                      </p>
                      <p>
                        <strong>Expérience:</strong> {cv.extracted_data.personal?.years_experience} ans
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
                      <span>Traité en {cv.processing_time_ms}ms</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 flex-shrink-0">
                {cv.status === 'processed' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <FileDown className="w-4 h-4 mr-2" />
                        Télécharger
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
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};
