/**
 * Shared links to messages: building them, recognising them, and resolving
 * them to a preview once per viewer.
 *
 * A link is `/m/<event id>` and nothing else. The room, the channel, the
 * sender and the text all come from the server when the link is resolved,
 * because whether the viewer may see any of it is a property of the viewer —
 * so the same link is a preview card for someone in the channel and an inert
 * link for someone who is not. See `backend/routes/message_links.rs`.
 *
 * Resolution is cached because a timeline draws every embed it can see, a
 * channel can hold many links to one message, and scrolling remounts all of
 * them. Refusals are cached too: a link nobody is allowed to follow must not
 * cost a request per render.
 */
import { apiGetMessagePreview, type MessagePreview } from "@/lib/api";

/** The path a message link lives at. Matched in `App.tsx` on a cold load. */
const MESSAGE_LINK_PATH = "/m/";

/**
 * How long a resolution is trusted.
 *
 * Both outcomes expire, and for the same reason in mirror image: a message can
 * be edited or deleted after its card was drawn, and a viewer can be given —
 * or refused — access to the channel it lives in. Neither is worth a
 * subscription, and both fix themselves within a few minutes or on reload.
 */
const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** An absolute link to a message, for putting on the clipboard. */
export function messageLinkFor(eventId: string): string {
  return `${window.location.origin}${MESSAGE_LINK_PATH}${encodeURIComponent(eventId)}`;
}

/**
 * The event id a URL names, if it is a message link on *this* instance.
 *
 * Same-origin only. A link to a message on somebody else's Chatter is a
 * perfectly good link and none of our business — resolving it here would
 * quietly ask our own server about an event id from a different instance,
 * which at best answers nothing and at worst answers about an unrelated
 * message that happens to share the id.
 */
export function parseMessageLink(url: string): string | null {
  let parsed: URL;
  try {
    // The base makes a relative `/m/...` parse; an absolute URL ignores it.
    parsed = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  return eventIdFromPath(parsed.pathname);
}

/**
 * The event id in a pathname, for the cold-load case where someone has
 * followed a link into the app rather than clicked one inside it.
 */
export function eventIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(MESSAGE_LINK_PATH)) return null;
  const rest = pathname.slice(MESSAGE_LINK_PATH.length);
  // One segment, and a non-empty one. `/m/`, `/m/a/b` and a trailing slash are
  // not message links.
  if (!rest || rest.includes("/")) return null;
  try {
    return decodeURIComponent(rest) || null;
  } catch {
    return null; // malformed percent-encoding
  }
}

/**
 * Every message link in a body, in the order they appear and without
 * repeats — a message that names the same one twice draws one card.
 *
 * The URL pattern matches the linkifier in `MessageItem`, so what is detected
 * here is exactly what is rendered as a link there.
 */
export function findMessageLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const url of body.match(/https?:\/\/[^\s]+/g) ?? []) {
    const eventId = parseMessageLink(url);
    if (eventId) seen.add(eventId);
  }
  return [...seen];
}

type CacheEntry = {
  at: number;
  /** Null is a real answer — "not available to you" — not a miss. */
  value: MessagePreview | null;
};

const resolved = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MessagePreview | null>>();

function fresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.at < PREVIEW_TTL_MS;
}

/**
 * A resolution already in hand, without asking. For answering during a render
 * so a card that has been drawn before does not blink on its way back.
 */
export function peekMessagePreview(
  eventId: string,
): { value: MessagePreview | null } | null {
  const entry = resolved.get(eventId);
  return fresh(entry) ? { value: entry.value } : null;
}

/**
 * Resolve a message link, sharing one request between every caller asking for
 * the same one.
 *
 * Throws only on a failure worth retrying — a dropped connection, a rate
 * limit. "Not available to you" resolves to `null` and is remembered, because
 * it is an answer.
 */
export function resolveMessagePreview(
  eventId: string,
): Promise<MessagePreview | null> {
  const entry = resolved.get(eventId);
  if (fresh(entry)) return Promise.resolve(entry.value);

  const existing = inFlight.get(eventId);
  if (existing) return existing;

  const request = apiGetMessagePreview(eventId)
    .then((value) => {
      resolved.set(eventId, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(eventId);
    });
  inFlight.set(eventId, request);
  return request;
}

/** Drop a cached resolution, so the next ask goes to the server. Called when
 *  a message is edited or deleted under us. */
export function forgetMessagePreview(eventId: string) {
  resolved.delete(eventId);
}

/** Drop every resolution. Called on sign-out: what one account was allowed to
 *  see is not what the next one is. */
export function clearMessagePreviews() {
  resolved.clear();
}
