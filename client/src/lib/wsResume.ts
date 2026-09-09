/**
 * What to do with the connection when a page comes back to the foreground.
 *
 * A phone freezes a backgrounded page: timers stop, and the socket the server
 * gave up on 45 seconds ago is not necessarily reported closed on this side
 * either. Nothing then reconnects, because reconnection is driven entirely by
 * `onclose`, so the page goes on showing whoever was in a call at the moment it
 * was put down — long after they left.
 *
 * Keeping the decision pure makes it testable without a browser, a socket, or a
 * phone that can be locked.
 */

/** Below this, a page was switched away from rather than put down: nothing can
 *  have been missed that the socket did not simply deliver late. */
export const WS_RESUME_RESYNC_AFTER_MS = 10_000;

export type ResumeAction =
  /** Back too briefly to have missed anything. */
  | "nothing"
  /** The socket held, but refetch the state that is assembled from events. */
  | "resync"
  /** No usable socket: build a new one, and refetch once it is up. */
  | "reconnect";

export function decideResumeAction(page: {
  /** Whether the socket is open *as this side sees it*, which on a resumed
   *  page is a claim rather than a fact. */
  socketOpen: boolean;
  /** How long the page spent in the background, in ms. */
  hiddenForMs: number;
}): ResumeAction {
  if (!page.socketOpen) return "reconnect";
  return page.hiddenForMs >= WS_RESUME_RESYNC_AFTER_MS ? "resync" : "nothing";
}
