import { useAppContext, AppProvider } from "@/lib/store";
import { LoginScreen } from "@/components/LoginScreen";
import { ChatLayout } from "@/components/ChatLayout";
import { TooltipProvider } from "@/components/ui/tooltip";

function AppContent() {
  const { state } = useAppContext();

  if (!state.accessToken) {
    return <LoginScreen />;
  }

  return <ChatLayout />;
}

function App() {
  return (
    <AppProvider>
      <TooltipProvider>
        <AppContent />
      </TooltipProvider>
    </AppProvider>
  );
}

export default App;
