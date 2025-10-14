import { FileText } from "lucide-react";

const Footer = () => {
  return (
    <footer className="bg-card border-t py-12">
      <div className="container mx-auto px-4">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          <div className="col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 bg-gradient-hero rounded-lg flex items-center justify-center">
                <FileText className="w-6 h-6 text-primary-foreground" />
              </div>
              <div>
                <h3 className="text-xl font-bold bg-gradient-hero bg-clip-text text-transparent">
                  SpeedCV
                </h3>
                <p className="text-xs text-muted-foreground">Standardisation IA</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground max-w-md">
              Automatisez la création de dossiers de compétences professionnels grâce à l'intelligence artificielle.
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Produit</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="#features" className="hover:text-foreground transition-colors">Fonctionnalités</a></li>
              <li><a href="#how-it-works" className="hover:text-foreground transition-colors">Comment ça marche</a></li>
              <li><a href="#" className="hover:text-foreground transition-colors">Tarifs</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Support</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="#" className="hover:text-foreground transition-colors">Documentation</a></li>
              <li><a href="#" className="hover:text-foreground transition-colors">Contact</a></li>
              <li><a href="#" className="hover:text-foreground transition-colors">FAQ</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t pt-8 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <p>© 2025 SpeedCV. Tous droits réservés.</p>
          <div className="flex gap-6">
            <a href="#" className="hover:text-foreground transition-colors">Confidentialité</a>
            <a href="#" className="hover:text-foreground transition-colors">Conditions</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
