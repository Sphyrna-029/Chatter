import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Scissors, Loader2 } from "lucide-react";
import { apiUploadFile } from "@/lib/api";
import { toast } from "sonner";
import { clipBufferSupported, useClipBuffer } from "@/hooks/useClipBuffer";
import {
  CLIP_LENGTH_OPTIONS,
  useClipSettings,
  type ClipLength,
} from "@/hooks/useClipSettings";

/**
 * Arm a rolling buffer over the focused screen share and save the last stretch
 * of it into the channel.
 *
 * Off unless the user's profile says otherwise: it runs a second video encoder
 * for as long as it is armed, which is a real cost to pay for a button nobody
 * may press.
 */
export function ClipControls() {
  const { state, wsRef, sendMessage } = useAppContext();
  const { settings, updateSettings } = useClipSettings();
  const lengthSecs = settings.lengthSecs;
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // screenStreamsMap is a plain module-level Map, so a track arriving in it
  // triggers no render on its own. ScreenShareViewer subscribes to this event
  // for the same reason; without it this component can sit on a stale null and
  // never notice the share it is meant to be buffering.
  const [streamVersion, setStreamVersion] = useState(0);
  useEffect(() => {
    const bump = () => setStreamVersion((v) => v + 1);
    window.addEventListener("screen-stream-update", bump);
    return () => window.removeEventListener("screen-stream-update", bump);
  }, []);

  const sharerId = state.selectedScreenSharer;
  const stream = useMemo(
    () => (sharerId ? screenStreamsMap.get(sharerId) ?? null : null),
    // streamVersion is the subscription; the map itself is not reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sharerId, streamVersion],
  );
  const { armed, bufferedSecs, error, takeClip } = useClipBuffer(stream, enabled, lengthSecs);
  const supported = clipBufferSupported();

  // Everyone in the channel is told, so a buffer of someone's screen is never
  // running unannounced.
  const announce = useCallback(
    (clipping: boolean) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "voice_clipping",
          room_id: state.voiceRoomId || state.currentRoomId,
          channel_id: state.voiceChannelId || undefined,
          clipping,
        }),
      );
    },
    [wsRef, state.voiceRoomId, state.currentRoomId, state.voiceChannelId],
  );

  // Nothing else retracts the announcement: the server holds `clipping` on the
  // voice member until they leave the call outright, so closing the viewer or
  // watching the share end would leave the channel told that a recording is
  // running when it stopped with this component. Read through refs so the
  // cleanup runs on unmount only, rather than on every state change.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const announceRef = useRef(announce);
  announceRef.current = announce;
  useEffect(
    () => () => {
      if (enabledRef.current) announceRef.current(false);
    },
    [],
  );

  // The saved default follows the focused share: whichever stream lands in the
  // main slot — on joining a call that already has one up, or on switching to
  // another — gets the user's clipping settings without being asked for.
  //
  // It only ever arms. Disarming here as well would silently cancel a buffer
  // the user armed by hand just because they looked at a different share.
  const autoArmedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sharerId) {
      // The share ended; focusing it again later should arm again.
      autoArmedFor.current = null;
      return;
    }
    if (!settings.autoArm || !stream || !supported) return;
    if (autoArmedFor.current === sharerId) return;
    autoArmedFor.current = sharerId;
    setEnabled(true);
    announce(true);
    toast.info(`Clipping armed — the last ${lengthSecs}s stays buffered`);
  }, [sharerId, stream, settings.autoArm, supported, lengthSecs, announce]);

  const toggle = useCallback(() => {
    // Whatever the user picks by hand stands for this share; the effect above
    // is keyed on the same sharer and will not override it.
    autoArmedFor.current = sharerId;
    setEnabled((prev) => {
      const next = !prev;
      announce(next);
      if (next) {
        toast.info(`Clipping armed — the last ${lengthSecs}s stays buffered`);
      }
      return next;
    });
  }, [announce, lengthSecs, sharerId]);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const clip = await takeClip();
      if (!clip || clip.blob.size === 0) {
        toast.error(
          error ?? "Nothing buffered yet — give it a few seconds",
        );
        return;
      }
      // Readable in a file list, and free of the colons that would break a path.
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace("T", "-")
        .replace(/:/g, "-");
      const ext = clip.blob.type.includes("mp4") ? "mp4" : "webm";
      const file = new File([clip.blob], `clip-${stamp}.${ext}`, { type: clip.blob.type });
      const { url } = await apiUploadFile(file);
      await sendMessage(url);
      // Say the real length: before the buffer has filled it is shorter than
      // the setting, and silently posting a stub would look like a bug.
      toast.success(`Clip posted (${Math.round(clip.seconds)}s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the clip");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [takeClip, sendMessage, error]);

  // Nothing to clip without a share on screen, and nothing to offer on a
  // browser that cannot record.
  if (!sharerId || !stream || !supported) return null;

  return (
    <div className="flex items-center gap-1">
      {armed && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={save}
          disabled={saving || bufferedSecs < 1}
          title={
            bufferedSecs < lengthSecs
              ? `Buffering — ${Math.floor(bufferedSecs)}s of ${lengthSecs}s so far`
              : `Save the last ${lengthSecs} seconds to this channel`
          }
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            `Clip ${Math.min(lengthSecs, Math.floor(bufferedSecs))}s`
          )}
        </Button>
      )}
      {/* The reason, not a euphemism for it — hiding it in a tooltip meant the
          one useful piece of information needed a hover to find. */}
      {enabled && error && (
        <span
          className="max-w-[16rem] truncate text-2xs text-destructive"
          title={error}
        >
          {error}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className={`h-7 w-7 p-0 ${armed ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
            title={armed ? "Clipping armed" : "Arm clipping"}
          >
            <Scissors className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Clip buffer</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={enabled ? "on" : "off"}
            onValueChange={() => toggle()}
          >
            <DropdownMenuRadioItem value="on">Armed</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuLabel>Length</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(lengthSecs)}
            onValueChange={(v) =>
              updateSettings({ lengthSecs: Number(v) as ClipLength })
            }
          >
            {CLIP_LENGTH_OPTIONS.map((secs) => (
              <DropdownMenuRadioItem key={secs} value={String(secs)}>
                {secs} seconds
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
