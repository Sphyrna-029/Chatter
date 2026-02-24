import { useAppContext, AppProvider } from "@/lib/store";
import { LoginScreen } from "@/components/LoginScreen";
import { ChatLayout } from "@/components/ChatLayout";
import { InvitePage } from "@/components/InvitePage";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useThemeSettings } from "@/hooks/useThemeSettings";

function getInviteCode(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

function AppContent() {
  const { state } = useAppContext();

  const inviteCode = getInviteCode();
  if (inviteCode) {
    return <InvitePage inviteCode={inviteCode} />;
  }

  if (!state.accessToken) {
    return <LoginScreen />;
  }

  return <ChatLayout />;
}

function App() {
  useThemeSettings();

  return (
    <AppProvider>
      <TooltipProvider>
        <AppContent />
      </TooltipProvider>
    </AppProvider>
  );
}

export default App;
