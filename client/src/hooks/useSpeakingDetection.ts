import { useEffect, useState, useRef } from "react";

/// Who is currently talking.
///
/// Remote speakers come from the server, which already measures every
/// publisher's level to decide who gets a slot. Analysing the received audio
/// instead would only ever light up the handful of people currently audible —
/// someone talking while outside the slots would look silent, and the whole
/// point of slots is that most of a large call is outside them.
///
/// The local mic is still measured here, so your own indicator responds
/// immediately rather than after a round trip.
export function useSpeakingDetection(
  inVoiceChannel: boolean,
  userId: string | null,
  localStreamRef: React.MutableRefObject<MediaStream | null>,
) {
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  const remoteSpeakingRef = useRef<Set<string>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const localStreamIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!inVoiceChannel) {
      remoteSpeakingRef.current = new Set();
      localAnalyserRef.current = null;
      localStreamIdRef.current = null;
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      setSpeakingUsers(new Set());
      return;
    }

    const SPEAKING_THRESHOLD = 15; // RMS threshold (0-255 range)
    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    const dataArray = new Uint8Array(128);
    let rafId: number;

    const onWsMessage = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg?.type !== "voice_speaking" || !Array.isArray(msg.speaking)) return;
      remoteSpeakingRef.current = new Set<string>(msg.speaking);
    };
    window.addEventListener("ws-message", onWsMessage);

    const detect = () => {
      if (ctx.state === "closed") return;
      const next = new Set<string>(remoteSpeakingRef.current);
      // The server hears our published audio too, so drop its view of us in
      // favour of the local mic — otherwise the indicator lags our own voice.
      if (userId) next.delete(userId);

      // Lazily attach local mic analyser when the stream becomes available
      // (or re-attach if the stream changed, e.g. after rejoin)
      const localStream = localStreamRef.current;
      if (localStream && userId) {
        if (localStream.id !== localStreamIdRef.current) {
          try {
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            const source = ctx.createMediaStreamSource(localStream);
            source.connect(analyser);
            localAnalyserRef.current = analyser;
            localStreamIdRef.current = localStream.id;
          } catch {}
        }
        if (localAnalyserRef.current) {
          localAnalyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          if (sum / dataArray.length > SPEAKING_THRESHOLD) {
            next.add(userId);
          }
        }
      }

      setSpeakingUsers((prev) => {
        // Only update if changed to avoid re-renders
        if (prev.size !== next.size || [...next].some((u) => !prev.has(u))) return next;
        return prev;
      });

      rafId = requestAnimationFrame(detect);
    };

    rafId = requestAnimationFrame(detect);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("ws-message", onWsMessage);
      localAnalyserRef.current = null;
      localStreamIdRef.current = null;
      ctx.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, [inVoiceChannel, userId, localStreamRef]);

  return speakingUsers;
}
