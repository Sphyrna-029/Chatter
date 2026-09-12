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
export function buildCommentThread(comments: ForumComment[]): ForumCommentNode[] {
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
