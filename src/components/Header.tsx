import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useNavigate } from "react-router-dom";

const Header = () => {
  const navigate = useNavigate();

  return (
    <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-10 h-10 bg-gradient-hero rounded-lg flex items-center justify-center">
            <FileText className="w-6 h-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-bold bg-gradient-hero bg-clip-text text-transparent">
              SpeedCV
            </h1>
            <p className="text-xs text-muted-foreground">Standardisation IA</p>
          </div>
        </Link>
        
        <nav className="hidden md:flex items-center gap-6">
          <a href="/#features" className="text-sm font-medium text-foreground/80 hover:text-foreground transition-colors">
            Fonctionnalités
          </a>
          <a href="/#how-it-works" className="text-sm font-medium text-foreground/80 hover:text-foreground transition-colors">
            Comment ça marche
          </a>
          <Button variant="hero" size="sm" onClick={() => navigate('/dashboard')}>
            Commencer
          </Button>
        </nav>
      </div>
    </header>
  );
};

export default Header;
