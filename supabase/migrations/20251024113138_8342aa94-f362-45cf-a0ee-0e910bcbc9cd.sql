-- Phase 1: Add user_id columns to track data ownership
ALTER TABLE commercial_profiles ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE cv_documents ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE cv_templates ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add indexes for performance
CREATE INDEX idx_cv_documents_user_id ON cv_documents(user_id);
CREATE INDEX idx_cv_templates_user_id ON cv_templates(user_id);
CREATE INDEX idx_commercial_profiles_user_id ON commercial_profiles(user_id);

-- Phase 2: Drop all insecure 'WHERE true' RLS policies

-- Drop cv_documents policies
DROP POLICY IF EXISTS "Tous les CV sont visibles" ON cv_documents;
DROP POLICY IF EXISTS "Tout le monde peut uploader des CV" ON cv_documents;
DROP POLICY IF EXISTS "Tout le monde peut mettre à jour les CV" ON cv_documents;
DROP POLICY IF EXISTS "Tout le monde peut supprimer les CV" ON cv_documents;

-- Drop cv_templates policies
DROP POLICY IF EXISTS "Tout le monde peut voir tous les templates" ON cv_templates;
DROP POLICY IF EXISTS "Tout le monde peut créer des templates" ON cv_templates;
DROP POLICY IF EXISTS "Tout le monde peut modifier les templates" ON cv_templates;
DROP POLICY IF EXISTS "Tout le monde peut supprimer les templates" ON cv_templates;

-- Drop commercial_profiles policies
DROP POLICY IF EXISTS "Profils commerciaux visibles par tous" ON commercial_profiles;
DROP POLICY IF EXISTS "Tout le monde peut créer un profil commercial" ON commercial_profiles;
DROP POLICY IF EXISTS "Tout le monde peut mettre à jour les profils commerciaux" ON commercial_profiles;
DROP POLICY IF EXISTS "Tout le monde peut supprimer les profils commerciaux" ON commercial_profiles;

-- Phase 3: Create secure user-scoped RLS policies

-- cv_documents: Users can only access their own CVs
CREATE POLICY "Users can view their own CVs"
  ON cv_documents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own CVs"
  ON cv_documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own CVs"
  ON cv_documents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own CVs"
  ON cv_documents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- cv_templates: Authenticated users can view all active templates, but only manage their own
CREATE POLICY "Users can view all active templates"
  ON cv_templates FOR SELECT
  TO authenticated
  USING (is_active = true OR auth.uid() = user_id);

CREATE POLICY "Users can create their own templates"
  ON cv_templates FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own templates"
  ON cv_templates FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own templates"
  ON cv_templates FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- commercial_profiles: Users can only manage their own profile
CREATE POLICY "Users can view their own profile"
  ON commercial_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own profile"
  ON commercial_profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON commercial_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own profile"
  ON commercial_profiles FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Phase 4: Storage RLS policies

-- cv-uploads bucket: Users can only access their own uploaded CVs
CREATE POLICY "Users can upload their own CV files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'cv-uploads' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can view their own CV files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'cv-uploads' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can delete their own CV files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'cv-uploads' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- cv-generated bucket: Users can only access their own generated files
CREATE POLICY "Users can create their own generated files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'cv-generated' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can view their own generated files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'cv-generated' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can delete their own generated files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'cv-generated' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- cv-templates bucket: Users can only access their own templates
CREATE POLICY "Users can upload their own template files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'cv-templates' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can view their own template files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'cv-templates' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can delete their own template files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'cv-templates' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- company-logos bucket: Public bucket remains accessible to all (intentional)
CREATE POLICY "Anyone can view company logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'company-logos');

CREATE POLICY "Authenticated users can upload company logos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'company-logos');