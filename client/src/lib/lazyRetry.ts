import { lazy, type ComponentType } from "react";

/**
 * Loading a code-split view, and telling apart the two ways it fails.
 *
 * Every view `ChatLayout` splits out — the forum, the showcase, the whiteboard,
 * the watch party, the spatial floor — is fetched the first time somebody opens
 * a channel of that type. That makes a failed chunk a *navigation* failure:
 * nothing is wrong until you change channel, and then the import rejects,
 * `React.lazy` rethrows it during render, and without a boundary above it the
 * whole app unmounts. A grey page, on switching channels, sometimes.
 *
 * Two different failures arrive looking identical, and only one of them is
 * worth retrying:
 *
 *  - The build moved. Vite names chunks by content hash, so a deploy replaces
 *    `ForumArea-a1b2c3.js` with a new name and the tab that is already open
 *    asks for a file that no longer exists. Retrying cannot help — only a
 *    reload learns the new names — so the person has to be told to reload.
 *  - The network hiccupped. A dropped connection, a proxy closing early. A
 *    second attempt usually works.
 *
 * The browser reports both as the same `TypeError`, so they cannot be told
 * apart from the error alone. One cheap retry covers the second case; the first
 * then fails twice and is surfaced as "reload" by the boundary.
 */

/** What each engine says when a dynamic import does not load. */
const CHUNK_ERROR_PATTERNS = [
  // Chrome, Edge
  "failed to fetch dynamically imported module",
  // Firefox
  "error loading dynamically imported module",
  // Safari
  "importing a module script failed",
  // Vite's preload helper, when the stylesheet beside the chunk is the casualty
  "unable to preload css",
];

/**
 * Whether this is a view that failed to *load*, rather than one that threw
 * while rendering.
 *
 * The distinction is the whole point: a chunk that will not load is almost
 * always a stale build and the reader needs to reload, while a view that threw
 * is a bug and reloading will only reproduce it.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return false;
  const lower = message.toLowerCase();
  return CHUNK_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export interface LoadWithRetryOptions {
  /** Total tries, including the first. */
  attempts?: number;
  /** Base backoff; each further wait is a multiple of it. */
  delayMs?: number;
  /** Injected so a test does not have to wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `load`, retrying a failure a small number of times.
 *
 * The last error is rethrown rather than swallowed — the caller above this is
 * an error boundary, and a view that cannot be loaded has to reach it.
 */
export async function loadWithRetry<T>(
  load: () => Promise<T>,
  { attempts = 2, delayMs = 350, sleep = wait }: LoadWithRetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * `React.lazy`, with the one retry above.
 *
 * A drop-in for `lazy(() => import(…))` at every split point, so no call site
 * has to remember that a dynamic import is a network request.
 */
export function lazyRetry<
  // The same constraint `React.lazy` declares for itself. "Any component,
  // whatever its props" has no narrower spelling: `ComponentType<never>` and
  // `ComponentType<object>` both collapse every call site's props to `never`,
  // because a component is contravariant in them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ComponentType<any>,
>(load: () => Promise<{ default: T }>, options?: LoadWithRetryOptions) {
  return lazy(() => loadWithRetry(load, options));
}
