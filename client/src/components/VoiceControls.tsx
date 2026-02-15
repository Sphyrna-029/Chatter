import { useCallback, useRef, useEffect, useState } from "react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { useVoiceSettings } from "@/hooks/useVoiceSettings";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

interface PeerStats {
  rtt: number | null;
  bitrate: number | null;
  packetsLost: number | null;
  framesPerSecond: number | null;
  resolution: string | null;
  connectionState: string;
}

const WEBRTC_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

const VOICE_SUBSCRIBE_RETRY_MS = 1000;
const SCREEN_SUBSCRIBE_RETRY_MS = 1000;

export function VoiceControls() {
  const { state, dispatch, wsRef, loadVoiceMembers } = useAppContext();
  const localStreamRef = useRef<MediaStream | null>(null);
  const voicePublisherPcRef = useRef<RTCPeerConnection | null>(null);
  const voiceSubscriberPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const voiceAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const voiceUserVolumesRef = useRef<Record<string, number>>({});
  const pendingVoiceSubsRef = useRef<Set<string>>(new Set());
  const voiceRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Screen share
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenPubPcRef = useRef<RTCPeerConnection | null>(null);
  const screenSubPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingScreenSubsRef = useRef<Set<string>>(new Set());
  const { settings } = useVoiceSettings();
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [debugOpen, setDebugOpen] = useState(false);
  const [screenFps, setScreenFps] = useState<30 | 60>(30);
  const [connStats, setConnStats] = useState<Record<string, PeerStats>>({});
  const [voiceMembersExpanded, setVoiceMembersExpanded] = useState(true);
  const prevBytesRef = useRef<Record<string, number>>({});

  // Refs to avoid stale closures in useCallback / timers
  const inVoiceRef = useRef(state.inVoiceChannel);
  const currentRoomRef = useRef(state.currentRoomId);
  useEffect(() => { inVoiceRef.current = state.inVoiceChannel; }, [state.inVoiceChannel]);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);
  const prevTimestampRef = useRef<Record<string, number>>({});

  // Speaking detection
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalysersRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>>(new Map());

  const canSignal = () => wsRef.current && wsRef.current.readyState === WebSocket.OPEN;

  // ─── Connection stats polling ───────────────────────────────────────────────
  useEffect(() => {
    if (!state.inVoiceChannel) {
      setConnStats({});
      prevBytesRef.current = {};
      prevTimestampRef.current = {};
      return;
    }

    const pollStats = async () => {
      const pcs: [string, RTCPeerConnection | null][] = [
        ["voice-pub", voicePublisherPcRef.current],
      ];
      voiceSubscriberPcsRef.current.forEach((pc, uid) => pcs.push([`voice-sub:${uid}`, pc]));
      pcs.push(["screen-pub", screenPubPcRef.current]);
      screenSubPcsRef.current.forEach((pc, uid) => pcs.push([`screen-sub:${uid}`, pc]));

      const next: Record<string, PeerStats> = {};
      const now = performance.now();

      for (const [key, pc] of pcs) {
        if (!pc) continue;
        try {
          const stats = await pc.getStats();
          let rtt: number | null = null;
          let packetsLost: number | null = null;
          let fps: number | null = null;
          let resolution: string | null = null;
          let totalBytes = 0;

          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.nominated) {
              if (report.currentRoundTripTime != null) rtt = report.currentRoundTripTime;
            }
            if (report.type === "inbound-rtp" || report.type === "outbound-rtp") {
              if (report.packetsLost != null) packetsLost = report.packetsLost;
              if (report.framesPerSecond != null) fps = report.framesPerSecond;
              if (report.frameWidth && report.frameHeight) {
                resolution = `${report.frameWidth}x${report.frameHeight}`;
              }
              const bytes = report.bytesReceived ?? report.bytesSent ?? 0;
              totalBytes += bytes;
            }
          });

          let bitrate: number | null = null;
          const prevBytes = prevBytesRef.current[key];
          const prevTs = prevTimestampRef.current[key];
          if (prevBytes != null && prevTs != null) {
            const dt = (now - prevTs) / 1000;
            if (dt > 0) bitrate = (totalBytes - prevBytes) / dt;
          }
          prevBytesRef.current[key] = totalBytes;
          prevTimestampRef.current[key] = now;

          next[key] = { rtt, bitrate, packetsLost, framesPerSecond: fps, resolution, connectionState: pc.connectionState };
        } catch {}
      }
      setConnStats(next);
    };

    pollStats();
    const id = setInterval(pollStats, 2000);
    return () => clearInterval(id);
  }, [state.inVoiceChannel]);

  // ─── Speaking detection via AnalyserNode ────────────────────────────────────
  useEffect(() => {
    if (!state.inVoiceChannel) {
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
      if (localAnalyserRef.current && state.userId) {
        localAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        if (sum / dataArray.length > SPEAKING_THRESHOLD) {
          next.add(state.userId);
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
  }, [state.inVoiceChannel, state.userId]);

  // Attach analysers to remote audio streams when they arrive
  useEffect(() => {
    if (!state.inVoiceChannel || !audioContextRef.current) return;

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

  // ─── WS Message handler for WebRTC signaling ──────────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
      // Voice WebRTC signaling
      if (msg.type === "voice_webrtc_publish_answer" && voicePublisherPcRef.current) {
        try {
          await voicePublisherPcRef.current.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        } catch {}
      } else if (msg.type === "voice_webrtc_publish_candidate" && voicePublisherPcRef.current) {
        try { await voicePublisherPcRef.current.addIceCandidate(msg.candidate); } catch {}
      } else if (msg.type === "voice_webrtc_subscribe_answer") {
        const pc = voiceSubscriberPcsRef.current.get(msg.speaker_user_id);
        if (pc && msg.sdp) {
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            pendingVoiceSubsRef.current.delete(msg.speaker_user_id);
          } catch {}
        }
      } else if (msg.type === "voice_webrtc_subscribe_candidate") {
        const pc = voiceSubscriberPcsRef.current.get(msg.speaker_user_id);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch {}
        }
      } else if (msg.type === "voice_webrtc_publishers_list") {
        if (msg.publishers && state.inVoiceChannel) {
          for (const uid of msg.publishers) {
            if (uid !== state.userId) createVoiceSub(uid);
          }
        }
      } else if (msg.type === "voice_webrtc_publisher_ready") {
        if (state.inVoiceChannel && msg.user_id !== state.userId) {
          // Clean up any previously failed attempt so we can retry fresh
          const oldPc = voiceSubscriberPcsRef.current.get(msg.user_id);
          if (oldPc) {
            try { oldPc.close(); } catch {}
            voiceSubscriberPcsRef.current.delete(msg.user_id);
          }
          pendingVoiceSubsRef.current.delete(msg.user_id);
          const timer = voiceRetryTimersRef.current.get(msg.user_id);
          if (timer) {
            clearTimeout(timer);
            voiceRetryTimersRef.current.delete(msg.user_id);
          }
          createVoiceSub(msg.user_id);
        }
      } else if (msg.type === "voice_webrtc_error") {
        console.warn("[voice] WebRTC error:", msg.detail || msg);
        if (msg.scope === "subscribe" && msg.speaker_user_id) {
          const failedPc = voiceSubscriberPcsRef.current.get(msg.speaker_user_id);
          if (failedPc) {
            try { failedPc.close(); } catch {}
            voiceSubscriberPcsRef.current.delete(msg.speaker_user_id);
          }
          pendingVoiceSubsRef.current.delete(msg.speaker_user_id);
          scheduleVoiceRetry(msg.speaker_user_id);
        }
      }
      // Screen WebRTC signaling
      if (msg.type === "screen_webrtc_publish_answer" && screenPubPcRef.current) {
        try { await screenPubPcRef.current.setRemoteDescription({ type: "answer", sdp: msg.sdp }); } catch {}
      } else if (msg.type === "screen_webrtc_publish_candidate" && screenPubPcRef.current) {
        try { await screenPubPcRef.current.addIceCandidate(msg.candidate); } catch {}
      } else if (msg.type === "screen_webrtc_subscribe_answer") {
        const pc = screenSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.sdp) {
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            pendingScreenSubsRef.current.delete(msg.sharer_user_id);
          } catch {}
        }
      } else if (msg.type === "screen_webrtc_subscribe_candidate") {
        const pc = screenSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch {}
        }
      } else if (msg.type === "screen_webrtc_publisher_ready") {
        // The sharer's track is now ready on the server — safe to subscribe
        if (state.inVoiceChannel && msg.user_id !== state.userId) {
          const sharerId = msg.user_id;
          // Clean up any previously failed attempt so we can retry fresh
          const oldPc = screenSubPcsRef.current.get(sharerId);
          if (oldPc) {
            try { oldPc.close(); } catch {}
            screenSubPcsRef.current.delete(sharerId);
          }
          pendingScreenSubsRef.current.delete(sharerId);
          // Clear old stream so a fresh one is created on resubscribe
          screenStreamsMap.delete(sharerId);
          // Cancel any pending retry timer
          const timer = screenRetryTimersRef.current.get(sharerId);
          if (timer) {
            clearTimeout(timer);
            screenRetryTimersRef.current.delete(sharerId);
          }
          ensureScreenSub(sharerId);
        }
      } else if (msg.type === "screen_webrtc_error") {
        console.warn("[screen-share] WebRTC error:", msg.detail || msg);
        if (msg.scope === "subscribe" && msg.sharer_user_id) {
          // Clean up the failed subscription so we can retry
          const failedPc = screenSubPcsRef.current.get(msg.sharer_user_id);
          if (failedPc) {
            try { failedPc.close(); } catch {}
            screenSubPcsRef.current.delete(msg.sharer_user_id);
          }
          pendingScreenSubsRef.current.delete(msg.sharer_user_id);
          screenStreamsMap.delete(msg.sharer_user_id);
          // Schedule retry if the sharer is still active
          scheduleScreenRetry(msg.sharer_user_id);
        } else if (msg.scope === "publish") {
          // Publisher error -- stop screen sharing on our end
          if (state.isScreenSharing) {
            stopScreenShare();
          }
        }
      }
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId]);

  // ─── Voice publisher ──────────────────────────────────────────────────────
  const createVoicePublisher = useCallback(async () => {
    if (!localStreamRef.current || !canSignal()) return;
    const pc = new RTCPeerConnection(WEBRTC_CONFIG);
    voicePublisherPcRef.current = pc;
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) pc.addTrack(audioTrack, localStreamRef.current!);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal()) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_publish_candidate",
        room_id: currentRoomRef.current,
        candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex, usernameFragment: ev.candidate.usernameFragment },
      }));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsRef.current!.send(JSON.stringify({
      type: "voice_webrtc_publish_offer",
      room_id: currentRoomRef.current,
      sdp: offer.sdp,
    }));
  }, []);

  // ─── Voice subscriber ─────────────────────────────────────────────────────
  const createVoiceSub = useCallback((speakerUserId: string) => {
    if (speakerUserId === state.userId || !canSignal()) return;
    if (voiceSubscriberPcsRef.current.has(speakerUserId) || pendingVoiceSubsRef.current.has(speakerUserId)) return;

    const pc = new RTCPeerConnection(WEBRTC_CONFIG);
    voiceSubscriberPcsRef.current.set(speakerUserId, pc);
    pendingVoiceSubsRef.current.add(speakerUserId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal()) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_candidate",
        room_id: currentRoomRef.current,
        speaker_user_id: speakerUserId,
        candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex, usernameFragment: ev.candidate.usernameFragment },
      }));
    };

    pc.ontrack = (ev) => {
      let audioEl = voiceAudioElementsRef.current.get(speakerUserId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        voiceAudioElementsRef.current.set(speakerUserId, audioEl);
      }
      audioEl.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      audioEl.volume = voiceUserVolumesRef.current[speakerUserId] ?? 1.0;
      audioEl.play().catch(() => {});
    };

    // Detect failed or stuck connections and retry
    pc.onconnectionstatechange = () => {
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      if (pc.connectionState === "failed") {
        try { pc.close(); } catch {}
        voiceSubscriberPcsRef.current.delete(speakerUserId);
        pendingVoiceSubsRef.current.delete(speakerUserId);
        scheduleVoiceRetry(speakerUserId);
      }
    };

    // Timeout: if still "new" after 5s, the signaling was lost — tear down and retry
    setTimeout(() => {
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      if (pc.connectionState === "new") {
        console.warn("[voice] Subscription to", speakerUserId, "stuck in 'new', retrying");
        try { pc.close(); } catch {}
        voiceSubscriberPcsRef.current.delete(speakerUserId);
        pendingVoiceSubsRef.current.delete(speakerUserId);
        scheduleVoiceRetry(speakerUserId);
      }
    }, 5000);

    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      // Guard: if this PC was replaced before the offer resolved, don't send a stale offer
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      await pc.setLocalDescription(offer);
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_offer",
        room_id: currentRoomRef.current,
        speaker_user_id: speakerUserId,
        sdp: offer.sdp,
      }));
    }).catch(() => {});
  }, [state.userId]);

  const scheduleVoiceRetryRef = useRef<(speakerUserId: string) => void>(() => {});
  scheduleVoiceRetryRef.current = (speakerUserId: string) => {
    if (voiceRetryTimersRef.current.has(speakerUserId)) return;
    if (voiceSubscriberPcsRef.current.has(speakerUserId)) return;

    const timer = setTimeout(() => {
      voiceRetryTimersRef.current.delete(speakerUserId);
      if (
        inVoiceRef.current &&
        speakerUserId !== state.userId &&
        !voiceSubscriberPcsRef.current.has(speakerUserId) &&
        !pendingVoiceSubsRef.current.has(speakerUserId)
      ) {
        console.log("[voice] Retrying subscription to", speakerUserId);
        createVoiceSub(speakerUserId);
      }
    }, VOICE_SUBSCRIBE_RETRY_MS);

    voiceRetryTimersRef.current.set(speakerUserId, timer);
  };
  const scheduleVoiceRetry = (speakerUserId: string) => scheduleVoiceRetryRef.current(speakerUserId);

  // ─── Join/Leave voice ─────────────────────────────────────────────────────
  const joinVoice = useCallback(async () => {
    if (!state.currentRoomId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.inputDeviceId !== "default" ? { exact: settings.inputDeviceId } : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppressionMode === "browser",
          autoGainControl: settings.autoGainControl,
          sampleRate: 48000,
        },
        video: false,
      });
      localStreamRef.current = stream;

      dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: true, isMuted: false } });

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "voice_join", room_id: state.currentRoomId }));
      }
      await createVoicePublisher();
      await loadVoiceMembers();
    } catch {
      alert("Could not access microphone. Please check permissions.");
    }
  }, [state.currentRoomId, createVoicePublisher, loadVoiceMembers, dispatch]);

  const leaveVoice = useCallback(async () => {
    // Stop screen sharing
    if (state.isScreenSharing) await stopScreenShare();

    // Close voice peers
    if (voicePublisherPcRef.current) {
      voicePublisherPcRef.current.close();
      voicePublisherPcRef.current = null;
    }
    voiceSubscriberPcsRef.current.forEach((pc) => pc.close());
    voiceSubscriberPcsRef.current.clear();
    voiceAudioElementsRef.current.forEach((el) => { el.srcObject = null; });
    voiceAudioElementsRef.current.clear();
    voiceRetryTimersRef.current.forEach((t) => clearTimeout(t));
    voiceRetryTimersRef.current.clear();
    pendingVoiceSubsRef.current.clear();

    // Close screen peers
    screenSubPcsRef.current.forEach((pc) => pc.close());
    screenSubPcsRef.current.clear();
    screenRetryTimersRef.current.forEach((t) => clearTimeout(t));
    screenRetryTimersRef.current.clear();
    pendingScreenSubsRef.current.clear();
    screenStreamsMap.clear();
    dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false, sharer: null } });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: false, isMuted: false, isScreenSharing: false } });

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "voice_leave", room_id: state.currentRoomId }));
    }
    await loadVoiceMembers();
  }, [state.currentRoomId, state.isScreenSharing, dispatch, loadVoiceMembers]);

  // ─── Mute ─────────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const newMuted = !state.isMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !newMuted; });
    dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: newMuted } });
    const muteSound = new Audio(newMuted ? "/external/mute.wav" : "/external/unmute.wav");
    muteSound.volume = 0.2;
    muteSound.play().catch(() => {});
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, muted: newMuted }));
    }
  }, [state.isMuted, state.currentRoomId, dispatch]);

  // ─── PTT ──────────────────────────────────────────────────────────────────
  const toggleInputMode = useCallback(() => {
    const newMode = state.voiceInputMode === "open" ? "ptt" : "open";
    if (newMode === "ptt" && localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = false; });
      dispatch({ type: "SET_VOICE_STATE", payload: { voiceInputMode: "ptt", isMuted: true } });
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, muted: true }));
      }
    } else {
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = true; });
      }
      dispatch({ type: "SET_VOICE_STATE", payload: { voiceInputMode: "open", isMuted: false } });
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, muted: false }));
      }
    }
  }, [state.voiceInputMode, state.currentRoomId, dispatch]);

  // PTT key handling
  useEffect(() => {
    if (!state.inVoiceChannel || state.voiceInputMode !== "ptt") return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "`" && !e.repeat) {
        localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = true; });
        dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: false } });
        const unmuteSound = new Audio("/external/unmute.wav");
        unmuteSound.volume = 0.2;
        unmuteSound.play().catch(() => {});
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, muted: false }));
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "`") {
        localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
        dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: true } });
        const muteSound = new Audio("/external/mute.wav");
        muteSound.volume = 0.2;
        muteSound.play().catch(() => {});
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, muted: true }));
        }
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [state.inVoiceChannel, state.voiceInputMode, state.currentRoomId, dispatch]);

  // ─── Screen share ─────────────────────────────────────────────────────────
  const startScreenShare = useCallback(async () => {
    if (!state.inVoiceChannel || !canSignal()) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: screenFps } } as any,
        audio: true,
      });
      screenStreamRef.current = stream;
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: true } });
      wsRef.current!.send(JSON.stringify({ type: "screen_share_start", room_id: state.currentRoomId }));

      const screenTrack = stream.getVideoTracks()[0];
      screenTrack.onended = () => stopScreenShare();

      // Publish via WebRTC
      const pc = new RTCPeerConnection(WEBRTC_CONFIG);
      screenPubPcRef.current = pc;
      pc.addTrack(screenTrack, stream);
      // Add system audio track if available (user may decline or browser may not support it)
      const screenAudioTrack = stream.getAudioTracks()[0];
      if (screenAudioTrack) pc.addTrack(screenAudioTrack, stream);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !canSignal()) return;
        wsRef.current!.send(JSON.stringify({ type: "screen_webrtc_publish_candidate", room_id: state.currentRoomId, candidate: ev.candidate.toJSON() }));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current!.send(JSON.stringify({ type: "screen_webrtc_publish_offer", room_id: state.currentRoomId, sdp: offer.sdp }));
    } catch (err: any) {
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
      if (err.name !== "NotAllowedError") alert("Could not start screen sharing: " + err.message);
    }
  }, [state.inVoiceChannel, state.currentRoomId, screenFps, dispatch]);

  const stopScreenShare = useCallback(async () => {
    dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
    if (screenPubPcRef.current) { screenPubPcRef.current.close(); screenPubPcRef.current = null; }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      screenStreamRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "screen_share_stop", room_id: state.currentRoomId }));
    }
  }, [state.currentRoomId, dispatch]);

  // Subscribe to screen shares from other users
  useEffect(() => {
    if (!state.inVoiceChannel) return;
    for (const sharerId of state.activeScreenSharers) {
      if (
        sharerId !== state.userId &&
        !screenSubPcsRef.current.has(sharerId) &&
        !pendingScreenSubsRef.current.has(sharerId) &&
        !screenRetryTimersRef.current.has(sharerId)
      ) {
        ensureScreenSub(sharerId);
      }
    }
    // Clean up subscriptions for sharers who stopped
    screenSubPcsRef.current.forEach((pc, sharerId) => {
      if (!state.activeScreenSharers.includes(sharerId)) {
        pc.close();
        screenSubPcsRef.current.delete(sharerId);
        pendingScreenSubsRef.current.delete(sharerId);
        screenStreamsMap.delete(sharerId);
      }
    });
  }, [state.activeScreenSharers, state.inVoiceChannel, state.userId]);

  const ensureScreenSub = (sharerId: string) => {
    if (!canSignal() || sharerId === state.userId) return;
    // Guard: don't create duplicate subscriptions
    if (screenSubPcsRef.current.has(sharerId) || pendingScreenSubsRef.current.has(sharerId)) return;

    const pc = new RTCPeerConnection(WEBRTC_CONFIG);
    screenSubPcsRef.current.set(sharerId, pc);
    pendingScreenSubsRef.current.add(sharerId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal()) return;
      wsRef.current!.send(JSON.stringify({
        type: "screen_webrtc_subscribe_candidate",
        room_id: state.currentRoomId,
        sharer_user_id: sharerId,
        candidate: ev.candidate.toJSON(),
      }));
    };

    pc.ontrack = (ev) => {
      // Accumulate tracks into a single stream per sharer.
      // ontrack fires once per track (video, then audio). If we overwrite
      // the map entry each time, the second call can replace the video
      // stream with an audio-only stream, causing a blank screen.
      let stream = screenStreamsMap.get(sharerId);
      if (stream) {
        if (ev.track && !stream.getTrackById(ev.track.id)) {
          stream.addTrack(ev.track);
        }
      } else {
        stream = ev.streams[0] || new MediaStream([ev.track]);
        screenStreamsMap.set(sharerId, stream);
      }
      // Notify ScreenShareViewer to re-render
      window.dispatchEvent(new CustomEvent("screen-stream-update"));
    };

    // Detect failed or stuck connections and retry
    pc.onconnectionstatechange = () => {
      if (pc !== screenSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "failed") {
        try { pc.close(); } catch {}
        screenSubPcsRef.current.delete(sharerId);
        pendingScreenSubsRef.current.delete(sharerId);
        screenStreamsMap.delete(sharerId);
        window.dispatchEvent(new CustomEvent("screen-stream-update"));
        scheduleScreenRetry(sharerId);
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      // Guard: if this PC was replaced before the offer resolved, don't send a stale offer
      if (pc !== screenSubPcsRef.current.get(sharerId)) return;
      await pc.setLocalDescription(offer);
      wsRef.current!.send(JSON.stringify({
        type: "screen_webrtc_subscribe_offer",
        room_id: state.currentRoomId,
        sharer_user_id: sharerId,
        sdp: offer.sdp,
      }));
    }).catch(() => {});
  };

  const scheduleScreenRetry = (sharerId: string) => {
    // Don't schedule if we already have a retry timer or active connection
    if (screenRetryTimersRef.current.has(sharerId)) return;
    if (screenSubPcsRef.current.has(sharerId)) return;

    const timer = setTimeout(() => {
      screenRetryTimersRef.current.delete(sharerId);
      // Only retry if still in voice and the sharer is still active
      if (
        state.inVoiceChannel &&
        state.activeScreenSharers.includes(sharerId) &&
        sharerId !== state.userId &&
        !screenSubPcsRef.current.has(sharerId) &&
        !pendingScreenSubsRef.current.has(sharerId)
      ) {
        console.log("[screen-share] Retrying subscription to", sharerId);
        ensureScreenSub(sharerId);
      }
    }, SCREEN_SUBSCRIBE_RETRY_MS);

    screenRetryTimersRef.current.set(sharerId, timer);
  };

  // Notify ScreenShareViewer when streams change
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("screen-stream-update"));
  }, [state.activeScreenSharers]);

  // Auto-close viewer when no more sharers (excluding self)
  useEffect(() => {
    const otherSharers = state.activeScreenSharers.filter((id) => id !== state.userId);
    if (otherSharers.length === 0) {
      screenStreamsMap.clear();
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false, sharer: null } });
    }
  }, [state.activeScreenSharers, state.userId, dispatch]);

  const watchUser = useCallback(async (sharerId: string) => {
    // Toggle: if already watching this user, close the viewer
    if (state.selectedScreenSharer === sharerId && state.screenViewerOpen) {
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false } });
    } else {
      // Auto-join voice if not already in voice channel (required for screen subscriptions)
      if (!state.inVoiceChannel) {
        await joinVoice();
      }
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true, sharer: sharerId } });
    }
  }, [state.selectedScreenSharer, state.screenViewerOpen, state.inVoiceChannel, dispatch, joinVoice]);

  const setUserVolume = (userId: string, vol: number) => {
    voiceUserVolumesRef.current[userId] = vol;
    const audioEl = voiceAudioElementsRef.current.get(userId);
    if (audioEl) audioEl.volume = vol;
    setVolumes((v) => ({ ...v, [userId]: vol }));
  };

  if (!state.currentRoomId) return null;

  const shortenId = (id: string) => id.split(":")[0]?.replace("@", "") || id;

  return (
    <div className="flex flex-col">
      {/* Voice controls bar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button
          size="sm"
          variant={state.inVoiceChannel ? "destructive" : "default"}
          onClick={state.inVoiceChannel ? leaveVoice : joinVoice}
          className="text-xs"
        >
          {state.inVoiceChannel ? "🔇 Leave Voice" : "🔊 Join Voice"}
        </Button>

        {state.inVoiceChannel && (
          <>
            {state.voiceInputMode === "open" && (
              <Button
                size="sm"
                variant={state.isMuted ? "destructive" : "outline"}
                onClick={toggleMute}
                className="text-xs"
              >
                {state.isMuted ? "🔇 Unmute" : "🎤 Mute"}
              </Button>
            )}

            <Button
              size="sm"
              variant={state.voiceInputMode === "ptt" ? "secondary" : "outline"}
              onClick={toggleInputMode}
              className="text-xs"
            >
              {state.voiceInputMode === "ptt" ? "🔑 PTT (`)" : "🎙 Open Mic"}
            </Button>

            <div className="flex items-center">
              <Button
                size="sm"
                variant={state.isScreenSharing ? "destructive" : "outline"}
                onClick={state.isScreenSharing ? stopScreenShare : startScreenShare}
                className="text-xs rounded-r-none"
              >
                {state.isScreenSharing ? "🖥️ Stop Sharing" : `🖥️ Share (${screenFps}fps)`}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant={state.isScreenSharing ? "destructive" : "outline"}
                    className="text-xs rounded-l-none border-l-0 px-1.5"
                  >
                    ▾
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup value={String(screenFps)} onValueChange={(v) => setScreenFps(Number(v) as 30 | 60)}>
                    <DropdownMenuRadioItem value="30">30 FPS</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="60">60 FPS</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {state.voiceInputMode === "ptt" && !state.isMuted && (
              <span className="text-xs text-green-500 font-semibold animate-pulse">
                🔊 Transmitting
              </span>
            )}

            <Button
              size="sm"
              variant={debugOpen ? "secondary" : "ghost"}
              onClick={() => setDebugOpen((o) => !o)}
              className="text-xs"
            >
              Debug
            </Button>
          </>
        )}
      </div>

      {/* Debug panel */}
      {debugOpen && state.inVoiceChannel && Object.keys(connStats).length > 0 && (
        <div className="border-b px-4 py-2 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            WebRTC Connections
          </p>
          <div className="grid gap-1">
            {Object.entries(connStats).map(([key, s]) => {
              let label = key;
              if (key === "voice-pub") label = "Voice Pub";
              else if (key === "screen-pub") label = "Screen Pub";
              else if (key.startsWith("voice-sub:")) label = `Voice Sub: ${shortenId(key.replace("voice-sub:", ""))}`;
              else if (key.startsWith("screen-sub:")) label = `Screen Sub: ${shortenId(key.replace("screen-sub:", ""))}`;

              return (
                <div key={key} className="flex flex-wrap items-center gap-3 text-xs font-mono">
                  <span className="font-semibold min-w-[120px]">{label}</span>
                  <span className="text-muted-foreground">{s.connectionState}</span>
                  <span>RTT: {s.rtt != null ? `${Math.round(s.rtt * 1000)}ms` : "—"}</span>
                  <span>↕ {s.bitrate != null ? `${Math.round(s.bitrate * 8 / 1000)}kbps` : "—"}</span>
                  <span>Lost: {s.packetsLost ?? "—"}</span>
                  {s.framesPerSecond != null && <span>{s.framesPerSecond}fps</span>}
                  {s.resolution && <span>{s.resolution}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Voice members list */}
      {state.voiceMembers.length > 0 && (
        <div className="border-b px-4 py-2">
          <button
            onClick={() => setVoiceMembersExpanded((o) => !o)}
            className="flex w-full items-center justify-between mb-2 group"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                In Voice Channel
              </span>
              <span className="inline-flex items-center rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {state.voiceMembers.length}
              </span>
            </div>
            <ChevronDown className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-muted-foreground transition-all duration-200",
              !voiceMembersExpanded && "-rotate-90"
            )} />
          </button>

          {voiceMembersExpanded && (
            <div className="space-y-1">
              {state.voiceMembers.map((memberId) => {
                const name = shortenId(memberId);
                const isSelf = memberId === state.userId;
                const memberState = state.voiceMemberStates[memberId];
                const isMutedMember = memberState?.muted || (isSelf && state.isMuted);
                const isSharing = memberState?.screen_sharing || state.activeScreenSharers.includes(memberId);
                const vol = volumes[memberId] ?? 1;
                const isSpeaking = speakingUsers.has(memberId) && !isMutedMember;
                const isWatching = state.selectedScreenSharer === memberId && state.screenViewerOpen;

                return (
                  <div key={memberId} className={cn(
                    "flex flex-col rounded-md px-1 -mx-1 py-0.5 transition-shadow duration-150",
                    isSpeaking && "shadow-[0_0_8px_2px_rgba(34,197,94,0.5)]"
                  )}>
                    {/* Top row: mute icon, latency dot, name, sharing badge */}
                    <div className="flex items-center gap-1.5 text-sm">
                      <span className={cn("text-xs flex-shrink-0", isMutedMember ? "text-destructive" : isSpeaking ? "text-green-500" : "")}>
                        {isMutedMember ? "🔇" : "🎤"}
                      </span>
                      {(() => {
                        const statsKey = isSelf ? "voice-pub" : `voice-sub:${memberId}`;
                        const rtt = connStats[statsKey]?.rtt;
                        const rttMs = rtt != null ? Math.round(rtt * 1000) : null;
                        const dotColor = rttMs == null
                          ? "text-muted-foreground"
                          : rttMs < 100
                            ? "text-green-500"
                            : rttMs <= 300
                              ? "text-orange-500"
                              : "text-red-500";
                        return (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={cn("text-[8px] leading-none flex-shrink-0", dotColor)}>●</span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">
                                {rttMs != null ? `${rttMs}ms` : "No data"}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        );
                      })()}
                      <span className={cn("flex-1 truncate min-w-0", isSpeaking && "text-green-400 font-semibold")}>
                        {name}{isSelf && " (You)"}
                      </span>
                      {isSharing && isSelf && (
                        <span className="text-xs text-purple-400 font-semibold px-1.5 py-0.5 rounded-md bg-purple-500/10 flex-shrink-0">
                          📺 Sharing
                        </span>
                      )}
                    </div>
                    {/* Bottom row: volume slider + watch button, indented under name */}
                    {!isSelf && (
                      <div className="flex items-center gap-1.5 pl-5 mt-0.5">
                        <Slider
                          value={[vol * 100]}
                          onValueChange={([v]) => setUserVolume(memberId, v / 100)}
                          max={100}
                          step={1}
                          className="w-16"
                        />
                        <span className="text-xs text-muted-foreground w-7 text-right">
                          {Math.round(vol * 100)}%
                        </span>
                        {isSharing && (
                          <Button
                            size="sm"
                            variant={isWatching ? "secondary" : "outline"}
                            onClick={(e) => {
                              e.stopPropagation();
                              watchUser(memberId);
                            }}
                            className={cn(
                              "h-5 px-1.5 text-[10px] font-semibold ml-auto flex-shrink-0",
                              isWatching
                                ? "bg-purple-600 text-white hover:bg-purple-700 border-purple-600"
                                : "border-purple-500/50 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300"
                            )}
                            title={isWatching ? `Stop watching ${name}'s screen` : `Watch ${name}'s screen`}
                          >
                            📺 {isWatching ? "Watching" : "Watch"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
