import { useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiSync, apiGetAllRooms, type RoomSummary } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { UserProfileDialog } from "./UserProfileDialog";
import { displayUserId } from "@/lib/utils";
import { AuthImage, AuthAvatarImage } from "@/components/AuthImage";
import { AtSign, Users, MessageSquare, Clock, UserPlus, UserCheck, Ban, ChevronDown } from "lucide-react";

interface RoomActivity {
  roomId: string;
  lastMessage?: { sender: string; body: string; timestamp: number };
  memberCount: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusColor(status: string) {
  if (status === "active" || status === "online") return "bg-green-500";
  if (status === "idle" || status === "away") return "bg-yellow-500";
  if (status === "dnd") return "bg-red-500";
  return "bg-muted-foreground";
}

export function ActivityPage() {
  const { state, selectRoom, openDM, acceptFriendRequest, rejectFriendRequest, removeFriend, unblockUser } = useAppContext();
  const [activities, setActivities] = useState<RoomActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [blockedExpanded, setBlockedExpanded] = useState(false);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchActivity() {
      try {
        const [syncData, summaryData] = await Promise.all([
          apiSync(),
          apiGetAllRooms(),
        ]);

        const summaryMap: Record<string, RoomSummary> = {};
        for (const r of summaryData.rooms) {
          summaryMap[r.room_id] = r;
        }

        const roomJoin = syncData.rooms?.join ?? {};
        const result: RoomActivity[] = [];

        for (const roomId of state.joinedRoomIds) {
          const roomData = roomJoin[roomId];
          const summary = summaryMap[roomId];

          let lastMessage: RoomActivity["lastMessage"];
          if (roomData?.timeline?.events) {
            const msgs = roomData.timeline.events
              .filter((e: any) => e.type === "m.room.message" && e.content?.body)
              .sort((a: any, b: any) => (b.origin_server_ts ?? 0) - (a.origin_server_ts ?? 0));
            if (msgs.length > 0) {
              lastMessage = {
                sender: msgs[0].sender,
                body: msgs[0].content.body,
                timestamp: msgs[0].origin_server_ts,
              };
            }
          }

          result.push({
            roomId,
            lastMessage,
            memberCount: summary?.member_count ?? 0,
          });
        }

        // Sort by most recent activity
        result.sort((a, b) => {
          const ta = a.lastMessage?.timestamp ?? 0;
          const tb = b.lastMessage?.timestamp ?? 0;
          return tb - ta;
        });

        if (!cancelled) {
          setActivities(result);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    fetchActivity();
    return () => { cancelled = true; };
  }, [state.joinedRoomIds]);

  const mentionedRooms = Object.entries(state.roomMentions).filter(
    ([, count]) => count > 0
  );

  // Sort friends: online first
  const sortedFriends = [...state.friends].sort((a, b) => {
    const sa = state.userPresence[a]?.status || "offline";
    const sb = state.userPresence[b]?.status || "offline";
    const isOnlineA = sa === "active" || sa === "online" ? 0 : sa === "idle" || sa === "away" ? 1 : sa === "dnd" ? 2 : 3;
    const isOnlineB = sb === "active" || sb === "online" ? 0 : sb === "idle" || sb === "away" ? 1 : sb === "dnd" ? 2 : 3;
    return isOnlineA - isOnlineB;
  });

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto max-w-5xl px-4 md:px-6 py-6 md:py-8 space-y-6 md:space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your rooms and recent conversations
          </p>
        </div>

        {/* Unread Mentions — full width above the two-column layout */}
        {mentionedRooms.length > 0 && (
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              <AtSign className="h-4 w-4" />
              Unread Mentions
            </h2>
            <div className="grid gap-2">
              {mentionedRooms.map(([roomId, count]) => {
                const info = state.roomInfoMap[roomId];
                return (
                  <button
                    key={roomId}
                    onClick={() => selectRoom(roomId)}
                    className="flex items-center justify-between rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-left transition-colors hover:bg-blue-500/10 cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/20 text-blue-400 text-sm font-bold shrink-0">
                        {info?.name?.charAt(0).toUpperCase() || "?"}
                      </span>
                      <span className="font-medium truncate">
                        {info?.name || roomId}
                      </span>
                    </div>
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-[11px] font-bold text-white shrink-0">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Two-column layout: Rooms left, Friends right */}
        <div className="flex flex-col md:flex-row gap-6 md:gap-8 items-start">
          {/* Left column — Your Rooms */}
          <div className="flex-1 min-w-0 overflow-hidden space-y-3">
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                <MessageSquare className="h-4 w-4" />
                Your Rooms
              </h2>

              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4 animate-spin mr-2" />
                  Loading activity…
                </div>
              ) : activities.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">
                  No rooms joined yet. Create or join a room to get started.
                </p>
              ) : (
                <div className="grid gap-2">
                  {activities.map(({ roomId, lastMessage, memberCount }) => {
                    const info = state.roomInfoMap[roomId];
                    const name = info?.name || "Unnamed";
                    const hasMention = !!state.roomMentions[roomId];

                    return (
                      <button
                        key={roomId}
                        onClick={() => selectRoom(roomId)}
                        className="flex items-start gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/50 cursor-pointer w-full overflow-hidden"
                      >
                        {/* Room icon */}
                        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-sm font-bold shrink-0 mt-0.5">
                          {info?.icon_url ? (
                            <AuthImage src={info.icon_url} alt="" className="h-9 w-9 rounded-md object-cover" />
                          ) : (
                            name.charAt(0).toUpperCase()
                          )}
                        </span>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{name}</span>
                            {hasMention && (
                              <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                            )}
                            {info?.room_type === "forum" && (
                              <span className="text-[10px] text-muted-foreground border border-border rounded px-1">forum</span>
                            )}
                            {info?.room_type === "whiteboard" && (
                              <span className="text-[10px] text-muted-foreground border border-border rounded px-1">whiteboard</span>
                            )}
                          </div>

                          {lastMessage ? (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              <span className="font-medium">{displayUserId(lastMessage.sender)}</span>
                              {": "}
                              {lastMessage.body}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground mt-0.5 italic">
                              No messages yet
                            </p>
                          )}
                        </div>

                        {/* Meta */}
                        <div className="flex flex-col items-end gap-1 shrink-0 text-xs text-muted-foreground">
                          {lastMessage && (
                            <span>{relativeTime(lastMessage.timestamp)}</span>
                          )}
                          {memberCount > 0 && (
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {memberCount}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          {/* Right column — Friends */}
          <div className="w-full md:w-64 md:shrink-0 space-y-6">
            {/* Friend Requests */}
            {state.incomingFriendRequests.length > 0 && (
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  <UserPlus className="h-4 w-4" />
                  Requests
                </h2>
                <div className="grid gap-2">
                  {state.incomingFriendRequests.map((req) => (
                    <div
                      key={req.userId}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`h-2 w-2 rounded-full shrink-0 ${statusColor(state.userPresence[req.userId]?.status || "offline")}`} />
                        <span className="font-medium truncate text-sm">
                          {state.userPresence[req.userId]?.displayName || displayUserId(req.userId)}
                        </span>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] px-2"
                          onClick={() => rejectFriendRequest(req.userId)}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          className="h-6 text-[11px] px-2"
                          onClick={() => acceptFriendRequest(req.userId)}
                        >
                          Accept
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Friends */}
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                <UserCheck className="h-4 w-4" />
                Friends
                {sortedFriends.length > 0 && (
                  <span className="text-xs font-normal">({sortedFriends.length})</span>
                )}
              </h2>
              {sortedFriends.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No friends yet. Add friends from their profile.
                </p>
              ) : (
                <div className="grid gap-0.5">
                  {sortedFriends.map((friendId) => {
                    const presence = state.userPresence[friendId];
                    const displayName = presence?.displayName || displayUserId(friendId);
                    const status = presence?.status || "offline";
                    const avatarUrl = presence?.avatarUrl || "";
                    const initial = displayName[0]?.toUpperCase() || "?";

                    return (
                      <button
                        key={friendId}
                        onClick={() => setProfileUserId(friendId)}
                        className="flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/50 cursor-pointer"
                      >
                        <div className="relative shrink-0">
                          <Avatar className="h-7 w-7">
                            <AuthAvatarImage src={avatarUrl} />
                            <AvatarFallback className="text-xs bg-secondary">{initial}</AvatarFallback>
                          </Avatar>
                          <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${statusColor(status)}`} />
                        </div>
                        <span className="font-medium text-sm truncate">{displayName}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Blocked Users */}
            {state.blockedUsers.length > 0 && (
              <section className="space-y-3">
                <button
                  onClick={() => setBlockedExpanded(!blockedExpanded)}
                  className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer hover:text-foreground transition-colors"
                >
                  <Ban className="h-4 w-4" />
                  Blocked
                  <span className="text-xs font-normal">({state.blockedUsers.length})</span>
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${blockedExpanded ? "rotate-180" : ""}`} />
                </button>
                {blockedExpanded && (
                  <div className="grid gap-2">
                    {state.blockedUsers.map((userId) => (
                      <div
                        key={userId}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5"
                      >
                        <span className="font-medium text-sm truncate">
                          {displayUserId(userId)}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] px-2"
                          onClick={() => unblockUser(userId)}
                        >
                          Unblock
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
      {profileUserId && (
        <UserProfileDialog
          open={!!profileUserId}
          onOpenChange={(open) => { if (!open) setProfileUserId(null); }}
          userId={profileUserId}
          displayName={state.userPresence[profileUserId]?.displayName || displayUserId(profileUserId)}
        />
      )}
    </ScrollArea>
  );
}
