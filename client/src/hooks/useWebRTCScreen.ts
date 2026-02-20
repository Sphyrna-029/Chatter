import { useCallback, useRef, useEffect, useState } from "react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { WEBRTC_CONFIG, SCREEN_SUBSCRIBE_RETRY_MS, canSignal, mungeScreenAudioSdp } from "@/lib/webrtc";
import type { PeerStats } from "@/lib/webrtc";

export function useWebRTCScreen() {
  const { state, dispatch, wsRef } = useAppContext();

  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenPubPcRef = useRef<RTCPeerConnection | null>(null);
  const screenSubPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingScreenSubsRef = useRef<Set<string>>(new Set());
  const [screenFps, setScreenFps] = useState<30 | 60>(30);

  // Ref for frozen detection external stats
  const connStatsRef = useRef<Record<string, PeerStats>>({});

  // Refs to avoid stale closures
  const currentRoomRef = useRef(state.currentRoomId);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);

  const ensureScreenSub = (sharerId: string) => {
    if (!canSignal(wsRef) || sharerId === state.userId) return;
    // Guard: don't create duplicate subscriptions
    if (screenSubPcsRef.current.has(sharerId) || pendingScreenSubsRef.current.has(sharerId)) return;

    const pc = new RTCPeerConnection(WEBRTC_CONFIG);
    screenSubPcsRef.current.set(sharerId, pc);
    pendingScreenSubsRef.current.add(sharerId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "screen_webrtc_subscribe_candidate",
        room_id: state.currentRoomId,
        sharer_user_id: sharerId,
        candidate: ev.candidate.toJSON(),
      }));
    };

    pc.ontrack = (ev) => {
      // Accumulate tracks into a single stream per sharer.
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

  // ─── WS Message handler for Screen WebRTC signaling ────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
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
          // Clean up any previously failed attempt
          const oldPc = screenSubPcsRef.current.get(sharerId);
          if (oldPc) {
            try { oldPc.close(); } catch {}
            screenSubPcsRef.current.delete(sharerId);
          }
          pendingScreenSubsRef.current.delete(sharerId);
          screenStreamsMap.delete(sharerId);
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
          const failedPc = screenSubPcsRef.current.get(msg.sharer_user_id);
          if (failedPc) {
            try { failedPc.close(); } catch {}
            screenSubPcsRef.current.delete(msg.sharer_user_id);
          }
          pendingScreenSubsRef.current.delete(msg.sharer_user_id);
          screenStreamsMap.delete(msg.sharer_user_id);
          scheduleScreenRetry(msg.sharer_user_id);
        } else if (msg.scope === "publish") {
          if (state.isScreenSharing) {
            stopScreenShare();
          }
        }
      }
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId]);

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
    // Also cancel pending retry timers for sharers who stopped
    screenRetryTimersRef.current.forEach((timer, sharerId) => {
      if (!state.activeScreenSharers.includes(sharerId)) {
        clearTimeout(timer);
        screenRetryTimersRef.current.delete(sharerId);
        pendingScreenSubsRef.current.delete(sharerId);
      }
    });
  }, [state.activeScreenSharers, state.inVoiceChannel, state.userId]);

  // Notify ScreenShareViewer when streams change
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("screen-stream-update"));
  }, [state.activeScreenSharers]);

  // Auto-close viewer when no more sharers, or switch away from a sharer who left
  useEffect(() => {
    if (state.activeScreenSharers.length === 0) {
      screenStreamsMap.forEach((_stream, id) => {
        if (!state.activeScreenSharers.includes(id)) {
          screenStreamsMap.delete(id);
        }
      });
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false, sharer: null } });
    } else if (
      state.screenViewerOpen &&
      state.selectedScreenSharer &&
      !state.activeScreenSharers.includes(state.selectedScreenSharer)
    ) {
      const next = state.activeScreenSharers.includes(state.userId!)
        ? state.userId!
        : state.activeScreenSharers[0];
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { sharer: next } });
    }
  }, [state.activeScreenSharers, state.screenViewerOpen, state.selectedScreenSharer, state.userId, dispatch]);

  // ─── Frozen screen share video detection ──────────────────────────────────
  const frozenCountersRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!state.inVoiceChannel) {
      frozenCountersRef.current = {};
      return;
    }

    const FROZEN_THRESHOLD = 3; // consecutive 0-FPS polls (3 x 2s = 6s)

    const id = setInterval(() => {
      const counters = frozenCountersRef.current;
      const currentStats = connStatsRef.current;
      // Clean up counters for sharers we're no longer subscribed to
      for (const key of Object.keys(counters)) {
        if (!screenSubPcsRef.current.has(key)) {
          delete counters[key];
        }
      }

      for (const [uid, pc] of screenSubPcsRef.current) {
        const statsKey = `screen-sub:${uid}`;
        const stats = currentStats[statsKey];
        if (!stats) continue;

        if (pc.connectionState !== "connected") continue;

        if (stats.framesPerSecond === 0) {
          counters[uid] = (counters[uid] || 0) + 1;
        } else {
          counters[uid] = 0;
        }

        if (counters[uid] >= FROZEN_THRESHOLD) {
          console.warn(`Screen share from ${uid} frozen for ${counters[uid] * 2}s, reconnecting`);
          counters[uid] = 0;
          try { pc.close(); } catch {}
          screenSubPcsRef.current.delete(uid);
          pendingScreenSubsRef.current.delete(uid);
          screenStreamsMap.delete(uid);
          window.dispatchEvent(new CustomEvent("screen-stream-update"));
          scheduleScreenRetry(uid);
        }
      }
    }, 2000);

    return () => clearInterval(id);
  }, [state.inVoiceChannel]);

  // Method to update external stats for frozen detection
  const updateConnStats = useCallback((stats: Record<string, PeerStats>) => {
    connStatsRef.current = stats;
  }, []);

  // ─── Screen share publish/stop ─────────────────────────────────────────────
  const startScreenShare = useCallback(async () => {
    if (!state.inVoiceChannel || !canSignal(wsRef)) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: screenFps } } as any,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
        },
      });
      screenStreamRef.current = stream;
      screenStreamsMap.set(state.userId!, stream);
      window.dispatchEvent(new CustomEvent("screen-stream-update"));
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: true } });
      dispatch({ type: "SCREEN_SHARE_STARTED", payload: state.userId! });
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true, sharer: state.userId! } });
      wsRef.current!.send(JSON.stringify({ type: "screen_share_start", room_id: state.currentRoomId }));

      const screenTrack = stream.getVideoTracks()[0];
      if ('contentHint' in screenTrack) {
        screenTrack.contentHint = "motion";
      }
      screenTrack.onended = () => stopScreenShare();

      const pc = new RTCPeerConnection(WEBRTC_CONFIG);
      screenPubPcRef.current = pc;
      const videoSender = pc.addTrack(screenTrack, stream);
      const screenAudioTrack = stream.getAudioTracks()[0];
      if (screenAudioTrack) {
        pc.addTrack(screenAudioTrack, new MediaStream([screenAudioTrack]));
      }
      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !canSignal(wsRef)) return;
        wsRef.current!.send(JSON.stringify({ type: "screen_webrtc_publish_candidate", room_id: state.currentRoomId, candidate: ev.candidate.toJSON() }));
      };
      const offer = await pc.createOffer();
      const mungedSdp = mungeScreenAudioSdp(offer.sdp!);
      await pc.setLocalDescription({ type: "offer", sdp: mungedSdp });

      try {
        const params = videoSender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].maxBitrate = screenFps >= 60 ? 8_000_000 : 4_000_000;
        }
        params.degradationPreference = "maintain-framerate";
        await videoSender.setParameters(params);
      } catch {}

      wsRef.current!.send(JSON.stringify({ type: "screen_webrtc_publish_offer", room_id: state.currentRoomId, sdp: mungedSdp }));
    } catch (err: any) {
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
      if (err.name !== "NotAllowedError") alert("Could not start screen sharing: " + err.message);
    }
  }, [state.inVoiceChannel, state.currentRoomId, screenFps, dispatch]);

  const stopScreenShare = useCallback(async () => {
    dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
    if (state.userId) {
      screenStreamsMap.delete(state.userId);
      window.dispatchEvent(new CustomEvent("screen-stream-update"));
    }
    if (screenPubPcRef.current) { screenPubPcRef.current.close(); screenPubPcRef.current = null; }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      screenStreamRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "screen_share_stop", room_id: state.currentRoomId }));
    }
  }, [state.currentRoomId, dispatch]);

  const watchUser = useCallback(async (sharerId: string, joinVoice: () => Promise<void>) => {
    if (state.selectedScreenSharer === sharerId && state.screenViewerOpen) {
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false } });
    } else {
      if (!state.inVoiceChannel) {
        await joinVoice();
      }
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true, sharer: sharerId } });
    }
  }, [state.selectedScreenSharer, state.screenViewerOpen, state.inVoiceChannel, dispatch]);

  // Full cleanup for cross-hook coordination (called by leaveVoice)
  const fullCleanup = useCallback(async () => {
    if (state.isScreenSharing) await stopScreenShare();
    screenSubPcsRef.current.forEach((pc) => pc.close());
    screenSubPcsRef.current.clear();
    screenRetryTimersRef.current.forEach((t) => clearTimeout(t));
    screenRetryTimersRef.current.clear();
    pendingScreenSubsRef.current.clear();
    screenStreamsMap.clear();
    dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false, sharer: null } });
  }, [state.isScreenSharing, stopScreenShare, dispatch]);

  return {
    screenPubPcRef,
    screenSubPcsRef,
    screenFps,
    setScreenFps,
    startScreenShare,
    stopScreenShare,
    watchUser,
    fullCleanup,
    updateConnStats,
  };
}
