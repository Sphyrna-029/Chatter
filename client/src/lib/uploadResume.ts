/**
 * The decisions a resumable chunked upload has to make, kept apart from the
 * XMLHttpRequest that carries it out so they can be reasoned about — and
 * tested — without a network.
 *
 * Three of them: which file this is (so a second attempt recognises the first),
 * which chunks are still owed, and what a failure means. That last one is the
 * substance: three attempts a second apart used to treat a laptop changing
 * Wi-Fi networks exactly like a 403, so a transfer that had nothing wrong with
 * it died in three seconds and one that could never succeed was tried three
 * times.
 */

/** What `GET /api/upload/{id}` answers. */
export interface UploadStatus {
  uploadId: string;
  filename: string;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  /** Indices the server holds at the right length. Sorted. */
  received: number[];
  receivedBytes: number;
  /** `"done"` once the server has assembled this upload — which it can have
   *  done without the client hearing about it, since a long remux runs past
   *  the wait on `complete`. Absent on a server from before that existed. */
  status?: "receiving" | "done";
  /** The URL the upload turned into, present only when `status` is `"done"`. */
  resultUrl?: string;
}

/**
 * What makes two `File`s the same file across a reload.
 *
 * Deliberately not a content hash: reading eight gigabytes through SubtleCrypto
 * before the first byte leaves would cost a minute of nothing happening, and
 * every chunk is checksummed on its way out anyway. Name, size and modified
 * time is what a file picker can tell us for free, and two different files
 * agreeing on all three is not a thing that happens by accident.
 */
export function fingerprintFile(file: File): string {
  return [file.name, file.size, file.lastModified || 0].join("\u0000");
}

/** Everything in `0..chunkCount` the server has not already got, in order. */
export function missingChunks(chunkCount: number, received: number[]): number[] {
  const have = new Set(received);
  const missing: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (!have.has(i)) missing.push(i);
  }
  return missing;
}

/** The byte range chunk `index` covers. The last one is short. */
export function chunkRange(
  index: number,
  chunkSize: number,
  fileSize: number,
): { start: number; end: number } {
  const start = index * chunkSize;
  return { start, end: Math.min(start + chunkSize, fileSize) };
}

/** How many bytes of `fileSize` the chunks in `received` account for. */
export function receivedBytes(
  received: number[],
  chunkSize: number,
  fileSize: number,
): number {
  return received.reduce((total, index) => {
    const { start, end } = chunkRange(index, chunkSize, fileSize);
    return total + Math.max(0, end - start);
  }, 0);
}

/**
 * What kind of failure a chunk met, which is the whole of what decides what to
 * do about it.
 *
 * - `transient` — nothing is wrong with the upload; try again later.
 * - `auth`      — the token expired mid-transfer; refresh and go straight back.
 * - `restart`   — the server no longer has this upload (swept after a day
 *                 idle, or the id is stale); the chunks are gone, so begin
 *                 again rather than sending into nothing.
 * - `permanent` — retrying cannot change the answer; say so and stop.
 */
export type ChunkFailureKind = "transient" | "auth" | "restart" | "permanent";

export class ChunkUploadError extends Error {
  readonly kind: ChunkFailureKind;
  /** Set when the server named a wait, as a rate limit does. */
  readonly retryAfterMs?: number;

  constructor(message: string, kind: ChunkFailureKind, retryAfterMs?: number) {
    super(message);
    this.name = "ChunkUploadError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Read an HTTP response to a chunk as one of the four kinds.
 *
 * Status 0 is XHR's way of saying the request never got an answer — offline,
 * DNS, a dropped connection — which is the most retryable thing there is.
 * A checksum refusal is transient on purpose: the length was right and the
 * bytes were not, which is corruption in transit, and sending them again is
 * exactly the fix.
 */
export function classifyChunkFailure(
  status: number,
  body: { error?: string; retry_after_secs?: number } | null,
): ChunkUploadError {
  const message = body?.error || "Chunk upload failed";

  if (status === 401) return new ChunkUploadError(message, "auth");
  if (status === 404) return new ChunkUploadError(message, "restart");
  if (status === 429) {
    const secs = body?.retry_after_secs;
    return new ChunkUploadError(
      message,
      "transient",
      typeof secs === "number" ? secs * 1000 : undefined,
    );
  }
  if (status === 0 || status >= 500) return new ChunkUploadError(message, "transient");
  if (status === 400 && /checksum/i.test(message)) {
    return new ChunkUploadError(message, "transient");
  }
  return new ChunkUploadError(message, "permanent");
}

export const CHUNK_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * Exponential with jitter, because a room full of clients knocked off the same
 * flaky uplink would otherwise all come back at the same instant and knock it
 * off again. `random` is a parameter so a test can pin it.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  // A server that named a wait knows better than any local schedule.
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.min(retryAfterMs, BACKOFF_CAP_MS);
  }
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  // Full jitter across the window rather than a fixed fraction of it.
  return Math.round(ceiling * (0.5 + random() * 0.5));
}
