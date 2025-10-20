import { useState } from "react";
import { FileUploadSection } from "@/components/dashboard/FileUploadSection";
import { TemplateManagement } from "@/components/dashboard/TemplateManagement";
import { CVHistoryList } from "@/components/dashboard/CVHistoryList";
import Header from "@/components/Header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Upload, History, FileText } from "lucide-react";

const Dashboard = () => {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleUploadSuccess = () => {
    setRefreshKey(prev => prev + 1);
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Dashboard SpeedCV</h1>
          <p className="text-muted-foreground">Gérez vos CV et templates en toute simplicité</p>
        </div>

        <Tabs defaultValue="upload" className="w-full">
          <TabsList className="grid w-full max-w-2xl grid-cols-3">
            <TabsTrigger value="upload" className="flex items-center gap-2">
              <Upload className="w-4 h-4" />
              <span className="hidden sm:inline">Upload CV</span>
            </TabsTrigger>
            <TabsTrigger value="history" className="flex items-center gap-2">
              <History className="w-4 h-4" />
              <span className="hidden sm:inline">Historique</span>
            </TabsTrigger>
            <TabsTrigger value="templates" className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              <span className="hidden sm:inline">Templates</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="mt-6">
            <FileUploadSection onUploadSuccess={handleUploadSuccess} />
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            <CVHistoryList key={refreshKey} />
          </TabsContent>

          <TabsContent value="templates" className="mt-6">
            <TemplateManagement />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Dashboard;
