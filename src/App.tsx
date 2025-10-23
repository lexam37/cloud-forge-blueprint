import { useState, useEffect } from 'react';
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { supabase } from '@/integrations/supabase/client';
import Index from "./pages/Index";
import Dashboard from "./pages/Dashboard";
import NotFound from "./pages/NotFound";
import AuthComponent from "./components/Auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CVHistoryList } from './components/dashboard/CVHistoryList';
import { TemplateManagement } from './components/dashboard/TemplateManagement';
import { FileUploadSection } from './components/dashboard/FileUploadSection';

const queryClient = new QueryClient();

const App = () => {
  const [session, setSession] = useState(null);

  useEffect(() => {
    // Vérifier la session au chargement
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    // Écouter les changements de session
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route
              path="/dashboard"
              element={
                session ? (
                  <Tabs defaultValue="historique">
                    <TabsList>
                      <TabsTrigger value="cvupload">CV Upload</TabsTrigger>
                      <TabsTrigger value="historique">Historique</TabsTrigger>
                      <TabsTrigger value="templates">Templates</TabsTrigger>
                    </TabsList>
                    <TabsContent value="cvupload">
                      <FileUploadSection />
                    </TabsContent>
                    <TabsContent value="historique">
                      <CVHistoryList />
                    </TabsContent>
                    <TabsContent value="templates">
                      <TemplateManagement />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <Navigate to="/login" replace />
                )
              }
            />
            <Route path="/login" element={<AuthComponent />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
