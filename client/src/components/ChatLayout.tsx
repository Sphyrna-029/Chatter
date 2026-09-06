import { useState, useEffect, useRef, useCallback } from "react";
import { WifiOff, ChevronRight, Menu, Users, Hash, Mic, MicOff, Headphones, HeadphoneOff, MonitorUp, PhoneOff, Camera } from "lucide-react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { AdminDashboard } from "./AdminDashboard";
import { AppSidebar } from "./AppSidebar";
import { ChatArea } from "./ChatArea";
import { ForumArea } from "./ForumArea";
import { ShowcaseArea } from "./ShowcaseArea";
import { WatchPartyArea } from "./WatchPartyArea";
import { WhiteboardArea } from "./WhiteboardArea";
import { ActivityPage } from "./ActivityPage";
import { MembersPanel } from "./MembersPanel";
import { ThreadPanel } from "./ThreadPanel";
import { ChannelList } from "./ChannelList";
import { VoiceControls, type ConnQualityData } from "./VoiceControls";
import { ScreenShareViewer, ScreenShareHeader } from "./ScreenShareViewer";
import { CreateRoomDialog, JoinRoomDialog } from "./RoomDialogs";
import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { displayUserId } from "@/lib/utils";
import { syncPushSubscription } from "@/lib/push";

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

/** Mobile top bar with sidebar toggle + room name + members */
function MobileHeader({
  roomName,
  channelName,
  onChannelsToggle,
  showChannels,
  onMembersToggle,
  showMembers,
}: {
  roomName: string;
  channelName?: string;
  onChannelsToggle: () => void;
  showChannels: boolean;
  onMembersToggle: () => void;
  showMembers: boolean;
}) {
  const { toggleSidebar } = useSidebar();
  return (
    <div className="flex items-center gap-1 border-b px-2 py-1.5 shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10">
      <button
        onClick={toggleSidebar}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors active:bg-accent"
        title="Open sidebar"
      >
        <Menu className="h-6 w-6" />
      </button>
      {showChannels && (
        <button
          onClick={onChannelsToggle}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors active:bg-accent"
          title="Show channels"
        >
          <Hash className="h-5 w-5" />
        </button>
      )}
      {/* Room above channel: the channel column is a drawer on mobile, so this
          is the only place the current channel is named. */}
      <div className="flex-1 min-w-0 px-1 leading-tight">
        <h1 className="truncate text-sm font-semibold">{roomName}</h1>
        {channelName && (
          <p className="truncate ui-meta">#{channelName}</p>
        )}
      </div>
      {showMembers && (
        <button
          onClick={onMembersToggle}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors active:bg-accent"
          title="Show members"
        >
          <Users className="h-6 w-6" />
        </button>
      )}
    </div>
  );
}

