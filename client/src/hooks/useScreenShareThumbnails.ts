import { useEffect } from "react";
import { useAppContext, screenThumbnailsMap } from "@/lib/store";
import { apiGetScreenThumbnails } from "@/lib/api";
import { syncScreenThumbnails } from "@/lib/screenThumbnail";

/** How often a member outside the call refreshes the room's stills. Slower than
 *  the sharer's own capture cadence: this is a hover peek, and one request per
 *  idle viewer every few seconds is plenty to keep the thumbnail honest. */
const SCREEN_THUMBNAIL_POLL_MS = 4000;

/** Keeps `screenThumbnailsMap` current for the room on screen, so the members
 *  list can show what a sharer has on screen when the viewer is not in the call
 *  and therefore has no stream of their own.
 *
 *  Mounted by the app shell rather than the voice controls: the whole point is
 *  the people who are *not* in a call, and the voice UI is not on screen for
 *  them. Inside a call this clears — the member list there has a real "Watch"
 *  button and a live stream, so a still would only ever disagree with it. */
export function useScreenShareThumbnails() {
  const { state } = useAppContext();

  useEffect(() => {
    if (state.inVoiceChannel || !state.currentRoomId) {
      screenThumbnailsMap.clear();
      return;
    }
    // Nothing to peek at until someone in this room is sharing.
    if (state.activeScreenSharers.length === 0) {
      screenThumbnailsMap.clear();
      return;
    }

    const roomId = state.currentRoomId;
    const poll = async () => {
      try {
        const { thumbnails } = await apiGetScreenThumbnails(roomId);
        syncScreenThumbnails(thumbnails);
      } catch {
        // A dropped request keeps the last set rather than blanking the peek.
      }
    };

    void poll();
    const timer = setInterval(poll, SCREEN_THUMBNAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [state.currentRoomId, state.inVoiceChannel, state.activeScreenSharers.length]);
}
