import { useCallback, useRef, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { useVoiceSettings } from "@/hooks/useVoiceSettings";
import { getWebRTCConfig, VOICE_SUBSCRIBE_RETRY_MS, canSignal } from "@/lib/webrtc";

interface UseWebRTCVoiceOptions {
  cleanupScreenRef: React.MutableRefObject<() => Promise<void>>;
}

export function useWebRTCVoice({ cleanupScreenRef }: UseWebRTCVoiceOptions) {
  const { state, dispatch, wsRef, loadVoiceMembers } = useAppContext();
  const { settings } = useVoiceSettings();

  const localStreamRef = useRef<MediaStream | null>(null);
  const voicePublisherPcRef = useRef<RTCPeerConnection | null>(null);
  const voiceSubscriberPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const voiceAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const voiceUserVolumesRef = useRef<Record<string, number>>({});
  const pendingVoiceSubsRef = useRef<Set<string>>(new Set());
  const voiceRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Refs to avoid stale closures
  const inVoiceRef = useRef(state.inVoiceChannel);
  const currentRoomRef = useRef(state.currentRoomId);
  const voiceRoomIdRef = useRef(state.voiceRoomId);
  const voiceChannelIdRef = useRef(state.voiceChannelId);
  useEffect(() => { inVoiceRef.current = state.inVoiceChannel; }, [state.inVoiceChannel]);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);
  useEffect(() => { voiceRoomIdRef.current = state.voiceRoomId; }, [state.voiceRoomId]);
  useEffect(() => { voiceChannelIdRef.current = state.voiceChannelId; }, [state.voiceChannelId]);

  // ─── Voice publisher ──────────────────────────────────────────────────────
  const createVoicePublisher = useCallback(async () => {
    if (!localStreamRef.current || !canSignal(wsRef)) return;
    const pc = new RTCPeerConnection(getWebRTCConfig());
    voicePublisherPcRef.current = pc;
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) pc.addTrack(audioTrack, localStreamRef.current!);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_publish_candidate",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex, usernameFragment: ev.candidate.usernameFragment },
      }));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsRef.current!.send(JSON.stringify({
      type: "voice_webrtc_publish_offer",
      room_id: voiceRoomIdRef.current || currentRoomRef.current,
      channel_id: voiceChannelIdRef.current || undefined,
      sdp: offer.sdp,
    }));
  }, []);

  // ─── Voice subscriber ─────────────────────────────────────────────────────
  const createVoiceSub = useCallback((speakerUserId: string) => {
    if (speakerUserId === state.userId || !canSignal(wsRef)) return;
    if (voiceSubscriberPcsRef.current.has(speakerUserId) || pendingVoiceSubsRef.current.has(speakerUserId)) return;

    const pc = new RTCPeerConnection(getWebRTCConfig());
    voiceSubscriberPcsRef.current.set(speakerUserId, pc);
    pendingVoiceSubsRef.current.add(speakerUserId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_candidate",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
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
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
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

  // ─── WS Message handler for Voice WebRTC signaling ─────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
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
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId]);

  // ─── Join/Leave voice ─────────────────────────────────────────────────────
  const joinVoice = useCallback(async (channelId?: string) => {
    if (!state.currentRoomId) return;

    // If already in a voice channel, leave it first
    if (inVoiceRef.current) {
      await cleanupScreenRef.current();

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

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const leaveMsg: any = { type: "voice_leave", room_id: voiceRoomIdRef.current || state.currentRoomId };
        if (voiceChannelIdRef.current) leaveMsg.channel_id = voiceChannelIdRef.current;
        wsRef.current.send(JSON.stringify(leaveMsg));
      }
    }

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

      const resolvedChannelId = channelId || state.voiceChannelId || undefined;
      dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: true, isMuted: false, isDeafened: false, voiceRoomId: state.currentRoomId, voiceChannelId: resolvedChannelId ?? null } });
      voiceChannelIdRef.current = resolvedChannelId ?? null;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const joinMsg: any = { type: "voice_join", room_id: state.currentRoomId };
        if (resolvedChannelId) joinMsg.channel_id = resolvedChannelId;
        wsRef.current.send(JSON.stringify(joinMsg));
      }
      await createVoicePublisher();
      await loadVoiceMembers();
    } catch {
      alert("Could not access microphone. Please check permissions.");
    }
  }, [state.currentRoomId, state.voiceChannelId, createVoicePublisher, loadVoiceMembers, dispatch]);

  const leaveVoice = useCallback(async () => {
    // Stop screen sharing via the screen hook cleanup
    await cleanupScreenRef.current();

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

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: false, isMuted: false, isDeafened: false, isScreenSharing: false, voiceRoomId: null, voiceChannelId: null } });

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const leaveMsg: any = { type: "voice_leave", room_id: state.currentRoomId };
      if (state.voiceChannelId) leaveMsg.channel_id = state.voiceChannelId;
      wsRef.current.send(JSON.stringify(leaveMsg));
    }
    await loadVoiceMembers();
  }, [state.currentRoomId, state.voiceChannelId, dispatch, loadVoiceMembers]);

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
      wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, channel_id: voiceChannelIdRef.current || undefined, muted: newMuted }));
    }
  }, [state.isMuted, state.currentRoomId, dispatch]);

  // ─── PTT ──────────────────────────────────────────────────────────────────
  const toggleInputMode = useCallback(() => {
    const newMode = state.voiceInputMode === "open" ? "ptt" : "open";
    if (newMode === "ptt" && localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = false; });
      dispatch({ type: "SET_VOICE_STATE", payload: { voiceInputMode: "ptt", isMuted: true } });
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, channel_id: voiceChannelIdRef.current || undefined, muted: true }));
      }
    } else {
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = true; });
      }
      dispatch({ type: "SET_VOICE_STATE", payload: { voiceInputMode: "open", isMuted: false } });
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, channel_id: voiceChannelIdRef.current || undefined, muted: false }));
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
          wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, channel_id: voiceChannelIdRef.current || undefined, muted: false }));
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
          wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, channel_id: voiceChannelIdRef.current || undefined, muted: true }));
        }
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [state.inVoiceChannel, state.voiceInputMode, state.currentRoomId, dispatch]);

  // ─── Volume control ───────────────────────────────────────────────────────
  const setUserVolume = useCallback((userId: string, vol: number) => {
    voiceUserVolumesRef.current[userId] = vol;
    const audioEl = voiceAudioElementsRef.current.get(userId);
    if (audioEl) audioEl.volume = vol;
  }, []);

  // ─── Deafen ───────────────────────────────────────────────────────────────
  const toggleDeafen = useCallback(() => {
    const newDeafened = !state.isDeafened;
    voiceAudioElementsRef.current.forEach((el) => {
      el.muted = newDeafened;
    });
    dispatch({ type: "SET_VOICE_STATE", payload: { isDeafened: newDeafened } });
  }, [state.isDeafened, dispatch]);

  return {
    localStreamRef,
    voicePublisherPcRef,
    voiceSubscriberPcsRef,
    voiceAudioElementsRef,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    toggleInputMode,
    setUserVolume,
  };
}