export function ChatLayout() {
  const { state, dispatch, loadRooms, loadFriends, loadRoomGroups, loadUnreads, loadNotificationSettings, loadContinuity, selectRoom, selectChannel, openThread, closeThread } = useAppContext();
  const isMobile = useIsMobile();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [membersCollapsed, setMembersCollapsed] = useState(false);
  // Sidebar + channels + members + a 22rem companion panel leaves the timeline
  // around 300px on a 1366px laptop. Below this width the members list folds to
  // its collapsed strip while a panel is open; the user can still reopen it.
  const roomForBothPanels = useMediaQuery("(min-width: 1280px)");
  // Which mobile drawer is open, and the room it was opened for — a room switch
  // then closes it by derivation rather than by an effect.
  const [mobileDrawer, setMobileDrawer] = useState<{ kind: "channels" | "members"; roomId: string | null } | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const joinVoiceRef = useRef<((channelId?: string) => void) | null>(null);
  const leaveVoiceRef = useRef<(() => void) | null>(null);
  const toggleMuteRef = useRef<(() => void) | null>(null);
  const toggleDeafenRef = useRef<(() => void) | null>(null);
  const startScreenShareRef = useRef<(() => void) | null>(null);
  const connQualityRef = useRef<ConnQualityData>({ quality: 0, pingMs: null, status: "closed" });
  const stopScreenShareRef = useRef<(() => void) | null>(null);
  const startWebcamRef = useRef<(() => void) | null>(null);
  const stopWebcamRef = useRef<(() => void) | null>(null);
  const setUserVolumeRef = useRef<((userId: string, vol: number) => void) | null>(null);
  const speakingUsersRef = useRef<Set<string>>(new Set());
  const [isPiP, setIsPiP] = useState(false);
  // True when we want PiP but auto-enter failed (Firefox requires user gesture)
  const [pipWanted, setPipWanted] = useState(false);
  // Flag to distinguish our code exiting PiP vs the user clicking "back to tab" / close
  const programmaticPipExitRef = useRef(false);

  // Load rooms, friends, room groups and unread counts on mount
  useEffect(() => {
    loadRooms();
    loadFriends();
    loadRoomGroups();
    loadUnreads();
    loadNotificationSettings();
    loadContinuity();
  }, [loadRooms, loadFriends, loadRoomGroups, loadUnreads, loadNotificationSettings, loadContinuity]);

  // Refetch what should follow the user between devices when this tab comes
  // back to the foreground: a draft written on a phone should be here when
  // they turn back to the desktop, without needing a reload. Only an empty
  // composer is hydrated, so this can never overwrite what is being typed.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadContinuity();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadContinuity]);

  // Clicking a desktop notification should land on the message it was about.
  // The WS handler cannot navigate on its own, so it raises this event.
  useEffect(() => {
    const handler = async (e: Event) => {
      const { roomId, channelId, threadId } = (e as CustomEvent).detail ?? {};
      if (!roomId) return;
      if (roomId !== state.currentRoomId) await selectRoom(roomId);
      if (channelId) await selectChannel(channelId);
      // A thread notification should land in the thread, not merely the
      // channel it hangs in.
      if (threadId) await openThread(threadId);
    };
    // The same destination arrives two ways: from the in-page notification as
    // a window event, and from a push notification as a service worker
    // message. Both land here so there is one navigation path.
    const fromServiceWorker = (e: MessageEvent) => {
      if (e.data?.type !== "notification-navigate") return;
      void handler(new CustomEvent("notification-navigate", { detail: e.data }));
    };
    window.addEventListener("notification-navigate", handler);
    navigator.serviceWorker?.addEventListener("message", fromServiceWorker);
    return () => {
      window.removeEventListener("notification-navigate", handler);
      navigator.serviceWorker?.removeEventListener("message", fromServiceWorker);
    };
  }, [selectRoom, selectChannel, openThread, state.currentRoomId]);

  // A push notification clicked with no window open reopens the app with the
  // destination in the URL. Consume it once, then strip it so a refresh does
  // not bounce the user back here.
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (Object.keys(state.roomInfoMap).length === 0) return;
    deepLinkHandledRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room");
    const channelId = params.get("channel");
    if (!roomId) return;

    window.history.replaceState({}, "", window.location.pathname);
    void (async () => {
      await selectRoom(roomId);
      if (channelId) await selectChannel(channelId);
    })();
  }, [state.roomInfoMap, selectRoom, selectChannel]);

  // Repair this browser's push subscription if it was enrolled and the
  // endpoint has since rotated or been dropped.
  useEffect(() => {
    void syncPushSubscription();
  }, []);

  // Auto-rejoin voice channel on page refresh (within 30 seconds)
  const autoRejoinAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoRejoinAttemptedRef.current) return;
    if (!state.wsConnected) return;
    // Wait until rooms are loaded so selectRoom works
    if (Object.keys(state.roomInfoMap).length === 0) return;
    autoRejoinAttemptedRef.current = true;

    try {
      const raw = sessionStorage.getItem("voiceSession");
      if (!raw) return;
      const session = JSON.parse(raw) as { roomId: string; channelId: string | null; timestamp: number };
      if (Date.now() - session.timestamp > 30_000) {
        sessionStorage.removeItem("voiceSession");
        return;
      }
      // Clear so we don't retry on subsequent renders
      sessionStorage.removeItem("voiceSession");

      // Navigate to the room then join voice after a short delay for state to settle
      selectRoom(session.roomId);
      setTimeout(() => {
        const ch = state.channels.find((c) => c.channel_id === session.channelId);
        if (ch) dispatch({ type: "SET_VOICE_STATE", payload: { voiceChannelName: ch.name } });
        joinVoiceRef.current?.(session.channelId ?? undefined);
      }, 500);
    } catch {
      sessionStorage.removeItem("voiceSession");
    }
  }, [state.wsConnected, state.roomInfoMap, state.channels, selectRoom, dispatch]);

  const isDmRoom = state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]?.is_direct === true
    : false;
  const hasChannels = !isDmRoom && state.channels.length > 0;
  const currentChannel = state.currentChannelId
    ? state.channels.find((c) => c.channel_id === state.currentChannelId)
    : null;
  const currentChannelType = currentChannel?.channel_type;
  const isForumRoom = (state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]?.room_type === "forum"
    : false) || currentChannelType === "forum";
  const isWhiteboardRoom = (state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]?.room_type === "whiteboard"
    : false) || currentChannelType === "whiteboard";
  const isWatchPartyRoom = (state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]?.room_type === "watchparty"
    : false) || currentChannelType === "theater";
  const isShowcaseChannel = currentChannelType === "showcase";
  const isOnVoiceRoom = state.voiceRoomId != null && state.currentRoomId === state.voiceRoomId;
  const hasActiveScreenShare =
    state.screenViewerOpen &&
    state.inVoiceChannel &&
    (state.activeScreenSharers.length > 0 || state.activeWebcamStreamers.length > 0);
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
      : (state.userPresence[state.selectedScreenSharer]?.displayName || displayUserId(state.selectedScreenSharer)) + "'s screen"
    : "Screen share";
  const voiceRoomName = state.voiceRoomId
    ? state.roomInfoMap[state.voiceRoomId]?.name || "voice channel"
    : "voice channel";
  const showPipBanner = hasActiveScreenShare && !isOnVoiceRoom && (isPiP || pipWanted);

  // On a phone the channel column would eat most of the viewport, so it moves
  // into a drawer and the chat gets the full width.
  const showChannelColumn = hasChannels;

  const renderChannelList = (asDrawer: boolean) => (
    <ChannelList
      asDrawer={asDrawer}
      onChannelSelected={asDrawer ? () => setMobileDrawer(null) : undefined}
      onJoinVoiceChannel={(channelId) => {
        const ch = state.channels.find((c) => c.channel_id === channelId);
        if (ch) dispatch({ type: "SET_VOICE_STATE", payload: { voiceChannelName: ch.name } });
        joinVoiceRef.current?.(channelId);
      }}
      onLeaveVoice={() => leaveVoiceRef.current?.()}
      onToggleMute={() => toggleMuteRef.current?.()}
      onToggleDeafen={() => toggleDeafenRef.current?.()}
      onToggleScreenShare={() => {
        if (state.isScreenSharing) {
          stopScreenShareRef.current?.();
        } else {
          startScreenShareRef.current?.();
        }
      }}
      isScreenSharing={state.isScreenSharing}
      onToggleWebcam={() => {
        if (state.isWebcamActive) stopWebcamRef.current?.();
        else startWebcamRef.current?.();
      }}
      isWebcamActive={state.isWebcamActive}
      connQualityRef={connQualityRef}
      setUserVolumeRef={setUserVolumeRef}
      speakingUsersRef={speakingUsersRef}
    />
  );

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
        <div className={`flex h-dvh w-full bg-muted ${isMobile ? "" : "gap-2 p-2"}`}>
          <AppSidebar
            onCreateRoom={() => setCreateOpen(true)}
            onJoinRoom={() => setJoinOpen(true)}
          />

          <SidebarInset className={`flex flex-1 flex-col min-w-0 overflow-hidden ${isMobile ? "" : "rounded-lg border border-border"}`}>
            {/* Floating restore button — only visible when left sidebar is collapsed (desktop only) */}
            {!isMobile && <LeftPanelRestoreButton />}

            {/* Mobile top bar */}
            {isMobile && (
              <MobileHeader
                roomName={
                  state.currentRoomId
                    ? state.roomInfoMap[state.currentRoomId]?.name || "Unnamed"
                    : state.adminDashboardOpen
                    ? "Admin Dashboard"
                    : "Activity"
                }
                channelName={
                  state.currentChannelId
                    ? state.channels.find((c) => c.channel_id === state.currentChannelId)?.name
                    : undefined
                }
                onChannelsToggle={() => setMobileDrawer({ kind: "channels", roomId: state.currentRoomId })}
                showChannels={showChannelColumn}
                onMembersToggle={() => setMobileDrawer({ kind: "members", roomId: state.currentRoomId })}
                showMembers={!!state.currentRoomId && !state.adminDashboardOpen}
              />
            )}

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
            {/* VoiceControls is always mounted here (sr-only when not visible) so WebRTC/stats stay alive across page navigations */}
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              <div className={!state.currentRoomId || state.adminDashboardOpen || isDmRoom || hasChannels || isWatchPartyRoom || isForumRoom || isWhiteboardRoom || isShowcaseChannel ? "sr-only" : "shrink-0"}>
                <VoiceControls
                  joinVoiceRef={joinVoiceRef}
                  leaveVoiceRef={leaveVoiceRef}
                  toggleMuteRef={toggleMuteRef}
                  toggleDeafenRef={toggleDeafenRef}
                  startScreenShareRef={startScreenShareRef}
                  stopScreenShareRef={stopScreenShareRef}
                  startWebcamRef={startWebcamRef}
                  stopWebcamRef={stopWebcamRef}
                  connQualityRef={connQualityRef}
                  setUserVolumeRef={setUserVolumeRef}
                  speakingUsersRef={speakingUsersRef}
                />
              </div>
              {state.adminDashboardOpen ? (
                <AdminDashboard />
              ) : !state.currentRoomId ? (
                <ActivityPage />
              ) : (
              <>
                {showChannelColumn && !isMobile && renderChannelList(false)}
                {isWatchPartyRoom ? (
                  <WatchPartyArea onJoinVoice={() => joinVoiceRef.current?.()} />
                ) : isShowcaseChannel ? (
                  <ShowcaseArea />
                ) : isWhiteboardRoom ? (
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
                          {state.activeThreadEventId ? (
                            <ThreadPanel />
                          ) : (
                            <ChatArea onJoinVoice={() => joinVoiceRef.current?.()} />
                          )}
                        </div>
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </div>
                ) : state.activeThreadEventId ? (
                  <ThreadPanel />
                ) : (
                  <ChatArea onJoinVoice={() => joinVoiceRef.current?.()} />
                )}
                {!isMobile && (
                  <MembersPanel
                    collapsed={
                      membersCollapsed || (!!state.companionPanel && !roomForBothPanels)
                    }
                    onToggle={() => setMembersCollapsed((v) => !v)}
                  />
                )}
              </>
              )}
            </div>
            {/* Voice bar: shown when in voice while viewing a different room, and
                always on mobile — the channel column's voice controls live in a
                drawer there, so this is the only reachable mute/hang-up. */}
            {state.inVoiceChannel && (!isOnVoiceRoom || isMobile) && (
              <VoiceBar
                channelName={state.voiceChannelName || "Voice"}
                roomName={voiceRoomName}
                occupiedSince={state.voiceChannelId ? state.voiceChannelOccupiedSince[state.voiceChannelId] : undefined}
                isMuted={state.isMuted}
                isDeafened={state.isDeafened}
                isScreenSharing={state.isScreenSharing}
                isWebcamActive={state.isWebcamActive}
                onNavigate={() => { if (state.voiceRoomId) selectRoom(state.voiceRoomId); }}
                onToggleMute={() => toggleMuteRef.current?.()}
                onToggleDeafen={() => toggleDeafenRef.current?.()}
                onToggleScreenShare={() => {
                  if (state.isScreenSharing) stopScreenShareRef.current?.();
                  else startScreenShareRef.current?.();
                }}
                onToggleWebcam={() => {
                  if (state.isWebcamActive) stopWebcamRef.current?.();
                  else startWebcamRef.current?.();
                }}
                onHangUp={() => leaveVoiceRef.current?.()}
              />
            )}
          </SidebarInset>
        </div>
      </SidebarProvider>

      {/* Mobile channels drawer */}
      {isMobile && (
        <Sheet
          open={
            mobileDrawer?.kind === "channels" &&
            mobileDrawer.roomId === state.currentRoomId &&
            showChannelColumn
          }
          onOpenChange={(open) => !open && setMobileDrawer(null)}
        >
          <SheetContent side="left" className="w-72 p-0 flex flex-col overflow-hidden">
            <SheetHeader className="sr-only">
              <SheetTitle>Channels</SheetTitle>
              <SheetDescription>Channels in this room</SheetDescription>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-hidden">
              {showChannelColumn && renderChannelList(true)}
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Mobile members drawer */}
      {isMobile && (
        <Sheet
          open={
            mobileDrawer?.kind === "members" &&
            mobileDrawer.roomId === state.currentRoomId
          }
          onOpenChange={(open) => !open && setMobileDrawer(null)}
        >
          <SheetContent side="right" className="w-72 p-0 flex flex-col overflow-hidden">
            <SheetHeader className="sr-only">
              <SheetTitle>Members</SheetTitle>
              <SheetDescription>Room members list</SheetDescription>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-hidden">
              <MembersPanel collapsed={false} onToggle={() => setMobileDrawer(null)} />
            </div>
          </SheetContent>
        </Sheet>
      )}

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />


      <Toaster />
    </>
  );
}

