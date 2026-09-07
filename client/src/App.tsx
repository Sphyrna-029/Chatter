import { lazy, Suspense } from "react";
import { WifiOff } from "lucide-react";
import { useAppContext, AppProvider } from "@/lib/store";
import { hadSession } from "@/lib/api";
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

/** Shown while a session is being restored against a server that is not
 *  answering. Deliberately the same words as the in-app connection banner: it
 *  is the same situation, met before the app could open rather than during. */
function ReconnectingScreen() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <WifiOff className="h-6 w-6 text-amber-600" />
      <p className="text-sm font-medium text-amber-600">
        Connection lost — reconnecting…
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        You are still signed in. This will carry on by itself as soon as the
        server answers.
      </p>
    </div>
  );
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
    // "pending" and "unreachable" are not "logged out" — the server has not
    // answered yet, or could not. Someone who has signed in on this browser
    // waits behind the same banner the app shows for a dropped socket, rather
    // than a login form they do not need; the restore keeps retrying behind it
    // and drops them straight in. Only "absent" is the server actually saying
    // there is no session.
    if (state.sessionRestore !== "absent" && hadSession()) {
      return <ReconnectingScreen />;
    }
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
