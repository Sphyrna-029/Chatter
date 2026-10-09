import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/lib/store";
import { forumRefFromPath, resolveForumPreview } from "@/lib/forumLinks";
import { requestForumPost } from "@/lib/pendingForumPost";

/**
 * Opens the forum post named by a `/f/<post id>` (or `/f/<post id>/<comment id>`)
 * URL the app was loaded at.
 *
 * Clicking a link inside the app is handled where it is clicked; this is the
 * other half — a link followed from somewhere else, which arrives as a cold
 * load with a path and no state. Renders nothing.
 *
 * The order matters, as in `MessageLinkOpener`. The link is resolved first,
 * because that needs nothing but a token and it is what says whether there is
 * anywhere to go; only then does it wait for the room list, which `ChatLayout`
 * loads on mount. `requestForumPost` parks the post and announces it, and
 * whichever of the two the forum view reaches first wins.
 */
export function ForumLinkOpener() {
  const { state } = useAppContext();
  // Read once: the path is cleared below, and a component that re-read it would
  // decide the link was gone half way through following it.
  const [ref] = useState(() => forumRefFromPath(window.location.pathname));
  const target = useRef<{ roomId: string; postId: string; channelId: string | null } | null>(null);
  const done = useRef(false);

  // Resolve the link. Runs once there is a session to resolve it with — which
  // may be after a sign-in, since the path survives the login screen.
  useEffect(() => {
    if (!ref || !state.accessToken || target.current || done.current) return;
    let live = true;
    void resolveForumPreview(ref.postId, ref.commentId)
      .then((preview) => {
        if (!live) return;
        if (!preview) {
          // Deliberately the same words the in-app click uses, and deliberately
          // not "that post does not exist": the server does not say which, so
          // neither does this.
          toast.error("That post is not available to you");
          done.current = true;
          window.history.replaceState({}, "", "/");
          return;
        }
        target.current = {
          roomId: preview.room_id,
          postId: preview.post_id,
          channelId: preview.channel_id,
        };
      })
      .catch(() => {
        if (!live) return;
        toast.error("Could not open that post");
        done.current = true;
        window.history.replaceState({}, "", "/");
      });
    return () => {
      live = false;
    };
  }, [ref, state.accessToken]);

  // Jump, once the room the post lives in is one the client knows about.
  useEffect(() => {
    const goal = target.current;
    if (!goal || done.current) return;
    if (!state.joinedRoomIds.includes(goal.roomId)) return;
    done.current = true;
    // Cleared before the jump rather than after: opening a post selects a room,
    // and leaving the path in place through that means a reload mid-jump starts
    // the whole thing again.
    window.history.replaceState({}, "", "/");
    requestForumPost(goal.roomId, goal.postId, goal.channelId);
  }, [ref, state.joinedRoomIds]);

  return null;
}
