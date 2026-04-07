import { useCallback, useRef, useEffect, useState } from "react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import {
  getWebRTCConfig,
  SCREEN_SUBSCRIBE_RETRY_MS,
  VOICE_SUB_STUCK_NEW_MS,
  VOICE_SUB_STUCK_CONNECTING_MS,
  canSignal,
  getScreenSharePublishProfile,
  mungeScreenAudioSdp,
} from "@/lib/webrtc";
import type { PeerStats, ScreenSharePublishProfile } from "@/lib/webrtc";

function buildDisplayVideoConstraints(
  profile: ScreenSharePublishProfile,
): MediaTrackConstraints {
  return {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: profile.targetFps },
  };
}

function buildDisplayAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 2,
  };
}

async function tuneScreenVideoSender(
  sender: RTCRtpSender,
  profile: ScreenSharePublishProfile,
) {
  try {
    const params = sender.getParameters();
    const baseEncoding = params.encodings?.[0] ?? {};
    const encoding: RTCRtpEncodingParameters = {
      ...baseEncoding,
      maxBitrate: profile.maxBitrateBps,
      maxFramerate: profile.targetFps,
      priority: "high",
      networkPriority: "high",
    };
    params.encodings = [encoding];
    params.degradationPreference = "maintain-resolution";
    await sender.setParameters(params);
  } catch {
    // Browsers differ in which sender parameters are writable.
  }
}

