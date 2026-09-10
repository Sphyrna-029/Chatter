import { useCallback, useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "@/components/AuthImage";
import { Slider } from "@/components/ui/slider";
import { useAppContext } from "@/lib/store";
import { canShareScreen } from "@/lib/webrtc";
import { cn, displayUserId } from "@/lib/utils";
import type { ConnQualityData } from "@/components/VoiceControls";
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Camera,
  MonitorUp,
  Monitor,
  PhoneOff,
  ChevronUp,
  Volume2,
  VolumeX,
} from "lucide-react";

/**
 * The call, on a phone.
 *
 * The desktop call lives in a 208px sidebar whose controls are 28px icon
 * buttons with tooltips — three things a touch screen does not have: room for
 * a permanent column, fingers that land on 28px, and a hover state to read
 * the label from. So mobile gets its own surface instead of a squeezed copy
 * of that one: a bar that is always reachable, and a sheet behind it holding
 * everything the sidebar would have shown.
 *
 * Every control here is at least 44px, the smallest thing a thumb hits
 * reliably, and every icon carries its word underneath rather than in a
 * `title` no touch device will ever show.
 */

/** Minimum comfortable touch target. Worth naming, since it drives the sizes. */
const TOUCH_TARGET = "min-h-11 min-w-11";

function CallTimer({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - since);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - since), 1000);
    return () => clearInterval(id);
  }, [since]);
  const totalSecs = Math.max(0, Math.floor(elapsed / 1000));
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return (
    <span className="font-mono tabular-nums">
      {h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        : `${m}:${String(s).padStart(2, "0")}`}
    </span>
  );
}

function SignalBars({ quality }: { quality: 0 | 1 | 2 | 3 | 4 }) {
  const color = [
    "text-muted-foreground",
    "text-destructive",
    "text-orange-400",
    "text-success",
    "text-success",
  ][quality];
  return (
    <svg width="14" height="12" viewBox="0 0 16 14" className={cn("shrink-0", color)} fill="currentColor">
      <rect x="0" y="10" width="3" height="4" rx="0.5" opacity={quality >= 1 ? 1 : 0.3} />
      <rect x="4.5" y="7" width="3" height="7" rx="0.5" opacity={quality >= 2 ? 1 : 0.3} />
      <rect x="9" y="3.5" width="3" height="10.5" rx="0.5" opacity={quality >= 3 ? 1 : 0.3} />
      <rect x="13" y="0" width="3" height="14" rx="0.5" opacity={quality >= 4 ? 1 : 0.3} />
    </svg>
  );
}

/** A round icon button with its label spelled out underneath. */
function CallAction({
  icon,
  label,
  onClick,
  tone = "neutral",
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "neutral" | "active" | "danger" | "hangup";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-1 flex-col items-center gap-1.5 disabled:opacity-40"
    >
      <span
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-full transition-colors",
          tone === "hangup" && "bg-destructive text-white",
          tone === "danger" && "bg-destructive/20 text-destructive",
          tone === "active" && "bg-success/20 text-success",
          tone === "neutral" && "bg-secondary text-secondary-foreground",
        )}
      >
        {icon}
      </span>
      <span className="text-3xs font-medium text-muted-foreground">{label}</span>
    </button>
  );
}

interface MobileCallBarProps {
  channelName: string;
  roomName: string;
  occupiedSince?: number;
  connQualityRef?: React.MutableRefObject<ConnQualityData>;
  speakingUsersRef?: React.MutableRefObject<Set<string>>;
  setUserVolumeRef?: React.MutableRefObject<((userId: string, vol: number) => void) | null>;
  /** True when the chat already shows the voice room, so a stream is one tap away. */
  onVoiceRoom: boolean;
  onNavigate: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onToggleWebcam: () => void;
  onHangUp: () => void;
}

