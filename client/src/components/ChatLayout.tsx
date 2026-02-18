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
  const { state, loadRooms, selectRoom } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const [isPiP, setIsPiP] = useState(false);
  // Flag to distinguish our code exiting PiP vs the user clicking "back to tab" / close
  const programmaticPipExitRef = useRef(false);

  // Load rooms on mount
  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const isOnVoiceRoom = state.voiceRoomId != null && state.currentRoomId === state.voiceRoomId;
  const hasActiveScreenShare =
    state.screenViewerOpen &&
    state.inVoiceChannel &&
    state.activeScreenSharers.length > 0;
  const showViewer = hasActiveScreenShare && isOnVoiceRoom;

  // Sync hidden video's srcObject with the selected screen sharer's stream
  useEffect(() => {
    const syncStream = () => {
      const video = pipVideoRef.current;
      if (!video) return;
      const stream = state.selectedScreenSharer
        ? screenStreamsMap.get(state.selectedScreenSharer) ?? null
        : null;
      if (video.srcObject !== stream) {
        video.srcObject = stream;
        if (stream) video.play().catch(() => {});
      }
    };
    syncStream();
    const handler = () => syncStream();
    window.addEventListener("screen-stream-update", handler);
    return () => window.removeEventListener("screen-stream-update", handler);
  }, [state.selectedScreenSharer]);

  // Keep refs for values needed inside PiP event handlers (avoids stale closures)
  const voiceRoomIdRef = useRef(state.voiceRoomId);
  const selectRoomRef = useRef(selectRoom);
  useEffect(() => { voiceRoomIdRef.current = state.voiceRoomId; }, [state.voiceRoomId]);
  useEffect(() => { selectRoomRef.current = selectRoom; }, [selectRoom]);

  // Track PiP state via events on the video element
  useEffect(() => {
    const video = pipVideoRef.current;
    if (!video) return;
    const onEnter = () => setIsPiP(true);
    const onLeave = () => {
      setIsPiP(false);
      if (programmaticPipExitRef.current) {
        // Our code triggered this exit — don't navigate
        programmaticPipExitRef.current = false;
        return;
      }
      // User clicked "back to tab" or close on the PiP window — return to voice room
      if (voiceRoomIdRef.current) {
        selectRoomRef.current(voiceRoomIdRef.current);
      }
    };
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  // Auto-PiP: when navigating away from voice room while watching a screen share
  useEffect(() => {
    const video = pipVideoRef.current;
    if (!video) return;
    if (hasActiveScreenShare && !isOnVoiceRoom) {
      // Navigated away — pop into PiP
      if (!document.pictureInPictureElement && video.srcObject) {
        video.requestPictureInPicture().catch(() => {});
      }
    } else if (isOnVoiceRoom && document.pictureInPictureElement) {
      // Returned to voice room — exit PiP, inline viewer takes over
      programmaticPipExitRef.current = true;
      document.exitPictureInPicture().catch(() => { programmaticPipExitRef.current = false; });
    }
  }, [hasActiveScreenShare, isOnVoiceRoom]);

  // Close PiP when leaving voice or when screen share stops
  useEffect(() => {
    if (!hasActiveScreenShare && document.pictureInPictureElement) {
      programmaticPipExitRef.current = true;
      document.exitPictureInPicture().catch(() => { programmaticPipExitRef.current = false; });
    }
  }, [hasActiveScreenShare]);

  const togglePiP = useCallback(() => {
    const video = pipVideoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      programmaticPipExitRef.current = true;
      document.exitPictureInPicture().catch(() => { programmaticPipExitRef.current = false; });
    } else if (video.srcObject) {
      video.requestPictureInPicture().catch(() => {});
    }
  }, []);

  // Navigate back to the voice room and restore inline viewer
  const returnToStream = useCallback(() => {
    if (state.voiceRoomId) {
      selectRoom(state.voiceRoomId);
    }
  }, [state.voiceRoomId, selectRoom]);

  // Derive the sharer's display name and voice room name for the PiP banner
  const sharerName = state.selectedScreenSharer
    ? state.selectedScreenSharer === state.userId
      ? "Your screen"
      : (state.selectedScreenSharer.split(":")[0]?.replace("@", "") || state.selectedScreenSharer) + "'s screen"
    : "Screen share";
  const voiceRoomName = state.voiceRoomId
    ? state.roomInfoMap[state.voiceRoomId]?.name || "voice channel"
    : "voice channel";
  const showPipBanner = isPiP && hasActiveScreenShare && !isOnVoiceRoom;

  return (
    <>
      {/* Persistent hidden video for PiP — never unmounted by React */}
      <video
        ref={pipVideoRef}
        autoPlay
        playsInline
        muted
        style={{ position: "fixed", top: -9999, left: -9999, width: 1, height: 1 }}
      />

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

            {/* PiP active banner — shown when watching a screen share from another room */}
            {showPipBanner && (
              <div className="flex items-center justify-between px-3 py-1.5 bg-purple-500/10 border-b border-purple-500/20 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
                  </span>
                  <p className="text-xs text-purple-300 truncate">
                    Watching <span className="font-semibold">{sharerName}</span> in PiP
                  </p>
                </div>
                <button
                  onClick={returnToStream}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 hover:text-purple-200 transition-colors shrink-0 cursor-pointer"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                  Expand to {voiceRoomName}
                </button>
              </div>
            )}

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
