import { useState, useEffect, useCallback, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  TypeScript declarations for the Google Cast SDK (CAF)              */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    cast?: typeof cast;
    chrome?: { cast?: typeof chrome.cast };
  }
}

declare namespace cast {
  namespace framework {
    class CastContext {
      static getInstance(): CastContext;
      setOptions(options: {
        receiverApplicationId: string;
        autoJoinPolicy: string;
      }): void;
      requestSession(): Promise<void>;
      getCurrentSession(): CastSession | null;
      getCastState(): string;
      addEventListener(
        type: string,
        handler: (event: { castState: string }) => void,
      ): void;
      removeEventListener(
        type: string,
        handler: (event: { castState: string }) => void,
      ): void;
    }
    class CastSession {
      getSessionObj(): chrome.cast.Session;
      getMediaSession(): chrome.cast.media.Media | null;
      loadMedia(
        request: chrome.cast.media.LoadRequest,
      ): Promise<void>;
      endSession(stopCasting: boolean): void;
    }
    enum CastState {
      NO_DEVICES_AVAILABLE = "NO_DEVICES_AVAILABLE",
      NOT_CONNECTED = "NOT_CONNECTED",
      CONNECTING = "CONNECTING",
      CONNECTED = "CONNECTED",
    }
    enum CastContextEventType {
      CAST_STATE_CHANGED = "caststatechanged",
    }
    enum SessionEventType {
      MEDIA_SESSION = "MEDIA_SESSION",
    }
  }
}

declare namespace chrome.cast {
  class Session {
    displayName: string;
  }
  namespace media {
    class MediaInfo {
      constructor(contentId: string, contentType: string);
      contentId: string;
      contentType: string;
      metadata: GenericMediaMetadata | null;
    }
    class LoadRequest {
      constructor(mediaInfo: MediaInfo);
      autoplay: boolean;
      currentTime: number;
    }
    class GenericMediaMetadata {
      title: string;
      images: Array<{ url: string }>;
    }
    class Media {
      playerState: string;
      play(
        request: null,
        onSuccess: () => void,
        onError: () => void,
      ): void;
      pause(
        request: null,
        onSuccess: () => void,
        onError: () => void,
      ): void;
      stop(
        request: null,
        onSuccess: () => void,
        onError: () => void,
      ): void;
    }
    enum PlayerState {
      IDLE = "IDLE",
      PLAYING = "PLAYING",
      PAUSED = "PAUSED",
      BUFFERING = "BUFFERING",
    }
  }
  class AutoJoinPolicy {
    static ORIGIN_SCOPED: string;
  }
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export type CastState = "unavailable" | "available" | "connecting" | "connected";

const SDK_STATE_MAP: Record<string, CastState> = {
  NO_DEVICES_AVAILABLE: "unavailable",
  NOT_CONNECTED: "available",
  CONNECTING: "connecting",
  CONNECTED: "connected",
};

let sdkInitialised = false;
const sdkReadyCallbacks: Array<() => void> = [];

function ensureSdkInit() {
  if (sdkInitialised) return;

  const tryInit = () => {
    if (!window.cast?.framework) return false;
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId:
        chrome.cast?.AutoJoinPolicy
          ? "CC1AD845" // Default Media Receiver
          : "CC1AD845",
      autoJoinPolicy: "ORIGIN_SCOPED",
    });
    sdkInitialised = true;
    for (const cb of sdkReadyCallbacks) cb();
    sdkReadyCallbacks.length = 0;
    return true;
  };

  if (tryInit()) return;

  // SDK not loaded yet — wait for the callback
  const prev = window.__onGCastApiAvailable;
  window.__onGCastApiAvailable = (isAvailable: boolean) => {
    prev?.(isAvailable);
    if (isAvailable) tryInit();
  };
}

export function useChromecast() {
  const [castState, setCastState] = useState<CastState>("unavailable");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const castingUrl = useRef<string | null>(null);

  useEffect(() => {
    ensureSdkInit();

    const update = () => {
      if (!window.cast?.framework) return;
      const ctx = cast.framework.CastContext.getInstance();
      const raw = ctx.getCastState();
      setCastState(SDK_STATE_MAP[raw] ?? "unavailable");

      const session = ctx.getCurrentSession();
      if (session) {
        setDeviceName(session.getSessionObj().displayName ?? null);
      } else {
        setDeviceName(null);
        castingUrl.current = null;
      }
    };

    if (sdkInitialised) {
      const ctx = cast.framework.CastContext.getInstance();
      ctx.addEventListener("caststatechanged", update);
      update();
      return () => ctx.removeEventListener("caststatechanged", update);
    }

    // SDK not ready yet — register for later
    const cb = () => {
      const ctx = cast.framework.CastContext.getInstance();
      ctx.addEventListener("caststatechanged", update);
      update();
    };
    sdkReadyCallbacks.push(cb);
    return () => {
      const idx = sdkReadyCallbacks.indexOf(cb);
      if (idx !== -1) sdkReadyCallbacks.splice(idx, 1);
    };
  }, []);

  const castVideo = useCallback(
    async (url: string, title?: string, thumbnailUrl?: string) => {
      if (!window.cast?.framework || !window.chrome?.cast) return;
      const ctx = cast.framework.CastContext.getInstance();

      // If not connected, prompt for device selection first
      if (ctx.getCastState() !== "CONNECTED") {
        try {
          await ctx.requestSession();
        } catch {
          return; // User cancelled
        }
      }

      const session = ctx.getCurrentSession();
      if (!session) return;

      // Determine content type from URL extension
      const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
      const typeMap: Record<string, string> = {
        mp4: "video/mp4",
        webm: "video/webm",
        ogg: "video/ogg",
        mov: "video/mp4",
        mkv: "video/mp4", // served as remuxed mp4
      };
      const contentType = typeMap[ext] || "video/mp4";

      const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);
      if (title || thumbnailUrl) {
        const metadata = new chrome.cast.media.GenericMediaMetadata();
        if (title) metadata.title = title;
        if (thumbnailUrl) metadata.images = [{ url: thumbnailUrl }];
        mediaInfo.metadata = metadata;
      }

      const request = new chrome.cast.media.LoadRequest(mediaInfo);
      request.autoplay = true;
      request.currentTime = 0;

      try {
        await session.loadMedia(request);
        castingUrl.current = url;
      } catch (e) {
        console.error("Cast loadMedia failed:", e);
      }
    },
    [],
  );

  const stopCasting = useCallback(() => {
    if (!window.cast?.framework) return;
    const session =
      cast.framework.CastContext.getInstance().getCurrentSession();
    if (session) {
      session.endSession(true);
      castingUrl.current = null;
    }
  }, []);

  return {
    castState,
    deviceName,
    castVideo,
    stopCasting,
    isCasting: (url: string) => castingUrl.current === url,
  };
}
