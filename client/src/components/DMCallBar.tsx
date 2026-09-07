import { useAppContext } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "./AuthImage";
import { displayUserId } from "@/lib/utils";
import { Mic, MicOff, HeadphoneOff, Monitor, PhoneOff, Phone } from "lucide-react";

/**
 * Voice and screen share for a DM.
 *
 * A DM has no channels, so its call is keyed by the room id — the path the
 * server has always kept for rooms that predate channels, where a `channel_id`
 * equal to the room means "the room itself" and permissions are judged at room
 * scope. Nothing in the voice stack needed changing; this is the surface that
 * was missing.
 *
 * There is no ringing. A call is a place, the same as a voice channel: one
 * person opens it and the other sees it is open. That keeps a missed call from
 * being a thing that can happen, and keeps one model of what voice is.
 */
export function DMCallBar({
  roomId,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onStartScreenShare,
  onStopScreenShare,
}: {
  roomId: string;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
}) {
  const { state, dispatch } = useAppContext();

  const members = state.voiceChannelMembers[roomId] ?? [];
  const inThisCall = state.inVoiceChannel && state.voiceRoomId === roomId;

  // Nothing to say when nobody is in the call and neither are you.
  if (!inThisCall && members.length === 0) return null;

  const name = (userId: string) =>
    state.userPresence[userId]?.displayName || displayUserId(userId);

  const faces = (
    <div className="flex -space-x-1.5">
      {members.slice(0, 4).map((m) => (
        <Avatar
          key={m.userId}
          className="h-6 w-6 border-2 border-background"
          title={name(m.userId)}
        >
          <AuthAvatarImage src={state.userPresence[m.userId]?.avatarUrl} />
          <AvatarFallback className="bg-secondary text-3xs">
            {name(m.userId)[0]?.toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
      ))}
      {members.length > 4 && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-secondary text-3xs font-medium">
          +{members.length - 4}
        </span>
      )}
    </div>
  );

  // Someone is in the call and you are not: an invitation, not a controller.
  if (!inThisCall) {
    return (
      <div className="flex items-center gap-3 border-b bg-success/10 px-4 py-2 shrink-0">
        {faces}
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium">
            {members.length === 1 ? name(members[0].userId) : `${members.length} people`}
          </span>
          <span className="text-muted-foreground">
            {members.length === 1 ? " is in a call" : " are in a call"}
          </span>
        </span>
        <Button size="sm" className="shrink-0 gap-1.5" onClick={onJoin}>
          <Phone className="h-3.5 w-3.5" />
          Join
        </Button>
      </div>
    );
  }

  const me = members.find((m) => m.userId === state.userId);
  const sharers = members.filter((m) => m.screen_sharing);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-success/10 px-4 py-2 shrink-0">
      {faces}

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm text-muted-foreground">
          {members.length === 1
            ? "Waiting for someone to join"
            : `In a call · ${members.length}`}
        </span>
        {/* Whoever is sharing is worth a way in, not just a note that they are. */}
        {sharers
          .filter((m) => m.userId !== state.userId)
          .map((m) => (
            <button
              key={m.userId}
              onClick={() =>
                dispatch({
                  type: "SET_SCREEN_VIEWER",
                  payload: { open: true, sharer: m.userId },
                })
              }
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-info transition-colors hover:bg-info/20 cursor-pointer"
              title={`Watch ${name(m.userId)}'s screen`}
            >
              <Monitor className="h-3 w-3" />
              Watch
            </button>
          ))}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onToggleMute}
          disabled={state.isDeafened}
          title={state.isDeafened ? "Undeafen to unmute" : state.isMuted ? "Unmute" : "Mute"}
        >
          {state.isMuted || state.isDeafened ? (
            <MicOff className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onToggleDeafen}
          title={state.isDeafened ? "Undeafen" : "Deafen"}
        >
          <HeadphoneOff
            className={`h-3.5 w-3.5 ${state.isDeafened ? "text-destructive" : ""}`}
          />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={state.isScreenSharing ? onStopScreenShare : onStartScreenShare}
          title={state.isScreenSharing ? "Stop sharing" : "Share your screen"}
        >
          <Monitor
            className={`h-3.5 w-3.5 ${state.isScreenSharing ? "text-destructive" : ""}`}
          />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={onLeave}
          title="Leave call"
        >
          <PhoneOff className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Push-to-talk is a keyboard mode, so it needs saying where the button
          for it is not. */}
      {state.voiceInputMode === "ptt" && me && (
        <span className="w-full text-2xs text-muted-foreground">
          Push to talk — hold ` to speak
        </span>
      )}
    </div>
  );
}
