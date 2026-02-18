import { useState, useEffect, useRef, useCallback } from "react";
import { WifiOff, ChevronRight } from "lucide-react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { AppSidebar } from "./AppSidebar";
import { ChatArea } from "./ChatArea";
import { MembersPanel } from "./MembersPanel";
import { VoiceControls } from "./VoiceControls";
import { ScreenShareViewer, ScreenShareHeader } from "./ScreenShareViewer";
import { CreateRoomDialog, JoinRoomDialog } from "./RoomDialogs";
import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";

/** Floating tab that appears on the left edge when the sidebar is collapsed */
function LeftPanelRestoreButton() {
  const { state, toggleSidebar } = useSidebar();
  if (state === "expanded") return null;
  return (
    <button
      onClick={toggleSidebar}
      title="Open sidebar (Ctrl+B)"
      className="absolute left-0 top-1/2 -translate-y-1/2 z-20 flex h-10 w-5 items-center justify-center rounded-r-md border border-l-0 border-border bg-sidebar text-muted-foreground shadow-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
    >
      <ChevronRight className="h-3 w-3" />
    </button>
  );
}

export function ChatLayout() {
  const { state, loadRooms } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  const viewerContainerRef = useRef<HTMLDivElement>(null);

  // PiP anchor: a tiny hidden video that stays mounted for Picture-in-Picture
  const pipAnchorRef = useRef<HTMLVideoElement>(null);
  const [isPiP, setIsPiP] = useState(false);

  // Load rooms on mount
  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const hasActiveScreenShare =
    state.screenViewerOpen &&
    state.inVoiceChannel &&
    state.activeScreenSharers.length > 0;

  // Only show the in-panel viewer when we're in the voice room itself
  const isOnVoiceRoom =
    state.voiceRoomId != null && state.currentRoomId === state.voiceRoomId;

  const showViewer = hasActiveScreenShare && isOnVoiceRoom;

  // Keep the PiP anchor's srcObject synced to the selected stream
  useEffect(() => {
    if (!hasActiveScreenShare) return;
    const anchor = pipAnchorRef.current;
    if (!anchor) return;

    const syncStream = () => {
      const sharer = state.selectedScreenSharer;
      if (!sharer) return;
      const stream = screenStreamsMap.get(sharer);
      if (stream && anchor.srcObject !== stream) {
        anchor.srcObject = stream;
        anchor.play().catch(() => {});
      }
    };

    syncStream();
    window.addEventListener("screen-stream-update", syncStream);
    return () => window.removeEventListener("screen-stream-update", syncStream);
  }, [hasActiveScreenShare, state.selectedScreenSharer]);

  // Auto-enter PiP when switching away from the voice room; auto-exit when returning
  useEffect(() => {
    const anchor = pipAnchorRef.current;
    if (!anchor) return;

    if (hasActiveScreenShare && !isOnVoiceRoom) {
      // Away from voice room — enter PiP (mute self-share to avoid feedback)
      anchor.muted = state.selectedScreenSharer === state.userId;
      if (!document.pictureInPictureElement && typeof anchor.requestPictureInPicture === "function") {
        anchor.play().catch(() => {});
        try { anchor.requestPictureInPicture(); } catch { /* unsupported or not allowed */ }
      }
    } else {
      // On voice room — mute anchor (ScreenShareViewer handles audio), exit PiP if needed
      anchor.muted = true;
      if (document.pictureInPictureElement === anchor) {
        try { document.exitPictureInPicture(); } catch { /* ignore */ }
      }
    }
  }, [hasActiveScreenShare, isOnVoiceRoom, state.selectedScreenSharer, state.userId]);

  // Track PiP state via browser events
  useEffect(() => {
    const onEnter = () => setIsPiP(true);
    const onLeave = () => setIsPiP(false);
    document.addEventListener("enterpictureinpicture", onEnter);
    document.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      document.removeEventListener("enterpictureinpicture", onEnter);
      document.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  // Manual PiP toggle used by the button in ScreenShareHeader
  const togglePiP = useCallback(async () => {
    const anchor = pipAnchorRef.current;
    if (!anchor || typeof anchor.requestPictureInPicture !== "function") return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        anchor.muted = state.selectedScreenSharer === state.userId;
        await anchor.requestPictureInPicture();
      }
    } catch { /* PiP not available or user declined */ }
  }, [state.selectedScreenSharer, state.userId]);

  return (
    <>
      <SidebarProvider>
        {/* PiP anchor video: always mounted when a screen share viewer is active.
            Positioned off-screen (not display:none) so requestPictureInPicture works. */}
        {hasActiveScreenShare && (
          <video
            ref={pipAnchorRef}
            autoPlay
            playsInline
            muted
            style={{
              position: "fixed",
              left: "-2px",
              top: "-2px",
              width: "2px",
              height: "2px",
              opacity: 0.01,
              pointerEvents: "none",
              zIndex: -1,
            }}
          />
        )}

        <div className="flex h-screen w-full">
          <AppSidebar
            onCreateRoom={() => setCreateOpen(true)}
            onJoinRoom={() => setJoinOpen(true)}
          />

          <SidebarInset className="flex flex-1 flex-col min-w-0">
            {/* Floating restore button — only visible when left sidebar is collapsed */}
            <LeftPanelRestoreButton />

            {/* Connection lost banner */}
            {!state.wsConnected && (
              <div className="flex items-center justify-center gap-2 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white">
                <WifiOff className="h-4 w-4" />
                Connection lost — reconnecting…
              </div>
            )}

            {/* Voice controls at top of main area */}
            <VoiceControls />

            {/* Main content: chat + members */}
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              {showViewer ? (
                <div ref={viewerContainerRef} className="flex-1 flex flex-col min-h-0">
                  {/* Header lives outside the resizable panels — always visible */}
                  <ScreenShareHeader
                    containerRef={viewerContainerRef}
                    isPiP={isPiP}
                    onTogglePiP={togglePiP}
                  />

                  <ResizablePanelGroup
                    orientation="vertical"
                    className="flex-1"
                  >
                    <ResizablePanel defaultSize={50} minSize={15}>
                      <div className="h-full flex flex-col min-h-0">
                        <ScreenShareViewer />
                      </div>
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={50} minSize={15}>
                      <div className="h-full flex flex-col min-h-0">
                        <ChatArea />
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              ) : (
                <ChatArea />
              )}
              <MembersPanel
                collapsed={membersCollapsed}
                onToggle={() => setMembersCollapsed((v) => !v)}
              />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <Toaster />
    </>
  );
}
