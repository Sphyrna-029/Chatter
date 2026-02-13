import { useCallback, useRef, useEffect, useState } from "react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const WEBRTC_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

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
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  const canSignal = () => wsRef.current && wsRef.current.readyState === WebSocket.OPEN;

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
          createVoiceSub(msg.user_id);
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
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) pc.addTrack(audioTrack, localStreamRef.current);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal()) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_publish_candidate",
        room_id: state.currentRoomId,
        candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex, usernameFragment: ev.candidate.usernameFragment },
      }));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsRef.current!.send(JSON.stringify({
      type: "voice_webrtc_publish_offer",
      room_id: state.currentRoomId,
      sdp: offer.sdp,
    }));
  }, [state.currentRoomId]);

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
        room_id: state.currentRoomId,
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

    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      await pc.setLocalDescription(offer);
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_offer",
        room_id: state.currentRoomId,
        speaker_user_id: speakerUserId,
        sdp: offer.sdp,
      }));
    }).catch(() => {});
  }, [state.userId, state.currentRoomId]);

  // ─── Join/Leave voice ─────────────────────────────────────────────────────
  const joinVoice = useCallback(async () => {
    if (!state.currentRoomId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 },
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
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, muted: false }));
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "`") {
        localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
        dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: true } });
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
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } as any,
        audio: false,
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
  }, [state.inVoiceChannel, state.currentRoomId, dispatch]);

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
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      screenStreamsMap.set(sharerId, stream);
      // Notify ScreenShareViewer to re-render
      window.dispatchEvent(new CustomEvent("screen-stream-update"));
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
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

            <Button
              size="sm"
              variant={state.isScreenSharing ? "destructive" : "outline"}
              onClick={state.isScreenSharing ? stopScreenShare : startScreenShare}
              className="text-xs"
            >
              {state.isScreenSharing ? "🖥️ Stop Sharing" : "🖥️ Share Screen"}
            </Button>

            {state.voiceInputMode === "ptt" && !state.isMuted && (
              <span className="text-xs text-green-500 font-semibold animate-pulse">
                🔊 Transmitting
              </span>
            )}
          </>
        )}
      </div>

      {/* Voice members list */}
      {state.voiceMembers.length > 0 && (
        <div className="border-b px-4 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            In Voice Channel
          </p>
          <div className="space-y-1">
            {state.voiceMembers.map((memberId) => {
              const name = shortenId(memberId);
              const isSelf = memberId === state.userId;
              const memberState = state.voiceMemberStates[memberId];
              const isMutedMember = memberState?.muted || (isSelf && state.isMuted);
              const isSharing = memberState?.screen_sharing || state.activeScreenSharers.includes(memberId);
              const vol = volumes[memberId] ?? 1;

              return (
                <div key={memberId} className="flex items-center gap-2 text-sm">
                  <span className={cn("text-xs", isMutedMember && "text-destructive")}>
                    {isMutedMember ? "🔇" : "🎤"}
                  </span>
                  <span className="flex-1 truncate">
                    {name}{isSelf && " (You)"}
                  </span>
                  {!isSelf && (
                    <div className="flex items-center gap-1 w-24">
                      <Slider
                        value={[vol * 100]}
                        onValueChange={([v]) => setUserVolume(memberId, v / 100)}
                        max={100}
                        step={1}
                        className="w-16"
                      />
                      <span className="text-xs text-muted-foreground w-8 text-right">
                        {Math.round(vol * 100)}%
                      </span>
                    </div>
                  )}
                  {isSharing && !isSelf && (
                    <Button
                      size="sm"
                      variant={state.selectedScreenSharer === memberId && state.screenViewerOpen ? "secondary" : "outline"}
                      onClick={(e) => {
                        e.stopPropagation();
                        watchUser(memberId);
                      }}
                      className={cn(
                        "h-6 px-2 text-xs font-semibold gap-1",
                        state.selectedScreenSharer === memberId && state.screenViewerOpen
                          ? "bg-purple-600 text-white hover:bg-purple-700 border-purple-600"
                          : "border-purple-500/50 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300"
                      )}
                      title={state.selectedScreenSharer === memberId && state.screenViewerOpen ? `Stop watching ${name}'s screen` : `Watch ${name}'s screen`}
                    >
                      📺 {state.selectedScreenSharer === memberId && state.screenViewerOpen ? "Watching" : "Watch"}
                    </Button>
                  )}
                  {isSharing && isSelf && (
                    <span className="text-xs text-purple-400 font-semibold px-2 py-0.5 rounded-md bg-purple-500/10">
                      📺 Sharing
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
