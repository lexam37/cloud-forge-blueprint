-- Ajouter des policies pour le bucket cv-templates
CREATE POLICY "Tout le monde peut uploader dans cv-templates"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'cv-templates');

CREATE POLICY "Tout le monde peut lire cv-templates"
ON storage.objects
FOR SELECT
USING (bucket_id = 'cv-templates');

CREATE POLICY "Tout le monde peut mettre à jour cv-templates"
ON storage.objects
FOR UPDATE
USING (bucket_id = 'cv-templates');

-- Ajouter des policies pour le bucket cv-generated
CREATE POLICY "Tout le monde peut uploader dans cv-generated"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'cv-generated');

CREATE POLICY "Tout le monde peut lire cv-generated"
ON storage.objects
FOR SELECT
USING (bucket_id = 'cv-generated');