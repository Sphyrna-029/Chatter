import { useState, useEffect, useCallback } from "react";
import { WifiOff, ChevronRight } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { AppSidebar } from "./AppSidebar";
import { ChatArea } from "./ChatArea";
import { MembersPanel } from "./MembersPanel";
import { VoiceControls } from "./VoiceControls";
import { ScreenShareViewer, ScreenShareHeader } from "./ScreenShareViewer";
import { CreateRoomDialog, JoinRoomDialog } from "./RoomDialogs";
import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar";
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

/** Helper — grab the ScreenShareViewer's <video> element by id */
function getScreenVideo(): HTMLVideoElement | null {
  return document.getElementById("screen-share-main-video") as HTMLVideoElement | null;
}

export function ChatLayout() {
  const { state, loadRooms } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  const [isPiP, setIsPiP] = useState(false);

  // Load rooms on mount
  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const hasActiveScreenShare =
    state.screenViewerOpen &&
    state.inVoiceChannel &&
    state.activeScreenSharers.length > 0;

  const isOnVoiceRoom =
    state.voiceRoomId != null && state.currentRoomId === state.voiceRoomId;

  // Show the full inline viewer only when on the voice room
  const showViewer = hasActiveScreenShare && isOnVoiceRoom;

  // Auto-enter PiP when navigating away from the voice room.
  // The viewer wrapper stays on-screen (behind the chat via z-index:-1)
  // so the browser keeps decoding video frames for the PiP request.
  useEffect(() => {
    if (!hasActiveScreenShare) return;

    if (!isOnVoiceRoom) {
      const videoEl = getScreenVideo();
      if (
        videoEl &&
        !document.pictureInPictureElement &&
        typeof videoEl.requestPictureInPicture === "function"
      ) {
        (async () => {
          try {
            await videoEl.play();
            await videoEl.requestPictureInPicture();
          } catch { /* unsupported / not allowed */ }
        })();
      }
    } else {
      // Returned to voice room — exit PiP so the inline viewer takes over
      if (document.pictureInPictureElement) {
        try { document.exitPictureInPicture(); } catch { /* ignore */ }
      }
    }
  }, [hasActiveScreenShare, isOnVoiceRoom]);

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

  // Manual PiP toggle (button in ScreenShareHeader)
  const togglePiP = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        const videoEl = getScreenVideo();
        if (videoEl && typeof videoEl.requestPictureInPicture === "function") {
          await videoEl.play();
          await videoEl.requestPictureInPicture();
        }
      }
    } catch { /* PiP not available or user declined */ }
  }, []);

  return (
    <>
      <SidebarProvider>
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
              {/*
                The inner column uses position:relative so the viewer can
                be placed behind the chat (position:absolute, z-index:-1)
                when not on the voice room.  This keeps the video element
                on-screen and decoding so PiP gets real frames.
              */}
              <div className="flex-1 flex flex-col min-h-0 relative">
                {showViewer && (
                  <ScreenShareHeader
                    containerRef={undefined as any}
                    isPiP={isPiP}
                    onTogglePiP={togglePiP}
                  />
                )}

                {/*
                  ScreenShareViewer stays mounted at this tree position
                  whenever hasActiveScreenShare is true.  When showing: flex
                  child taking 50%.  When hidden: absolute behind the chat
                  so video keeps decoding for PiP.
                */}
                {hasActiveScreenShare && (
                  <div
                    style={
                      showViewer
                        ? { flex: "1 1 50%", minHeight: 0, display: "flex", flexDirection: "column" as const }
                        : {
                            position: "absolute" as const,
                            inset: 0,
                            zIndex: -1,
                            overflow: "hidden",
                            pointerEvents: "none" as const,
                          }
                    }
                  >
                    <ScreenShareViewer />
                  </div>
                )}

                <div
                  style={
                    showViewer
                      ? { flex: "1 1 50%", minHeight: 0, display: "flex", flexDirection: "column" as const }
                      : { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" as const }
                  }
                >
                  <ChatArea />
                </div>
              </div>

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
