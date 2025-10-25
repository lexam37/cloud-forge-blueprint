-- Créer le bucket pour les CV générés
INSERT INTO storage.buckets (id, name, public)
VALUES ('cv-outputs', 'cv-outputs', false)
ON CONFLICT (id) DO NOTHING;

-- Politique RLS pour permettre aux utilisateurs de télécharger leurs propres CV
CREATE POLICY "Users can upload their own CV outputs"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'cv-outputs' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can view their own CV outputs"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'cv-outputs' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can update their own CV outputs"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'cv-outputs' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete their own CV outputs"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'cv-outputs' AND
  auth.uid()::text = (storage.foldername(name))[1]
);