export function MobileCallBar(props: MobileCallBarProps) {
  const {
    channelName,
    roomName,
    occupiedSince,
    connQualityRef,
    onVoiceRoom,
    onNavigate,
    onToggleMute,
    onToggleDeafen,
    onHangUp,
  } = props;
  const { state, dispatch } = useAppContext();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [quality, setQuality] = useState<0 | 1 | 2 | 3 | 4>(0);

  useEffect(() => {
    if (!connQualityRef) return;
    const id = setInterval(() => setQuality(connQualityRef.current.quality), 1000);
    return () => clearInterval(id);
  }, [connQualityRef]);

  const streaming =
    state.activeScreenSharers.length + state.activeWebcamStreamers.length > 0;
  // The opt-in bar above the chat already makes the offer when the voice room
  // is what you are looking at; anywhere else, this is the only way through.
  const showStreamChip = streaming && !state.screenViewerOpen && !onVoiceRoom;

  const openStream = useCallback(() => {
    dispatch({
      type: "SET_SCREEN_VIEWER",
      payload: { open: true, sharer: state.activeScreenSharers[0] ?? null },
    });
    onNavigate();
  }, [dispatch, state.activeScreenSharers, onNavigate]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-t bg-card px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {/* The whole label is the handle for the sheet — a bigger target than
            any chevron, and the chevron still says which way it opens. */}
        <button
          onClick={() => setSheetOpen(true)}
          className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left", TOUCH_TARGET)}
          aria-label="Call details"
        >
          <SignalBars quality={quality} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-success">
              {channelName}
            </span>
            <span className="block truncate text-3xs text-muted-foreground">
              {occupiedSince ? <CallTimer since={occupiedSince} /> : "Connecting…"}
              {" · "}
              {roomName}
            </span>
          </span>
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {showStreamChip && (
          <button
            onClick={openStream}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md bg-info/15 px-2 text-xs font-medium text-info",
              TOUCH_TARGET,
            )}
          >
            <Monitor className="h-4 w-4" />
            View
          </button>
        )}

        <button
          onClick={onToggleMute}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md transition-colors",
            TOUCH_TARGET,
            state.isMuted || state.isDeafened
              ? "bg-destructive/15 text-destructive"
              : "bg-secondary text-secondary-foreground",
          )}
          aria-label={state.isMuted || state.isDeafened ? "Unmute" : "Mute"}
        >
          {state.isMuted || state.isDeafened ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          onClick={onToggleDeafen}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md transition-colors",
            TOUCH_TARGET,
            state.isDeafened
              ? "bg-destructive/15 text-destructive"
              : "bg-secondary text-secondary-foreground",
          )}
          aria-label={state.isDeafened ? "Undeafen" : "Deafen"}
        >
          {state.isDeafened ? <HeadphoneOff className="h-5 w-5" /> : <Headphones className="h-5 w-5" />}
        </button>
        <button
          onClick={onHangUp}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md bg-destructive text-white",
            TOUCH_TARGET,
          )}
          aria-label="Leave call"
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>

      <MobileCallSheet
        {...props}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        quality={quality}
      />
    </>
  );
}

