-- Ajouter le champ logo_path dans commercial_profiles
ALTER TABLE public.commercial_profiles 
ADD COLUMN logo_path TEXT;

-- Ajouter un commentaire pour documenter la colonne
COMMENT ON COLUMN public.commercial_profiles.logo_path IS 'Chemin du fichier logo de la société dans le bucket cv-uploads';