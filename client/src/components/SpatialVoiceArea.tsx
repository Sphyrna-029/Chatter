import { useCallback, useEffect, useRef, useState } from "react";
import { useAppContext } from "@/lib/store";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "./AuthImage";
import { Button } from "@/components/ui/button";
import { cn, displayUserId } from "@/lib/utils";
import { readProfileAccent } from "@/lib/profileTheme";
import { distanceGain, worldDistance } from "@/lib/spatialAudio";
import { Mic, MicOff, Volume2, VolumeX } from "lucide-react";

/**
 * A voice channel with a floor.
 *
 * Everything here is a view of `voiceChannelMembers` — the same record the
 * sidebar and the voice panel read — plus a drag that sends `voice_move`. The
 * hearing is not done here at all: the SFU forwards each speaker as their own
 * track, so `useWebRTCVoice` places them with a PannerNode and this file only
 * has to agree with it about where everybody is standing.
 */

/** How often a drag is allowed to reach the socket, in milliseconds. */
const MOVE_INTERVAL_MS = 60;

const EMPTY_SPEAKING: ReadonlySet<string> = new Set();

interface SpatialVoiceAreaProps {
  onJoinVoice: (channelId: string) => void;
  onLeaveVoice: () => void;
  speakingUsersRef?: React.MutableRefObject<Set<string>>;
}

