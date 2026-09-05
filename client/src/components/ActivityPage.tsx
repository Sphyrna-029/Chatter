import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import {
  apiSync,
  apiGetAllRooms,
  apiGetVoiceMembers,
  apiGetChannels,
  apiGetUnreads,
  apiMarkRead,
  type RoomSummary,
} from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { UserProfileDialog } from "./UserProfileDialog";
import { displayUserId } from "@/lib/utils";
import { AuthImage, AuthAvatarImage } from "@/components/AuthImage";
import { AtSign, Users, MessageSquare, Clock, UserPlus, UserCheck, Ban, ChevronDown, Radio, Volume2, Monitor, MicOff, CheckCheck, Music, Gamepad2, MessageCircle } from "lucide-react";
import { ActivityStats } from "./activity/ActivityStats";
import { ActivityFeed } from "./activity/ActivityFeed";
import { StorageManager } from "./activity/StorageManager";
import { RecentDiscussions } from "./activity/RecentDiscussions";
import { CrossRoomSearch } from "./activity/CrossRoomSearch";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface RoomActivity {
  roomId: string;
  lastMessage?: { sender: string; body: string; timestamp: number };
  memberCount: number;
}

interface LiveVoiceMember {
  userId: string;
  muted: boolean;
  deafened: boolean;
  screenSharing: boolean;
}

interface LiveVoiceChannel {
  channelId: string;
  name: string;
  members: LiveVoiceMember[];
}

interface LiveVoiceRoom {
  roomId: string;
  channels: LiveVoiceChannel[];
}

/** Voice occupancy is not in the store here — it is only tracked for the room
 *  you are viewing, and on this page there is none — so it is polled. */
const LIVE_REFRESH_MS = 15_000;
/** The sync-derived digest is far heavier, so it refreshes lazily. */
const DIGEST_REFRESH_MS = 60_000;

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

/** Steam reports the session start in seconds, matching UserProfileDialog. */
function playingFor(startSecs: number): string {
  const elapsed = Math.floor(Date.now() / 1000 - startSecs);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "just started";
}

function statusColor(status: string) {
  if (status === "active" || status === "online") return "bg-success";
  if (status === "idle" || status === "away") return "bg-warning";
  if (status === "dnd") return "bg-destructive";
  return "bg-muted-foreground";
}

