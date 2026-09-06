import { useEffect, useRef } from "react";
import { useAppContext, resumePointsMap } from "@/lib/store";

/**
 * Picks a video up where this user left it, on whatever device they left it on.
 *
 * The position is bookmarked while playing and restored once, when the browser
 * first knows how long the video is. The server decides what is worth
 * remembering — a barely-started or as-good-as-finished video is discarded
 * rather than stored (see backend/routes/continuity.rs), so the client can
 * simply seek to whatever came back.
 */

/** How often a playing video banks its position. Frequent enough to lose only
 *  a few seconds to a crash, rare enough not to be chatty. */
const SAVE_INTERVAL_MS = 10_000;

/** Matches MIN_RESUME_SECS on the server: below this there is nothing to
 *  return to, and seeking would be a surprise rather than a convenience. */
const MIN_RESUME_SECS = 30;

export function useVideoResume(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  url: string,
) {
  const { saveResumePoint } = useAppContext();
  // Restoring must happen once per source. Without this a user who seeks back
  // under 30s, triggering a metadata event, would be thrown forward again.
  const restoredRef = useRef<string | null>(null);
  const lastSaveRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    const restore = () => {
      if (restoredRef.current === url) return;
      restoredRef.current = url;
      const point = resumePointsMap.get(url);
      if (!point || point.positionSecs < MIN_RESUME_SECS) return;
      // A stored position past the end of what actually loaded would seek to
      // the last frame; leave the video alone rather than land there.
      if (video.duration && point.positionSecs >= video.duration) return;
      try {
        video.currentTime = point.positionSecs;
      } catch {
        // Some sources refuse a seek before they are seekable; not worth retrying.
      }
    };

    const onTimeUpdate = () => {
      if (video.paused || video.seeking) return;
      const now = Date.now();
      if (now - lastSaveRef.current < SAVE_INTERVAL_MS) return;
      lastSaveRef.current = now;
      void saveResumePoint(url, video.currentTime, video.duration || 0);
    };

    // Pausing is the strongest signal someone is stepping away, so bank it
    // immediately rather than waiting for the next interval.
    const onPause = () => {
      if (video.ended) return;
      lastSaveRef.current = Date.now();
      void saveResumePoint(url, video.currentTime, video.duration || 0);
    };

    // Watching to the end clears the bookmark: the server treats a position at
    // the end as nothing worth resuming, so a rewatch starts from the top.
    const onEnded = () => {
      void saveResumePoint(url, video.duration || 0, video.duration || 0);
    };

    video.addEventListener("loadedmetadata", restore);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    // The element may already have metadata by the time this runs.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) restore();

    return () => {
      video.removeEventListener("loadedmetadata", restore);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      // Unmounting mid-playback — scrolled away, or the channel changed — is
      // still a place worth returning to.
      if (!video.ended && video.currentTime > 0) {
        void saveResumePoint(url, video.currentTime, video.duration || 0);
      }
    };
  }, [videoRef, url, saveResumePoint]);
}
