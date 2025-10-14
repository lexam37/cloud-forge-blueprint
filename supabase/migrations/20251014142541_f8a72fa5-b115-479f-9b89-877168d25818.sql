-- Corriger la fonction update_updated_at_column pour la sécurité
DROP FUNCTION IF EXISTS public.update_updated_at_column() CASCADE;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Recréer les triggers
CREATE TRIGGER update_cv_templates_updated_at
  BEFORE UPDATE ON public.cv_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_cv_documents_updated_at
  BEFORE UPDATE ON public.cv_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();