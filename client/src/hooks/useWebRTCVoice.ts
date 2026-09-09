import { useCallback, useRef, useEffect } from "react";
import { useAppContext } from "@/lib/store";
import { useVoiceSettings } from "@/hooks/useVoiceSettings";
import {
  dropDeferredArrivalSound,
  playDeferredArrivalSound,
  playSound,
  type SoundPack,
} from "@/lib/sounds";
import { fetchIceServers, getWebRTCConfig, VOICE_SUBSCRIBE_RETRY_MS, VOICE_SUBSCRIBE_MAX_RETRIES, VOICE_SUBSCRIBE_MAX_BACKOFF_MS, VOICE_PUBLISH_INITIAL_RETRY_MS, VOICE_PUBLISH_MAX_BACKOFF_MS, VOICE_SLOT_COUNT, VOICE_BITRATE_DEFAULT_BPS, canSignal, clampVoiceBitrate, mungeVoiceAudioSdp, applyVoiceSenderBitrate } from "@/lib/webrtc";
import { toast } from "sonner";
import type { VoiceRestoreState } from "@/lib/voiceRejoin";

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
  // One connection for the whole call. The server writes whoever is currently
  // loudest into a fixed set of slots on it, so this stays a single connection
  // whether the call has three people in it or three hundred.
  const voiceSubscriberPcRef = useRef<RTCPeerConnection | null>(null);
  // Everything below is keyed by slot index, not by user: a slot outlives the
  // speakers that pass through it.
  const voiceSlotAudioRef = useRef<Map<number, HTMLAudioElement>>(new Map());
  const voiceSlotGainRef = useRef<Map<number, GainNode>>(new Map());
  const voiceSlotUsersRef = useRef<Map<number, string>>(new Map());
  // One AudioContext for the whole call, with a gain node per slot hanging off
  // it. A context per speaker capped call size far below anything else here —
  // browsers limit how many a single document may hold.
  const voiceAudioCtxRef = useRef<AudioContext | null>(null);
  const voiceUserVolumesRef = useRef<Record<string, number>>({});
  const voiceSubscribeRetryCountRef = useRef(0);
  const createVoiceSubscriptionRef = useRef<() => Promise<void>>(async () => {});
  const voicePublishRetryCountRef = useRef(0);
  const voicePublishAnswerReceivedRef = useRef(false);
  const createVoicePublisherRef = useRef<() => Promise<void>>(async () => {});
  // Bitrate configured on the voice channel we're publishing into
  const voiceBitrateRef = useRef(VOICE_BITRATE_DEFAULT_BPS);
  // Set below; lets the moderation handlers call join/leave without adding them
  // to the WS effect's dependencies.
  const joinVoiceRef = useRef<(channelId?: string, restore?: VoiceRestoreState) => Promise<void>>(async () => {});
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

  // Built on first use and reused for every speaker. A context that was closed
  // by an earlier call is replaced rather than revived — closing is final.
  const getVoiceAudioCtx = () => {
    if (!voiceAudioCtxRef.current || voiceAudioCtxRef.current.state === "closed") {
      voiceAudioCtxRef.current = new AudioContext();
    }
    return voiceAudioCtxRef.current;
  };

  // Drop every slot's gain node and the context they share.
  const closeVoiceAudioGraph = () => {
    voiceSlotGainRef.current.forEach((gain) => { try { gain.disconnect(); } catch {} });
    voiceSlotGainRef.current.clear();
    voiceSlotAudioRef.current.forEach((el) => { el.pause(); el.srcObject = null; });
    voiceSlotAudioRef.current.clear();
    voiceSlotUsersRef.current.clear();
    if (voiceAudioCtxRef.current) {
      voiceAudioCtxRef.current.close().catch(() => {});
      voiceAudioCtxRef.current = null;
    }
  };

  // A slot plays at the volume set for whoever currently occupies it, and is
  // silent while empty — an unassigned slot still carries whatever the previous
  // speaker left in the pipeline.
  const applySlotGain = (slot: number) => {
    const gain = voiceSlotGainRef.current.get(slot);
    if (!gain) return;
    const userId = voiceSlotUsersRef.current.get(slot);
    gain.gain.value =
      isDeafenedRef.current || !userId ? 0 : (voiceUserVolumesRef.current[userId] ?? 1.0);
  };

  // Write down enough to put the call back after a refresh. Mute and deafen
  // are included and kept current, because a refresh discards the state they
  // otherwise live in — and coming back on an open mic is the one mistake here
  // the person cannot see.
  const persistVoiceSession = (over: {
    roomId?: string | null;
    channelId?: string | null;
    muted?: boolean;
    deafened?: boolean;
  } = {}) => {
    // The refs behind these are mirrored by effects, so a caller acting on a
    // change it just made passes the new value rather than reading one a render
    // behind.
    const roomId = over.roomId ?? voiceRoomIdRef.current ?? currentRoomRef.current;
    if (!roomId) return;
    try {
      sessionStorage.setItem("voiceSession", JSON.stringify({
        roomId,
        channelId: over.channelId !== undefined ? over.channelId : voiceChannelIdRef.current,
        muted: over.muted ?? isMutedRef.current,
        deafened: over.deafened ?? isDeafenedRef.current,
        timestamp: Date.now(),
      }));
    } catch {
      // Only costs the restore; the call itself is unaffected.
    }
  };

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
      // Reported the moment it changes, so the UI and the entrance sound agree
      // on when the call came up rather than the label trailing it by a poll.
      dispatch({ type: "SET_VOICE_STATE", payload: { voicePublisherState: pc.connectionState } });
      if (pc.connectionState === "connected") {
        voicePublishRetryCountRef.current = 0;
        // Audio is flowing now, so the arrival this call was announcing has
        // actually happened. Held since the join was acknowledged; a retry
        // simply releases it later, and leaving first drops it entirely.
        playDeferredArrivalSound();
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

    // A retry closes the failed connection and builds this one; without a
    // report here the label would go on showing whatever the dead one last said.
    dispatch({ type: "SET_VOICE_STATE", payload: { voicePublisherState: pc.connectionState } });

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
  // One connection carries the entire call. It offers a fixed number of
  // receive-only transceivers — slots — and the server decides which speaker
  // occupies each one, announcing the mapping over the websocket. Nobody
  // joining or leaving the call renegotiates anything, which is what lets the
  // same connection serve a call of any size.
  const createVoiceSubscription = useCallback(async () => {
    if (!canSignal(wsRef) || voiceSubscriberPcRef.current) return;

    const pc = new RTCPeerConnection(getWebRTCConfig());
    voiceSubscriberPcRef.current = pc;

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_candidate",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex, usernameFragment: ev.candidate.usernameFragment },
      }));
    };

    pc.ontrack = (ev) => {
      if (pc !== voiceSubscriberPcRef.current) return;
      // Slot index is the transceiver's position, which the server matches by
      // adding its slot tracks in the same order our offer listed them.
      const slot = pc.getTransceivers().indexOf(ev.transceiver);
      if (slot < 0) return;

      let audioEl = voiceSlotAudioRef.current.get(slot);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        voiceSlotAudioRef.current.set(slot, audioEl);
      }
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      audioEl.srcObject = stream;

      // Route through a GainNode so per-user volume can exceed 100%
      if (!voiceSlotGainRef.current.has(slot)) {
        const ctx = getVoiceAudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(ctx.destination);
        voiceSlotGainRef.current.set(slot, gain);
        // Mute the HTML element since GainNode handles playback
        audioEl.volume = 0;
      }
      applySlotGain(slot);
      audioEl.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (pc !== voiceSubscriberPcRef.current) return;
      if (pc.connectionState === "connected") {
        voiceSubscribeRetryCountRef.current = 0;
      } else if (pc.connectionState === "disconnected") {
        // Transient loss — attempt ICE restart before giving up
        try { pc.restartIce(); } catch {}
      } else if (pc.connectionState === "failed") {
        const attempt = voiceSubscribeRetryCountRef.current + 1;
        console.warn(`[voice] Subscription failed (attempt ${attempt}/${VOICE_SUBSCRIBE_MAX_RETRIES})`);
        try { pc.close(); } catch {}
        voiceSubscriberPcRef.current = null;
        closeVoiceAudioGraph();
        if (attempt <= VOICE_SUBSCRIBE_MAX_RETRIES && inVoiceRef.current) {
          voiceSubscribeRetryCountRef.current = attempt;
          const delay = Math.min(VOICE_SUBSCRIBE_RETRY_MS * 2 ** (attempt - 1), VOICE_SUBSCRIBE_MAX_BACKOFF_MS);
          setTimeout(async () => {
            if (!inVoiceRef.current || voiceSubscriberPcRef.current) return;
            await fetchIceServers();
            await createVoiceSubscriptionRef.current();
          }, delay);
        } else {
          voiceSubscribeRetryCountRef.current = 0;
        }
      }
    };

    for (let i = 0; i < VOICE_SLOT_COUNT; i++) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    try {
      const offer = await pc.createOffer();
      // Guard: if this PC was replaced before the offer resolved, drop it
      if (pc !== voiceSubscriberPcRef.current) return;
      await pc.setLocalDescription(offer);
      if (!canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "voice_webrtc_subscribe_offer",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sdp: offer.sdp,
      }));
    } catch {
      try { pc.close(); } catch {}
      if (pc === voiceSubscriberPcRef.current) voiceSubscriberPcRef.current = null;
    }
  }, []);
  createVoiceSubscriptionRef.current = createVoiceSubscription;

  // Point each slot at the user the server says is in it. Only the mapping
  // changes here — the tracks and gain nodes are already wired up.
  const applySlotMap = (slots: { slot: number; user_id: string | null }[]) => {
    const seen = new Set<number>();
    for (const { slot, user_id } of slots) {
      seen.add(slot);
      if (user_id) voiceSlotUsersRef.current.set(slot, user_id);
      else voiceSlotUsersRef.current.delete(slot);
      applySlotGain(slot);
    }
    // Anything the server did not mention is empty.
    for (const slot of [...voiceSlotUsersRef.current.keys()]) {
      if (!seen.has(slot)) {
        voiceSlotUsersRef.current.delete(slot);
        applySlotGain(slot);
      }
    }
  };

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
        const pc = voiceSubscriberPcRef.current;
        if (pc && msg.sdp) {
          try { await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }); } catch {}
        }
      } else if (msg.type === "voice_webrtc_subscribe_candidate") {
        const pc = voiceSubscriberPcRef.current;
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch {}
        }
      } else if (msg.type === "voice_slot_map") {
        if (Array.isArray(msg.slots)) applySlotMap(msg.slots);
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
        if (msg.scope === "subscribe" && voiceSubscriberPcRef.current) {
          // The subscription is the only way to hear anyone, so a refusal is
          // rebuilt from scratch rather than left in place.
          try { voiceSubscriberPcRef.current.close(); } catch {}
          voiceSubscriberPcRef.current = null;
          closeVoiceAudioGraph();
          if (inVoiceRef.current) await createVoiceSubscriptionRef.current();
        }
      }
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId, dispatch]);

  // ─── Join/Leave voice ─────────────────────────────────────────────────────
  const joinVoice = useCallback(async (channelId?: string, restore?: VoiceRestoreState) => {
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
      if (voiceSubscriberPcRef.current) {
        try { voiceSubscriberPcRef.current.close(); } catch {}
        voiceSubscriberPcRef.current = null;
      }
      closeVoiceAudioGraph();
      voicePublishRetryCountRef.current = 0;
      voiceSubscribeRetryCountRef.current = 0;

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    }

    // Joining while already in a call is either a channel switch or a rejoin
    // after the socket dropped. Either way mute and deafen belong to the
    // person, not to the channel: resetting them would put someone who has
    // every reason to believe they are muted back on an open mic.
    // A refresh loses the refs along with the rest of the page, so a caller
    // restoring a persisted call hands back what it recorded. Without that the
    // rejoin looks like a fresh one and puts a muted person on an open mic.
    const rejoining = inVoiceRef.current;
    const nextMuted = restore?.muted ?? (rejoining ? isMutedRef.current : false);
    const nextDeafened = restore?.deafened ?? (rejoining ? isDeafenedRef.current : false);

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
      dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: true, isMuted: nextMuted, isDeafened: nextDeafened, voiceRoomId: state.currentRoomId, voiceChannelId: resolvedChannelId ?? null, voicePublisherState: "new" } });
      voiceChannelIdRef.current = resolvedChannelId ?? null;

      // Persist voice session for auto-rejoin on refresh
      persistVoiceSession({
        roomId: state.currentRoomId,
        channelId: resolvedChannelId ?? null,
        muted: nextMuted,
        deafened: nextDeafened,
      });

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        // Mute and deafen ride along with the join. They used to follow it as
        // two more messages, and each one was a second broadcast — so everyone
        // else saw the arrival unmuted first and corrected a moment later.
        const joinMsg: any = {
          type: "voice_join",
          room_id: state.currentRoomId,
          muted: nextMuted,
          deafened: nextDeafened,
        };
        if (resolvedChannelId) joinMsg.channel_id = resolvedChannelId;
        wsRef.current.send(JSON.stringify(joinMsg));
      }
      await createVoicePublisher();
      // One subscription covers everyone in the call, so it is opened on join
      // rather than in response to anybody publishing. Its slots start empty
      // and the server fills them as people speak.
      await createVoiceSubscription();
      await loadVoiceMembers();
    } catch {
      toast.error("Could not access microphone. Please check permissions.");
    }
  }, [state.currentRoomId, state.voiceChannelId, state.channels, createVoicePublisher, createVoiceSubscription, loadVoiceMembers, dispatch]);

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
    if (voiceSubscriberPcRef.current) {
      try { voiceSubscriberPcRef.current.close(); } catch {}
      voiceSubscriberPcRef.current = null;
    }
    closeVoiceAudioGraph();
    voicePublishRetryCountRef.current = 0;
    voiceSubscribeRetryCountRef.current = 0;
    // Every exit runs through here, so an entrance sting still waiting on a
    // connection is dropped whichever way the call ended — left deliberately,
    // taken by another device, or released after too long off the socket.
    // A sting must never surface on some later call it was not announcing.
    dropDeferredArrivalSound();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    dispatch({ type: "SET_VOICE_STATE", payload: { inVoiceChannel: false, isMuted: false, isDeafened: false, isScreenSharing: false, voiceRoomId: null, voiceChannelId: null, voiceChannelName: null, voicePublisherState: "closed" } });
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
    isMutedRef.current = newMuted;
    dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: newMuted } });
    persistVoiceSession({ muted: newMuted });
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
    // Only takes effect now if they currently hold a slot; otherwise it is
    // waiting for them in voiceUserVolumesRef when they next occupy one.
    for (const [slot, occupant] of voiceSlotUsersRef.current) {
      if (occupant === userId) applySlotGain(slot);
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
    // Set before the gains are recomputed: applySlotGain reads this ref, and a
    // slot map arriving before the next render would otherwise be built at full
    // volume while the user is deafened.
    isDeafenedRef.current = newDeafened;
    voiceSlotGainRef.current.forEach((_, slot) => applySlotGain(slot));
    persistVoiceSession({ deafened: newDeafened });
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
    voiceSubscriberPcRef,
    joinVoice,
    leaveVoice,
    /** Drop the local half of a call without announcing a leave — for when the
     *  session is already gone on the server's side. */
    releaseVoice: teardownLocalVoice,
    toggleMute,
    toggleDeafen,
    toggleInputMode,
    setUserVolume,
  };
}
