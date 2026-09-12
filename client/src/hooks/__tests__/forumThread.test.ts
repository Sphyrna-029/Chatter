import { describe, it, expect } from "vitest";
import { buildCommentThread, countReplies } from "@/lib/forumThread";
import type { ForumComment } from "@/lib/api";

function comment(id: string, parentId?: string): ForumComment {
  return {
    comment_id: id,
    post_id: "post_1",
    room_id: "room_1",
    author: "@a:localhost",
    body: id,
    image_url: "",
    parent_id: parentId,
    created_at: 0,
  };
}

/** The ids of a thread, depth-first, as "id@depth". */
function shape(comments: ForumComment[]): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof buildCommentThread>) => {
    for (const node of nodes) {
      out.push(`${node.comment.comment_id}@${node.depth}`);
      walk(node.replies);
    }
  };
  walk(buildCommentThread(comments));
  return out;
}

describe("buildCommentThread", () => {
  it("leaves a flat list flat", () => {
    expect(shape([comment("a"), comment("b")])).toEqual(["a@0", "b@0"]);
  });

  it("hangs a reply off what it answers", () => {
    expect(shape([comment("a"), comment("b", "a")])).toEqual(["a@0", "b@1"]);
  });

  it("nests to any depth", () => {
    expect(shape([comment("a"), comment("b", "a"), comment("c", "b"), comment("d", "c")]))
      .toEqual(["a@0", "b@1", "c@2", "d@3"]);
  });

  it("keeps siblings in the order they arrived", () => {
    expect(shape([comment("a"), comment("x", "a"), comment("y", "a")]))
      .toEqual(["a@0", "x@1", "y@1"]);
  });

  it("interleaves branches without mixing them up", () => {
    expect(shape([comment("a"), comment("b"), comment("a1", "a"), comment("b1", "b")]))
      .toEqual(["a@0", "a1@1", "b@0", "b1@1"]);
  });

  it("raises a reply whose parent is missing rather than losing it", () => {
    expect(shape([comment("orphan", "gone")])).toEqual(["orphan@0"]);
  });

  it("ignores a comment that claims to be its own parent", () => {
    expect(shape([comment("a", "a")])).toEqual(["a@0"]);
  });

  it("treats an empty parent_id as answering the post", () => {
    expect(shape([comment("a", "")])).toEqual(["a@0"]);
  });

  it("handles no comments at all", () => {
    expect(buildCommentThread([])).toEqual([]);
  });
});

describe("countReplies", () => {
  it("counts the whole branch, not just the children", () => {
    const [root] = buildCommentThread([
      comment("a"),
      comment("b", "a"),
      comment("c", "b"),
      comment("d", "a"),
    ]);
    expect(countReplies(root)).toBe(3);
  });

  it("is zero for a comment nobody answered", () => {
    const [root] = buildCommentThread([comment("a")]);
    expect(countReplies(root)).toBe(0);
  });
});
