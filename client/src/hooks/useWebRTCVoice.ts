import { useCallback, useRef, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { useVoiceSettings } from "@/hooks/useVoiceSettings";
import { playSound, type SoundPack } from "@/lib/sounds";
import { fetchIceServers, getWebRTCConfig, VOICE_SUBSCRIBE_RETRY_MS, VOICE_SUBSCRIBE_MAX_RETRIES, VOICE_SUBSCRIBE_MAX_BACKOFF_MS, VOICE_PUBLISH_INITIAL_RETRY_MS, VOICE_PUBLISH_MAX_BACKOFF_MS, VOICE_SUB_STUCK_NEW_MS, VOICE_SUB_STUCK_CONNECTING_MS, VOICE_BITRATE_DEFAULT_BPS, canSignal, clampVoiceBitrate, mungeVoiceAudioSdp, applyVoiceSenderBitrate } from "@/lib/webrtc";
import { toast } from "sonner";

const VOICE_PUBLISH_MAX_RETRIES = 5;
const VOICE_PUBLISH_ANSWER_TIMEOUT_MS = 10_000;

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
  const voiceGainNodesRef = useRef<Map<string, { ctx: AudioContext; gain: GainNode }>>(new Map());
  const voiceUserVolumesRef = useRef<Record<string, number>>({});
  const pendingVoiceSubsRef = useRef<Set<string>>(new Set());
  const voiceRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const voiceRetryCountsRef = useRef<Map<string, number>>(new Map());
  const voicePublishRetryCountRef = useRef(0);
  const voicePublishAnswerReceivedRef = useRef(false);
  const createVoicePublisherRef = useRef<() => Promise<void>>(async () => {});
  // Bitrate configured on the voice channel we're publishing into
  const voiceBitrateRef = useRef(VOICE_BITRATE_DEFAULT_BPS);
  // Set below; lets the moderation handlers call join/leave without adding them
  // to the WS effect's dependencies.
  const joinVoiceRef = useRef<(channelId?: string) => Promise<void>>(async () => {});
  const leaveVoiceRef = useRef<() => Promise<void>>(async () => {});
  const releaseVoiceRef = useRef<() => Promise<void>>(async () => {});

  // Refs to avoid stale closures
  const inVoiceRef = useRef(state.inVoiceChannel);
  const currentRoomRef = useRef(state.currentRoomId);
  const voiceRoomIdRef = useRef(state.voiceRoomId);
  const voiceChannelIdRef = useRef(state.voiceChannelId);
  // Mute and deafen are read from places that must not re-run when they change
  // — the join path, and the gain node built for each new speaker.
  const isMutedRef = useRef(state.isMuted);
  const isDeafenedRef = useRef(state.isDeafened);
  useEffect(() => { isMutedRef.current = state.isMuted; }, [state.isMuted]);
  useEffect(() => { isDeafenedRef.current = state.isDeafened; }, [state.isDeafened]);
  useEffect(() => { inVoiceRef.current = state.inVoiceChannel; }, [state.inVoiceChannel]);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);
  useEffect(() => { voiceRoomIdRef.current = state.voiceRoomId; }, [state.voiceRoomId]);
  useEffect(() => { voiceChannelIdRef.current = state.voiceChannelId; }, [state.voiceChannelId]);

  // Track the current voice channel's bitrate. A moderator changing it while
  // we're connected re-caps the sender live — no renegotiation needed.
  useEffect(() => {
    const channel = state.channels.find((c) => c.channel_id === state.voiceChannelId);
    if (!channel) return;
    const bitrate = clampVoiceBitrate(channel.voice_bitrate);
    if (bitrate === voiceBitrateRef.current) return;
    voiceBitrateRef.current = bitrate;
    if (voicePublisherPcRef.current) {
      applyVoiceSenderBitrate(voicePublisherPcRef.current, bitrate);
    }
  }, [state.channels, state.voiceChannelId]);

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

    pc.onconnectionstatechange = () => {
      if (pc !== voicePublisherPcRef.current) return;
      if (pc.connectionState === "connected") {
        voicePublishRetryCountRef.current = 0;
      } else if (pc.connectionState === "failed") {
        const attempt = voicePublishRetryCountRef.current + 1;
        console.warn(`[voice] Publisher connection failed (attempt ${attempt}/${VOICE_PUBLISH_MAX_RETRIES})`);
        try { pc.close(); } catch {}
        voicePublisherPcRef.current = null;
        if (attempt <= VOICE_PUBLISH_MAX_RETRIES && inVoiceRef.current) {
          voicePublishRetryCountRef.current = attempt;
          const delay = Math.min(VOICE_PUBLISH_INITIAL_RETRY_MS * 2 ** (attempt - 1), VOICE_PUBLISH_MAX_BACKOFF_MS);
          setTimeout(async () => {
            if (!inVoiceRef.current || voicePublisherPcRef.current) return;
            await fetchIceServers();
            await createVoicePublisherRef.current();
          }, delay);
        } else {
          voicePublishRetryCountRef.current = 0;
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await applyVoiceSenderBitrate(pc, voiceBitrateRef.current);
    if (!canSignal(wsRef)) return;
    voicePublishAnswerReceivedRef.current = false;
    wsRef.current!.send(JSON.stringify({
      type: "voice_webrtc_publish_offer",
      room_id: voiceRoomIdRef.current || currentRoomRef.current,
      channel_id: voiceChannelIdRef.current || undefined,
      sdp: offer.sdp,
    }));

    // Timeout: if no answer arrives within threshold, tear down and retry
    setTimeout(() => {
      if (pc !== voicePublisherPcRef.current) return;
      if (voicePublishAnswerReceivedRef.current) return;
      console.warn("[voice] Publisher offer timed out waiting for answer, retrying");
      try { pc.close(); } catch {}
      voicePublisherPcRef.current = null;
      const attempt = voicePublishRetryCountRef.current + 1;
      if (attempt <= VOICE_PUBLISH_MAX_RETRIES && inVoiceRef.current) {
        voicePublishRetryCountRef.current = attempt;
        const delay = Math.min(VOICE_PUBLISH_INITIAL_RETRY_MS * 2 ** (attempt - 1), VOICE_PUBLISH_MAX_BACKOFF_MS);
        setTimeout(async () => {
          if (!inVoiceRef.current || voicePublisherPcRef.current) return;
          await fetchIceServers();
          await createVoicePublisherRef.current();
        }, delay);
      }
    }, VOICE_PUBLISH_ANSWER_TIMEOUT_MS);
  }, []);
  // Keep ref in sync so the publisher failure handler can re-invoke it
  createVoicePublisherRef.current = createVoicePublisher;

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
      // Guard: if this PC was replaced, ignore stale track events
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      let audioEl = voiceAudioElementsRef.current.get(speakerUserId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        voiceAudioElementsRef.current.set(speakerUserId, audioEl);
      }
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      audioEl.srcObject = stream;

      // Route through a GainNode so per-user volume can exceed 100%
      if (!voiceGainNodesRef.current.has(speakerUserId)) {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        // Deafened means deafened to everyone, including whoever joins next —
        // and on a rejoin every speaker is a new one.
        gain.gain.value = isDeafenedRef.current
          ? 0
          : (voiceUserVolumesRef.current[speakerUserId] ?? 1.0);
        source.connect(gain);
        gain.connect(ctx.destination);
        voiceGainNodesRef.current.set(speakerUserId, { ctx, gain });
        // Mute the HTML element since GainNode handles playback
        audioEl.volume = 0;
      }

      audioEl.play().catch(() => {});
    };

    // Detect failed or stuck connections and retry
    pc.onconnectionstatechange = () => {
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      if (pc.connectionState === "connected") {
        // Successful connection — reset backoff counter
        voiceRetryCountsRef.current.delete(speakerUserId);
      } else if (pc.connectionState === "disconnected") {
        // Transient loss — attempt ICE restart before giving up
        try { pc.restartIce(); } catch {}
      } else if (pc.connectionState === "failed") {
        try { pc.close(); } catch {}
        voiceSubscriberPcsRef.current.delete(speakerUserId);
        pendingVoiceSubsRef.current.delete(speakerUserId);
        scheduleVoiceRetry(speakerUserId);
      }
    };

    // Timeout: if still "new" after 2.5s, the signaling was lost — tear down and retry
    setTimeout(() => {
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      if (pc.connectionState === "new") {
        console.warn("[voice] Subscription to", speakerUserId, "stuck in 'new', retrying");
        try { pc.close(); } catch {}
        voiceSubscriberPcsRef.current.delete(speakerUserId);
        pendingVoiceSubsRef.current.delete(speakerUserId);
        scheduleVoiceRetry(speakerUserId);
      }
    }, VOICE_SUB_STUCK_NEW_MS);

    // Timeout: if still "connecting" after 10s, ICE negotiation is stuck — tear down and retry
    setTimeout(() => {
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      if (pc.connectionState === "connecting") {
        console.warn("[voice] Subscription to", speakerUserId, "stuck in 'connecting', retrying");
        try { pc.close(); } catch {}
        voiceSubscriberPcsRef.current.delete(speakerUserId);
        pendingVoiceSubsRef.current.delete(speakerUserId);
        scheduleVoiceRetry(speakerUserId);
      }
    }, VOICE_SUB_STUCK_CONNECTING_MS);

    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      // Guard: if this PC was replaced before the offer resolved, don't send a stale offer
      if (pc !== voiceSubscriberPcsRef.current.get(speakerUserId)) return;
      await pc.setLocalDescription(offer);
      if (!canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_offer",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        speaker_user_id: speakerUserId,
        sdp: offer.sdp,
      }));
    }).catch(() => {
      // Offer creation failed — tear down so retry can start fresh
      try { pc.close(); } catch {}
      voiceSubscriberPcsRef.current.delete(speakerUserId);
      pendingVoiceSubsRef.current.delete(speakerUserId);
      scheduleVoiceRetry(speakerUserId);
    });
  }, [state.userId]);

  const scheduleVoiceRetryRef = useRef<(speakerUserId: string) => void>(() => {});
  scheduleVoiceRetryRef.current = (speakerUserId: string) => {
    if (voiceRetryTimersRef.current.has(speakerUserId)) return;
    if (voiceSubscriberPcsRef.current.has(speakerUserId)) return;

    const attempt = (voiceRetryCountsRef.current.get(speakerUserId) ?? 0) + 1;
    if (attempt > VOICE_SUBSCRIBE_MAX_RETRIES) {
      console.warn("[voice] Max retries reached for", speakerUserId, "— giving up");
      voiceRetryCountsRef.current.delete(speakerUserId);
      return;
    }
    voiceRetryCountsRef.current.set(speakerUserId, attempt);

    // Exponential backoff: 1.5s, 3s, 6s, 12s … capped at 30s
    const delay = Math.min(VOICE_SUBSCRIBE_RETRY_MS * 2 ** (attempt - 1), VOICE_SUBSCRIBE_MAX_BACKOFF_MS);

    const timer = setTimeout(async () => {
      voiceRetryTimersRef.current.delete(speakerUserId);
      if (
        inVoiceRef.current &&
        speakerUserId !== state.userId &&
        !voiceSubscriberPcsRef.current.has(speakerUserId) &&
        !pendingVoiceSubsRef.current.has(speakerUserId)
      ) {
        // Re-fetch ICE config in case TURN credentials rotated
        await fetchIceServers();
        console.log(`[voice] Retrying subscription to ${speakerUserId} (attempt ${attempt})`);
        createVoiceSub(speakerUserId);
      }
    }, delay);

    voiceRetryTimersRef.current.set(speakerUserId, timer);
  };
  const scheduleVoiceRetry = (speakerUserId: string) => scheduleVoiceRetryRef.current(speakerUserId);

  // ─── WS Message handler for Voice WebRTC signaling ─────────────────────────
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg.type === "voice_webrtc_publish_answer" && voicePublisherPcRef.current) {
        voicePublishAnswerReceivedRef.current = true;
        try {
          await voicePublisherPcRef.current.setRemoteDescription({
            type: "answer",
            sdp: mungeVoiceAudioSdp(msg.sdp, voiceBitrateRef.current),
          });
          await applyVoiceSenderBitrate(voicePublisherPcRef.current, voiceBitrateRef.current);
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
      } else if (msg.type === "voice_user_left") {
        // Immediately tear down the subscriber PC for a user who left the channel.
        // Without this, audio continues until the server-side close propagates, and
        // the failed-state retry loop can re-subscribe them after they've switched channels.
        const leftId = msg.user_id;
        if (leftId && leftId !== state.userId) {
          const oldPc = voiceSubscriberPcsRef.current.get(leftId);
          if (oldPc) {
            try { oldPc.close(); } catch {}
            voiceSubscriberPcsRef.current.delete(leftId);
          }
          pendingVoiceSubsRef.current.delete(leftId);
          const timer = voiceRetryTimersRef.current.get(leftId);
          if (timer) { clearTimeout(timer); voiceRetryTimersRef.current.delete(leftId); }
          voiceRetryCountsRef.current.delete(leftId);
          const audioEl = voiceAudioElementsRef.current.get(leftId);
          if (audioEl) { audioEl.pause(); audioEl.srcObject = null; voiceAudioElementsRef.current.delete(leftId); }
          const gainEntry = voiceGainNodesRef.current.get(leftId);
          if (gainEntry) { gainEntry.ctx.close().catch(() => {}); voiceGainNodesRef.current.delete(leftId); }
        }
      } else if (msg.type === "voice_webrtc_publisher_ready") {
        if (state.inVoiceChannel && msg.user_id !== state.userId) {
          // Only subscribe if the publisher is in our voice channel.
          // When someone switches channels their new publisher fires publisher_ready
          // for the new channel — users in the old channel must not subscribe.
          if (msg.channel_id && msg.channel_id !== voiceChannelIdRef.current) return;
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
          // Fresh publisher — reset backoff so we start from the beginning
          voiceRetryCountsRef.current.delete(msg.user_id);
          createVoiceSub(msg.user_id);
        }
      } else if (msg.type === "voice_force_muted") {
        // A moderator muted or unmuted us. The SFU already refuses our audio
        // while muted, so tearing the publisher down here just stops sending
        // into a closed door; rebuilding it on release restores our voice.
        if (msg.force_muted) {
          localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
          if (voicePublisherPcRef.current) {
            try { voicePublisherPcRef.current.close(); } catch { /* already closed */ }
            voicePublisherPcRef.current = null;
          }
          dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: true } });
        } else if (inVoiceRef.current && !voicePublisherPcRef.current) {
          await createVoicePublisherRef.current();
        }
      } else if (msg.type === "voice_force_moved") {
        // The server has already moved us in its own state; rebuild the peer
        // connections for the new channel.
        if (msg.channel_id) await joinVoiceRef.current(msg.channel_id);
      } else if (msg.type === "voice_session_taken") {
        // The same account joined this call from somewhere else. The server has
        // already moved the session and torn our media down on its side; drop
        // the local half quietly rather than announcing a leave, which would be
        // this device answering for a call it no longer holds.
        //
        // The member list is left alone: the account is still in the call, on
        // another device, so nothing about the room has changed.
        if (inVoiceRef.current) {
          await releaseVoiceRef.current();
          toast.info("You joined this call from another device");
        }
      } else if (msg.type === "voice_force_disconnected") {
        if (inVoiceRef.current) await leaveVoiceRef.current();
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
  }, [state.inVoiceChannel, state.userId, state.currentRoomId, createVoiceSub, dispatch]);

  // ─── Join/Leave voice ─────────────────────────────────────────────────────
  const joinVoice = useCallback(async (channelId?: string) => {
    if (!state.currentRoomId) return;

    // If already in a voice channel, tear down local state first.
    // Do NOT send voice_leave — the server's voice_join handler already removes
    // the user from any previous channel atomically, avoiding a race where a
    // stale voice_leave could arrive after voice_join and destroy the new connection.
    if (inVoiceRef.current) {
      await cleanupScreenRef.current();

      if (voicePublisherPcRef.current) {
        voicePublisherPcRef.current.close();
        voicePublisherPcRef.current = null;
      }
      voiceSubscriberPcsRef.current.forEach((pc) => pc.close());
      voiceSubscriberPcsRef.current.clear();
      voiceAudioElementsRef.current.forEach((el) => { el.pause(); el.srcObject = null; });
      voiceAudioElementsRef.current.clear();
      voiceGainNodesRef.current.forEach((entry) => entry.ctx.close().catch(() => {}));
      voiceGainNodesRef.current.clear();
      voiceRetryTimersRef.current.forEach((t) => clearTimeout(t));
      voiceRetryTimersRef.current.clear();
      voiceRetryCountsRef.current.clear();
      voicePublishRetryCountRef.current = 0;
      pendingVoiceSubsRef.current.clear();

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    }

    // Joining while already in a call is either a channel switch or a rejoin
    // after the socket dropped. Either way mute and deafen belong to the
    // person, not to the channel: resetting them would put someone who has
    // every reason to believe they are muted back on an open mic.
    const rejoining = inVoiceRef.current;
    const nextMuted = rejoining ? isMutedRef.current : false;
    const nextDeafened = rejoining ? isDeafenedRef.current : false;

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
      // A fresh track starts enabled, so silence it before anything is sent.
      if (nextMuted || nextDeafened) {
        stream.getAudioTracks().forEach((t) => { t.enabled = false; });
      }

      const resolvedChannelId = channelId || state.voiceChannelId || undefined;
      const joinedChannel = state.channels.find((c) => c.channel_id === resolvedChannelId);
      voiceBitrateRef.current = clampVoiceBitrate(joinedChannel?.voice_bitrate);
      dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: true, isMuted: nextMuted, isDeafened: nextDeafened, voiceRoomId: state.currentRoomId, voiceChannelId: resolvedChannelId ?? null } });
      voiceChannelIdRef.current = resolvedChannelId ?? null;

      // Persist voice session for auto-rejoin on refresh
      try {
        sessionStorage.setItem("voiceSession", JSON.stringify({
          roomId: state.currentRoomId,
          channelId: resolvedChannelId ?? null,
          timestamp: Date.now(),
        }));
      } catch {}

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const joinMsg: any = { type: "voice_join", room_id: state.currentRoomId };
        if (resolvedChannelId) joinMsg.channel_id = resolvedChannelId;
        wsRef.current.send(JSON.stringify(joinMsg));

        // The server treats a join as a fresh, unmuted arrival, so a preserved
        // state has to be announced or the rest of the room sees an open mic
        // on someone who is muted.
        if (nextMuted) {
          wsRef.current.send(JSON.stringify({
            type: "voice_mute",
            room_id: state.currentRoomId,
            channel_id: resolvedChannelId || undefined,
            muted: true,
          }));
        }
        if (nextDeafened) {
          wsRef.current.send(JSON.stringify({
            type: "voice_deafen",
            room_id: state.currentRoomId,
            channel_id: resolvedChannelId || undefined,
            deafened: true,
          }));
        }
      }
      await createVoicePublisher();
      await loadVoiceMembers();
    } catch {
      toast.error("Could not access microphone. Please check permissions.");
    }
  }, [state.currentRoomId, state.voiceChannelId, state.channels, createVoicePublisher, loadVoiceMembers, dispatch]);

  // Announce the departure while the socket is still open.
  //
  // Closing a tab otherwise leaves it to the server noticing the socket die,
  // which can lag by up to the read timeout, and the whole room goes on showing
  // someone who has gone. pagehide covers tab close, navigation and mobile
  // backgrounding, where beforeunload does not.
  useEffect(() => {
    const announceLeave = () => {
      if (!inVoiceRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const roomId = voiceRoomIdRef.current || currentRoomRef.current;
      if (!roomId) return;
      try {
        ws.send(
          JSON.stringify({
            type: "voice_leave",
            room_id: roomId,
            channel_id: voiceChannelIdRef.current || undefined,
          }),
        );
      } catch {
        // The socket was already going down; the server falls back to noticing.
      }
    };
    window.addEventListener("pagehide", announceLeave);
    return () => window.removeEventListener("pagehide", announceLeave);
  }, [wsRef]);

  /** Shut the local half of a voice session down, telling nobody.
   *
   *  On its own this is what a device does when it has already lost the
   *  session — announcing a leave for a call it no longer holds is at best
   *  noise, and would have been an eviction before the server started
   *  scoping membership to a connection. */
  const teardownLocalVoice = useCallback(async () => {
    // Stop screen sharing via the screen hook cleanup
    await cleanupScreenRef.current();

    // Close voice peers
    if (voicePublisherPcRef.current) {
      voicePublisherPcRef.current.close();
      voicePublisherPcRef.current = null;
    }
    voiceSubscriberPcsRef.current.forEach((pc) => pc.close());
    voiceSubscriberPcsRef.current.clear();
    voiceAudioElementsRef.current.forEach((el) => { el.pause(); el.srcObject = null; });
    voiceAudioElementsRef.current.clear();
    voiceGainNodesRef.current.forEach((entry) => entry.ctx.close().catch(() => {}));
    voiceGainNodesRef.current.clear();
    voiceRetryTimersRef.current.forEach((t) => clearTimeout(t));
    voiceRetryTimersRef.current.clear();
    voicePublishRetryCountRef.current = 0;
    pendingVoiceSubsRef.current.clear();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: false, isMuted: false, isDeafened: false, isScreenSharing: false, voiceRoomId: null, voiceChannelId: null, voiceChannelName: null } });
    // Cleared so a refresh on this device does not auto-rejoin and take the
    // session straight back off whichever device is holding it.
    try { sessionStorage.removeItem("voiceSession"); } catch {}
  }, [dispatch, cleanupScreenRef]);

  const leaveVoice = useCallback(async () => {
    await teardownLocalVoice();

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const leaveMsg: any = { type: "voice_leave", room_id: state.currentRoomId };
      if (state.voiceChannelId) leaveMsg.channel_id = state.voiceChannelId;
      wsRef.current.send(JSON.stringify(leaveMsg));
    }
    await loadVoiceMembers();
  }, [teardownLocalVoice, state.currentRoomId, state.voiceChannelId, loadVoiceMembers]);

  // ─── Mute ─────────────────────────────────────────────────────────────────
  // The pack of the room this call belongs to, so the effects match the server
  // being talked on rather than whichever room is on screen.
  //
  // Held in a ref because the PTT handlers below are bound once: adding it to
  // their dependencies would rebind the keyboard listeners every time any room
  // updated, and reading it through a stale closure would play the previous
  // room's sounds after switching calls.
  const roomSoundsRef = useRef<SoundPack | undefined>(undefined);
  roomSoundsRef.current = state.roomInfoMap[state.voiceRoomId ?? state.currentRoomId ?? ""]
    ?.sounds as SoundPack | undefined;

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const newMuted = !state.isMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !newMuted; });
    dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: newMuted } });
    playSound(newMuted ? "mute" : "unmute", roomSoundsRef.current);
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
        playSound("unmute", roomSoundsRef.current);
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "voice_mute", room_id: state.currentRoomId, channel_id: voiceChannelIdRef.current || undefined, muted: false }));
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "`") {
        localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
        dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: true } });
        playSound("mute", roomSoundsRef.current);
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
    const gainEntry = voiceGainNodesRef.current.get(userId);
    if (gainEntry) {
      gainEntry.gain.gain.value = vol;
    } else {
      // Fallback if GainNode not yet created (clamped to 1.0 by browser)
      const audioEl = voiceAudioElementsRef.current.get(userId);
      if (audioEl) audioEl.volume = Math.min(vol, 1);
    }
  }, []);

  // ─── Deafen ───────────────────────────────────────────────────────────────
  const toggleDeafen = useCallback(() => {
    const newDeafened = !state.isDeafened;
    // Disable the outgoing mic track when deafening so others can't hear the user.
    // When undeafening, only re-enable it if the user isn't separately muted.
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = newDeafened ? false : !state.isMuted;
      });
    }
    voiceGainNodesRef.current.forEach((entry, userId) => {
      entry.gain.gain.value = newDeafened ? 0 : (voiceUserVolumesRef.current[userId] ?? 1.0);
    });
    // Set alongside the dispatch, not by the effect that mirrors it: a
    // speaker's track can arrive before the next render, and would be built a
    // gain node at full volume while the user is deafened.
    isDeafenedRef.current = newDeafened;
    dispatch({ type: "SET_VOICE_STATE", payload: { isDeafened: newDeafened } });
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "voice_deafen",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        channel_id: voiceChannelIdRef.current || undefined,
        deafened: newDeafened,
      }));
    }
  }, [state.isDeafened, state.isMuted, dispatch]);

  joinVoiceRef.current = joinVoice;
  leaveVoiceRef.current = leaveVoice;
  releaseVoiceRef.current = teardownLocalVoice;

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
