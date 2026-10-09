/**
 * @vitest-environment jsdom
 *
 * Building and recognising shared forum post and reply links.
 *
 * The parsing is what decides whether a URL in somebody's message gets asked
 * about at all, so the cases that matter are the ones that must *not* match: a
 * link to another instance, and anything shaped like a forum link but isn't.
 * Post and comment ids are `prefix_` + base64url, so every real link is
 * percent-encoded and the round trip has to survive it.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  forumLinkFor,
  forumReplyLinkFor,
  parseForumLink,
  forumRefFromPath,
  findForumLinks,
  peekForumPreview,
  resolveForumPreview,
  forgetForumPreview,
  clearForumPreviews,
} from "@/lib/forumLinks";
import * as api from "@/lib/api";

const POST = "post_AbCd-_0123456789abcdef";
const COMMENT = "comment_zzz-_0123456789abcdef";

const preview = {
  kind: "post",
  post_id: POST,
  comment_id: null,
  room_id: "!room",
  room_name: "Room",
  channel_id: "#chan",
  channel_name: "announcements",
  title: "Hello there",
  author: "@someone:localhost",
  author_display_name: "Someone",
  author_avatar_url: "",
  body: "the body",
  created_at: 1_700_000_000_000,
  edited: false,
  comment_count: 2,
} satisfies api.ForumPreview;

beforeEach(() => {
  clearForumPreviews();
  expect(window.location.origin).toBeTruthy();
});

describe("forumLinkFor", () => {
  it("is absolute, so it survives being pasted anywhere", () => {
    const link = forumLinkFor(POST);
    expect(link.startsWith(`${window.location.origin}/f/`)).toBe(true);
  });

  it("round-trips a post id through its own encoding", () => {
    const ref = parseForumLink(forumLinkFor(POST));
    expect(ref).toEqual({ postId: POST, commentId: null });
  });

  it("round-trips a reply link through its own encoding", () => {
    const ref = parseForumLink(forumReplyLinkFor(POST, COMMENT));
    expect(ref).toEqual({ postId: POST, commentId: COMMENT });
  });
});

describe("parseForumLink", () => {
  it("accepts a bare path as well as an absolute URL", () => {
    expect(parseForumLink(`/f/${encodeURIComponent(POST)}`)).toEqual({
      postId: POST,
      commentId: null,
    });
  });

  it("refuses a forum link on another instance", () => {
    expect(
      parseForumLink(`https://other.example/f/${encodeURIComponent(POST)}`),
    ).toBeNull();
  });

  it("refuses paths that only look like one", () => {
    expect(parseForumLink("/f/")).toBeNull();
    expect(parseForumLink("/f")).toBeNull();
    expect(parseForumLink(`/f/${encodeURIComponent(POST)}/a/b`)).toBeNull();
    expect(parseForumLink("/m/abc")).toBeNull();
    expect(parseForumLink("/invite/abc")).toBeNull();
    expect(parseForumLink("not a url at all")).toBeNull();
  });

  it("refuses malformed percent-encoding rather than throwing", () => {
    expect(forumRefFromPath("/f/%")).toBeNull();
    expect(forumRefFromPath("/f/%zz")).toBeNull();
  });
});

describe("findForumLinks", () => {
  it("finds a link in amongst prose", () => {
    const body = `see ${forumLinkFor(POST)} for context`;
    expect(findForumLinks(body)).toEqual([{ postId: POST, commentId: null }]);
  });

  it("draws one card for a post named twice", () => {
    const link = forumLinkFor(POST);
    expect(findForumLinks(`${link} and again ${link}`)).toEqual([
      { postId: POST, commentId: null },
    ]);
  });

  it("tells a post link and a reply link apart", () => {
    const body = `${forumLinkFor(POST)} vs ${forumReplyLinkFor(POST, COMMENT)}`;
    expect(findForumLinks(body)).toEqual([
      { postId: POST, commentId: null },
      { postId: POST, commentId: COMMENT },
    ]);
  });

  it("ignores ordinary links and other instances", () => {
    const body = [
      "https://example.com/thing",
      `https://other.example/f/${encodeURIComponent(POST)}`,
      `${window.location.origin}/invite/abc123`,
    ].join(" ");
    expect(findForumLinks(body)).toEqual([]);
  });
});

describe("resolveForumPreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks once for a post many cards point at", async () => {
    const spy = vi.spyOn(api, "apiGetForumPreview").mockResolvedValue(preview);

    const all = await Promise.all([
      resolveForumPreview(POST),
      resolveForumPreview(POST),
      resolveForumPreview(POST),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(all).toEqual([preview, preview, preview]);
    expect(peekForumPreview(POST)).toEqual({ value: preview });
  });

  it("keeps a post link and a reply link as separate requests", async () => {
    const reply = { ...preview, kind: "reply", comment_id: COMMENT };
    const spy = vi.spyOn(api, "apiGetForumPreview").mockResolvedValue(reply);

    await resolveForumPreview(POST);
    await resolveForumPreview(POST, COMMENT);

    // The post and the reply under it are different cards, so they must not
    // share one cached answer.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(peekForumPreview(POST, COMMENT)).toEqual({ value: reply });
  });

  it("remembers a refusal, so an unfollowable link costs one request", async () => {
    const spy = vi.spyOn(api, "apiGetForumPreview").mockResolvedValue(null);

    expect(await resolveForumPreview(POST)).toBeNull();
    expect(await resolveForumPreview(POST)).toBeNull();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(peekForumPreview(POST)).toEqual({ value: null });
  });

  it("does not remember a failure worth retrying", async () => {
    const spy = vi
      .spyOn(api, "apiGetForumPreview")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(preview);

    await expect(resolveForumPreview(POST)).rejects.toThrow("offline");
    expect(peekForumPreview(POST)).toBeNull();

    expect(await resolveForumPreview(POST)).toEqual(preview);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("re-asks after the post changes under it", async () => {
    const edited = { ...preview, title: "Hello, edited", edited: true };
    const spy = vi
      .spyOn(api, "apiGetForumPreview")
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(edited);

    expect(await resolveForumPreview(POST)).toEqual(preview);
    forgetForumPreview(POST);
    expect(peekForumPreview(POST)).toBeNull();

    expect(await resolveForumPreview(POST)).toEqual(edited);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("forgets everything on sign-out", async () => {
    vi.spyOn(api, "apiGetForumPreview").mockResolvedValue(preview);
    await resolveForumPreview(POST);

    clearForumPreviews();

    expect(peekForumPreview(POST)).toBeNull();
  });
});
