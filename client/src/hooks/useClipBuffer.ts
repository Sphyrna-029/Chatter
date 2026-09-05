import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A rolling buffer of the last N seconds of a screen share, kept encoded.
 *
 * Two recorders run staggered rather than one, because a MediaRecorder's later
 * chunks are not independently decodable — only its first carries the container
 * header. Dropping the oldest chunk of a single recorder would leave a blob
 * nothing can play. With two, one has always been running long enough to cover
 * the whole window on its own, so a clip is one recorder's complete output.
 *
 * A clip is therefore one recorder's entire output, never a splice: WebM cannot
 * be cut at arbitrary chunk boundaries, so the result runs between one and two
 * windows and ends at the moment it was taken. Longer than asked for, rather
 * than corrupt — and the saved length is reported so it is not a surprise.
 *
 * The cost is real: a second video encoder runs for as long as this is armed,
 * and at 12Mbps the two legs hold up to three windows between them — roughly
 * 135MB for a 30s setting. It stays off until asked for.
 */

/** Chunk cadence. Small enough to trim close to the requested window. */
const TIMESLICE_MS = 1000;
/** If nothing has been recorded by now, something is wrong — say so rather than
 *  letting the user wait for footage that will never arrive. */
const FIRST_CHUNK_TIMEOUT_MS = 6000;
/** How soon to try again when a leg fails to start. Rotation alone would leave
 *  a transient failure — a track not live yet — stuck for a whole window. */
const RETRY_MS = 2000;
/** Match the 60fps screen-share cap in lib/webrtc.ts. Encoding below what the
 *  source was allowed to send loses detail a second time, on top of the loss
 *  already taken by re-encoding a decoded stream. */
const CLIP_BITS_PER_SECOND = 12_000_000;

/**
 * The first MIME type the browser will record, matched to the tracks on hand.
 *
 * The codec list has to agree with the stream. Asking for `...,opus` while
 * recording a video-only stream is accepted by isTypeSupported — the *type* is
 * supported — and the recorder then starts and emits nothing at all, having
 * been told to mux an audio stream with no source behind it.
 */
