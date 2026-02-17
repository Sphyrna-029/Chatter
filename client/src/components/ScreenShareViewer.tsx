import { useRef, useEffect, useState, useCallback } from "react";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const shortenId = (id: string) =>
  id.split(":")[0]?.replace("@", "") || id;

/** Header bar shown above the resizable panel group — always visible */
export function ScreenShareHeader({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { state, dispatch } = useAppContext();
  const [isFullscreen, setIsFullscreen] = useState(false);

  const sharers = state.activeScreenSharers;

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  }, [containerRef]);

  const closeViewer = useCallback(() => {
    dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false } });
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [dispatch]);

  if (
    !state.screenViewerOpen ||
    sharers.length === 0 ||
    !state.inVoiceChannel
  ) {
    return null;
  }

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-purple-500/10 border-b border-purple-500/20 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        <p className="text-sm font-semibold text-purple-300 truncate">
          {state.selectedScreenSharer
            ? state.selectedScreenSharer === state.userId
              ? "Your screen (preview)"
              : `${shortenId(state.selectedScreenSharer)}'s screen`
            : "Screen Share"}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {sharers.length > 1 && (
          <div className="flex items-center gap-1 mr-2">
            {sharers.map((sharerId) => (
              <button
                key={sharerId}
                onClick={() =>
                  dispatch({
                    type: "SET_SCREEN_VIEWER",
                    payload: { sharer: sharerId },
                  })
                }
                className={cn(
                  "px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer",
                  sharerId === state.selectedScreenSharer
                    ? "bg-purple-500 text-white"
                    : "bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                )}
              >
                {sharerId === state.userId ? "You" : shortenId(sharerId)}
              </button>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={closeViewer}
          title="Close viewer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </Button>
      </div>
    </div>
  );
}

/** Video content — goes inside the resizable panel */
export function ScreenShareViewer() {
  const { state, dispatch } = useAppContext();
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const thumbVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [, setStreamVersion] = useState(0);

  // Per-sharer volume state (persists when switching between sharers)
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
  const [screenMuted, setScreenMuted] = useState<Record<string, boolean>>({});

  const sharers = state.activeScreenSharers;

  const currentSharer = state.selectedScreenSharer;
  const isSelfSharer = currentSharer === state.userId;
  const currentVolume = currentSharer ? (screenVolumes[currentSharer] ?? 50) : 50;
  const currentMuted = currentSharer ? (screenMuted[currentSharer] ?? false) : false;

  // Listen for stream updates from VoiceControls
  useEffect(() => {
    const handler = () => setStreamVersion((v) => v + 1);
    window.addEventListener("screen-stream-update", handler);
    return () => window.removeEventListener("screen-stream-update", handler);
  }, []);

  // Attach streams to video elements and apply volume
  useEffect(() => {
    if (currentSharer && mainVideoRef.current) {
      const stream = screenStreamsMap.get(currentSharer);
      if (stream && mainVideoRef.current.srcObject !== stream) {
        mainVideoRef.current.srcObject = stream;
        mainVideoRef.current.play().catch(() => {});
      }
      // Mute own stream to avoid audio feedback loop
      mainVideoRef.current.muted = isSelfSharer;
      mainVideoRef.current.volume = (isSelfSharer || currentMuted) ? 0 : currentVolume / 100;
    }
    // Thumbnails
    screenStreamsMap.forEach((stream, sharerId) => {
      const el = thumbVideoRefs.current.get(sharerId);
      if (el && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
    });
  });

  const setVolume = useCallback((vol: number) => {
    if (!currentSharer) return;
    setScreenVolumes((prev) => ({ ...prev, [currentSharer]: vol }));
    if (mainVideoRef.current) {
      mainVideoRef.current.volume = currentMuted ? 0 : vol / 100;
    }
  }, [currentSharer, currentMuted]);

  const toggleMute = useCallback(() => {
    if (!currentSharer) return;
    const newMuted = !currentMuted;
    setScreenMuted((prev) => ({ ...prev, [currentSharer]: newMuted }));
    if (mainVideoRef.current) {
      mainVideoRef.current.volume = newMuted ? 0 : currentVolume / 100;
    }
  }, [currentSharer, currentMuted, currentVolume]);

  if (
    !state.screenViewerOpen ||
    sharers.length === 0 ||
    !state.inVoiceChannel
  ) {
    return null;
  }

  return (
    <div className="flex flex-col min-h-0 h-full relative bg-black/95">
      {/* Main video */}
      <div className="flex-1 flex items-center justify-center bg-black min-h-0">
        {state.selectedScreenSharer &&
        screenStreamsMap.has(state.selectedScreenSharer) ? (
          <video
            ref={mainVideoRef}
            autoPlay
            playsInline
            className="object-contain w-full h-full bg-black"
          />
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mb-2 opacity-50"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <p className="text-sm">Connecting to stream...</p>
          </div>
        )}
      </div>

      {/* Volume controls overlay */}
      {state.selectedScreenSharer &&
        screenStreamsMap.has(state.selectedScreenSharer) && (
        <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 hover:opacity-100 transition-opacity">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-white/80 hover:text-white shrink-0"
            onClick={toggleMute}
            title={currentMuted ? "Unmute" : "Mute"}
          >
            {currentMuted || currentVolume === 0 ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            )}
          </Button>
          <Slider
            value={[currentMuted ? 0 : currentVolume]}
            onValueChange={([v]) => setVolume(v)}
            max={100}
            step={1}
            className="w-32"
          />
          <span className="text-xs text-white/60 w-8 text-right tabular-nums">
            {currentMuted ? 0 : currentVolume}%
          </span>
        </div>
      )}

      {/* Preview thumbnails for multiple sharers */}
      {sharers.length > 1 && (
        <div className="flex gap-2 p-2 bg-black/80 border-t border-purple-500/20 overflow-x-auto shrink-0">
          {sharers.map((sharerId) => (
            <button
              key={sharerId}
              className={cn(
                "relative shrink-0 w-28 rounded-md border-2 overflow-hidden bg-black aspect-video cursor-pointer transition-all",
                sharerId === state.selectedScreenSharer
                  ? "border-purple-500 ring-1 ring-purple-500/50"
                  : "border-border/50 hover:border-purple-500/50 opacity-70 hover:opacity-100"
              )}
              onClick={() =>
                dispatch({
                  type: "SET_SCREEN_VIEWER",
                  payload: { sharer: sharerId },
                })
              }
            >
              <video
                ref={(el) => {
                  if (el) thumbVideoRefs.current.set(sharerId, el);
                }}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-0.5">
                <p className="text-[10px] text-purple-300 font-semibold truncate">
                  {sharerId === state.userId ? "You" : shortenId(sharerId)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
