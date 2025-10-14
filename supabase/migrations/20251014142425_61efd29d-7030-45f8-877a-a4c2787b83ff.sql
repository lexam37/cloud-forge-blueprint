-- Create enum for CV processing status
CREATE TYPE public.cv_status AS ENUM ('uploaded', 'analyzing', 'processed', 'error');

-- Create enum for file types
CREATE TYPE public.file_type AS ENUM ('pdf', 'docx', 'pptx');

-- Table pour stocker les templates de CV
CREATE TABLE public.cv_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  file_path TEXT NOT NULL,
  file_type file_type NOT NULL,
  
  -- Structure extraite par l'IA
  structure_data JSONB, -- Contient: layout, couleurs, polices, logo position, sections, etc.
  
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table pour les CV uploadés et traités
CREATE TABLE public.cv_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Fichier original
  original_file_path TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  original_file_type file_type NOT NULL,
  
  -- Template utilisé
  template_id UUID REFERENCES public.cv_templates(id),
  
  -- Statut du traitement
  status cv_status DEFAULT 'uploaded',
  
  -- Données extraites du CV
  extracted_data JSONB, -- Nom, titre, expériences, compétences, formations, etc.
  
  -- CV généré
  generated_file_path TEXT,
  generated_file_type file_type,
  
  -- Métadonnées
  processing_time_ms INTEGER,
  error_message TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table pour l'historique des traitements (logs)
CREATE TABLE public.processing_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_document_id UUID REFERENCES public.cv_documents(id) ON DELETE CASCADE,
  step TEXT NOT NULL, -- 'upload', 'extraction', 'generation', 'error'
  message TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.cv_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cv_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies - Tous les utilisateurs peuvent voir les templates actifs
CREATE POLICY "Templates actifs visibles par tous"
  ON public.cv_templates
  FOR SELECT
  USING (is_active = true);

-- Tous les utilisateurs peuvent créer des CV
CREATE POLICY "Tout le monde peut uploader des CV"
  ON public.cv_documents
  FOR INSERT
  WITH CHECK (true);

-- Tous les utilisateurs peuvent voir tous les CV (pour cette version interne)
CREATE POLICY "Tous les CV sont visibles"
  ON public.cv_documents
  FOR SELECT
  USING (true);

-- Tous les utilisateurs peuvent mettre à jour les CV
CREATE POLICY "Tout le monde peut mettre à jour les CV"
  ON public.cv_documents
  FOR UPDATE
  USING (true);

-- Les logs sont visibles par tous
CREATE POLICY "Les logs sont visibles"
  ON public.processing_logs
  FOR SELECT
  USING (true);

-- Création des buckets de stockage
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
  ('cv-uploads', 'cv-uploads', false, 10485760, ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']::text[]),
  ('cv-templates', 'cv-templates', false, 10485760, ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']::text[]),
  ('cv-generated', 'cv-generated', false, 10485760, ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']::text[]);

-- Policies pour les buckets (accès public en lecture/écriture pour cette version)
CREATE POLICY "Tout le monde peut uploader des CV"
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'cv-uploads');

CREATE POLICY "Tout le monde peut lire les CV uploadés"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'cv-uploads');

CREATE POLICY "Tout le monde peut uploader des templates"
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'cv-templates');

CREATE POLICY "Tout le monde peut lire les templates"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'cv-templates');

CREATE POLICY "Tout le monde peut uploader des CV générés"
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'cv-generated');

CREATE POLICY "Tout le monde peut lire les CV générés"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'cv-generated');

CREATE POLICY "Tout le monde peut télécharger les CV générés"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'cv-generated');

-- Fonction pour mettre à jour updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers pour updated_at
CREATE TRIGGER update_cv_templates_updated_at
  BEFORE UPDATE ON public.cv_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_cv_documents_updated_at
  BEFORE UPDATE ON public.cv_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Index pour les performances
CREATE INDEX idx_cv_documents_status ON public.cv_documents(status);
CREATE INDEX idx_cv_documents_created_at ON public.cv_documents(created_at DESC);
CREATE INDEX idx_cv_templates_active ON public.cv_templates(is_active) WHERE is_active = true;
CREATE INDEX idx_processing_logs_cv_document_id ON public.processing_logs(cv_document_id);