import type { ForumComment } from "@/lib/api";

export interface ForumCommentNode {
  comment: ForumComment;
  /** 0 for a reply to the post itself, 1 for a reply to one of those, and so on. */
  depth: number;
  replies: ForumCommentNode[];
}

/**
 * Arrange a post's comments into the thread they describe.
 *
 * The server sends one flat list, oldest first, each carrying the id of what it
 * answers. Nesting is derived rather than stored so that a reply is still a
 * comment — deleting, editing and counting all keep working on the flat list.
 *
 * A reply whose parent is missing is raised to the top rather than dropped. The
 * server keeps a deleted comment as a tombstone precisely so this does not
 * happen, but a client that is out of date with the server, or a parent deleted
 * between two fetches, must not make a comment disappear.
 */
export type ThreadOrder = "oldest" | "newest";

/**
 * Sorting happens within each set of siblings, never across the list as a
 * whole: a reply belongs under what it answers whichever way round the thread
 * is read, and a flat re-sort would tear the tree apart.
 */
function orderSiblings(nodes: ForumCommentNode[], order: ThreadOrder) {
  nodes.sort((a, b) =>
    order === "newest"
      ? b.comment.created_at - a.comment.created_at
      : a.comment.created_at - b.comment.created_at,
  );
  for (const node of nodes) orderSiblings(node.replies, order);
}

export function buildCommentThread(
  comments: ForumComment[],
  order: ThreadOrder = "oldest",
): ForumCommentNode[] {
  const byId = new Map<string, ForumCommentNode>();
  for (const comment of comments) {
    byId.set(comment.comment_id, { comment, depth: 0, replies: [] });
  }

  const roots: ForumCommentNode[] = [];
  for (const comment of comments) {
    const node = byId.get(comment.comment_id)!;
    const parentId = comment.parent_id;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent !== node) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  // Depth is walked from the roots rather than read off each parent as it is
  // linked: the flat list is ordered by creation, so a parent is always linked
  // before its children, but that is the server's ordering to guarantee and not
  // something worth depending on here.
  const setDepth = (nodes: ForumCommentNode[], depth: number) => {
    for (const node of nodes) {
      node.depth = depth;
      setDepth(node.replies, depth + 1);
    }
  };
  setDepth(roots, 0);
  orderSiblings(roots, order);

  return roots;
}

/** How many comments hang below this one, at any depth. */
export function countReplies(node: ForumCommentNode): number {
  return node.replies.reduce((total, reply) => total + 1 + countReplies(reply), 0);
}

/**
 * How deep the thread rail keeps stepping in.
 *
 * Past this, replies still stack under their parent but stop moving right: a
 * long back-and-forth would otherwise walk itself off the edge of a phone, and
 * by then the rail says less than the "replying to" line above the composer.
 */
export const MAX_THREAD_INDENT = 5;

const THREAD_ORDER_KEY = "chatter_forum_thread_order";

/** The reader's last choice, so it holds across posts and sessions. */
export function loadThreadOrder(): ThreadOrder {
  try {
    return localStorage.getItem(THREAD_ORDER_KEY) === "newest" ? "newest" : "oldest";
  } catch {
    // Private windows and blocked site data both throw rather than return null.
    return "oldest";
  }
}

export function storeThreadOrder(order: ThreadOrder): void {
  try {
    localStorage.setItem(THREAD_ORDER_KEY, order);
  } catch {
    // A preference not persisting is not worth failing a render over.
  }
}
