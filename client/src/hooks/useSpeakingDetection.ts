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
  const remoteAnalysersRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>>(new Map());

  useEffect(() => {
    if (!inVoiceChannel) {
      // Clean up analysers
      remoteAnalysersRef.current.forEach(({ source }) => { try { source.disconnect(); } catch {} });
      remoteAnalysersRef.current.clear();
      localAnalyserRef.current = null;
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

    // Set up local mic analyser
    if (localStreamRef.current) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const source = ctx.createMediaStreamSource(localStreamRef.current);
      source.connect(analyser);
      localAnalyserRef.current = analyser;
    }

    const dataArray = new Uint8Array(128);
    let rafId: number;

    const detect = () => {
      const next = new Set<string>();

      // Check local mic
      if (localAnalyserRef.current && userId) {
        localAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        if (sum / dataArray.length > SPEAKING_THRESHOLD) {
          next.add(userId);
        }
      }

      // Check remote peers
      remoteAnalysersRef.current.forEach(({ analyser }, uid) => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        if (sum / dataArray.length > SPEAKING_THRESHOLD) {
          next.add(uid);
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
      ctx.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, [inVoiceChannel, userId]);

  // Attach analysers to remote audio streams when they arrive
  useEffect(() => {
    if (!inVoiceChannel || !audioContextRef.current) return;

    voiceAudioElementsRef.current.forEach((audioEl, uid) => {
      if (remoteAnalysersRef.current.has(uid)) return;
      const stream = audioEl.srcObject as MediaStream | null;
      if (!stream) return;
      try {
        const ctx = audioContextRef.current!;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        remoteAnalysersRef.current.set(uid, { analyser, source });
      } catch {}
    });
  });

  return speakingUsers;
}