function pickMimeType(hasAudio: boolean): string | undefined {
  const candidates = hasAudio
    ? [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ]
    : [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
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

/**
 * The tracks worth recording from a received share.
 *
 * A remote track stays `muted` until media actually flows, and MediaRecorder
 * muxes every track in the stream it is given — so one silent audio track that
 * never delivers a frame stalls the muxer and no data is emitted at all, for
 * video included. Screen shares frequently negotiate audio that carries
 * nothing, so audio joins only once it is demonstrably live.
 */
function buildRecordingStream(source: MediaStream): MediaStream | null {
  const video = source.getVideoTracks().find((t) => t.readyState === "live");
  if (!video) return null;
  const tracks: MediaStreamTrack[] = [video];
  const audio = source
    .getAudioTracks()
    .find((t) => t.readyState === "live" && !t.muted);
  if (audio) tracks.push(audio);
  return new MediaStream(tracks);
}

export function clipBufferSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && pickMimeType(false) !== undefined;
}

interface Leg {
  recorder: MediaRecorder;
  chunks: Blob[];
  /** When this leg started, so we know how much it covers. */
  startedAt: number;
}

export interface ClipBuffer {
  /** A recorder is genuinely running — not merely requested. */
  armed: boolean;
  /** Roughly how much footage is available right now. */
  bufferedSecs: number;
  /** Why arming failed, when it did. */
  error: string | null;
  takeClip: () => Promise<{ blob: Blob; seconds: number } | null>;
}

export function useClipBuffer(
  stream: MediaStream | null,
  enabled: boolean,
  lengthSecs: number,
): ClipBuffer {
  const legsRef = useRef<Leg[]>([]);
  const mimeRef = useRef<string | undefined>(undefined);
  const [armed, setArmed] = useState(false);
  const [bufferedSecs, setBufferedSecs] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  // A fixed property of the browser, so it is derived rather than tracked.
  const supported = clipBufferSupported();
  const error = supported ? startError : "This browser cannot record video";

  useEffect(() => {
    if (!enabled || !stream || !supported) return;

    let stopped = false;
    let waitingForUnmute = false;
    const watchdogs: ReturnType<typeof setTimeout>[] = [];
    const unmuteCleanups: (() => void)[] = [];

    /** Oldest leg's coverage, which is what a clip is taken from. */
    // Measured from recorded chunks, not from elapsed time: a recorder that
    // starts and produces nothing would otherwise look like a filling buffer.
    const publishBuffered = () => {
      const oldest = legsRef.current[0];
      setBufferedSecs(oldest ? (oldest.chunks.length * TIMESLICE_MS) / 1000 : 0);
    };

    const scheduleRetry = () => {
      if (stopped) return;
      const t = setTimeout(() => startLeg(), RETRY_MS);
      watchdogs.push(t);
    };

    const startLeg = () => {
      if (stopped) return;

      // A remote track is `muted` until media actually flows through it, and
      // recording one in that state stalls the muxer exactly as a dead audio
      // track does. Wait for it rather than starting a recorder that will
      // silently produce nothing.
      const videoTrack = stream.getVideoTracks().find((t) => t.readyState === "live");
      if (videoTrack && videoTrack.muted) {
        if (!waitingForUnmute) {
          waitingForUnmute = true;
          const onUnmute = () => {
            waitingForUnmute = false;
            videoTrack.removeEventListener("unmute", onUnmute);
            startLeg();
          };
          videoTrack.addEventListener("unmute", onUnmute);
          unmuteCleanups.push(() => videoTrack.removeEventListener("unmute", onUnmute));
        }
        return;
      }

      const recordingStream = buildRecordingStream(stream);
      if (!recordingStream) {
        setStartError("The share has no live video track yet");
        setArmed(false);
        scheduleRetry();
        return;
      }
      // Chosen per leg, from the tracks actually going in.
      const mime = pickMimeType(recordingStream.getAudioTracks().length > 0);
      mimeRef.current = mime;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(recordingStream, {
          mimeType: mime,
          videoBitsPerSecond: CLIP_BITS_PER_SECOND,
        });
      } catch {
        // Last resort: let the browser pick everything. A clip in a format we
        // did not choose beats no clip at all.
        try {
          recorder = new MediaRecorder(recordingStream);
          mimeRef.current = recorder.mimeType || undefined;
        } catch (err) {
          setStartError(err instanceof Error ? err.message : "Could not start recording");
          setArmed(false);
          scheduleRetry();
          return;
        }
      }

      const leg: Leg = { recorder, chunks: [], startedAt: Date.now() };
      // onstart is the only proof a recorder is actually running.
      recorder.onstart = () => {
        setArmed(true);
        setStartError(null);
      };
      // A recorder can start and then emit nothing at all. Without this the
      // only symptom is an empty buffer that looks like impatience.
      const watchdog = setTimeout(() => {
        if (!stopped && leg.chunks.length === 0) {
          setStartError("The recorder produced no data from this stream");
        }
      }, FIRST_CHUNK_TIMEOUT_MS);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          // Never dropped from the front: chunk 0 carries the container header,
          // and the rotation below already bounds how long a leg lives.
          leg.chunks.push(e.data);
          clearTimeout(watchdog);
        }
        publishBuffered();
      };
      watchdogs.push(watchdog);
      recorder.onerror = () => {
        setStartError("Recording stopped unexpectedly");
      };

      try {
        recorder.start(TIMESLICE_MS);
      } catch (err) {
        setStartError(err instanceof Error ? err.message : "Could not start recording");
        setArmed(false);
        scheduleRetry();
        return;
      }

      legsRef.current.push(leg);
      // Keep the current leg and its predecessor. A new leg every window means
      // the predecessor is always between one and two windows old, so it alone
      // covers the full clip. Rotating twice per window — as this did — threw
      // away the only leg with any footage and left two empty ones behind it.
      while (legsRef.current.length > 2) {
        const old = legsRef.current.shift();
        try { old?.recorder.stop(); } catch { /* already stopped */ }
      }
      publishBuffered();
    };

    startLeg();
    const rotate = setInterval(startLeg, lengthSecs * 1000);

    return () => {
      stopped = true;
      clearInterval(rotate);
      for (const w of watchdogs) clearTimeout(w);
      for (const c of unmuteCleanups) c();
      for (const leg of legsRef.current) {
        try { leg.recorder.stop(); } catch { /* already stopped */ }
      }
      legsRef.current = [];
      setArmed(false);
      setBufferedSecs(0);
    };
  }, [stream, enabled, lengthSecs, supported]);

  const takeClip = useCallback(async () => {
    // Whichever leg covers the most; before the first rotation there is only one.
    const leg = legsRef.current[0];
    if (!leg) return null;

    // Flush the partial chunk so the clip runs right up to now.
    await new Promise<void>((resolve) => {
      try {
        if (leg.recorder.state === "recording") {
          leg.recorder.requestData();
          setTimeout(resolve, 150);
        } else {
          resolve();
        }
      } catch {
        resolve();
      }
    });

    if (leg.chunks.length === 0) return null;

    // Every chunk, in order, untouched.
    //
    // Trimming the front to hit the requested length exactly is what the
    // staggered recorders exist to avoid: keeping chunk 0 for its header and
    // then skipping to the tail hands the decoder clusters whose reference
    // frames have been thrown away, and it renders artefacts until it happens
    // upon a keyframe. Cutting WebM at arbitrary chunk boundaries is not a
    // thing you can do, so the clip is one recorder's whole output — a window
    // to twice a window long, ending now.
    const seconds = (leg.chunks.length * TIMESLICE_MS) / 1000;
    return {
      blob: new Blob(leg.chunks, { type: mimeRef.current || "video/webm" }),
      seconds,
    };
    // No dependency on lengthSecs any more: the clip is whatever the leg
    // holds, not a slice measured against the setting.
  }, []);

  return { armed, bufferedSecs, error, takeClip };
}
