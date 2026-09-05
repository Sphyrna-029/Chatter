import { useCallback, useEffect, useRef } from "react";

/**
 * A rolling buffer of the last N seconds of a screen share, kept encoded.
 *
 * Two recorders run staggered rather than one, because a MediaRecorder's later
 * chunks are not independently decodable — only its first carries the container
 * header. Dropping the oldest chunk of a single recorder would leave a blob
 * nothing can play. With two, one has always been running long enough to cover
 * the whole window on its own, so a clip is one recorder's complete output.
 *
 * The cost is real: a second video encoder runs for as long as this is armed,
 * and the buffer holds roughly bitrate x window bytes (~45MB for 30s of a
 * 12Mbps 1080p60 share, doubled by the overlap). It stays off until asked for.
 */

export const CLIP_LENGTH_OPTIONS = [15, 30, 60] as const;
export type ClipLength = (typeof CLIP_LENGTH_OPTIONS)[number];

export const CLIP_LENGTH_STORAGE_KEY = "chatter_clip_length_secs";
export const DEFAULT_CLIP_LENGTH: ClipLength = 30;

/** Chunk cadence. Small enough to trim close to the requested window. */
const TIMESLICE_MS = 1000;
/** Cap what a viewer re-encode may spend; the source is already capped lower. */
const CLIP_BITS_PER_SECOND = 8_000_000;

export function loadClipLength(): ClipLength {
  try {
    const raw = Number(localStorage.getItem(CLIP_LENGTH_STORAGE_KEY));
    return (CLIP_LENGTH_OPTIONS as readonly number[]).includes(raw)
      ? (raw as ClipLength)
      : DEFAULT_CLIP_LENGTH;
  } catch {
    return DEFAULT_CLIP_LENGTH;
  }
}

export function storeClipLength(secs: ClipLength): void {
  try {
    localStorage.setItem(CLIP_LENGTH_STORAGE_KEY, String(secs));
  } catch {
    // The preference just will not survive the reload.
  }
}

/** The first MIME type the browser will actually record. */
function pickMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // Older browsers throw rather than answer.
    }
  }
  return undefined;
}

export function clipBufferSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && pickMimeType() !== undefined;
}

interface Leg {
  recorder: MediaRecorder;
  chunks: Blob[];
  /** When this leg started, so we know whether it spans the whole window. */
  startedAt: number;
}

export function useClipBuffer(
  stream: MediaStream | null,
  enabled: boolean,
  lengthSecs: number,
) {
  const legsRef = useRef<Leg[]>([]);
  const mimeRef = useRef<string | undefined>(undefined);
  // Derived rather than tracked: buffering is exactly "asked for, with a stream,
  // on a browser that can record". A recorder that fails to start leaves the
  // buffer empty, which takeClip already reports.
  const armed = enabled && stream !== null && clipBufferSupported();

  useEffect(() => {
    if (!armed) return;

    const mime = pickMimeType();
    mimeRef.current = mime;
    let stopped = false;
    let rotateTimer: ReturnType<typeof setInterval> | null = null;

    const startLeg = () => {
      if (stopped) return;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType: mime,
          videoBitsPerSecond: CLIP_BITS_PER_SECOND,
        });
      } catch {
        return;
      }
      const leg: Leg = { recorder, chunks: [], startedAt: Date.now() };
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) leg.chunks.push(e.data);
        // Trim to a little over the window; a leg older than two windows has
        // already been replaced by its successor.
        const maxChunks = Math.ceil((lengthSecs * 2000) / TIMESLICE_MS);
        if (leg.chunks.length > maxChunks) {
          leg.chunks.splice(0, leg.chunks.length - maxChunks);
        }
      };
      recorder.onerror = () => { /* the other leg carries on */ };
      try {
        recorder.start(TIMESLICE_MS);
      } catch {
        return;
      }
      legsRef.current.push(leg);
      // Keep only the current leg and the one before it.
      while (legsRef.current.length > 2) {
        const old = legsRef.current.shift();
        try { old?.recorder.stop(); } catch { /* already stopped */ }
      }
    };

    startLeg();
    // Stagger the second leg by half a window, so at any moment one of them has
    // been running for at least a full window.
    const stagger = setTimeout(startLeg, (lengthSecs * 1000) / 2);
    rotateTimer = setInterval(startLeg, (lengthSecs * 1000) / 2);

    return () => {
      stopped = true;
      clearTimeout(stagger);
      if (rotateTimer) clearInterval(rotateTimer);
      for (const leg of legsRef.current) {
        try { leg.recorder.stop(); } catch { /* already stopped */ }
      }
      legsRef.current = [];
    };
  }, [stream, armed, lengthSecs]);

  /** The longest-running leg's output — a complete, decodable recording. */
  const takeClip = useCallback(async (): Promise<Blob | null> => {
    const legs = legsRef.current;
    if (legs.length === 0) return null;

    // Oldest leg covers the most time. Flush it so the final partial chunk is
    // included before we read.
    const leg = legs[0];
    await new Promise<void>((resolve) => {
      try {
        if (leg.recorder.state === "recording") {
          leg.recorder.requestData();
          setTimeout(resolve, 120);
        } else {
          resolve();
        }
      } catch {
        resolve();
      }
    });

    if (leg.chunks.length === 0) return null;
    // Trim from the front to about the requested window. The header lives in
    // the first chunk, so that one is always kept.
    const wanted = Math.ceil((lengthSecs * 1000) / TIMESLICE_MS);
    const body = leg.chunks.length > wanted
      ? [leg.chunks[0], ...leg.chunks.slice(leg.chunks.length - wanted + 1)]
      : leg.chunks;
    return new Blob(body, { type: mimeRef.current || "video/webm" });
  }, [lengthSecs]);

  return { armed, takeClip };
}