export function SpatialVoiceArea({ onJoinVoice, onLeaveVoice, speakingUsersRef }: SpatialVoiceAreaProps) {
  const { state, wsRef } = useAppContext();
  const floorRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef(0);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  // While dragging, the avatar follows the pointer rather than the echo — a
  // round trip is imperceptible in the ears and very visible under the thumb.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());

  const channelId = state.currentChannelId;
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const members = channelId ? state.voiceChannelMembers[channelId] ?? [] : [];
  const inThisChannel = state.inVoiceChannel && state.voiceChannelId === channelId;
  const me = members.find((m) => m.userId === state.userId);

  useEffect(() => {
    if (!inThisChannel || !speakingUsersRef) return;
    const id = setInterval(() => setSpeaking(new Set(speakingUsersRef.current)), 100);
    return () => clearInterval(id);
  }, [inThisChannel, speakingUsersRef]);
  // Read through `inThisChannel` rather than cleared on the way out: a set
  // nobody is looking at does not need emptying, and emptying it from the
  // effect would be a render caused by leaving.
  const speakingNow = inThisChannel ? speaking : EMPTY_SPEAKING;

  // Leaving the floor ends the drag; otherwise a pointer released outside the
  // window leaves the avatar stuck to the cursor on return.
  useEffect(() => {
    if (!drag) return;
    const end = () => setDrag(null);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [drag]);

  useEffect(() => () => {
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
  }, []);

  const sendMove = useCallback(
    (x: number, y: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !channelId) return;
      ws.send(JSON.stringify({
        type: "voice_move",
        room_id: state.voiceRoomId || state.currentRoomId,
        channel_id: channelId,
        x,
        y,
      }));
    },
    [wsRef, channelId, state.voiceRoomId, state.currentRoomId],
  );

  /**
   * Metered, with the last position always sent.
   *
   * A drag is a stream and only its end matters, so dropping intermediate
   * frames is free — but dropping the *final* one leaves the person standing
   * somewhere they are not, which is why the trailing send exists rather than
   * a plain throttle.
   */
  const queueMove = useCallback(
    (x: number, y: number) => {
      pendingRef.current = { x, y };
      const since = Date.now() - lastSentRef.current;
      if (since >= MOVE_INTERVAL_MS) {
        lastSentRef.current = Date.now();
        sendMove(x, y);
        pendingRef.current = null;
        return;
      }
      if (flushTimerRef.current) return;
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        const p = pendingRef.current;
        if (!p) return;
        lastSentRef.current = Date.now();
        sendMove(p.x, p.y);
        pendingRef.current = null;
      }, MOVE_INTERVAL_MS - since);
    },
    [sendMove],
  );

  const pointToRoom = (clientX: number, clientY: number) => {
    const box = floorRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)),
    };
  };

  const moveTo = (clientX: number, clientY: number) => {
    const point = pointToRoom(clientX, clientY);
    if (!point) return;
    setDrag(point);
    queueMove(point.x, point.y);
  };

  const myPoint = drag ?? (me?.x !== undefined && me?.y !== undefined ? { x: me.x, y: me.y } : { x: 0.5, y: 0.5 });

  if (!channel) return <div className="flex-1" />;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate">{channel.name}</h2>
          <p className="ui-hint truncate">
            {members.length === 0
              ? "Nobody here yet"
              : `${members.length} ${members.length === 1 ? "person" : "people"} on the floor`}
            {channel.topic ? ` · ${channel.topic}` : ""}
          </p>
        </div>
        <div className="ml-auto shrink-0">
          {inThisChannel ? (
            <Button variant="outline" size="sm" onClick={onLeaveVoice}>Leave</Button>
          ) : (
            <Button size="sm" onClick={() => channelId && onJoinVoice(channelId)}>Join</Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 p-4 flex items-center justify-center overflow-auto">
        <div
          ref={floorRef}
          onPointerMove={(e) => { if (drag) moveTo(e.clientX, e.clientY); }}
          onPointerDown={(e) => {
            // Clicking anywhere on the floor walks you there, which is quicker
            // than dragging across it and is what a person tries first.
            if (inThisChannel && e.target === floorRef.current) moveTo(e.clientX, e.clientY);
          }}
          className={cn(
            "relative w-full max-w-[46rem] aspect-[4/3] rounded-xl border border-border/60 overflow-hidden",
            "bg-[radial-gradient(circle_at_center,var(--muted)_0%,var(--background)_78%)]",
            inThisChannel && "cursor-crosshair",
          )}
        >
          {/* A grid, so a move reads as a move across something. */}
          <div
            className="absolute inset-0 opacity-[0.35] pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
              backgroundSize: "12.5% 12.5%",
            }}
          />

          {!inThisChannel && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="ui-hint bg-background/80 rounded-md px-3 py-1.5">
                Join to walk around
              </p>
            </div>
          )}

          {members.map((member) => {
            const isSelf = member.userId === state.userId;
            const at = isSelf
              ? myPoint
              : { x: member.x ?? 0.5, y: member.y ?? 0.5 };
            const presence = state.userPresence[member.userId];
            const name = presence?.displayName || displayUserId(member.userId);
            const accent = readProfileAccent(presence);
            const isSpeaking = speakingNow.has(member.userId) && !member.muted;
            // How loud they are from where you are standing, used to fade the
            // ones you cannot really hear. Your own tile never fades.
            const heard = isSelf || !inThisChannel ? 1 : distanceGain(worldDistance(myPoint, at));

            return (
              <div
                key={member.userId}
                className="absolute flex flex-col items-center gap-1 select-none"
                style={{
                  left: `${at.x * 100}%`,
                  top: `${at.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                  zIndex: isSelf ? 2 : 1,
                  // Never all the way out: someone across the room is faint,
                  // not gone, and a dot you cannot see is one you will walk into.
                  opacity: 0.35 + 0.65 * heard,
                  touchAction: isSelf ? "none" : undefined,
                  cursor: isSelf && inThisChannel ? "grab" : undefined,
                }}
                onPointerDown={(e) => {
                  if (!isSelf || !inThisChannel) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ x: at.x, y: at.y });
                }}
                onPointerMove={(e) => { if (isSelf && drag) moveTo(e.clientX, e.clientY); }}
              >
                {isSelf && inThisChannel && (
                  // What you can hear, drawn where the falloff actually bites.
                  <span
                    className="absolute rounded-full pointer-events-none"
                    style={{
                      width: "13rem",
                      height: "13rem",
                      background: `radial-gradient(circle, ${accent ?? "var(--primary)"}22 0%, transparent 70%)`,
                    }}
                  />
                )}
                <span
                  className={cn("relative rounded-full transition-shadow", member.muted && "opacity-70")}
                  style={isSpeaking ? { boxShadow: `0 0 0 3px ${accent ?? "var(--success)"}` } : undefined}
                >
                  <Avatar className="h-11 w-11 border-2 border-background">
                    <AuthAvatarImage src={presence?.avatarUrl} />
                    <AvatarFallback className="text-xs bg-secondary">
                      {name[0]?.toUpperCase() || "?"}
                    </AvatarFallback>
                  </Avatar>
                  {member.muted && (
                    <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background p-0.5">
                      <MicOff className="h-3 w-3 text-destructive" />
                    </span>
                  )}
                </span>
                <span
                  className="max-w-[7rem] truncate rounded bg-background/80 px-1.5 text-3xs leading-tight"
                  style={accent ? { color: accent } : undefined}
                >
                  {name}{isSelf && " (you)"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {inThisChannel && (
        <div className="flex items-center justify-center gap-2 px-4 pb-4 shrink-0 ui-hint">
          {state.isMuted ? <MicOff className="h-3.5 w-3.5 text-destructive" /> : <Mic className="h-3.5 w-3.5" />}
          {state.isDeafened ? <VolumeX className="h-3.5 w-3.5 text-destructive" /> : <Volume2 className="h-3.5 w-3.5" />}
          <span>Drag yourself, or click the floor. People fade as you walk away.</span>
        </div>
      )}
    </div>
  );
}
