import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Save, Loader2, Upload, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface CommercialProfile {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  logo_path: string | null;
}

export const CommercialProfile = () => {
  const [profile, setProfile] = useState<CommercialProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    first_name: "",
    last_name: "",
    phone: "",
    email: "",
  });
  const { toast } = useToast();

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    setIsLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('commercial_profiles')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setProfile(data);
        setFormData({
          first_name: data.first_name,
          last_name: data.last_name,
          phone: data.phone,
          email: data.email,
        });
        
        // Charger l'aperçu du logo si disponible
        if (data.logo_path) {
          const { data: urlData } = supabase.storage
            .from('company-logos')
            .getPublicUrl(data.logo_path);
          setLogoPreview(urlData.publicUrl);
        }
      }
    } catch (error) {
      console.error('Error fetching profile:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de charger le profil",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to save profile",
          variant: "destructive"
        });
        return;
      }

      if (profile) {
        // Update existing profile
        const { error } = await supabase
          .from('commercial_profiles')
          .update(formData)
          .eq('id', profile.id)
          .eq('user_id', user.id);

        if (error) throw error;

        toast({
          title: "Profil mis à jour",
          description: "Vos coordonnées ont été mises à jour avec succès",
        });
      } else {
        // Create new profile with user_id
        const { error } = await supabase
          .from('commercial_profiles')
          .insert({
            ...formData,
            user_id: user.id
          });

        if (error) throw error;

        toast({
          title: "Profil créé",
          description: "Vos coordonnées ont été enregistrées avec succès",
        });
      }

      fetchProfile();
    } catch (error) {
      console.error('Error saving profile:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de sauvegarder le profil",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Vérifier le type de fichier
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        variant: "destructive",
        title: "Format non supporté",
        description: "Veuillez uploader une image PNG, JPG ou SVG",
      });
      return;
    }

    // Vérifier la taille (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        variant: "destructive",
        title: "Fichier trop volumineux",
        description: "Le logo ne doit pas dépasser 5 Mo",
      });
      return;
    }

    setIsUploadingLogo(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to upload logo",
          variant: "destructive"
        });
        return;
      }
      const timestamp = Date.now();
      const randomString = Math.random().toString(36).substring(7);
      const fileExt = file.name.split('.').pop();
      const fileName = `logo-${timestamp}-${randomString}.${fileExt}`;
      const filePath = fileName;

      // Upload vers Supabase Storage (bucket company-logos)
      const { error: uploadError } = await supabase.storage
        .from('company-logos')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      // Mettre à jour le profil avec le chemin du logo
      if (profile) {
        const { error: updateError } = await supabase
          .from('commercial_profiles')
          .update({ logo_path: filePath })
          .eq('id', profile.id)
          .eq('user_id', user.id);

        if (updateError) throw updateError;
      }

      // Créer l'aperçu local
      const reader = new FileReader();
      reader.onloadend = () => {
        setLogoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);

      toast({
        title: "Logo uploadé",
        description: "Votre logo a été enregistré avec succès",
      });

      fetchProfile();
    } catch (error) {
      console.error('Error uploading logo:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible d'uploader le logo",
      });
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!profile || !profile.logo_path) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to remove logo",
          variant: "destructive"
        });
        return;
      }

      // Supprimer du storage
      await supabase.storage
        .from('company-logos')
        .remove([profile.logo_path]);

      // Mettre à jour le profil
      const { error } = await supabase
        .from('commercial_profiles')
        .update({ logo_path: null })
        .eq('id', profile.id)
        .eq('user_id', user.id);

      if (error) throw error;

      setLogoPreview(null);
      
      toast({
        title: "Logo supprimé",
        description: "Le logo a été retiré de votre profil",
      });

      fetchProfile();
    } catch (error) {
      console.error('Error removing logo:', error);
      toast({
        variant: "destructive",
        title: "Erreur",
        description: "Impossible de supprimer le logo",
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Profil Commercial</h2>
        <p className="text-muted-foreground">
          Ces coordonnées et votre logo apparaîtront sur les CV générés
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-gradient-hero flex items-center justify-center">
              <User className="w-8 h-8 text-primary-foreground" />
            </div>
            <div>
              <h3 className="text-xl font-semibold">Mes coordonnées</h3>
              <p className="text-sm text-muted-foreground">
                Commercial SpeedCV
              </p>
            </div>
          </div>

          {/* Section Logo */}
          <div className="space-y-4 pb-6 border-b">
            <Label>Logo de la société</Label>
            <p className="text-sm text-muted-foreground">
              Ce logo apparaîtra sur tous les CV générés (PNG, JPG ou SVG, max 5 Mo)
            </p>
            
            {logoPreview ? (
              <div className="flex items-center gap-4">
                <div className="w-32 h-32 border-2 border-dashed rounded-lg flex items-center justify-center bg-background">
                  <img src={logoPreview} alt="Logo" className="max-w-full max-h-full object-contain p-2" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveLogo}
                >
                  <X className="w-4 h-4 mr-2" />
                  Supprimer
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <label className="cursor-pointer">
                  <input
                    type="file"
                    className="hidden"
                    accept="image/png,image/jpeg,image/jpg,image/svg+xml"
                    onChange={handleLogoUpload}
                    disabled={isUploadingLogo}
                  />
                  <div className="w-32 h-32 border-2 border-dashed rounded-lg flex flex-col items-center justify-center hover:border-primary transition-colors bg-background">
                    {isUploadingLogo ? (
                      <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    ) : (
                      <>
                        <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                        <span className="text-xs text-muted-foreground text-center px-2">
                          Cliquez pour uploader
                        </span>
                      </>
                    )}
                  </div>
                </label>
              </div>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="first_name">Prénom *</Label>
              <Input
                id="first_name"
                placeholder="Jean"
                value={formData.first_name}
                onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="last_name">NOM *</Label>
              <Input
                id="last_name"
                placeholder="DUPONT"
                value={formData.last_name}
                onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Téléphone *</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="+33 6 12 34 56 78"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                placeholder="jean.dupont@speedcv.fr"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>
          </div>

          <Button type="submit" variant="hero" size="lg" disabled={isSaving} className="w-full">
            {isSaving ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Enregistrement...
              </>
            ) : (
              <>
                <Save className="w-5 h-5 mr-2" />
                Enregistrer mes coordonnées
              </>
            )}
          </Button>
        </form>
      </Card>
    </div>
  );
};
