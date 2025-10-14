-- Ajouter la policy INSERT manquante pour cv_templates
CREATE POLICY "Tout le monde peut uploader des templates"
ON public.cv_templates
FOR INSERT
WITH CHECK (true);

-- Ajouter la policy UPDATE pour cv_templates
CREATE POLICY "Tout le monde peut mettre à jour les templates"
ON public.cv_templates
FOR UPDATE
USING (true);

-- Créer une table pour les coordonnées commerciales
CREATE TABLE public.commercial_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.commercial_profiles ENABLE ROW LEVEL SECURITY;

-- Policies pour commercial_profiles
CREATE POLICY "Profils commerciaux visibles par tous"
ON public.commercial_profiles
FOR SELECT
USING (true);

CREATE POLICY "Tout le monde peut créer un profil commercial"
ON public.commercial_profiles
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Tout le monde peut mettre à jour les profils commerciaux"
ON public.commercial_profiles
FOR UPDATE
USING (true);

CREATE POLICY "Tout le monde peut supprimer les profils commerciaux"
ON public.commercial_profiles
FOR DELETE
USING (true);

-- Trigger pour updated_at
CREATE TRIGGER update_commercial_profiles_updated_at
BEFORE UPDATE ON public.commercial_profiles
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();