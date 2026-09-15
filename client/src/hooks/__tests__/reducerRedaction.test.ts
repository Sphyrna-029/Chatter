import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState } from "@/lib/store/types";
import type { MatrixMessage, PinnedMessage } from "@/lib/api";

const message = (eventId: string): MatrixMessage => ({
  event_id: eventId,
  sender: "@someone:localhost",
  room_id: "!room:localhost",
  origin_server_ts: 1,
  type: "m.room.message",
  content: { body: "hello", msgtype: "m.text" },
});

const pinned = (eventId: string): PinnedMessage => ({
  ...message(eventId),
  pinned_by: "@someone:localhost",
  pinned_at: 1,
});

/** A room with the same message pinned, in the timeline, and in an open thread. */
const everywhereAtOnce = (): AppState => ({
  ...initialState,
  currentRoomId: "!room:localhost",
  messages: [message("$a"), message("$reply")],
  pinnedMessages: [pinned("$a")],
  activeThreadEventId: "$root",
  threadRootMessage: message("$root"),
  threadMessages: [message("$reply"), message("$other")],
});

describe.each(["REDACT_MESSAGE", "REMOVE_MESSAGE"] as const)("%s", (type) => {
  it("takes the message out of the timeline and the pin list", () => {
    const next = reducer(everywhereAtOnce(), { type, payload: "$a" });
    expect(next.messages.map((m) => m.event_id)).toEqual(["$reply"]);
    expect(next.pinnedMessages).toEqual([]);
  });

  it("takes it out of an open thread as well", () => {
    // A message is on screen in up to three places at once, and the thread was
    // the one nothing cleared — so deleting a reply from inside a thread left
    // it sitting there until the panel was reopened.
    const next = reducer(everywhereAtOnce(), { type, payload: "$reply" });
    expect(next.threadMessages.map((m) => m.event_id)).toEqual(["$other"]);
    expect(next.messages.map((m) => m.event_id)).toEqual(["$a"]);
    // The thread itself is untouched: one of its replies went, not the thread.
    expect(next.activeThreadEventId).toBe("$root");
  });

  it("closes the thread when its root is what went", () => {
    // What is left otherwise is a panel of replies to something that is gone.
    const next = reducer(everywhereAtOnce(), { type, payload: "$root" });
    expect(next.activeThreadEventId).toBeNull();
    expect(next.threadRootMessage).toBeNull();
    expect(next.threadMessages).toEqual([]);
  });

  it("does nothing for a message this client never had", () => {
    const before = everywhereAtOnce();
    const next = reducer(before, { type, payload: "$unknown" });
    expect(next.messages).toEqual(before.messages);
    expect(next.threadMessages).toEqual(before.threadMessages);
    expect(next.activeThreadEventId).toBe("$root");
  });

  it("is safe to apply twice, since the broadcast follows the response", () => {
    // The deleter's own client now removes it on the successful DELETE, and
    // the broadcast arrives afterwards saying the same thing.
    const once = reducer(everywhereAtOnce(), { type, payload: "$reply" });
    const twice = reducer(once, { type, payload: "$reply" });
    expect(twice.messages).toEqual(once.messages);
    expect(twice.threadMessages).toEqual(once.threadMessages);
  });
});
