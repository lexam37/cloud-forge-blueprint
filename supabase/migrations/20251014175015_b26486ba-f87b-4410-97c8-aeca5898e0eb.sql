-- Créer un bucket public pour les logos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('company-logos', 'company-logos', true, 5242880, ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'])
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];

-- Policies pour le bucket company-logos
CREATE POLICY "Tout le monde peut voir les logos"
ON storage.objects FOR SELECT
USING (bucket_id = 'company-logos');

CREATE POLICY "Tout le monde peut uploader des logos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'company-logos');

CREATE POLICY "Tout le monde peut supprimer les logos"
ON storage.objects FOR DELETE
USING (bucket_id = 'company-logos');

-- Ajouter les policies pour supprimer templates et CVs
CREATE POLICY "Tout le monde peut supprimer les templates"
ON cv_templates FOR DELETE
USING (true);

CREATE POLICY "Tout le monde peut supprimer les CV"
ON cv_documents FOR DELETE
USING (true);