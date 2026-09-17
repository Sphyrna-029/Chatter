/**
 * @vitest-environment jsdom
 *
 * Building and recognising shared message links.
 *
 * The parsing is what decides whether a URL in somebody's message gets asked
 * about at all, so the cases that matter are the ones that must *not* match: a
 * link to another instance, and anything shaped like a message link but
 * isn't. Event ids start with `$` and are base64url, so every real link is
 * percent-encoded and the round trip has to survive it.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  messageLinkFor,
  parseMessageLink,
  eventIdFromPath,
  findMessageLinks,
  peekMessagePreview,
  resolveMessagePreview,
  forgetMessagePreview,
  clearMessagePreviews,
} from "@/lib/messageLinks";
import * as api from "@/lib/api";

const EVENT = "$AbCd-_0123456789abcdef";

beforeEach(() => {
  clearMessagePreviews();
  // jsdom serves the app from http://localhost:3000 by default; assert on the
  // real value rather than a guess so a jsdom change cannot quietly pass.
  expect(window.location.origin).toBeTruthy();
});

describe("messageLinkFor", () => {
  it("is absolute, so it survives being pasted anywhere", () => {
    const link = messageLinkFor(EVENT);
    expect(link.startsWith(`${window.location.origin}/m/`)).toBe(true);
  });

  it("round-trips an event id through its own encoding", () => {
    // `$` has to be escaped to survive a path, and the id is what the server
    // looks up — a link that decodes to something else finds nothing.
    expect(parseMessageLink(messageLinkFor(EVENT))).toBe(EVENT);
  });
});

describe("parseMessageLink", () => {
  it("accepts a bare path as well as an absolute URL", () => {
    expect(parseMessageLink(`/m/${encodeURIComponent(EVENT)}`)).toBe(EVENT);
  });

  it("refuses a message link on another instance", () => {
    // A perfectly good link, and none of our business: resolving it would ask
    // our own server about an id from somebody else's.
    expect(
      parseMessageLink(`https://other.example/m/${encodeURIComponent(EVENT)}`),
    ).toBeNull();
  });

  it("refuses paths that only look like one", () => {
    expect(parseMessageLink("/m/")).toBeNull();
    expect(parseMessageLink("/m")).toBeNull();
    expect(parseMessageLink(`/m/${encodeURIComponent(EVENT)}/extra`)).toBeNull();
    expect(parseMessageLink("/message/abc")).toBeNull();
    expect(parseMessageLink("/invite/abc")).toBeNull();
    expect(parseMessageLink("not a url at all")).toBeNull();
  });

  it("refuses malformed percent-encoding rather than throwing", () => {
    // `decodeURIComponent` throws on a lone `%`, and this runs over whatever
    // anyone typed into a message.
    expect(eventIdFromPath("/m/%")).toBeNull();
    expect(eventIdFromPath("/m/%zz")).toBeNull();
  });
});

describe("findMessageLinks", () => {
  it("finds a link in amongst prose", () => {
    const body = `see ${messageLinkFor(EVENT)} for context`;
    expect(findMessageLinks(body)).toEqual([EVENT]);
  });

  it("draws one card for a message named twice", () => {
    const link = messageLinkFor(EVENT);
    expect(findMessageLinks(`${link} and again ${link}`)).toEqual([EVENT]);
  });

  it("ignores ordinary links and other instances", () => {
    const body = [
      "https://example.com/thing",
      `https://other.example/m/${encodeURIComponent(EVENT)}`,
      `${window.location.origin}/invite/abc123`,
    ].join(" ");
    expect(findMessageLinks(body)).toEqual([]);
  });

  it("finds every distinct message in one body, in order", () => {
    const a = "$aaa";
    const b = "$bbb";
    const body = `${messageLinkFor(a)} then ${messageLinkFor(b)}`;
    expect(findMessageLinks(body)).toEqual([a, b]);
  });
});

describe("resolveMessagePreview", () => {
  const preview = {
    event_id: EVENT,
    room_id: "!room",
    room_name: "Room",
    channel_id: "#chan",
    channel_name: "general",
    sender: "@someone:localhost",
    sender_display_name: "Someone",
    sender_avatar_url: "",
    body: "hello",
    spoiler: false,
    attachment_count: 0,
    origin_server_ts: 1_700_000_000_000,
    edited: false,
  } satisfies api.MessagePreview;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks once for a message many cards point at", async () => {
    const spy = vi
      .spyOn(api, "apiGetMessagePreview")
      .mockResolvedValue(preview);

    // A timeline can hold a lot of links to one message, and they all mount
    // in the same tick.
    const all = await Promise.all([
      resolveMessagePreview(EVENT),
      resolveMessagePreview(EVENT),
      resolveMessagePreview(EVENT),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(all).toEqual([preview, preview, preview]);
    // And a later render is answered without asking at all.
    expect(peekMessagePreview(EVENT)).toEqual({ value: preview });
  });

  it("remembers a refusal, so an unfollowable link costs one request", async () => {
    // `null` is an answer — "not available to you" — and a channel nobody in
    // it can read must not cost a request per render.
    const spy = vi.spyOn(api, "apiGetMessagePreview").mockResolvedValue(null);

    expect(await resolveMessagePreview(EVENT)).toBeNull();
    expect(await resolveMessagePreview(EVENT)).toBeNull();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(peekMessagePreview(EVENT)).toEqual({ value: null });
  });

  it("does not remember a failure worth retrying", async () => {
    // A dropped connection or a rate limit is not an answer about access.
    const spy = vi
      .spyOn(api, "apiGetMessagePreview")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(preview);

    await expect(resolveMessagePreview(EVENT)).rejects.toThrow("offline");
    expect(peekMessagePreview(EVENT)).toBeNull();

    expect(await resolveMessagePreview(EVENT)).toEqual(preview);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("re-asks after the message changes under it", async () => {
    const edited = { ...preview, body: "hello, edited", edited: true };
    const spy = vi
      .spyOn(api, "apiGetMessagePreview")
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(edited);

    expect(await resolveMessagePreview(EVENT)).toEqual(preview);
    // What the edit and redaction broadcasts do.
    forgetMessagePreview(EVENT);
    expect(peekMessagePreview(EVENT)).toBeNull();

    expect(await resolveMessagePreview(EVENT)).toEqual(edited);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("forgets everything on sign-out", async () => {
    vi.spyOn(api, "apiGetMessagePreview").mockResolvedValue(preview);
    await resolveMessagePreview(EVENT);

    clearMessagePreviews();

    expect(peekMessagePreview(EVENT)).toBeNull();
  });
});