/* ── Floating voice bar ──────────────────────────────────────────────────── */

function VoiceBarTimer({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - since);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - since), 1000);
    return () => clearInterval(id);
  }, [since]);
  const totalSecs = Math.max(0, Math.floor(elapsed / 1000));
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const str = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
  return <span className="text-success text-xs font-mono">{str}</span>;
}

interface VoiceBarProps {
  channelName: string;
  roomName: string;
  occupiedSince?: number;
  isMuted: boolean;
  isDeafened: boolean;
  isScreenSharing: boolean;
  isWebcamActive: boolean;
  onNavigate: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onToggleWebcam: () => void;
  onHangUp: () => void;
}

function VoiceBar({
  channelName, roomName, occupiedSince,
  isMuted, isDeafened, isScreenSharing, isWebcamActive,
  onNavigate, onToggleMute, onToggleDeafen, onToggleScreenShare, onToggleWebcam, onHangUp,
}: VoiceBarProps) {
  return (
    <div className="flex items-center gap-3 shrink-0 bg-card border-t border-border px-4 py-2">
      {/* Channel name link + timer */}
      <button
        onClick={onNavigate}
        className="flex items-center gap-2 min-w-0 hover:underline text-success font-medium text-sm truncate"
      >
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="23" />
          <line x1="8" x2="16" y1="23" y2="23" />
        </svg>
        <span className="truncate">{channelName}</span>
        <span className="text-muted-foreground text-xs truncate">in {roomName}</span>
      </button>

      {occupiedSince && <VoiceBarTimer since={occupiedSince} />}

      <div className="flex-1" />

      {/* Controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleMute}
          className={`p-1.5 rounded-md transition-colors ${isMuted || isDeafened ? "text-destructive bg-destructive/10 hover:bg-destructive/20" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
          title={isDeafened ? "Undeafen to unmute" : isMuted ? "Unmute" : "Mute"}
        >
          {isMuted || isDeafened ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>
        <button
          onClick={onToggleDeafen}
          className={`p-1.5 rounded-md transition-colors ${isDeafened ? "text-destructive bg-destructive/10 hover:bg-destructive/20" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
          title={isDeafened ? "Undeafen" : "Deafen"}
        >
          {isDeafened ? <HeadphoneOff className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
        </button>
        <button
          onClick={onToggleWebcam}
          className={`p-1.5 rounded-md transition-colors ${isWebcamActive ? "text-success bg-success/10 hover:bg-success/20" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
          title={isWebcamActive ? "Stop camera" : "Share camera"}
        >
          <Camera className="w-4 h-4" />
        </button>
        <button
          onClick={onToggleScreenShare}
          className={`p-1.5 rounded-md transition-colors ${isScreenSharing ? "text-success bg-success/10 hover:bg-success/20" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
          title={isScreenSharing ? "Stop sharing" : "Share screen"}
        >
          <MonitorUp className="w-4 h-4" />
        </button>
        <button
          onClick={onHangUp}
          className="p-1.5 rounded-md text-destructive bg-destructive/10 hover:bg-destructive/20 transition-colors"
          title="Leave voice"
        >
          <PhoneOff className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
