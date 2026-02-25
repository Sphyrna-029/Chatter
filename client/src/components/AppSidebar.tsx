import { useEffect, useState, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetAllRooms, type RoomSummary } from "@/lib/api";
import { VoiceSettingsDialog } from "@/components/VoiceSettingsDialog";
import { RoomSettingsDialog } from "@/components/RoomDialogs";
import { UserProfileDialog } from "@/components/UserProfileDialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

interface AppSidebarProps {
  onCreateRoom: () => void;
  onJoinRoom: () => void;
}

export function AppSidebar({ onCreateRoom, onJoinRoom }: AppSidebarProps) {
  const { state, dispatch, selectRoom, leaveRoom, logout } = useAppContext();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsRoomId, setSettingsRoomId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"rooms" | "dms">("rooms");
  const [roomSummaries, setRoomSummaries] = useState<
    Record<string, RoomSummary>
  >({});

  const displayName = (state.userId && state.userPresence[state.userId]?.displayName) || state.userId?.split(":")[0]?.substring(1) || "User";
  const initial = displayName.substring(0, 1).toUpperCase();

  const fetchSummaries = useCallback(async () => {
    try {
      const data = await apiGetAllRooms();
      const map: Record<string, RoomSummary> = {};
      for (const r of data.rooms) {
        map[r.room_id] = r;
      }
      setRoomSummaries(map);
    } catch {
      // silent
    }
  }, []);

  // Poll room summaries every 5s
  useEffect(() => {
    if (!state.accessToken) return;
    fetchSummaries();
    const id = setInterval(fetchSummaries, 5000);
    return () => clearInterval(id);
  }, [state.accessToken, fetchSummaries]);

  const regularRoomIds = state.joinedRoomIds.filter(
    (id) => !state.roomInfoMap[id]?.is_direct
  );
  const dmRoomIds = state.joinedRoomIds.filter(
    (id) => state.roomInfoMap[id]?.is_direct
  );

  function renderRoomCard(roomId: string, isDm: boolean) {
    const info = state.roomInfoMap[roomId];
    const summary = roomSummaries[roomId];
    const isActive = roomId === state.currentRoomId;
    const hasMention = !!state.roomMentions[roomId] && !isActive;
    const isForumRoom = info?.room_type === "forum";
    const isWhiteboardRoom = info?.room_type === "whiteboard";
    const memberCount = summary?.member_count ?? 0;
    const voiceCount = summary?.voice_count ?? 0;
    const screenShareActive = summary?.screen_share_active ?? false;

    let roomName: string;
    if (isDm && info?.name) {
      // Strip "DM with " prefix for cleaner display
      roomName = info.name.replace(/^DM with /, "");
    } else {
      roomName = info?.name || "Unnamed";
    }
    const roomInitial = roomName.substring(0, 1).toUpperCase();

    return (
      <button
        key={roomId}
        onClick={() => selectRoom(roomId)}
        className="group/card relative flex flex-col items-center justify-center gap-1.5 rounded-md border p-3 text-center transition-colors cursor-pointer"
        style={{
          minHeight: "5.5rem",
          borderColor: screenShareActive
            ? "hsl(var(--chart-4))"
            : isActive
              ? "hsl(270 60% 70%)"
              : "hsl(var(--sidebar-border))",
          background: isActive
            ? "hsl(var(--sidebar-accent))"
            : "transparent",
          boxShadow: screenShareActive
            ? undefined
            : isActive
              ? "0 0 12px 2px hsl(270 60% 60% / 0.45), 0 0 4px 1px hsl(270 60% 70% / 0.3)"
              : undefined,
          animation: screenShareActive ? "pulse-border 2s ease-in-out infinite" : undefined,
        }}
      >
        {/* Mention ping */}
        {hasMention && (
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
        )}

        {/* Room icon / initial */}
        {info?.icon_url ? (
          <img
            src={info.icon_url}
            alt=""
            className="h-10 w-10 rounded-md object-cover"
          />
        ) : (
          <span
            className="flex h-10 w-10 items-center justify-center rounded-md text-sm font-bold"
            style={{
              background: isActive
                ? "hsl(var(--sidebar-primary))"
                : "hsl(var(--sidebar-accent))",
              color: isActive
                ? "hsl(var(--sidebar-primary-foreground))"
                : "hsl(var(--sidebar-foreground))",
            }}
          >
            {isDm ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2.678 11.894a1 1 0 0 1 .287.801 10.97 10.97 0 0 1-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 0 1 .71-.074A8.06 8.06 0 0 0 8 14c3.996 0 7-2.807 7-6s-3.004-6-7-6-7 2.808-7 6c0 1.468.617 2.83 1.678 3.894z" />
              </svg>
            ) : (
              roomInitial
            )}
          </span>
        )}

        {/* Room name */}
        <span className="w-full truncate text-[11px] font-medium leading-tight text-sidebar-foreground flex items-center justify-center gap-1">
          {isForumRoom && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-muted-foreground">
              <path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4.414a1 1 0 0 0-.707.293L1.5 14.5A.5.5 0 0 1 .5 14V2zm3.5 1a.5.5 0 0 0 0 1h9a.5.5 0 0 0 0-1h-9zm0 2.5a.5.5 0 0 0 0 1h9a.5.5 0 0 0 0-1h-9zm0 2.5a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5z"/>
            </svg>
          )}
          {isWhiteboardRoom && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
              <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/>
              <circle cx="11" cy="11" r="2"/>
            </svg>
          )}
          <span className="truncate">{roomName}</span>
        </span>

        {/* Stats row */}
        {!isDm && (memberCount > 0 || voiceCount > 0 || screenShareActive) && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {memberCount > 0 && (
              <span className="flex items-center gap-0.5">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z" />
                </svg>
                {memberCount}
              </span>
            )}
            {voiceCount > 0 && (
              <span className="flex items-center gap-0.5 text-green-500">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M5 3a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0V3zm3-2a2 2 0 0 0-2 2v5a2 2 0 0 0 4 0V3a2 2 0 0 0-2-2z" />
                  <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z" />
                </svg>
                {voiceCount}
              </span>
            )}
            {screenShareActive && (
              <span className="flex items-center gap-0.5 text-purple-500">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 10.5v-7zM1.5 3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-13z" />
                  <path d="M2 14h12v1H2v-1z" />
                </svg>
              </span>
            )}
          </div>
        )}

        {/* Leave button on hover */}
        <span
          className="absolute top-1 left-1 opacity-0 group-hover/card:opacity-100 transition-opacity text-[9px] text-destructive hover:text-destructive/80 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm("Leave this room?")) {
              leaveRoom(roomId);
            }
          }}
        >
          x
        </span>

        {/* Settings gear for room creator (non-DM only) */}
        {!isDm && info?.creator === state.userId && (
          <span
            className="absolute top-1 right-1 opacity-0 group-hover/card:opacity-100 transition-opacity text-[9px] text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              setSettingsRoomId(roomId);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
              <path d="M8 5.754a2.246 2.246 0 1 0 0 4.492 2.246 2.246 0 0 0 0-4.492zM9.246 8a1.246 1.246 0 1 1-2.492 0 1.246 1.246 0 0 1 2.492 0z"/>
            </svg>
          </span>
        )}
      </button>
    );
  }

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <div
            className="flex flex-1 items-center gap-3 cursor-pointer rounded-md p-1 -m-1 hover:bg-accent/50 transition-colors min-w-0"
            onClick={() => setProfileOpen(true)}
          >
            <div className="relative shrink-0">
              <Avatar className="h-9 w-9">
                {state.userId && state.userPresence[state.userId]?.avatarUrl && (
                  <AvatarImage src={state.userPresence[state.userId].avatarUrl} />
                )}
                <AvatarFallback className="bg-primary text-primary-foreground text-sm font-bold">
                  {initial}
                </AvatarFallback>
              </Avatar>
              {(() => {
                const st = state.userId ? (state.userPresence[state.userId]?.status ?? "offline") : "offline";
                return (
                  <span className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background",
                    (st === "active" || st === "online") && "bg-green-500",
                    (st === "idle" || st === "away") && "bg-yellow-500",
                    st === "dnd" && "bg-red-500",
                    st === "offline" && "bg-muted-foreground",
                  )} />
                );
              })()}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {state.userId}
              </p>
            </div>
          </div>
          <SidebarTrigger
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            title="Collapse sidebar (Ctrl+B)"
          />
        </div>
      </SidebarHeader>

      <Separator />

      <SidebarContent>
        <SidebarGroup>
          <div className="flex gap-2 px-2 py-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              onClick={onCreateRoom}
            >
              + Create
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              onClick={onJoinRoom}
            >
              Join
            </Button>
          </div>
        </SidebarGroup>

        <Separator />

        <SidebarGroup className="flex-1 min-h-0">
          <div className="px-2 py-2">
            <ToggleGroup
              type="single"
              value={activeTab}
              onValueChange={(val) => { if (val) setActiveTab(val as "rooms" | "dms"); }}
              className="w-full rounded-md border border-border p-0.5 bg-muted"
            >
              <ToggleGroupItem
                value="dms"
                className="flex-1 text-xs h-7 data-[state=on]:bg-background data-[state=on]:shadow-sm rounded-sm"
              >
                DMs
              </ToggleGroupItem>
              <ToggleGroupItem
                value="rooms"
                className="flex-1 text-xs h-7 data-[state=on]:bg-background data-[state=on]:shadow-sm rounded-sm"
              >
                Rooms
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <SidebarGroupContent className="flex-1 min-h-0">
            <ScrollArea className="h-[calc(100vh-280px)]">
              {activeTab === "rooms" ? (
                <>
                  {regularRoomIds.length === 0 && (
                    <p className="px-3 py-3 text-xs text-muted-foreground">
                      No rooms joined yet
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2 px-2 pb-2">
                    {regularRoomIds.map((roomId) => renderRoomCard(roomId, false))}
                  </div>
                </>
              ) : (
                <>
                  {dmRoomIds.length === 0 && (
                    <p className="px-3 py-3 text-xs text-muted-foreground">
                      No direct messages yet
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2 px-2 pb-2">
                    {dmRoomIds.map((roomId) => renderRoomCard(roomId, true))}
                  </div>
                </>
              )}
            </ScrollArea>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        {state.isAdmin && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-muted-foreground justify-start gap-2"
            onClick={() => dispatch({ type: "SET_ADMIN_DASHBOARD_OPEN", payload: true })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Server Dashboard
          </Button>
        )}
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-xs text-muted-foreground"
            onClick={logout}
          >
            Logout
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-muted-foreground"
            onClick={() => setSettingsOpen(true)}
            title="Voice & Audio Settings"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
              <path d="M8 5.754a2.246 2.246 0 1 0 0 4.492 2.246 2.246 0 0 0 0-4.492zM9.246 8a1.246 1.246 0 1 1-2.492 0 1.246 1.246 0 0 1 2.492 0z"/>
            </svg>
          </Button>
        </div>
        <VoiceSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        {state.userId && (
          <UserProfileDialog
            open={profileOpen}
            onOpenChange={setProfileOpen}
            userId={state.userId}
            displayName={displayName}
          />
        )}
        {settingsRoomId && (
          <RoomSettingsDialog
            open={!!settingsRoomId}
            onOpenChange={(open) => { if (!open) setSettingsRoomId(null); }}
            roomId={settingsRoomId}
          />
        )}
      </SidebarFooter>

      <style>{`
        @keyframes pulse-border {
          0%, 100% { box-shadow: 0 0 0 0 hsl(var(--chart-4) / 0.4); }
          50% { box-shadow: 0 0 8px 2px hsl(var(--chart-4) / 0.6); }
        }
      `}</style>
    </Sidebar>
  );
}
