import { describe, it, expect } from "vitest";
import { buildCommentThread, countReplies, loadThreadOrder, storeThreadOrder } from "@/lib/forumThread";
import type { ForumComment } from "@/lib/api";

function comment(id: string, parentId?: string, createdAt = 0): ForumComment {
  return {
    comment_id: id,
    post_id: "post_1",
    room_id: "room_1",
    author: "@a:localhost",
    body: id,
    image_url: "",
    parent_id: parentId,
    created_at: createdAt,
  };
}

/** The ids of a thread, depth-first, as "id@depth". */
function shape(comments: ForumComment[], order?: "oldest" | "newest"): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof buildCommentThread>) => {
    for (const node of nodes) {
      out.push(`${node.comment.comment_id}@${node.depth}`);
      walk(node.replies);
    }
  };
  walk(buildCommentThread(comments, order));
  return out;
}

/** Enough of localStorage for the preference helpers, and a way to break it. */
function installStorage(broken = false) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => {
        if (broken) throw new Error("blocked");
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (broken) throw new Error("blocked");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
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

describe("thread order", () => {
  it("reads oldest first by default", () => {
    const comments = [comment("a", "", 10), comment("b", "", 20), comment("c", "", 30)];
    expect(shape(comments)).toEqual(["a@0", "b@0", "c@0"]);
  });

  it("turns the top level around for newest first", () => {
    const comments = [comment("a", "", 10), comment("b", "", 20), comment("c", "", 30)];
    expect(shape(comments, "newest")).toEqual(["c@0", "b@0", "a@0"]);
  });

  it("turns replies around too, within their own branch", () => {
    const comments = [
      comment("a", "", 10),
      comment("a1", "a", 20),
      comment("a2", "a", 30),
    ];
    expect(shape(comments, "newest")).toEqual(["a@0", "a2@1", "a1@1"]);
  });

  it("never lifts a reply out from under what it answers", () => {
    // b is newer than a1, but a1 belongs to a whichever way the list reads.
    const comments = [
      comment("a", "", 10),
      comment("a1", "a", 20),
      comment("b", "", 30),
    ];
    expect(shape(comments, "newest")).toEqual(["b@0", "a@0", "a1@1"]);
    expect(shape(comments, "oldest")).toEqual(["a@0", "a1@1", "b@0"]);
  });

  it("leaves comments posted in the same millisecond in the order they came", () => {
    const comments = [comment("a", "", 5), comment("b", "", 5)];
    expect(shape(comments, "oldest")).toEqual(["a@0", "b@0"]);
    expect(shape(comments, "newest")).toEqual(["a@0", "b@0"]);
  });
});

describe("thread order preference", () => {
  it("defaults to oldest when nothing is stored", () => {
    installStorage();
    expect(loadThreadOrder()).toBe("oldest");
  });

  it("remembers what was chosen", () => {
    installStorage();
    storeThreadOrder("newest");
    expect(loadThreadOrder()).toBe("newest");
    storeThreadOrder("oldest");
    expect(loadThreadOrder()).toBe("oldest");
  });

  it("falls back rather than throwing where site data is blocked", () => {
    installStorage(true);
    expect(loadThreadOrder()).toBe("oldest");
    expect(() => storeThreadOrder("newest")).not.toThrow();
  });
});
