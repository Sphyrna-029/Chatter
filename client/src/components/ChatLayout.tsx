import { useState, useEffect, useRef, useCallback } from "react";
import { WifiOff, ChevronRight } from "lucide-react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { AdminDashboard } from "./AdminDashboard";
import { AppSidebar } from "./AppSidebar";
import { ChatArea } from "./ChatArea";
import { ForumArea } from "./ForumArea";
import { WhiteboardArea } from "./WhiteboardArea";
import { ActivityPage } from "./ActivityPage";
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

// ─── PiP helpers (bulletproof against Firefox / Safari quirks) ──────────────
function pipEnabled(): boolean {
  try { return !!document.pictureInPictureEnabled; } catch { return false; }
}
function pipActive(): boolean {
  try { return !!document.pictureInPictureElement; } catch { return false; }
}
function pipRequest(video: HTMLVideoElement): Promise<void> {
  try {
    return video.requestPictureInPicture().then(() => {});
  } catch { return Promise.reject(); }
}
function pipExit(): Promise<void> {
  try {
    if (!pipActive()) return Promise.resolve();
    return document.exitPictureInPicture();
  } catch { return Promise.reject(); }
}

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
  const { state, loadRooms, loadFriends, selectRoom } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const joinVoiceRef = useRef<(() => void) | null>(null);
  const [isPiP, setIsPiP] = useState(false);
  // True when we want PiP but auto-enter failed (Firefox requires user gesture)
  const [pipWanted, setPipWanted] = useState(false);
  // Flag to distinguish our code exiting PiP vs the user clicking "back to tab" / close
  const programmaticPipExitRef = useRef(false);

  // Load rooms and friends on mount
  useEffect(() => {
    loadRooms();
    loadFriends();
  }, [loadRooms, loadFriends]);

  const isForumRoom = state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]?.room_type === "forum"
    : false;
  const isWhiteboardRoom = state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]?.room_type === "whiteboard"
    : false;
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

  // Helper: safely exit PiP with the programmatic flag
  const safeExitPiP = useCallback(() => {
    if (!pipActive()) return;
    programmaticPipExitRef.current = true;
    pipExit().catch(() => { programmaticPipExitRef.current = false; });
  }, []);

  // Auto-PiP: when navigating away from voice room while watching a screen share
  useEffect(() => {
    if (!pipEnabled()) {
      // Browser doesn't support PiP at all — just show the banner
      if (hasActiveScreenShare && !isOnVoiceRoom) setPipWanted(true);
      else setPipWanted(false);
      return;
    }
    const video = pipVideoRef.current;
    if (!video) return;
    if (hasActiveScreenShare && !isOnVoiceRoom) {
      // Navigated away — try to pop into PiP automatically
      if (!pipActive() && video.srcObject) {
        pipRequest(video)
          .then(() => setPipWanted(false))
          .catch(() => {
            // Firefox (and others) require a user gesture — show manual banner instead
            setPipWanted(true);
          });
      }
    } else if (isOnVoiceRoom) {
      // Returned to voice room — exit PiP if active, clear wanted flag
      setPipWanted(false);
      safeExitPiP();
    }
  }, [hasActiveScreenShare, isOnVoiceRoom, safeExitPiP]);

  // Close PiP when leaving voice or when screen share stops
  useEffect(() => {
    if (!hasActiveScreenShare) {
      setPipWanted(false);
      safeExitPiP();
    }
  }, [hasActiveScreenShare, safeExitPiP]);

  const togglePiP = useCallback(() => {
    const video = pipVideoRef.current;
    if (!video) return;
    if (pipActive()) {
      safeExitPiP();
    } else if (video.srcObject) {
      pipRequest(video)
        .then(() => setPipWanted(false))
        .catch(() => {});
    }
  }, [safeExitPiP]);

  // Manually enter PiP from a user click (provides the gesture Firefox needs)
  const manualEnterPiP = useCallback(() => {
    const video = pipVideoRef.current;
    if (!video || !video.srcObject) return;
    pipRequest(video)
      .then(() => setPipWanted(false))
      .catch(() => {});
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
  const showPipBanner = hasActiveScreenShare && !isOnVoiceRoom && (isPiP || pipWanted);

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

            {/* PiP active banner — shown when watching a screen share from another room */}
            {showPipBanner && (
              <div className="flex items-center justify-between px-3 py-1.5 bg-purple-500/10 border-b border-purple-500/20 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
                  </span>
                  <p className="text-xs text-purple-300 truncate">
                    {isPiP
                      ? <>Watching <span className="font-semibold">{sharerName}</span> in PiP</>
                      : <>Screen share from <span className="font-semibold">{sharerName}</span> is active</>
                    }
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Firefox fallback: manual PiP button (provides user gesture) */}
                  {pipWanted && !isPiP && (
                    <button
                      onClick={manualEnterPiP}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 hover:text-purple-200 transition-colors cursor-pointer"
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
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <rect x="12" y="9" width="8" height="6" rx="1" />
                      </svg>
                      Pop out
                    </button>
                  )}
                  <button
                    onClick={returnToStream}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 hover:text-purple-200 transition-colors cursor-pointer"
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
              </div>
            )}

            {/* Main content: admin dashboard, activity page, or voice column + chat/forum + members */}
            {state.adminDashboardOpen ? (
              <AdminDashboard />
            ) : !state.currentRoomId ? (
              <ActivityPage />
            ) : (
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              {!isForumRoom && !isWhiteboardRoom && <VoiceControls joinVoiceRef={joinVoiceRef} />}
              {isWhiteboardRoom ? (
                <WhiteboardArea />
              ) : isForumRoom ? (
                <ForumArea />
              ) : showViewer ? (
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
                        <ChatArea onJoinVoice={() => joinVoiceRef.current?.()} />
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              ) : (
                <ChatArea onJoinVoice={() => joinVoiceRef.current?.()} />
              )}
              <MembersPanel
                collapsed={membersCollapsed}
                onToggle={() => setMembersCollapsed((v) => !v)}
              />
            </div>
            )}
          </SidebarInset>
        </div>
      </SidebarProvider>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <Toaster />
    </>
  );
}
