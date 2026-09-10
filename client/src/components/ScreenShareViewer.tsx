import { useRef, useEffect, useState, useCallback } from "react";
import { useAppContext, screenStreamsMap, webcamStreamsMap } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn, displayUserId } from "@/lib/utils";
import { ScreenFpsMenu } from "./voice/ScreenFpsMenu";
import { useScreenShareFps } from "@/hooks/useScreenShareFps";
import { ClipControls } from "./voice/ClipControls";
import { useIsMobile } from "@/hooks/use-mobile";


/** Header bar shown above the resizable panel group — always visible */
/** How long the overlay stays up after the last sign of life. */
const CONTROLS_IDLE_MS = 2500;

/** Below this a press is a tap rather than the start of a pan or a pinch. */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;

/**
 * Fade the overlay out when nothing is happening, back in on any pointer
 * movement over the video.
 *
 * It refuses to hide while the bar is being used: with the pointer on it, with
 * focus inside it, or with one of its menus open. That last check is why it
 * looks at the DOM rather than tracking each menu — the FPS and clip menus
 * render their content in a portal, so neither the pointer nor focus is inside
 * the header while one is open, and the bar would otherwise fade out from
 * under a menu the user was reading.
 *
 * A touch screen has no pointer to move and none to rest on the bar, so the
 * fade there was one-way: the bar went after two and a half seconds and
 * nothing could bring it back, taking Close, the sharer switcher and
 * fullscreen with it. On touch a tap on the video toggles it instead, and
 * only a tap — a pan or a pinch leaves it alone.
 */
function useIdleFade(
  hostRef: React.RefObject<HTMLElement | null>,
  headerRef: React.RefObject<HTMLElement | null>,
) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const inUse = () => {
      const header = headerRef.current;
      if (!header) return false;
      return (
        header.matches(":hover") ||
        header.contains(document.activeElement) ||
        header.querySelector('[data-state="open"]') !== null
      );
    };

    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (inUse()) {
          settle();
          return;
        }
        setVisible(false);
      }, CONTROLS_IDLE_MS);
    };

    const wake = () => {
      setVisible(true);
      settle();
    };

    let downAt = 0;
    let downX = 0;
    let downY = 0;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        wake();
        return;
      }
      downAt = e.timeStamp;
      downX = e.clientX;
      downY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (e.timeStamp - downAt > TAP_MAX_MS || moved > TAP_SLOP_PX) return;
      // Revealed by a tap, it stays until another one: 2.5s is not long
      // enough to notice the bar and reach the button you wanted.
      clearTimeout(timer);
      setVisible((v) => !v);
    };

    wake();
    host.addEventListener("mousemove", wake);
    host.addEventListener("mouseenter", wake);
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointerup", onPointerUp);
    return () => {
      clearTimeout(timer);
      host.removeEventListener("mousemove", wake);
      host.removeEventListener("mouseenter", wake);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointerup", onPointerUp);
    };
  }, [hostRef, headerRef]);

  return visible;
}

