import { useState, useEffect, useRef, useCallback } from "react";
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
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const [isPiP, setIsPiP] = useState(false);

  // pipPending: true while we're waiting for PiP to activate after a room switch.
  // Keeps the viewer wrapper visible so the browser still decodes video frames.
  const [pipPending, setPipPending] = useState(false);

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

  // Detect transition away from voice room during render (synchronously) so
  // the wrapper stays visible in the SAME commit — effects run too late.
  const prevIsOnVoiceRoomRef = useRef(isOnVoiceRoom);
  if (prevIsOnVoiceRoomRef.current !== isOnVoiceRoom) {
    prevIsOnVoiceRoomRef.current = isOnVoiceRoom;
    if (!isOnVoiceRoom && hasActiveScreenShare) {
      // Leaving voice room with active screen share — hold the viewer visible
      // until PiP is confirmed so the video keeps decoding frames.
      if (!pipPending) setPipPending(true);
    }
  }

  // The viewer wrapper stays visible while showing OR while PiP is pending
  const viewerVisible = showViewer || (hasActiveScreenShare && pipPending);

  // Once pipPending is set, request PiP on the still-visible video
  useEffect(() => {
    if (!pipPending) return;
    const videoEl = getScreenVideo();
    if (videoEl && typeof videoEl.requestPictureInPicture === "function") {
      (async () => {
        try {
          await videoEl.play();
          await videoEl.requestPictureInPicture();
        } catch { /* unsupported / not allowed */ }
        setPipPending(false);
      })();
    } else {
      setPipPending(false);
    }
  }, [pipPending]);

  // Exit PiP when returning to the voice room
  useEffect(() => {
    if (isOnVoiceRoom && document.pictureInPictureElement) {
      try { document.exitPictureInPicture(); } catch { /* ignore */ }
    }
    if (isOnVoiceRoom) setPipPending(false);
  }, [isOnVoiceRoom]);

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
              <div className="flex-1 flex flex-col min-h-0">
                {/*
                  ScreenShareViewer is always at this tree position when
                  hasActiveScreenShare is true, so it never unmounts on room
                  switch.  The wrapper div switches between visible (flex child)
                  and hidden (off-screen fixed) keeping the <video> alive and
                  its decode pipeline running for PiP.
                */}
                {hasActiveScreenShare && (
                  <>
                    {showViewer && (
                      <ScreenShareHeader
                        containerRef={viewerContainerRef}
                        isPiP={isPiP}
                        onTogglePiP={togglePiP}
                      />
                    )}
                    <div
                      ref={viewerContainerRef}
                      style={
                        viewerVisible
                          ? { flex: "1 1 50%", minHeight: 0, display: "flex", flexDirection: "column" as const }
                          : { position: "fixed", left: "-9999px", top: "-9999px", width: "320px", height: "180px" }
                      }
                    >
                      <ScreenShareViewer />
                    </div>
                  </>
                )}
                <div style={viewerVisible ? { flex: "1 1 50%", minHeight: 0, display: "flex", flexDirection: "column" as const } : { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" as const }}>
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
