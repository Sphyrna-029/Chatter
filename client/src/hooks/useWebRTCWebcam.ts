import { useCallback, useRef, useEffect } from "react";
import { useAppContext, webcamStreamsMap } from "@/lib/store";
import {
  getWebRTCConfig,
  SCREEN_SUBSCRIBE_RETRY_MS,
  VOICE_SUB_STUCK_NEW_MS,
  VOICE_SUB_STUCK_CONNECTING_MS,
  canSignal,
  getWebcamPublishProfile,
} from "@/lib/webrtc";
import type { WebcamPublishProfile } from "@/lib/webrtc";
import { toast } from "sonner";

function buildWebcamVideoConstraints(
  profile: WebcamPublishProfile,
  deviceId?: string,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: profile.targetFps },
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
}

async function tuneWebcamVideoSender(
  sender: RTCRtpSender,
  profile: WebcamPublishProfile,
) {
  try {
    const params = sender.getParameters();
    const baseEncoding = params.encodings?.[0] ?? {};
    params.encodings = [{
      ...baseEncoding,
      maxBitrate: profile.maxBitrateBps,
      maxFramerate: profile.targetFps,
    }];
    // A camera picked for 60fps is being picked for smooth motion, so shed
    // resolution before frames when the network tightens.
    params.degradationPreference = "maintain-framerate";
    await sender.setParameters(params);
  } catch {
    // Browsers differ in which sender parameters are writable.
  }
}

