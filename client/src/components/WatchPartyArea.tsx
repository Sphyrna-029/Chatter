import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetWatchPartyState, apiGetWatchPartyReactions, type WatchPartyReaction } from "@/lib/api";
import { ChatArea } from "./ChatArea";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Play, Pause, Film, RefreshCw, Volume2, VolumeX } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "./AuthImage";
import { displayUserId } from "@/lib/utils";

/** Re-seek once a player is further than this from the shared timeline. Above
 *  a second or so the drift is visible; below it, correcting is worse than the
 *  drift because every correction is a visible jump. */
const DRIFT_TOLERANCE_SECS = 1.5;
/** How often each client checks itself against the timeline. */
const DRIFT_CHECK_MS = 3000;
/** Treat the video as finished slightly early — browsers rarely report a
 *  currentTime exactly equal to duration. */
const END_EPSILON_SECS = 0.35;
/** A player position older than this is not trusted for drift correction. */
const PLAYER_POSITION_STALE_MS = 10_000;
/** HTMLMediaElement.HAVE_FUTURE_DATA — enough buffered to advance a frame. */
const HAVE_FUTURE_DATA = 3;
/** Leave a correction this long to land before considering another. A seek into
 *  an unbuffered stretch takes seconds, and re-seeking restarts it. */
const DRIFT_SETTLE_MS = 5000;
/** Give up waiting on a seek that never reports landing. */
const SEEK_ABANDON_MS = 15_000;
/** Offered on the reaction bar. Any emoji is storable; these are the shortcuts. */
const REACTION_EMOJI = ["😂", "😮", "❤️", "🔥", "👀", "💀"] as const;
/** A reaction floats over the video when it lands this close to where we are,
 *  so viewers in step see each other react live. */
const LIVE_REACTION_WINDOW_SECS = 4;
/** How long a floating reaction stays on screen. */
const FLOAT_LIFETIME_MS = 2600;

function extractYouTubeId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?/\s]+)/
  );
  return m ? m[1] : null;
}

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface WatchState {
  videoUrl: string;
  playing: boolean;
  positionSecs: number;
  positionUpdatedAt: number;
}

