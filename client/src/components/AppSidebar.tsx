import { useEffect, useState, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetAllRooms, type RoomSummary } from "@/lib/api";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface AppSidebarProps {
  onCreateRoom: () => void;
  onJoinRoom: () => void;
}

export function AppSidebar({ onCreateRoom, onJoinRoom }: AppSidebarProps) {
  const { state, selectRoom, leaveRoom, logout } = useAppContext();
  const [roomSummaries, setRoomSummaries] = useState<
    Record<string, RoomSummary>
  >({});

  const displayName = state.userId?.split(":")[0]?.substring(1) || "User";
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

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-bold">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 overflow-hidden">
            <p className="truncate text-sm font-semibold">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {state.userId}
            </p>
          </div>
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

        <SidebarGroup>
          <SidebarGroupLabel>Rooms</SidebarGroupLabel>
          <SidebarGroupContent>
            <ScrollArea className="h-[calc(100vh-280px)]">
              {state.joinedRoomIds.length === 0 && (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  No rooms joined yet
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 px-2 pb-2">
                {state.joinedRoomIds.map((roomId) => {
                  const info = state.roomInfoMap[roomId];
                  const summary = roomSummaries[roomId];
                  const isActive = roomId === state.currentRoomId;
                  const hasMention = state.roomMentions[roomId] && !isActive;
                  const memberCount = summary?.member_count ?? 0;
                  const voiceCount = summary?.voice_count ?? 0;
                  const roomName = info?.name || "Unnamed";
                  const roomInitial = roomName.substring(0, 1).toUpperCase();

                  return (
                    <button
                      key={roomId}
                      onClick={() => selectRoom(roomId)}
                      className="group relative flex flex-col items-center justify-center gap-1.5 rounded-md border p-3 text-center transition-colors cursor-pointer"
                      style={{
                        minHeight: "5.5rem",
                        borderColor: isActive
                          ? "hsl(var(--sidebar-primary))"
                          : "hsl(var(--sidebar-border))",
                        background: isActive
                          ? "hsl(var(--sidebar-accent))"
                          : "transparent",
                      }}
                    >
                      {/* Mention ping */}
                      {hasMention && (
                        <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                      )}

                      {/* Room initial */}
                      <span
                        className="flex h-8 w-8 items-center justify-center rounded-md text-xs font-bold"
                        style={{
                          background: isActive
                            ? "hsl(var(--sidebar-primary))"
                            : "hsl(var(--sidebar-accent))",
                          color: isActive
                            ? "hsl(var(--sidebar-primary-foreground))"
                            : "hsl(var(--sidebar-foreground))",
                        }}
                      >
                        {roomInitial}
                      </span>

                      {/* Room name */}
                      <span className="w-full truncate text-[11px] font-medium leading-tight text-sidebar-foreground">
                        {roomName}
                      </span>

                      {/* Stats row */}
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
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
                      </div>

                      {/* Leave button on hover */}
                      <span
                        className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity text-[9px] text-destructive hover:text-destructive/80 cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm("Leave this room?")) {
                            leaveRoom(roomId);
                          }
                        }}
                      >
                        x
                      </span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs text-muted-foreground"
          onClick={logout}
        >
          Logout
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
