-- Supprimer les anciennes policies restrictives
DROP POLICY IF EXISTS "Templates actifs visibles par tous" ON cv_templates;
DROP POLICY IF EXISTS "Tout le monde peut uploader des templates" ON cv_templates;
DROP POLICY IF EXISTS "Tout le monde peut mettre à jour les templates" ON cv_templates;

-- Créer des policies plus permissives pour la démo
CREATE POLICY "Tout le monde peut voir tous les templates"
ON cv_templates FOR SELECT
USING (true);

CREATE POLICY "Tout le monde peut créer des templates"
ON cv_templates FOR INSERT
WITH CHECK (true);

CREATE POLICY "Tout le monde peut modifier les templates"
ON cv_templates FOR UPDATE
USING (true);

-- Mettre à jour l'enum file_type pour supporter tous les formats
ALTER TYPE file_type ADD VALUE IF NOT EXISTS 'doc';
ALTER TYPE file_type ADD VALUE IF NOT EXISTS 'ppt';