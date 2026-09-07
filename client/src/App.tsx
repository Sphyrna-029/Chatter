import { lazy, Suspense } from "react";
import { useAppContext, AppProvider } from "@/lib/store";
import { LoginScreen } from "@/components/LoginScreen";
import { ChatLayout } from "@/components/ChatLayout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { useThemeSettings } from "@/hooks/useThemeSettings";

// Only ever reached by following an invite link, which is a fresh navigation
// anyway — no reason for every other load to carry it.
const InvitePage = lazy(() =>
  import("@/components/InvitePage").then((m) => ({ default: m.InvitePage })),
);

function getInviteCode(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

function AppContent() {
  const { state } = useAppContext();

  const inviteCode = getInviteCode();
  if (inviteCode) {
    return (
      <Suspense fallback={null}>
        <InvitePage inviteCode={inviteCode} />
      </Suspense>
    );
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
        <ConfirmProvider>
          <AppContent />
        </ConfirmProvider>
      </TooltipProvider>
    </AppProvider>
  );
}

export default App;