export function useWebRTCWebcam() {
  const { state, dispatch, wsRef } = useAppContext();

  const webcamStreamRef = useRef<MediaStream | null>(null);
  const webcamPubPcRef = useRef<RTCPeerConnection | null>(null);
  const webcamSubPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const webcamRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingWebcamSubsRef = useRef<Set<string>>(new Set());
  const webcamStartingRef = useRef(false);
  // Profile of the stream currently being published, so the publish answer
  // handler can re-apply sender parameters browsers reset on renegotiation.
  const webcamProfileRef = useRef<WebcamPublishProfile>(getWebcamPublishProfile(30));

  const currentRoomRef = useRef(state.currentRoomId);
  const voiceRoomIdRef = useRef(state.voiceRoomId);
  const inVoiceChannelRef = useRef(state.inVoiceChannel);
  const activeWebcamStreamersRef = useRef(state.activeWebcamStreamers);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);
  useEffect(() => { voiceRoomIdRef.current = state.voiceRoomId; }, [state.voiceRoomId]);
  useEffect(() => { inVoiceChannelRef.current = state.inVoiceChannel; }, [state.inVoiceChannel]);
  useEffect(() => { activeWebcamStreamersRef.current = state.activeWebcamStreamers; }, [state.activeWebcamStreamers]);

  const ensureWebcamSub = (sharerId: string) => {
    if (!canSignal(wsRef) || sharerId === state.userId) return;
    if (webcamSubPcsRef.current.has(sharerId) || pendingWebcamSubsRef.current.has(sharerId)) return;

    const pc = new RTCPeerConnection(getWebRTCConfig());
    webcamSubPcsRef.current.set(sharerId, pc);
    pendingWebcamSubsRef.current.add(sharerId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "webcam_webrtc_subscribe_candidate",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        candidate: ev.candidate.toJSON(),
      }));
    };

    pc.ontrack = (ev) => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      let stream = webcamStreamsMap.get(sharerId);
      if (stream) {
        if (ev.track && !stream.getTrackById(ev.track.id)) {
          stream.addTrack(ev.track);
        }
      } else {
        stream = ev.streams[0] || new MediaStream([ev.track]);
        webcamStreamsMap.set(sharerId, stream);
      }
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
    };

    pc.onconnectionstatechange = () => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        try { pc.close(); } catch { /* noop */ }
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        webcamStreamsMap.delete(sharerId);
        window.dispatchEvent(new CustomEvent("webcam-stream-update"));
        scheduleWebcamRetry(sharerId);
      }
    };

    setTimeout(() => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "new") {
        try { pc.close(); } catch {}
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        scheduleWebcamRetry(sharerId);
      }
    }, VOICE_SUB_STUCK_NEW_MS);

    setTimeout(() => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "connecting") {
        try { pc.close(); } catch {}
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        scheduleWebcamRetry(sharerId);
      }
    }, VOICE_SUB_STUCK_CONNECTING_MS);

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      await pc.setLocalDescription(offer);
      if (!canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "webcam_webrtc_subscribe_offer",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        sdp: offer.sdp,
      }));
    }).catch(() => {
      try { pc.close(); } catch {}
      webcamSubPcsRef.current.delete(sharerId);
      pendingWebcamSubsRef.current.delete(sharerId);
      scheduleWebcamRetry(sharerId);
    });
  };

  const scheduleWebcamRetry = (sharerId: string) => {
    if (webcamRetryTimersRef.current.has(sharerId)) return;
    if (webcamSubPcsRef.current.has(sharerId)) return;

    const timer = setTimeout(() => {
      webcamRetryTimersRef.current.delete(sharerId);
      if (
        inVoiceChannelRef.current &&
        activeWebcamStreamersRef.current.includes(sharerId) &&
        sharerId !== state.userId &&
        !webcamSubPcsRef.current.has(sharerId) &&
        !pendingWebcamSubsRef.current.has(sharerId)
      ) {
        ensureWebcamSub(sharerId);
      }
    }, SCREEN_SUBSCRIBE_RETRY_MS);

    webcamRetryTimersRef.current.set(sharerId, timer);
  };

  const stopWebcam = useCallback(async () => {
    dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: false } });
    if (state.userId) {
      dispatch({ type: "WEBCAM_SHARE_STOPPED", payload: state.userId });
      webcamStreamsMap.delete(state.userId);
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
    }
    if (webcamPubPcRef.current) { webcamPubPcRef.current.close(); webcamPubPcRef.current = null; }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      webcamStreamRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg: any = { type: "webcam_share_stop", room_id: state.currentRoomId };
      if (state.voiceChannelId) msg.channel_id = state.voiceChannelId;
      wsRef.current.send(JSON.stringify(msg));
    }
  }, [state.currentRoomId, state.userId, state.voiceChannelId, dispatch, wsRef]);

  // WS message handler
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg.type === "webcam_webrtc_publish_answer" && webcamPubPcRef.current) {
        try {
          await webcamPubPcRef.current.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          // Some browsers reset encodings when the answer is applied.
          const videoSender = webcamPubPcRef.current.getSenders().find(
            (s) => s.track?.kind === "video",
          );
          if (videoSender) {
            await tuneWebcamVideoSender(videoSender, webcamProfileRef.current);
          }
        } catch { /* noop */ }
      } else if (msg.type === "webcam_webrtc_publish_candidate" && webcamPubPcRef.current) {
        try { await webcamPubPcRef.current.addIceCandidate(msg.candidate); } catch { /* noop */ }
      } else if (msg.type === "webcam_webrtc_subscribe_answer") {
        const pc = webcamSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.sdp) {
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            pendingWebcamSubsRef.current.delete(msg.sharer_user_id);
          } catch { /* noop */ }
        }
      } else if (msg.type === "webcam_webrtc_subscribe_candidate") {
        const pc = webcamSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch { /* noop */ }
        }
      } else if (msg.type === "webcam_webrtc_publisher_ready") {
        if (state.inVoiceChannel && msg.user_id !== state.userId) {
          const sharerId = msg.user_id;
          const oldPc = webcamSubPcsRef.current.get(sharerId);
          if (oldPc) {
            try { oldPc.close(); } catch { /* noop */ }
            webcamSubPcsRef.current.delete(sharerId);
          }
          pendingWebcamSubsRef.current.delete(sharerId);
          webcamStreamsMap.delete(sharerId);
          const timer = webcamRetryTimersRef.current.get(sharerId);
          if (timer) {
            clearTimeout(timer);
            webcamRetryTimersRef.current.delete(sharerId);
          }
          ensureWebcamSub(sharerId);
        }
      } else if (msg.type === "webcam_webrtc_error") {
        console.warn("[webcam] WebRTC error:", msg.detail || msg);
        if (msg.scope === "subscribe" && msg.sharer_user_id) {
          const failedPc = webcamSubPcsRef.current.get(msg.sharer_user_id);
          if (failedPc) {
            try { failedPc.close(); } catch { /* noop */ }
            webcamSubPcsRef.current.delete(msg.sharer_user_id);
          }
          pendingWebcamSubsRef.current.delete(msg.sharer_user_id);
          webcamStreamsMap.delete(msg.sharer_user_id);
          scheduleWebcamRetry(msg.sharer_user_id);
        } else if (msg.scope === "publish") {
          void stopWebcam();
        }
      }
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId, stopWebcam]);

  // Subscribe to webcam streams from other users
  useEffect(() => {
    if (!state.inVoiceChannel) return;
    for (const sharerId of state.activeWebcamStreamers) {
      if (
        sharerId !== state.userId &&
        !webcamSubPcsRef.current.has(sharerId) &&
        !pendingWebcamSubsRef.current.has(sharerId) &&
        !webcamRetryTimersRef.current.has(sharerId)
      ) {
        ensureWebcamSub(sharerId);
      }
    }
    webcamSubPcsRef.current.forEach((pc, sharerId) => {
      if (!state.activeWebcamStreamers.includes(sharerId)) {
        pc.close();
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        webcamStreamsMap.delete(sharerId);
      }
    });
    webcamRetryTimersRef.current.forEach((timer, sharerId) => {
      if (!state.activeWebcamStreamers.includes(sharerId)) {
        clearTimeout(timer);
        webcamRetryTimersRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
      }
    });
  }, [state.activeWebcamStreamers, state.inVoiceChannel, state.userId]);

  // Notify viewer when streams change
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("webcam-stream-update"));
  }, [state.activeWebcamStreamers]);

  // Auto-close viewer when no more webcam or screen streams
  useEffect(() => {
    if (state.activeWebcamStreamers.length === 0) {
      webcamStreamsMap.forEach((_stream, id) => {
        if (!state.activeWebcamStreamers.includes(id)) {
          webcamStreamsMap.delete(id);
        }
      });
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
    }
  }, [state.activeWebcamStreamers]);

  const startWebcam = useCallback(async (deviceId?: string, fps: 30 | 60 = 30) => {
    if (!state.inVoiceChannel || !canSignal(wsRef)) return;
    if (webcamStartingRef.current) return;
    webcamStartingRef.current = true;
    const profile = getWebcamPublishProfile(fps);
    webcamProfileRef.current = profile;
    try {
      const videoConstraints = buildWebcamVideoConstraints(profile, deviceId);

      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      webcamStreamRef.current = stream;
      webcamStreamsMap.set(state.userId!, stream);
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
      dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: true } });
      dispatch({ type: "WEBCAM_SHARE_STARTED", payload: state.userId! });
      // Open the viewer to show the webcam
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true } });

      if (canSignal(wsRef)) {
        const startMsg: any = { type: "webcam_share_start", room_id: state.currentRoomId };
        if (state.voiceChannelId) startMsg.channel_id = state.voiceChannelId;
        wsRef.current!.send(JSON.stringify(startMsg));
      }

      const videoTrack = stream.getVideoTracks()[0];
      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = profile.contentHint;
      }
      videoTrack.onended = () => {
        if (webcamStreamRef.current === stream) stopWebcam();
      };

      const pc = new RTCPeerConnection(getWebRTCConfig());
      webcamPubPcRef.current = pc;
      const videoSender = pc.addTrack(videoTrack, stream);
      await tuneWebcamVideoSender(videoSender, profile);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !canSignal(wsRef)) return;
        wsRef.current!.send(JSON.stringify({
          type: "webcam_webrtc_publish_candidate",
          room_id: state.currentRoomId,
          channel_id: state.voiceChannelId || undefined,
          candidate: ev.candidate.toJSON(),
        }));
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await tuneWebcamVideoSender(videoSender, profile);

      if (canSignal(wsRef)) {
        wsRef.current!.send(JSON.stringify({
          type: "webcam_webrtc_publish_offer",
          room_id: state.currentRoomId,
          channel_id: state.voiceChannelId || undefined,
          sdp: offer.sdp,
        }));
      }
    } catch (err: unknown) {
      dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: false } });
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
        webcamStreamRef.current = null;
      }
      if (webcamPubPcRef.current) { webcamPubPcRef.current.close(); webcamPubPcRef.current = null; }
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast.error("Could not start webcam: " + message);
      }
    } finally {
      webcamStartingRef.current = false;
    }
  }, [state.inVoiceChannel, state.currentRoomId, state.userId, state.voiceChannelId, dispatch, stopWebcam, wsRef]);

  const fullCleanup = useCallback(async () => {
    if (state.isWebcamActive) await stopWebcam();
    webcamSubPcsRef.current.forEach((pc) => pc.close());
    webcamSubPcsRef.current.clear();
    webcamRetryTimersRef.current.forEach((t) => clearTimeout(t));
    webcamRetryTimersRef.current.clear();
    pendingWebcamSubsRef.current.clear();
    webcamStreamsMap.clear();
    window.dispatchEvent(new CustomEvent("webcam-stream-update"));
  }, [state.isWebcamActive, stopWebcam]);

  return {
    webcamPubPcRef,
    webcamSubPcsRef,
    startWebcam,
    stopWebcam,
    fullCleanup,
  };
}
