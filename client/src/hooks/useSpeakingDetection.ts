import { useEffect, useState, useRef } from "react";
import type { LocalMic } from "@/lib/media";

/// Who is currently talking.
///
/// Remote speakers come from the server, which already measures every
/// publisher's level to decide who gets a slot. Analysing the received audio
/// instead would only ever light up the handful of people currently audible —
/// someone talking while outside the slots would look silent, and the whole
/// point of slots is that most of a large call is outside them.
///
/// The local mic is still measured here, so your own indicator responds
/// immediately rather than after a round trip. How it is measured belongs to
/// the media backend (lib/media) that opened the mic.
export function useSpeakingDetection(
  inVoiceChannel: boolean,
  userId: string | null,
  micRef: React.MutableRefObject<LocalMic | null>,
) {
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  const remoteSpeakingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!inVoiceChannel) {
      remoteSpeakingRef.current = new Set();
      setSpeakingUsers(new Set());
      return;
    }

    let rafId: number;
    let stopped = false;

    const onWsMessage = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg?.type !== "voice_speaking" || !Array.isArray(msg.speaking)) return;
      remoteSpeakingRef.current = new Set<string>(msg.speaking);
    };
    window.addEventListener("ws-message", onWsMessage);

    const detect = () => {
      if (stopped) return;
      const next = new Set<string>(remoteSpeakingRef.current);
      // The server hears our published audio too, so drop its view of us in
      // favour of the local mic — otherwise the indicator lags our own voice.
      if (userId) next.delete(userId);
      if (userId && micRef.current?.isSpeaking()) next.add(userId);

      setSpeakingUsers((prev) => {
        // Only update if changed to avoid re-renders
        if (prev.size !== next.size || [...next].some((u) => !prev.has(u))) return next;
        return prev;
      });

      rafId = requestAnimationFrame(detect);
    };

    rafId = requestAnimationFrame(detect);

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("ws-message", onWsMessage);
    };
  }, [inVoiceChannel, userId, micRef]);

  return speakingUsers;
}