export function ScreenShareHeader({
  containerRef,
  hostRef,
  isPiP,
  onTogglePiP,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The video area whose pointer activity keeps the bar awake. */
  hostRef: React.RefObject<HTMLDivElement | null>;
  isPiP?: boolean;
  onTogglePiP?: () => void;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const controlsVisible = useIdleFade(hostRef, headerRef);
  const isMobile = useIsMobile();
  // 28px squares are a mouse size. A thumb needs the best part of 40, which
  // the bar can afford because it floats over the video rather than above it.
  const ctrlBtn = isMobile
    ? "h-10 w-10 p-0 text-muted-foreground hover:text-foreground"
    : "h-7 w-7 p-0 text-muted-foreground hover:text-foreground";
  const iconPx = isMobile ? 18 : 14;
  const { state, dispatch } = useAppContext();
  const { screenFps } = useScreenShareFps();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const supportsPiP = (() => { try { return !!document.pictureInPictureEnabled; } catch { return false; } })();

  const sharers = state.activeScreenSharers;
  const hasContent = sharers.length > 0 || state.activeWebcamStreamers.length > 0;

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
    !hasContent ||
    !state.inVoiceChannel
  ) {
    return null;
  }

  return (
    <div
      ref={headerRef}
      className={cn(
        "absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 py-1.5",
        "bg-background/70 backdrop-blur-sm border-b border-info/20",
        "transition-opacity duration-200",
        // Faded out it must not swallow clicks meant for the video.
        controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
        </span>
        <p className="text-sm font-semibold text-info truncate">
          {state.selectedScreenSharer
            ? state.selectedScreenSharer === state.userId
              ? "Your screen (preview)"
              : `${displayUserId(state.selectedScreenSharer)}'s screen`
            : "Screen Share"}
        </p>
        {state.isScreenSharing && (() => {
          const viewers = state.screenViewers[state.userId!] || [];
          if (viewers.length === 0) return (
            <span className="text-xs text-muted-foreground">No viewers</span>
          );
          if (viewers.length <= 3) return (
            <span className="text-xs text-info">
              {viewers.map(displayUserId).join(", ")}
            </span>
          );
          return (
            <span className="text-xs text-info">
              {viewers.length} viewers
            </span>
          );
        })()}
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
                  "rounded text-xs font-medium transition-colors cursor-pointer",
                  isMobile ? "px-3 py-2.5" : "px-2 py-1",
                  sharerId === state.selectedScreenSharer
                    ? "bg-info text-background"
                    : "bg-info/20 text-info hover:bg-info/30"
                )}
              >
                {sharerId === state.userId ? "You" : displayUserId(sharerId)}
              </button>
            ))}
          </div>
        )}
        <ClipControls />
        {state.isScreenSharing && (
          <ScreenFpsMenu>
            <Button
              size="sm"
              variant="ghost"
              className={cn("px-2 text-xs font-medium text-muted-foreground hover:text-foreground", isMobile ? "h-10" : "h-7")}
              title="Screen share quality"
            >
              {screenFps} FPS
            </Button>
          </ScreenFpsMenu>
        )}
        {onTogglePiP && supportsPiP && (
          <Button
            size="sm"
            variant="ghost"
            className={ctrlBtn}
            onClick={onTogglePiP}
            title={isPiP ? "Exit Picture-in-Picture" : "Picture-in-Picture"}
          >
            {isPiP ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={iconPx}
                height={iconPx}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <path d="M8 21h8M12 17v4" />
                <path d="M7 9l5 3-5 3V9z" fill="currentColor" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={iconPx}
                height={iconPx}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <rect x="12" y="9" width="8" height="6" rx="1" />
              </svg>
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className={ctrlBtn}
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={iconPx}
              height={iconPx}
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
              width={iconPx}
              height={iconPx}
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
          className={ctrlBtn}
          onClick={closeViewer}
          title="Close viewer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={iconPx}
            height={iconPx}
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
  const mainWebcamVideoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const thumbVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const webcamVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [, setStreamVersion] = useState(0);

  // Per-sharer volume state (persists when switching between sharers)
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
  const [screenMuted, setScreenMuted] = useState<Record<string, boolean>>({});

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  // Every pointer currently down on the video, so one finger can pan and two
  // can pinch. A mouse only ever puts one entry in here.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const lastTapAt = useRef(0);

  // Reset zoom/pan when switching sharers
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [state.selectedScreenSharer]);

  // Clamp pan so the video edge can reach the container edge but not beyond.
  // The CSS applies: scale(z) translate(px/z %, py/z %).
  // At zoom z, the visible portion is 1/z of the total. To pan the edge
  // of the content to the edge of the viewport: max translate = (z-1)/z * 50%.
  // Since CSS divides by z: maxPan = (z-1) * 50.
  const clampPan = useCallback((px: number, py: number, z: number) => {
    if (z <= 1) return { x: 0, y: 0 };
    const maxPan = (z - 1) * 50;
    return {
      x: Math.max(-maxPan, Math.min(maxPan, px)),
      y: Math.max(-maxPan, Math.min(maxPan, py)),
    };
  }, []);

  const clampPanRef = useRef(clampPan);
  clampPanRef.current = clampPan;

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  // One set of handlers for mouse, pen and touch. Panning a zoomed image was
  // mouse-only before, and zooming was the scroll wheel — between them a phone
  // could neither zoom nor move around a screen share, which is where reading
  // someone's terminal actually needs it.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // A second finger cancels the pan it interrupted and starts a pinch.
      isDragging.current = false;
      pinch.current = { dist: spread(), zoom };
      return;
    }
    if (pointers.current.size > 2) return;
    if (zoom <= 1) return;
    // Capture rather than a mouseleave handler: the drag now survives the
    // pointer leaving the video, and ends wherever it is actually released.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    // Without this a drag across the video starts a native selection instead.
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    panStart.current = { ...pan };
  }, [zoom, pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const start = pinch.current;
      if (start.dist <= 0) return;
      const next = Math.max(1, Math.min(10, (start.zoom * spread()) / start.dist));
      setZoom(next);
      setPan((prev) =>
        next <= 1 ? { x: 0, y: 0 } : clampPanRef.current(prev.x, prev.y, next),
      );
      return;
    }

    if (!isDragging.current || !videoContainerRef.current) return;
    const rect = videoContainerRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStart.current.x) / rect.width) * 100;
    const dy = ((e.clientY - dragStart.current.y) / rect.height) * 100;
    setPan(clampPan(panStart.current.x + dx, panStart.current.y + dy, zoom));
  }, [zoom, clampPan]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const down = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) isDragging.current = false;

    // Double-tap to reset, the touch counterpart of the double-click below.
    // `dblclick` is synthesised inconsistently on mobile browsers, so it is
    // measured here rather than relied on.
    if (e.pointerType === "mouse" || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > TAP_SLOP_PX) return;
    const now = e.timeStamp;
    if (now - lastTapAt.current < 300) {
      resetZoom();
      lastTapAt.current = 0;
    } else {
      lastTapAt.current = now;
    }
  }, [resetZoom]);

  const sharers = state.activeScreenSharers;
  const webcamStreamers = state.activeWebcamStreamers;

  const currentSharer = state.selectedScreenSharer;
  const currentWebcamStreamer = state.selectedWebcamStreamer;
  // A webcam is focused in the main view when explicitly selected, or when
  // there are no screen sharers at all.
  const focusedWebcam = currentWebcamStreamer
    ?? (sharers.length === 0 && webcamStreamers.length > 0 ? webcamStreamers[0] : null);
  const showingWebcam = focusedWebcam !== null && (currentWebcamStreamer !== null || !currentSharer);
  const isSelfSharer = currentSharer === state.userId;
  const isSelfWebcam = focusedWebcam === state.userId;
  const currentVolume = currentSharer ? (screenVolumes[currentSharer] ?? 50) : 50;
  const currentMuted = currentSharer ? (screenMuted[currentSharer] ?? false) : false;

  // Listen for stream updates from VoiceControls
  useEffect(() => {
    const handler = () => setStreamVersion((v) => v + 1);
    window.addEventListener("screen-stream-update", handler);
    window.addEventListener("webcam-stream-update", handler);
    return () => {
      window.removeEventListener("screen-stream-update", handler);
      window.removeEventListener("webcam-stream-update", handler);
    };
  }, []);

  // Attach streams to video elements and apply volume
  useEffect(() => {
    if (currentSharer && mainVideoRef.current) {
      const stream = screenStreamsMap.get(currentSharer);
      if (stream && mainVideoRef.current.srcObject !== stream) {
        mainVideoRef.current.srcObject = stream;
        mainVideoRef.current.play().catch(() => {});
      }
      mainVideoRef.current.muted = isSelfSharer;
      mainVideoRef.current.volume = (isSelfSharer || currentMuted) ? 0 : currentVolume / 100;
    }
    if (focusedWebcam && mainWebcamVideoRef.current) {
      const stream = webcamStreamsMap.get(focusedWebcam);
      if (stream && mainWebcamVideoRef.current.srcObject !== stream) {
        mainWebcamVideoRef.current.srcObject = stream;
        mainWebcamVideoRef.current.play().catch(() => {});
      }
      mainWebcamVideoRef.current.muted = isSelfWebcam;
    }
    // Screen share thumbnails
    screenStreamsMap.forEach((stream, sharerId) => {
      const el = thumbVideoRefs.current.get(sharerId);
      if (el && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
    });
    // Webcam thumbnails
    webcamStreamsMap.forEach((stream, userId) => {
      const el = webcamVideoRefs.current.get(userId);
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

  // Wheel zoom — non-passive listener, attached after the DOM renders
  const viewerVisible = state.screenViewerOpen && (sharers.length > 0 || webcamStreamers.length > 0) && state.inVoiceChannel;
  useEffect(() => {
    const container = videoContainerRef.current;
    if (!viewerVisible || !container) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setZoom((prevZoom) => {
        const delta = e.deltaY > 0 ? -0.2 : 0.2;
        const newZoom = Math.max(1, Math.min(10, prevZoom + delta * prevZoom * 0.3));
        if (newZoom <= 1) {
          setPan({ x: 0, y: 0 });
        } else {
          setPan((prev) => clampPanRef.current(prev.x, prev.y, newZoom));
        }
        return newZoom;
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [viewerVisible]);

  if (
    !state.screenViewerOpen ||
    (sharers.length === 0 && webcamStreamers.length === 0) ||
    !state.inVoiceChannel
  ) {
    return null;
  }

  return (
    <div className="flex flex-col min-h-0 h-full bg-black/95">
      {/* Main video */}
      <div
        ref={videoContainerRef}
        className={cn(
          "flex-1 flex items-center justify-center bg-black min-h-0 relative group overflow-hidden",
          // `active:` rather than the drag flag: that lives in a ref, which
          // never re-renders, so the grabbing cursor never actually appeared.
          zoom > 1 && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={resetZoom}
        // The browser must not claim the gesture for scrolling or its own
        // pinch-zoom — nothing here scrolls, and the pinch is ours.
        style={{ touchAction: "none" }}
      >
        {showingWebcam && focusedWebcam && webcamStreamsMap.has(focusedWebcam) ? (
          <div className="w-full h-full flex items-center justify-center">
            <video
              ref={mainWebcamVideoRef}
              autoPlay
              playsInline
              className="object-contain w-full h-full bg-black select-none"
              draggable={false}
            />
          </div>
        ) : currentSharer && screenStreamsMap.has(currentSharer) ? (
          <div
            className="w-full h-full"
            style={{
              transform: zoom > 1
                ? `scale(${zoom}) translate(${pan.x / zoom}%, ${pan.y / zoom}%)`
                : undefined,
              transformOrigin: "center center",
              willChange: zoom > 1 ? "transform" : undefined,
            }}
          >
            <video
              ref={mainVideoRef}
              autoPlay
              playsInline
              className="object-contain w-full h-full bg-black select-none"
              draggable={false}
            />
          </div>
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
            <p className="text-sm">Connecting to stream…</p>
          </div>
        )}

      {/* Zoom indicator */}
      {zoom > 1 && (
        <div className="absolute left-3 bottom-3 flex items-center gap-1.5 px-2 py-1 bg-black/60 rounded-lg text-xs text-white/80">
          <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            className="text-white/60 hover:text-white cursor-pointer"
            onClick={resetZoom}
            title="Reset zoom (or double-tap)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Volume controls overlay */}
      {state.selectedScreenSharer &&
        screenStreamsMap.has(state.selectedScreenSharer) && (
        <div className="absolute right-3 bottom-3 flex flex-col items-center gap-2 px-2 py-2.5 bg-black/60 rounded-lg can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity">
          <span className="text-xs text-white/60 tabular-nums">
            {currentMuted ? 0 : currentVolume}%
          </span>
          <Slider
            value={[currentMuted ? 0 : currentVolume]}
            onValueChange={([v]) => setVolume(v)}
            max={100}
            step={1}
            orientation="vertical"
            style={{ height: '5rem', minHeight: '5rem' }}
          />
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
        </div>
      )}
      </div>

      {/* Unified thumbnail strip — shown whenever there are multiple feeds */}
      {(sharers.length + webcamStreamers.length) > 1 && (
        <div className="flex gap-2 p-2 bg-black/80 border-t border-white/10 overflow-x-auto shrink-0">
          {sharers.map((sharerId) => {
            const isSelected = !showingWebcam && sharerId === state.selectedScreenSharer;
            return (
              <button
                key={`screen-${sharerId}`}
                className={cn(
                  "relative shrink-0 w-28 rounded-md border-2 overflow-hidden bg-black aspect-video cursor-pointer transition-all",
                  isSelected
                    ? "border-info ring-1 ring-info/50"
                    : "border-border/50 hover:border-info/50 opacity-70 hover:opacity-100"
                )}
                onClick={() => dispatch({ type: "SET_SCREEN_VIEWER", payload: { sharer: sharerId } })}
              >
                <video
                  ref={(el) => { if (el) thumbVideoRefs.current.set(sharerId, el); }}
                  autoPlay playsInline muted
                  className="w-full h-full object-contain"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-0.5 flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-info shrink-0">
                    <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                  <p className="text-3xs text-info font-semibold truncate">
                    {sharerId === state.userId ? "You" : displayUserId(sharerId)}
                  </p>
                </div>
              </button>
            );
          })}
          {webcamStreamers.map((userId) => {
            const isSelected = showingWebcam && userId === focusedWebcam;
            return (
              <button
                key={`webcam-${userId}`}
                className={cn(
                  "relative shrink-0 rounded-md border-2 overflow-hidden bg-black cursor-pointer transition-all",
                  isSelected
                    ? "border-blue-500 ring-1 ring-blue-500/50"
                    : "border-border/50 hover:border-blue-500/50 opacity-70 hover:opacity-100"
                )}
                style={{ width: "7rem", aspectRatio: "4/3" }}
                onClick={() => dispatch({ type: "SET_SCREEN_VIEWER", payload: { webcamStreamer: userId } })}
              >
                {webcamStreamsMap.has(userId) ? (
                  <video
                    ref={(el) => { if (el) webcamVideoRefs.current.set(userId, el); }}
                    autoPlay playsInline muted={userId === state.userId}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-400/50">
                      <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-0.5 flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-300 shrink-0">
                    <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                  </svg>
                  <p className="text-3xs text-blue-300 font-semibold truncate">
                    {userId === state.userId ? "You" : displayUserId(userId)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
