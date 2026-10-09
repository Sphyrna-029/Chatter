/**
 * Shared links to forum posts and replies: building them, recognising them, and
 * resolving them to a preview once per viewer.
 *
 * A link to a post is `/f/<post id>` and nothing else; a reply adds the comment
 * id it answers, `/f/<post id>/<comment id>`. The room, the forum channel, the
 * title and the body all come from the server when the link is resolved, because
 * whether the viewer may see any of it is a property of the viewer — so the same
 * link is a card for someone who may read the post and an inert link for someone
 * who may not. See `backend/routes/forum_links.rs`, and `messageLinks.ts`, which
 * this mirrors.
 *
 * Resolution is cached because a timeline draws every embed it can see, a forum
 * can hold many links to one post, and scrolling remounts all of them. Refusals
 * are cached too: a link nobody is allowed to follow must not cost a request per
 * render.
 */
import { apiGetForumPreview, type ForumPreview } from "@/lib/api";

/** The path a forum link lives at. Matched in `App.tsx` on a cold load. */
const FORUM_LINK_PATH = "/f/";

/**
 * How long a resolution is trusted.
 *
 * Both outcomes expire, and for the same reason in mirror image: a post or reply
 * can be edited or deleted after its card was drawn, and a viewer can be given —
 * or refused — access to the forum channel it lives in. Neither is worth a
 * subscription, and both fix themselves within a few minutes or on reload.
 */
const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** A post link, for putting on the clipboard. */
export function forumLinkFor(postId: string): string {
  return `${window.location.origin}${FORUM_LINK_PATH}${encodeURIComponent(postId)}`;
}

/** A reply link, for putting on the clipboard. */
export function forumReplyLinkFor(postId: string, commentId: string): string {
  return `${window.location.origin}${FORUM_LINK_PATH}${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}`;
}

/**
 * The post and optional reply a URL names, if it is a forum link on *this*
 * instance.
 *
 * Same-origin only. A link to a post on somebody else's Chatter is a perfectly
 * good link and none of our business — resolving it here would quietly ask our
 * own server about an id from a different instance.
 */
export function parseForumLink(url: string): ForumLinkRef | null {
  let parsed: URL;
  try {
    // The base makes a relative `/f/...` parse; an absolute URL ignores it.
    parsed = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  return forumRefFromPath(parsed.pathname);
}

/**
 * The post and optional reply in a pathname, for the cold-load case where
 * someone has followed a link into the app rather than clicked one inside it.
 */
export function forumRefFromPath(pathname: string): ForumLinkRef | null {
  if (!pathname.startsWith(FORUM_LINK_PATH)) return null;
  const rest = pathname.slice(FORUM_LINK_PATH.length);
  const segments = rest.split("/");
  // One segment is a post; two is a reply under it. `/f/`, `/f/a/b/c` and a
  // trailing slash are not forum links.
  if (segments.length === 0 || segments.length > 2) return null;
  if (segments.some((s) => !s)) return null;
  try {
    const postId = decodeURIComponent(segments[0]);
    const commentId = segments.length === 2 ? decodeURIComponent(segments[1]) : null;
    return postId ? { postId, commentId } : null;
  } catch {
    return null; // malformed percent-encoding
  }
}

export type ForumLinkRef = { postId: string; commentId: string | null };

/**
 * Every forum link in a body, in the order they appear and without repeats — a
 * message that names the same one twice draws one card.
 *
 * The URL pattern matches the linkifier in `MessageItem`, so what is detected
 * here is exactly what is rendered as a link there.
 */
export function findForumLinks(body: string): ForumLinkRef[] {
  const seen = new Set<string>();
  const refs: ForumLinkRef[] = [];
  for (const url of body.match(/https?:\/\/[^\s]+/g) ?? []) {
    const ref = parseForumLink(url);
    if (!ref) continue;
    const key = refKey(ref.postId, ref.commentId);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/** A cache key that tells a post link and a reply link apart. Ids never hold a
 *  colon, so it is a safe separator. */
function refKey(postId: string, commentId: string | null): string {
  return commentId ? `${postId}:${commentId}` : postId;
}

type CacheEntry = {
  at: number;
  /** Null is a real answer — "not available to you" — not a miss. */
  value: ForumPreview | null;
};

const resolved = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ForumPreview | null>>();

function fresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.at < PREVIEW_TTL_MS;
}

/**
 * A resolution already in hand, without asking. For answering during a render
 * so a card that has been drawn before does not blink on its way back.
 */
export function peekForumPreview(
  postId: string,
  commentId: string | null = null,
): { value: ForumPreview | null } | null {
  const entry = resolved.get(refKey(postId, commentId));
  return fresh(entry) ? { value: entry.value } : null;
}

/**
 * Resolve a forum link, sharing one request between every caller asking for the
 * same one.
 *
 * Throws only on a failure worth retrying — a dropped connection, a rate limit.
 * "Not available to you" resolves to `null` and is remembered, because it is an
 * answer.
 */
export function resolveForumPreview(
  postId: string,
  commentId: string | null = null,
): Promise<ForumPreview | null> {
  const key = refKey(postId, commentId);
  const entry = resolved.get(key);
  if (fresh(entry)) return Promise.resolve(entry.value);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = apiGetForumPreview(postId, commentId ?? undefined)
    .then((value) => {
      resolved.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Drop a cached resolution, so the next ask goes to the server. Called when a
 *  post or reply is edited or deleted under us. */
export function forgetForumPreview(postId: string, commentId: string | null = null) {
  resolved.delete(refKey(postId, commentId));
}

/** Drop every resolution. Called on sign-out: what one account was allowed to
 *  see is not what the next one is. */
export function clearForumPreviews() {
  resolved.clear();
}
