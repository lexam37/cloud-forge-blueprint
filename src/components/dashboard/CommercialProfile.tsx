import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Save, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface CommercialProfile {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
}

export const CommercialProfile = () => {
  const [profile, setProfile] = useState<CommercialProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
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
      const { data, error } = await supabase
        .from('commercial_profiles')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
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
      if (profile) {
        // Update existing profile
        const { error } = await supabase
          .from('commercial_profiles')
          .update(formData)
          .eq('id', profile.id);

        if (error) throw error;

        toast({
          title: "Profil mis à jour",
          description: "Vos coordonnées ont été mises à jour avec succès",
        });
      } else {
        // Create new profile
        const { error } = await supabase
          .from('commercial_profiles')
          .insert(formData);

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
          Ces coordonnées apparaîtront sur les CV générés
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
