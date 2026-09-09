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
