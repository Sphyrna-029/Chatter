/**
 * A process-wide cache of authenticated media, keyed by URL.
 *
 * With `require_auth_for_uploads` on, an upload cannot be handed to an `<img>`
 * as a plain `src` — it has to be fetched with the session's credentials and
 * given over as a blob URL. Doing that per mount is what makes a member list
 * flicker: every avatar that scrolls out of view and back renders nothing
 * until a fresh fetch resolves, even though the bytes are sitting in the HTTP
 * cache. The empty frame is the cost of re-creating the blob URL, not of the
 * transfer, so no amount of caching on the server removes it.
 *
 * Two things here do. A resolved blob URL is kept after its last user
 * unmounts, so the next mount can be answered during render; and everyone who
 * asks for one URL while a fetch is in flight shares that fetch, so a room
 * where forty people have the same avatar costs one request.
 *
 * Blob URLs live as long as the document unless `revokeObjectURL` is called on
 * them, so this cache is bounded and evicts. What it must never do is revoke a
 * URL an `<img>` is still pointing at — that shows a broken image, which is
 * worse than the flicker it set out to fix. So entries are reference-counted
 * and only an idle one is ever evicted.
 */

/** How many resolved blobs to keep. Avatars and custom emoji are small, and
 *  the point is to cover a member list being scrolled, so this only has to be
 *  comfortably larger than what one screen can show. */
const MAX_ENTRIES = 192;

type Entry = {
  /** Set once the fetch has landed. */
  objectUrl?: string;
  /** The fetch every caller arriving during it waits on, shared. */
  inFlight?: Promise<string>;
  /** Mounted components currently pointing at `objectUrl`. */
  refs: number;
  /** Monotonic tick of last interest, for choosing an eviction victim. */
  lastUsed: number;
};

const entries = new Map<string, Entry>();
let tick = 0;

function revoke(objectUrl: string) {
  // Guarded rather than called: jsdom has no object-URL implementation, and a
  // cache that throws on eviction would take the render with it.
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {
    /* nothing to release */
  }
}

/**
 * Drop idle entries until the cache is back within its bound.
 *
 * Least-recently-wanted first, and only ever one with no references: an entry
 * some component still holds is skipped however old it is, so the cache going
 * over capacity costs memory rather than a broken picture.
 */
function evictIfNeeded() {
  while (entries.size > MAX_ENTRIES) {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [url, entry] of entries) {
      if (entry.refs > 0 || entry.inFlight) continue;
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        victim = url;
      }
    }
    if (victim === null) return; // everything is in use; let it run over
    const entry = entries.get(victim)!;
    if (entry.objectUrl) revoke(entry.objectUrl);
    entries.delete(victim);
  }
}

/**
 * The blob URL for `url` if it is already resolved, without taking a
 * reference — for answering during a render, where there is nothing to
 * release it from.
 *
 * Bumping `lastUsed` here is what keeps that safe: an entry just read this way
 * is the most recently wanted one, so eviction will not choose it before the
 * effect that follows the render can take its reference.
 */
export function peekMediaBlob(url: string): string | null {
  const entry = entries.get(url);
  if (!entry?.objectUrl) return null;
  entry.lastUsed = ++tick;
  return entry.objectUrl;
}

/**
 * Take a reference to an already-resolved blob URL, or `null` if there isn't
 * one. Every non-null answer must be paired with `releaseMediaBlob`.
 */
export function retainMediaBlob(url: string): string | null {
  const entry = entries.get(url);
  if (!entry?.objectUrl) return null;
  entry.refs += 1;
  entry.lastUsed = ++tick;
  return entry.objectUrl;
}

/**
 * Fetch `url` if it is not already cached or in flight, and take a reference
 * to the result. Resolves to the blob URL; every resolution must be paired
 * with `releaseMediaBlob`.
 *
 * A rejection caches nothing. Same reasoning as the server refusing to put
 * freshness on a 404: a preview whose source has not been generated yet fails
 * now and succeeds on a later load, and remembering the failure would turn a
 * missed race into a permanently empty frame.
 */
export function loadMediaBlob(
  url: string,
  fetcher: (url: string) => Promise<string>,
): Promise<string> {
  const existing = entries.get(url);
  if (existing?.objectUrl) {
    existing.refs += 1;
    existing.lastUsed = ++tick;
    return Promise.resolve(existing.objectUrl);
  }
  if (existing?.inFlight) {
    existing.lastUsed = ++tick;
    return existing.inFlight.then((objectUrl) => {
      // Re-read: the entry may have been dropped by a sibling's failure, or
      // evicted, between the fetch landing and this caller being woken.
      const entry = entries.get(url);
      if (entry?.objectUrl === objectUrl) {
        entry.refs += 1;
        entry.lastUsed = ++tick;
      }
      return objectUrl;
    });
  }

  const entry: Entry = { refs: 0, lastUsed: ++tick };
  const inFlight = fetcher(url).then(
    (objectUrl) => {
      // Only if this entry is still the live one — a `forget` or an eviction
      // while the fetch was out means nobody is waiting on it any more, and
      // the blob it produced would otherwise be held for the document's life.
      if (entries.get(url) !== entry) {
        revoke(objectUrl);
        return objectUrl;
      }
      entry.objectUrl = objectUrl;
      entry.inFlight = undefined;
      entry.refs += 1;
      entry.lastUsed = ++tick;
      evictIfNeeded();
      return objectUrl;
    },
    (err) => {
      if (entries.get(url) === entry) entries.delete(url);
      throw err;
    },
  );
  entry.inFlight = inFlight;
  entries.set(url, entry);
  return inFlight;
}

/** Give back a reference taken by `retainMediaBlob` or `loadMediaBlob`. The
 *  blob is kept for the next mount; it is only released once evicted. */
export function releaseMediaBlob(url: string) {
  const entry = entries.get(url);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) entry.lastUsed = ++tick;
}

/**
 * Drop a URL outright, releasing its blob if nothing holds it.
 *
 * For the case the cache cannot see: the bytes behind an upload URL never
 * change, but a *logged-out* session's cached media should not survive into
 * the next one.
 */
export function forgetMediaBlob(url: string) {
  const entry = entries.get(url);
  if (!entry) return;
  entries.delete(url);
  if (entry.refs === 0 && entry.objectUrl) revoke(entry.objectUrl);
}

/** Drop everything not currently on screen. Called on sign-out. */
export function clearMediaBlobs() {
  for (const url of [...entries.keys()]) forgetMediaBlob(url);
}

/** Test seam: the cache is module state, and a test that inspected it through
 *  the public functions alone could not tell "evicted" from "never stored". */
export function mediaBlobCacheSize() {
  return entries.size;
}