export function useWebRTCScreen() {
  const { state, dispatch, wsRef } = useAppContext();

  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenPubPcRef = useRef<RTCPeerConnection | null>(null);
  const screenSubPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingScreenSubsRef = useRef<Set<string>>(new Set());
  const [screenFps, setScreenFps] = useState<30 | 60>(30);
  const screenShareStartingRef = useRef(false);

  // Ref for frozen detection external stats
  const connStatsRef = useRef<Record<string, PeerStats>>({});

  // Refs to avoid stale closures
  const currentRoomRef = useRef(state.currentRoomId);
  const voiceRoomIdRef = useRef(state.voiceRoomId);
  const inVoiceChannelRef = useRef(state.inVoiceChannel);
  const activeScreenSharersRef = useRef(state.activeScreenSharers);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);
  useEffect(() => { voiceRoomIdRef.current = state.voiceRoomId; }, [state.voiceRoomId]);
  useEffect(() => { inVoiceChannelRef.current = state.inVoiceChannel; }, [state.inVoiceChannel]);
  useEffect(() => { activeScreenSharersRef.current = state.activeScreenSharers; }, [state.activeScreenSharers]);

  const ensureScreenSub = (sharerId: string) => {
    if (!canSignal(wsRef) || sharerId === state.userId) return;
    // Guard: don't create duplicate subscriptions
    if (screenSubPcsRef.current.has(sharerId) || pendingScreenSubsRef.current.has(sharerId)) return;

    const pc = new RTCPeerConnection(getWebRTCConfig());
    screenSubPcsRef.current.set(sharerId, pc);
    pendingScreenSubsRef.current.add(sharerId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "screen_webrtc_subscribe_candidate",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        candidate: ev.candidate.toJSON(),
      }));
    };

    pc.ontrack = (ev) => {
      // Guard: if this PC was replaced, ignore stale track events
      if (pc !== screenSubPcsRef.current.get(sharerId)) return;
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
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        try { pc.close(); } catch { /* noop */ }
        screenSubPcsRef.current.delete(sharerId);
        pendingScreenSubsRef.current.delete(sharerId);
        screenStreamsMap.delete(sharerId);
        window.dispatchEvent(new CustomEvent("screen-stream-update"));
        scheduleScreenRetry(sharerId);
      }
    };

    // Timeout: if still "new" after threshold, signaling was lost — tear down and retry
    setTimeout(() => {
      if (pc !== screenSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "new") {
        console.warn("[screen-share] Subscription to", sharerId, "stuck in 'new', retrying");
        try { pc.close(); } catch {}
        screenSubPcsRef.current.delete(sharerId);
        pendingScreenSubsRef.current.delete(sharerId);
        scheduleScreenRetry(sharerId);
      }
    }, VOICE_SUB_STUCK_NEW_MS);

    // Timeout: if still "connecting" after threshold, ICE negotiation stuck — retry
    setTimeout(() => {
      if (pc !== screenSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "connecting") {
        console.warn("[screen-share] Subscription to", sharerId, "stuck in 'connecting', retrying");
        try { pc.close(); } catch {}
        screenSubPcsRef.current.delete(sharerId);
        pendingScreenSubsRef.current.delete(sharerId);
        scheduleScreenRetry(sharerId);
      }
    }, VOICE_SUB_STUCK_CONNECTING_MS);

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      // Guard: if this PC was replaced before the offer resolved, don't send a stale offer
      if (pc !== screenSubPcsRef.current.get(sharerId)) return;
      await pc.setLocalDescription(offer);
      if (!canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "screen_webrtc_subscribe_offer",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        sdp: offer.sdp,
      }));
    }).catch(() => {
      // Offer creation failed — tear down so retry can start fresh
      try { pc.close(); } catch {}
      screenSubPcsRef.current.delete(sharerId);
      pendingScreenSubsRef.current.delete(sharerId);
      scheduleScreenRetry(sharerId);
    });
  };

  const scheduleScreenRetry = (sharerId: string) => {
    // Don't schedule if we already have a retry timer or active connection
    if (screenRetryTimersRef.current.has(sharerId)) return;
    if (screenSubPcsRef.current.has(sharerId)) return;

    const timer = setTimeout(() => {
      screenRetryTimersRef.current.delete(sharerId);
      // Only retry if still in voice and the sharer is still active
      if (
        inVoiceChannelRef.current &&
        activeScreenSharersRef.current.includes(sharerId) &&
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

  const stopScreenShare = useCallback(async () => {
    dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
    if (state.userId) {
      dispatch({ type: "SCREEN_SHARE_STOPPED", payload: state.userId });
      screenStreamsMap.delete(state.userId);
      window.dispatchEvent(new CustomEvent("screen-stream-update"));
    }
    if (screenPubPcRef.current) { screenPubPcRef.current.close(); screenPubPcRef.current = null; }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      screenStreamRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const screenStopMsg: any = { type: "screen_share_stop", room_id: state.currentRoomId };
      if (state.voiceChannelId) screenStopMsg.channel_id = state.voiceChannelId;
      wsRef.current.send(JSON.stringify(screenStopMsg));
    }
    // Update per-channel voice members locally
    if (state.voiceChannelId && state.userId) {
      const cur = { ...state.voiceChannelMembers };
      cur[state.voiceChannelId] = (cur[state.voiceChannelId] || []).map((m: any) =>
        m.userId === state.userId ? { ...m, screen_sharing: false } : m
      );
      dispatch({ type: "SET_VOICE_CHANNEL_MEMBERS", payload: cur });
    }
  }, [state.currentRoomId, state.userId, state.voiceChannelId, state.voiceChannelMembers, dispatch, wsRef]);

  // ─── WS Message handler for Screen WebRTC signaling ────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg.type === "screen_webrtc_publish_answer" && screenPubPcRef.current) {
        try {
          await screenPubPcRef.current.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          // Re-apply sender parameters — some browsers reset encodings when the answer is applied.
          const profile = getScreenSharePublishProfile(screenFps);
          const videoSender = screenPubPcRef.current.getSenders().find(
            (s) => s.track?.kind === "video",
          );
          if (videoSender) {
            await tuneScreenVideoSender(videoSender, profile);
          }
        } catch { /* noop */ }
      } else if (msg.type === "screen_webrtc_publish_candidate" && screenPubPcRef.current) {
        try { await screenPubPcRef.current.addIceCandidate(msg.candidate); } catch { /* noop */ }
      } else if (msg.type === "screen_webrtc_subscribe_answer") {
        const pc = screenSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.sdp) {
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            pendingScreenSubsRef.current.delete(msg.sharer_user_id);
          } catch { /* noop */ }
        }
      } else if (msg.type === "screen_webrtc_subscribe_candidate") {
        const pc = screenSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch { /* noop */ }
        }
      } else if (msg.type === "screen_webrtc_publisher_ready") {
        // The sharer's track is now ready on the server — safe to subscribe
        if (state.inVoiceChannel && msg.user_id !== state.userId) {
          const sharerId = msg.user_id;
          // Clean up any previously failed attempt
          const oldPc = screenSubPcsRef.current.get(sharerId);
          if (oldPc) {
            try { oldPc.close(); } catch { /* noop */ }
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
            try { failedPc.close(); } catch { /* noop */ }
            screenSubPcsRef.current.delete(msg.sharer_user_id);
          }
          pendingScreenSubsRef.current.delete(msg.sharer_user_id);
          screenStreamsMap.delete(msg.sharer_user_id);
          scheduleScreenRetry(msg.sharer_user_id);
        } else if (msg.scope === "publish") {
          void stopScreenShare();
        }
      }
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId, stopScreenShare, screenFps]);

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

  // Auto-close viewer when no more sharers (only close if no webcam streams either)
  useEffect(() => {
    if (state.activeScreenSharers.length === 0) {
      screenStreamsMap.forEach((_stream, id) => {
        if (!state.activeScreenSharers.includes(id)) {
          screenStreamsMap.delete(id);
        }
      });
      // Only close the viewer if no webcam streams are active
      if (state.activeWebcamStreamers.length === 0) {
        dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false, sharer: null } });
      } else {
        dispatch({ type: "SET_SCREEN_VIEWER", payload: { sharer: null } });
      }
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
  }, [state.activeScreenSharers, state.activeWebcamStreamers, state.screenViewerOpen, state.selectedScreenSharer, state.userId, dispatch]);

  // ─── Frozen screen share video detection ──────────────────────────────────
  const frozenCountersRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!state.inVoiceChannel) {
      frozenCountersRef.current = {};
      return;
    }

    const FROZEN_THRESHOLD = 4; // consecutive suspicious polls (4 x 2s = 8s)
    const STUCK_VIDEO_BITRATE_BPS = 100_000;

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

        // 0 FPS alone is common for static screen content.
        // Only treat it as frozen when packets are still arriving.
        const receivingVideo = (stats.videoBitrate ?? 0) >= STUCK_VIDEO_BITRATE_BPS;
        if (stats.framesPerSecond === 0 && receivingVideo) {
          counters[uid] = (counters[uid] || 0) + 1;
        } else {
          counters[uid] = 0;
        }

        if (counters[uid] >= FROZEN_THRESHOLD) {
          console.warn(`Screen share from ${uid} frozen for ${counters[uid] * 2}s, reconnecting`);
          counters[uid] = 0;
          try { pc.close(); } catch { /* noop */ }
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
    // Prevent concurrent starts
    if (screenShareStartingRef.current) return;
    screenShareStartingRef.current = true;
    const profile = getScreenSharePublishProfile(screenFps);
    try {
      const videoConstraints = buildDisplayVideoConstraints(profile);
      const audioConstraints = buildDisplayAudioConstraints();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: audioConstraints,
      });
      screenStreamRef.current = stream;
      screenStreamsMap.set(state.userId!, stream);
      window.dispatchEvent(new CustomEvent("screen-stream-update"));
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: true } });
      dispatch({ type: "SCREEN_SHARE_STARTED", payload: state.userId! });
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true, sharer: state.userId! } });
      if (canSignal(wsRef)) {
        const screenStartMsg: any = { type: "screen_share_start", room_id: state.currentRoomId };
        if (state.voiceChannelId) screenStartMsg.channel_id = state.voiceChannelId;
        wsRef.current!.send(JSON.stringify(screenStartMsg));
      }

      const screenTrack = stream.getVideoTracks()[0];
      if ("contentHint" in screenTrack) {
        screenTrack.contentHint = profile.contentHint;
      }
      // Guard: only stop if this is still the active stream
      screenTrack.onended = () => {
        if (screenStreamRef.current === stream) stopScreenShare();
      };

      const pc = new RTCPeerConnection(getWebRTCConfig());
      screenPubPcRef.current = pc;
      const videoSender = pc.addTrack(screenTrack, stream);
      await tuneScreenVideoSender(videoSender, profile);

      const screenAudioTrack = stream.getAudioTracks()[0];
      if (screenAudioTrack) {
        if ("contentHint" in screenAudioTrack) {
          screenAudioTrack.contentHint = "music";
        }
        pc.addTrack(screenAudioTrack, new MediaStream([screenAudioTrack]));
      }
      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !canSignal(wsRef)) return;
        wsRef.current!.send(JSON.stringify({ type: "screen_webrtc_publish_candidate", room_id: state.currentRoomId, channel_id: state.voiceChannelId || undefined, candidate: ev.candidate.toJSON() }));
      };
      const offer = await pc.createOffer();
      const mungedSdp = mungeScreenAudioSdp(offer.sdp!, {
        maxAverageBitrate: profile.audioMaxAverageBitrate,
      });
      await pc.setLocalDescription({ type: "offer", sdp: mungedSdp });
      await tuneScreenVideoSender(videoSender, profile);

      if (canSignal(wsRef)) {
        wsRef.current!.send(JSON.stringify({ type: "screen_webrtc_publish_offer", room_id: state.currentRoomId, channel_id: state.voiceChannelId || undefined, sdp: mungedSdp }));
      }
    } catch (err: unknown) {
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
      // Clean up stream if it was acquired but signaling failed
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
        screenStreamRef.current = null;
      }
      if (screenPubPcRef.current) { screenPubPcRef.current.close(); screenPubPcRef.current = null; }
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        const message = err instanceof Error ? err.message : "Unknown error";
        alert("Could not start screen sharing: " + message);
      }
    } finally {
      screenShareStartingRef.current = false;
    }
  }, [state.inVoiceChannel, state.currentRoomId, screenFps, state.userId, dispatch, stopScreenShare, wsRef]);

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
