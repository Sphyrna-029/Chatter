import { useEffect, useState, useRef } from "react";

export function useSpeakingDetection(
  inVoiceChannel: boolean,
  userId: string | null,
  localStreamRef: React.MutableRefObject<MediaStream | null>,
  voiceAudioElementsRef: React.MutableRefObject<Map<string, HTMLAudioElement>>,
) {
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const localStreamIdRef = useRef<string | null>(null);
  const remoteAnalysersRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; streamId: string }>>(new Map());

  useEffect(() => {
    if (!inVoiceChannel) {
      // Clean up analysers
      remoteAnalysersRef.current.forEach(({ source }) => { try { source.disconnect(); } catch {} });
      remoteAnalysersRef.current.clear();
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

    const detect = () => {
      if (ctx.state === "closed") return;
      const next = new Set<string>();

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

      // Lazily attach remote analysers and detect speech in one pass.
      // This handles new audio elements (from ontrack) and stream replacements
      // (from subscriber PC retries) without needing a separate useEffect.
      voiceAudioElementsRef.current.forEach((audioEl, uid) => {
        const stream = audioEl.srcObject as MediaStream | null;
        if (!stream) return;

        const existing = remoteAnalysersRef.current.get(uid);
        // Attach a new analyser if we don't have one for this user, or if the
        // underlying stream changed (subscriber PC was torn down and recreated).
        if (!existing || existing.streamId !== stream.id) {
          if (existing) { try { existing.source.disconnect(); } catch {} }
          try {
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            const source = ctx.createMediaStreamSource(stream);
            source.connect(analyser);
            remoteAnalysersRef.current.set(uid, { analyser, source, streamId: stream.id });
          } catch {}
        }

        const entry = remoteAnalysersRef.current.get(uid);
        if (entry) {
          entry.analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          if (sum / dataArray.length > SPEAKING_THRESHOLD) {
            next.add(uid);
          }
        }
      });

      // Remove analysers for users who left (no longer in the audio elements map)
      remoteAnalysersRef.current.forEach(({ source }, uid) => {
        if (!voiceAudioElementsRef.current.has(uid)) {
          try { source.disconnect(); } catch {}
          remoteAnalysersRef.current.delete(uid);
        }
      });

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
      remoteAnalysersRef.current.forEach(({ source }) => { try { source.disconnect(); } catch {} });
      remoteAnalysersRef.current.clear();
      localAnalyserRef.current = null;
      localStreamIdRef.current = null;
      ctx.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, [inVoiceChannel, userId]);

  return speakingUsers;
}
