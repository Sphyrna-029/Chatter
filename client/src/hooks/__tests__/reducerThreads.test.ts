import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState } from "@/lib/store/types";
import type { MatrixMessage } from "@/lib/api";

const message = (eventId: string): MatrixMessage => ({
  event_id: eventId,
  sender: "@someone:localhost",
  room_id: "!room:localhost",
  origin_server_ts: 1,
  type: "m.room.message",
  content: { body: "hello", msgtype: "m.text" },
});

const inAThread = (): AppState => ({
  ...initialState,
  currentRoomId: "!room:localhost",
  currentChannelId: "!general:localhost",
  activeThreadEventId: "$root",
  threadRootMessage: message("$root"),
  threadMessages: [message("$reply")],
});

describe("leaving a thread", () => {
  it("closes when another channel is picked", () => {
    // The thread panel renders on activeThreadEventId alone, so leaving it set
    // made clicking a channel look like it did nothing.
    const next = reducer(inAThread(), {
      type: "SELECT_CHANNEL",
      payload: "!other:localhost",
    });

    expect(next.currentChannelId).toBe("!other:localhost");
    expect(next.activeThreadEventId).toBeNull();
    expect(next.threadRootMessage).toBeNull();
    expect(next.threadMessages).toEqual([]);
  });

  it("closes when another room is picked", () => {
    const next = reducer(inAThread(), {
      type: "SELECT_ROOM",
      payload: "!elsewhere:localhost",
    });

    expect(next.activeThreadEventId).toBeNull();
    expect(next.threadRootMessage).toBeNull();
    expect(next.threadMessages).toEqual([]);
  });

  it("still closes when the channel picked is the one already open", () => {
    // Re-selecting the current channel is how the UI gets back to its message
    // list, so it has to leave the thread too.
    const next = reducer(inAThread(), {
      type: "SELECT_CHANNEL",
      payload: "!general:localhost",
    });

    expect(next.activeThreadEventId).toBeNull();
  });

  it("opens a thread that arrives after the channel change", () => {
    // The sidebar selects a thread's channel and opens the thread without
    // waiting, so the open must survive the select that precedes it.
    const selected = reducer(inAThread(), {
      type: "SELECT_CHANNEL",
      payload: "!other:localhost",
    });
    const opened = reducer(selected, {
      type: "OPEN_THREAD",
      payload: {
        eventId: "$newroot",
        root: message("$newroot"),
        messages: [message("$newreply")],
      },
    });

    expect(opened.activeThreadEventId).toBe("$newroot");
    expect(opened.threadMessages).toHaveLength(1);
  });
});

describe("replying inside a thread", () => {
  it("aims the thread's composer, not the channel's", () => {
    const next = reducer(inAThread(), {
      type: "SET_THREAD_REPLYING_TO",
      payload: message("$reply"),
    });

    expect(next.threadReplyingTo?.event_id).toBe("$reply");
    expect(next.replyingTo).toBeNull();
  });

  it("forgets the target when the thread closes", () => {
    const replying = reducer(inAThread(), {
      type: "SET_THREAD_REPLYING_TO",
      payload: message("$reply"),
    });
    const closed = reducer(replying, { type: "CLOSE_THREAD" });

    expect(closed.threadReplyingTo).toBeNull();
  });

  it("drops the target when the message it answers is deleted", () => {
    const replying = reducer(inAThread(), {
      type: "SET_THREAD_REPLYING_TO",
      payload: message("$reply"),
    });
    const next = reducer(replying, { type: "REDACT_MESSAGE", payload: "$reply" });

    expect(next.threadReplyingTo).toBeNull();
  });
});

describe("a thread's pins", () => {
  const pin = (eventId: string, threadId = "$root") => ({
    ...message(eventId),
    thread_id: threadId,
    pinned_by: "@mod:localhost",
    pinned_at: 2,
  });

  it("lands in the thread, never in the channel's list", () => {
    const next = reducer(inAThread(), { type: "ADD_THREAD_PIN", payload: pin("$reply") });

    expect(next.threadPins.map((m) => m.event_id)).toEqual(["$reply"]);
    expect(next.pinnedMessages).toEqual([]);
  });

  it("ignores a pin from a thread that is not open", () => {
    const next = reducer(inAThread(), {
      type: "ADD_THREAD_PIN",
      payload: pin("$elsewhere", "$otherroot"),
    });

    expect(next.threadPins).toEqual([]);
  });

  it("ignores a late answer for a thread that was swapped out", () => {
    const next = reducer(inAThread(), {
      type: "SET_THREAD_PINS",
      payload: { threadId: "$otherroot", pins: [pin("$x", "$otherroot")] },
    });

    expect(next.threadPins).toEqual([]);
  });

  it("is unpinned by the same event as a channel pin", () => {
    const pinned = reducer(inAThread(), { type: "ADD_THREAD_PIN", payload: pin("$reply") });
    const next = reducer(pinned, { type: "REMOVE_PINNED_MESSAGE", payload: "$reply" });

    expect(next.threadPins).toEqual([]);
  });

  it("starts empty for each thread opened", () => {
    const pinned = reducer(inAThread(), { type: "ADD_THREAD_PIN", payload: pin("$reply") });
    const next = reducer(pinned, {
      type: "OPEN_THREAD",
      payload: { eventId: "$newroot", root: message("$newroot"), messages: [] },
    });

    expect(next.threadPins).toEqual([]);
  });
});