export function ActivityPage() {
  const { state, selectRoom, openDM, acceptFriendRequest, rejectFriendRequest, removeFriend, unblockUser, loadUnreads, sendFriendRequest } = useAppContext();
  const [activities, setActivities] = useState<RoomActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [blockedExpanded, setBlockedExpanded] = useState(false);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [liveVoice, setLiveVoice] = useState<LiveVoiceRoom[]>([]);
  const [markingRead, setMarkingRead] = useState(false);
  // Bumped on each digest tick; the self-fetching sections refresh off it.
  const [refreshKey, setRefreshKey] = useState(0);
  const [friendToAdd, setFriendToAdd] = useState("");

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
    // The reducer keeps unread counts live over the socket, but a resync picks
    // up reads that happened on another device.
    void loadUnreads();
    const interval = setInterval(() => {
      fetchActivity();
      void loadUnreads();
      setRefreshKey((k) => k + 1);
    }, DIGEST_REFRESH_MS);
    // Coming back to the tab is exactly when a stale digest is most obvious.
    const onFocus = () => { if (!document.hidden) fetchActivity(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [state.joinedRoomIds, loadUnreads]);

  // Who is in voice, and who is streaming, across every room you have joined.
  useEffect(() => {
    let cancelled = false;

    async function fetchLiveVoice() {
      try {
        const { rooms } = await apiGetAllRooms();
        const joined = new Set(state.joinedRoomIds);
        const active = rooms.filter((r) => joined.has(r.room_id) && r.voice_count > 0);
        if (active.length === 0) {
          if (!cancelled) setLiveVoice([]);
          return;
        }

        const detailed = await Promise.all(
          active.map(async (room): Promise<LiveVoiceRoom> => {
            const [voice, channelData] = await Promise.all([
              apiGetVoiceMembers(room.room_id),
              apiGetChannels(room.room_id).catch(() => ({ channels: [], categories: [] })),
            ]);
            const channelNames: Record<string, string> = {};
            for (const ch of channelData.channels) channelNames[ch.channel_id] = ch.name;

            const channels: LiveVoiceChannel[] = Object.entries(voice.voice_channels ?? {})
              .map(([channelId, members]) => ({
                channelId,
                // Rooms predating channels key their members by room id instead.
                name: channelNames[channelId] || "Voice",
                members: members.map((m) => ({
                  userId: m.user_id,
                  muted: !!m.muted,
                  deafened: !!m.deafened,
                  screenSharing: !!m.screen_sharing,
                })),
              }))
              .filter((c) => c.members.length > 0);

            return { roomId: room.room_id, channels };
          }),
        );

        if (!cancelled) setLiveVoice(detailed.filter((r) => r.channels.length > 0));
      } catch {
        // Keep showing the last known state rather than blanking the section.
      }
    }

    fetchLiveVoice();
    const interval = setInterval(fetchLiveVoice, LIVE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [state.joinedRoomIds]);

  // Read markers are per channel, so clearing a room means clearing each of
  // its channels — the unread rows already carry the pairs to mark.
  const markAllRead = useCallback(async () => {
    setMarkingRead(true);
    try {
      const { unreads } = await apiGetUnreads();
      await Promise.all(
        unreads.map((u) => apiMarkRead(u.room_id, u.channel_id).catch(() => {})),
      );
      await loadUnreads();
    } catch {
      // Nothing to undo — the next refresh reflects whatever landed.
    } finally {
      setMarkingRead(false);
    }
  }, [loadUnreads]);

  const addFriend = useCallback(async () => {
    const target = friendToAdd.trim();
    if (!target) return;
    try {
      await sendFriendRequest(target);
      setFriendToAdd("");
      toast.success(`Friend request sent to ${target}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send friend request");
    }
  }, [friendToAdd, sendFriendRequest]);

  const mentionedRooms = Object.entries(state.roomMentions).filter(
    ([, count]) => count > 0
  );

  const unreadRooms = Object.entries(state.roomUnreadCounts).filter(
    ([, count]) => count > 0
  );
  const totalUnread = unreadRooms.reduce((sum, [, count]) => sum + count, 0);

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

        <CrossRoomSearch onSelectRoom={selectRoom} />

        {/* Happening Now — live voice and screen shares across your rooms */}
        {liveVoice.length > 0 && (
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              <Radio className="h-4 w-4 text-success" />
              Happening Now
            </h2>
            <div className="grid gap-2">
              {liveVoice.map((room) => {
                const info = state.roomInfoMap[room.roomId];
                const name = info?.name || "Unnamed";
                return (
                  <button
                    key={room.roomId}
                    onClick={() => selectRoom(room.roomId)}
                    className="flex flex-col gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-left transition-colors hover:bg-success/10 cursor-pointer w-full overflow-hidden"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-3xs font-bold shrink-0">
                        {info?.icon_url ? (
                          <AuthImage src={info.icon_url} alt="" className="h-6 w-6 rounded-md object-cover" />
                        ) : (
                          name.charAt(0).toUpperCase()
                        )}
                      </span>
                      <span className="font-medium truncate">{name}</span>
                    </div>

                    {room.channels.map((channel) => {
                      const sharers = channel.members.filter((m) => m.screenSharing);
                      return (
                        <div key={channel.channelId} className="flex items-center gap-2 pl-8 min-w-0">
                          <Volume2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-xs text-muted-foreground truncate max-w-[8rem]">
                            {channel.name}
                          </span>
                          <div className="flex items-center -space-x-1.5 shrink-0">
                            {channel.members.slice(0, 5).map((member) => {
                              const presence = state.userPresence[member.userId];
                              const label = presence?.displayName || displayUserId(member.userId);
                              return (
                                <span key={member.userId} className="relative" title={label}>
                                  <Avatar className="h-6 w-6 border-2 border-background">
                                    <AuthAvatarImage src={presence?.avatarUrl || ""} />
                                    <AvatarFallback className="text-3xs bg-secondary">
                                      {label[0]?.toUpperCase() || "?"}
                                    </AvatarFallback>
                                  </Avatar>
                                  {member.muted && (
                                    <MicOff className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-background p-[1px] text-destructive" />
                                  )}
                                </span>
                              );
                            })}
                          </div>
                          {channel.members.length > 5 && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              +{channel.members.length - 5}
                            </span>
                          )}
                          {sharers.length > 0 && (
                            <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-semibold bg-purple-500/20 text-purple-400 shrink-0">
                              <Monitor className="h-3 w-3" />
                              {sharers.length === 1
                                ? `${state.userPresence[sharers[0].userId]?.displayName || displayUserId(sharers[0].userId)} is streaming`
                                : `${sharers.length} streaming`}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Unread summary */}
        {totalUnread > 0 && (
          <section className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <p className="text-sm min-w-0">
              <span className="font-semibold">{totalUnread}</span>
              {" unread message"}{totalUnread !== 1 ? "s" : ""}
              {" across "}
              <span className="font-semibold">{unreadRooms.length}</span>
              {" room"}{unreadRooms.length !== 1 ? "s" : ""}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs shrink-0"
              onClick={markAllRead}
              disabled={markingRead}
            >
              <CheckCheck className="h-3.5 w-3.5 mr-1" />
              {markingRead ? "Marking…" : "Mark all read"}
            </Button>
          </section>
        )}

        <ActivityStats
          refreshKey={refreshKey}
          onSelectRoom={selectRoom}
          onSelectUser={setProfileUserId}
        />

        <RecentDiscussions refreshKey={refreshKey} onSelectRoom={selectRoom} />

        <ActivityFeed refreshKey={refreshKey} onSelectRoom={selectRoom} />

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
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-2xs font-bold text-white shrink-0">
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
                    const unreadCount = state.roomUnreadCounts[roomId] || 0;

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
                              <span className="text-3xs text-muted-foreground border border-border rounded px-1">forum</span>
                            )}
                            {info?.room_type === "whiteboard" && (
                              <span className="text-3xs text-muted-foreground border border-border rounded px-1">whiteboard</span>
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
                          {unreadCount > 0 && (
                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-2xs font-bold text-primary-foreground">
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          )}
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
                          className="h-6 text-2xs px-2"
                          onClick={() => rejectFriendRequest(req.userId)}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          className="h-6 text-2xs px-2"
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

                    const isOffline = status === "offline";
                    // Rich presence arrives on the global presence_update event,
                    // so it is as live here as it is in the members panel.
                    const spotify = !isOffline && presence?.spotifyTrack;
                    const steam = !isOffline && !spotify && presence?.steamGame;

                    return (
                      <button
                        key={friendId}
                        onClick={() => setProfileUserId(friendId)}
                        className="group flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/50 cursor-pointer w-full min-w-0"
                      >
                        <div className="relative shrink-0">
                          <Avatar className="h-7 w-7">
                            <AuthAvatarImage src={avatarUrl} />
                            <AvatarFallback className="text-xs bg-secondary">{initial}</AvatarFallback>
                          </Avatar>
                          <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${statusColor(status)}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block font-medium text-sm truncate">{displayName}</span>
                          {spotify && (
                            <span className="flex items-center gap-1 text-2xs text-muted-foreground truncate">
                              {presence?.spotifyAlbumArt ? (
                                <img
                                  src={presence.spotifyAlbumArt}
                                  alt=""
                                  className="h-3 w-3 rounded-[2px] object-cover shrink-0"
                                />
                              ) : (
                                <Music className="h-3 w-3 shrink-0 text-success" />
                              )}
                              <span className="truncate">
                                {presence?.spotifyTrack}
                                {presence?.spotifyArtist ? ` — ${presence.spotifyArtist}` : ""}
                              </span>
                            </span>
                          )}
                          {steam && (
                            <span className="flex items-center gap-1 text-2xs text-muted-foreground truncate">
                              <Gamepad2 className="h-3 w-3 shrink-0 text-blue-400" />
                              <span className="truncate">
                                {presence?.steamGame}
                                {presence?.gameSessionStart
                                  ? ` · ${playingFor(presence.gameSessionStart)}`
                                  : ""}
                              </span>
                            </span>
                          )}
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          title={`Message ${displayName}`}
                          onClick={(e) => { e.stopPropagation(); openDM(friendId); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              openDM(friendId);
                            }
                          }}
                          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <MessageCircle className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-1.5 pt-1">
                <Input
                  value={friendToAdd}
                  onChange={(e) => setFriendToAdd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addFriend(); }}
                  placeholder="Add friend by username"
                  className="h-7 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-2xs px-2 shrink-0"
                  onClick={addFriend}
                  disabled={!friendToAdd.trim()}
                >
                  Add
                </Button>
              </div>
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
                          className="h-6 text-2xs px-2"
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

        <StorageManager refreshKey={refreshKey} />
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
