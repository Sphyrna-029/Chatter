import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetWatchPartyState } from "@/lib/api";
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
  const { state, wsRef } = useAppContext();
  const { voiceMembers, userPresence } = state;
  const roomId = state.currentRoomId!;
  const channelId = state.currentChannelId ?? "";

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
      videoRef.current.muted = muted;
    }
  }, []);

  // Track whether the <video> element is ready to accept commands.
  // Reset when the video URL changes; set when onCanPlay fires.
  const videoReadyRef = useRef(false);
  // Store pending sync so onCanPlay can apply it when the video is actually ready.
  const pendingSyncRef = useRef<{ position: number; playing: boolean } | null>(null);

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
      videoRef.current.currentTime = positionSecs;
      if (playing && videoRef.current.paused) {
        videoRef.current.muted = true; // ensure muted so autoplay is allowed
        videoRef.current.play().catch(() => {});
      } else if (!playing && !videoRef.current.paused) {
        videoRef.current.pause();
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
        if (playStateChanged) {
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
    const interval = setInterval(() => {
      const pos = startPos + (Date.now() / 1000 - startTime);
      setDisplayPosition(pos);
      displayPositionRef.current = pos;
    }, 500);
    return () => clearInterval(interval);
  }, [watchState.playing, watchState.positionSecs, watchState.positionUpdatedAt]);

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
  const handleVideoSeeked = useCallback(() => {}, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    isMutedRef.current = newMuted;
    applyVolume(volumeRef.current, newMuted);
  };

  const MAX_AVATARS = 7;
  const visibleMembers = voiceMembers.slice(0, MAX_AVATARS);
  const overflowCount = voiceMembers.length - visibleMembers.length;

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
                <video
                  ref={videoRef}
                  key={watchState.videoUrl}
                  className="w-full h-full object-contain"
                  src={videoSrc}
                  controls={false}
                  autoPlay
                  muted
                  playsInline
                  preload="auto"
                  onPlay={handleVideoPlay}
                  onPause={handleVideoPause}
                  onSeeked={handleVideoSeeked}
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

              {/* Viewer count + avatar overlay */}
              {voiceMembers.length > 0 && (
                <div className="group absolute bottom-2 left-2 z-10 flex items-center gap-2 opacity-60 transition-opacity duration-150 group-hover:opacity-100 select-none">
                  <div className="flex items-center -space-x-1.5">
                    {visibleMembers.map((memberId) => {
                      const presence = userPresence[memberId];
                      const name = presence?.displayName || displayUserId(memberId);
                      const initial = (name[0] || "?").toUpperCase();
                      return (
                        <div key={memberId} className="opacity-60 transition-opacity duration-150 hover:opacity-100" title={name}>
                          <Avatar className="h-7 w-7 ring-2 ring-zinc-900">
                            <AuthAvatarImage src={presence?.avatarUrl} />
                            <AvatarFallback className="text-[10px] bg-zinc-700">{initial}</AvatarFallback>
                          </Avatar>
                        </div>
                      );
                    })}
                    {overflowCount > 0 && (
                      <div className="opacity-60 transition-opacity duration-150" title={`+${overflowCount} more`}>
                        <div className="h-7 w-7 rounded-full bg-zinc-800 ring-2 ring-zinc-900 flex items-center justify-center text-[10px] text-zinc-200">
                          +{overflowCount}
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="rounded-full bg-zinc-900/80 backdrop-blur px-2 py-1 text-[11px] text-zinc-200 tabular-nums whitespace-nowrap">
                    {voiceMembers.length} watching
                  </span>
                </div>
              )}
            </div>

            {/* Controls bar */}
            <div className="flex flex-col gap-1.5 px-3 py-2 bg-zinc-900 border-t border-border shrink-0">
              {/* Progress bar + volume */}
              {watchState.videoUrl && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="shrink-0 tabular-nums w-10 text-right">
                    {formatTime(Math.max(0, displayPosition))}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={videoDuration || 14400}
                    step={1}
                    value={Math.max(0, displayPosition)}
                    onChange={handleSeekDrag}
                    onPointerUp={handleSeekCommit}
                    className="flex-1 accent-purple-500 cursor-pointer h-1"
                  />
                  {/* Volume */}
                  <button
                    onClick={handleToggleMute}
                    className="shrink-0 hover:text-zinc-200 transition-colors cursor-pointer"
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
                    className="w-16 shrink-0 accent-zinc-400 cursor-pointer h-1"
                    title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
                  />
                </div>
              )}

              {/* Action row — available to all users */}
              <div className="flex items-center gap-2">
                {watchState.videoUrl && (
                  <button
                    onClick={handlePlayPause}
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
                  className="flex-1 h-7 text-xs bg-zinc-800 border-zinc-700 placeholder:text-zinc-500"
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
                  className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors cursor-pointer shrink-0"
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
