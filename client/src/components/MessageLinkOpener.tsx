import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/lib/store";
import { eventIdFromPath, resolveMessagePreview } from "@/lib/messageLinks";

/**
 * Opens the message named by a `/m/<event id>` URL the app was loaded at.
 *
 * Clicking a link inside the app is handled where it is clicked; this is the
 * other half — a link followed from somewhere else, which arrives as a cold
 * load with a path and no state. Renders nothing.
 *
 * The order matters. The link is resolved first, because that needs nothing
 * but a token and it is what says whether there is anywhere to go; only then
 * does it wait for the room list, which `ChatLayout` loads on mount. Jumping
 * before the room is known would select a room the sidebar has not heard of
 * yet, and the jump itself needs the room's channels to have arrived — see the
 * `pendingJump` effect in `ChatArea`.
 */
export function MessageLinkOpener() {
  const { state, openMessage } = useAppContext();
  // Read once: the path is cleared below, and a component that re-read it
  // would decide the link was gone half way through following it.
  const [eventId] = useState(() => eventIdFromPath(window.location.pathname));
  const target = useRef<{ roomId: string; eventId: string; channelId: string | null; ts: number } | null>(null);
  const done = useRef(false);

  // Resolve the link. Runs once there is a session to resolve it with — which
  // may be after a sign-in, since the path survives the login screen.
  useEffect(() => {
    if (!eventId || !state.accessToken || target.current || done.current) return;
    let live = true;
    void resolveMessagePreview(eventId)
      .then((preview) => {
        if (!live) return;
        if (!preview) {
          // Deliberately the same words the in-app click uses, and deliberately
          // not "that message does not exist": the server does not say which,
          // so neither does this.
          toast.error("That message is not available to you");
          done.current = true;
          window.history.replaceState({}, "", "/");
          return;
        }
        target.current = {
          roomId: preview.room_id,
          eventId: preview.event_id,
          channelId: preview.channel_id,
          ts: preview.origin_server_ts,
        };
      })
      .catch(() => {
        if (!live) return;
        toast.error("Could not open that message");
        done.current = true;
        window.history.replaceState({}, "", "/");
      });
    return () => {
      live = false;
    };
  }, [eventId, state.accessToken]);

  // Jump, once the room the message lives in is one the client knows about.
  useEffect(() => {
    const goal = target.current;
    if (!goal || done.current) return;
    if (!state.joinedRoomIds.includes(goal.roomId)) return;
    done.current = true;
    // Cleared before the jump rather than after: `openMessage` selects a room,
    // and leaving the path in place through that means a reload mid-jump starts
    // the whole thing again.
    window.history.replaceState({}, "", "/");
    void openMessage(goal);
  }, [state.joinedRoomIds, openMessage]);

  return null;
}