function MobileCallSheet({
  channelName,
  roomName,
  occupiedSince,
  speakingUsersRef,
  setUserVolumeRef,
  onNavigate,
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onToggleWebcam,
  onHangUp,
  open,
  onOpenChange,
  quality,
}: MobileCallBarProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quality: 0 | 1 | 2 | 3 | 4;
}) {
  const { state, dispatch } = useAppContext();
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [volumeOpenFor, setVolumeOpenFor] = useState<string | null>(null);

  // Only while the sheet is up: nothing on screen reads this otherwise.
  useEffect(() => {
    if (!open || !speakingUsersRef) return;
    const id = setInterval(() => setSpeaking(new Set(speakingUsersRef.current)), 150);
    return () => clearInterval(id);
  }, [open, speakingUsersRef]);

  const setVolume = useCallback(
    (userId: string, vol: number) => {
      setVolumes((v) => ({ ...v, [userId]: vol }));
      setUserVolumeRef?.current?.(userId, vol);
    },
    [setUserVolumeRef],
  );

  const name = (userId: string) =>
    state.userPresence[userId]?.displayName || displayUserId(userId);

  const watch = (userId: string, kind: "screen" | "webcam") => {
    dispatch({
      type: "SET_SCREEN_VIEWER",
      payload:
        kind === "screen"
          ? { open: true, sharer: userId }
          : { open: true, webcamStreamer: userId },
    });
    onNavigate();
    onOpenChange(false);
  };

  const screenShareAvailable = canShareScreen();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[85dvh] gap-0 rounded-t-2xl p-0"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Call in {channelName}</SheetTitle>
          <SheetDescription>Participants and call controls</SheetDescription>
        </SheetHeader>

        {/* The grabber is the way out as well as the sign of one: tapping
            outside works, but only if you already know it does. */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="flex w-full justify-center pt-3 pb-2"
          aria-label="Close call details"
        >
          <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
        </button>

        <div className="flex items-center gap-2 px-4 pb-3">
          <SignalBars quality={quality} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-success">{channelName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {roomName}
              {occupiedSince && (
                <>
                  {" · "}
                  <CallTimer since={occupiedSince} />
                </>
              )}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-3xs font-medium text-muted-foreground">
            {state.voiceMembers.length}
          </span>
        </div>

        {/* Participants. Capped rather than flex-1: the sheet is auto-height,
            and a flex-basis of 0 in an auto-height column collapses to nothing
            instead of filling what is left. */}
        <div className="max-h-[45dvh] overflow-y-auto border-t px-2 py-1">
          {state.voiceMembers.map((memberId) => {
            const isSelf = memberId === state.userId;
            const memberState = state.voiceMemberStates[memberId];
            const isMuted = memberState?.muted || (isSelf && state.isMuted);
            const sharingScreen =
              memberState?.screen_sharing || state.activeScreenSharers.includes(memberId);
            const sharingCamera = state.activeWebcamStreamers.includes(memberId);
            const vol = volumes[memberId] ?? 1;
            const isSpeaking = speaking.has(memberId) && !isMuted;
            const volumeOpen = volumeOpenFor === memberId;

            return (
              <div key={memberId} className="px-2 py-1">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "shrink-0 rounded-full transition-shadow",
                      isSpeaking && "shadow-[0_0_0_2px_var(--success)]",
                    )}
                  >
                    <Avatar className="h-9 w-9">
                      <AuthAvatarImage src={state.userPresence[memberId]?.avatarUrl} />
                      <AvatarFallback className="bg-secondary text-xs">
                        {name(memberId)[0]?.toUpperCase() || "?"}
                      </AvatarFallback>
                    </Avatar>
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-sm", isSpeaking && "font-semibold text-success")}>
                      {name(memberId)}
                      {isSelf && <span className="text-muted-foreground"> (You)</span>}
                    </p>
                    <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
                      {isMuted ? (
                        <><MicOff className="h-3 w-3 text-destructive" /> Muted</>
                      ) : (
                        <><Mic className="h-3 w-3 text-success" /> Open</>
                      )}
                      {(sharingScreen || sharingCamera) && (
                        <span className="text-info">
                          · {sharingScreen ? "Sharing screen" : "Camera on"}
                        </span>
                      )}
                    </div>
                  </div>

                  {(sharingScreen || sharingCamera) && (
                    <button
                      onClick={() => watch(memberId, sharingScreen ? "screen" : "webcam")}
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-md bg-info/15 px-3 text-xs font-medium text-info",
                        TOUCH_TARGET,
                      )}
                    >
                      {sharingScreen ? <Monitor className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
                      Watch
                    </button>
                  )}

                  {!isSelf && (
                    <button
                      onClick={() => setVolumeOpenFor(volumeOpen ? null : memberId)}
                      className={cn(
                        "flex shrink-0 items-center justify-center rounded-md transition-colors",
                        TOUCH_TARGET,
                        volumeOpen || vol === 0
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground",
                      )}
                      aria-label={`Volume for ${name(memberId)}`}
                    >
                      {vol === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </button>
                  )}
                </div>

                {volumeOpen && !isSelf && (
                  <div className="flex items-center gap-3 py-2 pl-12 pr-1">
                    <Slider
                      value={[vol * 100]}
                      onValueChange={([v]) => setVolume(memberId, v / 100)}
                      max={150}
                      step={1}
                      className="flex-1"
                    />
                    <span className="w-10 text-right text-3xs tabular-nums text-muted-foreground">
                      {Math.round(vol * 100)}%
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Controls */}
        <div className="flex items-start gap-1 border-t px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <CallAction
            icon={state.isMuted || state.isDeafened ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            label={state.isMuted || state.isDeafened ? "Unmute" : "Mute"}
            tone={state.isMuted || state.isDeafened ? "danger" : "neutral"}
            onClick={onToggleMute}
            disabled={state.isDeafened}
          />
          <CallAction
            icon={state.isDeafened ? <HeadphoneOff className="h-6 w-6" /> : <Headphones className="h-6 w-6" />}
            label={state.isDeafened ? "Undeafen" : "Deafen"}
            tone={state.isDeafened ? "danger" : "neutral"}
            onClick={onToggleDeafen}
          />
          <CallAction
            icon={<Camera className="h-6 w-6" />}
            label={state.isWebcamActive ? "Stop cam" : "Camera"}
            tone={state.isWebcamActive ? "active" : "neutral"}
            onClick={onToggleWebcam}
          />
          {/* No mobile browser can capture a screen, so the button is left out
              rather than left to fail. */}
          {screenShareAvailable && (
            <CallAction
              icon={<MonitorUp className="h-6 w-6" />}
              label={state.isScreenSharing ? "Stop" : "Screen"}
              tone={state.isScreenSharing ? "active" : "neutral"}
              onClick={onToggleScreenShare}
            />
          )}
          <CallAction
            icon={<PhoneOff className="h-6 w-6" />}
            label="Leave"
            tone="hangup"
            onClick={() => {
              onOpenChange(false);
              onHangUp();
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