export function WatchPartyArea({ onJoinVoice }: { onJoinVoice: () => void }) {
  const { state, wsRef, dispatch } = useAppContext();
  const userPresence = state.userPresence;
  const roomId = state.currentRoomId!;
  const channelId = state.currentChannelId ?? "";
  const watchViewers = state.watchViewers[roomId] ?? [];
  const selfId = state.userId;

  const [watchState, setWatchState] = useState<WatchState>({
    videoUrl: "",
    playing: false,
    positionSecs: 0,
    positionUpdatedAt: 0,
  });
  const [urlInput, setUrlInput] = useState("");
  const [displayPosition, setDisplayPosition] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem("watchparty_volume");
    return saved ? parseFloat(saved) : 1.0;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [autoplayMuted, setAutoplayMuted] = useState(false);
  const [reactions, setReactions] = useState<WatchPartyReaction[]>([]);
  // Reactions currently animating over the video, keyed so repeats of the same
  // emoji do not collapse into one node.
  const [floating, setFloating] = useState<{ id: string; emoji: string; offset: number }[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isApplyingSync = useRef(false);
  const watchStateRef = useRef(watchState);
  const isYoutubeRef = useRef(false);
  const displayPositionRef = useRef(0);
  const videoDurationRef = useRef(0);
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);

  useEffect(() => {
    watchStateRef.current = watchState;
  }, [watchState]);

  const ytId = extractYouTubeId(watchState.videoUrl);
  const isYoutube = ytId !== null;

  // The media_session HttpOnly cookie (Path=/external) is sent automatically by the
  // browser for <video> elements — no ?access_token= query param is needed.
  const videoSrc = watchState.videoUrl;

  useEffect(() => {
    isYoutubeRef.current = isYoutube;
  }, [isYoutube]);

  // Keep videoDurationRef in sync so callbacks can read the latest value
  useEffect(() => { videoDurationRef.current = videoDuration; }, [videoDuration]);

  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  const send = useCallback(
    (msg: object) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ ...msg, room_id: roomId, channel_id: channelId }));
      }
    },
    [wsRef, roomId, channelId]
  );

  const applyVolume = useCallback((vol: number, muted: boolean) => {
    if (isYoutubeRef.current && iframeRef.current) {
      const win = iframeRef.current.contentWindow;
      if (muted) {
        win?.postMessage(JSON.stringify({ event: "command", func: "mute", args: "" }), "*");
      } else {
        win?.postMessage(JSON.stringify({ event: "command", func: "unMute", args: "" }), "*");
        win?.postMessage(JSON.stringify({ event: "command", func: "setVolume", args: [Math.round(vol * 100)] }), "*");
      }
    } else if (videoRef.current) {
      videoRef.current.volume = vol;
      // Only muting because autoplay demanded it: unmuting here would have the
      // browser pause the video, which is the "audio but no picture, or
      // neither" late joiners were seeing. It stays muted until a gesture.
      videoRef.current.muted = muted || autoplayMutedRef.current;
    }
  }, []);

  // Mark self as an active viewer while watching, and unmark on unmount/room change.
  // The video is considered "receiving" once a URL is loaded.
  const isActiveViewer = watchState.videoUrl !== "" && selfId !== null;
  const sendViewerMsg = useCallback((type: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, room_id: roomId }));
    }
  }, [wsRef, roomId]);

  useEffect(() => {
    if (!isActiveViewer) return;
    sendViewerMsg("watchparty_viewer_join");
    return () => { sendViewerMsg("watchparty_viewer_leave"); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActiveViewer, roomId]);

  // Track whether the <video> element is ready to accept commands.
  // Reset when the video URL changes; set when onCanPlay fires.
  const videoReadyRef = useRef(false);
  // What the player is actually showing, as opposed to where the shared
  // timeline says it should be. Drift correction compares the two.
  const playerPositionRef = useRef(0);
  // When that reading was taken. Drift correction needs a *fresh* one: acting
  // on a stale or never-delivered position would seek the player continuously.
  const playerPositionAtRef = useRef(0);
  // Guards the end-of-video report so it is sent once per playthrough.
  const endReportedRef = useRef(false);
  // Held in a ref because the YouTube message listener is installed before the
  // callback exists.
  const reportEndedRef = useRef<(() => void) | null>(null);
  // Store pending sync so onCanPlay can apply it when the video is actually ready.
  const pendingSyncRef = useRef<{ position: number; playing: boolean } | null>(null);
  // A seek we have issued that has not landed yet. Seeking again before it
  // lands restarts the fetch, which is how a late joiner ends up stuck on a
  // black frame for ever.
  const seekPendingRef = useRef<number | null>(null);
  // When we last moved the player, so corrections cannot stack up.
  const lastCorrectionAtRef = useRef(0);
  // Set when autoplay was only permitted because we muted. Unmuting such a
  // video without a user gesture makes the browser pause it outright.
  const autoplayMutedRef = useRef(false);

  const applySync = useCallback((positionSecs: number, playing: boolean) => {
    isApplyingSync.current = true;
    if (isYoutubeRef.current && iframeRef.current) {
      const win = iframeRef.current.contentWindow;
      win?.postMessage(
        JSON.stringify({ event: "command", func: "seekTo", args: [positionSecs, true] }),
        "*"
      );
      win?.postMessage(
        JSON.stringify({ event: "command", func: playing ? "playVideo" : "pauseVideo", args: "" }),
        "*"
      );
    } else if (videoRef.current) {
      // If video isn't ready yet, queue the sync for onCanPlay
      if (!videoReadyRef.current) {
        pendingSyncRef.current = { position: positionSecs, playing };
        setTimeout(() => { isApplyingSync.current = false; }, 400);
        setDisplayPosition(positionSecs);
        displayPositionRef.current = positionSecs;
        return;
      }
      const video = videoRef.current;
      // Re-issuing a seek that is already on its way restarts the fetch and the
      // decode, so a player that is still fetching never reaches a keyframe.
      const alreadySeekingHere =
        seekPendingRef.current !== null &&
        Math.abs(seekPendingRef.current - positionSecs) < DRIFT_TOLERANCE_SECS;
      if (!alreadySeekingHere && Math.abs(video.currentTime - positionSecs) > 0.25) {
        seekPendingRef.current = positionSecs;
        video.currentTime = positionSecs;
        // If `seeked` never arrives — a source that will not serve the range,
        // say — release the guard eventually so one retry is possible. Long
        // enough that it cannot become the thrash it exists to prevent.
        const target = positionSecs;
        setTimeout(() => {
          if (seekPendingRef.current === target) seekPendingRef.current = null;
        }, SEEK_ABANDON_MS);
      }
      lastCorrectionAtRef.current = Date.now();

      if (playing && video.paused) {
        // Try with sound first. Muting up front guarantees playback but leaves
        // everyone silent, and unmuting afterwards is what stopped the video.
        video.play().catch(() => {
          autoplayMutedRef.current = true;
          setAutoplayMuted(true);
          video.muted = true;
          video.play().catch(() => {});
        });
      } else if (!playing && !video.paused) {
        video.pause();
      }
    }
    setDisplayPosition(positionSecs);
    displayPositionRef.current = positionSecs;
    setTimeout(() => {
      isApplyingSync.current = false;
    }, 400);
  }, []);

  // Reset video readiness when URL changes so applySync queues until onCanPlay fires
  useEffect(() => {
    videoReadyRef.current = false;
    pendingSyncRef.current = null;
    endReportedRef.current = false;
    playerPositionRef.current = 0;
    playerPositionAtRef.current = 0;
    seekPendingRef.current = null;
    lastCorrectionAtRef.current = 0;
    autoplayMutedRef.current = false;
    setAutoplayMuted(false);
  }, [watchState.videoUrl]);

  // Listen for YouTube player postMessages: duration detection and onReady sync.
  // Each client has their own iframe so these fire independently — no broadcasting needed.
  useEffect(() => {
    const handleYtMsg = (e: MessageEvent) => {
      if (!isYoutubeRef.current) return;
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        // When the player is ready, apply full sync (seek + play/pause + volume).
        // This is the reliable signal that it can accept commands — the iframe
        // onLoad fires too early for the JS API to be initialised, which causes
        // late joiners to see a black screen.
        if (data?.event === "onReady") {
          const ws = watchStateRef.current;
          const compensated = ws.playing
            ? ws.positionSecs + (Date.now() / 1000 - ws.positionUpdatedAt)
            : ws.positionSecs;
          applySync(compensated, ws.playing);
          applyVolume(volumeRef.current, isMutedRef.current);
        }
        // YouTube reports playback position on its info feed; this is the only
        // way to know where its player actually is.
        const cur: unknown = data?.info?.currentTime;
        if (typeof cur === "number" && isFinite(cur)) {
          playerPositionRef.current = cur;
          playerPositionAtRef.current = Date.now();
        }
        // playerState 0 is "ended".
        if (data?.info?.playerState === 0 || data?.info?.playerState === "0") {
          reportEndedRef.current?.();
        }
        // Duration detection
        const dur: unknown = data?.info?.duration;
        if (typeof dur === "number" && isFinite(dur) && dur > 0 && dur !== videoDurationRef.current) {
          videoDurationRef.current = dur;
          setVideoDuration(dur);
        }
      } catch {}
    };
    window.addEventListener("message", handleYtMsg);
    return () => window.removeEventListener("message", handleYtMsg);
  }, [applyVolume, applySync]);

  // Fetch state on mount and request sync
  useEffect(() => {
    setWatchState({ videoUrl: "", playing: false, positionSecs: 0, positionUpdatedAt: 0 });
    setDisplayPosition(0);
    displayPositionRef.current = 0;

    apiGetWatchPartyState(roomId).then((data) => {
      dispatch({ type: "SET_WATCH_VIEWERS", payload: { roomId, users: data.viewers ?? [] } });
      if (data.video_url) {
        const now = Date.now() / 1000;
        const compensated = data.playing
          ? data.position_secs + (now - data.position_updated_at)
          : data.position_secs;
        setWatchState({
          videoUrl: data.video_url,
          playing: data.playing,
          positionSecs: data.position_secs,
          positionUpdatedAt: data.position_updated_at,
        });
        if (data.duration_secs > 0) {
          setVideoDuration(data.duration_secs);
        }
        setDisplayPosition(compensated);
        displayPositionRef.current = compensated;
      }
    }).catch(() => {});

    send({ type: "watchparty_request_sync" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // The timeline belongs to a video, not to the room, so it reloads whenever
  // the video does.
  useEffect(() => {
    if (!watchState.videoUrl) {
      setReactions([]);
      return;
    }
    let cancelled = false;
    apiGetWatchPartyReactions(roomId)
      .then((data) => {
        // A late response for a video we have already moved on from would put
        // marks at meaningless positions.
        if (cancelled || data.video_url !== watchStateRef.current.videoUrl) return;
        setReactions(data.reactions);
      })
      .catch(() => { /* the bar still works, it just starts empty */ });
    return () => { cancelled = true; };
  }, [roomId, watchState.videoUrl]);

  // Live reactions from everyone, including our own echo, so what we send looks
  // the same to us as it does to everyone else.
  useEffect(() => {
    const handle = (e: Event) => {
      const msg = (e as CustomEvent).detail as WatchPartyReaction & {
        room_id: string;
        video_url: string;
      };
      if (msg.room_id !== roomId) return;
      if (msg.video_url !== watchStateRef.current.videoUrl) return;

      setReactions((prev) =>
        prev.some((r) => r.reaction_id === msg.reaction_id) ? prev : [...prev, msg],
      );

      if (Math.abs(msg.position_secs - displayPositionRef.current) <= LIVE_REACTION_WINDOW_SECS) {
        const id = `${msg.reaction_id}:${Date.now()}`;
        setFloating((prev) => [
          ...prev,
          { id, emoji: msg.emoji, offset: Math.random() * 60 },
        ]);
        setTimeout(
          () => setFloating((prev) => prev.filter((f) => f.id !== id)),
          FLOAT_LIFETIME_MS,
        );
      }
    };
    window.addEventListener("watchparty_reaction_added", handle);
    return () => window.removeEventListener("watchparty_reaction_added", handle);
  }, [roomId]);

  const sendReaction = useCallback(
    (emoji: string) => {
      if (!watchStateRef.current.videoUrl) return;
      send({
        type: "watchparty_reaction",
        emoji,
        position_secs: Math.max(0, displayPositionRef.current),
      });
    },
    [send],
  );

  // Listen for WS sync events
  useEffect(() => {
    const handle = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg.room_id !== roomId) return;

      const newState: WatchState = {
        videoUrl: msg.video_url !== undefined ? msg.video_url : watchStateRef.current.videoUrl,
        playing: msg.playing,
        positionSecs: msg.position_secs,
        positionUpdatedAt: msg.position_updated_at,
      };
      setWatchState(newState);

      if (msg.duration_secs > 0) {
        setVideoDuration(msg.duration_secs);
      }

      const compensated = msg.playing
        ? msg.position_secs + (Date.now() / 1000 - msg.position_updated_at)
        : msg.position_secs;

      // Only seek the player when something meaningful changed.
      // Heartbeat syncs (same play state, no video change) just update the
      // progress bar via state — they must not seek or they cause stuttering.
      // Skip applying sync if we sent this message (already applied locally).
      const iAmSender = state.userId === msg.sender_user_id;
      const isVideoChanged = msg.type === "watchparty_video_changed";

      if (isVideoChanged) {
        // Video URL changed — don't call applySync now. The <video> element
        // will remount (key={videoUrl}) and onCanPlay will handle initial sync.
        // Just store the desired state so onCanPlay can pick it up.
        pendingSyncRef.current = { position: compensated, playing: msg.playing };
      } else if (!iAmSender) {
        const playStateChanged = msg.playing !== watchStateRef.current.playing;
        // A seek keeps the play state and only moves the position, so gating on
        // playStateChanged alone dropped every seek: the progress bar jumped to
        // the new spot while the video carried on from the old one, and nothing
        // ever reconciled the two.
        const havePosition = playerPositionAtRef.current > 0;
        const drifted =
          !havePosition ||
          Math.abs(compensated - playerPositionRef.current) > DRIFT_TOLERANCE_SECS;
        if (playStateChanged || drifted) {
          applySync(compensated, msg.playing);
        }
      }
    };

    window.addEventListener("watchparty_sync", handle);
    window.addEventListener("watchparty_video_changed", handle);
    return () => {
      window.removeEventListener("watchparty_sync", handle);
      window.removeEventListener("watchparty_video_changed", handle);
    };
  }, [roomId, state.userId, applySync]);

  // Animate progress bar while playing
  useEffect(() => {
    if (!watchState.playing) return;
    const startPos = watchState.positionSecs;
    const startTime = watchState.positionUpdatedAt;
    // Starting anywhere before the end re-arms the end report, so replaying or
    // seeking backwards is noticed again.
    const startDuration = videoDurationRef.current;
    if (!(startDuration > 0) || startPos < startDuration - END_EPSILON_SECS) {
      endReportedRef.current = false;
    }

    const interval = setInterval(() => {
      const raw = startPos + (Date.now() / 1000 - startTime);
      const duration = videoDurationRef.current;
      // The readout is pure extrapolation from the last sync, and nothing used
      // to bound it — so once the video finished the clock kept climbing past
      // the runtime for ever.
      const pos = duration > 0 ? Math.min(raw, duration) : raw;
      setDisplayPosition(pos);
      displayPositionRef.current = pos;
      if (duration > 0 && raw >= duration - END_EPSILON_SECS) {
        reportEndedRef.current?.();
      }
    }, 500);
    return () => clearInterval(interval);
  }, [watchState.playing, watchState.positionSecs, watchState.positionUpdatedAt]);

  // Pull a drifting player back onto the shared timeline.
  //
  // Nothing corrected drift before: a client that stalled buffering fell behind
  // and stayed behind, because controls are only broadcast on an explicit
  // action and the server's heartbeat branch never receives one.
  useEffect(() => {
    if (!watchState.playing) return;
    const interval = setInterval(() => {
      if (isApplyingSync.current) return;
      const ws = watchStateRef.current;
      if (!ws.playing) return;
      const expected = ws.positionSecs + (Date.now() / 1000 - ws.positionUpdatedAt);
      const duration = videoDurationRef.current;
      if (duration > 0 && expected >= duration - END_EPSILON_SECS) return;
      // No fresh reading means we cannot tell where the player is — a YouTube
      // embed that never reports currentTime would otherwise be seeked on every
      // pass.
      if (Date.now() - playerPositionAtRef.current > PLAYER_POSITION_STALE_MS) return;
      // Never correct a player that is mid-seek or starved of data. It is
      // behind precisely because it is still fetching, and seeking again
      // restarts that fetch — which is how a late joiner seeking into an
      // unbuffered stretch could be held on a black frame indefinitely.
      if (seekPendingRef.current !== null) return;
      const video = videoRef.current;
      if (!isYoutubeRef.current) {
        if (!video || video.seeking) return;
        if (video.readyState < HAVE_FUTURE_DATA) return;
      }
      // Give a correction time to take effect before judging it again.
      if (Date.now() - lastCorrectionAtRef.current < DRIFT_SETTLE_MS) return;
      if (Math.abs(expected - playerPositionRef.current) > DRIFT_TOLERANCE_SECS) {
        applySync(expected, true);
      }
    }, DRIFT_CHECK_MS);
    return () => clearInterval(interval);
  }, [watchState.playing, applySync]);

  // Settle playback at the end of the video. The server call is idempotent, so
  // every viewer reporting at once costs one state change and one broadcast.
  const reportEnded = useCallback(() => {
    if (endReportedRef.current) return;
    if (!watchStateRef.current.playing) return;
    endReportedRef.current = true;

    const duration = videoDurationRef.current;
    const finalPos = duration > 0 ? duration : displayPositionRef.current;
    setWatchState((prev) => ({
      ...prev,
      playing: false,
      positionSecs: finalPos,
      positionUpdatedAt: Date.now() / 1000,
    }));
    setDisplayPosition(finalPos);
    displayPositionRef.current = finalPos;
    send({ type: "watchparty_ended" });
  }, [send]);

  useEffect(() => {
    reportEndedRef.current = reportEnded;
  }, [reportEnded]);

  const handleLoadVideo = () => {
    const url = urlInput.trim();
    if (!url) return;
    send({ type: "watchparty_set_video", video_url: url });
    setUrlInput("");
  };

  const handlePlayPause = () => {
    const pos = displayPositionRef.current;
    const newPlaying = !watchState.playing;
    send({ type: "watchparty_control", playing: newPlaying, position_secs: pos, duration_secs: videoDuration > 0 ? videoDuration : undefined });
    setWatchState((prev) => ({
      ...prev,
      playing: newPlaying,
      positionSecs: pos,
      positionUpdatedAt: Date.now() / 1000,
    }));
    applySync(pos, newPlaying);
  };

  const handleSeekDrag = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pos = parseFloat(e.target.value);
    setDisplayPosition(pos);
    displayPositionRef.current = pos;
  };

  const handleSeekCommit = (e: React.PointerEvent<HTMLInputElement>) => {
    const pos = parseFloat(e.currentTarget.value);
    displayPositionRef.current = pos;
    const playing = watchStateRef.current.playing;
    send({ type: "watchparty_control", playing, position_secs: pos });
    setWatchState((prev) => ({
      ...prev,
      positionSecs: pos,
      positionUpdatedAt: Date.now() / 1000,
    }));
    applySync(pos, playing);
  };

  // Video element events are suppressed — only explicit UI actions (play/pause
  // button, seekbar) broadcast controls to prevent cross-user feedback loops.
  const handleVideoPlay = useCallback(() => {}, []);
  const handleVideoPause = useCallback(() => {}, []);
  // A landed seek clears the in-flight guard, so drift correction may resume.
  const handleVideoSeeked = useCallback(() => {
    seekPendingRef.current = null;
    const t = videoRef.current?.currentTime;
    if (typeof t === "number" && isFinite(t)) {
      playerPositionRef.current = t;
      playerPositionAtRef.current = Date.now();
    }
  }, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    autoplayMutedRef.current = false;
    setAutoplayMuted(false);
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    volumeRef.current = vol;
    localStorage.setItem("watchparty_volume", String(vol));
    const newMuted = vol === 0;
    setIsMuted(newMuted);
    isMutedRef.current = newMuted;
    applyVolume(vol, newMuted);
  };

  const handleToggleMute = () => {
    // A click is the gesture the autoplay policy wants, so the forced mute
    // no longer applies.
    autoplayMutedRef.current = false;
    setAutoplayMuted(false);
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    isMutedRef.current = newMuted;
    applyVolume(volumeRef.current, newMuted);
  };

  const MAX_AVATARS = 7;
  // Always include self (we are receiving the video), merged ahead of the
  // server list so it renders immediately without waiting for our own join
  // broadcast to round-trip back.
  const activeViewers =
    selfId && !watchViewers.includes(selfId) ? [selfId, ...watchViewers] : watchViewers;
  const visibleMembers = activeViewers.slice(0, MAX_AVATARS);
  const overflowCount = activeViewers.length - visibleMembers.length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ResizablePanelGroup orientation="vertical" className="flex-1">
        <ResizablePanel defaultSize={65} minSize={20}>
          <div className="h-full flex flex-col bg-black">
            {/* Video */}
            <div className="flex-1 relative flex items-center justify-center min-h-0 overflow-hidden">
              {!watchState.videoUrl ? (
                <div className="flex flex-col items-center gap-3 text-muted-foreground select-none">
                  <Film className="w-12 h-12 opacity-20" />
                  <p className="text-sm opacity-60">No video loaded</p>
                  <p className="text-xs opacity-40">Paste a YouTube or direct video URL below</p>
                </div>
              ) : isYoutube ? (
                <iframe
                  ref={iframeRef}
                  key={ytId}
                  className="w-full h-full"
                  src={`https://www.youtube-nocookie.com/embed/${ytId}?enablejsapi=1&controls=0&disablekb=1&rel=0&autoplay=0&origin=${encodeURIComponent(window.location.origin)}`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  onLoad={() => {
                    const win = iframeRef.current?.contentWindow;
                    // Enable YouTube event delivery so we receive duration info
                    win?.postMessage(
                      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
                      "*"
                    );
                    const ws = watchStateRef.current;
                    const compensated = ws.playing
                      ? ws.positionSecs + (Date.now() / 1000 - ws.positionUpdatedAt)
                      : ws.positionSecs;
                    setTimeout(() => {
                      applySync(compensated, ws.playing);
                      applyVolume(volumeRef.current, isMutedRef.current);
                    }, 600);
                  }}
                />
              ) : (
                // Deliberately carries neither autoPlay nor muted. Autoplay
                // would start at zero only to be seeked away, and a hardcoded
                // muted attribute meant every load began muted and was unmuted
                // by applyVolume moments later — which is what made the browser
                // stop playback for late joiners. applySync starts it instead.
                <video
                  ref={videoRef}
                  key={watchState.videoUrl}
                  className="w-full h-full object-contain"
                  src={videoSrc}
                  controls={false}
                  playsInline
                  preload="auto"
                  onPlay={handleVideoPlay}
                  onPause={handleVideoPause}
                  onSeeked={handleVideoSeeked}
                  onTimeUpdate={() => {
                    const t = videoRef.current?.currentTime;
                    if (typeof t === "number" && isFinite(t)) {
                      playerPositionRef.current = t;
                      playerPositionAtRef.current = Date.now();
                    }
                  }}
                  onEnded={() => reportEndedRef.current?.()}
                  onSeeking={() => {
                    if (seekPendingRef.current === null && videoRef.current) {
                      seekPendingRef.current = videoRef.current.currentTime;
                    }
                  }}
                  onLoadedMetadata={() => {
                    const dur = videoRef.current?.duration;
                    if (dur && isFinite(dur)) {
                      setVideoDuration(dur);
                    }
                  }}
                  onCanPlay={() => {
                    // Only sync on the first canplay after a video loads.
                    // canplay fires again after every buffering stall recovery;
                    // re-seeking each time causes visible jitter.
                    if (videoReadyRef.current) return;
                    videoReadyRef.current = true;
                    const pending = pendingSyncRef.current;
                    if (pending) {
                      pendingSyncRef.current = null;
                      applySync(pending.position, pending.playing);
                    } else {
                      // First load — sync to current watch state
                      const ws = watchStateRef.current;
                      const compensated = ws.playing
                        ? ws.positionSecs + (Date.now() / 1000 - ws.positionUpdatedAt)
                        : ws.positionSecs;
                      applySync(compensated, ws.playing);
                    }
                    applyVolume(volumeRef.current, isMutedRef.current);
                  }}
                />
              )}

              {/* Autoplay only went through because we muted; say so, since
                  otherwise the video simply has no sound and nothing explains
                  why. Clicking is the gesture that lifts the restriction. */}
              {autoplayMuted && (
                <button
                  onClick={() => {
                    autoplayMutedRef.current = false;
                    setAutoplayMuted(false);
                    setIsMuted(false);
                    isMutedRef.current = false;
                    applyVolume(volumeRef.current, false);
                  }}
                  className="absolute top-2 left-2 z-30 flex items-center gap-1.5 rounded-full bg-background/85 backdrop-blur px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background transition-colors cursor-pointer"
                >
                  <VolumeX className="w-3.5 h-3.5" />
                  Muted to start playback — click for sound
                </button>
              )}

              {/* Reactions landing near the current position */}
              {floating.length > 0 && (
                <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
                  {floating.map((f) => (
                    <span
                      key={f.id}
                      className="absolute bottom-10 text-3xl watchparty-float select-none"
                      style={{ right: `${8 + f.offset}px` }}
                    >
                      {f.emoji}
                    </span>
                  ))}
                </div>
              )}

              {/* Viewer count + avatar overlay */}
              {isActiveViewer && (
                <div className="group absolute bottom-2 left-2 z-10 flex items-center gap-2 opacity-60 transition-opacity duration-150 group-hover:opacity-100 select-none">
                  <div className="flex items-center -space-x-1.5">
                    {visibleMembers.map((memberId) => {
                      const presence = userPresence[memberId];
                      const name = presence?.displayName || displayUserId(memberId);
                      const initial = (name[0] || "?").toUpperCase();
                      return (
                        <div key={memberId} className="opacity-60 transition-opacity duration-150 hover:opacity-100" title={name}>
                          <Avatar className="h-7 w-7 ring-2 ring-background">
                            <AuthAvatarImage src={presence?.avatarUrl} />
                            <AvatarFallback className="text-3xs bg-secondary">{initial}</AvatarFallback>
                          </Avatar>
                        </div>
                      );
                    })}
                    {overflowCount > 0 && (
                      <div className="opacity-60 transition-opacity duration-150" title={`+${overflowCount} more`}>
                        <div className="h-7 w-7 rounded-full bg-muted ring-2 ring-background flex items-center justify-center text-3xs text-foreground">
                          +{overflowCount}
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="rounded-full bg-background/80 backdrop-blur px-2 py-1 text-2xs text-foreground tabular-nums whitespace-nowrap">
                    {activeViewers.length} watching
                  </span>
                </div>
              )}
            </div>

            {/* Controls bar */}
            <div className="flex flex-col gap-1.5 px-3 py-2 bg-card border-t border-border shrink-0">
              {/* Progress bar + volume */}
              {watchState.videoUrl && (
                <div className="flex items-center gap-2 ui-meta">
                  <span className="shrink-0 tabular-nums w-10 text-right">
                    {formatTime(Math.max(0, displayPosition))}
                  </span>
                  <div className="relative flex-1">
                    {/* Reaction marks, positioned by where in the video they
                        were left. Only meaningful once the runtime is known. */}
                    {videoDuration > 0 && reactions.length > 0 && (
                      <div className="pointer-events-none absolute -top-3 left-0 right-0 h-3">
                        {reactions.map((r) => {
                          const who =
                            userPresence[r.user_id]?.displayName || displayUserId(r.user_id);
                          return (
                            <span
                              key={r.reaction_id}
                              className="absolute -translate-x-1/2 text-[11px] leading-none opacity-70 hover:opacity-100"
                              style={{
                                left: `${Math.min(100, Math.max(0, (r.position_secs / videoDuration) * 100))}%`,
                              }}
                              title={`${who} at ${formatTime(r.position_secs)}`}
                            >
                              {r.emoji}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <input
                      type="range"
                      min={0}
                      max={videoDuration || 14400}
                      step={1}
                      value={Math.max(0, displayPosition)}
                      onChange={handleSeekDrag}
                      onPointerUp={handleSeekCommit}
                      className="w-full accent-purple-500 cursor-pointer h-1"
                    />
                  </div>
                  {/* Volume */}
                  <button
                    onClick={handleToggleMute}
                    className="shrink-0 hover:text-foreground transition-colors cursor-pointer"
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    {isMuted || volume === 0 ? (
                      <VolumeX className="w-3.5 h-3.5" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="w-16 shrink-0 accent-primary cursor-pointer h-1"
                    title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
                  />
                </div>
              )}

              {/* Reaction bar */}
              {watchState.videoUrl && (
                <div className="flex items-center gap-1">
                  {REACTION_EMOJI.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => sendReaction(emoji)}
                      className="rounded px-1.5 py-0.5 text-base leading-none transition-transform hover:scale-125 cursor-pointer"
                      title={`React at ${formatTime(Math.max(0, displayPosition))}`}
                    >
                      {emoji}
                    </button>
                  ))}
                  {reactions.length > 0 && (
                    <span className="ml-1 ui-meta text-muted-foreground">
                      {reactions.length} reaction{reactions.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              )}

              {/* Action row — available to all users */}
              <div className="flex items-center gap-2">
                {watchState.videoUrl && (
                  <button
                    onClick={handlePlayPause}
                    aria-label={watchState.playing ? "Pause" : "Play"}
                    className="p-1.5 rounded hover:bg-white/10 text-white transition-colors cursor-pointer shrink-0"
                  >
                    {watchState.playing ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                  </button>
                )}
                <Input
                  className="flex-1 h-7 text-xs bg-background border-border placeholder:text-muted-foreground"
                  placeholder="YouTube URL or direct video URL…"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLoadVideo()}
                />
                <Button
                  size="sm"
                  className="h-7 text-xs shrink-0"
                  onClick={handleLoadVideo}
                  disabled={!urlInput.trim()}
                >
                  Load
                </Button>
                <button
                  className="flex items-center gap-1 text-2xs text-blue-400 hover:text-blue-300 transition-colors cursor-pointer shrink-0"
                  onClick={() => send({ type: "watchparty_request_sync" })}
                  title="Sync to current playback position"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={35} minSize={15}>
          <div className="h-full flex flex-col min-h-0">
            <ChatArea onJoinVoice={onJoinVoice} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
